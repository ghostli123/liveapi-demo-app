import asyncio
import base64
import datetime
import hashlib
import json
import logging
import os
import ssl
import struct
import tempfile
import types
import unittest
from unittest import mock

import aiohttp
import websockets
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

import get_credentials
import websocket_handler


class ClientCloseFrameTest(unittest.TestCase):
    def frame(self, code, reason=""):
        handler = websocket_handler.WebsocketHandler("ws://unused", "s", None)
        handler.close_code, handler.close_reason = code, reason
        return handler.client_close_frame()

    def test_mirrors_sendable_codes(self):
        self.assertEqual(self.frame(1008, "Quota exceeded"), (1008, "Quota exceeded"))
        self.assertEqual(self.frame(1000), (1000, ""))

    def test_maps_reserved_codes(self):
        self.assertEqual(self.frame(None), (1000, ""))
        self.assertEqual(self.frame(1005), (1000, ""))
        self.assertEqual(self.frame(1006), (1011, "Upstream connection lost"))

    def test_truncates_long_reasons_on_character_boundary(self):
        code, reason = self.frame(1011, "é" * 100)
        self.assertEqual(code, 1011)
        self.assertLessEqual(len(reason.encode("utf-8")), 123)
        self.assertEqual(set(reason), {"é"})


class RejectedHandshake(Exception):
    """Shaped like websockets' InvalidStatus: carries the HTTP response."""

    def __init__(self, status_code, body):
        super().__init__("rejected")
        self.response = types.SimpleNamespace(status_code=status_code, body=body)


class DescribeConnectErrorTest(unittest.TestCase):
    def test_extracts_google_api_error_message(self):
        error = RejectedHandshake(
            403, b'{"error": {"code": 403, "message": "Permission denied on project"}}'
        )
        self.assertEqual(
            websocket_handler.describe_connect_error(error),
            "Upstream HTTP 403: Permission denied on project",
        )

    def test_plain_body_and_no_response(self):
        error = RejectedHandshake(502, b"Bad gateway")
        self.assertEqual(
            websocket_handler.describe_connect_error(error),
            "Upstream HTTP 502: Bad gateway",
        )

    def test_network_errors_show_only_their_type(self):
        # Their text names internal hosts (a proxy's address) or files.
        error = ConnectionRefusedError(111, "Connect call failed ('10.1.2.3', 3128)")
        self.assertEqual(
            websocket_handler.describe_connect_error(error),
            "Could not connect to the Live API (ConnectionRefusedError); "
            "see the server log",
        )
        self.assertEqual(
            websocket_handler.connect_error_detail(error),
            "ConnectionRefusedError: [Errno 111] Connect call failed "
            "('10.1.2.3', 3128)",
        )
        self.assertEqual(
            websocket_handler.describe_connect_error(TimeoutError("timed out")),
            "TimeoutError: timed out",
        )

    def test_long_html_body_becomes_one_short_line(self):
        page = "<html>\n<body>\n" + "<p>Not found.</p>\n" * 12000 + "</body></html>"
        self.assertGreater(len(page), 200_000)
        reason = websocket_handler.describe_connect_error(
            RejectedHandshake(404, page.encode())
        )
        self.assertTrue(reason.startswith("Upstream HTTP 404: <html> <body> <p>"))
        self.assertTrue(reason.endswith("..."))
        self.assertLessEqual(
            len(reason),
            len("Upstream HTTP 404: ") + websocket_handler._MAX_CONNECT_ERROR_CHARS,
        )
        self.assertNotIn("\n", reason)

    def test_long_api_message_and_exception_are_capped(self):
        message = "Quota exceeded.\n" + "x" * 1000
        body = json.dumps({"error": {"message": message}}).encode()
        reason = websocket_handler.describe_connect_error(RejectedHandshake(429, body))
        self.assertTrue(reason.startswith("Upstream HTTP 429: Quota exceeded. xxx"))
        self.assertTrue(reason.endswith("..."))
        reason = websocket_handler.connect_error_detail(OSError("a\nb " + "c" * 500))
        self.assertTrue(reason.startswith("OSError: a b ccc"))
        self.assertEqual(len(reason), websocket_handler._MAX_CONNECT_ERROR_CHARS)

    def test_invalid_header_value_redacts_header_values(self):
        secret = "fake-bearer-secret"
        error = websockets.InvalidHeaderValue(
            "Authorization", f"Bearer {secret}\r\nX-Inject: 1"
        )
        for fn in (
            websocket_handler.connect_error_detail,
            websocket_handler.describe_connect_error,
        ):
            reason = fn(error)
            self.assertEqual(reason, "InvalidHeaderValue: invalid Authorization header")
            self.assertNotIn(secret, reason)
            self.assertNotIn("X-Inject", reason)

        self.assertEqual(
            websocket_handler.connect_error_detail(
                websockets.InvalidHeaderValue("Authorization", None)
            ),
            "InvalidHeaderValue: missing Authorization header",
        )
        self.assertEqual(
            websocket_handler.connect_error_detail(
                websockets.InvalidHeaderValue("Authorization", "")
            ),
            "InvalidHeaderValue: empty Authorization header",
        )
        self.assertEqual(
            websocket_handler.describe_connect_error(
                websockets.InvalidHeaderValue("Sec-WebSocket-Accept", "bad-accept-val")
            ),
            "InvalidHeaderValue: invalid Sec-WebSocket-Accept header",
        )

    def test_sensitive_invalid_header_subclasses_redact_values(self):
        secret = "Basic dXNlcjpodW50ZXIy"
        for error in (
            websockets.InvalidHeader("Proxy-Authorization", secret),
            websockets.InvalidHeaderFormat(
                "Authorization", "expected token", f"Bearer {secret}", 0
            ),
            websockets.InvalidHeader("Set-Cookie", f"sid={secret}"),
        ):
            for fn in (
                websocket_handler.connect_error_detail,
                websocket_handler.describe_connect_error,
            ):
                reason = fn(error)
                self.assertNotIn(secret, reason)
                self.assertIn(error.name, reason)

        # Non-sensitive handshake errors still keep their diagnostic value.
        self.assertEqual(
            websocket_handler.describe_connect_error(
                websockets.InvalidUpgrade("Upgrade", "h2c")
            ),
            "InvalidUpgrade: invalid Upgrade header: h2c",
        )


