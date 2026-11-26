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
        self.assertIn("no-such-model", str(msg.extra))

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


def _close_after_tasks():
    code = mock_live_api.MockSession.close_after.__code__
    return [
        t
        for t in asyncio.all_tasks()
        if not t.done() and getattr(t.get_coro(), "cr_code", None) is code
    ]


async def _wait_for_no_close_after_tasks(timeout: float = TIMEOUT_S) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while _close_after_tasks():
        if asyncio.get_running_loop().time() >= deadline:
            break
        await asyncio.sleep(0.02)


class MockLiveApiDirectTest(unittest.IsolatedAsyncioTestCase):
    async def test_first_message_must_be_setup(self):
        async with mock_live_api.MockLiveApi() as api:
            for payload in (
                text_turn("hi"),
                {"setup": None},
                {"setup": ["not-an-object"]},
            ):
                with self.subTest(payload=payload):
                    async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                        await ws.send(json.dumps(payload))
                        with self.assertRaises(websockets.exceptions.ConnectionClosed):
                            await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                        self.assertEqual(ws.close_code, 1007)

    async def test_goaway_cancels_prior_task_and_cleans_up_on_disconnect(self):
        async with mock_live_api.MockLiveApi() as api:
            async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                await ws.send(json.dumps(setup_message(["TEXT"])))
                self.assertEqual(
                    json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S)),
                    {"setupComplete": {}},
                )
                await ws.send(json.dumps(text_turn("/goaway 10")))
                self.assertEqual(
                    json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S)),
                    {"goAway": {"timeLeft": "10s"}},
                )
                first_tasks = _close_after_tasks()
                self.assertEqual(len(first_tasks), 1)

                await ws.send(json.dumps(text_turn("/goaway 20")))
                self.assertEqual(
                    json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S)),
                    {"goAway": {"timeLeft": "20s"}},
                )
                self.assertTrue(first_tasks[0].cancelled())
                second_tasks = _close_after_tasks()
                self.assertEqual(len(second_tasks), 1)
                self.assertIsNot(second_tasks[0], first_tasks[0])

            await _wait_for_no_close_after_tasks()
            self.assertEqual(_close_after_tasks(), [])
            self.assertTrue(second_tasks[0].cancelled())

    async def test_close_command_cancels_pending_goaway_task(self):
        async with mock_live_api.MockLiveApi() as api:
            async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                await ws.send(json.dumps(setup_message(["TEXT"])))
                await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                await ws.send(json.dumps(text_turn("/goaway 10")))
                await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                tasks = _close_after_tasks()
                self.assertEqual(len(tasks), 1)

                await ws.send(json.dumps(text_turn("/close 3000 Custom close")))
                with self.assertRaises(websockets.exceptions.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                self.assertEqual(ws.close_code, 3000)
                self.assertEqual(ws.close_reason, "Custom close")

            await _wait_for_no_close_after_tasks()
            self.assertEqual(_close_after_tasks(), [])
            self.assertTrue(tasks[0].cancelled())

    async def test_malformed_goaway_and_close_commands_reply_without_crashing(self):
        async with mock_live_api.MockLiveApi() as api:
            async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                await ws.send(json.dumps(setup_message(["TEXT"])))
                await asyncio.wait_for(ws.recv(), TIMEOUT_S)

                async def receive_text_reply():
                    text = ""
                    while True:
                        msg = json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S))
                        parts = (
                            msg.get("serverContent", {})
                            .get("modelTurn", {})
                            .get("parts", [])
                        )
                        for part in parts:
                            text += part.get("text", "")
                        if msg.get("serverContent", {}).get("turnComplete"):
                            return text

                for cmd in (
                    "/goaway abc",
                    "/goaway -1",
                    "/goaway -0",
                    "/goaway nan",
                    "/goaway inf",
                    "/goaway 1 extra",
                ):
                    with self.subTest(cmd=cmd):
                        await ws.send(json.dumps(text_turn(cmd)))
                        self.assertIn(
                            "Invalid /goaway command", await receive_text_reply()
                        )
                        self.assertEqual(_close_after_tasks(), [])

                for cmd in (
                    "/close",
                    "/close abc",
                    "/close 5 x",
                    "/close 1004",
                    "/close 1005",
                    "/close 1006",
                    "/close 1015",
                    "/close 2999",
                    "/close 5000",
                    "/close 1008 " + "x" * 124,
                ):
                    with self.subTest(cmd=cmd):
                        await ws.send(json.dumps(text_turn(cmd)))
                        self.assertIn(
                            "Invalid /close command", await receive_text_reply()
                        )

                # Session stays alive and still accepts valid turns and commands.
                await ws.send(json.dumps(text_turn("still here")))
                self.assertIn("You said: still here", await receive_text_reply())

                # A malformed /goaway does not cancel an active valid /goaway.
                await ws.send(json.dumps(text_turn("/goaway 0.3")))
                self.assertEqual(
                    json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S)),
                    {"goAway": {"timeLeft": "0.3s"}},
                )
                await ws.send(json.dumps(text_turn("/goaway abc")))
                self.assertIn("Invalid /goaway command", await receive_text_reply())
                with self.assertRaises(websockets.exceptions.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                self.assertEqual(ws.close_code, 1001)

            await _wait_for_no_close_after_tasks()
            self.assertEqual(_close_after_tasks(), [])

    async def test_malformed_post_setup_frame_closes_1007_and_cancels_expiry(self):
        async with mock_live_api.MockLiveApi() as api:
            for raw in ("not-json", "[]", "null"):
                with self.subTest(raw=raw):
                    async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                        await ws.send(json.dumps(setup_message(["TEXT"])))
                        await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                        await ws.send(json.dumps(text_turn("/goaway 10")))
                        await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                        self.assertEqual(len(_close_after_tasks()), 1)

                        await ws.send(raw)
                        with self.assertRaises(websockets.exceptions.ConnectionClosed):
                            await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                        self.assertEqual(ws.close_code, 1007)

                    await _wait_for_no_close_after_tasks()
                    self.assertEqual(_close_after_tasks(), [])

    def test_declared_functions_ignores_malformed_entries(self):
        for bad_tools in (None, 123, "bad", {"function_declarations": []}):
            with self.subTest(bad_tools=bad_tools):
                self.assertEqual(
                    mock_live_api.declared_functions({"tools": bad_tools}), []
                )

        setup = {
            "tools": [
                None,
                123,
                "bad",
                [],
                {"function_declarations": 123},
                {"functionDeclarations": "bad"},
                {
                    "function_declarations": [
                        None,
                        42,
                        "bad",
                        [],
                        {"name": None},
                        {"name": 123},
                        {"name": ["fn"]},
                        {"name": ""},
                        {"name": "   "},
                        {"name": "get_weather"},
                    ]
                },
                {
                    "functionDeclarations": [
                        {"name": "lookup_order"},
                    ]
                },
            ]
        }
        self.assertEqual(
            mock_live_api.declared_functions(setup),
            ["get_weather", "lookup_order"],
        )

    async def test_malformed_setup_nested_fields_do_not_crash(self):
        async with mock_live_api.MockLiveApi() as api:
            for label, setup in (
                (
                    "non-dict generationConfig",
                    {"model": "models/m", "generationConfig": "bad"},
                ),
                (
                    "non-dict sessionResumption",
                    {"model": "models/m", "sessionResumption": "bad"},
                ),
                (
                    "unhashable resumption handle list",
                    {"model": "models/m", "sessionResumption": {"handle": ["x"]}},
                ),
                (
                    "unhashable resumption handle dict",
                    {"model": "models/m", "sessionResumption": {"handle": {"a": 1}}},
                ),
                (
                    "non-dict outputAudioTranscription",
                    {"model": "models/m", "outputAudioTranscription": False},
                ),
                (
                    "non-list tools",
                    {"model": "models/m", "tools": 123},
                ),
                (
                    "non-dict tool entry",
                    {"model": "models/m", "tools": ["bad"]},
                ),
                (
                    "non-list functionDeclarations",
                    {"model": "models/m", "tools": [{"function_declarations": 123}]},
                ),
                (
                    "non-dict declaration entry",
                    {
                        "model": "models/m",
                        "tools": [{"function_declarations": ["bad"]}],
                    },
                ),
                (
                    "non-string declaration name",
                    {
                        "model": "models/m",
                        "tools": [{"function_declarations": [{"name": 123}]}],
                    },
                ),
            ):
                with self.subTest(label=label):
                    async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                        await ws.send(json.dumps({"setup": setup}))
                        self.assertEqual(
                            json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S)),
                            {"setupComplete": {}},
                        )
                        await ws.send(json.dumps(text_turn("hello")))
                        messages = []
                        while True:
                            msg = json.loads(
                                await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                            )
                            messages.append(msg)
                            if msg.get("serverContent", {}).get("turnComplete"):
                                break
                        if label == "non-dict outputAudioTranscription":
                            self.assertFalse(
                                any(
                                    "outputTranscription" in m.get("serverContent", {})
                                    for m in messages
                                )
                            )

    async def test_invalid_or_overlong_model_closes_1008(self):
        async with mock_live_api.MockLiveApi() as api:
            for model in (
                None,
                123,
                ["m"],
                "models/   ",
                "models/no-such-" + "a" * 200,
            ):
                with self.subTest(model=model):
                    async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                        await ws.send(json.dumps({"setup": {"model": model}}))
                        with self.assertRaises(websockets.exceptions.ConnectionClosed):
                            await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                        self.assertEqual(ws.close_code, 1008)
                        self.assertIsNotNone(ws.close_reason)
                        assert ws.close_reason is not None
                        self.assertLessEqual(
                            len(ws.close_reason.encode("utf-8")),
                            mock_live_api.MAX_CLOSE_REASON_BYTES,
                        )

    async def test_malformed_text_turns_and_tool_responses_do_not_crash(self):
        async with mock_live_api.MockLiveApi() as api:
            tools = [{"function_declarations": [{"name": "get_weather"}]}]
            async with websockets.connect(f"ws://127.0.0.1:{api.port}/x") as ws:
                await ws.send(json.dumps(setup_message(["TEXT"], tools=tools)))
                await asyncio.wait_for(ws.recv(), TIMEOUT_S)

                async def receive_text_reply():
                    text = ""
                    while True:
                        msg = json.loads(await asyncio.wait_for(ws.recv(), TIMEOUT_S))
                        parts = (
                            msg.get("serverContent", {})
                            .get("modelTurn", {})
                            .get("parts", [])
                        )
                        for part in parts:
                            text += part.get("text", "")
                        if msg.get("serverContent", {}).get("turnComplete"):
                            return text

                for label, content, expected in (
                    ("non-list turns", {"turns": 123}, "You said: "),
                    ("string turns", {"turns": "bad"}, "You said: "),
                    ("non-dict turn", {"turns": [None, "bad", 123]}, "You said: "),
                    ("non-list parts", {"turns": [{"parts": 123}]}, "You said: "),
                    (
                        "non-dict part",
                        {"turns": [{"parts": [None, "bad", 42]}]},
                        "You said: ",
                    ),
                    (
                        "non-string part text",
                        {
                            "turns": [
                                {
                                    "parts": [
                                        {"text": None},
                                        {"text": 42},
                                        {"text": ["a"]},
                                        {"text": "valid"},
                                    ]
                                }
                            ]
                        },
                        "You said: valid",
                    ),
                ):
                    with self.subTest(label=label):
                        await ws.send(json.dumps({"client_content": content}))
                        self.assertIn(expected, await receive_text_reply())

                for label, responses, expected in (
                    ("non-list functionResponses", 123, ""),
                    ("string functionResponses", "bad", ""),
                    (
                        "mixed functionResponses entries",
                        [
                            None,
                            "bad",
                            42,
                            {"name": "get_weather", "response": {"c": 21}},
                        ],
                        'get_weather returned {"c": 21}',
                    ),
                ):
                    with self.subTest(label=label):
                        await ws.send(json.dumps(text_turn("Call get_weather")))
                        call_msg = json.loads(
                            await asyncio.wait_for(ws.recv(), TIMEOUT_S)
                        )
                        self.assertIn("toolCall", call_msg)
                        await ws.send(
                            json.dumps(
                                {"toolResponse": {"functionResponses": responses}}
                            )
                        )
                        self.assertEqual(await receive_text_reply(), expected)

                # Session remains healthy after malformed payloads.
                await ws.send(json.dumps(text_turn("final check")))
                self.assertIn("You said: final check", await receive_text_reply())


if __name__ == "__main__":
    unittest.main()
