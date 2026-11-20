"""Minimal WebSocket proxy for the Gemini Live API.

Browsers can't set the Authorization header on a WebSocket, so the browser
connects to this proxy, and the proxy opens the Live API WebSocket with an OAuth
token from Application Default Credentials. Frames are forwarded unchanged in
both directions, and the server's close code and reason are passed back to the
browser.

    pip install "websockets>=14" google-auth requests
    gcloud auth application-default login
    LOCATION=us python ws_proxy.py     # Listens on ws://localhost:8080.

LOCATION must match the location in the model name that the page sends. Set
HOST=0.0.0.0 to accept connections from outside the machine, for example in a
container. For production, authenticate your own users before proxying, and
restrict allowed origins (the `origins` argument of `websockets.serve`).
"""

import asyncio
import os
import threading

import google.auth
import google.auth.transport.requests
import websockets

LOCATION = os.environ.get("LOCATION", "us")  # "us" or "eu".
HOST = os.environ.get("HOST", "localhost")
PORT = int(os.environ.get("PORT", "8080"))
LIVE_API_URL = (
    f"wss://aiplatform.{LOCATION}.rep.googleapis.com/ws/"
    "google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent"
)

_credentials, _ = google.auth.default(
    scopes=["https://www.googleapis.com/auth/cloud-platform"]
)
_credentials_lock = threading.Lock()


def _access_token() -> str:
    with _credentials_lock:
        if not _credentials.valid:
            _credentials.refresh(google.auth.transport.requests.Request())
        return _credentials.token


def _close_reason(text: str) -> str:
    # A WebSocket close reason is limited to 123 bytes of UTF-8.
    return text.encode()[:123].decode(errors="ignore")


async def _pipe(source, target) -> None:
    try:
        async for message in source:
            await target.send(message)
    except websockets.ConnectionClosed:
        pass


async def _handle(client) -> None:
    try:
        token = await asyncio.to_thread(_access_token)
        server = await websockets.connect(
            LIVE_API_URL,
            additional_headers={"Authorization": f"Bearer {token}"},
            max_size=None,
        )
    except Exception as e:  # For example, expired credentials or HTTP 403.
        await client.close(1011, _close_reason(f"Proxy can't reach the Live API: {e}"))
        return
    async with server:
        tasks = [
            asyncio.create_task(_pipe(client, server)),
            asyncio.create_task(_pipe(server, client)),
        ]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            task.cancel()
        # Pass the server's close code and reason (for example 1007 with an
        # error message) back to the browser.
        if server.close_code not in (None, 1005, 1006):
            await client.close(
                server.close_code, _close_reason(server.close_reason or "")
            )


async def main() -> None:
    async with websockets.serve(_handle, HOST, PORT, max_size=None):
        print(f"Proxying ws://{HOST}:{PORT} to {LIVE_API_URL}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