class UpstreamRejectionLogTest(unittest.IsolatedAsyncioTestCase):
    async def test_html_error_page_is_logged_as_one_short_line(self):
        page = "<html>\n" + "<p>The requested URL was not found.</p>\n" * 5000

        def reject(connection, request):
            response = connection.respond(404, page)
            response.headers["Content-Type"] = "text/html"
            return response

        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)

        async def unused(connection):
            pass

        async with websockets.serve(
            unused,
            "127.0.0.1",
            0,
            logger=quiet,
            process_request=reject,
        ) as server:
            port = next(iter(server.sockets)).getsockname()[1]
            handler = websocket_handler.WebsocketHandler(
                f"ws://127.0.0.1:{port}/ws", "s", None
            )
            with self.assertLogs(level=logging.WARNING) as logs:
                self.assertIsNone(await handler._open_upstream())
        self.assertEqual(handler.close_code, 1011)
        self.assertTrue(
            handler.close_reason.startswith("Upstream HTTP 404: <html> <p>")
        )
        [line] = [o for o in logs.output if "Upstream connection failed" in o]
        self.assertNotIn("\n", line)
        self.assertLess(len(line), 500)


class UpstreamLoggingTest(unittest.IsolatedAsyncioTestCase):
    async def test_debug_logging_leaves_out_the_access_token(self):
        root = logging.getLogger()
        self.addCleanup(root.setLevel, root.level)
        root.setLevel(logging.DEBUG)  # What --debug does.
        handler = websocket_handler.WebsocketHandler("wss://unused", "s", None)
        with mock.patch.object(websocket_handler, "_NoRedirectConnect") as connect:
            handler._connect_upstream("secret-token")
        options = dict(connect.call_args.kwargs)
        del options["ssl"]  # The test server is plain ws://.

        async def close(connection):
            await connection.close()

        # The server's own logger would log the header it received.
        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        async with websockets.serve(close, "127.0.0.1", 0, logger=quiet) as server:
            port = next(iter(server.sockets)).getsockname()[1]
            with self.assertLogs(level=logging.DEBUG) as logs:
                logging.getLogger().debug("captured")
                async with websockets.connect(f"ws://127.0.0.1:{port}", **options):
                    pass
        self.assertNotIn("secret-token", "\n".join(logs.output))


class UpstreamRedirectTest(unittest.IsolatedAsyncioTestCase):
    async def test_redirect_is_not_followed_with_the_token(self):
        received = []

        async def target(connection):
            received.append(connection.request.headers.get("Authorization"))
            await connection.close()

        def redirect_to_target(connection, request):
            response = connection.respond(302, "")
            response.headers["Location"] = f"ws://localhost:{target_port}/elsewhere"
            return response

        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        async with (
            websockets.serve(target, "127.0.0.1", 0, logger=quiet) as target_server,
            websockets.serve(
                target,
                "127.0.0.1",
                0,
                logger=quiet,
                process_request=redirect_to_target,
            ) as redirector,
        ):
            target_port = next(iter(target_server.sockets)).getsockname()[1]
            port = next(iter(redirector.sockets)).getsockname()[1]
            handler = websocket_handler.WebsocketHandler(
                f"ws://127.0.0.1:{port}/ws", "s", None
            )
            with self.assertRaises(websockets.exceptions.InvalidStatus) as caught:
                await handler._connect_upstream("secret-token")
        self.assertEqual(received, [])
        self.assertEqual(
            websocket_handler.describe_connect_error(caught.exception),
            "Upstream HTTP 302",
        )


