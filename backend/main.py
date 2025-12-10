import asyncio
import json
import ssl  # LARRY <-- Import the ssl module
import certifi  # LARRY <-- Import the certifi module
from aiohttp import web
import aiohttp_cors
from google import genai
import google.genai.chats

import google.auth
import google.auth.transport.requests

import websockets
from websockets.legacy.protocol import WebSocketCommonProtocol
from websockets.legacy.server import WebSocketServerProtocol


SERVICE_URL: str | None = None

DEBUG = False

BEARER_TOKEN = None
FR_SIMULATOR_MODEL = "gemini-2.5-pro"

# Global variable to hold the persistent chat session
GEMINI_CHAT_SESSION: google.genai.chats.AsyncChat | None = None
WEBSOCKET_SERVER_TASK: asyncio.Task | None = None


FR_SIMULATOR_PROMPT = """
You're a function response simulator, your job is to provide a simulated function response, you'll be provided with all function names and their descriptions.

Then you'll be given a function name to be triggered and input arguments. You should generate a function response based your understanding of the function.

If a function response should follow a specific format, it will be described in the function description. If you cannot find any function response format, just return a string that you think best fit the function response.
If there are any issues with the arguments, such as type is incorrect, required arguments not provided, in these kind of cases, you should return a string like raise Exception.

"""


async def proxy_task(
    client_websocket: WebSocketCommonProtocol, server_websocket: WebSocketCommonProtocol
) -> None:
    """
    Forwards messages from one WebSocket connection to another.

    Args:
        client_websocket: The WebSocket connection from which to receive messages.
        server_websocket: The WebSocket connection to which to send messages.
    """
    async for message in client_websocket:

        try:
            data = json.loads(message)
            # print(json.dumps(data, indent=2))
            if DEBUG:
                print("proxying: ", data)
            await server_websocket.send(json.dumps(data))
        except Exception as e:
            print(f"Error processing message: {e}")

    await server_websocket.close()


async def create_proxy(
    client_websocket: WebSocketCommonProtocol, bearer_token: str
) -> None:
    """
    Establishes a WebSocket connection to the server and creates two tasks for
    bidirectional message forwarding between the client and the server.

    Args:
        client_websocket: The WebSocket connection of the client.
        bearer_token: The bearer token for authentication with the server.
    """

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {bearer_token}",
    }

    # LARRY
    # This creates a secure context using certifi's trusted certificates.
    # It ensures Python can verify Google's SSL certificate.
    ssl_context = ssl.create_default_context(cafile=certifi.where())

    async with websockets.connect(
        SERVICE_URL,
        additional_headers=headers,
        ssl=ssl_context,  # LARRY <-- Pass the secure SSL context here
    ) as server_websocket:
        client_to_server_task = asyncio.create_task(
            proxy_task(client_websocket, server_websocket)
        )
        server_to_client_task = asyncio.create_task(
            proxy_task(server_websocket, client_websocket)
        )
        await asyncio.gather(client_to_server_task, server_to_client_task)


async def handle_client(client_websocket: WebSocketServerProtocol) -> None:
    """
    Handles a new client connection, expecting the first message to contain a bearer token.
    Establishes a proxy connection to the server upon successful authentication.

    Args:
        client_websocket: The WebSocket connection of the client.
    """
    print("New connection...")

    if not BEARER_TOKEN:
        print("Error: Bearer token not found in the .env file.")
        await client_websocket.close(code=1008, reason="Bearer token missing")
        return

    await create_proxy(client_websocket, BEARER_TOKEN)


async def websocket_server_service():
    """
    Starts the WebSocket server and listens for incoming client connections.
    """
    async with websockets.serve(handle_client, "localhost", 8080):
        print("Running local insecure websocket server localhost:8080...")
        # Run forever
        await asyncio.Future()


