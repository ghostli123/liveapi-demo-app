import asyncio
import json
import ssl  # LARRY <-- Import the ssl module
import certifi  # LARRY <-- Import the certifi module
from aiohttp import web
import aiohttp_cors
from google import genai
import google.genai.chats

import dotenv
import os

dotenv.load_dotenv()


import websockets
from websockets.legacy.protocol import WebSocketCommonProtocol
from websockets.legacy.server import WebSocketServerProtocol

# HOST = "us-central1-autopush-aiplatform.sandbox.googleapis.com"
# !!! Need to change this as well to make the environment switch work.
HOST = "us-central1-autopush-aiplatform.sandbox.googleapis.com"
# HOST = "us-central1-aiplatform.googleapis.com"
# SERVICE_URL = f"wss://{HOST}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
SERVICE_URL = f"wss://{HOST}/ws/google.cloud.aiplatform.internal.LlmBidiService/BidiGenerateContent"
DEBUG = False

BEARER_TOKEN = os.environ.get("BEARER_TOKEN", None)
PROJECT_ID = os.environ.get("PROJECT_ID", None)
LOCATION = os.environ.get("LOCATION", None)
FR_SIMULATOR_MODEL = "gemini-2.5-pro"

# Global variable to hold the persistent chat session
GEMINI_CHAT_SESSION: google.genai.chats.AsyncChat | None = None


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
    # Wait for the first message from the client

    # auth_message = await asyncio.wait_for(client_websocket.recv(), timeout=5.0)
    # auth_data = json.loads(auth_message)

    # if "bearer_token" in auth_data:
    #     bearer_token = auth_data["bearer_token"]
    # else:
    #     print("Error: Bearer token not found in the first message.")
    #     await client_websocket.close(code=1008, reason="Bearer token missing")
    #     return

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


async def handle_post_request(request):
    """
    Handles incoming POST requests, forwards the content to the Gemini chat session,
    and returns the model's response.
    """
    global GEMINI_CHAT_SESSION
    if not GEMINI_CHAT_SESSION:
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
    route = resource.add_route("POST", handle_post_request)
    cors.add(route)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "localhost", 8081)
    await site.start()
    print("Running local HTTP server on localhost:8081...")
    await asyncio.Future()


async def main() -> None:
    """Runs both the WebSocket and HTTP servers concurrently."""
    global GEMINI_CHAT_SESSION

    # Initialize the Gemini Chat Session on startup
    print("Initializing Gemini chat session...")

    client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    GEMINI_CHAT_SESSION = client.aio.chats.create(
        model=FR_SIMULATOR_MODEL,
        config=genai.types.GenerateContentConfig(
            system_instruction=FR_SIMULATOR_PROMPT,
        ),
        history=[],
    )
    print("Gemini chat session initialized successfully.")

    await asyncio.gather(websocket_server_service(), http_server_service())


if __name__ == "__main__":
    asyncio.run(main())
