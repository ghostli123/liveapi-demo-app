"""End-to-end smoke test for a running demo backend.

Drives the backend the same way the browser does: POST /api/control to create
a session, open /ws, send a setup message and one text turn, then report what
came back. Exits non-zero if the session never completes setup or a turn.

    python scripts/smoke_test.py --server=http://localhost:8080 \
        --environment=prod --location=us-central1 \
        --model=gemini-live-2.5-flash-native-audio --modality=AUDIO
"""

import argparse
import asyncio
import json
import sys
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

import aiohttp

# Mirrors GeminiLiveAPI.setApiHost() in frontend/gemini-live-api.js.
ENVIRONMENT_ENDPOINTS = {
    "autopush": "autopush-aiplatform.sandbox.googleapis.com",
    "staging": "staging-aiplatform.sandbox.googleapis.com",
    "prod": "aiplatform.googleapis.com",
    "autopush-us-rep": "autopush-aiplatform.us.rep.sandbox.googleapis.com",
    "staging-us-rep": "staging-aiplatform.us.rep.sandbox.googleapis.com",
    "prod-us-rep": "aiplatform.us.rep.googleapis.com",
}
COMMON_BAG_ENVIRONMENTS = (
    "autopush-common",
    "staging-common",
    "autopush-vertex-bidi",
    "autopush-vertex-us-bidi",
)


def _ws_url(server: str, session_id: str) -> str:
    """Builds the /ws URL from an http(s) server URL."""
    parts = urlsplit(server.strip())
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(
            f"--server must be an http:// or https:// URL (got {server!r})"
        )
    ws_scheme = "wss" if scheme == "https" else "ws"
    path = parts.path.rstrip("/") + "/ws"
    return urlunsplit((ws_scheme, parts.netloc, path, f"session_id={session_id}", ""))


def _server_content(message: dict) -> dict:
    content = message.get("serverContent") or message.get("server_content")
    return content if isinstance(content, dict) else {}


def is_turn_complete(message: dict) -> bool:
    """Returns True when a server message signals the end of a model turn."""
    content = _server_content(message)
    return bool(content.get("turnComplete") or content.get("turn_complete"))


def summarize(message: dict, stats: dict) -> None:
    """Folds one server message into the running stats."""
    content = _server_content(message)
    turn = content.get("modelTurn") or content.get("model_turn")
    parts = turn.get("parts") if isinstance(turn, dict) else None
    if isinstance(parts, list):
        for part in parts:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str):
                stats["text"].append(text)
            inline = part.get("inlineData") or part.get("inline_data")
            if isinstance(inline, dict):
                raw_mime = inline.get("mimeType") or inline.get("mime_type")
                mime = raw_mime.strip().lower() if isinstance(raw_mime, str) else ""
                kind = "video" if mime.startswith(("video/", "image/")) else "audio"
                stats[f"{kind}_chunks"] += 1
                data = inline.get("data")
                if isinstance(data, str):
                    stats[f"{kind}_bytes"] += len(data) * 3 // 4
    for key in ("outputTranscription", "output_transcription"):
        transcription = content.get(key)
        if isinstance(transcription, dict):
            text = transcription.get("text")
            if isinstance(text, str) and text:
                stats["transcript"].append(text)


