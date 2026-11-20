"""Proxies one browser WebSocket to the upstream Live API WebSocket."""

import asyncio
import datetime
import json
import ssl

import certifi
import websockets
from absl import logging

import get_credentials

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
# Close codes that must not appear in a close frame (RFC 6455, section 7.4.1).
_RESERVED_CLOSE_CODES = frozenset({1005, 1006, 1015})
# A close frame carries at most 123 bytes of reason after the 2-byte code.
_MAX_CLOSE_REASON_BYTES = 123
# Lower bound between token pushes, so a token that's already near expiry
# can't turn the refresh loop into a busy loop.
_MIN_TOKEN_REFRESH_INTERVAL_S = 30
_DEBUG_PREVIEW_CHARS = 300


def truncate_close_reason(reason: str) -> str:
    """Cuts reason to fit a close frame without splitting a UTF-8 sequence."""
    encoded = reason.encode("utf-8")
    if len(encoded) <= _MAX_CLOSE_REASON_BYTES:
        return reason
    return encoded[:_MAX_CLOSE_REASON_BYTES].decode("utf-8", errors="ignore")


def describe_connect_error(error: Exception) -> str:
    """Turns an upstream handshake failure into a one-line, user-facing reason."""
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        return f"{type(error).__name__}: {error}"
    body = getattr(response, "body", b"") or b""
    detail = body.decode("utf-8", errors="replace").strip()
    try:
        # Google APIs return {"error": {"message": ...}} on handshake errors.
        detail = json.loads(detail)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        pass
    return f"Upstream HTTP {status}: {detail}" if detail else f"Upstream HTTP {status}"


class WebsocketHandler:
    """Relays messages between the browser and the Live API for one session."""

    def __init__(
        self,
        liveapi_service_url,
        session_id,
        client_websocket,
        debug_mode=False,
    ) -> None:
        self.session_id = session_id
        self.liveapi_service_url = liveapi_service_url
        self.client_websocket = client_websocket
        self.server_websocket = None
        self.debug_mode = debug_mode
        self.connection_handler: asyncio.Task | None = None
        # How the upstream connection ended, for relaying to the browser.
        self.close_code: int | None = None
        self.close_reason: str = ""
        logging.info("Websocket handler initialized for session: %s", self.session_id)

    async def proxy_task(
        self, source_websocket, target_websocket, service_name: str
    ) -> None:
        """Forwards messages from source to target until either side closes.

        Messages are forwarded as-is, without parsing: video frames are large,
        and re-encoding them cost more CPU than the rest of the proxy combined.
        The one change is that binary frames that hold UTF-8 text (the Live API
        sends its JSON that way) become text frames, since the browser client
        only handles text frames.
        """
        while True:
            try:
                message = await source_websocket.recv()
            except websockets.exceptions.ConnectionClosed:
                logging.info(
                    "%s: source closed for session %s", service_name, self.session_id
                )
                return
            if isinstance(message, bytes):
                try:
                    message = message.decode("utf-8")
                except UnicodeDecodeError:
                    pass
            if self.debug_mode:
                preview = (
                    message[:_DEBUG_PREVIEW_CHARS]
                    if isinstance(message, str)
                    else "<binary>"
                )
                logging.debug(
                    "%s proxying %d bytes: %s", service_name, len(message), preview
                )
            try:
                await target_websocket.send(message)
            except (
                Exception
            ) as e:  # The target closed; aiohttp and websockets raise different types.
                logging.info(
                    "%s: target closed for session %s (%s)",
                    service_name,
                    self.session_id,
                    e,
                )
                return

    def _connect_upstream(self, token: str | None):
        if token is None:
            return websockets.connect(
                self.liveapi_service_url, max_size=MAX_MESSAGE_BYTES
            )
        return websockets.connect(
            self.liveapi_service_url,
            additional_headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            ssl=ssl.create_default_context(cafile=certifi.where()),
            max_size=MAX_MESSAGE_BYTES,
        )

    async def create_proxy(self) -> None:
        """Connects upstream and relays in both directions until one side closes."""
        token = None
        if not self.liveapi_service_url.startswith("ws://"):
            token = await asyncio.to_thread(get_credentials.get_access_token)

        try:
            connection = await self._connect_upstream(token.token if token else None)
        except Exception as e:
            self.close_code = 1011
            self.close_reason = describe_connect_error(e)
            logging.warning(
                "Upstream connection failed for session %s: %s",
                self.session_id,
                self.close_reason,
            )
            return

        refresh_task = None
        async with connection as server_websocket:
            self.server_websocket = server_websocket
            if token:
                refresh_task = asyncio.create_task(
                    self._refresh_token_loop(token.expiry)
                )
            client_to_server = asyncio.create_task(
                self.proxy_task(self.client_websocket, server_websocket, "c->s")
            )
            server_to_client = asyncio.create_task(
                self.proxy_task(server_websocket, self.client_websocket, "s->c")
            )
            logging.info("Proxy established for session %s", self.session_id)
            try:
                await asyncio.wait(
                    [client_to_server, server_to_client],
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for task in (client_to_server, server_to_client, refresh_task):
                    if task:
                        task.cancel()
        # Leaving the `async with` completed the closing handshake, so the
        # upstream close code is known.
        self.server_websocket = None
        self.close_code = server_websocket.close_code
        self.close_reason = server_websocket.close_reason or ""
        logging.info(
            "Proxy closed for session %s (upstream close code %s %s)",
            self.session_id,
            self.close_code,
            self.close_reason,
        )

    def client_close_frame(self) -> tuple[int, str]:
        """The close code and reason to send the browser, mirroring upstream."""
        code, reason = self.close_code, self.close_reason
        if code is None or code == 1005:
            code = 1000
        elif code in _RESERVED_CLOSE_CODES:
            code, reason = 1011, reason or "Upstream connection lost"
        return code, truncate_close_reason(reason)

    async def start_websocket(self) -> None:
        """Runs the proxy until the session ends."""
        self.connection_handler = asyncio.create_task(self.create_proxy())
        await self.connection_handler

    async def end_websocket(self) -> None:
        if self.connection_handler:
            self.connection_handler.cancel()
            try:
                await self.connection_handler
            except asyncio.CancelledError:
                pass  # Cancellation is expected.
            self.connection_handler = None

    async def _refresh_token_loop(self, expiry: datetime.datetime) -> None:
        """Pushes a fresh access token upstream a minute before each expiry."""
        while True:
            remaining = (
                expiry - datetime.datetime.now(datetime.timezone.utc)
            ).total_seconds()
            await asyncio.sleep(max(_MIN_TOKEN_REFRESH_INTERVAL_S, remaining - 60))
            try:
                token = await asyncio.to_thread(get_credentials.get_access_token)
            except Exception:
                logging.exception(
                    "Token refresh failed for session %s", self.session_id
                )
                continue
            server_websocket = self.server_websocket
            if server_websocket is None:
                return
            logging.info("Updating bearer token for session %s", self.session_id)
            try:
                await server_websocket.send(json.dumps({"access_token": token.token}))
            except websockets.exceptions.ConnectionClosed:
                return
            expiry = token.expiry
