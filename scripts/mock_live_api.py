"""A stand-in for the Live API, for running the app without credentials.

The backend connects to the common BAG environments (e.g. autopush-common)
over plain ws://127.0.0.1:--common_bag_ws_port without a token, so pointing
that port here and picking autopush-common in the app runs a full session
locally:

    python scripts/mock_live_api.py --port=8765
    python backend/main.py --common_bag_ws_port=8765

It speaks enough of BidiGenerateContent for the frontend:

- setup is answered with setupComplete. There is no rtcSetupComplete, so the
  WebRTC transport falls back to WebSocket media, and no avatar video: VIDEO
  sessions get audio only.
- Each text turn gets a reply of a short tone (audio/pcm;rate=24000) with an
  output transcript, or a text part in TEXT sessions, then usage metadata and
  turnComplete. The reply repeats the turn and the conversation's earlier
  turns, so tests can tell whether resumption kept the conversation.
- With session_resumption in the setup, a sessionResumptionUpdate follows each
  turn; a later setup with that handle restores the conversation.
- A turn that names a declared function gets a toolCall for it, and the reply
  follows the toolResponse, quoting it.
- Models named no-such-* are rejected with close code 1008, like an unknown
  model.
- The turn "/goaway [seconds]" sends goAway, then closes with 1001 once the
  time is up; "/close <code> [reason]" closes with that code.
"""

import argparse
import asyncio
import base64
import itertools
import json
import logging
import math
import struct
import uuid

import websockets

OUTPUT_RATE = 24000
AUDIO_MIME_TYPE = f"audio/pcm;rate={OUTPUT_RATE}"
# Each reply is this many 100 ms chunks of a 440 Hz tone.
REPLY_AUDIO_CHUNKS = 3
DEFAULT_GOAWAY_S = 1.0
MAX_MESSAGE_BYTES = 64 * 1024 * 1024


def tone_chunk(index: int, duration_s: float = 0.1, frequency: float = 440) -> str:
    """One chunk of a quiet sine tone as base64 16-bit little-endian PCM."""
    count = int(OUTPUT_RATE * duration_s)
    start = index * count
    samples = (
        int(3000 * math.sin(2 * math.pi * frequency * (start + i) / OUTPUT_RATE))
        for i in range(count)
    )
    return base64.b64encode(struct.pack(f"<{count}h", *samples)).decode()


def _field(obj: dict, camel: str, snake: str):
    """Reads a field the browser may send in either case, like the real API."""
    value = obj.get(camel)
    return obj.get(snake) if value is None else value


def declared_functions(setup: dict) -> list[str]:
    names = []
    for tool in setup.get("tools") or []:
        for declaration in (
            _field(tool, "functionDeclarations", "function_declarations") or []
        ):
            if declaration.get("name"):
                names.append(declaration["name"])
    return names


class MockLiveApi:
    """Serves mock Live API sessions; keeps state for resumption and tests."""

    def __init__(self):
        # Conversations by resumption handle: the user turns so far.
        self.conversations: dict[str, list[str]] = {}
        # Every setup received, for tests.
        self.setups: list[dict] = []
        self._call_ids = itertools.count(1)
        self.server = None
        self.port = None

    async def __aenter__(self):
        return await self.start()

    async def __aexit__(self, *exc_info):
        await self.stop()

    async def start(self, host: str = "127.0.0.1", port: int = 0):
        self.server = await websockets.serve(
            self.handler, host, port, max_size=MAX_MESSAGE_BYTES
        )
        self.port = next(iter(self.server.sockets)).getsockname()[1]
        return self

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

    async def handler(self, connection) -> None:
        try:
            first = json.loads(await connection.recv())
            setup = first["setup"]
        except (ValueError, KeyError, TypeError):
            await connection.close(1007, "The first message must be a setup message")
            return
        except websockets.exceptions.ConnectionClosed:
            return
        self.setups.append(setup)
        model = str(setup.get("model", "")).rsplit("/", 1)[-1]
        if not model or model.startswith("no-such-"):
            await connection.close(1008, f"Publisher model `{model}` was not found")
            return
        session = MockSession(self, connection, setup)
        logging.info("Session started: model %s", model)
        try:
            await session.run()
        except websockets.exceptions.ConnectionClosed:
            pass
        logging.info("Session ended: %s", connection.close_code)

    def next_call_id(self) -> str:
        return f"call-{next(self._call_ids)}"


