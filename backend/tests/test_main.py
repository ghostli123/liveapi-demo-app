import asyncio
import base64
import concurrent.futures
import datetime
import gzip
import hashlib
import html.parser
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.parse
import urllib.request

import aiohttp
from aiohttp import test_utils, web
from absl import flags
from absl.testing import flagsaver
import websockets

import get_credentials
import main
import session_management
import websocket_handler


class ResolveWsHostTest(unittest.TestCase):
    def test_frontend_environments(self):
        cases = {
            # (endpoint, location): expected host
            ("autopush-common", "us-central1"): "autopush-common",
            ("autopush-vertex-us-bidi", ""): "autopush-vertex-us-bidi",
            (
                "aiplatform.us.rep.googleapis.com",
                "us-central1",
            ): "aiplatform.us.rep.googleapis.com",
            (
                "staging-aiplatform.us.rep.sandbox.googleapis.com",
                "us-central1",
            ): "staging-aiplatform.us.rep.sandbox.googleapis.com",
            (
                "aiplatform.googleapis.com",
                "us-central1",
            ): "us-central1-aiplatform.googleapis.com",
            (
                "autopush-aiplatform.sandbox.googleapis.com",
                "europe-west4",
            ): "europe-west4-autopush-aiplatform.sandbox.googleapis.com",
            ("aiplatform.googleapis.com", "us"): "aiplatform.us.rep.googleapis.com",
            (
                "staging-aiplatform.sandbox.googleapis.com",
                "eu",
            ): "staging-aiplatform.eu.rep.sandbox.googleapis.com",
            ("aiplatform.googleapis.com", "global"): "aiplatform.googleapis.com",
        }
        for (endpoint, location), expected in cases.items():
            with self.subTest(endpoint=endpoint, location=location):
                self.assertEqual(main.resolve_ws_host(endpoint, location), expected)

    def test_rejects_hosts_outside_allowlist(self):
        cases = [
            ("evil.rep.attacker.com", "us-central1"),
            ("global-attacker.com", "us-central1"),
            ("aiplatform.googleapis.com.attacker.com", "us-central1"),
            ("attacker.com/x.googleapis.com", "us-central1"),
            ("aiplatform.googleapis.com", "x.attacker.com/"),
            ("aiplatform.googleapis.com", "us-central1@attacker.com#"),
            ("aiplatform.googleapis.com", None),
            (None, "us-central1"),
            ("", "us-central1"),
        ]
        for endpoint, location in cases:
            with self.subTest(endpoint=endpoint, location=location):
                with self.assertRaises(ValueError):
                    main.resolve_ws_host(endpoint, location)

    def test_allowed_host_suffixes_flag(self):
        with flagsaver.flagsaver(allowed_host_suffixes=[".example.com"]):
            self.assertEqual(
                main.resolve_ws_host("live.rep.example.com", "us"),
                "live.rep.example.com",
            )
            with self.assertRaises(ValueError):
                main.resolve_ws_host("aiplatform.googleapis.com", "us-central1")

    def test_allowed_host_suffixes_match_at_a_dot(self):
        for suffixes in ([".googleapis.com"], ["googleapis.com"], ["GoogleAPIs.com."]):
            with self.subTest(suffixes=suffixes):
                with flagsaver.flagsaver(allowed_host_suffixes=suffixes):
                    self.assertEqual(
                        main.resolve_ws_host("aiplatform.googleapis.com", "us"),
                        "aiplatform.us.rep.googleapis.com",
                    )
                    # "evilgoogleapis.com" ends with "googleapis.com" but is
                    # someone else's domain.
                    for endpoint in (
                        "x.rep.evilgoogleapis.com",
                        "global-evilgoogleapis.com",
                    ):
                        with self.assertRaises(ValueError, msg=endpoint):
                            main.resolve_ws_host(endpoint, "us")
        with flagsaver.flagsaver(allowed_host_suffixes=["live.rep.example.com"]):
            self.assertEqual(
                main.resolve_ws_host("live.rep.example.com", "us"),
                "live.rep.example.com",
            )

    def test_blank_allowed_host_suffix_matches_nothing(self):
        # A trailing comma in the flag adds "", which every host ends with.
        with flagsaver.flagsaver(allowed_host_suffixes=[".googleapis.com", ""]):
            with self.assertRaises(ValueError):
                main.resolve_ws_host("evil.rep.attacker.com", "us")
            self.assertEqual(
                main.resolve_ws_host("aiplatform.googleapis.com", "global"),
                "aiplatform.googleapis.com",
            )

    def test_allowed_host_suffixes_validator(self):
        for entry in [
            "com",
            ".com",
            ".",
            "..",
            "...",
            " . ",
            "*",
            "googleapis.com/x",
            "a..b.com",
            "..googleapis.com",
            ".googleapis.com..",
            "googleapis.com..",
            "..googleapis.com.",
            "..googleapis.com..",
            "https://x.com",
        ]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=entry):
                with flagsaver.flagsaver(
                    allowed_host_suffixes=[".googleapis.com", entry]
                ):
                    pass
        with flagsaver.flagsaver(
            allowed_host_suffixes=[
                ".googleapis.com",
                "example.com",
                "example.com.",
                " .Example.ORG. ",
                "",
                "   ",
            ]
        ):
            pass


class FakeUpstream:
    """A local stand-in for the Live API, reached through the common BAG route."""

    def __init__(self):
        self.received = []
        # The close code each connection received from the proxy.
        self.close_codes = []

    async def handler(self, connection):
        try:
            async for message in connection:
                self.received.append(message)
                if message == "close-please":
                    await connection.close(code=1008, reason="Quota exceeded")
                    return
                # The Live API sends JSON in binary frames.
                if isinstance(message, bytes):
                    await connection.send(
                        json.dumps({"echo_bytes": message.decode("latin-1")}).encode()
                    )
                else:
                    await connection.send(json.dumps({"echo": message}).encode())
        finally:
            self.close_codes.append(connection.close_code)

    async def wait_for_close_codes(self, count, timeout=5):
        async with asyncio.timeout(timeout):
            while len(self.close_codes) < count:
                await asyncio.sleep(0.02)
        return self.close_codes

    async def __aenter__(self):
        self.server = await websockets.serve(self.handler, "127.0.0.1", 0)
        self.port = next(iter(self.server.sockets)).getsockname()[1]
        return self

    async def __aexit__(self, *exc_info):
        self.server.close()
        await self.server.wait_closed()


class UnresponsiveUpstream:
    """Accepts the WebSocket handshake, then ignores everything, pings included.

    Stands in for an upstream that has silently gone away (e.g. a dropped NAT
    mapping); a websockets server can't be used because it always answers pings.
    """

    def __init__(self):
        self.writers = []

    async def handler(self, reader, writer):
        self.writers.append(writer)
        request = await reader.readuntil(b"\r\n\r\n")
        key = next(
            line.split(b":", 1)[1].strip()
            for line in request.split(b"\r\n")
            if line.lower().startswith(b"sec-websocket-key:")
        )
        accept = base64.b64encode(
            hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest()
        )
        writer.write(
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n"
        )
        while await reader.read(65536):
            pass

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc_info):
        for writer in self.writers:
            writer.close()
        self.server.close()
        await self.server.wait_closed()


