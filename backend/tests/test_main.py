import asyncio
import base64
import concurrent.futures
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

import aiohttp
from aiohttp import test_utils, web
from absl import flags
from absl.testing import flagsaver
import websockets

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
            "*",
            "googleapis.com/x",
            "a..b.com",
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
                " .Example.ORG. ",
                "",
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

    async def test_unparsable_host_and_origin_rejected(self):
        body = {
            "command": "connect",
            "session_id": "s22",
            "endpoint": "autopush-common",
            "location": "us-central1",
        }
        # urlsplit raises on an unclosed IPv6 bracket; that used to be a 500.
        for headers, status in (({"Host": "["}, 400), ({"Origin": "http://["}, 403)):
            resp = await self.client.post("/api/control", json=body, headers=headers)
            self.assertEqual(resp.status, status, headers)
            resp = await self.client.get("/ws?session_id=s22", headers=headers)
            self.assertEqual(resp.status, status, headers)
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
                # The expiry check has run, rather than a sleep that a slow
                # machine could end before it.
                assert record is not None and record.expiry_task is not None
                await asyncio.wait_for(record.expiry_task, 5)
                self.assertIs(await main.SESSION_MANAGER.search_item("s6"), record)
                await ws.send_str("ping")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(json.loads(msg.data), {"echo": "ping"})
                await ws.close()

    async def test_control_retry_cannot_replace_a_connected_session(self):
        # /api/control checked for a WebSocket, awaited the simulator's init,
        # then replaced the record, so a /ws arriving during that await was
        # attached to a record nobody tracked and a second /ws was allowed.
        async with FakeUpstream() as upstream:
            with flagsaver.flagsaver(common_bag_ws_port=upstream.port):
                await self.connect_session("s23")
                first = await main.SESSION_MANAGER.search_item("s23")
                init_started, release = threading.Event(), threading.Event()

                def slow_init():
                    init_started.set()
                    release.wait(5)
                    raise RuntimeError("no creds")

                try:
                    with mock.patch.object(
                        main, "initialize_gemini_chat_session", side_effect=slow_init
                    ):
                        retry = asyncio.create_task(self.connect_session("s23"))
                        self.assertTrue(await asyncio.to_thread(init_started.wait, 5))
                        ws = await self.client.ws_connect("/ws?session_id=s23")
                        await ws.send_str("ping")
                        await asyncio.wait_for(ws.receive(), 5)
                        release.set()
                        status, body = await retry
                finally:
                    release.set()
                self.assertEqual(status, 409, body)
                self.assertIs(await main.SESSION_MANAGER.search_item("s23"), first)
                with self.assertRaises(aiohttp.WSServerHandshakeError) as cm:
                    await self.client.ws_connect("/ws?session_id=s23")
                self.assertEqual(cm.exception.status, 409)
                await ws.close()
                await self.wait_for_session_end("s23")

    async def test_control_retry_replaces_a_pending_session(self):
        with mock.patch.object(main, "PENDING_SESSION_TTL_S", 0.5):
            await self.connect_session("s24")
        first = await main.SESSION_MANAGER.search_item("s24")
        status, body = await self.connect_session("s24")
        self.assertEqual(status, 200, body)
        second = await main.SESSION_MANAGER.search_item("s24")
        self.assertIsNot(second, first)
        assert first is not None and first.expiry_task is not None
        await asyncio.sleep(0)
        self.assertTrue(first.expiry_task.cancelled())
        # The first record's expiry time passes; the second record stays.
        await asyncio.sleep(0.8)
        self.assertIs(await main.SESSION_MANAGER.search_item("s24"), second)

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
                # A retry for the pending session still fits and still inits.
                status, body = await self.connect_session("s28")
                self.assertEqual(status, 200, body)
                init.assert_called_once()

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
        self.assertEqual(json.loads(second.data), {"echo": "second"})
        self.assertEqual(upstream.received, ["setup", "second"])

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
                mock.patch.object(websocket_handler, "MAX_PENDING_CLIENT_BYTES", 1000),
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
        self.assertEqual(upstream.received, ["x" * 600, "y" * 400])
        self.assertEqual(len(upstream.close_codes), 1)

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
            allowed_hosts=["demo.example:8443", "web.example:443", "any.example"]
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
                ("http://web.example", 403),
                ("https://web.example:8443", 403),
                ("https://any.example:6666", 200),
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
            "demo.example:99999",
            "https://demo.example",
            "demo.example/app",
            "user@demo.example",
            "demo example",
            ":8443",
        ]:
            with self.assertRaises(flags.IllegalFlagValueError, msg=entry):
                with flagsaver.flagsaver(allowed_hosts=["demo.example.com", entry]):
                    pass
        with flagsaver.flagsaver(allowed_hosts=["myhost", "[::1]:8080", "*", ""]):
            self.assertEqual(
                main.explicitly_allowed_hosts(), frozenset({"myhost", "::1", "*"})
            )

    def test_server_refuses_to_start_with_invalid_allowed_hosts(self):
        result = subprocess.run(
            [
                sys.executable,
                os.path.join(os.path.dirname(main.__file__), "main.py"),
                "--allowed_hosts=demo.example,[",
            ],
            env={**os.environ, "PORT": "0"},
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--allowed_hosts", result.stderr)
        self.assertIn("invalid entry '['", result.stderr)
        self.assertNotIn("Serving on", result.stderr)

    def test_is_allowed_host(self):
        for host in ["localhost", "127.0.0.1", "::1", "10.1.2.3", "app.localhost"]:
            self.assertTrue(main.is_allowed_host(host), host)
        for host in ["evil.example", "", None, "foo.run.app"]:
            self.assertFalse(main.is_allowed_host(host), host)
        with mock.patch.dict("os.environ", {"K_SERVICE": "demo"}):
            self.assertTrue(main.is_allowed_host("demo-abc123-uc.a.run.app"))

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
        popen = mock.patch.object(main.subprocess, "Popen", return_value=self.gateway)
        self.popen = popen.start()
        self.addCleanup(popen.stop)
        for patcher in [
            mock.patch.object(main, "COMMON_BAG_PROXY_PAR", gateway.name),
            mock.patch.object(
                main.get_credentials, "get_access_token", return_value="token"
            ),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_gateway_stopped_when_port_is_in_use(self):
        with socket.socket() as busy:
            busy.bind(("", 0))
            busy.listen()
            port = busy.getsockname()[1]
            with mock.patch.dict("os.environ", {"PORT": str(port)}):
                with self.assertRaises(OSError):
                    await main.main_async()
        self.popen.assert_called_once()
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
        self.assertTrue(await manager.add_unless_connected("s", old))
        self.assertTrue(await manager.add_unless_connected("s", new))
        await manager.delete_item("s", old)
        self.assertIs(await manager.search_item("s"), new)
        await manager.delete_item("s", new)
        self.assertIsNone(await manager.search_item("s"))

    async def test_claim_websocket_is_exclusive(self):
        manager = session_management.SessionManager()
        record = session_management.SessionBaseModel("s", "host")
        other = session_management.SessionBaseModel("s", "host")
        await manager.add_unless_connected("s", record)
        handler = mock.Mock(spec=websocket_handler.WebsocketHandler)
        self.assertFalse(await manager.claim_websocket("s", other, handler))
        self.assertTrue(await manager.claim_websocket("s", record, handler))
        self.assertFalse(await manager.claim_websocket("s", record, handler))
        self.assertFalse(await manager.add_unless_connected("s", other))
        self.assertIs(await manager.search_item("s"), record)

    async def test_session_limit(self):
        manager = session_management.SessionManager()
        a = session_management.SessionBaseModel("a", "host")
        b = session_management.SessionBaseModel("b", "host")
        self.assertTrue(await manager.add_unless_connected("a", a, max_sessions=2))
        self.assertTrue(await manager.add_unless_connected("b", b, max_sessions=2))
        c = session_management.SessionBaseModel("c", "host")
        with self.assertRaises(session_management.SessionLimitError):
            await manager.add_unless_connected("c", c, max_sessions=2)
        self.assertIsNone(await manager.search_item("c"))
        # A retry replacing a pending record takes no extra slot.
        a2 = session_management.SessionBaseModel("a", "host")
        self.assertTrue(await manager.add_unless_connected("a", a2, max_sessions=2))
        await manager.delete_item("b", b)
        self.assertTrue(await manager.add_unless_connected("c", c, max_sessions=2))
        # A released record frees its slot without being ended.
        handler = mock.Mock(spec=websocket_handler.WebsocketHandler)
        self.assertTrue(await manager.claim_websocket("c", c, handler))
        self.assertTrue(await manager.release("c", c))
        self.assertFalse(await manager.release("c", c))
        handler.end_websocket.assert_not_called()
        b2 = session_management.SessionBaseModel("b", "host")
        self.assertTrue(await manager.add_unless_connected("b", b2, max_sessions=2))
        # Deleting it later still ends it, and leaves a newer "c" alone.
        c2 = session_management.SessionBaseModel("c", "host")
        await manager.delete_item("b", b2)
        self.assertTrue(await manager.add_unless_connected("c", c2, max_sessions=2))
        await manager.delete_item("c", c)
        handler.end_websocket.assert_awaited_once()
        self.assertIs(await manager.search_item("c"), c2)
        # 0 means no limit.
        d = session_management.SessionBaseModel("d", "host")
        self.assertTrue(await manager.add_unless_connected("d", d))
        self.assertEqual(len(await manager.all_items()), 3)

    async def test_check_can_add(self):
        manager = session_management.SessionManager()
        await manager.check_can_add("a", 1)
        a = session_management.SessionBaseModel("a", "host")
        self.assertTrue(await manager.add_unless_connected("a", a, max_sessions=1))
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
            self.assertTrue(await manager.add_unless_connected("a", a))
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
            self.assertTrue(await manager.add_unless_connected("c", c))
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
