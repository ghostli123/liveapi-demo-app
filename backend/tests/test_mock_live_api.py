"""Sessions through the proxy to scripts/mock_live_api.py, shaped like the browser's."""

import asyncio
import base64
import json
import os
import sys
import unittest
from unittest import mock

import aiohttp
from aiohttp import test_utils
from absl.testing import flagsaver
import websockets

import main
import session_management
from test_main import ProductionTestServer

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts")
)
import mock_live_api  # noqa: E402

TIMEOUT_S = 5


def setup_message(modalities=("AUDIO",), **extra):
    return {
        "setup": {
            "model": "models/live_avatar_v2_rev25_rc2",
            "generation_config": {"response_modalities": list(modalities)},
            "output_audio_transcription": {},
            **extra,
        }
    }


def text_turn(text):
    return {
        "client_content": {
            "turns": [{"role": "user", "parts": [{"text": text}]}],
            "turn_complete": True,
        }
    }


class MockLiveApiTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main.SESSION_MANAGER = session_management.SessionManager()
        self.upstream = await mock_live_api.MockLiveApi().start()
        self.addAsyncCleanup(self.upstream.stop)
        saver = flagsaver.flagsaver(common_bag_ws_port=self.upstream.port)
        saver.__enter__()
        self.addCleanup(saver.__exit__, None, None, None)
        patcher = mock.patch.object(
            main, "initialize_gemini_chat_session", side_effect=RuntimeError("no creds")
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = test_utils.TestClient(
            ProductionTestServer(await main.create_app())
        )
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.session_count = 0

    async def open_session(self, setup):
        """Connects like the browser and returns the WebSocket after setupComplete."""
        self.session_count += 1
        session_id = f"mock-{self.session_count}"
        resp = await self.client.post(
            "/api/control",
            json={
                "command": "connect",
                "session_id": session_id,
                "endpoint": "autopush-common",
                "location": "us-central1",
            },
        )
        self.assertEqual(resp.status, 200, await resp.text())
        ws = await self.client.ws_connect(f"/ws?session_id={session_id}")
        await ws.send_json(setup)
        self.assertEqual(await self.receive(ws), {"setupComplete": {}})
        return ws

    async def receive(self, ws):
        msg = await asyncio.wait_for(ws.receive(), TIMEOUT_S)
        # The mock sends binary frames, like the Live API; the proxy relays
        # them to the browser as text.
        self.assertEqual(msg.type, aiohttp.WSMsgType.TEXT, msg)
        return json.loads(msg.data)

    async def receive_turn(self, ws):
        """Messages up to turnComplete, and the resumption update after it."""
        messages = []
        while True:
            message = await self.receive(ws)
            messages.append(message)
            if message.get("serverContent", {}).get("turnComplete"):
                break
        return messages

    @staticmethod
    def transcript(messages):
        return "".join(
            m["serverContent"].get("outputTranscription", {}).get("text", "")
            for m in messages
            if "serverContent" in m
        )

    async def test_audio_turn(self):
        ws = await self.open_session(setup_message())
        await ws.send_json(text_turn("Hello there"))
        messages = await self.receive_turn(ws)
        chunks = [
            part["inlineData"]
            for m in messages
            for part in m.get("serverContent", {}).get("modelTurn", {}).get("parts", [])
        ]
        self.assertEqual(len(chunks), mock_live_api.REPLY_AUDIO_CHUNKS)
        for chunk in chunks:
            self.assertEqual(chunk["mimeType"], "audio/pcm;rate=24000")
            # 100 ms of 16-bit mono samples.
            self.assertEqual(len(base64.b64decode(chunk["data"])), 4800)
        self.assertEqual(self.transcript(messages), "You said: Hello there")
        self.assertTrue(any("usageMetadata" in m for m in messages))
        self.assertEqual(
            self.upstream.setups[0]["model"], "models/live_avatar_v2_rev25_rc2"
        )
        await ws.close()

    async def test_text_turn(self):
        ws = await self.open_session(setup_message(["TEXT"]))
        await ws.send_json(text_turn("Hi"))
        messages = await self.receive_turn(ws)
        self.assertEqual(
            messages[0],
            {"serverContent": {"modelTurn": {"parts": [{"text": "You said: Hi"}]}}},
        )
        await ws.close()

    async def test_resumption_restores_the_conversation(self):
        ws = await self.open_session(setup_message(session_resumption={}))
        await ws.send_json(text_turn("My favorite fruit is mango."))
        await self.receive_turn(ws)
        update = await self.receive(ws)
        handle = update["sessionResumptionUpdate"]["newHandle"]
        await ws.close()

        ws = await self.open_session(
            setup_message(session_resumption={"handle": handle})
        )
        await ws.send_json(text_turn("What is my favorite fruit?"))
        self.assertIn(
            "Earlier you said: My favorite fruit is mango.",
            self.transcript(await self.receive_turn(ws)),
        )
        await ws.close()

        # Without the handle, the conversation starts over.
        ws = await self.open_session(setup_message(session_resumption={}))
        await ws.send_json(text_turn("What is my favorite fruit?"))
        self.assertEqual(
            self.transcript(await self.receive_turn(ws)),
            "You said: What is my favorite fruit?",
        )
        await ws.close()

    async def test_function_call(self):
        tools = [{"function_declarations": [{"name": "get_weather"}]}]
        ws = await self.open_session(setup_message(tools=tools))
        await ws.send_json(text_turn("Call get_weather for Paris"))
        call = (await self.receive(ws))["toolCall"]["functionCalls"][0]
        self.assertEqual(call["name"], "get_weather")
        # The browser sends tool responses in camelCase.
        await ws.send_json(
            {
                "toolResponse": {
                    "functionResponses": [
                        {"id": call["id"], "name": "get_weather", "response": {"c": 21}}
                    ]
                }
            }
        )
        self.assertEqual(
            self.transcript(await self.receive_turn(ws)),
            'get_weather returned {"c": 21}',
        )
        await ws.close()

    async def test_unknown_model_is_relayed_as_1008(self):
        resp = await self.client.post(
            "/api/control",
            json={
                "command": "connect",
                "session_id": "bad-model",
                "endpoint": "autopush-common",
                "location": "us-central1",
            },
        )
        self.assertEqual(resp.status, 200)
        ws = await self.client.ws_connect("/ws?session_id=bad-model")
        await ws.send_json({"setup": {"model": "models/no-such-model"}})
        msg = await asyncio.wait_for(ws.receive(), TIMEOUT_S)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(ws.close_code, 1008)
        self.assertIn("no-such-model", msg.extra)

    async def test_goaway_then_close_1001(self):
        ws = await self.open_session(setup_message())
        await ws.send_json(text_turn("/goaway 0.3"))
        self.assertEqual(await self.receive(ws), {"goAway": {"timeLeft": "0.3s"}})
        msg = await asyncio.wait_for(ws.receive(), TIMEOUT_S)
        self.assertEqual(msg.type, aiohttp.WSMsgType.CLOSE)
        self.assertEqual(ws.close_code, 1001)

    async def test_close_command(self):
        ws = await self.open_session(setup_message())
        await ws.send_json(text_turn("/close 1011 Internal error"))
        msg = await asyncio.wait_for(ws.receive(), TIMEOUT_S)
        self.assertEqual(ws.close_code, 1011)
        self.assertEqual(msg.extra, "Internal error")


class MockLiveApiDirectTest(unittest.IsolatedAsyncioTestCase):
    async def test_first_message_must_be_setup(self):
        async with mock_live_api.MockLiveApi() as api:
            async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                await ws.send(json.dumps(text_turn("hi")))
                with self.assertRaises(websockets.exceptions.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                self.assertEqual(ws.close_code, 1007)


if __name__ == "__main__":
    unittest.main()
