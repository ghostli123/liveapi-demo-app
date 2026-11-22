import asyncio
import datetime
import json
import logging
import os
import ssl
import tempfile
import types
import unittest
from unittest import mock

import aiohttp
import websockets
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

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
        self.assertEqual(
            websocket_handler.describe_connect_error(OSError("refused")),
            "OSError: refused",
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
        reason = websocket_handler.describe_connect_error(OSError("a\nb " + "c" * 500))
        self.assertTrue(reason.startswith("OSError: a b ccc"))
        self.assertEqual(len(reason), websocket_handler._MAX_CONNECT_ERROR_CHARS)


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


class UpstreamProxyTest(unittest.IsolatedAsyncioTestCase):
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

    async def serve_tls(self, directory, handler):
        cert_path, key_path = _self_signed_cert(directory, self.HOST)
        server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ssl.load_cert_chain(cert_path, key_path)
        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        server = await websockets.serve(
            handler, "127.0.0.1", 0, ssl=server_ssl, logger=quiet
        )
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        # The handler trusts certifi's bundle; trust the test's certificate.
        self.enterContext(
            mock.patch.object(websocket_handler.certifi, "where", lambda: cert_path)
        )
        return next(iter(server.sockets)).getsockname()[1]

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


class FakeConnection:
    def __init__(self, recv_error=None, messages=(), send_error=None):
        self.recv_error = recv_error
        self.messages = list(messages)
        self.send_error = send_error
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

    async def close(self, code=1000, reason=""):
        self.close_code = code


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


if __name__ == "__main__":
    unittest.main()
