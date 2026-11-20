import asyncio
import json
import unittest
from unittest import mock

import aiohttp
from aiohttp import test_utils
from absl.testing import flagsaver
import websockets

import main
import session_management


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


class FakeUpstream:
    """A local stand-in for the Live API, reached through the common BAG route."""

    def __init__(self):
        self.received = []
        self.server = None

    async def handler(self, connection):
        async for message in connection:
            self.received.append(message)
            if message == "close-please":
                await connection.close(code=1008, reason="Quota exceeded")
                return
            # The Live API sends JSON in binary frames.
            await connection.send(json.dumps({"echo": message}).encode())

    async def __aenter__(self):
        self.server = await websockets.serve(self.handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc_info):
        self.server.close()
        await self.server.wait_closed()


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main.SESSION_MANAGER = session_management.SessionManager()
        self.client = test_utils.TestClient(
            test_utils.TestServer(await main.create_app())
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
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s1"))

    async def test_upstream_unreachable_closes_with_reason(self):
        async with FakeUpstream() as upstream:
            unused_port = upstream.port
        with flagsaver.flagsaver(common_bag_ws_port=unused_port):
            await self.connect_session("s2")
            ws = await self.client.ws_connect("/ws?session_id=s2")
            msg = await asyncio.wait_for(ws.receive(), 5)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(msg.data, 1011)
        self.assertTrue(msg.extra)

    async def test_ws_requires_known_session(self):
        resp = await self.client.get("/ws?session_id=unknown")
        self.assertEqual(resp.status, 404)
        resp = await self.client.get("/ws")
        self.assertEqual(resp.status, 400)

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

    async def test_fr_endpoint_reports_unavailable_simulator(self):
        await self.connect_session("s4")
        resp = await self.client.post(
            "/api/post_endpoint",
            json={"session_id": "s4", "objective": "fr_generate", "functionName": "f"},
        )
        self.assertEqual(resp.status, 503)
        self.assertIn("no creds", (await resp.json())["error"])

        resp = await self.client.post(
            "/api/post_endpoint",
            json={"session_id": "nope", "objective": "fr_generate"},
        )
        self.assertEqual(resp.status, 404)

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
        with mock.patch.object(main, "PENDING_SESSION_TTL_S", 0.05):
            await self.connect_session("s5")
            self.assertIsNotNone(await main.SESSION_MANAGER.search_item("s5"))
            await asyncio.sleep(0.2)
        self.assertIsNone(await main.SESSION_MANAGER.search_item("s5"))

    async def test_connected_session_does_not_expire(self):
        async with FakeUpstream() as upstream:
            with (
                flagsaver.flagsaver(common_bag_ws_port=upstream.port),
                mock.patch.object(main, "PENDING_SESSION_TTL_S", 0.05),
            ):
                await self.connect_session("s6")
                ws = await self.client.ws_connect("/ws?session_id=s6")
                await asyncio.sleep(0.2)
                self.assertIsNotNone(await main.SESSION_MANAGER.search_item("s6"))
                await ws.send_str("ping")
                msg = await asyncio.wait_for(ws.receive(), 5)
                self.assertEqual(json.loads(msg.data), {"echo": "ping"})
                await ws.close()

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

    async def test_static_files_revalidate(self):
        resp = await self.client.get("/frontend/script.js")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Cache-Control"], "no-cache")
        resp = await self.client.get("/healthz")
        self.assertEqual(await resp.text(), "ok")


if __name__ == "__main__":
    unittest.main()
