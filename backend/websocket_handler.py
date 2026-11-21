"""Proxies one browser WebSocket to the upstream Live API WebSocket."""

import asyncio
import json
import logging as std_logging
import ssl
import time
from collections.abc import Awaitable, Callable

import certifi
import websockets
from absl import logging

import get_credentials

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
# Most bytes of browser messages held while the upstream connection opens,
# when nothing pushes back on the browser yet. The setup message is the only
# large one: at most ~46 MB, with a 20 MB avatar image and a 5-minute voice
# sample in base64. A browser that sends more is closed with 1009.
MAX_PENDING_CLIENT_BYTES = 64 * 1024 * 1024
# Seconds between pings to the Live API, and how long to wait for each pong.
DEFAULT_KEEPALIVE_S = 20
# How long to wait for upstream to acknowledge a close, including the one sent
# after a missed pong. A dead upstream is detected within
# 2 * keepalive + this many seconds.
UPSTREAM_CLOSE_TIMEOUT_S = 10
# How long the upstream WebSocket handshake may take (websockets' default too).
UPSTREAM_OPEN_TIMEOUT_S = 10
# Close codes that must not appear in a close frame (RFC 6455, section 7.4.1).
_RESERVED_CLOSE_CODES = frozenset({1005, 1006, 1015})
# A close frame carries at most 123 bytes of reason after the 2-byte code.
_MAX_CLOSE_REASON_BYTES = 123
_DEBUG_PREVIEW_CHARS = 300
# websockets logs every handshake header at debug level, the Authorization
# header with the access token included, and --debug sets the root logger to
# debug. The upstream connection logs here instead, a logger kept at INFO.
_UPSTREAM_LOGGER = std_logging.getLogger("websockets.client.upstream")
_UPSTREAM_LOGGER.setLevel(std_logging.INFO)