def _self_signed_cert(directory, host):
    """Writes a certificate and key for host; returns (cert_path, key_path)."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, host)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
        .sign(key, hashes.SHA256())
    )
    cert_path = os.path.join(directory, "cert.pem")
    key_path = os.path.join(directory, "key.pem")
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as f:
        f.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    return cert_path, key_path


class ConnectProxy:
    """An HTTP CONNECT proxy that tunnels every request to target_port.

    Records each request's head, or answers with reject_status instead.
    """

    def __init__(self, target_port, reject_status=None):
        self.target_port = target_port
        self.reject_status = reject_status
        self.requests = []
        self.tunneled = bytearray()

    async def handle(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        self.requests.append(head.decode())
        if self.reject_status:
            writer.write(f"HTTP/1.1 {self.reject_status} No\r\n\r\n".encode())
            writer.close()
            return
        up_reader, up_writer = await asyncio.open_connection(
            "127.0.0.1", self.target_port
        )
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")

        async def pipe(src, dst, record=None):
            try:
                while data := await src.read(65536):
                    if record is not None:
                        record.extend(data)
                    dst.write(data)
                    await dst.drain()
            except ConnectionError:
                pass
            finally:
                dst.close()

        await asyncio.gather(
            pipe(reader, up_writer, self.tunneled), pipe(up_reader, writer)
        )


class TlsUpstreamTestCase(unittest.IsolatedAsyncioTestCase):
    """Serves a wss:// upstream for HOST with a certificate the handler trusts."""

    HOST = "live.test"

    def environ(self, **proxies):
        """Patches os.environ to hold only these proxy variables."""
        names = ("http", "https", "wss", "ws", "socks", "all", "no")
        cleared = {
            key: ""
            for key in os.environ
            if key.lower() in {f"{n}_proxy" for n in names}
        }
        return mock.patch.dict("os.environ", {**cleared, **proxies})

    async def serve_tls(self, directory, handler, process_request=None):
        cert_path, key_path = _self_signed_cert(directory, self.HOST)
        server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ssl.load_cert_chain(cert_path, key_path)
        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        server = await websockets.serve(
            handler,
            "127.0.0.1",
            0,
            ssl=server_ssl,
            logger=quiet,
            process_request=process_request,
        )
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        # The handler trusts certifi's bundle; trust the test's certificate.
        self.enterContext(
            mock.patch.object(websocket_handler.certifi, "where", lambda: cert_path)
        )
        return next(iter(server.sockets)).getsockname()[1]


