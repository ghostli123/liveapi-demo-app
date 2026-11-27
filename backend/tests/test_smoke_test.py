"""Tests for scripts/smoke_test.py."""

import argparse
import asyncio
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

from absl.testing import flagsaver
import aiohttp
from aiohttp import test_utils, web

import main
import session_management
from test_main import ProductionTestServer

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts")
)
import smoke_test  # noqa: E402


def _make_args(server: str, **overrides) -> argparse.Namespace:
    defaults = dict(
        server=server,
        environment="autopush-common",
        location="us-central1",
        model="gemini-3.8-live",
        modality="TEXT",
        prompt="hi",
        timeout=5.0,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


class SmokeTestHelpersTest(unittest.TestCase):
    def test_is_turn_complete_handles_camel_and_snake_case(self):
        self.assertTrue(
            smoke_test.is_turn_complete({"serverContent": {"turnComplete": True}})
        )
        self.assertTrue(
            smoke_test.is_turn_complete({"server_content": {"turn_complete": True}})
        )
        self.assertTrue(
            smoke_test.is_turn_complete({"serverContent": {"turn_complete": True}})
        )
        self.assertTrue(
            smoke_test.is_turn_complete({"server_content": {"turnComplete": True}})
        )
        self.assertFalse(
            smoke_test.is_turn_complete({"serverContent": {"turnComplete": False}})
        )
        self.assertFalse(
            smoke_test.is_turn_complete({"server_content": {"turn_complete": False}})
        )
        self.assertFalse(smoke_test.is_turn_complete({"serverContent": None}))
        self.assertFalse(smoke_test.is_turn_complete({}))

    def test_summarize_handles_snake_case_and_null_transcription(self):
        stats = {
            "text": [],
            "transcript": [],
            "audio_chunks": 0,
            "audio_bytes": 0,
            "video_chunks": 0,
            "video_bytes": 0,
        }
        smoke_test.summarize(
            {
                "server_content": {
                    "model_turn": {
                        "parts": [
                            {"text": "hello"},
                            {"inline_data": {"mime_type": "audio/pcm", "data": "AAAA"}},
                            {
                                "inline_data": {
                                    "mime_type": "image/jpeg",
                                    "data": "BBBB",
                                }
                            },
                        ]
                    },
                    "output_transcription": {"text": "spoken"},
                    "outputTranscription": None,
                }
            },
            stats,
        )
        self.assertEqual(stats["text"], ["hello"])
        self.assertEqual(stats["transcript"], ["spoken"])
        self.assertEqual(stats["audio_chunks"], 1)
        self.assertEqual(stats["video_chunks"], 1)

    def test_summarize_handles_malformed_parts_and_uppercase_mimes(self):
        stats = {
            "text": [],
            "transcript": [],
            "audio_chunks": 0,
            "audio_bytes": 0,
            "video_chunks": 0,
            "video_bytes": 0,
        }
        cases = [
            {"serverContent": {"modelTurn": None}},
            {"serverContent": {"modelTurn": "not-a-dict"}},
            {"serverContent": {"modelTurn": {"parts": None}}},
            {"serverContent": {"modelTurn": {"parts": "not-a-list"}}},
            {
                "serverContent": {
                    "modelTurn": {
                        "parts": [
                            None,
                            "bad-part",
                            123,
                            {"text": None},
                            {"text": 42},
                            {"text": "ok"},
                            {"inlineData": "not-a-dict"},
                            {"inlineData": {"mimeType": "audio/pcm", "data": None}},
                            {"inlineData": {"mimeType": 123, "data": "AAAA"}},
                            {"inlineData": {"mimeType": "VIDEO/MP4", "data": "AAAA"}},
                            {
                                "inline_data": {
                                    "mime_type": "  IMAGE/JPEG; quality=90 ",
                                    "data": "BBBB",
                                }
                            },
                        ]
                    },
                    "outputTranscription": {"text": None},
                    "output_transcription": {"text": 999},
                }
            },
        ]
        for msg in cases:
            smoke_test.summarize(msg, stats)

        self.assertEqual(stats["text"], ["ok"])
        self.assertEqual(stats["transcript"], [])
        self.assertEqual(stats["audio_chunks"], 2)
        self.assertEqual(stats["audio_bytes"], 3)
        self.assertEqual(stats["video_chunks"], 2)
        self.assertEqual(stats["video_bytes"], 6)
        # Ensure printing stats["text"] / stats["transcript"] won't crash on join.
        self.assertEqual("".join(stats["text"]), "ok")
        self.assertEqual("".join(stats["transcript"]), "")

    def test_ws_url_converts_case_insensitive_schemes_and_rejects_invalid(self):
        for server, expected in [
            ("http://localhost:8080", "ws://localhost:8080/ws?session_id=s1"),
            ("HTTP://localhost:8080/", "ws://localhost:8080/ws?session_id=s1"),
            (
                "Https://example.com:8443/app/",
                "wss://example.com:8443/app/ws?session_id=s1",
            ),
            ("  HTTPS://http.example.com  ", "wss://http.example.com/ws?session_id=s1"),
            ("http://[::1]:8080/", "ws://[::1]:8080/ws?session_id=s1"),
            ("http://[::1]", "ws://[::1]/ws?session_id=s1"),
            ("http://[2001:db8::]", "ws://[2001:db8::]/ws?session_id=s1"),
        ]:
            with self.subTest(server=server):
                self.assertEqual(smoke_test._ws_url(server, "s1"), expected)

        for bad in [
            "",
            "localhost:8080",
            "ftp://localhost:8080",
            "ws://localhost:8080",
            "http://",
            "http://:8080",
            "http://localhost:",
            "http://localhost:/",
            "http://localhost:/app",
            "https://example.com:",
            "http://[::1]:",
            "http://[2001:db8::]:",
            "http://user:pass@localhost:",
            "http://localhost:0",
            "http://localhost:99999",
            "http://localhost:abc",
            "http://localhost:8080?x=1",
            "http://localhost:8080?",
            "http://localhost:8080#frag",
            "http://localhost:8080#",
            "http://localhost:8080/app?x=1",
            "http://localhost:8080/app#frag",
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    smoke_test._ws_url(bad, "s1")

    def test_validate_timeout_accepts_positive_finite_and_rejects_invalid(self):
        for good, expected in [(1, 1.0), (0.5, 0.5), (60.0, 60.0)]:
            with self.subTest(good=good):
                self.assertEqual(smoke_test._validate_timeout(good), expected)

        for bad in [
            0,
            0.0,
            -0.0,
            -5,
            float("nan"),
            float("inf"),
            float("-inf"),
            True,
            False,
            None,
            "5",
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    smoke_test._validate_timeout(bad)


class SmokeTestRunTest(unittest.IsolatedAsyncioTestCase):
    async def _start_app(self, app: web.Application) -> test_utils.TestServer:
        server = test_utils.TestServer(app)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        return server

    async def _run_captured(self, args: argparse.Namespace) -> tuple[int, str]:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = await smoke_test.run(args)
        return rc, buf.getvalue()

    async def test_plain_text_control_error_returns_1_without_crashing(self):
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.Response(status=403, text="Host evil.com is not allowed")

        app.router.add_post("/api/control", control)
        server = await self._start_app(app)

        rc, out = await self._run_captured(_make_args(str(server.make_url(""))))
        self.assertEqual(rc, 1)
        self.assertIn("control: HTTP 403 Host evil.com is not allowed", out)

    async def test_json_control_error_returns_1(self):
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.json_response({"error": "Server is busy"}, status=503)

        app.router.add_post("/api/control", control)
        server = await self._start_app(app)

        rc, out = await self._run_captured(_make_args(str(server.make_url(""))))
        self.assertEqual(rc, 1)
        self.assertIn("control: HTTP 503 {'error': 'Server is busy'}", out)

    async def test_non_json_200_control_response_returns_1(self):
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.Response(
                status=200, text="<html>Not an API</html>", content_type="text/html"
            )

        app.router.add_post("/api/control", control)
        server = await self._start_app(app)

        rc, out = await self._run_captured(_make_args(str(server.make_url(""))))
        self.assertEqual(rc, 1)
        self.assertIn("control: HTTP 200 <html>Not an API</html>", out)
        self.assertIn("FAIL: /api/control did not return a JSON object", out)

    async def test_non_object_json_200_control_response_returns_1(self):
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.json_response(["unexpected", "list"], status=200)

        app.router.add_post("/api/control", control)
        server = await self._start_app(app)

        rc, out = await self._run_captured(_make_args(str(server.make_url(""))))
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: /api/control did not return a JSON object", out)

    async def test_deeply_nested_and_overlong_int_control_responses_return_1(self):
        for label, status, payload, expected in [
            (
                "200 deeply nested json",
                200,
                "[" * 20000 + "]" * 20000,
                "FAIL: /api/control did not return a JSON object",
            ),
            (
                "200 overlong integer",
                200,
                "1" * 5000,
                "FAIL: /api/control did not return a JSON object",
            ),
            (
                "500 deeply nested json",
                500,
                "[" * 20000 + "]" * 20000,
                "control: HTTP 500 [[[",
            ),
            (
                "500 overlong integer",
                500,
                "1" * 5000,
                "control: HTTP 500 111",
            ),
        ]:
            with self.subTest(case=label):
                app = web.Application()

                async def control(
                    _request: web.Request, code: int = status, body: str = payload
                ) -> web.Response:
                    return web.Response(
                        status=code, text=body, content_type="application/json"
                    )

                app.router.add_post("/api/control", control)
                server = await self._start_app(app)

                rc, out = await self._run_captured(_make_args(str(server.make_url(""))))
                self.assertEqual(rc, 1, out)
                self.assertIn(expected, out)

    async def test_snake_case_turn_complete_passes_without_waiting_for_timeout(self):
        app = web.Application()
        ws_closed = asyncio.Event()

        async def control(_request: web.Request) -> web.Response:
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def ws_handler(request: web.Request) -> web.WebSocketResponse:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.receive_str()
            await ws.send_str(json.dumps({"setup_complete": {}}))
            await ws.receive_str()
            await ws.send_str(
                json.dumps(
                    {
                        "server_content": {
                            "model_turn": {"parts": [{"text": "snake hello"}]},
                            "turn_complete": True,
                        }
                    }
                )
            )
            # Keep the socket open until the client closes after turn_complete.
            async for _ in ws:
                pass
            ws_closed.set()
            return ws

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", ws_handler)
        server = await self._start_app(app)

        rc, out = await self._run_captured(
            _make_args(str(server.make_url("")), timeout=1.5)
        )
        self.assertEqual(rc, 0, out)
        self.assertIn("text: snake hello", out)
        self.assertIn("PASS", out)
        self.assertNotIn("timed out", out)
        await asyncio.wait_for(ws_closed.wait(), timeout=2.0)

    async def test_camel_case_turn_complete_passes(self):
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def ws_handler(request: web.Request) -> web.WebSocketResponse:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.receive_str()
            await ws.send_str(json.dumps({"setupComplete": {}}))
            await ws.receive_str()
            await ws.send_str(
                json.dumps(
                    {
                        "serverContent": {
                            "modelTurn": {"parts": [{"text": "camel hello"}]},
                            "turnComplete": True,
                        }
                    }
                )
            )
            async for _ in ws:
                pass
            return ws

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", ws_handler)
        server = await self._start_app(app)

        rc, out = await self._run_captured(
            _make_args(str(server.make_url("")), timeout=1.5)
        )
        self.assertEqual(rc, 0, out)
        self.assertIn("text: camel hello", out)
        self.assertIn("PASS", out)

    async def test_real_backend_host_rejection_403_prints_error_and_returns_1(self):
        main.SESSION_MANAGER = session_management.SessionManager()
        with mock.patch.object(
            main, "_is_allowed_host", new=mock.AsyncMock(return_value=False)
        ):
            server = ProductionTestServer(await main.create_app())
            await server.start_server()
            self.addAsyncCleanup(server.close)

            rc, out = await self._run_captured(_make_args(str(server.make_url(""))))
            self.assertEqual(rc, 1)
            self.assertIn("control: HTTP 403", out)
            self.assertIn("is not allowed", out)

    async def test_malformed_and_non_object_ws_frames_return_1_without_crashing(self):
        for label, frame, expected in [
            ("invalid json", "not-json{", "FAIL: received non-JSON text frame"),
            (
                "deeply nested json",
                "[" * 20000 + "]" * 20000,
                "FAIL: received non-JSON text frame",
            ),
            (
                "overlong integer",
                "1" * 5000,
                "FAIL: received non-JSON text frame",
            ),
            (
                "json list",
                '["unexpected"]',
                "FAIL: received non-object JSON frame: list",
            ),
            ("json null", "null", "FAIL: received non-object JSON frame: NoneType"),
            ("json number", "42", "FAIL: received non-object JSON frame: int"),
        ]:
            with self.subTest(case=label):
                app = web.Application()

                async def control(_request: web.Request) -> web.Response:
                    return web.json_response(
                        {"status": "ok", "project_id": "test-proj"}
                    )

                async def ws_handler(
                    request: web.Request, payload: str = frame
                ) -> web.WebSocketResponse:
                    ws = web.WebSocketResponse()
                    await ws.prepare(request)
                    await ws.receive_str()
                    await ws.send_str(payload)
                    async for _ in ws:
                        pass
                    return ws

                app.router.add_post("/api/control", control)
                app.router.add_get("/ws", ws_handler)
                server = await self._start_app(app)

                rc, out = await self._run_captured(
                    _make_args(str(server.make_url("")), timeout=1.5)
                )
                self.assertEqual(rc, 1, out)
                self.assertIn(expected, out)

    async def test_uppercase_http_server_scheme_connects_and_passes(self):
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def ws_handler(request: web.Request) -> web.WebSocketResponse:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.receive_str()
            await ws.send_str(json.dumps({"setupComplete": {}}))
            await ws.receive_str()
            await ws.send_str(
                json.dumps(
                    {
                        "serverContent": {
                            "modelTurn": {
                                "parts": [
                                    {"text": None},
                                    {"text": "upper ok"},
                                    {
                                        "inlineData": {
                                            "mimeType": "VIDEO/MP4",
                                            "data": "AAAA",
                                        }
                                    },
                                ]
                            },
                            "turnComplete": True,
                        }
                    }
                )
            )
            async for _ in ws:
                pass
            return ws

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", ws_handler)
        server = await self._start_app(app)

        upper_url = str(server.make_url("")).replace("http://", "HTTP://", 1)
        seen_ws_urls: list[str] = []
        orig_ws_connect = smoke_test.aiohttp.ClientSession.ws_connect

        def spy_ws_connect(session, url, *args, **kwargs):
            seen_ws_urls.append(url)
            return orig_ws_connect(session, url, *args, **kwargs)

        with mock.patch.object(
            smoke_test.aiohttp.ClientSession, "ws_connect", new=spy_ws_connect
        ):
            rc, out = await self._run_captured(_make_args(upper_url, timeout=1.5))
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(seen_ws_urls), 1)
        self.assertTrue(seen_ws_urls[0].startswith("ws://"), seen_ws_urls[0])
        self.assertIn("text: upper ok", out)
        self.assertIn("video: 1 chunks / 3 B", out)
        self.assertIn("PASS", out)

    async def test_invalid_server_scheme_returns_1_without_crashing(self):
        rc, out = await self._run_captured(_make_args("ftp://localhost:8080"))
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: --server must be an http:// or https:// URL", out)

    async def test_server_with_trailing_empty_port_returns_1_without_request(self):
        with mock.patch.object(smoke_test.aiohttp, "ClientSession") as session_cls:
            for bad in ("http://localhost:", "http://localhost:/app", "http://[::1]:"):
                with self.subTest(bad=bad):
                    rc, out = await self._run_captured(_make_args(bad))
                    self.assertEqual(rc, 1, out)
                    self.assertIn("FAIL: --server has an invalid port", out)
            session_cls.assert_not_called()

    async def test_server_with_query_or_fragment_returns_1_without_request(self):
        called = False
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            nonlocal called
            called = True
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        app.router.add_post("/api/control", control)
        server = await self._start_app(app)
        base = str(server.make_url("")).rstrip("/")

        for suffix in ("?x=1", "?", "#frag", "#", "?x=1/"):
            with self.subTest(suffix=suffix):
                rc, out = await self._run_captured(_make_args(f"{base}{suffix}"))
                self.assertEqual(rc, 1, out)
                self.assertIn(
                    "FAIL: --server must not include a query or fragment", out
                )
        self.assertFalse(called)

    async def test_invalid_timeout_returns_1_without_request(self):
        called = False
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            nonlocal called
            called = True
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        app.router.add_post("/api/control", control)
        server = await self._start_app(app)
        base = str(server.make_url(""))

        for bad_timeout in (
            float("nan"),
            float("inf"),
            float("-inf"),
            0,
            -1.0,
            True,
            None,
        ):
            with self.subTest(timeout=bad_timeout):
                rc, out = await self._run_captured(
                    _make_args(base, timeout=bad_timeout)
                )
                self.assertEqual(rc, 1, out)
                self.assertIn("FAIL: --timeout must be a finite positive number", out)
        self.assertFalse(called)

    async def test_missing_or_invalid_project_id_fails_for_vertex_environment(self):
        for label, payload in [
            ("missing", {"status": "ok"}),
            ("null", {"status": "ok", "project_id": None}),
            ("empty", {"status": "ok", "project_id": ""}),
            ("whitespace", {"status": "ok", "project_id": "   "}),
            ("int", {"status": "ok", "project_id": 123}),
            ("bool", {"status": "ok", "project_id": True}),
            ("list", {"status": "ok", "project_id": ["p"]}),
        ]:
            with self.subTest(case=label):
                ws_called = False
                control_calls: list[dict] = []
                app = web.Application()

                async def control(
                    request: web.Request,
                    body: dict = payload,
                    calls: list[dict] = control_calls,
                ) -> web.Response:
                    req_body = await request.json()
                    calls.append(req_body)
                    if req_body.get("command") == "disconnect":
                        return web.json_response({"removed": True})
                    return web.json_response(body)

                async def ws_handler(request: web.Request) -> web.WebSocketResponse:
                    nonlocal ws_called
                    ws_called = True
                    ws = web.WebSocketResponse()
                    await ws.prepare(request)
                    return ws

                app.router.add_post("/api/control", control)
                app.router.add_get("/ws", ws_handler)
                server = await self._start_app(app)

                rc, out = await self._run_captured(
                    _make_args(
                        str(server.make_url("")),
                        environment="prod",
                        timeout=1.5,
                    )
                )
                self.assertEqual(rc, 1, out)
                self.assertIn(
                    "FAIL: /api/control did not return a valid project_id", out
                )
                self.assertFalse(ws_called)
                self.assertEqual(
                    [c.get("command") for c in control_calls],
                    ["connect", "disconnect"],
                )
                self.assertEqual(
                    control_calls[0].get("session_id"),
                    control_calls[1].get("session_id"),
                )

    async def test_invalid_project_id_releases_real_backend_session_slot(self):
        main.SESSION_MANAGER = session_management.SessionManager()
        with (
            flagsaver.flagsaver(max_sessions=1),
            mock.patch.object(
                main, "initialize_gemini_chat_session", return_value=None
            ),
            mock.patch.object(
                main,
                "_session_initialized_response",
                side_effect=lambda: web.json_response(
                    {"status": "ok", "project_id": ""}
                ),
            ),
        ):
            server = ProductionTestServer(await main.create_app())
            await server.start_server()
            self.addAsyncCleanup(server.close)

            rc, out = await self._run_captured(
                _make_args(
                    str(server.make_url("")),
                    environment="prod",
                    timeout=1.5,
                )
            )
            self.assertEqual(rc, 1, out)
            self.assertIn("FAIL: /api/control did not return a valid project_id", out)

            # With max_sessions=1, a fresh connect succeeds only if smoke_test
            # released its pending session before exiting.
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    str(server.make_url("/api/control")),
                    json={
                        "command": "connect",
                        "session_id": "follow-up-session",
                        "endpoint": "aiplatform.googleapis.com",
                        "location": "us-central1",
                    },
                ) as resp:
                    self.assertEqual(resp.status, 200, await resp.text())

    async def test_timeout_bounds_blackhole_control_request(self):
        release = asyncio.Event()

        async def blackhole(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            try:
                await reader.read(4096)
                await release.wait()
            finally:
                writer.close()
                await writer.wait_closed()

        tcp_server = await asyncio.start_server(blackhole, "127.0.0.1", 0)
        port = tcp_server.sockets[0].getsockname()[1]

        async def cleanup() -> None:
            release.set()
            tcp_server.close()
            await tcp_server.wait_closed()

        self.addAsyncCleanup(cleanup)

        rc, out = await asyncio.wait_for(
            self._run_captured(_make_args(f"http://127.0.0.1:{port}", timeout=0.3)),
            timeout=5.0,
        )
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: /api/control timed out after 0.3s", out)

    async def test_timeout_bounds_ws_connect_and_releases_pending_session(self):
        release = asyncio.Event()
        self.addCleanup(release.set)
        control_calls: list[dict] = []
        app = web.Application()

        async def control(request: web.Request) -> web.Response:
            body = await request.json()
            control_calls.append(body)
            if body.get("command") == "disconnect":
                return web.json_response({"removed": True})
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def hang_ws(_request: web.Request) -> web.Response:
            await release.wait()
            return web.Response(status=500)

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", hang_ws)
        server = await self._start_app(app)

        rc, out = await asyncio.wait_for(
            self._run_captured(_make_args(str(server.make_url("")), timeout=0.6)),
            timeout=5.0,
        )
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: /ws connect timed out after 0.6s", out)
        self.assertEqual(
            [c.get("command") for c in control_calls], ["connect", "disconnect"]
        )
        self.assertEqual(
            control_calls[0].get("session_id"), control_calls[1].get("session_id")
        )

    async def test_ws_connect_error_releases_pending_session(self):
        control_calls: list[dict] = []
        app = web.Application()

        async def control(request: web.Request) -> web.Response:
            body = await request.json()
            control_calls.append(body)
            if body.get("command") == "disconnect":
                return web.json_response({"removed": True})
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def failing_ws(_request: web.Request) -> web.Response:
            return web.Response(status=500, text="upgrade failed")

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", failing_ws)
        server = await self._start_app(app)

        with self.assertRaises(aiohttp.WSServerHandshakeError):
            await self._run_captured(_make_args(str(server.make_url("")), timeout=1.5))

        self.assertEqual(
            [c.get("command") for c in control_calls], ["connect", "disconnect"]
        )
        self.assertEqual(
            control_calls[0].get("session_id"), control_calls[1].get("session_id")
        )

    async def test_timeout_bounds_unresponsive_ws_close_after_turn_complete(self):
        release = asyncio.Event()
        self.addCleanup(release.set)
        app = web.Application()

        async def control(_request: web.Request) -> web.Response:
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def silent_close_ws(request: web.Request) -> web.WebSocketResponse:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.receive_str()
            await ws.send_str(json.dumps({"setupComplete": {}}))
            await ws.receive_str()
            await ws.send_str(
                json.dumps(
                    {
                        "serverContent": {
                            "modelTurn": {"parts": [{"text": "done"}]},
                            "turnComplete": True,
                        }
                    }
                )
            )
            # Stay idle without reading the client's close frame.
            await release.wait()
            return ws

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", silent_close_ws)
        server = await self._start_app(app)

        rc, out = await asyncio.wait_for(
            self._run_captured(_make_args(str(server.make_url("")), timeout=1.0)),
            timeout=5.0,
        )
        self.assertEqual(rc, 0, out)
        self.assertIn("text: done", out)
        self.assertIn("PASS", out)
        self.assertNotIn("timed out", out)

    async def test_timeout_during_ws_receive_prints_stats_without_disconnect(self):
        release = asyncio.Event()
        self.addCleanup(release.set)
        control_calls: list[dict] = []
        app = web.Application()

        async def control(request: web.Request) -> web.Response:
            body = await request.json()
            control_calls.append(body)
            return web.json_response({"status": "ok", "project_id": "test-proj"})

        async def stalled_ws(request: web.Request) -> web.WebSocketResponse:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.receive_str()
            await ws.send_str(json.dumps({"setupComplete": {}}))
            await ws.receive_str()
            await release.wait()
            return ws

        app.router.add_post("/api/control", control)
        app.router.add_get("/ws", stalled_ws)
        server = await self._start_app(app)

        rc, out = await asyncio.wait_for(
            self._run_captured(_make_args(str(server.make_url("")), timeout=1.0)),
            timeout=5.0,
        )
        self.assertEqual(rc, 1, out)
        self.assertIn("timed out after 1.0s", out)
        self.assertIn("audio: 0 chunks / 0 B", out)
        self.assertIn("FAIL: no turnComplete", out)
        self.assertEqual([c.get("command") for c in control_calls], ["connect"])

    async def test_trimmed_project_id_for_vertex_and_optional_for_common_bag(self):
        for env, control_body, expected_model in [
            (
                "prod",
                {"status": "ok", "project_id": "  my-proj  "},
                "projects/my-proj/locations/us-central1/publishers/google/models/gemini-3.8-live",
            ),
            (
                "autopush-common",
                {"status": "ok"},
                "models/gemini-3.8-live",
            ),
        ]:
            with self.subTest(environment=env):
                seen_models: list[str] = []
                app = web.Application()

                async def control(
                    _request: web.Request, body: dict = control_body
                ) -> web.Response:
                    return web.json_response(body)

                async def ws_handler(
                    request: web.Request, models: list[str] = seen_models
                ) -> web.WebSocketResponse:
                    ws = web.WebSocketResponse()
                    await ws.prepare(request)
                    setup = json.loads(await ws.receive_str())
                    models.append(setup["setup"]["model"])
                    await ws.send_str(json.dumps({"setupComplete": {}}))
                    await ws.receive_str()
                    await ws.send_str(
                        json.dumps(
                            {
                                "serverContent": {
                                    "modelTurn": {"parts": [{"text": "ok"}]},
                                    "turnComplete": True,
                                }
                            }
                        )
                    )
                    async for _ in ws:
                        pass
                    return ws

                app.router.add_post("/api/control", control)
                app.router.add_get("/ws", ws_handler)
                server = await self._start_app(app)

                rc, out = await self._run_captured(
                    _make_args(
                        str(server.make_url("")),
                        environment=env,
                        timeout=1.5,
                    )
                )
                self.assertEqual(rc, 0, out)
                self.assertEqual(seen_models, [expected_model])
                self.assertIn("PASS", out)


if __name__ == "__main__":
    unittest.main()