async def handle_fr_post_request(request):
    """
    Handles incoming POST requests, forwards the content to the Gemini chat session,
    and returns the model's response.
    """
    global GEMINI_CHAT_SESSION
    if not GEMINI_CHAT_SESSION:
        print("Error: Chat session not initialized")
        return web.json_response({"error": "Chat session not initialized"}, status=503)

    try:
        data = await request.json()
        # The entire body is the query for the function call simulation

        query_object = data.pop("objective")
        print("query object", query_object)
        query = json.dumps(data)
        print(f"Received query for Gemini: '{query}'")

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

        response = await GEMINI_CHAT_SESSION.send_message(current_content)
        print(f"Sending back frontend with response: '{response.text}'")
        return web.json_response({"response": response.text})
    except Exception as e:
        print(f"Error processing POST request: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def initialize_gemini_chat_session(project_id, location):
    """Initializes the global Gemini chat session."""

    print("Initializing Gemini chat session...")
    global GEMINI_CHAT_SESSION
    client = genai.Client(vertexai=True, project=project_id, location=location)
    GEMINI_CHAT_SESSION = client.aio.chats.create(
        model=FR_SIMULATOR_MODEL,
        config=genai.types.GenerateContentConfig(
            system_instruction=FR_SIMULATOR_PROMPT,
        ),
        history=[],
    )
    print("Gemini chat session initialized successfully.")


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
    global WEBSOCKET_SERVER_TASK, GEMINI_CHAT_SESSION, SERVICE_URL, BEARER_TOKEN
    try:
        data = await request.json()
        command = data.get("command")

        if command == "connect":
            project_id = data.get("project_id")
            location = data.get("location")
            host = data.get("host")
            print(json.dumps(data, indent=2))

            if WEBSOCKET_SERVER_TASK and not WEBSOCKET_SERVER_TASK.done():
                print("WebSocket server is already running.")
                return web.json_response(
                    {"status": "WebSocket server is already running."}
                )

            await initialize_gemini_chat_session(project_id, location)
            # 1. Get credentials using Application Default Credentials
            # ADC automatically finds credentials in your environment (Service Account, gcloud, etc.)
            credentials, project = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
                # Use the scope your API requires
            )

            # 2. Refresh the token if necessary (usually handled automatically, but good practice)
            if not credentials.valid:
                credentials.refresh(google.auth.transport.requests.Request())

            # 3. The access token is available in the 'token' attribute
            BEARER_TOKEN = credentials.token

            SERVICE_URL = f"wss://{host}/ws/google.cloud.aiplatform.internal.LlmBidiService/BidiGenerateContent"

            print("Starting WebSocket server via control request...")
            WEBSOCKET_SERVER_TASK = asyncio.create_task(websocket_server_service())
            return web.json_response({"status": "WebSocket server started."})

        elif command == "disconnect":
            if not WEBSOCKET_SERVER_TASK or WEBSOCKET_SERVER_TASK.done():
                print("WebSocket server is not running.")
                return web.json_response({"status": "WebSocket server is not running."})

            print("Stopping WebSocket server and clearing cache...")
            WEBSOCKET_SERVER_TASK.cancel()
            try:
                await WEBSOCKET_SERVER_TASK
            except asyncio.CancelledError:
                print("WebSocket server task cancelled successfully.")

            WEBSOCKET_SERVER_TASK = None
            GEMINI_CHAT_SESSION = None  # Clearing cache
            SERVICE_URL = None
            BEARER_TOKEN = None

            print("Cache cleared.")

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
    site = web.TCPSite(runner, "localhost", 8081)
    await site.start()
    print("Running local HTTP server on localhost:8081...")
    await asyncio.Future()


async def main() -> None:
    """Runs the HTTP server and initializes services."""
    # The Gemini Chat Session is now initialized on-demand via the /api/control endpoint
    # when a "connect" command is received.

    # The WebSocket server will now be started on-demand via the /api/control endpoint
    # instead of at startup.
    # We only start the http_server_service here.

    await http_server_service()


if __name__ == "__main__":
    asyncio.run(main())