class UpstreamProxyTest(TlsUpstreamTestCase):
    async def test_gateway_ignores_proxy_environment_variables(self):
        async def close(connection):
            await connection.close()

        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        # Nothing listens on port 9, so a connection through the proxy fails.
        proxies = {
            name: "http://127.0.0.1:9"
            for name in ("http_proxy", "https_proxy", "ws_proxy", "all_proxy")
        }
        async with websockets.serve(close, "127.0.0.1", 0, logger=quiet) as server:
            port = next(iter(server.sockets)).getsockname()[1]
            handler = websocket_handler.WebsocketHandler(
                f"ws://127.0.0.1:{port}/ws", "s", None
            )
            with self.environ(**proxies):
                async with handler._connect_upstream(None) as connection:
                    await connection.wait_closed()

    def test_upstream_proxy_reads_the_environment(self):
        url = f"wss://{self.HOST}/ws"
        with self.environ():
            self.assertIsNone(websocket_handler.upstream_proxy(url))
        with self.environ(http_proxy="http://plain:1"):
            # http_proxy is for http:// URLs; requests doesn't use it either.
            self.assertIsNone(websocket_handler.upstream_proxy(url))
        with self.environ(https_proxy="http://corp:3128"):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://corp:3128")
        with self.environ(all_proxy="http://all:8080"):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://all:8080")
        with self.environ(https_proxy="http://corp:3128", no_proxy=".test"):
            self.assertIsNone(websocket_handler.upstream_proxy(url))
        with self.environ(all_proxy="http://all:8080", no_proxy=self.HOST):
            self.assertIsNone(websocket_handler.upstream_proxy(url))
        # No scheme means HTTP, as in requests and curl; websockets refuses it.
        with self.environ(https_proxy="corp:3128"):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://corp:3128")
        with self.environ(all_proxy="user:pw@all:8080"):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "http://user:pw@all:8080"
            )
        with self.environ(https_proxy="socks5h://corp:1080"):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5h://corp:1080"
            )
        with self.environ(socks_proxy="corp:1080", https_proxy="other:3128"):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5h://corp:1080"
            )

    def test_upstream_proxy_ignores_whitespace_and_trims_values(self):
        url = f"wss://{self.HOST}/ws"
        for name in ("wss_proxy", "socks_proxy", "https_proxy", "all_proxy"):
            with self.subTest(blank=name), self.environ(**{name: "  \t\n "}):
                self.assertIsNone(websocket_handler.upstream_proxy(url))
        # A whitespace-only higher-priority setting falls through to lower ones.
        with self.environ(wss_proxy="   ", https_proxy="corp:3128"):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://corp:3128")
        with self.environ(socks_proxy="   ", all_proxy="all:8080"):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://all:8080")
        with self.environ(https_proxy="  http://corp:3128  "):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://corp:3128")
        with self.environ(https_proxy="  corp:3128  "):
            self.assertEqual(websocket_handler.upstream_proxy(url), "http://corp:3128")
        with self.environ(socks_proxy="  http://corp:1080  "):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5h://corp:1080"
            )
        with self.environ(socks_proxy="  HTTP://corp:1080  "):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5h://corp:1080"
            )
        with self.environ(socks_proxy="  corp:1080  "):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5h://corp:1080"
            )

    def test_upstream_proxy_picks_scheme_by_priority_not_value(self):
        url = f"wss://{self.HOST}/ws"
        # wss_proxy has higher priority than socks_proxy even with the same value.
        with self.environ(wss_proxy="proxy.corp:1080", socks_proxy="proxy.corp:1080"):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "http://proxy.corp:1080"
            )
        with self.environ(
            wss_proxy="http://proxy.corp:1080", socks_proxy="http://proxy.corp:1080"
        ):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "http://proxy.corp:1080"
            )
        with self.environ(socks_proxy="proxy.corp:1080", https_proxy="proxy.corp:1080"):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5h://proxy.corp:1080"
            )
        with self.environ(socks_proxy="socks5://proxy.corp:1080"):
            self.assertEqual(
                websocket_handler.upstream_proxy(url), "socks5://proxy.corp:1080"
            )
        with self.environ(
            wss_proxy="proxy.corp:1080",
            socks_proxy="proxy.corp:1080",
            no_proxy=self.HOST,
        ):
            self.assertIsNone(websocket_handler.upstream_proxy(url))

    async def test_upstream_tunnels_through_padded_and_priority_wss_proxy(self):
        async def echo(connection):
            await connection.send(await connection.recv())

        with tempfile.TemporaryDirectory() as directory:
            server_port = await self.serve_tls(directory, echo)
            proxy = ConnectProxy(server_port)
            proxy_port = await self.start_proxy(proxy)
            handler = websocket_handler.WebsocketHandler(
                f"wss://{self.HOST}/ws", "s", None
            )
            # wss_proxy wins over same-value socks_proxy (HTTP CONNECT, not SOCKS)
            # and trims surrounding whitespace.
            addr = f"127.0.0.1:{proxy_port}"
            for env in (
                {"wss_proxy": addr, "socks_proxy": addr},
                {"wss_proxy": f"  {addr}  ", "socks_proxy": addr},
            ):
                with self.subTest(env=env), self.environ(**env):
                    async with handler._connect_upstream("secret-token") as connection:
                        await connection.send("hello")
                        self.assertEqual(await connection.recv(), "hello")
            # Blank proxy env vars connect directly instead of failing with InvalidProxy.
            with self.environ(https_proxy="   ", all_proxy=" \t "):
                with mock.patch.object(
                    websocket_handler, "_NoRedirectConnect"
                ) as connect:
                    handler._connect_upstream("secret-token")
            self.assertIsNone(connect.call_args.kwargs["proxy"])
        self.assertEqual(len(proxy.requests), 2)

    async def test_upstream_tunnels_through_proxy_without_scheme(self):
        async def echo(connection):
            await connection.send(await connection.recv())

        with tempfile.TemporaryDirectory() as directory:
            server_port = await self.serve_tls(directory, echo)
            proxy = ConnectProxy(server_port)
            proxy_port = await self.start_proxy(proxy)
            handler = websocket_handler.WebsocketHandler(
                f"wss://{self.HOST}/ws", "s", None
            )
            with self.environ(https_proxy=f"127.0.0.1:{proxy_port}"):
                async with handler._connect_upstream("secret-token") as connection:
                    await connection.send("hello")
                    self.assertEqual(await connection.recv(), "hello")
        self.assertEqual(len(proxy.requests), 1)

    async def start_proxy(self, proxy):
        server = await asyncio.start_server(proxy.handle, "127.0.0.1", 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        return server.sockets[0].getsockname()[1]

    async def test_upstream_tunnels_through_https_proxy(self):
        received = []

        async def echo(connection):
            received.append(connection.request.headers.get("Authorization"))
            await connection.send(await connection.recv())

        with tempfile.TemporaryDirectory() as directory:
            server_port = await self.serve_tls(directory, echo)
            proxy = ConnectProxy(server_port)
            proxy_port = await self.start_proxy(proxy)
            handler = websocket_handler.WebsocketHandler(
                f"wss://{self.HOST}/ws/live", "s", None
            )
            # live.test doesn't resolve, so only the proxy can reach the server.
            with self.environ(https_proxy=f"http://127.0.0.1:{proxy_port}"):
                async with handler._connect_upstream("secret-token") as connection:
                    await connection.send("hello")
                    self.assertEqual(await connection.recv(), "hello")
        self.assertEqual(len(proxy.requests), 1)
        self.assertTrue(proxy.requests[0].startswith(f"CONNECT {self.HOST}:443 "))
        self.assertEqual(received, ["Bearer secret-token"])
        # The token went through the tunnel encrypted, never in the clear.
        self.assertNotIn("secret-token", proxy.requests[0])
        self.assertNotIn(b"secret-token", bytes(proxy.tunneled))

    async def test_proxy_rejection_is_reported_as_the_proxys(self):
        with tempfile.TemporaryDirectory() as directory:
            server_port = await self.serve_tls(directory, lambda connection: None)
            proxy_port = await self.start_proxy(
                ConnectProxy(server_port, reject_status=407)
            )
            handler = websocket_handler.WebsocketHandler(
                f"wss://{self.HOST}/ws", "s", None
            )
            with self.environ(https_proxy=f"http://127.0.0.1:{proxy_port}"):
                with self.assertRaises(websockets.ProxyError) as caught:
                    await handler._connect_upstream("secret-token")
        self.assertEqual(
            websocket_handler.describe_connect_error(caught.exception),
            "InvalidProxyStatus: proxy rejected connection: HTTP 407",
        )

    async def test_invalid_proxy_setting_hides_its_credentials(self):
        handler = websocket_handler.WebsocketHandler(f"wss://{self.HOST}/ws", "s", None)
        with self.environ(https_proxy="ftp://user:hunter2@corp:21"):
            with self.assertRaises(websockets.InvalidProxy) as caught:
                await handler._connect_upstream("secret-token")
        reason = websocket_handler.describe_connect_error(caught.exception)
        self.assertEqual(reason, "Invalid proxy setting: scheme ftp isn't supported")
        self.assertNotIn("hunter2", reason)


def _access_token(name):
    expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
    return get_credentials.AccessToken(f"token-{name}", expiry, name)


class UpstreamUnauthorizedTest(TlsUpstreamTestCase):
    """A token the upstream rejects is dropped and the handshake retried once."""

    HOST = "localhost"

    def setUp(self):
        self.received = []
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(self.environ())

    def use_sources(self, *results):
        fetch = mock.Mock(side_effect=results)
        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("test source", fetch),))
        )
        return fetch

    async def open_upstream(self, rejected, status=401):
        def check_token(connection, request):
            token = request.headers.get("Authorization")
            self.received.append(token)
            if token in rejected:
                body = json.dumps({"error": {"message": "Invalid credentials"}})
                return connection.respond(status, body)
            return None

        async def close(connection):
            await connection.close()

        with tempfile.TemporaryDirectory() as directory:
            port = await self.serve_tls(directory, close, check_token)
            handler = websocket_handler.WebsocketHandler(
                f"wss://{self.HOST}:{port}/ws", "s", None
            )
            with self.assertLogs(level=logging.INFO) as logs:
                upstream = await handler._open_upstream()
            if upstream is not None:
                await upstream.close()
        self.assertNotIn("token-", "\n".join(logs.output))
        return handler, upstream

    async def test_rejected_cached_token_is_replaced(self):
        get_credentials._cached_token = _access_token("old")
        fetch = self.use_sources(_access_token("new"))
        handler, upstream = await self.open_upstream({"Bearer token-old"})
        self.assertIsNotNone(upstream)
        self.assertEqual(self.received, ["Bearer token-old", "Bearer token-new"])
        self.assertEqual(fetch.call_count, 1)
        # Later sessions use the new token too.
        self.assertEqual(get_credentials._cached_token.token, "token-new")

    async def test_rejected_again_is_not_retried_twice(self):
        get_credentials._cached_token = _access_token("old")
        self.use_sources(_access_token("new"), _access_token("newer"))
        handler, upstream = await self.open_upstream(
            {"Bearer token-old", "Bearer token-new"}
        )
        self.assertIsNone(upstream)
        self.assertEqual(self.received, ["Bearer token-old", "Bearer token-new"])
        self.assertEqual(handler.close_code, 1011)
        self.assertEqual(handler.close_reason, "Upstream HTTP 401: Invalid credentials")

    async def test_same_token_from_the_source_is_not_retried(self):
        fetch = self.use_sources(_access_token("old"), _access_token("old"))
        handler, upstream = await self.open_upstream({"Bearer token-old"})
        self.assertIsNone(upstream)
        self.assertEqual(self.received, ["Bearer token-old"])
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(handler.close_reason, "Upstream HTTP 401: Invalid credentials")

    async def test_failed_refetch_reports_the_401_and_drops_the_token(self):
        get_credentials._cached_token = _access_token("old")
        self.use_sources(RuntimeError("Account restricted"))
        handler, upstream = await self.open_upstream({"Bearer token-old"})
        self.assertIsNone(upstream)
        self.assertEqual(self.received, ["Bearer token-old"])
        self.assertEqual(handler.close_reason, "Upstream HTTP 401: Invalid credentials")
        self.assertIsNone(get_credentials._cached_token)

    async def test_other_rejections_keep_the_token(self):
        get_credentials._cached_token = _access_token("old")
        fetch = self.use_sources(_access_token("new"))
        handler, upstream = await self.open_upstream({"Bearer token-old"}, 403)
        self.assertIsNone(upstream)
        self.assertEqual(self.received, ["Bearer token-old"])
        self.assertEqual(fetch.call_count, 0)
        self.assertEqual(get_credentials._cached_token.token, "token-old")

    async def run_session(self, close_reason):
        """Runs a session whose upstream answers its setup like the Live API."""

        async def close_after_setup(connection):
            self.received.append(connection.request.headers.get("Authorization"))
            await connection.recv()
            await connection.close(1008, close_reason)

        with tempfile.TemporaryDirectory() as directory:
            port = await self.serve_tls(directory, close_after_setup)
            handler = websocket_handler.WebsocketHandler(
                f"wss://{self.HOST}:{port}/ws",
                "s",
                FakeConnection(messages=["setup"]),
                keepalive_s=None,
            )
            with self.assertLogs(level=logging.INFO) as logs:
                await asyncio.wait_for(handler.create_proxy(), 5)
        self.assertNotIn("token-", "\n".join(logs.output))
        return handler

    async def test_invalid_credentials_close_drops_the_token(self):
        # The Live API accepts the handshake with an invalid token and then
        # closes with this (seen from prod-us-rep with a fake token).
        get_credentials._cached_token = _access_token("old")
        handler = await self.run_session(
            "Request had invalid authentication credentials. Expected OAuth 2 "
            "access token, login cookie or other valid authentication c"
        )
        self.assertEqual(handler.close_code, 1008)
        self.assertEqual(self.received, ["Bearer token-old"])
        self.assertIsNone(get_credentials._cached_token)

    async def test_other_policy_closes_keep_the_token(self):
        get_credentials._cached_token = _access_token("old")
        await self.run_session("Publisher Model `gemini-x` was not found")
        self.assertEqual(get_credentials._cached_token.token, "token-old")

    async def test_invalid_header_value_from_websockets_hides_bearer_token(self):
        # Defense in depth: even if a malformed token reaches websockets,
        # neither the server log (checked by open_upstream) nor the browser
        # close reason echoes the header value.
        get_credentials._cached_token = _access_token("secret\r\nX-Inject: 1")
        handler, upstream = await self.open_upstream(set())
        self.assertIsNone(upstream)
        self.assertEqual(handler.close_code, 1011)
        self.assertEqual(
            handler.close_reason,
            "InvalidHeaderValue: invalid Authorization header",
        )
        self.assertNotIn("secret", handler.close_reason)
        self.assertNotIn("X-Inject", handler.close_reason)


