import asyncio
import json
import os
from typing import Any

from aiohttp import web
import aiohttp_cors
from absl import app, flags, logging
from google import genai
import google.genai.chats
import websockets

import session_management
import websocket_handler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Navigate to the frontend folder (assuming it's a sibling to the backend folder)
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
# Constants
DEBUG = False
SERVICE_URL = "wss://{host}/ws/google.cloud.aiplatform.internal.LlmBidiService/BidiGenerateContent"
FR_SIMULATOR_MODEL = "gemini-2.5-pro"
FR_SIMULATOR_PROMPT = """
You're a function response simulator, your job is to provide a simulated function response...
"""

SESSION_MANAGER = session_management.SessionManager()

# Flags
PROJECT_ID = flags.DEFINE_string("project_id", None, "Google Cloud Project ID.")

# --- ADAPTER CLASS ---


class AiohttpToWebsocketsAdapter:
    """Adapts an aiohttp WebSocketResponse to look like a websockets.LegacyProtocol"""

    def __init__(self, aio_ws: web.WebSocketResponse, request_path="/ws"):
        self.aio_ws = aio_ws
        self._path = request_path

    async def send(self, data):
        await self.aio_ws.send_str(data)

    async def recv(self):
        msg = await self.aio_ws.receive()
        if msg.type in (
            web.WSMsgType.CLOSE,
            web.WSMsgType.CLOSING,
            web.WSMsgType.CLOSED,
        ):
            raise websockets.exceptions.ConnectionClosed(None, None)
        return msg.data

    async def close(self, code=1000, reason=""):
        await self.aio_ws.close(code=code, message=reason.encode())

    @property
    def path(self):
        return self._path


# --- HANDLERS ---


async def aiohttp_websocket_handler(request: web.Request) -> web.WebSocketResponse:
    """Bridge between Cloud Run (aiohttp) and the shared WebsocketHandler."""
    session_id = request.query.get("session_id")
    if not session_id:
        return web.Response(text="Missing session_id", status=400)

    session_handler = await SESSION_MANAGER.search_item(session_id)
    if not session_handler:
        return web.Response(text="No config record for session", status=404)

    # Prepare aiohttp WS
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    # Wrap the aiohttp WS in the adapter to satisfy the shared dependency
    adapted_ws = AiohttpToWebsocketsAdapter(ws, request_path=request.path_qs)

    liveapi_service_url = SERVICE_URL.format(host=session_handler.ws_host)
    try:
        # Pass the ADAPTED websocket here
        wb_handler = websocket_handler.WebsocketHandler(
            liveapi_service_url, session_id, adapted_ws, debug_mode=DEBUG
        )

        # This starts the internal proxy tasks in your shared handler
        session_handler.websocket_handler = wb_handler
        await wb_handler.start_websocket()

    except Exception:
        logging.exception("Error in bridged websocket handler")
    finally:
        logging.info("WebSocket connection cleanup for session %s", session_id)
        # Always clean up the session to prevent memory leaks if the client
        # disconnects without sending a 'disconnect' command.
        await SESSION_MANAGER.delete_item(session_id)

    return ws


async def handle_fr_post_request(request: web.Request):
    """
    Handles incoming POST requests, forwards the content to the Gemini chat session,
    and returns the model's response.
    """

    try:
        request_body: dict[str, Any] = await request.json()
        # The entire body is the query for the function call simulation
        session_id = request_body.get("session_id")
        chat_session: session_management.SessionBaseModel | None = (
            await SESSION_MANAGER.search_item(session_id)
        )
        if not chat_session:
            return web.json_response(
                {"error": "Chat session not initialized"}, status=503
            )

        fr_chat_session = chat_session.fr_session
        query_object = request_body.pop("objective")
        logging.debug("query object:\n%s", query_object)

        query = json.dumps(request_body)
        logging.debug("Received query for Gemini:\n%s", query)

        if query_object == "fr_generate":
            current_content = [
                genai.types.Part(
                    text="Now generate function response this function call."
                ),
                genai.types.Part(text=query),
            ]
        elif query_object == "fc_definition":
            current_content = [
                genai.types.Part(text="The definition of the functions are:"),
                genai.types.Part(text=query),
            ]
        else:
            raise Exception(f"Unknown query objective type {query_object}")

        response = await fr_chat_session.send_message(current_content)
        logging.debug("Sending back frontend with response:\n%s", response.text)
        return web.json_response({"response": response.text})
    except Exception as e:
        logging.exception(f"Error processing POST request")
        return web.json_response({"error": str(e)}, status=500)


async def handle_control_request(request: web.Request):
    """Your existing control logic."""
    try:
        request_body = await request.json()
        command = request_body.get("command")
        session_id = request_body.get("session_id")
        session_handler = await SESSION_MANAGER.search_item(session_id)

        if command == "connect":
            location = request_body.get("location")
            endpoint = request_body.get("endpoint")

            ws_host = f"{location}-{endpoint}"

            if session_handler and session_handler.websocket_handler:
                return web.json_response({"error": "Already running"}, status=409)

            gemini_chat_session = await asyncio.to_thread(
                initialize_gemini_chat_session, location
            )
            session_handler = session_management.SessionBaseModel(
                session_id=session_id, ws_host=ws_host, fr_session=gemini_chat_session
            )
            await SESSION_MANAGER.add_item(session_id, session_handler)
            return web.json_response(
                {
                    "status": "Session initialized.",
                    "project_id": PROJECT_ID.value,
                }
            )

        return web.json_response({"error": "Invalid command"}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


def initialize_gemini_chat_session(location: str) -> google.genai.chats.AsyncChat:
    logging.info(
        f"Initializing Gemini chat session with project {PROJECT_ID.value}, location {location}..."
    )
    client = genai.Client(vertexai=True, project=PROJECT_ID.value, location=location)
    return client.aio.chats.create(
        model=FR_SIMULATOR_MODEL,
        config=genai.types.GenerateContentConfig(
            system_instruction=FR_SIMULATOR_PROMPT
        ),
    )


async def serve_index(request):
    return web.FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


async def create_app():
    app = web.Application()
    cors = aiohttp_cors.setup(
        app,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                allow_credentials=True,
                expose_headers="*",
                allow_headers="*",
                allow_methods="*",
            )
        },
    )

    # API and WS Routes
    cors.add(app.router.add_post("/api/post_endpoint", handle_fr_post_request))
    cors.add(app.router.add_post("/api/control", handle_control_request))
    app.router.add_get("/ws", aiohttp_websocket_handler)

    # Static Files
    app.router.add_get("/", serve_index)
    app.router.add_static("/frontend/", path=FRONTEND_DIR, name="frontend")

    return app


async def main_async():
    logging.set_verbosity(logging.DEBUG if DEBUG else logging.INFO)
    app = await create_app()
    port = int(os.environ.get("PORT", 8080))

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()

    logging.info(f"Server unified on port {port}")
    await asyncio.Event().wait()


if __name__ == "__main__":
    app.run(lambda argv: asyncio.run(main_async()))