class _NoRedirectConnect(websockets.connect):
    """websockets.connect that fails on redirects instead of following them.

    websockets follows up to 10 redirects and sends the same headers to each
    new host, so a redirect from an allowed host would hand the access token to
    a host that --allowed_host_suffixes never checked. The Live API doesn't
    redirect, so a redirect is reported as the handshake error it came with.
    """

    def process_redirect(self, exc: Exception) -> Exception | str:
        return exc


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
        keepalive_s: float | None = DEFAULT_KEEPALIVE_S,
        on_client_closed: Callable[[], Awaitable[object]] | None = None,
    ) -> None:
        self.session_id = session_id
        self.liveapi_service_url = liveapi_service_url
        self.client_websocket = client_websocket
        self.server_websocket = None
        self.debug_mode = debug_mode
        # Upstream ping interval and pong timeout; None disables pings.
        self.keepalive_s = keepalive_s
        self.connection_handler: asyncio.Task | None = None
        # Called once the browser leg has closed, before the upstream close
        # handshake, which can take up to UPSTREAM_CLOSE_TIMEOUT_S.
        self.on_client_closed = on_client_closed
        self.client_closed = False
        # How the upstream connection ended, for relaying to the browser.
        self.close_code: int | None = None
        self.close_reason: str = ""
        # Messages and characters forwarded per direction, for the summary
        # logged when the session ends.
        self.traffic = {"c->s": [0, 0], "s->c": [0, 0]}
        self.started_at: float | None = None
        logging.info("Websocket handler initialized for session: %s", self.session_id)

    async def proxy_task(
        self, source_websocket, target_websocket, service_name: str, pending=()
    ) -> None:
        """Forwards pending, then messages from source to target, until either side closes.

        Messages are forwarded as-is, without parsing: video frames are large,
        and re-encoding them cost more CPU than the rest of the proxy combined.
        The one change is that binary frames that hold UTF-8 text (the Live API
        sends its JSON that way) become text frames, since the browser client
        only handles text frames.
        """
        for message in pending:
            if not await self._forward(message, target_websocket, service_name):
                return
        while True:
            try:
                message = await source_websocket.recv()
            except websockets.exceptions.ConnectionClosed:
                if source_websocket is self.client_websocket:
                    self.client_closed = True
                logging.info(
                    "%s: source closed for session %s", service_name, self.session_id
                )
                return
            if not await self._forward(message, target_websocket, service_name):
                return

    async def _forward(self, message, target_websocket, service_name: str) -> bool:
        """Sends one message to target; False if target has closed."""
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
        # The target closed; aiohttp and websockets raise different types.
        except Exception as e:
            if target_websocket is self.client_websocket:
                self.client_closed = True
            logging.info(
                "%s: target closed for session %s (%s)",
                service_name,
                self.session_id,
                e,
            )
            return False
        counts = self.traffic[service_name]
        counts[0] += 1
        counts[1] += len(message)
        return True

    def _connect_upstream(self, token: str | None):
        options = {
            "max_size": MAX_MESSAGE_BYTES,
            "ping_interval": self.keepalive_s,
            "ping_timeout": self.keepalive_s,
            "open_timeout": UPSTREAM_OPEN_TIMEOUT_S,
            "close_timeout": UPSTREAM_CLOSE_TIMEOUT_S,
            "logger": _UPSTREAM_LOGGER,
        }
        if token is not None:
            options["additional_headers"] = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            }
        if self.liveapi_service_url.startswith("wss://"):
            options["ssl"] = ssl.create_default_context(cafile=certifi.where())
        return _NoRedirectConnect(self.liveapi_service_url, **options)

    async def _open_upstream(self):
        """Opens the upstream connection; None (with close_code set) if it fails.

        A failed token fetch raises instead, and its message reaches the browser.
        """
        token = None
        if not self.liveapi_service_url.startswith("ws://"):
            token = await asyncio.to_thread(get_credentials.get_access_token)
        try:
            return await self._connect_upstream(token.token if token else None)
        except Exception as e:
            self.close_code = 1011
            self.close_reason = describe_connect_error(e)
            logging.warning(
                "Upstream connection failed for session %s: %s",
                self.session_id,
                self.close_reason,
            )
            return None

    async def _read_client_while_connecting(self, messages: list) -> None:
        """Collects browser messages (the setup) until cancelled or it closes.

        Returns early, with close_code set, once they would exceed
        MAX_PENDING_CLIENT_BYTES.
        """
        pending_bytes = 0
        while True:
            try:
                message = await self.client_websocket.recv()
            except websockets.exceptions.ConnectionClosed:
                self.client_closed = True
                return
            pending_bytes += len(message)
            if pending_bytes > MAX_PENDING_CLIENT_BYTES:
                self.close_code = 1009
                self.close_reason = (
                    "Too much data sent before the Live API connection opened"
                )
                return
            messages.append(message)

    async def _connect_while_watching_client(self, messages: list):
        """Opens upstream unless the browser leaves first; returns the connection.

        The token fetch and handshake can take many seconds. Reading the
        browser meanwhile answers its Close frame, and ends the attempt so the
        session's --max_sessions slot frees at once; otherwise it was held
        until the upstream connection opened (or timed out) and closed again.
        """
        watch = asyncio.create_task(self._read_client_while_connecting(messages))
        connect = asyncio.create_task(self._open_upstream())
        waited = False
        try:
            await asyncio.wait([watch, connect], return_when=asyncio.FIRST_COMPLETED)
            waited = True
        finally:
            # Cancelling recv() loses no message, in aiohttp or websockets.
            for task in (watch, connect):
                task.cancel()
            await asyncio.gather(watch, connect, return_exceptions=True)
            upstream = None
            if not connect.cancelled() and connect.exception() is None:
                upstream = connect.result()
            # Keep it only if the browser was still there when it opened
            # (watch had to be cancelled) and this task isn't being cancelled.
            if upstream is not None and not (waited and watch.cancelled()):
                await upstream.close(1001)
                upstream = None
        if self.client_closed:
            logging.info(
                "Browser left before the upstream connection opened for session %s",
                self.session_id,
            )
            return None
        if not watch.cancelled() and watch.exception() is None:
            # It returned with the browser still there: too much data.
            logging.warning(
                "Session %s: browser sent over %d bytes before the upstream "
                "connection opened; closing it",
                self.session_id,
                MAX_PENDING_CLIENT_BYTES,
            )
            return None
        for task in (watch, connect):
            error = None if task.cancelled() else task.exception()
            if error is not None:
                raise error
        return upstream

    async def create_proxy(self) -> None:
        """Connects upstream and relays in both directions until one side closes."""
        early_messages: list = []
        server_websocket = await self._connect_while_watching_client(early_messages)
        if server_websocket is None:
            return

        # The token is only checked at the handshake. Don't push a refreshed
        # one later: the Live API rejects {"access_token": ...} messages with
        # close code 1007, and GoAway reconnects fetch a new token anyway.
        self.server_websocket = server_websocket
        started_at = self.started_at = time.monotonic()
        client_to_server = asyncio.create_task(
            self.proxy_task(
                self.client_websocket, server_websocket, "c->s", early_messages
            )
        )
        server_to_client = asyncio.create_task(
            self.proxy_task(server_websocket, self.client_websocket, "s->c")
        )
        logging.info("Proxy established for session %s", self.session_id)
        upstream_close_code = 1000
        error: BaseException | None = None
        try:
            await asyncio.wait(
                [client_to_server, server_to_client],
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self.client_closed and self.on_client_closed:
                await self.on_client_closed()
        except asyncio.CancelledError:
            # The server is shutting down, or aiohttp dropped the handler
            # because the browser's connection went away. Neither is an
            # upstream failure, which is what `async with connection` would
            # have reported (1011) for any exception.
            upstream_close_code = 1001
            raise
        finally:
            for task in (client_to_server, server_to_client):
                task.cancel()
            # Retrieves an unexpected error from either direction, which would
            # otherwise vanish and end the session as a clean 1000.
            for result in await asyncio.gather(
                client_to_server, server_to_client, return_exceptions=True
            ):
                if isinstance(result, Exception) and error is None:
                    error = result
                    upstream_close_code = 1011
                    logging.error(
                        "Proxy failed for session %s",
                        self.session_id,
                        exc_info=result,
                    )
            # Completes the closing handshake, so the upstream close code is
            # known afterwards.
            await server_websocket.close(upstream_close_code)
            self.server_websocket = None
            self.close_code = server_websocket.close_code
            self.close_reason = server_websocket.close_reason or ""
            if error is not None:
                self.close_code = 1011
                self.close_reason = f"Proxy error: {type(error).__name__}"
            self._log_summary(time.monotonic() - started_at)

    def _log_summary(self, duration_s: float) -> None:
        (up_messages, up_chars), (down_messages, down_chars) = (
            self.traffic["c->s"],
            self.traffic["s->c"],
        )
        logging.info(
            "Session %s ended after %.1f s (upstream close %s %s): "
            "%d messages / %.1f MB to the browser, %d messages / %.1f MB upstream",
            self.session_id,
            duration_s,
            self.close_code,
            self.close_reason,
            down_messages,
            down_chars / 1e6,
            up_messages,
            up_chars / 1e6,
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
        task, self.connection_handler = self.connection_handler, None
        # A finished task's outcome already went to start_websocket's caller;
        # awaiting it again would re-raise its error during cleanup.
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass  # Cancellation is expected.