class FakeConnection:
    def __init__(self, recv_error=None, messages=(), send_error=None, transport=None):
        self.recv_error = recv_error
        self.messages = list(messages)
        self.send_error = send_error
        self.transport = transport
        self.sent = []
        self.close_code = None
        self.close_reason = ""

    async def recv(self):
        if self.recv_error:
            raise self.recv_error
        if self.messages:
            return self.messages.pop(0)
        await asyncio.Event().wait()

    async def send(self, message):
        if self.send_error:
            raise self.send_error
        self.sent.append(message)

    async def close(self, code=1000, reason=""):
        self.close_code = code


class ForwardFrameTypeTest(unittest.IsolatedAsyncioTestCase):
    async def test_client_binary_frames_stay_binary_upstream(self):
        upstream = FakeConnection()
        client = FakeConnection()
        handler = websocket_handler.WebsocketHandler(
            "ws://unused", "s", client, debug_mode=True, keepalive_s=None
        )
        frames = [b'{"setup": {}}', b"\x00\x01\x02audio?", b"\xff\xfe", '{"text": 1}']
        with self.assertLogs("absl", level="DEBUG") as logs:
            for frame in frames:
                self.assertTrue(await handler._forward(frame, upstream, "c->s"))
        self.assertEqual(upstream.sent, frames)
        self.assertEqual([type(m) for m in upstream.sent], [bytes, bytes, bytes, str])
        self.assertEqual(
            handler.traffic["c->s"], [len(frames), sum(len(f) for f in frames)]
        )
        debug_lines = [
            r.getMessage() for r in logs.records if "c->s proxying" in r.getMessage()
        ]
        self.assertEqual(len(debug_lines), len(frames))
        self.assertTrue(debug_lines[0].endswith("<binary>"), debug_lines[0])
        self.assertTrue(debug_lines[1].endswith("<binary>"), debug_lines[1])
        self.assertTrue(debug_lines[2].endswith("<binary>"), debug_lines[2])
        self.assertTrue(debug_lines[3].endswith('{"text": 1}'), debug_lines[3])

    async def test_upstream_utf8_binary_frames_decode_to_text_for_browser(self):
        client = FakeConnection()
        handler = websocket_handler.WebsocketHandler(
            "ws://unused", "s", client, keepalive_s=None
        )
        frames = [b'{"setupComplete": {}}', b"\xff\xfe", '{"plain": true}']
        for frame in frames:
            self.assertTrue(await handler._forward(frame, client, "s->c"))
        self.assertEqual(
            client.sent, ['{"setupComplete": {}}', b"\xff\xfe", '{"plain": true}']
        )
        self.assertEqual([type(m) for m in client.sent], [str, bytes, str])