class MockSession:
    """One connection: answers text turns until the client goes away."""

    def __init__(self, api: MockLiveApi, connection, setup: dict):
        self.api = api
        self.connection = connection
        config = _field(setup, "generationConfig", "generation_config") or {}
        modalities = _field(config, "responseModalities", "response_modalities")
        self.text_only = modalities == ["TEXT"]
        self.transcribe = (
            _field(setup, "outputAudioTranscription", "output_audio_transcription")
            is not None
        )
        self.functions = declared_functions(setup)
        resumption = _field(setup, "sessionResumption", "session_resumption")
        self.resumable = resumption is not None
        handle = (resumption or {}).get("handle")
        # An unknown handle starts a new conversation.
        self.history = list(api.conversations.get(handle or "", []))
        self.pending_turn: str | None = None
        self.expiry: asyncio.Task | None = None

    async def send(self, message: dict) -> None:
        # The Live API sends its JSON in binary frames.
        await self.connection.send(json.dumps(message).encode())

    async def run(self) -> None:
        await self.send({"setupComplete": {}})
        async for raw in self.connection:
            message = json.loads(raw)
            content = _field(message, "clientContent", "client_content")
            tool_response = _field(message, "toolResponse", "tool_response")
            if content:
                await self.on_text_turn(content)
            elif tool_response and self.pending_turn is not None:
                await self.on_tool_response(tool_response)
            # Realtime audio and video are accepted and ignored.

    async def on_text_turn(self, content: dict) -> None:
        text = " ".join(
            part.get("text", "")
            for turn in content.get("turns") or []
            for part in turn.get("parts") or []
        ).strip()
        if text.startswith("/"):
            await self.on_command(text)
            return
        called = next((name for name in self.functions if name in text), None)
        if called:
            self.pending_turn = text
            await self.send(
                {
                    "toolCall": {
                        "functionCalls": [
                            {"id": self.api.next_call_id(), "name": called, "args": {}}
                        ]
                    }
                }
            )
            return
        await self.reply(text, self.describe(text))

    async def on_tool_response(self, tool_response: dict) -> None:
        responses = _field(tool_response, "functionResponses", "function_responses")
        results = "; ".join(
            f"{r.get('name')} returned {json.dumps(r.get('response'))}"
            for r in responses or []
        )
        text, self.pending_turn = self.pending_turn or "", None
        await self.reply(text, results)

    def describe(self, text: str) -> str:
        reply = f"You said: {text}"
        if self.history:
            reply += " Earlier you said: " + " | ".join(self.history)
        return reply

    async def reply(self, user_text: str, reply_text: str) -> None:
        if self.text_only:
            await self.send(
                {"serverContent": {"modelTurn": {"parts": [{"text": reply_text}]}}}
            )
        else:
            for index in range(REPLY_AUDIO_CHUNKS):
                inline = {"mimeType": AUDIO_MIME_TYPE, "data": tone_chunk(index)}
                await self.send(
                    {
                        "serverContent": {
                            "modelTurn": {"parts": [{"inlineData": inline}]}
                        }
                    }
                )
            if self.transcribe:
                await self.send(
                    {"serverContent": {"outputTranscription": {"text": reply_text}}}
                )
        prompt_tokens, response_tokens = len(user_text.split()), len(reply_text.split())
        await self.send(
            {
                "usageMetadata": {
                    "promptTokenCount": prompt_tokens,
                    "responseTokenCount": response_tokens,
                    "totalTokenCount": prompt_tokens + response_tokens,
                }
            }
        )
        await self.send({"serverContent": {"turnComplete": True}})
        self.history.append(user_text)
        if self.resumable:
            handle = uuid.uuid4().hex
            self.api.conversations[handle] = list(self.history)
            await self.send(
                {"sessionResumptionUpdate": {"newHandle": handle, "resumable": True}}
            )

    async def close_after(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
        await self.connection.close(1001, "Connection expired")

    async def on_command(self, text: str) -> None:
        command, *args = text.split(maxsplit=2)
        if command == "/goaway":
            seconds = float(args[0]) if args else DEFAULT_GOAWAY_S
            await self.send({"goAway": {"timeLeft": f"{seconds:g}s"}})
            self.expiry = asyncio.create_task(self.close_after(seconds))
        elif command == "/close" and args:
            await self.connection.close(int(args[0]), args[1] if len(args) > 1 else "")
        else:
            await self.reply(text, f"Unknown command: {command}")


async def main() -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port to listen on; give the backend the same --common_bag_ws_port.",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    api = await MockLiveApi().start(args.host, args.port)
    logging.info("Mock Live API listening on ws://%s:%d", args.host, api.port)
    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