async def run(args: argparse.Namespace) -> int:
    session_id = str(uuid.uuid4())
    environment = args.environment
    endpoint = ENVIRONMENT_ENDPOINTS.get(environment, environment)
    is_common_bag = environment in COMMON_BAG_ENVIRONMENTS
    server = args.server.strip().rstrip("/")
    try:
        ws_url = _ws_url(server, session_id)
    except ValueError as err:
        print(f"FAIL: {err}")
        return 1

    async with aiohttp.ClientSession() as http:
        async with http.post(
            f"{server}/api/control",
            json={
                "command": "connect",
                "session_id": session_id,
                "endpoint": endpoint,
                "location": args.location,
            },
        ) as resp:
            raw = await resp.text(errors="replace")
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = None
            display = body if body is not None else raw.strip()[:300]
            print(f"control: HTTP {resp.status} {display}".rstrip())
            if resp.status != 200 or not isinstance(body, dict):
                if resp.status == 200:
                    print("FAIL: /api/control did not return a JSON object")
                return 1
        project_id = body.get("project_id")

        model = (
            f"models/{args.model}"
            if is_common_bag
            else f"projects/{project_id}/locations/{args.location}"
            f"/publishers/google/models/{args.model}"
        )
        setup = {
            "setup": {
                "model": model,
                "generation_config": {"response_modalities": [args.modality]},
                "output_audio_transcription": {},
            }
        }
        if args.modality == "VIDEO":
            setup["setup"]["avatar_config"] = {"avatar_name": "Piper"}

        stats = {
            "text": [],
            "transcript": [],
            "audio_chunks": 0,
            "audio_bytes": 0,
            "video_chunks": 0,
            "video_bytes": 0,
        }
        setup_complete = turn_complete = False
        close_reason = ""
        start = time.monotonic()
        first_media_s = None
        async with http.ws_connect(ws_url, max_msg_size=64 * 1024 * 1024) as ws:
            await ws.send_str(json.dumps(setup))
            try:
                async with asyncio.timeout(args.timeout):
                    while True:
                        msg = await ws.receive()
                        if msg.type == aiohttp.WSMsgType.BINARY:
                            print(
                                "FAIL: received a binary frame; the browser ignores those"
                            )
                            return 1
                        if msg.type == aiohttp.WSMsgType.CLOSE:
                            close_reason = msg.extra or ""
                            break
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            break
                        try:
                            data = json.loads(msg.data)
                        except json.JSONDecodeError:
                            print(
                                f"FAIL: received non-JSON text frame: "
                                f"{msg.data.strip()[:300]}"
                            )
                            return 1
                        if not isinstance(data, dict):
                            print(
                                f"FAIL: received non-object JSON frame: "
                                f"{type(data).__name__}"
                            )
                            return 1
                        if "setupComplete" in data or "setup_complete" in data:
                            setup_complete = True
                            print(
                                f"setupComplete after {time.monotonic() - start:.2f}s"
                            )
                            await ws.send_str(
                                json.dumps(
                                    {
                                        "client_content": {
                                            "turns": [
                                                {
                                                    "role": "user",
                                                    "parts": [{"text": args.prompt}],
                                                }
                                            ],
                                            "turn_complete": True,
                                        }
                                    }
                                )
                            )
                            continue
                        before = stats["audio_chunks"] + stats["video_chunks"]
                        summarize(data, stats)
                        if first_media_s is None and before < (
                            stats["audio_chunks"] + stats["video_chunks"]
                        ):
                            first_media_s = time.monotonic() - start
                        if is_turn_complete(data):
                            turn_complete = True
                            break
            except TimeoutError:
                print(f"timed out after {args.timeout}s")
            close_code = ws.close_code

        print(f"close code: {close_code} {close_reason}".rstrip())
        print(
            f"audio: {stats['audio_chunks']} chunks / {stats['audio_bytes']} B, "
            f"video: {stats['video_chunks']} chunks / {stats['video_bytes']} B"
        )
        if first_media_s is not None:
            print(f"first media after {first_media_s:.2f}s")
        if stats["text"]:
            print("text:", "".join(stats["text"])[:300])
        if stats["transcript"]:
            print("transcript:", "".join(stats["transcript"])[:300])

    if not setup_complete:
        print("FAIL: no setupComplete")
        return 1
    if not turn_complete:
        print("FAIL: no turnComplete")
        return 1
    print("PASS")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="End-to-end smoke test.")
    parser.add_argument("--server", default="http://localhost:8080")
    parser.add_argument("--environment", default="prod")
    parser.add_argument("--location", default="us-central1")
    parser.add_argument("--model", default="gemini-live-2.5-flash-native-audio")
    parser.add_argument(
        "--modality", default="AUDIO", choices=["AUDIO", "VIDEO", "TEXT"]
    )
    parser.add_argument("--prompt", default="Say hello in one short sentence.")
    parser.add_argument("--timeout", type=float, default=60)
    sys.exit(asyncio.run(run(parser.parse_args())))


if __name__ == "__main__":
    main()
