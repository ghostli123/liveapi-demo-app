import asyncio
import json
from aiohttp import web
import aiohttp_cors
from absl import app
from google import genai
import google.genai.chats
from typing import Any
from absl import flags
from absl import logging
import websockets
import urllib.parse

from websockets import ServerConnection

import session_management
import websocket_handler
import os

DEBUG = True

SERVICE_URL = "wss://{host}/ws/google.cloud.aiplatform.internal.LlmBidiService/BidiGenerateContent"

WEBSOCKET_PORT = 8082
POST_REQUEST_PORT = 8081


FR_SIMULATOR_MODEL = "gemini-2.5-pro"

FR_SIMULATOR_PROMPT = """
You're a function response simulator, your job is to provide a simulated function response, you'll be provided with all function names and their descriptions.

Then you'll be given a function name to be triggered and input arguments. You should generate a function response based your understanding of the function.

If a function response should follow a specific format, it will be described in the function description. If you cannot find any function response format, just return a string that you think best fit the function response.
If there are any issues with the arguments, such as type is incorrect, required arguments not provided, in these kind of cases, you should return a string like raise Exception.

"""

SESSION_MANAGER = session_management.SessionManager()

PROJECT_ID = flags.DEFINE_string("project_id", None, "Google Cloud Project ID.")
LOCATION = flags.DEFINE_string("location", None, "Google Cloud Location.")


async def handle_client(
    client_websocket: ServerConnection,
) -> websocket_handler.WebsocketHandler:
    """
    Handles a new client connection, expecting the first message to contain a bearer token.
    Establishes a proxy connection to the server upon successful authentication.

    Args:
        client_websocket: The WebSocket connection of the client.
        path: The request path of the client connection.
    """

    path = client_websocket.request.path

    query_params = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
    session_id = query_params.get("session_id", [None])[0]

    logging.info("Getting client websocket with sessionid %s", session_id)

    # 2. Check if this session actually exists in our memory
    session_handler: session_management.SessionHandlers | None = (
        await SESSION_MANAGER.search_item(session_id)
    )

    if not session_handler:
        logging.error(
            "Connection rejected: No config record for session %s", session_id
        )
        await client_websocket.close(code=1008, reason="No config record for session.")
        return

    liveapi_service_url = SERVICE_URL.format(host=session_handler.ws_host)
    try:
        print("client websocket", client_websocket)
        wb_handler = websocket_handler.WebsocketHandler(
            liveapi_service_url, session_id, client_websocket, debug_mode=DEBUG
        )

        await wb_handler.start_websocket()
        session_handler.websocket_handler = wb_handler
    except Exception:
        logging.exception(f"Error starting websocket.")


async def websocket_server_service():
    """
    Starts the WebSocket server ONCE.
    It will stay running to handle all incoming users.
    """
    # Change "localhost" to "0.0.0.0" to allow external cloud connections
    async with websockets.serve(handle_client, "0.0.0.0", WEBSOCKET_PORT):
        logging.info("WebSocket server is listening on port %s...", WEBSOCKET_PORT)
        # This keeps the server running indefinitely
        await asyncio.Future()


async def handle_fr_post_request(request):
    """
    Handles incoming POST requests, forwards the content to the Gemini chat session,
    and returns the model's response.
    """

    try:
        request_body: dict[str, Any] = await request.json()
        # The entire body is the query for the function call simulation
        session_id = request_body.get("session_id")
        chat_session: session_management.SessionHandlers | None = (
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


def initialize_gemini_chat_session() -> google.genai.chats.AsyncChat:
    """Initializes the global Gemini chat session."""

    logging.info("Initializing Gemini chat session...")
    client = genai.Client(
        vertexai=True, project=PROJECT_ID.value, location=LOCATION.value
    )
    current_gemini_chat_session: google.genai.chats.AsyncChat = client.aio.chats.create(
        model=FR_SIMULATOR_MODEL,
        config=genai.types.GenerateContentConfig(
            system_instruction=FR_SIMULATOR_PROMPT,
        ),
        history=[],
    )
    logging.info("Gemini chat session initialized successfully.")
    return current_gemini_chat_session


async def handle_control_request(request):
    """
    Handles control commands for the server, like starting or stopping services.

    expected request body:
    {
        "command": "connect" | "disconnect",
        "project_id": string,
        "location": string,
        "host": string
    }

    """
    try:
        request_body: dict[str, Any] = await request.json()
        command = request_body.get("command")
        logging.debug("control request:\n%s", json.dumps(request_body, indent=2))
        session_id = request_body.get("session_id")

        session_handler: session_management.SessionHandlers | None = (
            await SESSION_MANAGER.search_item(session_id)
        )

        if command == "connect":
            host = request_body.get("host")

            if session_handler and session_handler.websocket_handler:
                logging.warning("WebSocket server is already running.")
                return web.json_response(
                    {
                        "error": "WebSocket server is already running, you should disconnect first."
                    },
                    status=409,
                )

            gemini_chat_session = await asyncio.to_thread(
                initialize_gemini_chat_session
            )
            session_handler = session_management.SessionHandlers(
                session_id=session_id, ws_host=host, fr_session=gemini_chat_session
            )

            await SESSION_MANAGER.add_item(session_id, session_handler)
            logging.info("Starting session service via control request...")

            return web.json_response(
                {
                    "status": "WebSocket server started.",
                    "project_id": PROJECT_ID.value,
                    "location": LOCATION.value,
                }
            )

        elif command == "disconnect":
            wb_handler = session_handler.websocket_handler if session_handler else None
            if not wb_handler:
                logging.info("WebSocket server is not running.")
                return web.json_response({"status": "WebSocket server is not running."})

            logging.info("Stopping WebSocket server and clearing cache...")

            await SESSION_MANAGER.delete_item(session_id)
            logging.info("Cache cleared.")

            return web.json_response(
                {"status": "WebSocket server stopped and cache cleared."}
            )

        else:
            return web.json_response({"error": "Invalid command"}, status=400)

    except Exception as e:
        print(f"Error processing control request: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def http_server_service():
    """
    Starts the HTTP server for handling POST requests.
    """
    app = web.Application()

    # Configure CORS
    cors = aiohttp_cors.setup(
        app,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                allow_credentials=True,
                expose_headers="*",
                allow_headers="*",
                allow_methods="*",  # Allow all methods including POST
            )
        },
    )

    # Add the route and apply CORS to it
    resource = app.router.add_resource("/api/post_endpoint")
    route = resource.add_route("POST", handle_fr_post_request)
    cors.add(route)

    # Add the new control route
    control_resource = app.router.add_resource("/api/control")
    control_route = control_resource.add_route("POST", handle_control_request)
    cors.add(control_route)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "localhost", POST_REQUEST_PORT)
    await site.start()
    print("Running local HTTP server on localhost:%s...", POST_REQUEST_PORT)
    await asyncio.Future()


async def main() -> None:
    """Runs the HTTP server and initializes services."""
    if DEBUG:
        logging.set_verbosity(logging.DEBUG)
    else:
        logging.set_verbosity(logging.INFO)

    # Run both the HTTP and WebSocket servers concurrently.
    logging.info(
        "Initializing for project %s, location %s", PROJECT_ID.value, LOCATION.value
    )
    await asyncio.gather(http_server_service(), websocket_server_service())


def main_wrapper(argv):
    asyncio.run(main())


if __name__ == "__main__":
    app.run(main_wrapper)
