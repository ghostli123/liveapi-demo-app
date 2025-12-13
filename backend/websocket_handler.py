import pydantic
import datetime
import ssl
import certifi
import websockets
import asyncio
import json
from websockets.legacy.protocol import WebSocketCommonProtocol
from absl import logging
import get_credentials


class WebsocketHandler:
    """
    This class handle the session connection between client and liveapi endpoint.
    """

    def __init__(
        self,
        liveapi_service_url,
        session_id,
        client_websocket,
        debug_mode=False,
    ) -> None:
        # TODO: Handle timeout connections and add checking methods such as is_alive

        self.session_id = session_id
        self.liveapi_service_url = liveapi_service_url
        self.bearer_token = None
        self.expire_time = None
        self.server_websocket: WebSocketCommonProtocol = None
        self.client_websocket: WebSocketCommonProtocol = client_websocket
        self.debug_mode = debug_mode
        self.update_cred_task: asyncio.Task | None = None
        self.connection_handler: asyncio.Task | None = None

        logging.info("Websocket handler initialized for session: %s", self.session_id)

        # The creator of this instance is responsible for calling start_websocket()

    async def proxy_task(
        self,
        source_websocket: WebSocketCommonProtocol,
        target_websocket: WebSocketCommonProtocol,
        service_name: str,
    ) -> None:
        """
        Forwards messages from one WebSocket connection to another.

        Args:
            source_websocket: The WebSocket connection from which to receive messages.
            target_websocket: The WebSocket connection to which to send messages.
        """
        while True:
            try:
                message = await source_websocket.recv()
                # We have to convert to json format, the frontend implementation won't recognize blob!
                # Leave as a TODO: modify frontend that can handle blob directly.
                data = json.loads(message)

                logging.debug(
                    "%s proxying: %s", service_name, json.dumps(data, indent=2)
                )
                await target_websocket.send(json.dumps(data))
            except websockets.exceptions.ConnectionClosed:
                logging.exception(
                    "%s Connection closed, stopping proxy task.", service_name
                )
                break

    async def create_proxy(self) -> None:
        """
        Create bi directional connection between client websocket and server websocket.

        """
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.bearer_token}",
        }
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        async with websockets.connect(
            self.liveapi_service_url,
            additional_headers=headers,
            ssl=ssl_context,
        ) as server_websocket:
            self.server_websocket = server_websocket
            self.client_to_server_task = asyncio.create_task(
                self.proxy_task(self.client_websocket, server_websocket, "c->s")
            )
            logging.info("client to server connection established.")
            self.server_to_client_task = asyncio.create_task(
                self.proxy_task(server_websocket, self.client_websocket, "s->c")
            )
            logging.info("server to client connection established.")
            # Wait for either of the proxy tasks to complete (which happens on connection close).
            # The `async with` block will handle closing the server_websocket.
            gather_results = await asyncio.gather(
                self.client_to_server_task,
                self.server_to_client_task,
                return_exceptions=True,
            )
            logging.info("Both task ended, connection closed.")
            for idx, result in gather_results:
                if isinstance(result, Exception):
                    logging.exception("service %s end with exception %s", idx, result)
                else:
                    logging.info("service %s end with result %s", idx, result)

    async def start_websocket(self) -> None:
        """
        Start the websocket connection between client and the server.

        """
        creds = get_credentials.get_credentials()
        self.bearer_token = creds.token
        self.expire_time: datetime.datetime = creds.expiry
        if self.expire_time.tzinfo is None:
            self.expire_time = self.expire_time.replace(tzinfo=datetime.timezone.utc)
        # Schedule the token refresh 60 seconds before it expires.
        wait_time = (
            self.expire_time - datetime.datetime.now(datetime.timezone.utc)
        ).total_seconds() - 60
        # Ensure we don't sleep for a negative duration
        wait_time = max(0, wait_time)

        self.update_cred_task = asyncio.create_task(
            self.update_websocket_creds(wait_time)
        )
        self.connection_handler = asyncio.create_task(self.create_proxy())
        await self.connection_handler

    async def end_websocket(self) -> None:
        if self.update_cred_task:
            self.update_cred_task.cancel()
            try:
                await self.update_cred_task
            except asyncio.CancelledError:
                pass  # Cancellation is expected
            self.update_cred_task = None

        if self.connection_handler:
            self.connection_handler.cancel()
            try:
                await self.connection_handler
            except asyncio.CancelledError:
                pass  # Cancellation is expected
            self.connection_handler = None

    async def update_websocket_creds(self, wait_time: float) -> None:
        """
        Update the cred token after the given wait_time.

        Args:
            wait_time (float): _description_
        """
        await asyncio.sleep(wait_time)

        if not self.server_websocket:
            return

        logging.info(
            "Updating bearer token for session: %s in %s seconds",
            self.session_id,
            wait_time,
        )

        creds = get_credentials.get_credentials()
        self.bearer_token = creds.token
        self.expire_time: datetime.datetime = creds.expiry
        if self.expire_time.tzinfo is None:
            self.expire_time = self.expire_time.replace(tzinfo=datetime.timezone.utc)

        # Construct the message to update the token
        update_token_message = json.dumps({"access_token": self.bearer_token})

        try:
            print("Updating bearer token for session:", self.session_id)
            await self.server_websocket.send(update_token_message)
        except Exception as e:
            print(f"Error sending updated token for session {self.session_id}: {e}")
            # You might want to handle connection errors here, e.g., by trying to reconnect.
            return

        # Schedule the next update
        next_wait_time = (
            self.expire_time - datetime.datetime.now(datetime.timezone.utc)
        ).total_seconds() - 60
        next_wait_time = max(0, next_wait_time)

        self.update_cred_task = asyncio.create_task(
            self.update_websocket_creds(next_wait_time)
        )