class ProxyErrorTest(unittest.IsolatedAsyncioTestCase):
    async def test_unexpected_relay_error_ends_session_with_1011(self):
        # The finished task's error was never retrieved, so the session ended
        # as a clean 1000 and nothing was logged.
        upstream = FakeConnection(recv_error=RuntimeError("boom"))
        handler = websocket_handler.WebsocketHandler(
            "ws://unused", "s", FakeConnection(), keepalive_s=None
        )
        with mock.patch.object(
            handler, "_connect_upstream", return_value=asyncio.sleep(0, upstream)
        ):
            with self.assertLogs("absl", level="ERROR") as logs:
                await handler.create_proxy()
        self.assertEqual(upstream.close_code, 1011)
        self.assertEqual(
            handler.client_close_frame(), (1011, "Proxy error: RuntimeError")
        )
        self.assertIn("boom", "\n".join(logs.output))

    async def run_proxy(self, client, upstream):
        handler = websocket_handler.WebsocketHandler(
            "ws://unused", "s", client, keepalive_s=None
        )
        with mock.patch.object(
            handler, "_connect_upstream", return_value=asyncio.sleep(0, upstream)
        ):
            await asyncio.wait_for(handler.create_proxy(), 5)
        return handler

    async def test_send_error_other_than_closed_ends_session_with_1011(self):
        # Every send() error counted as "target closed": a bug ended the
        # session as a clean 1000 with one INFO line and no traceback.
        upstream = FakeConnection(send_error=TypeError("bad frame"))
        with self.assertLogs("absl", level="ERROR") as logs:
            handler = await self.run_proxy(FakeConnection(messages=["hi"]), upstream)
        self.assertEqual(upstream.close_code, 1011)
        self.assertEqual(handler.client_close_frame(), (1011, "Proxy error: TypeError"))
        self.assertIn("Traceback", "\n".join(logs.output))
        self.assertIn("bad frame", "\n".join(logs.output))

    async def test_send_to_closed_browser_ends_session_cleanly(self):
        # What aiohttp raises when sending on a closed WebSocketResponse.
        client = FakeConnection(
            send_error=aiohttp.ClientConnectionResetError(
                "Cannot write to closing transport"
            )
        )
        upstream = FakeConnection(messages=["hi"])
        with self.assertNoLogs("absl", level="ERROR"):
            handler = await self.run_proxy(client, upstream)
        self.assertTrue(handler.client_closed)
        self.assertEqual(upstream.close_code, 1000)
        self.assertEqual(handler.client_close_frame(), (1000, ""))

    async def test_send_to_closed_upstream_ends_session_cleanly(self):
        upstream = FakeConnection(
            send_error=websockets.exceptions.ConnectionClosedOK(None, None)
        )
        with self.assertNoLogs("absl", level="ERROR"):
            handler = await self.run_proxy(FakeConnection(messages=["hi"]), upstream)
        self.assertFalse(handler.client_closed)
        self.assertEqual(upstream.close_code, 1000)


