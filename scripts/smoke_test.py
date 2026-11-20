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


def summarize(message: dict, stats: dict) -> None:
    """Folds one server message into the running stats."""
    content = message.get("serverContent") or message.get("server_content") or {}
    turn = content.get("modelTurn") or content.get("model_turn") or {}
    for part in turn.get("parts", []):
        if "text" in part:
            stats["text"].append(part["text"])
        inline = part.get("inlineData") or part.get("inline_data")
        if inline:
            mime = inline.get("mimeType") or inline.get("mime_type") or ""
            kind = "video" if mime.startswith(("video/", "image/")) else "audio"
            stats[f"{kind}_chunks"] += 1
            stats[f"{kind}_bytes"] += len(inline.get("data", "")) * 3 // 4
    for key in ("outputTranscription", "output_transcription"):
        if content.get(key, {}).get("text"):
            stats["transcript"].append(content[key]["text"])


async def run(args: argparse.Namespace) -> int:
    session_id = str(uuid.uuid4())
    environment = args.environment
    endpoint = ENVIRONMENT_ENDPOINTS.get(environment, environment)
    is_common_bag = environment in COMMON_BAG_ENVIRONMENTS
    server = args.server.rstrip("/")

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
            body = await resp.json()
            print(f"control: HTTP {resp.status} {body}")
            if resp.status != 200:
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

        ws_url = server.replace("http", "ws", 1) + f"/ws?session_id={session_id}"
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
                        data = json.loads(msg.data)
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
                        content = data.get("serverContent") or {}
                        if content.get("turnComplete"):
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
