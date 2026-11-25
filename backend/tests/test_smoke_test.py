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


if __name__ == "__main__":
    unittest.main()