async def _handshake_raw_ws(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """Completes a minimal RFC 6455 upgrade so the test controls close frames."""
    req = await reader.readuntil(b"\r\n\r\n")
    key = ""
    for line in req.decode("latin1").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
            break
    accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    writer.write(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode()
    )
    await writer.drain()


class ProxyCancellationCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._saved_cached_token = get_credentials._cached_token

    async def asyncTearDown(self):
        get_credentials._cached_token = self._saved_cached_token

    async def _start_raw_server(self, client_cb):
        writers = []

        async def wrapped(reader, writer):
            writers.append(writer)
            try:
                await client_cb(reader, writer)
            finally:
                writer.close()

        server = await asyncio.start_server(wrapped, "127.0.0.1", 0)

        async def stop():
            server.close()
            for w in writers:
                w.close()
            await server.wait_closed()

        self.addAsyncCleanup(stop)
        return server.sockets[0].getsockname()[1]

    async def test_second_cancel_during_upstream_close_aborts_socket_and_cleans_up(
        self,
    ):
        close_frame_seen = asyncio.Event()
        eof_seen = asyncio.Event()

        async def unresponsive_close(reader, writer):
            await _handshake_raw_ws(reader, writer)
            data = await reader.read(1024)
            if data:
                close_frame_seen.set()
            # Keep TCP open without replying until the client aborts.
            while await reader.read(1024):
                pass
            eof_seen.set()

        port = await self._start_raw_server(unresponsive_close)
        handler = websocket_handler.WebsocketHandler(
            f"ws://127.0.0.1:{port}/ws", "s-cancel", FakeConnection(), keepalive_s=None
        )
        with self.assertLogs("absl", level="INFO") as logs:
            session = asyncio.create_task(handler.start_websocket())
            async with asyncio.timeout(5):
                while handler.server_websocket is None:
                    await asyncio.sleep(0.02)
                # First cancel enters create_proxy()'s finally: and sends Close(1001).
                assert handler.connection_handler is not None
                handler.connection_handler.cancel()
                await close_frame_seen.wait()
                # Second cancel interrupts await server_websocket.close(1001).
                await handler.end_websocket()
                with self.assertRaises(asyncio.CancelledError):
                    await session
                await eof_seen.wait()

        self.assertIsNone(handler.server_websocket)
        self.assertEqual(handler.close_code, 1006)
        self.assertTrue(
            any("Session s-cancel ended after" in line for line in logs.output),
            logs.output,
        )

    async def test_cancel_during_upstream_close_still_drops_rejected_token(self):
        close_frame_sent = asyncio.Event()
        eof_seen = asyncio.Event()

        async def close_1008_then_hang(reader, writer):
            await _handshake_raw_ws(reader, writer)
            # Send Close(1008, invalid credentials) and keep TCP open so the
            # client's close() waits for TCP EOF while close_rcvd is set.
            reason = b"Request had invalid authentication credentials."
            payload = struct.pack("!H", 1008) + reason
            writer.write(bytes([0x88, len(payload)]) + payload)
            await writer.drain()
            close_frame_sent.set()
            while await reader.read(1024):
                pass
            eof_seen.set()

        port = await self._start_raw_server(close_1008_then_hang)
        token = _access_token("revoked")
        get_credentials._cached_token = token
        handler = websocket_handler.WebsocketHandler(
            f"ws://127.0.0.1:{port}/ws", "s-token", FakeConnection(), keepalive_s=None
        )

        close_entered = asyncio.Event()
        orig_open = handler._open_upstream

        async def open_with_token():
            ws = await orig_open()
            assert ws is not None
            handler.upstream_token = token
            orig_close = ws.close

            async def tracked_close(*args, **kwargs):
                close_entered.set()
                return await orig_close(*args, **kwargs)

            ws.close = tracked_close
            return ws

        with (
            mock.patch.object(handler, "_open_upstream", side_effect=open_with_token),
            self.assertLogs("absl", level="INFO") as logs,
        ):
            session = asyncio.create_task(handler.start_websocket())
            async with asyncio.timeout(5):
                while handler.server_websocket is None:
                    await asyncio.sleep(0.02)
                await close_frame_sent.wait()
                # Wait until websockets has parsed the server's 1008 Close frame.
                while (
                    getattr(
                        getattr(handler.server_websocket, "protocol", None),
                        "close_rcvd",
                        None,
                    )
                    is None
                ):
                    await asyncio.sleep(0.02)
                # First cancel starts close(); second cancel interrupts it.
                assert handler.connection_handler is not None
                handler.connection_handler.cancel()
                await close_entered.wait()
                await handler.end_websocket()
                with self.assertRaises(asyncio.CancelledError):
                    await session
                await eof_seen.wait()

        self.assertIsNone(handler.server_websocket)
        self.assertEqual(handler.close_code, 1008)
        self.assertIn(
            "invalid authentication credentials", handler.close_reason.lower()
        )
        self.assertIsNone(get_credentials._cached_token)
        self.assertTrue(
            any("Session s-token ended after" in line for line in logs.output),
            logs.output,
        )

    async def test_second_cancel_during_relay_gather_aborts_upstream_and_records_error(
        self,
    ):
        in_client_cleanup = asyncio.Event()
        release_client_cleanup = asyncio.Event()
        self.addCleanup(release_client_cleanup.set)

        class SlowCancelClient(FakeConnection):
            async def recv(self):
                try:
                    await asyncio.Event().wait()
                finally:
                    # Only pause during the relay phase (not the pre-connect watch).
                    if handler.server_websocket is not None:
                        in_client_cleanup.set()
                        await release_client_cleanup.wait()

        upstream = FakeConnection(recv_error=RuntimeError("boom"))
        upstream.transport = mock.Mock()
        handler = websocket_handler.WebsocketHandler(
            "ws://unused", "s-gather", SlowCancelClient(), keepalive_s=None
        )
        with (
            mock.patch.object(
                handler, "_connect_upstream", return_value=asyncio.sleep(0, upstream)
            ),
            self.assertLogs("absl", level="INFO") as logs,
        ):
            task = asyncio.create_task(handler.create_proxy())
            async with asyncio.timeout(5):
                await in_client_cleanup.wait()
                # Interrupt create_proxy()'s finally: while it awaits gather().
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        upstream.transport.abort.assert_called_once()
        self.assertIsNone(handler.server_websocket)
        self.assertEqual(
            handler.client_close_frame(), (1011, "Proxy error: RuntimeError")
        )
        output = "\n".join(logs.output)
        self.assertIn("boom", output)
        self.assertIn("Session s-gather ended after", output)

    async def test_second_cancel_during_connect_close_aborts_unused_upstream(self):
        close_frame_seen = asyncio.Event()
        eof_seen = asyncio.Event()

        async def unresponsive_close(reader, writer):
            await _handshake_raw_ws(reader, writer)
            data = await reader.read(1024)
            if data:
                close_frame_seen.set()
            while await reader.read(1024):
                pass
            eof_seen.set()

        port = await self._start_raw_server(unresponsive_close)
        # Browser leaves in the same turn upstream opens, so
        # _connect_while_watching_client's finally: closes the unused upstream.
        browser_closed = asyncio.Event()

        class ClosingClient(FakeConnection):
            async def recv(self):
                await browser_closed.wait()
                raise websockets.exceptions.ConnectionClosedOK(None, None)

        handler = websocket_handler.WebsocketHandler(
            f"ws://127.0.0.1:{port}/ws", "s-conn", ClosingClient(), keepalive_s=None
        )
        orig_open = handler._open_upstream

        async def open_then_let_browser_leave():
            ws = await orig_open()
            browser_closed.set()
            return ws

        with mock.patch.object(
            handler, "_open_upstream", side_effect=open_then_let_browser_leave
        ):
            task = asyncio.create_task(handler.create_proxy())
            async with asyncio.timeout(5):
                await close_frame_seen.wait()
                # Interrupt await upstream.close(1001) in _connect_while_watching_client.
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                await eof_seen.wait()


if __name__ == "__main__":
    unittest.main()