class ProductionTestServer(test_utils.TestServer):
    """A TestServer whose runner is configured like main_async's.

    aiohttp's TestServer cancels a handler as soon as its client disconnects;
    the AppRunner in main_async doesn't, so a browser that closes its WebSocket
    and drops the connection lets the handler finish normally.
    """

    async def _make_runner(self, **kwargs):
        kwargs["handler_cancellation"] = False
        return await super()._make_runner(**kwargs)


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main.SESSION_MANAGER = session_management.SessionManager()
        self.client = test_utils.TestClient(
            ProductionTestServer(await main.create_app())
        )
        await self.client.start_server()
        patcher = mock.patch.object(
            main, "initialize_gemini_chat_session", side_effect=RuntimeError("no creds")
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    async def asyncTearDown(self):
        await self.client.close()

    async def connect_session(self, session_id, endpoint="autopush-common"):
        resp = await self.client.post(
            "/api/control",
            json={
                "command": "connect",
                "session_id": session_id,
                "endpoint": endpoint,
                "location": "us-central1",
            },
        )
        return resp.status, await resp.json()

    async def test_proxy_round_trip_and_close_relay(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                status, body = await self.connect_session("s1")
                self.assertEqual(status, 200, body)
                self.assertEqual(body["project_id"], main.DEFAULT_PROJECT_ID)
                self.assertEqual(body["idle_timeout_s"], 900)

                ws = await self.client.ws_connect("/ws?session_id=s1")
                await ws.send_str('{"setup": {}}')
                msg = await asyncio.wait_for(ws.receive(), 5)
                # Binary upstream frames reach the browser as text frames.
                self.assertEqual(msg.type, aiohttp.WSMsgType.TEXT)
                self.assertEqual(json.loads(msg.data), {"echo": '{"setup": {}}'})

                await ws.send_str("close-please")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
                self.assertEqual(msg.data, 1008)
                self.assertEqual(msg.extra, "Quota exceeded")
                await ws.close()

        self.assertEqual(upstream.received, ['{"setup": {}}', "close-please"])

    async def test_session_summary_is_logged(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s15")
                with self.assertLogs("absl", level="INFO") as logs:
                    ws = await self.client.ws_connect("/ws?session_id=s15")
                    await ws.send_str("ping")
                    await asyncio.wait_for(ws.receive(), 5)
                    await ws.send_str("close-please")
                    await asyncio.wait_for(ws.receive(), 5)
                    await ws.close()
                    await self.wait_for_session_end("s15")
        summary = [line for line in logs.output if "Session s15 ended after" in line]
        self.assertEqual(len(summary), 1, logs.output)
        self.assertIn("upstream close 1008 Quota exceeded", summary[0])
        self.assertIn("1 messages / 0.0 MB to the browser, 2 messages", summary[0])
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s15"))

    async def test_upstream_unreachable_closes_with_reason(self):
        async with FakeUpstream() as upstream:
            unused_port = upstream.port
        with flagsaver.flagsaver(common_bag_ws_port=unused_port):
            await self.connect_session("s2")
            ws = await self.client.ws_connect("/ws?session_id=s2")
            msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1011)
        # The address it tried (an internal proxy, in production) stays in
        # the log.
        self.assertEqual(
            msg.extra,
            "Could not connect to the Live API (ConnectionRefusedError); "
            "see the server log",
        )
        self.assertNotIn(str(unused_port), str(msg.extra))

    async def test_missing_credentials_close_with_reason(self):
        # Cleanup used to re-raise the failed proxy task's error, so the
        # handler died before closing and the browser saw 1006, no reason.
        # The error's text (gcloud's stderr, file paths) used to be the reason.
        with tempfile.TemporaryDirectory() as bin_dir:
            gcloud = os.path.join(bin_dir, "gcloud")
            with open(gcloud, "w") as f:
                f.write(
                    "#!/bin/sh\n"
                    "echo 'ERROR: (gcloud) cannot read /home/u/.config/gcloud/adc.json' >&2\n"
                    "exit 1\n"
                )
            os.chmod(gcloud, 0o755)
            self.enterContext(mock.patch.dict(os.environ, {"PATH": bin_dir}))
            self.enterContext(
                mock.patch.object(
                    main.get_credentials,
                    "_SOURCES",
                    (("gcloud CLI", main.get_credentials._token_from_gcloud),),
                )
            )
            self.enterContext(
                mock.patch.object(main.get_credentials, "_cached_token", None)
            )
            await self.connect_session("s16", endpoint="aiplatform.googleapis.com")
            with self.assertLogs("absl", level="WARNING") as logs:
                ws = await self.client.ws_connect("/ws?session_id=s16")
                msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1011)
        self.assertEqual(msg.extra, websocket_handler.CREDENTIALS_ERROR_REASON)
        self.assertTrue(
            any("/home/u/.config/gcloud/adc.json" in line for line in logs.output),
            logs.output,
        )
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s16"))

    async def test_ws_requires_known_session(self):
        resp = await self.client.get("/ws?session_id=unknown")
        self.assertEqual(resp.status, 404)
        resp = await self.client.get("/ws")
        self.assertEqual(resp.status, 400)

    async def test_non_upgrade_request_keeps_pending_session(self):
        # A plain GET (a link preview, a curl) used to fail in ws.prepare after
        # the claim, and the cleanup deleted the browser's pending record.
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s49")
                resp = await self.client.get("/ws?session_id=s49")
                self.assertEqual(resp.status, 400)
                self.assertIn("WebSocket", await resp.text())
                record = await main.SESSION_MANAGER.search_item("s49")
                assert record is not None
                self.assertIsNone(record.websocket_handler)

                ws = await self.client.ws_connect("/ws?session_id=s49")
                await ws.send_str("ping")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(json.loads(msg.data), {"echo": "ping"})
                await ws.close()

    async def test_control_rejects_bad_requests(self):
        status, body = await self.connect_session(
            "s3", endpoint="evil.rep.attacker.com"
        )
        self.assertEqual(status, 400)
        self.assertIn("not an allowed", body["error"])

        resp = await self.client.post("/api/control", data="not json")
        self.assertEqual(resp.status, 400)
        resp = await self.client.post(
            "/api/control", json={"command": "connect", "session_id": "bad id"}
        )
        self.assertEqual(resp.status, 400)
        resp = await self.client.post(
            "/api/control", json={"command": "explode", "session_id": "s3"}
        )
        self.assertEqual(resp.status, 400)
        resp = await self.client.post(
            "/api/control", json={"command": "disconnect", "session_id": ["s3"]}
        )
        self.assertEqual(resp.status, 400)

    async def test_control_rejects_non_string_endpoints(self):
        # A list or object used to reach the environment set and fail with 500.
        for endpoint in ([], {}, ["autopush-common"], 5):
            resp = await self.client.post(
                "/api/control",
                json={
                    "command": "connect",
                    "session_id": "s20",
                    "endpoint": endpoint,
                    "location": "us-central1",
                },
            )
            self.assertEqual(resp.status, 400, endpoint)
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s20"))

    async def test_session_ids_with_trailing_newline_rejected(self):
        status, _ = await self.connect_session("s21\n")
        self.assertEqual(status, 400)
        resp = await self.client.get("/ws", params={"session_id": "s21\n"})
        self.assertEqual(resp.status, 400)

    async def test_undecodable_bodies_rejected(self):
        # Each of these used to escape the JSON parsing and answer 500.
        bodies = {
            "deep nesting": ("[" * 100_000, "application/json"),
            "huge integer": ('{"n": ' + "9" * 5000 + "}", "application/json"),
            "unknown charset": ("{}", "application/json; charset=no-such-codec"),
            "bad utf-8": (b'{"a": "\xff"}', "application/json"),
        }
        for path in ("/api/control", "/api/post_endpoint"):
            for name, (data, content_type) in bodies.items():
                resp = await self.client.post(
                    path, data=data, headers={"Content-Type": content_type}
                )
                self.assertEqual(resp.status, 400, f"{path} {name}")

    async def test_corrupt_compressed_bodies_rejected_without_error_log(self):
        # A body whose Content-Encoding fails mid-stream raises
        # RequestPayloadError from request.json() and leaves the stream
        # errored; both the handler and aiohttp's post-handler drain used to
        # log ERROR tracebacks and answer 500.
        cases = {
            "corrupt gzip": ("gzip", b"abcd"),
            "corrupt zlib-header deflate": ("deflate", b"\x78\x9c\xff\xff"),
        }
        for path in ("/api/control", "/api/post_endpoint"):
            for name, (encoding, data) in cases.items():
                with self.assertNoLogs("aiohttp.server", level="ERROR"):
                    resp = await self.client.post(
                        path,
                        data=data,
                        headers={
                            "Content-Type": "application/json",
                            "Content-Encoding": encoding,
                        },
                    )
                    self.assertEqual(resp.status, 400, f"{path} {name}")
                    body = await resp.json()
                    self.assertEqual(
                        body, {"error": "Request body must be a JSON object"}
                    )
                    # Let aiohttp finish the post-handler drain on the server
                    # before assertNoLogs exits.
                    await asyncio.sleep(0)
        # Valid gzip still works after corrupt compressed requests.
        payload = gzip.compress(
            json.dumps(
                {
                    "command": "connect",
                    "session_id": "s-gzip",
                    "endpoint": "autopush-common",
                    "location": "us-central1",
                }
            ).encode()
        )
        resp = await self.client.post(
            "/api/control",
            data=payload,
            headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
        )
        self.assertEqual(resp.status, 200)

    async def test_unparsable_host_and_origin_rejected(self):
        body = {
            "command": "connect",
            "session_id": "s22",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        # urlsplit raises on an unclosed IPv6 bracket; that used to be a 500.
        for headers, status in (
            ({"Host": "["}, 400),
            ({"Host": "localhost:0", "Origin": "http://localhost:0"}, 400),
            ({"Origin": "http://["}, 403),
        ):
            resp = await self.client.post("/api/control", json=body, headers=headers)
            self.assertEqual(resp.status, status, headers)
            resp = await self.client.get("/ws?session_id=s22", headers=headers)
            self.assertEqual(resp.status, status, headers)
        # aiohttp decodes a non-ASCII Host byte to a surrogate, which the 403
        # reply couldn't encode (a 500).
        for method, path in (("POST", "/api/control"), ("GET", "/ws?session_id=s22")):
            status = await self._raw_request(method, path, "Host: evil\xe9.example")
            self.assertEqual(status, 400, method)
        # Userinfo, path/query/fragment, backslash, invalid port, whitespace,
        # or empty Host headers would otherwise parse to hostname="localhost"
        # (or None) in urlsplit() and bypass the Host check or return 403 None.
        malformed_hosts = [
            "evil.com@localhost:8080",
            "evil.com\\@localhost:8080",
            "localhost/foo",
            "localhost?foo",
            "localhost#foo",
            "localhost\\foo",
            "localhost:notaport",
            "localhost:",
            "[::1]:",
            "127.0.0.1:",
            "localhost:0",
            "localhost:00",
            "[::1]:0",
            "localhost:99999",
            "local host:8080",
            ".",
            "..",
            ".localhost",
            "foo..localhost",
            "localhost..",
            ".localhost:8080",
            "foo..localhost:8080",
            "localhost..:8080",
            "",
        ]
        for bad_host in malformed_hosts:
            for method, path in (
                ("POST", "/api/control"),
                ("GET", "/ws?session_id=s22"),
            ):
                status = await self._raw_request(method, path, f"Host: {bad_host}")
                self.assertEqual(status, 400, (method, bad_host))
        # Malformed Origin headers (non-HTTP(S) scheme, userinfo, trailing empty
        # port, malformed dot-labels, or path/query/fragment) must be rejected
        # even if their hostname matches Host or --allowed_hosts.
        for bad_origin in [
            "http://.",
            "http://..",
            "http://.example.com",
            "http://foo..bar",
            "http://localhost..",
            "http://localhost:",
            "http://[::1]:",
        ]:
            self.assertIsNone(main._parse_origin(bad_origin), bad_origin)
        own_netloc = f"{self.client.host}:{self.client.port}"
        for bad_origin in [
            f"javascript://{own_netloc}",
            f"http://{own_netloc}/path",
            f"http://{own_netloc}?q=1",
            f"http://{own_netloc}#frag",
        ]:
            resp = await self.client.post(
                "/api/control", json=body, headers={"Origin": bad_origin}
            )
            self.assertEqual(resp.status, 403, bad_origin)
        with flagsaver.flagsaver(allowed_hosts=["demo.example"]):
            for bad_origin in [
                "https://evil.com@demo.example",
                "ftp://demo.example",
                "https://demo.example/path",
                "https://demo.example?q=1",
                "https://demo.example#frag",
                "https://demo.example:",
                "https://demo.example..",
                "https://demo.example..:443",
                "https://.demo.example",
                "https://foo..demo.example",
                "https://.",
                "https://..",
            ]:
                resp = await self.client.post(
                    "/api/control", json=body, headers={"Origin": bad_origin}
                )
                self.assertEqual(resp.status, 403, bad_origin)
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s22"))

    async def test_fr_endpoint_reports_unavailable_simulator(self):
        await self.connect_session("s4")
        resp = await self.client.post(
            "/api/post_endpoint",
            json={"session_id": "s4", "objective": "fr_generate", "functionName": "f"},
        )
        self.assertEqual(resp.status, 503)
        self.assertEqual(
            (await resp.json())["error"],
            "Function response simulator unavailable (RuntimeError); "
            "see the server log",
        )

        resp = await self.client.post(
            "/api/post_endpoint",
            json={"session_id": "nope", "objective": "fr_generate"},
        )
        self.assertEqual(resp.status, 404)

    async def test_fr_endpoint_failure_shows_only_the_error_type(self):
        # A failed token refresh inside the genai client carries every
        # source's error, gcloud's stderr and helper paths included.
        chat = mock.Mock()
        chat.send_message = mock.AsyncMock(
            side_effect=[
                RuntimeError(
                    "No access token available. LOAS helper: RuntimeError: "
                    "helper not found at /srv/app/backend/common_bag_ws_proxy.par"
                ),
                main.genai_errors.ClientError(
                    429,
                    {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}},
                ),
            ]
        )
        with mock.patch.object(
            main, "initialize_gemini_chat_session", return_value=chat
        ):
            await self.connect_session("s5")
        body = {"session_id": "s5", "objective": "fr_generate", "functionName": "f"}
        errors = []
        with self.assertLogs("absl", level="ERROR") as logs:
            for _ in range(2):
                resp = await self.client.post("/api/post_endpoint", json=body)
                self.assertEqual(resp.status, 502)
                errors.append((await resp.json())["error"])
        self.assertEqual(
            errors,
            [
                "Function response simulator failed (RuntimeError); see the server log",
                "Function response simulator failed (429 RESOURCE_EXHAUSTED)",
            ],
        )
        self.assertIn("common_bag_ws_proxy.par", "\n".join(logs.output))

    async def test_fr_endpoint_rejects_invalid_session_ids(self):
        # A list or object used to reach the session dict and fail with 500.
        for session_id in (["s4"], {"id": "s4"}, 5, None, "bad id"):
            resp = await self.client.post(
                "/api/post_endpoint",
                json={"session_id": session_id, "objective": "fr_generate"},
            )
            self.assertEqual(resp.status, 400, session_id)
            self.assertIn("session_id", (await resp.json())["error"])

    async def test_fr_endpoint_debug_log_quotes_objective(self):
        await self.connect_session("s4_log")
        forged = "I1124 09:00:00.000000 1 main.py:1] forged"
        for sep in ("\n", "\r", "\x1b", "\u2028", "\x85"):
            objective = f"bad{sep}{forged}"
            with self.assertLogs("absl", level="DEBUG") as logs:
                resp = await self.client.post(
                    "/api/post_endpoint",
                    json={"session_id": "s4_log", "objective": objective},
                )
            self.assertEqual(resp.status, 400)
            [message] = [
                r.getMessage()
                for r in logs.records
                if r.getMessage().startswith("Received ")
            ]
            self.assertTrue(message.isprintable(), repr(message))
            self.assertIn(repr(objective), message)

    async def test_fr_definitions_go_with_the_first_call_only(self):
        class FakeChat:
            def __init__(self):
                self.messages = []

            async def send_message(self, parts):
                self.messages.append([p.text for p in parts])
                return mock.Mock(text='{"ok": true}')

        chat = FakeChat()
        with mock.patch.object(
            main, "initialize_gemini_chat_session", return_value=chat
        ):
            await self.connect_session("s8")

        async def post(body):
            resp = await self.client.post(
                "/api/post_endpoint", json={"session_id": "s8", **body}
            )
            return resp.status, await resp.json()

        status, _ = await post(
            {"objective": "fc_definition", "functionDefinition": [{"name": "f"}]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(chat.messages, [])  # Storing makes no model call.

        for _ in range(2):
            status, body = await post(
                {"objective": "fr_generate", "functionName": "f", "functionArgs": {}}
            )
            self.assertEqual((status, body), (200, {"response": '{"ok": true}'}))
        self.assertIn('"name": "f"', chat.messages[0][1])
        self.assertEqual(len(chat.messages[0]), 4)
        self.assertEqual(len(chat.messages[1]), 2)

    async def test_fr_concurrent_calls_take_turns_on_the_chat(self):
        # Two toolCall messages can have simulator requests in flight at once.
        # The chat snapshots its history when a send starts, so overlapping
        # sends both carried the declarations and missed each other's turn.
        class SlowChat:
            def __init__(self):
                self.messages = []
                self.in_flight = 0
                self.max_in_flight = 0

            async def send_message(self, parts):
                self.in_flight += 1
                self.max_in_flight = max(self.max_in_flight, self.in_flight)
                self.messages.append([p.text for p in parts])
                await asyncio.sleep(0.3)
                self.in_flight -= 1
                return mock.Mock(text='{"ok": true}')

        chat = SlowChat()
        with mock.patch.object(
            main, "initialize_gemini_chat_session", return_value=chat
        ):
            await self.connect_session("s23")

        async def post(body):
            resp = await self.client.post(
                "/api/post_endpoint", json={"session_id": "s23", **body}
            )
            return resp.status

        await post(
            {"objective": "fc_definition", "functionDefinition": [{"name": "f"}]}
        )
        statuses = await asyncio.gather(
            *(
                post(
                    {"objective": "fr_generate", "functionName": n, "functionArgs": {}}
                )
                for n in ("f", "g")
            )
        )
        self.assertEqual(statuses, [200, 200])
        self.assertEqual(chat.max_in_flight, 1)
        self.assertEqual([len(m) for m in chat.messages], [4, 2])

        # A request still waiting when the session ends gets the 503.
        record = await main.SESSION_MANAGER.search_item("s23")
        assert record is not None
        body = {"objective": "fr_generate", "functionName": "h", "functionArgs": {}}
        first = asyncio.create_task(post(body))
        while chat.in_flight == 0:
            await asyncio.sleep(0.01)
        second = asyncio.create_task(post(body))
        await asyncio.sleep(0.1)
        await record.del_session()
        self.assertEqual(await asyncio.gather(first, second), [200, 503])
        self.assertEqual(len(chat.messages), 3)

    async def test_fr_call_that_never_returns_times_out_and_frees_the_chat(self):
        # The genai client sets no timeout, so a call that never returns held
        # fr_lock forever, and every later call queued behind it.
        class HungChat:
            def __init__(self):
                self.messages = []
                self.cancelled = 0
                self.answering = asyncio.Event()

            async def send_message(self, parts):
                self.messages.append([p.text for p in parts])
                try:
                    await self.answering.wait()
                except asyncio.CancelledError:
                    self.cancelled += 1
                    raise
                return mock.Mock(text='{"ok": true}')

        chat = HungChat()
        with mock.patch.object(
            main, "initialize_gemini_chat_session", return_value=chat
        ):
            await self.connect_session("s24")

        async def post(body):
            resp = await self.client.post(
                "/api/post_endpoint", json={"session_id": "s24", **body}
            )
            return resp.status, await resp.json()

        await post(
            {"objective": "fc_definition", "functionDefinition": [{"name": "f"}]}
        )
        body = {"objective": "fr_generate", "functionName": "f", "functionArgs": {}}
        with (
            mock.patch.object(main, "FR_SIMULATOR_TIMEOUT_S", 0.3),
            self.assertLogs("absl", level="WARNING") as logs,
        ):
            # The second one times out waiting for its turn.
            replies = await asyncio.wait_for(asyncio.gather(post(body), post(body)), 5)
        for status, reply in replies:
            self.assertEqual(status, 504)
            self.assertEqual(
                reply["error"],
                "Function response simulator didn't answer within 0.3 s",
            )
        self.assertNotIn("ERROR", "\n".join(logs.output))
        self.assertGreaterEqual(chat.cancelled, 1)
        self.assertEqual(chat.cancelled, len(chat.messages))

        # The chat is free again, and the declarations, never delivered, go
        # with the next call.
        chat.answering.set()
        chat.messages.clear()
        self.assertEqual(await post(body), (200, {"response": '{"ok": true}'}))
        self.assertEqual([len(m) for m in chat.messages], [4])

    async def test_fr_401_drops_rejected_token_and_retries_once(self):
        # Mirrors google-genai's async_get_token_from_credentials check on
        # ChainCredentials: it refreshes only when `expired` or `not token`.
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        tokens = [
            get_credentials.AccessToken("revoked-token", expiry, "gcloud"),
            get_credentials.AccessToken("fresh-token", expiry, "gcloud"),
        ]
        fetch = mock.Mock(side_effect=tokens)
        seen_tokens = []

        class AuthCheckingChat:
            async def send_message(self, parts):
                del parts
                if creds.expired or not creds.token:
                    creds.refresh(None)
                seen_tokens.append(creds.token)
                if creds.token == "revoked-token":
                    raise main.genai_errors.ClientError(
                        401,
                        {"error": {"code": 401, "status": "UNAUTHENTICATED"}},
                    )
                return mock.Mock(text='{"ok": true}')

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=AuthCheckingChat()
            )
        )
        # Prime both the shared cache and ChainCredentials with the revoked token.
        creds.refresh(None)
        self.assertEqual(creds.token, "revoked-token")

        await self.connect_session("s25")
        with self.assertLogs("absl", level="WARNING") as logs:
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s25",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"response": '{"ok": true}'})
        self.assertEqual(seen_tokens, ["revoked-token", "fresh-token"])
        self.assertEqual(fetch.call_count, 2)
        cached = get_credentials.cached_token()
        assert cached is not None
        self.assertEqual(cached.token, "fresh-token")
        output = "\n".join(logs.output)
        self.assertIn("dropped it from the cache", output)
        self.assertNotIn("revoked-token", output)
        self.assertNotIn("fresh-token", output)

    async def test_fr_401_does_not_retry_when_sources_return_same_token(self):
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        fetch = mock.Mock(
            side_effect=lambda: get_credentials.AccessToken(
                "same-bad-token", expiry, "gcloud"
            )
        )
        calls = 0

        class Always401Chat:
            async def send_message(self, parts):
                nonlocal calls
                del parts
                calls += 1
                if creds.expired or not creds.token:
                    creds.refresh(None)
                raise main.genai_errors.ClientError(
                    401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                )

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=Always401Chat()
            )
        )
        await self.connect_session("s26")
        with self.assertLogs("absl", level="WARNING") as logs:
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s26",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 502)
        self.assertEqual(
            (await resp.json())["error"],
            "Function response simulator failed (401 UNAUTHENTICATED)",
        )
        self.assertEqual(calls, 1)
        self.assertEqual(fetch.call_count, 2)
        self.assertIn("returned the rejected token again", "\n".join(logs.output))

    async def test_fr_401_surfaces_401_when_replacement_fetch_fails(self):
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        fetch = mock.Mock(
            side_effect=[
                get_credentials.AccessToken("revoked-token", expiry, "gcloud"),
                RuntimeError("gcloud down"),
            ]
        )

        class Always401Chat:
            async def send_message(self, parts):
                del parts
                if creds.expired or not creds.token:
                    creds.refresh(None)
                raise main.genai_errors.ClientError(
                    401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                )

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=Always401Chat()
            )
        )
        await self.connect_session("s27")
        with self.assertLogs("absl", level="WARNING"):
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s27",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 502)
        self.assertEqual(
            (await resp.json())["error"],
            "Function response simulator failed (401 UNAUTHENTICATED)",
        )
        self.assertIsNone(get_credentials._cached_token)

    async def test_fr_401_retries_with_token_replaced_while_in_flight(self):
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        old = get_credentials.AccessToken("old-token", expiry, "gcloud")
        newer = get_credentials.AccessToken("newer-token", expiry, "gcloud")
        fetch = mock.Mock(side_effect=AssertionError("should not refetch"))
        seen_tokens = []

        class RacingChat:
            async def send_message(self, parts):
                del parts
                if creds.expired or not creds.token:
                    creds.refresh(None)
                seen_tokens.append(creds.token)
                if creds.token == "old-token":
                    # Another caller (e.g. a Live API reconnect) refreshed the
                    # shared cache while this simulator request was in flight.
                    get_credentials._cached_token = newer
                    raise main.genai_errors.ClientError(
                        401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                    )
                return mock.Mock(text='{"ok": true}')

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", old))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=RacingChat()
            )
        )
        creds.refresh(None)
        await self.connect_session("s28")
        with self.assertLogs("absl", level="WARNING"):
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s28",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"response": '{"ok": true}'})
        self.assertEqual(seen_tokens, ["old-token", "newer-token"])
        self.assertEqual(fetch.call_count, 0)
        self.assertIs(get_credentials.cached_token(), newer)

    async def test_fr_401_retries_when_uncached_token_invalidated_in_flight(self):
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        tok_a = get_credentials.AccessToken("revoked-token", expiry, "gcloud")
        tok_b = get_credentials.AccessToken("fresh-token", expiry, "gcloud")
        fetch = mock.Mock(side_effect=[tok_a, tok_b])
        seen_tokens = []
        invalidated = []

        class RacingChat:
            async def send_message(self, parts):
                del parts
                if creds.expired or not creds.token:
                    creds.refresh(None)
                seen_tokens.append(creds.token)
                if creds.token == "revoked-token":
                    # Another caller (e.g. Live API 1008) invalidated the newly
                    # fetched token before the 401 returned.
                    invalidated.append(get_credentials.invalidate(tok_a))
                    raise main.genai_errors.ClientError(
                        401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                    )
                return mock.Mock(text='{"ok": true}')

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=RacingChat()
            )
        )
        await self.connect_session("s29")
        with self.assertLogs("absl", level="WARNING") as logs:
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s29",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"response": '{"ok": true}'})
        self.assertEqual(invalidated, [True])
        self.assertEqual(seen_tokens, ["revoked-token", "fresh-token"])
        self.assertEqual(fetch.call_count, 2)
        cached = get_credentials.cached_token()
        assert cached is not None
        self.assertEqual(cached.token, "fresh-token")
        output = "\n".join(logs.output)
        self.assertIn("invalidated in flight", output)
        self.assertNotIn("revoked-token", output)
        self.assertNotIn("fresh-token", output)

    async def test_fr_401_surfaces_401_when_in_flight_invalidation_refetch_fails(self):
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        tok_a = get_credentials.AccessToken("revoked-token", expiry, "gcloud")
        fetch = mock.Mock(side_effect=[tok_a, RuntimeError("gcloud down")])
        calls = 0

        class RacingChat:
            async def send_message(self, parts):
                nonlocal calls
                del parts
                calls += 1
                if creds.expired or not creds.token:
                    creds.refresh(None)
                get_credentials.invalidate(tok_a)
                raise main.genai_errors.ClientError(
                    401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                )

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=RacingChat()
            )
        )
        await self.connect_session("s30")
        with self.assertLogs("absl", level="WARNING") as logs:
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s30",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 502)
        self.assertEqual(
            (await resp.json())["error"],
            "Function response simulator failed (401 UNAUTHENTICATED)",
        )
        self.assertEqual(calls, 1)
        self.assertEqual(fetch.call_count, 2)
        self.assertIsNone(get_credentials._cached_token)
        self.assertIn("No other access token for simulator", "\n".join(logs.output))

    async def test_fr_401_retries_when_uncached_token_replaced_in_flight(self):
        creds = get_credentials.ChainCredentials()
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            hours=1
        )
        tok_a = get_credentials.AccessToken("revoked-token", expiry, "gcloud")
        tok_b = get_credentials.AccessToken("fresh-token", expiry, "gcloud")
        # Fetch 1: tok_a (used by RacingChat), Fetch 2: tok_b (concurrent WS),
        # Fetch 3: must not happen; if tok_b were spuriously invalidated, a 3rd
        # fetch returning tok_b would skip retry and fail with 502.
        fetch = mock.Mock(side_effect=[tok_a, tok_b, tok_b])
        seen_tokens = []

        class RacingChat:
            async def send_message(self, parts):
                del parts
                if creds.expired or not creds.token:
                    await asyncio.to_thread(creds.refresh, None)
                sent = creds.token
                seen_tokens.append(sent)
                if sent == "revoked-token":
                    # Concurrent caller invalidated tok_a and cached tok_b.
                    get_credentials.invalidate(tok_a)
                    get_credentials.get_access_token()
                    raise main.genai_errors.ClientError(
                        401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                    )
                return mock.Mock(text='{"ok": true}')

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(mock.patch.object(get_credentials, "_cached_token", None))
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=RacingChat()
            )
        )
        await self.connect_session("s30b")
        with self.assertLogs("absl", level="WARNING") as logs:
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s30b",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"response": '{"ok": true}'})
        self.assertEqual(seen_tokens, ["revoked-token", "fresh-token"])
        self.assertEqual(fetch.call_count, 2)
        self.assertIs(get_credentials.cached_token(), tok_b)
        output = "\n".join(logs.output)
        self.assertIn("retrying with the newer cached token", output)
        self.assertNotIn("revoked-token", output)
        self.assertNotIn("fresh-token", output)

    async def test_fr_401_does_not_retry_stale_replaced_token_if_it_was_used(self):
        creds = get_credentials.ChainCredentials()
        now = datetime.datetime.now(datetime.timezone.utc)
        near_expiry = get_credentials.AccessToken(
            "near-expiry-token", now + datetime.timedelta(seconds=30), "gcloud"
        )
        revoked_new = get_credentials.AccessToken(
            "revoked-new-token", now + datetime.timedelta(hours=1), "gcloud"
        )
        fresh = get_credentials.AccessToken(
            "fresh-token", now + datetime.timedelta(hours=1), "gcloud"
        )
        # Before send_message(), cache holds near_expiry (within _EXPIRY_MARGIN),
        # so ChainCredentials refreshes and sends revoked_new. On 401,
        # _send_simulator_message must recognize revoked_new as the rejected token
        # (not treat it as a newer replacement for near_expiry).
        fetch = mock.Mock(side_effect=[revoked_new, fresh])
        seen_tokens = []

        class RefreshingChat:
            async def send_message(self, parts):
                del parts
                if creds.expired or not creds.token:
                    await asyncio.to_thread(creds.refresh, None)
                sent = creds.token
                seen_tokens.append(sent)
                if sent == "revoked-new-token":
                    raise main.genai_errors.ClientError(
                        401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}
                    )
                return mock.Mock(text='{"ok": true}')

        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("gcloud", fetch),))
        )
        self.enterContext(
            mock.patch.object(get_credentials, "_cached_token", near_expiry)
        )
        self.enterContext(
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=RefreshingChat()
            )
        )
        await self.connect_session("s30c")
        with self.assertLogs("absl", level="WARNING") as logs:
            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s30c",
                    "objective": "fr_generate",
                    "functionName": "f",
                    "functionArgs": {},
                },
            )
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"response": '{"ok": true}'})
        self.assertEqual(seen_tokens, ["revoked-new-token", "fresh-token"])
        self.assertEqual(fetch.call_count, 2)
        self.assertIs(get_credentials.cached_token(), fresh)
        output = "\n".join(logs.output)
        self.assertIn("dropped it from the cache", output)
        self.assertNotIn("retrying with the newer cached token", output)
        self.assertNotIn("revoked-new-token", output)
        self.assertNotIn("fresh-token", output)

    async def test_fr_definitions_stored_without_simulator(self):
        await self.connect_session("s9")
        resp = await self.client.post(
            "/api/post_endpoint",
            json={
                "session_id": "s9",
                "objective": "fc_definition",
                "functionDefinition": [],
            },
        )
        self.assertEqual(resp.status, 200)

    async def test_shutdown_closes_sessions_with_going_away(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s10")
                ws = await self.client.ws_connect("/ws?session_id=s10")
                await ws.send_str("ping")
                await asyncio.wait_for(ws.receive(), 5)

                await main.close_sessions_on_shutdown(self.client.app)
                msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1001)
        self.assertEqual(msg.extra, "Server restarting")

    async def test_shutdown_removes_pending_sessions_and_cancels_expiry_tasks(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s10-active")
                ws = await self.client.ws_connect("/ws?session_id=s10-active")
                await ws.send_str("ping")
                await asyncio.wait_for(ws.receive(), 5)

                await self.connect_session("s10-pending")
                pending = await main.SESSION_MANAGER.search_item("s10-pending")
                assert pending is not None and pending.expiry_task is not None
                pending.fr_session = mock.Mock()
                self.assertFalse(pending.expiry_task.done())

                await main.close_sessions_on_shutdown(self.client.app)

                self.assertIsNone(await main.SESSION_MANAGER.search_item("s10-pending"))
                self.assertTrue(pending.expiry_task.done())
                self.assertTrue(pending.expiry_task.cancelled())
                self.assertIsNone(pending.fr_session)

                msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1001)
        self.assertEqual(msg.extra, "Server restarting")

    async def test_shutdown_closes_session_claimed_during_pending_cleanup(self):
        await self.connect_session("s10-race")
        pending = await main.SESSION_MANAGER.search_item("s10-race")
        assert pending is not None and pending.expiry_task is not None
        fake_ws = mock.AsyncMock()
        fake_handler = mock.Mock(
            client_websocket=fake_ws, end_websocket=mock.AsyncMock()
        )
        orig_delete = main.SESSION_MANAGER.delete_if_pending

        async def claim_before_delete(session_id, record, **kwargs):
            claimed = await main.SESSION_MANAGER.claim_websocket(
                session_id, record, fake_handler
            )
            self.assertTrue(claimed)
            return await orig_delete(session_id, record, **kwargs)

        with mock.patch.object(
            main.SESSION_MANAGER, "delete_if_pending", side_effect=claim_before_delete
        ):
            await main.close_sessions_on_shutdown(self.client.app)

        fake_ws.close.assert_awaited_once_with(code=1001, reason="Server restarting")
        self.assertIs(await main.SESSION_MANAGER.search_item("s10-race"), pending)
        await main.SESSION_MANAGER.delete_item("s10-race", pending)

    async def test_session_without_websocket_expires(self):
        with mock.patch.object(main, "PENDING_SESSION_TTL_S", 0.3):
            await self.connect_session("s5")
            record = await main.SESSION_MANAGER.search_item("s5")
        assert record is not None and record.expiry_task is not None
        await asyncio.wait_for(record.expiry_task, 5)
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s5"))

    async def test_connected_session_does_not_expire(self):
        async with FakeUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port),
                mock.patch.object(main, "PENDING_SESSION_TTL_S", 0.3),
            ):
                await self.connect_session("s6")
                record = await main.SESSION_MANAGER.search_item("s6")
                ws = await self.client.ws_connect("/ws?session_id=s6")
                # Claiming the WebSocket cancels the pending expiry timer.
                assert record is not None and record.expiry_task is not None
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(record.expiry_task, 5)
                self.assertIs(await main.SESSION_MANAGER.search_item("s6"), record)
                await ws.send_str("ping")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(json.loads(msg.data), {"echo": "ping"})
                await ws.close()

    async def test_expiry_timer_cannot_remove_claimed_session_under_lock_contention(
        self,
    ):
        # Even if the expiry timer wakes right as claim_websocket() runs and
        # queues behind it on SESSION_MANAGER._lock, delete_if_pending()
        # re-checks websocket_handler under the lock and leaves the live WS.
        async with FakeUpstream() as upstream:
            sleep_started = asyncio.Event()
            release_sleep = asyncio.Event()
            orig_sleep = asyncio.sleep

            async def controlled_sleep(delay, *args, **kwargs):
                if delay == main.PENDING_SESSION_TTL_S:
                    sleep_started.set()
                    await release_sleep.wait()
                    return
                return await orig_sleep(delay, *args, **kwargs)

            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port, ws_heartbeat_s=0),
                mock.patch.object(main.asyncio, "sleep", side_effect=controlled_sleep),
            ):
                await self.connect_session("s6-race")
                await asyncio.wait_for(sleep_started.wait(), 5)
                record = await main.SESSION_MANAGER.search_item("s6-race")
                assert record is not None

                orig_claim = main.SESSION_MANAGER.claim_websocket
                claim_waiting = asyncio.Event()
                release_hold = asyncio.Event()

                async def hold_on_claim(*args, **kwargs):
                    async def holder():
                        async with main.SESSION_MANAGER._lock:
                            claim_waiting.set()
                            await release_hold.wait()

                    asyncio.create_task(holder())
                    await claim_waiting.wait()
                    return await orig_claim(*args, **kwargs)

                with mock.patch.object(
                    main.SESSION_MANAGER, "claim_websocket", side_effect=hold_on_claim
                ):
                    ws_task = asyncio.create_task(
                        self.client.ws_connect("/ws?session_id=s6-race")
                    )
                    await asyncio.wait_for(claim_waiting.wait(), 5)
                    # Let claim_websocket() queue first on _lock, then wake the
                    # expiry timer so it passes its unlocked check and queues
                    # behind claim_websocket() on _lock.
                    await orig_sleep(0)
                    release_sleep.set()
                    await orig_sleep(0)
                    await orig_sleep(0)
                    release_hold.set()
                    ws = await asyncio.wait_for(ws_task, 5)

                self.assertIs(await main.SESSION_MANAGER.search_item("s6-race"), record)
                await ws.send_str("ping")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(json.loads(msg.data), {"echo": "ping"})
                await ws.close()
                await self.wait_for_session_end("s6-race")

    async def test_control_retry_cannot_replace_a_connected_session(self):
        # A slow connect awaiting simulator init while a retry connects and
        # opens /ws must get 409 instead of replacing the live record.
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                init_started, release = threading.Event(), threading.Event()
                calls = 0

                def slow_first_init():
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        init_started.set()
                        release.wait(5)
                    raise RuntimeError("no creds")

                try:
                    with mock.patch.object(
                        main,
                        "initialize_gemini_chat_session",
                        side_effect=slow_first_init,
                    ):
                        slow = asyncio.create_task(self.connect_session("s23"))
                        self.assertTrue(await asyncio.to_thread(init_started.wait, 5))
                        status, body = await self.connect_session("s23")
                        self.assertEqual(status, 200, body)
                        first = await main.SESSION_MANAGER.search_item("s23")
                        ws = await self.client.ws_connect("/ws?session_id=s23")
                        await ws.send_str("ping")
                        await asyncio.wait_for(ws.receive(), 5)
                        # A direct retry on an already-connected session also
                        # gets 409 immediately without running simulator init.
                        status_now, body_now = await self.connect_session("s23")
                        self.assertEqual(status_now, 409, body_now)
                        self.assertEqual(calls, 2)
                        release.set()
                        status, body = await slow
                finally:
                    release.set()
                self.assertEqual(status, 409, body)
                self.assertIs(await main.SESSION_MANAGER.search_item("s23"), first)
                with self.assertRaises(aiohttp.WSServerHandshakeError) as cm:
                    await self.client.ws_connect("/ws?session_id=s23")
                self.assertEqual(cm.exception.status, 409)
                await ws.close()
                await self.wait_for_session_end("s23")

    async def test_control_retry_keeps_a_pending_session(self):
        with mock.patch.object(main, "PENDING_SESSION_TTL_S", 0.5):
            await self.connect_session("s24")
        first = await main.SESSION_MANAGER.search_item("s24")
        assert first is not None and first.expiry_task is not None
        first_expiry = first.expiry_task
        resp = await self.client.post(
            "/api/post_endpoint",
            json={
                "session_id": "s24",
                "objective": "fc_definition",
                "functionDefinition": [{"name": "f"}],
            },
        )
        self.assertEqual(resp.status, 200)
        status, body = await self.connect_session("s24")
        self.assertEqual(status, 200, body)
        second = await main.SESSION_MANAGER.search_item("s24")
        self.assertIs(second, first)
        self.assertIn('"name": "f"', first.fc_definitions)
        self.assertIsNot(first.expiry_task, first_expiry)
        await asyncio.sleep(0)
        self.assertTrue(first_expiry.cancelled())
        # The first record's expiry time passes; the refreshed record stays.
        await asyncio.sleep(0.8)
        self.assertIs(await main.SESSION_MANAGER.search_item("s24"), first)

    async def test_control_retry_updates_pending_ws_host_and_skips_log_when_running(
        self,
    ):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                status, body = await self.connect_session("s24-host")
                self.assertEqual(status, 200, body)
                record = await main.SESSION_MANAGER.search_item("s24-host")
                assert record is not None
                self.assertEqual(record.ws_host, "autopush-common")

                # Re-connecting the pending session with a different endpoint
                # keeps the pending record and updates its ws_host.
                resp = await self.client.post(
                    "/api/control",
                    json={
                        "command": "connect",
                        "session_id": "s24-host",
                        "endpoint": "aiplatform.googleapis.com",
                        "location": "us-central1",
                    },
                )
                self.assertEqual(resp.status, 200)
                self.assertIs(
                    await main.SESSION_MANAGER.search_item("s24-host"), record
                )
                self.assertEqual(
                    record.ws_host, "us-central1-aiplatform.googleapis.com"
                )

                # Switch back to autopush-common so /ws opens against FakeUpstream.
                status, body = await self.connect_session("s24-host")
                self.assertEqual(status, 200, body)
                self.assertEqual(record.ws_host, "autopush-common")
                ws = await self.client.ws_connect("/ws?session_id=s24-host")
                await ws.send_str("ping")
                await asyncio.wait_for(ws.receive(), 5)

                # Once connected, a repeat connect returns 409 without logging
                # a misleading "Websocket host ... is set to" line.
                with self.assertLogs("absl", level="INFO") as logs:
                    main.logging.info("sentinel")
                    resp409 = await self.client.post(
                        "/api/control",
                        json={
                            "command": "connect",
                            "session_id": "s24-host",
                            "endpoint": "aiplatform.googleapis.com",
                            "location": "us-central1",
                        },
                    )
                self.assertEqual(resp409.status, 409)
                self.assertFalse(
                    any(
                        "Websocket host for session s24-host" in m for m in logs.output
                    ),
                    logs.output,
                )
                self.assertEqual(record.ws_host, "autopush-common")
                await ws.close()
                await self.wait_for_session_end("s24-host")

    async def test_slow_connect_finishing_after_retry_keeps_fc_definitions(self):
        # If attempt 1 is stuck in simulator init, attempt 2 succeeds and the
        # browser posts fc_definition before attempt 1 finishes; attempt 1 must
        # keep attempt 2's record instead of replacing it with an empty one.
        class FakeChat:
            def __init__(self):
                self.messages = []

            async def send_message(self, parts):
                self.messages.append([p.text for p in parts])
                return mock.Mock(text='{"ok": true}')

        stale_chat, winner_chat = FakeChat(), FakeChat()
        first_started, release = threading.Event(), threading.Event()
        calls = 0

        def init_chat():
            nonlocal calls
            calls += 1
            if calls == 1:
                first_started.set()
                release.wait(5)
                return stale_chat
            return winner_chat

        with flagsaver.flagsaver(max_sessions=1):
            try:
                with mock.patch.object(
                    main, "initialize_gemini_chat_session", side_effect=init_chat
                ):
                    slow_first = asyncio.create_task(self.connect_session("s24-race"))
                    self.assertTrue(await asyncio.to_thread(first_started.wait, 5))
                    status2, body2 = await self.connect_session("s24-race")
                    self.assertEqual(status2, 200, body2)
                    winner = await main.SESSION_MANAGER.search_item("s24-race")
                    assert winner is not None
                    self.assertIs(winner.fr_session, winner_chat)

                    resp = await self.client.post(
                        "/api/post_endpoint",
                        json={
                            "session_id": "s24-race",
                            "objective": "fc_definition",
                            "functionDefinition": [{"name": "lookup"}],
                        },
                    )
                    self.assertEqual(resp.status, 200)
                    release.set()
                    status1, body1 = await slow_first
            finally:
                release.set()

            self.assertEqual(status1, 200, body1)
            current = await main.SESSION_MANAGER.search_item("s24-race")
            self.assertIs(current, winner)
            self.assertIs(winner.fr_session, winner_chat)
            self.assertIn('"name": "lookup"', winner.fc_definitions)
            self.assertEqual(len(await main.SESSION_MANAGER.all_items()), 1)

            resp = await self.client.post(
                "/api/post_endpoint",
                json={
                    "session_id": "s24-race",
                    "objective": "fr_generate",
                    "functionName": "lookup",
                    "functionArgs": {},
                },
            )
            self.assertEqual(resp.status, 200)
            self.assertEqual(await resp.json(), {"response": '{"ok": true}'})
            self.assertEqual(len(winner_chat.messages), 1)
            self.assertIn('"name": "lookup"', winner_chat.messages[0][1])
            self.assertEqual(stale_chat.messages, [])

    async def test_control_enforces_max_sessions(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port, max_sessions=1):
                status, body = await self.connect_session("s26")
                self.assertEqual(status, 200, body)
                # A retry for the pending session still fits.
                status, body = await self.connect_session("s26")
                self.assertEqual(status, 200, body)

                ws = await self.client.ws_connect("/ws?session_id=s26")
                await ws.send_str("ping")
                await asyncio.wait_for(ws.receive(), 5)
                resp = await self.client.post(
                    "/api/control",
                    json={
                        "command": "connect",
                        "session_id": "s27",
                        "endpoint": "autopush-common",
                        "location": "us-central1",
                    },
                )
                self.assertEqual(resp.status, 503)
                self.assertEqual(resp.headers["Retry-After"], "1")
                self.assertIn("session limit (1)", (await resp.json())["error"])
                self.assertIsNone(await main.SESSION_MANAGER.search_item("s27"))

                # The slot frees when the session ends.
                await ws.close()
                await self.wait_for_session_end("s26")
                status, body = await self.connect_session("s27")
                self.assertEqual(status, 200, body)

    async def test_rejected_connect_skips_simulator_init(self):
        # Connects at the limit each built a genai chat in a pool thread
        # before getting 503.
        with flagsaver.flagsaver(max_sessions=1):
            status, body = await self.connect_session("s28")
            self.assertEqual(status, 200, body)
            init = mock.Mock(side_effect=RuntimeError("no creds"))
            with mock.patch.object(main, "initialize_gemini_chat_session", init):
                results = await asyncio.gather(
                    *(self.connect_session(f"s29-{i}") for i in range(5))
                )
                self.assertEqual([status for status, _ in results], [503] * 5)
                self.assertIn("session limit (1)", results[0][1]["error"])
                init.assert_not_called()
                # A retry for the pending session still fits and reuses the
                # pending record without re-running simulator init.
                status, body = await self.connect_session("s28")
                self.assertEqual(status, 200, body)
                init.assert_not_called()

    async def test_control_reports_idle_timeout(self):
        # The browser enforces it, so it must learn the server's value.
        for idle_timeout_s in (0, 120):
            with flagsaver.flagsaver(idle_timeout_s=idle_timeout_s):
                status, body = await self.connect_session(f"s-idle-{idle_timeout_s}")
                self.assertEqual(status, 200, body)
                self.assertEqual(body["idle_timeout_s"], idle_timeout_s)

    async def disconnect_session(self, session_id):
        resp = await self.client.post(
            "/api/control", json={"command": "disconnect", "session_id": session_id}
        )
        return resp.status, await resp.json()

    async def test_disconnect_command_frees_a_pending_slot(self):
        # A browser that gave up before opening its WebSocket left the record
        # holding the only slot for PENDING_SESSION_TTL_S.
        with flagsaver.flagsaver(max_sessions=1):
            status, body = await self.connect_session("s40")
            self.assertEqual(status, 200, body)
            pending = await main.SESSION_MANAGER.search_item("s40")
            status, body = await self.connect_session("s41")
            self.assertEqual(status, 503, body)

            status, body = await self.disconnect_session("s40")
            self.assertEqual((status, body), (200, {"removed": True}))
            self.assertIsNone(await main.SESSION_MANAGER.search_item("s40"))
            assert pending is not None and pending.expiry_task is not None
            await asyncio.sleep(0)
            self.assertTrue(pending.expiry_task.cancelled())
            status, body = await self.connect_session("s41")
            self.assertEqual(status, 200, body)

            # Repeats and unknown IDs are harmless.
            status, body = await self.disconnect_session("s40")
            self.assertEqual((status, body), (200, {"removed": False}))
            status, body = await self.disconnect_session("nope")
            self.assertEqual((status, body), (200, {"removed": False}))

    async def test_disconnect_command_leaves_connected_session(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s42")
                ws = await self.client.ws_connect("/ws?session_id=s42")
                await ws.send_str("ping")
                await asyncio.wait_for(ws.receive(), 5)
                status, body = await self.disconnect_session("s42")
                self.assertEqual((status, body), (200, {"removed": False}))
                await ws.send_str("still here")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(json.loads(msg.data), {"echo": "still here"})
                await ws.close()
                await self.wait_for_session_end("s42")

    async def test_disconnect_during_connect_drops_the_late_record(self):
        # The disconnect found no record while the connect was still building
        # the simulator chat; the connect then added one, which held its slot
        # for PENDING_SESSION_TTL_S.
        with flagsaver.flagsaver(max_sessions=1):
            init_started, release = threading.Event(), threading.Event()

            def slow_init():
                init_started.set()
                release.wait(5)
                raise RuntimeError("no creds")

            try:
                with mock.patch.object(
                    main, "initialize_gemini_chat_session", side_effect=slow_init
                ):
                    connect = asyncio.create_task(self.connect_session("s43"))
                    self.assertTrue(await asyncio.to_thread(init_started.wait, 5))
                    status, body = await self.disconnect_session("s43")
                    self.assertEqual((status, body), (200, {"removed": False}))
                    release.set()
                    status, body = await connect
            finally:
                release.set()
            self.assertEqual(status, 409, body)
            self.assertIn("gave up", body["error"])
            self.assertIsNone(await main.SESSION_MANAGER.search_item("s43"))
            status, body = await self.connect_session("s44")
            self.assertEqual(status, 200, body)

    async def test_connect_retry_after_disconnect_is_refused(self):
        # The frontend's connect retries can still be running after it sent
        # disconnect; they get 409, which it doesn't retry.
        init = mock.Mock(side_effect=RuntimeError("no creds"))
        with mock.patch.object(main, "initialize_gemini_chat_session", init):
            status, body = await self.connect_session("s45")
            self.assertEqual(status, 200, body)
            status, body = await self.disconnect_session("s45")
            self.assertEqual((status, body), (200, {"removed": True}))
            status, body = await self.connect_session("s45")
            self.assertEqual(status, 409, body)
            self.assertIsNone(await main.SESSION_MANAGER.search_item("s45"))
            # Refused before the simulator chat is built.
            init.assert_called_once()

    async def test_slot_frees_when_browser_closes(self):
        # The upstream never acknowledges the close, so the old session spends
        # UPSTREAM_CLOSE_TIMEOUT_S closing; a resume's new session ID must not
        # wait for that at the limit.
        async with UnresponsiveUpstream() as upstream:
            with (
                flagsaver.flagsaver(
                    common_bag_ws_port=upstream.port, max_sessions=1, ws_heartbeat_s=0
                ),
                mock.patch.object(websocket_handler, "UPSTREAM_CLOSE_TIMEOUT_S", 1.5),
            ):
                status, body = await self.connect_session("s28")
                self.assertEqual(status, 200, body)
                ws = await self.client.ws_connect("/ws?session_id=s28")
                record = await main.SESSION_MANAGER.search_item("s28")
                assert record is not None and record.websocket_handler is not None
                handler = record.websocket_handler
                async with asyncio.timeout(5):
                    while handler.server_websocket is None:
                        await asyncio.sleep(0.02)

                await ws.close()
                async with asyncio.timeout(1):
                    status, body = await self.connect_session("s29")
                self.assertEqual(status, 200, body)
                # The old session still closes upstream and ends its record.
                self.assertIsNotNone(handler.server_websocket)
                async with asyncio.timeout(5):
                    while handler.connection_handler is not None:
                        await asyncio.sleep(0.02)
                self.assertEqual(handler.close_code, 1006)

    async def test_slot_frees_when_browser_leaves_during_handshake(self):
        # Nothing read the browser socket until the proxy started, so its
        # Close went unanswered and the slot stayed held until the upstream
        # handshake timed out.
        async def silent(reader, writer):
            await reader.read()

        server = await asyncio.start_server(silent, "127.0.0.1", 0)
        self.addCleanup(server.close)
        port = server.sockets[0].getsockname()[1]
        with flagsaver.flagsaver(
            common_bag_ws_port=port, max_sessions=1, ws_heartbeat_s=0
        ):
            await self.connect_session("s43")
            ws = await self.client.ws_connect("/ws?session_id=s43")
            await asyncio.sleep(0.3)
            async with asyncio.timeout(2):
                await ws.close()
                await self.wait_for_session_end("s43")
                status, body = await self.connect_session("s44")
            self.assertEqual(status, 200, body)

    async def test_slot_frees_when_browser_leaves_during_token_fetch(self):
        fetching, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def slow_token():
            fetching.set()
            release.wait(10)
            raise RuntimeError("No access token")

        with (
            mock.patch.object(main.get_credentials, "get_access_token", slow_token),
            flagsaver.flagsaver(max_sessions=1, ws_heartbeat_s=0),
        ):
            await self.connect_session("s45", endpoint="aiplatform.googleapis.com")
            ws = await self.client.ws_connect("/ws?session_id=s45")
            await asyncio.to_thread(fetching.wait, 5)
            async with asyncio.timeout(2):
                await ws.close()
                await self.wait_for_session_end("s45")
                status, body = await self.connect_session("s46")
            self.assertEqual(status, 200, body)

    async def test_stuck_token_fetch_fails_sessions_within_the_deadline(self):
        # It had no deadline, so one stuck source (an ADC refresh waits 120 s
        # by default) held this session and, behind the lock, every new one.
        fetching, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def stuck():
            fetching.set()
            release.wait(10)
            raise RuntimeError("stuck source")

        self.enterContext(
            mock.patch.object(main.get_credentials, "_SOURCES", (("stuck", stuck),))
        )
        self.enterContext(
            mock.patch.object(main.get_credentials, "_cached_token", None)
        )
        self.enterContext(
            mock.patch.object(main.get_credentials, "FETCH_TIMEOUT_S", 0.5)
        )
        with (
            flagsaver.flagsaver(ws_heartbeat_s=0),
            self.assertLogs("absl", level="WARNING") as logs,
        ):
            await self.connect_session("s48", endpoint="aiplatform.googleapis.com")
            await self.connect_session("s49", endpoint="aiplatform.googleapis.com")
            ws = await self.client.ws_connect("/ws?session_id=s48")
            await asyncio.to_thread(fetching.wait, 5)
            ws2 = await self.client.ws_connect("/ws?session_id=s49")
            async with asyncio.timeout(4):
                first = await ws.receive()
                second = await ws2.receive()
        for msg in (first, second):
            self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
            self.assertEqual(msg.data, 1011)
            self.assertEqual(msg.extra, websocket_handler.CREDENTIALS_ERROR_REASON)
        timeouts = [line for line in logs.output if "Timed out after 0.5 s" in line]
        self.assertEqual(len(timeouts), 2, logs.output)

    async def test_control_answers_while_token_fetches_wait(self):
        # Token fetches ran in the default executor, which /api/control's
        # simulator setup also uses: a stuck fetch and its waiters held every
        # worker, so new connects waited up to FETCH_TIMEOUT_S for a thread.
        loop = asyncio.get_running_loop()
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        loop.set_default_executor(executor)
        fetching, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def stuck():
            fetching.set()
            release.wait(10)
            raise RuntimeError("stuck source")

        self.enterContext(
            mock.patch.object(main.get_credentials, "_SOURCES", (("stuck", stuck),))
        )
        self.enterContext(
            mock.patch.object(main.get_credentials, "_cached_token", None)
        )
        self.enterContext(mock.patch.object(main.get_credentials, "FETCH_TIMEOUT_S", 3))
        with flagsaver.flagsaver(ws_heartbeat_s=0):
            sockets = []
            for i in range(3):
                await self.connect_session(
                    f"s9{i}", endpoint="aiplatform.googleapis.com"
                )
            for i in range(3):
                sockets.append(await self.client.ws_connect(f"/ws?session_id=s9{i}"))
                if i == 0:
                    await asyncio.to_thread(fetching.wait, 5)
            await asyncio.sleep(0.3)  # The waiters reach their threads.
            started = loop.time()
            status, body = await self.connect_session("s93")
            elapsed = loop.time() - started
            release.set()
            for ws in sockets:
                await ws.close()
        self.assertEqual(status, 200, body)
        self.assertLess(elapsed, 1.5)

    async def test_messages_sent_while_connecting_are_forwarded(self):
        # The browser sends its setup as soon as the socket opens, while the
        # proxy is still connecting upstream.
        open_upstream = websocket_handler.WebsocketHandler._open_upstream

        async def slow_open(handler):
            await asyncio.sleep(0.3)
            return await open_upstream(handler)

        async with FakeUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port),
                mock.patch.object(
                    websocket_handler.WebsocketHandler, "_open_upstream", slow_open
                ),
            ):
                await self.connect_session("s47")
                ws = await self.client.ws_connect("/ws?session_id=s47")
                await ws.send_str("setup")
                await ws.send_bytes(b"second")
                first = await asyncio.wait_for(ws.receive(), 5)
                second = await asyncio.wait_for(ws.receive(), 5)
                await ws.close()
                await self.wait_for_session_end("s47")
        self.assertEqual(json.loads(first.data), {"echo": "setup"})
        self.assertEqual(json.loads(second.data), {"echo_bytes": "second"})
        self.assertEqual(upstream.received, ["setup", b"second"])

    async def test_ws_client_binary_frames_stay_binary_upstream(self):
        # Only upstream (s->c) UTF-8 binary frames decode to text for the
        # browser; browser binary frames must reach upstream as binary even if
        # their payload happens to be valid UTF-8.
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s48_bin")
                ws = await self.client.ws_connect("/ws?session_id=s48_bin")
                await ws.send_bytes(b"\x00\x01\x02audio?")
                await ws.send_bytes(b"\xff\xfe")
                await ws.send_str("hello")
                replies = [await asyncio.wait_for(ws.receive(), 5) for _ in range(3)]
                await ws.close()
                await self.wait_for_session_end("s48_bin")
        self.assertEqual(
            upstream.received, [b"\x00\x01\x02audio?", b"\xff\xfe", "hello"]
        )
        self.assertEqual([type(m) for m in upstream.received], [bytes, bytes, str])
        self.assertEqual([r.type for r in replies], [aiohttp.WSMsgType.TEXT] * 3)
        self.assertEqual(
            [json.loads(r.data) for r in replies],
            [
                {"echo_bytes": "\x00\x01\x02audio?"},
                {"echo_bytes": "\xff\xfe"},
                {"echo": "hello"},
            ],
        )

    async def test_too_much_data_while_connecting_closes_the_browser(self):
        # Nothing pushes back on the browser until the relay starts, so the
        # proxy held all of it (336 MB in a second, measured).
        open_upstream = websocket_handler.WebsocketHandler._open_upstream
        opened = asyncio.Event()

        async def slow_open(handler):
            await opened.wait()
            return await open_upstream(handler)

        async with FakeUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port),
                mock.patch.object(
                    websocket_handler.WebsocketHandler, "_open_upstream", slow_open
                ),
                # 1000 bytes of payload in two messages.
                mock.patch.object(
                    websocket_handler,
                    "MAX_PENDING_CLIENT_BYTES",
                    1000 + 2 * websocket_handler.PENDING_MESSAGE_OVERHEAD_BYTES,
                ),
            ):
                await self.connect_session("s49")
                ws = await self.client.ws_connect("/ws?session_id=s49")
                await ws.send_str("x" * 600)
                await ws.send_bytes(b"y" * 400)  # Exactly the limit.
                await asyncio.sleep(0.3)
                opened.set()
                echo = await asyncio.wait_for(ws.receive(), 5)
                await ws.close()
                await self.wait_for_session_end("s49")
                opened.clear()

                await self.connect_session("s50")
                ws = await self.client.ws_connect("/ws?session_id=s50")
                await ws.send_str("x" * 600)
                await ws.send_bytes(b"y" * 401)
                msg = await asyncio.wait_for(ws.receive(), 5)
                await self.wait_for_session_end("s50")
        self.assertEqual(json.loads(echo.data), {"echo": "x" * 600})
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1009)
        self.assertEqual(
            msg.extra, "Too much data sent before the Live API connection opened"
        )
        # The second session never reached upstream.
        self.assertEqual(upstream.received, ["x" * 600, b"y" * 400])
        self.assertEqual(len(upstream.close_codes), 1)

    async def test_many_small_messages_while_connecting_close_the_browser(self):
        # Each held message costs memory beyond its payload (~60 bytes for a
        # 2-byte frame), so 1-byte frames counted by payload alone could hold
        # ~30x the cap (1.7 GB per session, measured in the cycle 132 audit).
        open_upstream = websocket_handler.WebsocketHandler._open_upstream
        opened = asyncio.Event()

        async def slow_open(handler):
            await opened.wait()
            return await open_upstream(handler)

        async with FakeUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port),
                mock.patch.object(
                    websocket_handler.WebsocketHandler, "_open_upstream", slow_open
                ),
                mock.patch.object(
                    websocket_handler,
                    "MAX_PENDING_CLIENT_BYTES",
                    10 * websocket_handler.PENDING_MESSAGE_OVERHEAD_BYTES,
                ),
            ):
                await self.connect_session("s95")
                ws = await self.client.ws_connect("/ws?session_id=s95")
                for _ in range(20):  # 20 bytes of payload in all.
                    await ws.send_str("x")
                try:
                    msg = await asyncio.wait_for(ws.receive(), 5)
                finally:
                    opened.set()
                await self.wait_for_session_end("s95")
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1009)
        self.assertEqual(upstream.received, [])

    async def test_multibyte_utf8_messages_while_connecting_count_utf8_bytes(self):
        # Counting len(str) (code points) let 4-byte UTF-8 characters hold up
        # to 4x MAX_PENDING_CLIENT_BYTES in memory before upstream opened.
        open_upstream = websocket_handler.WebsocketHandler._open_upstream
        opened = asyncio.Event()

        async def slow_open(handler):
            await opened.wait()
            return await open_upstream(handler)

        async with FakeUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port),
                mock.patch.object(
                    websocket_handler.WebsocketHandler, "_open_upstream", slow_open
                ),
                # 1000 UTF-8 bytes of payload in one message.
                mock.patch.object(
                    websocket_handler,
                    "MAX_PENDING_CLIENT_BYTES",
                    1000 + websocket_handler.PENDING_MESSAGE_OVERHEAD_BYTES,
                ),
            ):
                # 250 4-byte emoji = exactly 1000 UTF-8 bytes -> accepted.
                await self.connect_session("s96")
                ws = await self.client.ws_connect("/ws?session_id=s96")
                await ws.send_str("\U0001f600" * 250)
                await asyncio.sleep(0.2)
                opened.set()
                echo = await asyncio.wait_for(ws.receive(), 5)
                await ws.close()
                await self.wait_for_session_end("s96")
                opened.clear()

                # 251 4-byte emoji = 1004 UTF-8 bytes (only 251 chars) -> 1009.
                await self.connect_session("s97")
                ws = await self.client.ws_connect("/ws?session_id=s97")
                await ws.send_str("\U0001f600" * 251)
                try:
                    msg = await asyncio.wait_for(ws.receive(), 5)
                finally:
                    opened.set()
                await self.wait_for_session_end("s97")
        self.assertEqual(json.loads(echo.data), {"echo": "\U0001f600" * 250})
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1009)
        self.assertEqual(upstream.received, ["\U0001f600" * 250])

    async def test_upstream_handshake_times_out(self):
        async def silent(reader, writer):
            await reader.read()

        server = await asyncio.start_server(silent, "127.0.0.1", 0)
        self.addCleanup(server.close)
        port = server.sockets[0].getsockname()[1]
        with (
            flagsaver.flagsaver(common_bag_ws_port=port),
            mock.patch.object(websocket_handler, "UPSTREAM_OPEN_TIMEOUT_S", 0.3),
        ):
            await self.connect_session("s48")
            ws = await self.client.ws_connect("/ws?session_id=s48")
            msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1011)
        self.assertIn("timed out during opening handshake", str(msg.extra))

    async def test_concurrent_websockets_for_one_session(self):
        # The /ws handler attached itself to the record only after
        # ws.prepare, so two requests could both pass the 409 check.
        prepare = web.WebSocketResponse.prepare

        async def slow_prepare(ws, request):
            await asyncio.sleep(0.2)
            return await prepare(ws, request)

        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s25")
                with mock.patch.object(web.WebSocketResponse, "prepare", slow_prepare):
                    results = await asyncio.gather(
                        self.client.ws_connect("/ws?session_id=s25"),
                        self.client.ws_connect("/ws?session_id=s25"),
                        return_exceptions=True,
                    )
                connected = [
                    r for r in results if isinstance(r, aiohttp.ClientWebSocketResponse)
                ]
                rejected = [
                    r.status
                    for r in results
                    if isinstance(r, aiohttp.WSServerHandshakeError)
                ]
                self.assertEqual((len(connected), rejected), (1, [409]), results)
                await connected[0].close()
                await self.wait_for_session_end("s25")

    async def test_browser_close_closes_upstream_normally(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s20")
                with self.assertLogs("absl", level="INFO") as logs:
                    ws = await self.client.ws_connect("/ws?session_id=s20")
                    await ws.send_str("ping")
                    await asyncio.wait_for(ws.receive(), 5)
                    await ws.close()
                    await self.wait_for_session_end("s20")
                self.assertEqual(await upstream.wait_for_close_codes(1), [1000])
        self.assertTrue(
            any("Session s20 ended after" in line for line in logs.output),
            logs.output,
        )

    async def test_cancelled_proxy_closes_upstream_as_going_away(self):
        class SilentBrowser:
            async def recv(self):
                await asyncio.Event().wait()

            async def send(self, data):
                pass

        async with FakeUpstream() as upstream:
            handler = websocket_handler.WebsocketHandler(
                f"ws://127.0.0.1:{upstream.port}", "s21", SilentBrowser()
            )
            with self.assertLogs("absl", level="INFO") as logs:
                session = asyncio.create_task(handler.start_websocket())
                async with asyncio.timeout(5):
                    while handler.server_websocket is None:
                        await asyncio.sleep(0.02)
                # What aiohttp does to the handler at shutdown.
                await handler.end_websocket()
                with self.assertRaises(asyncio.CancelledError):
                    await session
            self.assertEqual(await upstream.wait_for_close_codes(1), [1001])
        self.assertTrue(
            any("Session s21 ended after" in line for line in logs.output),
            logs.output,
        )

    async def wait_for_session_end(self, session_id, timeout=5):
        """Waits until session_id's record is gone and no proxy is running.

        A record is released when the browser closes, before its proxy has
        closed upstream.
        """

        # By code object, not name, so a rename fails here instead of making
        # this stop waiting for the proxy.
        proxy_code = websocket_handler.WebsocketHandler.create_proxy.__code__

        def proxy_running():
            return any(
                getattr(t.get_coro(), "cr_code", None) is proxy_code
                for t in asyncio.all_tasks()
                if not t.done()
            )

        async with asyncio.timeout(timeout):
            while await main.SESSION_MANAGER.search_item(session_id) or proxy_running():
                await asyncio.sleep(0.02)

    async def test_quiet_session_survives_many_heartbeats(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(
                common_bag_ws_port=upstream.port, ws_heartbeat_s=0.4
            ):
                await self.connect_session("s16")
                ws = await self.client.ws_connect("/ws?session_id=s16")
                # aiohttp's client answers pings only while receive() is
                # pending; browsers always do.
                receive = asyncio.create_task(ws.receive())
                # Both peers answer pings, so five silent intervals are fine.
                await asyncio.sleep(2)
                self.assertFalse(receive.done())
                await ws.send_str("still there?")
                msg = await asyncio.wait_for(receive, 5)
                self.assertEqual(json.loads(msg.data), {"echo": "still there?"})
                await ws.close()

    async def test_browser_that_stops_answering_pings_is_dropped(self):
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(
                common_bag_ws_port=upstream.port, ws_heartbeat_s=0.1
            ):
                await self.connect_session("s17")
                ws = await self.client.ws_connect("/ws?session_id=s17", autoping=False)
                await self.wait_for_session_end("s17")
                # The upstream connection is closed with the session.
                async with asyncio.timeout(5):
                    while upstream.server.connections:
                        await asyncio.sleep(0.02)
                await ws.close()

    async def test_upstream_that_stops_answering_pings_ends_session(self):
        async with UnresponsiveUpstream() as upstream:
            with (
                flagsaver.flagsaver(
                    common_bag_ws_port=upstream.port, ws_heartbeat_s=0.4
                ),
                mock.patch.object(websocket_handler, "UPSTREAM_CLOSE_TIMEOUT_S", 0.1),
            ):
                await self.connect_session("s18")
                ws = await self.client.ws_connect("/ws?session_id=s18")
                msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1011)
        await self.wait_for_session_end("s18")

    async def test_heartbeat_can_be_disabled(self):
        # Watching for pings alone can't tell "disabled" from a default
        # interval longer than the test, so also check what each leg was given.
        heartbeats = []

        class RecordingResponse(web.WebSocketResponse):
            def __init__(self, *args, **kwargs):
                heartbeats.append(kwargs.get("heartbeat"))
                super().__init__(*args, **kwargs)

        async with UnresponsiveUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port, ws_heartbeat_s=0),
                mock.patch.object(websocket_handler, "UPSTREAM_CLOSE_TIMEOUT_S", 0.1),
                mock.patch.object(main.web, "WebSocketResponse", RecordingResponse),
            ):
                await self.connect_session("s19")
                ws = await self.client.ws_connect("/ws?session_id=s19")
                record = await main.SESSION_MANAGER.search_item("s19")
                assert record is not None and record.websocket_handler is not None
                self.assertIsNone(record.websocket_handler.keepalive_s)
                self.assertEqual(heartbeats, [None])
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(ws.receive(), 0.5)
                self.assertIsNotNone(await main.SESSION_MANAGER.search_item("s19"))
                await ws.close()
                await self.wait_for_session_end("s19")

    async def test_rejects_cross_origin_requests(self):
        body = {
            "command": "connect",
            "session_id": "s7",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        resp = await self.client.post(
            "/api/control", json=body, headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(resp.status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", resp.headers)
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s7"))

        resp = await self.client.get(
            "/ws?session_id=s7", headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(resp.status, 403)

        # The app's own pages, and scripts that send no Origin, are allowed.
        own_origin = f"http://{self.client.host}:{self.client.port}"
        resp = await self.client.post(
            "/api/control", json=body, headers={"Origin": own_origin}
        )
        self.assertEqual(resp.status, 200)

    async def test_same_origin_normalizes_host_case_and_default_ports(self):
        body = {
            "command": "connect",
            "session_id": "s7n",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        allowed_cases = [
            ("LOCALHOST:18731", "http://localhost:18731"),
            ("localhost:18731", "http://LOCALHOST:18731"),
            ("localhost:18731", "HTTP://LOCALHOST:18731"),
            ("[2001:DB8::1]:18731", "http://[2001:db8::1]:18731"),
            ("[2001:db8::1]:18731", "http://[2001:DB8::1]:18731"),
            ("localhost:80", "http://localhost"),
            ("localhost:443", "https://localhost"),
            ("localhost", "http://localhost:80"),
            ("localhost", "https://localhost:443"),
            ("LOCALHOST:80", "http://localhost"),
            ("LOCALHOST:443", "https://localhost"),
            ("[2001:DB8::1]:80", "http://[2001:db8::1]"),
            ("[2001:DB8::1]:443", "https://[2001:db8::1]"),
            ("localhost.", "http://LOCALHOST."),
        ]
        for i, (host, origin) in enumerate(allowed_cases):
            headers = {"Host": host, "Origin": origin}
            resp = await self.client.post(
                "/api/control",
                json={**body, "session_id": f"s7n-ok-{i}"},
                headers=headers,
            )
            self.assertEqual(resp.status, 200, headers)
            resp = await self.client.get("/ws?session_id=none", headers=headers)
            self.assertNotEqual(resp.status, 403, headers)

        rejected_cases = [
            ("localhost:443", "http://localhost"),
            ("localhost:80", "https://localhost"),
            ("localhost", "http://localhost:443"),
            ("localhost", "https://localhost:80"),
            ("localhost:18731", "http://localhost"),
            ("localhost", "http://localhost:18731"),
            ("[2001:db8::1]:443", "http://[2001:db8::1]"),
            ("localhost:18731", "http://evil.example@localhost:18731"),
            ("localhost:18731", "http://@localhost:18731"),
            ("localhost:18731", "http://evil.example\\@localhost:18731"),
            ("localhost:18731", "http://localhost:18731?"),
            ("localhost:18731", "http://localhost:18731#"),
            ("localhost:18731", "http://localhost:18731/"),
            ("localhost", "http://localhost:"),
            ("[::1]", "http://[::1]:"),
            ("localhost", "http://localhost:0"),
            ("localhost", "http://localhost."),
            ("localhost.", "http://localhost"),
            ("localhost:18731", "http://[::1]:18731"),
        ]
        for host, origin in rejected_cases:
            headers = {"Host": host, "Origin": origin}
            resp = await self.client.post("/api/control", json=body, headers=headers)
            self.assertEqual(resp.status, 403, headers)
            self.assertEqual(
                await resp.text(), "Cross-origin request rejected", headers
            )
            resp = await self.client.get("/ws?session_id=s7n", headers=headers)
            self.assertEqual(resp.status, 403, headers)

        # Normalized same-origin headers still must not bypass the Host check.
        for host, origin in [
            ("EVIL.EXAMPLE:80", "http://evil.example"),
            ("EVIL.EXAMPLE:443", "https://evil.example"),
        ]:
            resp = await self.client.post(
                "/api/control", json=body, headers={"Host": host, "Origin": origin}
            )
            self.assertEqual(resp.status, 403, (host, origin))
            self.assertIn("--allowed_hosts", await resp.text())
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s7n"))

    async def test_rejection_logs_escape_client_text(self):
        # The path is percent-decoded, so a client can put a newline in it, and
        # header values may hold bytes 0x80-0xFF (NEL, 0x85, is a line break to
        # str.splitlines). Neither may forge or hide a log line. (Both HTTP
        # parsers refuse ASCII control characters in headers with a 400.)
        forged = "W1122 09:00:00.000000 1 main.py:1] forged"
        paths = [
            "/api/control" + urllib.parse.quote(sep + forged)
            for sep in ("\n", "\r", "\u2028", "\x85")
        ]
        requests = [(path, "Host: evil.example") for path in paths]
        requests += [(path, "Origin: https://evil.example") for path in paths]
        requests.append(("/api/control", "Origin: https://evil.example\x85" + forged))
        for path, header in requests:
            with self.assertLogs("absl", level="WARNING") as logs:
                status = await self._raw_request("POST", path, header)
            self.assertEqual(status, 403, (path, header))
            [message] = [record.getMessage() for record in logs.records]
            self.assertTrue(message.startswith("Rejected POST "), message)
            self.assertTrue(message.isprintable(), repr(message))
            self.assertIn("forged", message)

    async def _raw_request(self, method: str, path: str, header: str) -> int:
        """Sends a header aiohttp's client won't send; returns the status."""
        reader, writer = await asyncio.open_connection(
            self.client.host, self.client.port
        )
        try:
            host = f"Host: {self.client.host}:{self.client.port}\r\n"
            if header.startswith("Host:"):
                host = ""
            writer.write(
                f"{method} {path} HTTP/1.1\r\n{host}{header}\r\n"
                "Content-Length: 0\r\nConnection: close\r\n\r\n".encode("latin-1")
            )
            status_line = await reader.readline()
            return int(status_line.split()[1])
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_rejects_dns_rebinding_and_foreign_ip_origins(self):
        body = {
            "command": "connect",
            "session_id": "s11",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        # DNS rebinding: the attacker's name, pointed at this server.
        resp = await self.client.post(
            "/api/control",
            json=body,
            headers={"Host": "evil.example:8080", "Origin": "http://evil.example:8080"},
        )
        self.assertEqual(resp.status, 403)
        self.assertIn("--allowed_hosts", await resp.text())
        # A page served from some other IP address.
        resp = await self.client.post(
            "/api/control", json=body, headers={"Origin": "http://203.0.113.7:8080"}
        )
        self.assertEqual(resp.status, 403)

    async def test_allowed_hosts_flag_admits_a_proxy(self):
        body = {
            "command": "connect",
            "session_id": "s12",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        headers = {"Host": "demo.example.com", "Origin": "https://demo.example.com"}
        resp = await self.client.post("/api/control", json=body, headers=headers)
        self.assertEqual(resp.status, 403)
        with flagsaver.flagsaver(allowed_hosts=["demo.example.com"]):
            resp = await self.client.post("/api/control", json=body, headers=headers)
            self.assertEqual(resp.status, 200)
            # A proxy that rewrites Host to localhost but keeps the Origin.
            resp = await self.client.post(
                "/api/control",
                json={**body, "session_id": "s13"},
                headers={"Origin": "https://demo.example.com"},
            )
            self.assertEqual(resp.status, 200)

    async def test_null_origin_rejected_even_with_blank_allowed_host(self):
        body = {
            "command": "connect",
            "session_id": "s14",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        # A trailing comma leaves an empty entry in the list flag.
        with flagsaver.flagsaver(allowed_hosts=["demo.example.com", ""]):
            resp = await self.client.post(
                "/api/control", json=body, headers={"Origin": "null"}
            )
        self.assertEqual(resp.status, 403)

    async def test_star_allowed_host_keeps_the_origin_check(self):
        body = {
            "command": "connect",
            "session_id": "s15",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        with flagsaver.flagsaver(allowed_hosts=["*"]):
            # Any Host passes, but a page on another site still can't reach
            # the server, at its own host or any other.
            for host, origin in [
                (None, "https://evil.example"),
                (None, "http://*"),
                (None, "http://203.0.113.7:8080"),
                ("any.example", "http://evil.example"),
                ("any.example", "http://any.example:6666"),
            ]:
                headers = {"Origin": origin} | ({"Host": host} if host else {})
                resp = await self.client.post(
                    "/api/control", json=body, headers=headers
                )
                self.assertEqual(resp.status, 403, (host, origin))
                resp = await self.client.get("/ws?session_id=s15", headers=headers)
                self.assertEqual(resp.status, 403, (host, origin))
            self.assertIsNone(await main.SESSION_MANAGER.search_item("s15"))
            # Any Host with its own page, or with no Origin (scripts), works.
            resp = await self.client.post(
                "/api/control",
                json=body,
                headers={"Host": "any.example", "Origin": "http://any.example"},
            )
            self.assertEqual(resp.status, 200)
            resp = await self.client.post(
                "/api/control",
                json={**body, "session_id": "s16"},
                headers={"Host": "any.example"},
            )
            self.assertEqual(resp.status, 200)
        # A named entry next to "*" still admits that origin behind a proxy.
        with flagsaver.flagsaver(allowed_hosts=["*", "demo.example.com"]):
            resp = await self.client.post(
                "/api/control",
                json={**body, "session_id": "s17"},
                headers={"Origin": "https://demo.example.com"},
            )
            self.assertEqual(resp.status, 200)

    async def test_allowed_host_port_limits_the_origin(self):
        body = {
            "command": "connect",
            "session_id": "s18",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        with flagsaver.flagsaver(
            allowed_hosts=[
                "demo.example:8443",
                "web.example:443",
                "any.example",
                "[::1]",
            ]
        ):
            # Behind a proxy that rewrites Host: only the listed port, or the
            # scheme's default when the Origin names none, is that page.
            cases = [
                ("https://demo.example:8443", 200),
                ("https://Demo.Example.:8443", 200),
                ("https://demo.example:6666", 403),
                ("https://demo.example", 403),
                ("http://demo.example:8443", 200),
                ("https://web.example", 200),
                ("https://web.example:443", 200),
                ("https://web.example:0", 403),
                ("http://web.example", 403),
                ("https://web.example:8443", 403),
                ("https://any.example:6666", 200),
                ("https://any.example:1", 200),
                ("https://any.example:65535", 200),
                ("https://any.example:0", 403),
                ("http://any.example:0", 403),
                ("https://any.example:00", 403),
                ("http://[::1]:0", 403),
                ("http://[::1]:8080", 200),
                ("https://demo.example:99999", 403),
            ]
            for i, (origin, status) in enumerate(cases):
                resp = await self.client.post(
                    "/api/control",
                    json={**body, "session_id": f"s18-{i}"},
                    headers={"Origin": origin},
                )
                self.assertEqual(resp.status, status, origin)
                resp = await self.client.get(
                    "/ws?session_id=none", headers={"Origin": origin}
                )
                self.assertEqual(resp.status == 403, status == 403, origin)

    def test_allowed_hosts_entries_are_normalized(self):
        with flagsaver.flagsaver(
            allowed_hosts=[" Demo.Example.com. ", "proxy.example:8443", ""]
        ):
            self.assertEqual(
                main.explicitly_allowed_hosts(),
                frozenset({"demo.example.com", "proxy.example"}),
            )
            self.assertTrue(main.is_allowed_host("demo.example.com"))
            self.assertTrue(main.is_allowed_host("proxy.example"))
            self.assertFalse(main.is_allowed_host(""))

    def test_invalid_allowed_hosts_entries_are_rejected(self):
        for entry in [
            "[",
            "demo.example:http",
            "demo.example:",
            "[::1]:",
            "127.0.0.1:",
            "demo.example:0",
            "demo.example:00",
            "[::1]:0",
            "demo.example:99999",
            "https://demo.example",
            "demo.example/app",
            "user@demo.example",
            "demo\\example",
            "demo example",
            ":8443",
            ".",
            "..",
            ".example.com",
            "foo..bar",
            "demo.example..",
            ".example.com:8443",
            "foo..bar:8443",
            "demo.example..:8443",
            ".:8443",
            "*.",
            "*:8080",
            "*.example.com",
            "*.example.com:8443",
            "foo*bar",
            "ev\u00e9.example",
            "ev\u00e9.example:8443",
            "demo.example\x00",
            "demo.example\x7f",
        ]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=entry):
                with flagsaver.flagsaver(allowed_hosts=["demo.example.com", entry]):
                    pass
        with flagsaver.flagsaver(
            allowed_hosts=[
                "myhost",
                "min.example:1",
                "max.example:65535",
                "fqdn.example.:8443",
                "xn--ev-cja.example:443",
                "[::1]:8080",
                "[2001:db8::]",
                "*",
                "",
            ]
        ):
            self.assertEqual(
                main.explicitly_allowed_hosts(),
                frozenset(
                    {
                        "myhost",
                        "min.example",
                        "max.example",
                        "fqdn.example",
                        "xn--ev-cja.example",
                        "::1",
                        "2001:db8::",
                        "*",
                    }
                ),
            )

    def test_server_refuses_to_start_with_invalid_allowed_hosts(self):
        for flag_val, expected_err in [
            ("demo.example,[", "invalid entry '['"),
            ("*.", "invalid entry '*.'"),
            ("*:8080", "invalid entry '*:8080'"),
            ("*.example.com", "invalid entry '*.example.com'"),
            ("ev\u00e9.example", "non-ASCII host name"),
        ]:
            with self.subTest(allowed_hosts=flag_val):
                result = subprocess.run(
                    [
                        sys.executable,
                        os.path.join(os.path.dirname(main.__file__), "main.py"),
                        f"--allowed_hosts={flag_val}",
                    ],
                    env={**os.environ, "PORT": "0"},
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("--allowed_hosts", result.stderr)
                self.assertIn(expected_err, result.stderr)
                self.assertNotIn("Serving on", result.stderr)

    def test_is_allowed_host(self):
        for host in [
            "localhost",
            "localhost.",
            "127.0.0.1",
            "::1",
            "10.1.2.3",
            "app.localhost",
            "app.localhost.",
        ]:
            self.assertTrue(main.is_allowed_host(host), host)
        for host in [
            "evil.example",
            "",
            None,
            "foo.run.app",
            ".",
            "..",
            ".localhost",
            "foo..localhost",
            "localhost..",
        ]:
            self.assertFalse(main.is_allowed_host(host), host)
        with mock.patch.dict("os.environ", {"K_SERVICE": "demo"}):
            self.assertTrue(main.is_allowed_host("demo-abc123-uc.a.run.app"))
            self.assertTrue(main.is_allowed_host("demo-abc123-uc.a.run.app."))
            for host in [".run.app", "demo..run.app", "demo-abc123-uc.a.run.app.."]:
                self.assertFalse(main.is_allowed_host(host), host)
        with flagsaver.flagsaver(allowed_hosts=["*"]):
            for host in [".", "..", ".localhost", "foo..bar", "localhost.."]:
                self.assertFalse(main.is_allowed_host(host), host)

    async def test_gethostname_oserror_does_not_500_in_reject_cross_origin(self):
        main._machine_hostnames.cache_clear()
        self.addCleanup(main._machine_hostnames.cache_clear)
        with mock.patch.object(
            main.socket, "gethostname", side_effect=OSError("hostname failed")
        ):
            resp = await self.client.post(
                "/api/control",
                json={
                    "command": "connect",
                    "session_id": "s-host-err",
                    "endpoint": "autopush-common",
                    "location": "us-central1",
                },
                headers={"Host": "unknown.example"},
            )
            self.assertEqual(resp.status, 403)
            self.assertFalse(main.is_allowed_host("unknown.example"))
            self.assertTrue(main.is_allowed_host("localhost"))

    async def test_slow_getfqdn_does_not_stall_event_loop_or_duplicate_lookups(self):
        main._machine_hostnames.cache_clear()
        self.addCleanup(main._machine_hostnames.cache_clear)
        started = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        calls = 0

        def slow_fqdn():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(timeout=5)
            return "MyBox.Corp.Example."

        with (
            mock.patch.object(main.socket, "getfqdn", slow_fqdn),
            mock.patch.object(main.socket, "gethostname", lambda: "mybox"),
        ):
            # Loopback/IP requests don't need reverse DNS at all.
            resp = await asyncio.wait_for(
                self.client.post("/api/control", json={}), timeout=2.0
            )
            self.assertEqual(resp.status, 400)
            self.assertEqual(calls, 0)

            # Two concurrent requests that need FQDN share one worker-thread lookup.
            fqdn_req = asyncio.create_task(
                self.client.post(
                    "/api/control",
                    json={},
                    headers={"Host": "mybox.corp.example:8080"},
                )
            )
            evil_req = asyncio.create_task(
                self.client.post(
                    "/api/control",
                    json={},
                    headers={"Host": "evil.example:8080"},
                )
            )
            for _ in range(200):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("getfqdn was not called")

            # While getfqdn is blocked, the event loop still serves other requests.
            health = await asyncio.wait_for(self.client.get("/healthz"), timeout=1.0)
            self.assertEqual(health.status, 200)
            fast_post = await asyncio.wait_for(
                self.client.post("/api/control", json={}), timeout=1.0
            )
            self.assertEqual(fast_post.status, 400)
            self.assertFalse(fqdn_req.done())
            self.assertFalse(evil_req.done())
            self.assertEqual(calls, 1)

            release.set()
            fqdn_resp, evil_resp = await asyncio.wait_for(
                asyncio.gather(fqdn_req, evil_req), timeout=2.0
            )
            self.assertEqual(fqdn_resp.status, 400)
            self.assertEqual(evil_resp.status, 403)
            self.assertEqual(calls, 1)

            # Subsequent lookups hit the cache without re-running getfqdn.
            cached_resp = await asyncio.wait_for(
                self.client.post(
                    "/api/control",
                    json={},
                    headers={"Host": "mybox.corp.example:8080"},
                ),
                timeout=1.0,
            )
            self.assertEqual(cached_resp.status, 400)
            self.assertEqual(calls, 1)

    async def test_static_files_revalidate(self):
        resp = await self.client.get("/frontend/script.js")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Cache-Control"], "no-cache")
        resp = await self.client.get("/")
        csp = resp.headers["Content-Security-Policy"]
        self.assertEqual(csp, main.CONTENT_SECURITY_POLICY)
        self.assertIn("frame-ancestors 'self'", csp)
        self.assertNotIn("'unsafe-inline' https", csp)
        self.assertEqual(resp.headers["X-Content-Type-Options"], "nosniff")
        resp = await self.client.get("/healthz")
        self.assertEqual(await resp.text(), "ok")

    def test_index_html_has_nothing_the_csp_blocks(self):
        directives = {}
        for directive in main.CONTENT_SECURITY_POLICY.split(";"):
            name, _, sources = directive.strip().partition(" ")
            directives[name] = sources
        script_sources = directives["script-src"].split()
        self.assertNotIn("'unsafe-inline'", script_sources)
        style_sources = directives["style-src"].split()

        class Collector(html.parser.HTMLParser):
            def __init__(self):
                super().__init__()
                self.problems = []

            def handle_starttag(self, tag, attrs):
                attrs = {name: value or "" for name, value in attrs}
                for name, value in attrs.items():
                    if name.startswith("on"):
                        self.problems.append(f"<{tag} {name}>")
                    if value.strip().lower().startswith("javascript:"):
                        self.problems.append(f"<{tag} {name}=javascript:>")
                if tag == "script":
                    src = attrs.get("src")
                    if not src:
                        self.problems.append("inline <script>")
                    elif not self._allowed(src, script_sources):
                        self.problems.append(f"script {src}")
                if tag == "link" and attrs.get("rel") == "stylesheet":
                    if not self._allowed(attrs["href"], style_sources):
                        self.problems.append(f"stylesheet {attrs['href']}")

            @staticmethod
            def _allowed(url, sources):
                parts = urllib.parse.urlsplit(url)
                if not parts.netloc:
                    return "'self'" in sources
                return f"{parts.scheme}://{parts.netloc}" in sources

        with open(os.path.join(main.FRONTEND_DIR, "index.html")) as f:
            collector = Collector()
            collector.feed(f.read())
        self.assertEqual(collector.problems, [])


class MainAsyncTest(unittest.IsolatedAsyncioTestCase):
    """main_async with a fake Common BAG gateway subprocess."""

    def setUp(self):
        gateway = tempfile.NamedTemporaryFile(suffix=".par")
        self.addCleanup(gateway.close)
        self.gateway = mock.Mock(spec=subprocess.Popen)
        self.gateway.poll.return_value = None
        self._popen_patcher = mock.patch.object(
            main.subprocess, "Popen", return_value=self.gateway
        )
        self.popen = self._popen_patcher.start()
        self.addCleanup(self._popen_patcher.stop)
        for patcher in [
            mock.patch.object(main, "COMMON_BAG_PROXY_PAR", gateway.name),
            mock.patch.object(
                main.get_credentials, "get_access_token", return_value="token"
            ),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_invalid_port_fails_before_gateway_or_app(self):
        with mock.patch.object(main, "create_app", wraps=main.create_app) as create_app:
            for value in ["", "   ", "abc", "-1", "65536", "70000", "1_000", "+8080"]:
                with self.subTest(port=value):
                    self.popen.reset_mock()
                    create_app.reset_mock()
                    with mock.patch.dict("os.environ", {"PORT": value}):
                        with self.assertRaisesRegex(ValueError, "invalid PORT"):
                            await main.main_async()
                    self.popen.assert_not_called()
                    create_app.assert_not_called()

    async def test_gateway_stopped_when_port_is_in_use(self):
        with socket.socket() as busy:
            busy.bind(("", 0))
            busy.listen()
            port = busy.getsockname()[1]
            with mock.patch.dict("os.environ", {"PORT": str(port)}):
                with self.assertRaises(OSError):
                    await main.main_async()
        self.popen.assert_called_once()
        self.assertEqual(self.popen.call_args.kwargs.get("stdin"), subprocess.DEVNULL)
        self.gateway.terminate.assert_called_once()

    async def test_gateway_stopped_on_sigterm(self):
        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        with mock.patch.dict("os.environ", {"PORT": str(port)}):
            server = asyncio.create_task(main.main_async())
            async with aiohttp.ClientSession() as session:
                for _ in range(100):
                    try:
                        async with session.get(
                            f"http://127.0.0.1:{port}/healthz"
                        ) as resp:
                            self.assertEqual(resp.status, 200)
                            break
                    except aiohttp.ClientConnectionError:
                        self.assertFalse(server.done())
                        await asyncio.sleep(0.05)
                else:
                    self.fail("server didn't start")
            self.gateway.terminate.assert_not_called()
            os.kill(os.getpid(), signal.SIGTERM)
            await asyncio.wait_for(server, timeout=10)
        self.gateway.terminate.assert_called_once()
        self.gateway.wait.assert_called_once_with(
            timeout=main.GATEWAY_SHUTDOWN_TIMEOUT_S
        )
        self.gateway.kill.assert_not_called()

    async def test_gateway_escalates_to_kill_when_sigterm_times_out(self):
        self.gateway.wait.side_effect = [
            subprocess.TimeoutExpired("gw", main.GATEWAY_SHUTDOWN_TIMEOUT_S),
            -9,
        ]
        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        with (
            mock.patch.dict("os.environ", {"PORT": str(port)}),
            self.assertLogs("absl", level="WARNING") as logs,
        ):
            server = asyncio.create_task(main.main_async())
            async with aiohttp.ClientSession() as session:
                for _ in range(100):
                    try:
                        async with session.get(
                            f"http://127.0.0.1:{port}/healthz"
                        ) as resp:
                            self.assertEqual(resp.status, 200)
                            break
                    except aiohttp.ClientConnectionError:
                        self.assertFalse(server.done())
                        await asyncio.sleep(0.05)
                else:
                    self.fail("server didn't start")
            os.kill(os.getpid(), signal.SIGTERM)
            await asyncio.wait_for(server, timeout=10)
        self.gateway.terminate.assert_called_once()
        self.gateway.kill.assert_called_once()
        self.assertEqual(self.gateway.wait.call_count, 2)
        self.assertIn("killing it", "\n".join(logs.output))

    async def test_gateway_already_exited_not_terminated_on_shutdown(self):
        self.gateway.poll.return_value = 0
        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        with mock.patch.dict("os.environ", {"PORT": str(port)}):
            server = asyncio.create_task(main.main_async())
            async with aiohttp.ClientSession() as session:
                for _ in range(100):
                    try:
                        async with session.get(
                            f"http://127.0.0.1:{port}/healthz"
                        ) as resp:
                            self.assertEqual(resp.status, 200)
                            break
                    except aiohttp.ClientConnectionError:
                        self.assertFalse(server.done())
                        await asyncio.sleep(0.05)
                else:
                    self.fail("server didn't start")
            os.kill(os.getpid(), signal.SIGTERM)
            await asyncio.wait_for(server, timeout=10)
        self.gateway.terminate.assert_not_called()
        self.gateway.wait.assert_not_called()
        self.gateway.kill.assert_not_called()

    async def test_sigterm_during_startup_skips_binding_and_stops_gateway(self):
        orig_setup = web.AppRunner.setup

        async def setup_with_sigterm(runner_self):
            os.kill(os.getpid(), signal.SIGTERM)
            await asyncio.sleep(0.02)
            return await orig_setup(runner_self)

        with (
            mock.patch.dict("os.environ", {"PORT": "0"}),
            mock.patch.object(web.AppRunner, "setup", setup_with_sigterm),
            mock.patch.object(web.TCPSite, "start") as site_start,
        ):
            await asyncio.wait_for(main.main_async(), timeout=10)
        site_start.assert_not_called()
        self.gateway.terminate.assert_called_once()
        self.gateway.wait.assert_called_once_with(
            timeout=main.GATEWAY_SHUTDOWN_TIMEOUT_S
        )
        self.gateway.kill.assert_not_called()

    async def _assert_starts_without_gateway(self, gateway_path: str) -> list[str]:
        """Runs main_async with the real Popen against a failing gateway file."""
        self._popen_patcher.stop()
        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        with (
            mock.patch.object(main, "COMMON_BAG_PROXY_PAR", gateway_path),
            mock.patch.dict("os.environ", {"PORT": str(port)}),
            self.assertLogs("absl", level="WARNING") as logs,
        ):
            server = asyncio.create_task(main.main_async())
            try:
                async with aiohttp.ClientSession() as session:
                    for _ in range(100):
                        try:
                            async with session.get(
                                f"http://127.0.0.1:{port}/healthz"
                            ) as resp:
                                self.assertEqual(resp.status, 200)
                                break
                        except aiohttp.ClientConnectionError:
                            if server.done():
                                await server
                            await asyncio.sleep(0.05)
                    else:
                        self.fail("server didn't start")
            finally:
                if not server.done():
                    os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.wait_for(server, timeout=10)
        return logs.output

    async def test_non_executable_gateway_logs_warning_and_continues(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gateway_path = os.path.join(tmpdir, "common_bag_ws_proxy.par")
            with open(gateway_path, "wb") as f:
                f.write(b"#!/bin/sh\nexit 0\n")
            os.chmod(gateway_path, 0o644)
            warnings = await self._assert_starts_without_gateway(gateway_path)
        joined = "\n".join(warnings)
        self.assertIn(gateway_path, joined)
        self.assertIn("continuing without it", joined)

    async def test_broken_gateway_shebang_logs_warning_and_continues(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gateway_path = os.path.join(tmpdir, "common_bag_ws_proxy.par")
            with open(gateway_path, "wb") as f:
                f.write(b"#!/nonexistent/interpreter/for/test\n")
            os.chmod(gateway_path, 0o755)
            warnings = await self._assert_starts_without_gateway(gateway_path)
        joined = "\n".join(warnings)
        self.assertIn(gateway_path, joined)
        self.assertIn("continuing without it", joined)

    async def test_main_async_warms_machine_hostnames_without_blocking_startup(self):
        main._machine_hostnames.cache_clear()
        self.addCleanup(main._machine_hostnames.cache_clear)
        started = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)

        def slow_fqdn():
            started.set()
            release.wait(timeout=5)
            return "warmed.example"

        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        with (
            mock.patch.dict("os.environ", {"PORT": str(port)}),
            mock.patch.object(main.socket, "getfqdn", slow_fqdn),
        ):
            server = asyncio.create_task(main.main_async())
            try:
                async with aiohttp.ClientSession() as session:
                    for _ in range(100):
                        try:
                            async with session.get(
                                f"http://127.0.0.1:{port}/healthz"
                            ) as resp:
                                self.assertEqual(resp.status, 200)
                                break
                        except aiohttp.ClientConnectionError:
                            self.assertFalse(server.done())
                            await asyncio.sleep(0.05)
                    else:
                        self.fail("server didn't start")
                for _ in range(200):
                    if started.is_set():
                        break
                    await asyncio.sleep(0.01)
                else:
                    self.fail("warmup did not start getfqdn")
                self.assertEqual(main._machine_hostnames.cache_info().currsize, 0)
                release.set()
                for _ in range(200):
                    if main._machine_hostnames.cache_info().currsize:
                        break
                    await asyncio.sleep(0.01)
                else:
                    self.fail("warmup did not populate _machine_hostnames cache")
                self.assertIn("warmed.example", main._machine_hostnames())
            finally:
                release.set()
                if not server.done():
                    os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.wait_for(server, timeout=10)

    async def test_main_async_cancels_prefetch_on_shutdown(self):
        started = asyncio.Event()
        cancelled = False

        async def slow_prefetch(*, bounded=True):
            nonlocal cancelled
            del bounded
            started.set()
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                cancelled = True
                raise

        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        with (
            mock.patch.dict("os.environ", {"PORT": str(port)}),
            mock.patch.object(
                main.get_credentials, "fetch_access_token", side_effect=slow_prefetch
            ),
            mock.patch.object(main, "COMMON_BAG_PROXY_PAR", "/nonexistent/gw.par"),
        ):
            before_tasks = set(asyncio.all_tasks())
            server = asyncio.create_task(main.main_async())
            try:
                await asyncio.wait_for(started.wait(), timeout=5)
                os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.wait_for(server, timeout=10)
                leaked = [
                    t for t in (set(asyncio.all_tasks()) - before_tasks) if not t.done()
                ]
                self.assertEqual(leaked, [])
                self.assertTrue(cancelled)
            finally:
                if not server.done():
                    os.kill(os.getpid(), signal.SIGTERM)
                    await asyncio.wait_for(server, timeout=10)

    async def _bound_addresses(self, k_service=None):
        """Starts main_async, returns what it listens on, and stops it."""
        runners = []

        class RecordingRunner(web.AppRunner):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                runners.append(self)

        with socket.socket() as probe:
            probe.bind(("", 0))
            port = probe.getsockname()[1]
        env = {"PORT": str(port)}
        if k_service:
            env["K_SERVICE"] = k_service
        with (
            mock.patch.dict("os.environ", env),
            mock.patch.object(main.web, "AppRunner", RecordingRunner),
        ):
            if not k_service:
                os.environ.pop("K_SERVICE", None)
            server = asyncio.create_task(main.main_async())
            try:
                for _ in range(100):
                    if runners and runners[0].addresses:
                        break
                    self.assertFalse(server.done())
                    await asyncio.sleep(0.05)
                else:
                    self.fail("server didn't start")
                addresses = [address[:2] for address in runners[0].addresses]
                reachable = await asyncio.to_thread(
                    _accepts_connections, _non_loopback_ipv4(), port
                )
            finally:
                os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.wait_for(server, timeout=10)
        return addresses, port, reachable

    async def test_binds_loopback_by_default(self):
        # With no login on the server, another machine on the LAN that reached
        # it could start sessions billed to the owner's project.
        addresses, port, reachable = await self._bound_addresses()
        self.assertEqual(addresses, [("127.0.0.1", port)])
        self.assertIn(reachable, (False, None))

    async def test_binds_every_interface_on_cloud_run(self):
        addresses, _, reachable = await self._bound_addresses(k_service="demo")
        self.assertIn("0.0.0.0", {host for host, _ in addresses})
        self.assertIn(reachable, (True, None))

    async def test_host_flag_sets_the_address(self):
        with flagsaver.flagsaver(host="0.0.0.0"):
            addresses, port, reachable = await self._bound_addresses()
        self.assertEqual(addresses, [("0.0.0.0", port)])
        self.assertIn(reachable, (True, None))

    async def test_host_flag_overrides_cloud_run(self):
        with flagsaver.flagsaver(host="127.0.0.1"):
            addresses, port, _ = await self._bound_addresses(k_service="demo")
        self.assertEqual(addresses, [("127.0.0.1", port)])

    def test_host_flag_validator(self):
        for value in ["0.0.0.0", "::", "::1", "localhost", "my-box", "box.example.com"]:
            with flagsaver.flagsaver(host=value):
                self.assertEqual(main.HOST.value, value)
        for value in ["0.0.0.0:8080", "http://0.0.0.0", "", " ", "[::]", "a b"]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=value):
                with flagsaver.flagsaver(host=value):
                    pass


class FlagValidatorTest(unittest.TestCase):
    def test_common_bag_ws_port_flag_validator(self):
        for value in [1, 8765, 65535]:
            with flagsaver.flagsaver(common_bag_ws_port=value):
                self.assertEqual(main.COMMON_BAG_WS_PORT.value, value)
        for value in [-1, 0, 65536, 70000]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=value):
                with flagsaver.flagsaver(common_bag_ws_port=value):
                    pass

    def test_ws_heartbeat_s_flag_validator(self):
        for value in [0, 0.0, 0.5, 20.0]:
            with flagsaver.flagsaver(ws_heartbeat_s=value):
                self.assertEqual(main.WS_HEARTBEAT_S.value, value)
        for value in [-1.0, float("-inf"), float("inf"), float("nan")]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=value):
                with flagsaver.flagsaver(ws_heartbeat_s=value):
                    pass

    def test_fr_simulator_thinking_level_flag_validator(self):
        for value in [
            "",
            "   ",
            "low",
            "LOW",
            " low ",
            "minimal",
            "medium",
            "high",
            "THINKING_LEVEL_UNSPECIFIED",
        ]:
            with flagsaver.flagsaver(fr_simulator_thinking_level=value):
                self.assertEqual(main.FR_SIMULATOR_THINKING.value, value)
        for value in ["bogus", "very_low", "none", "off", "0", "low high"]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=value):
                with flagsaver.flagsaver(fr_simulator_thinking_level=value):
                    pass

    def test_project_id_resolution_and_validation(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
            for flag_val in [None, "", "   ", "\t\n"]:
                with self.subTest(flag_val=flag_val):
                    with flagsaver.flagsaver(project_id=flag_val):
                        self.assertEqual(main.project_id(), main.DEFAULT_PROJECT_ID)

        for env_val, expected in [
            ("", main.DEFAULT_PROJECT_ID),
            ("   ", main.DEFAULT_PROJECT_ID),
            ("  env-proj  ", "env-proj"),
            ("123456789012", "123456789012"),
            ("google.com:my-proj", "google.com:my-proj"),
        ]:
            with self.subTest(env_val=env_val):
                with mock.patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT": env_val}):
                    with flagsaver.flagsaver(project_id="   "):
                        self.assertEqual(main.project_id(), expected)

        for flag_val, expected in [
            ("p", "p"),
            ("  my-proj  ", "my-proj"),
            ("123456789012", "123456789012"),
            ("google.com:my-proj", "google.com:my-proj"),
        ]:
            with self.subTest(flag_val=flag_val):
                with mock.patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT": "bad/env"}):
                    with flagsaver.flagsaver(project_id=flag_val):
                        self.assertEqual(main.project_id(), expected)

        bad_values = [
            "my proj",
            "proj\nother",
            "proj/other",
            "proj\\other",
            ".",
            "..",
            "a..b",
            "proj?x=1",
            "proj#frag",
            "-proj",
            "proj-",
            "ev\u00e9-proj",
        ]
        for value in bad_values:
            with self.subTest(bad_flag=value):
                with self.assertRaises(flags.IllegalFlagValueError, msg=value):
                    with flagsaver.flagsaver(project_id=value):
                        pass
            with self.subTest(bad_env=value):
                with mock.patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT": value}):
                    with flagsaver.flagsaver(project_id=None):
                        with self.assertRaisesRegex(
                            ValueError, "invalid GOOGLE_CLOUD_PROJECT"
                        ):
                            main.project_id()

    def test_fr_simulator_model_flag_validator(self):
        for value in [
            "gemini-3-flash-preview",
            "  gemini-2.5-flash  ",
            "gemini-2.5-flash@001",
            "models/gemini-2.5-flash",
            "publishers/google/models/gemini-2.5-flash",
            "projects/google.com:my-proj/locations/global/publishers/google/models/gemini-2.5-flash",
        ]:
            with flagsaver.flagsaver(fr_simulator_model=value):
                self.assertEqual(main.FR_SIMULATOR_MODEL.value, value)
        for value in [
            "",
            "   ",
            "\t\n",
            "gemini 3",
            "gemini\n3",
            "/gemini-3",
            "gemini-3/",
            "models//gemini-3",
            ".",
            "..",
            "../gemini-3",
            "models/../gemini-3",
            "gemini..3",
            "gemini-3?key=1",
            "gemini-3&a=1",
            "gemini-3#frag",
            "gemini-\u00e9",
        ]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=value):
                with flagsaver.flagsaver(fr_simulator_model=value):
                    pass

    def test_initialize_gemini_chat_session_strips_model(self):
        fake_client = mock.Mock()
        with mock.patch.object(main, "_genai_client", return_value=fake_client):
            with flagsaver.flagsaver(fr_simulator_model="  gemini-2.5-flash  "):
                main.initialize_gemini_chat_session()
        self.assertEqual(
            fake_client.aio.chats.create.call_args.kwargs["model"],
            "gemini-2.5-flash",
        )

    def test_initialize_gemini_chat_session_thinking_level(self):
        fake_client = mock.Mock()
        with mock.patch.object(main, "_genai_client", return_value=fake_client):
            for flag_val, expected in [
                ("", None),
                ("   ", None),
                ("low", main.genai.types.ThinkingLevel.LOW),
                (" High ", main.genai.types.ThinkingLevel.HIGH),
            ]:
                with self.subTest(flag_val=flag_val):
                    fake_client.aio.chats.create.reset_mock()
                    with flagsaver.flagsaver(fr_simulator_thinking_level=flag_val):
                        main.initialize_gemini_chat_session()
                    config = fake_client.aio.chats.create.call_args.kwargs["config"]
                    if expected is None:
                        self.assertIsNone(config.thinking_config)
                    else:
                        self.assertEqual(
                            config.thinking_config.thinking_level, expected
                        )

    def test_listen_port(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            os.environ.pop("PORT", None)
            self.assertEqual(main.listen_port(), main.DEFAULT_PORT)
        for raw, expected in [
            ("0", 0),
            ("80", 80),
            ("8080", 8080),
            ("65535", 65535),
            (" 8080 ", 8080),
        ]:
            with self.subTest(port=raw):
                with mock.patch.dict("os.environ", {"PORT": raw}):
                    self.assertEqual(main.listen_port(), expected)
        for raw in [
            "",
            "   ",
            "abc",
            "-1",
            "-0",
            "+8080",
            "65536",
            "70000",
            "1_000",
            "8080.0",
            "80 80",
            "\u0668\u0660\u0668\u0660",
        ]:
            with self.subTest(port=raw):
                with mock.patch.dict("os.environ", {"PORT": raw}):
                    with self.assertRaisesRegex(
                        ValueError, "invalid PORT.*0 and 65535"
                    ):
                        main.listen_port()

    def test_server_refuses_to_start_with_invalid_env_port(self):
        script = os.path.join(os.path.dirname(main.__file__), "main.py")
        for raw in ["", "abc", "-1", "70000"]:
            with self.subTest(port=raw):
                result = subprocess.run(
                    [sys.executable, script],
                    env={**os.environ, "PORT": raw},
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("invalid PORT", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertNotIn("Serving on", result.stderr)

    def test_server_refuses_to_start_with_invalid_env_project_id(self):
        script = os.path.join(os.path.dirname(main.__file__), "main.py")
        for raw in ["my proj", "proj/other"]:
            with self.subTest(project=raw):
                result = subprocess.run(
                    [sys.executable, script],
                    env={**os.environ, "PORT": "0", "GOOGLE_CLOUD_PROJECT": raw},
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("invalid GOOGLE_CLOUD_PROJECT", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertNotIn("Serving on", result.stderr)

    def test_server_refuses_to_start_with_invalid_port_or_heartbeat(self):
        script = os.path.join(os.path.dirname(main.__file__), "main.py")
        for flag_name, flag_arg in [
            ("--common_bag_ws_port", "--common_bag_ws_port=0"),
            ("--common_bag_ws_port", "--common_bag_ws_port=70000"),
            ("--ws_heartbeat_s", "--ws_heartbeat_s=nan"),
            ("--ws_heartbeat_s", "--ws_heartbeat_s=inf"),
            ("--project_id", "--project_id=proj/other"),
            ("--fr_simulator_model", "--fr_simulator_model="),
            ("--fr_simulator_model", "--fr_simulator_model=   "),
            ("--fr_simulator_thinking_level", "--fr_simulator_thinking_level=bogus"),
        ]:
            with self.subTest(flag=flag_arg):
                result = subprocess.run(
                    [sys.executable, script, flag_arg],
                    env={**os.environ, "PORT": "0"},
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(flag_name, result.stderr)
                self.assertNotIn("Serving on", result.stderr)


def _non_loopback_ipv4():
    """An IPv4 address of this machine other than loopback, or None."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.0.2.1", 9))  # UDP: picks a route, sends nothing.
        except OSError:
            return None
        address = s.getsockname()[0]
    return None if address.startswith("127.") or address == "0.0.0.0" else address


def _accepts_connections(address, port):
    """Whether address:port accepts a TCP connection; None without an address."""
    if address is None:
        return None
    try:
        socket.create_connection((address, port), timeout=2).close()
        return True
    except OSError:
        return False


class ShutdownTest(unittest.TestCase):
    def test_sigterm_exits_while_a_token_fetch_hangs(self):
        # Threads can't be cancelled, so asyncio.run used to wait for the
        # startup token prefetch: ~23 s with this gcloud, and Cloud Run sends
        # SIGKILL 10 s after SIGTERM.
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = os.path.join(tmp, "bin")
            os.mkdir(bin_dir)
            started = os.path.join(tmp, "gcloud.pid")
            gcloud = os.path.join(bin_dir, "gcloud")
            with open(gcloud, "w") as f:
                f.write(f"#!/bin/sh\necho $$ > {started}\nexec sleep 25\n")
            os.chmod(gcloud, 0o755)
            env = {
                "HOME": tmp,
                "PATH": f"{bin_dir}:/usr/bin:/bin",
                "NO_GCE_CHECK": "true",
                "PORT": "0",
            }
            proc = subprocess.Popen(
                [
                    sys.executable,
                    os.path.join(os.path.dirname(main.__file__), "main.py"),
                    "--common_bag_ws_port=1",
                ],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                for _ in range(300):
                    if os.path.exists(started) and os.path.getsize(started):
                        break
                    self.assertIsNone(proc.poll(), "server exited early")
                    threading.Event().wait(0.1)
                else:
                    self.fail("the token fetch never ran gcloud")
                with open(started) as f:
                    self.addCleanup(_kill_if_running, int(f.read()))
                proc.send_signal(signal.SIGTERM)
                try:
                    _, stderr = proc.communicate(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    self.fail("server still running 8 s after SIGTERM")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate()
            self.assertEqual(proc.returncode, 0, stderr)
            self.assertIn("Shutting down", stderr)

    def test_sigterm_kills_gateway_that_ignores_sigterm(self):
        # A wedged gateway that ignores SIGTERM used to outlive the server
        # because main_async called terminate() without waiting or killing it.
        with tempfile.TemporaryDirectory() as tmp:
            gw_pid_path = os.path.join(tmp, "gw.pid")
            gateway = os.path.join(tmp, "common_bag_ws_proxy.par")
            with open(gateway, "w") as f:
                f.write(
                    "#!/bin/sh\n"
                    'trap "" TERM\n'
                    f"echo $$ > {gw_pid_path}.tmp && mv {gw_pid_path}.tmp {gw_pid_path}\n"
                    "exec sleep 300\n"
                )
            os.chmod(gateway, 0o755)
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            runner_code = (
                "import sys\n"
                f"sys.path.insert(0, {os.path.dirname(main.__file__)!r})\n"
                "import main\n"
                f"main.COMMON_BAG_PROXY_PAR = {gateway!r}\n"
                "main.app.run(main.serve)\n"
            )
            stderr_path = os.path.join(tmp, "stderr.log")
            env = {
                "HOME": tmp,
                "PATH": "/usr/bin:/bin",
                "NO_GCE_CHECK": "true",
                "PORT": str(port),
            }
            with open(stderr_path, "w") as stderr_file:
                proc = subprocess.Popen(
                    [sys.executable, "-c", runner_code, "--common_bag_ws_port=1"],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=stderr_file,
                )
                gw_pid = None
                try:
                    for _ in range(200):
                        if os.path.exists(gw_pid_path):
                            try:
                                with urllib.request.urlopen(
                                    f"http://127.0.0.1:{port}/healthz", timeout=1
                                ) as resp:
                                    if resp.status == 200:
                                        break
                            except OSError:
                                pass
                        self.assertIsNone(proc.poll(), "server exited early")
                        threading.Event().wait(0.05)
                    else:
                        self.fail("server or gateway never became ready")
                    with open(gw_pid_path) as f:
                        gw_pid = int(f.read().strip())
                    self.addCleanup(_kill_if_running, gw_pid)
                    # Let main_async finish registering signal handlers on old code
                    # so this test specifically exercises terminate -> kill.
                    threading.Event().wait(0.1)
                    proc.send_signal(signal.SIGTERM)
                    try:
                        proc.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                        self.fail("server still running 8 s after SIGTERM")
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait(timeout=5)
            with open(stderr_path) as f:
                stderr = f.read()
            self.assertEqual(proc.returncode, 0, stderr)
            self.assertIn("Shutting down", stderr)
            with self.assertRaises(
                ProcessLookupError,
                msg=f"gateway pid {gw_pid} still alive after server exit",
            ):
                os.kill(gw_pid, 0)
            self.assertIn("killing it", stderr)

    def test_sigterm_during_startup_stops_gateway(self):
        # SIGTERM arriving between spawning the gateway and registering signal
        # handlers used to kill Python without running finally, orphaning the
        # gateway.
        with tempfile.TemporaryDirectory() as tmp:
            gw_pid_path = os.path.join(tmp, "gw.pid")
            in_setup = os.path.join(tmp, "in_setup")
            release = os.path.join(tmp, "release")
            stderr_path = os.path.join(tmp, "stderr.log")
            gateway = os.path.join(tmp, "common_bag_ws_proxy.par")
            with open(gateway, "w") as f:
                f.write(
                    "#!/bin/sh\n"
                    f"echo $$ > {gw_pid_path}.tmp && mv {gw_pid_path}.tmp {gw_pid_path}\n"
                    "exec sleep 300\n"
                )
            os.chmod(gateway, 0o755)
            runner_code = (
                "import asyncio, os, sys\n"
                f"sys.path.insert(0, {os.path.dirname(main.__file__)!r})\n"
                "from aiohttp import web\n"
                "import main\n"
                f"main.COMMON_BAG_PROXY_PAR = {gateway!r}\n"
                "orig_setup = web.AppRunner.setup\n"
                "async def slow_setup(self):\n"
                f"    open({in_setup!r}, 'w').close()\n"
                "    for _ in range(500):\n"
                f"        if os.path.exists({release!r}):\n"
                "            break\n"
                "        await asyncio.sleep(0.02)\n"
                "    return await orig_setup(self)\n"
                "web.AppRunner.setup = slow_setup\n"
                "main.app.run(main.serve)\n"
            )
            env = {
                "HOME": tmp,
                "PATH": "/usr/bin:/bin",
                "NO_GCE_CHECK": "true",
                "PORT": "0",
            }
            with open(stderr_path, "w") as stderr_file:
                proc = subprocess.Popen(
                    [sys.executable, "-c", runner_code, "--common_bag_ws_port=1"],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=stderr_file,
                )
                gw_pid = None
                try:
                    for _ in range(200):
                        if os.path.exists(gw_pid_path) and os.path.exists(in_setup):
                            break
                        self.assertIsNone(proc.poll(), "server exited early")
                        threading.Event().wait(0.05)
                    else:
                        self.fail("server never reached AppRunner.setup with gateway")
                    with open(gw_pid_path) as f:
                        gw_pid = int(f.read().strip())
                    self.addCleanup(_kill_if_running, gw_pid)
                    proc.send_signal(signal.SIGTERM)
                    # Keep setup paused briefly so SIGTERM is delivered during setup.
                    threading.Event().wait(0.2)
                    open(release, "w").close()
                    try:
                        proc.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                        self.fail("server still running 8 s after startup SIGTERM")
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait(timeout=5)
            with open(stderr_path) as f:
                stderr = f.read()
            self.assertEqual(proc.returncode, 0, stderr)
            self.assertIn("Shutting down", stderr)
            self.assertNotIn("killing it", stderr)
            with self.assertRaises(
                ProcessLookupError,
                msg=f"gateway pid {gw_pid} still alive after startup SIGTERM",
            ):
                os.kill(gw_pid, 0)


def _kill_if_running(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class SessionManagerTest(unittest.IsolatedAsyncioTestCase):
    async def test_delete_only_removes_the_expected_record(self):
        manager = session_management.SessionManager()
        old = session_management.SessionBaseModel("s", "host")
        new = session_management.SessionBaseModel("s", "host")
        self.assertIs(await manager.add_unless_connected("s", old), old)
        self.assertTrue(await manager.release("s", old))
        self.assertIs(await manager.add_unless_connected("s", new), new)
        await manager.delete_item("s", old)
        self.assertIs(await manager.search_item("s"), new)
        await manager.delete_item("s", new)
        self.assertIsNone(await manager.search_item("s"))

    async def test_add_unless_connected_keeps_existing_pending_record(self):
        manager = session_management.SessionManager()
        first = session_management.SessionBaseModel("s", "host")
        first.fc_definitions = '{"functions": ["f"]}'
        second = session_management.SessionBaseModel("s", "host2")
        self.assertIs(await manager.add_unless_connected("s", first), first)
        self.assertIs(await manager.add_unless_connected("s", second), first)
        self.assertIs(await manager.search_item("s"), first)
        self.assertEqual(first.ws_host, "host2")
        self.assertEqual(first.fc_definitions, '{"functions": ["f"]}')

    async def test_delete_if_pending_skips_claimed_record(self):
        manager = session_management.SessionManager()
        record = session_management.SessionBaseModel("s", "host")
        self.assertIs(await manager.add_unless_connected("s", record), record)
        handler = mock.AsyncMock(spec=websocket_handler.WebsocketHandler)
        self.assertTrue(await manager.claim_websocket("s", record, handler))
        self.assertFalse(await manager.delete_if_pending("s", record))
        self.assertIs(await manager.search_item("s"), record)
        handler.end_websocket.assert_not_awaited()

        pending = session_management.SessionBaseModel("p", "host")
        self.assertIs(await manager.add_unless_connected("p", pending), pending)
        self.assertTrue(await manager.delete_if_pending("p", pending))
        self.assertIsNone(await manager.search_item("p"))

    async def test_claim_websocket_is_exclusive(self):
        manager = session_management.SessionManager()
        record = session_management.SessionBaseModel("s", "host")
        other = session_management.SessionBaseModel("s", "host")
        self.assertIs(await manager.add_unless_connected("s", record), record)
        handler = mock.Mock(spec=websocket_handler.WebsocketHandler)
        self.assertFalse(await manager.claim_websocket("s", other, handler))
        self.assertTrue(await manager.claim_websocket("s", record, handler))
        self.assertFalse(await manager.claim_websocket("s", record, handler))
        self.assertIsNone(await manager.add_unless_connected("s", other))
        self.assertIs(await manager.search_item("s"), record)

    async def test_session_limit(self):
        manager = session_management.SessionManager()
        a = session_management.SessionBaseModel("a", "host")
        b = session_management.SessionBaseModel("b", "host")
        self.assertIs(await manager.add_unless_connected("a", a, max_sessions=2), a)
        self.assertIs(await manager.add_unless_connected("b", b, max_sessions=2), b)
        c = session_management.SessionBaseModel("c", "host")
        with self.assertRaises(session_management.SessionLimitError):
            await manager.add_unless_connected("c", c, max_sessions=2)
        self.assertIsNone(await manager.search_item("c"))
        # A retry for a pending record keeps it and takes no extra slot.
        a2 = session_management.SessionBaseModel("a", "host")
        self.assertIs(await manager.add_unless_connected("a", a2, max_sessions=2), a)
        self.assertIs(await manager.search_item("a"), a)
        await manager.delete_item("b", b)
        self.assertIs(await manager.add_unless_connected("c", c, max_sessions=2), c)
        # A released record frees its slot without being ended.
        handler = mock.Mock(spec=websocket_handler.WebsocketHandler)
        self.assertTrue(await manager.claim_websocket("c", c, handler))
        self.assertTrue(await manager.release("c", c))
        self.assertFalse(await manager.release("c", c))
        handler.end_websocket.assert_not_called()
        b2 = session_management.SessionBaseModel("b", "host")
        self.assertIs(await manager.add_unless_connected("b", b2, max_sessions=2), b2)
        # Deleting it later still ends it, and leaves a newer "c" alone.
        c2 = session_management.SessionBaseModel("c", "host")
        await manager.delete_item("b", b2)
        self.assertIs(await manager.add_unless_connected("c", c2, max_sessions=2), c2)
        await manager.delete_item("c", c)
        handler.end_websocket.assert_awaited_once()
        self.assertIs(await manager.search_item("c"), c2)
        # 0 means no limit.
        d = session_management.SessionBaseModel("d", "host")
        self.assertIs(await manager.add_unless_connected("d", d), d)
        self.assertEqual(len(await manager.all_items()), 3)

    async def test_check_can_add(self):
        manager = session_management.SessionManager()
        await manager.check_can_add("a", 1)
        a = session_management.SessionBaseModel("a", "host")
        self.assertIs(await manager.add_unless_connected("a", a, max_sessions=1), a)
        with self.assertRaises(session_management.SessionLimitError):
            await manager.check_can_add("b", 1)
        # Its own ID fits, and 0 means no limit; nothing is stored.
        await manager.check_can_add("a", 1)
        await manager.check_can_add("b", 0)
        self.assertIsNone(await manager.search_item("b"))

    async def test_remove_pending_refuses_the_id_for_a_while(self):
        manager = session_management.SessionManager()
        now = 1000.0
        with (
            mock.patch.object(session_management.time, "monotonic", lambda: now),
            mock.patch.object(manager, "ABANDONED_ID_TTL_S", 10),
        ):
            # Removed or not yet added: both refuse a later add of the ID.
            a = session_management.SessionBaseModel("a", "host")
            self.assertIs(await manager.add_unless_connected("a", a), a)
            self.assertTrue(await manager.remove_pending("a"))
            self.assertFalse(await manager.remove_pending("b"))
            for session_id in ("a", "b"):
                with self.assertRaises(session_management.SessionAbandonedError):
                    await manager.check_can_add(session_id, 0)
                record = session_management.SessionBaseModel(session_id, "host")
                with self.assertRaises(session_management.SessionAbandonedError):
                    await manager.add_unless_connected(session_id, record)
                self.assertIsNone(await manager.search_item(session_id))

            # A connected record is left alone, and its ID isn't refused.
            c = session_management.SessionBaseModel("c", "host")
            self.assertIs(await manager.add_unless_connected("c", c), c)
            self.assertTrue(await manager.claim_websocket("c", c, mock.AsyncMock()))
            self.assertFalse(await manager.remove_pending("c"))
            self.assertIs(await manager.search_item("c"), c)
            await manager.check_can_add("c", 0)

            now += 10
            await manager.check_can_add("a", 0)
            await manager.check_can_add("b", 0)

    async def test_abandoned_ids_are_bounded(self):
        manager = session_management.SessionManager()
        with mock.patch.object(manager, "MAX_ABANDONED_IDS", 3):
            for i in range(5):
                await manager.remove_pending(f"id{i}")
            # The oldest are forgotten first.
            for i in (0, 1):
                await manager.check_can_add(f"id{i}", 0)
            for i in (2, 3, 4):
                with self.assertRaises(session_management.SessionAbandonedError):
                    await manager.check_can_add(f"id{i}", 0)
            # Abandoning an ID again makes it the newest.
            await manager.remove_pending("id2")
            await manager.remove_pending("id5")
            await manager.check_can_add("id3", 0)
            with self.assertRaises(session_management.SessionAbandonedError):
                await manager.check_can_add("id2", 0)


if __name__ == "__main__":
    unittest.main()
