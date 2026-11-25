"""Proxies one browser WebSocket to the upstream Live API WebSocket."""

import asyncio
import json
import logging as std_logging
import ssl
import time
import urllib.request
from collections.abc import Awaitable, Callable

import certifi
import websockets
import websockets.uri
from absl import logging

import get_credentials

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
# Most bytes of browser messages held while the upstream connection opens,
# when nothing pushes back on the browser yet. The setup message is the only
# large one: at most ~46 MB, with a 20 MB avatar image and a 5-minute voice
# sample in base64. A browser that sends more is closed with 1009.
MAX_PENDING_CLIENT_BYTES = 64 * 1024 * 1024
# Charged per held message on top of its length. A tiny message costs ~60
# bytes of memory for 1-2 bytes of payload, so counting payload alone let a
# flood of small frames hold ~30x the cap. The app sends only its setup
# before the Live API answers, so this costs real sessions nothing.
PENDING_MESSAGE_OVERHEAD_BYTES = 1024
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
# Most characters of an upstream handshake error kept for the log line. The
# body can be a whole HTML error page (up to websockets' 1 MiB limit); the
# browser sees only the first 123 bytes anyway.
_MAX_CONNECT_ERROR_CHARS = 300
# In the close reason the Live API sends, with code 1008, after the setup
# message when the handshake's token is invalid (it doesn't refuse the
# handshake itself): "Request had invalid authentication credentials. ..."
_INVALID_TOKEN_REASON = "invalid authentication credentials"
# The browser's close reason when no access token could be fetched.
CREDENTIALS_ERROR_REASON = (
    "Server could not get Google Cloud credentials; see the server log"
)
# What send() raises once its connection has closed: websockets raises
# ConnectionClosed, aiohttp ClientConnectionResetError (a ConnectionResetError).
_TARGET_CLOSED_ERRORS = (websockets.ConnectionClosed, ConnectionError)
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


def _one_line(text: str) -> str:
    """Collapses whitespace and cuts text to _MAX_CONNECT_ERROR_CHARS."""
    text = " ".join(text.split())
    if len(text) <= _MAX_CONNECT_ERROR_CHARS:
        return text
    return text[: _MAX_CONNECT_ERROR_CHARS - 3].rstrip() + "..."


def describe_connect_error(error: Exception) -> str:
    """Turns an upstream handshake failure into a one-line, user-facing reason.

    HTTP and WebSocket protocol errors keep their text, the Live API's own
    message included. Others, such as a refused TCP connection, can name
    internal hosts, proxies or files, so the browser gets only their type;
    connect_error_detail() has the rest for the log.
    """
    status = getattr(getattr(error, "response", None), "status_code", None)
    if status is not None or isinstance(
        error, (websockets.WebSocketException, TimeoutError)
    ):
        return connect_error_detail(error)
    return f"Could not connect to the Live API ({type(error).__name__}); see the server log"


_SENSITIVE_HEADER_NAMES = frozenset(
    {"authorization", "proxy-authorization", "cookie", "set-cookie"}
)


def connect_error_detail(error: Exception) -> str:
    """An upstream handshake failure as one line for the server log."""
    if isinstance(error, websockets.InvalidProxy):
        # Its text repeats the proxy URL, which can hold a user and password.
        return _one_line(f"Invalid proxy setting: {error.msg}")
    if isinstance(error, websockets.InvalidHeaderValue) or (
        isinstance(error, websockets.InvalidHeader)
        and error.name.lower() in _SENSITIVE_HEADER_NAMES
    ):
        # Its text repeats the header value, which can hold a bearer token or
        # proxy credentials.
        kind = (
            "missing"
            if error.value is None
            else "empty"
            if error.value == ""
            else "invalid"
        )
        return _one_line(f"{type(error).__name__}: {kind} {error.name} header")
    if isinstance(error, websockets.ProxyError):
        # InvalidProxyStatus carries the proxy's response, not the Live API's.
        return _one_line(f"{type(error).__name__}: {error}")
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        return _one_line(f"{type(error).__name__}: {error}")
    body = getattr(response, "body", b"") or b""
    detail = body.decode("utf-8", errors="replace")
    try:
        # Google APIs return {"error": {"message": ...}} on handshake errors.
        detail = str(json.loads(detail)["error"]["message"])
    except (ValueError, KeyError, TypeError):
        pass
    detail = _one_line(detail)
    return f"Upstream HTTP {status}: {detail}" if detail else f"Upstream HTTP {status}"


def upstream_proxy(url: str) -> str | None:
    """The proxy for a wss:// URL from the environment, as the token fetch uses.

    Matches websockets' priority (wss_proxy, socks_proxy, https_proxy) and
    no_proxy bypass, and also falls back to all_proxy as requests (google-auth)
    does. An HTTP proxy gets a CONNECT tunnel, so the token stays inside TLS; a
    SOCKS one needs the python-socks package. Whitespace-only settings are
    treated as unset; a proxy without a scheme (proxy.corp:3128) defaults to
    http://, or socks5h:// when it came from socks_proxy.
    """
    uri = websockets.uri.parse_uri(url)
    if urllib.request.proxy_bypass(f"{uri.host}:{uri.port}"):
        return None
    proxies = urllib.request.getproxies()
    schemes = (
        ("wss", "socks", "https", "all")
        if uri.secure
        else ("ws", "socks", "https", "http", "all")
    )
    for scheme in schemes:
        proxy = (proxies.get(scheme) or "").strip()
        if not proxy:
            continue
        if scheme == "socks" and proxy.lower().startswith("http://"):
            return "socks5h://" + proxy[7:]
        if "://" not in proxy:
            default_scheme = "socks5h" if scheme == "socks" else "http"
            return f"{default_scheme}://{proxy}"
        return proxy
    return None


def _abort_websocket(ws) -> None:
    """Closes a websockets connection's transport immediately without awaiting."""
    transport = getattr(ws, "transport", None)
    if transport is not None:
        transport.abort()


def _upstream_close_info(ws, *, aborted: bool) -> tuple[int | None, str]:
    """Reads the upstream close code and reason, even right after abort()."""
    code = ws.close_code
    reason = ws.close_reason or ""
    if code is None:
        close_rcvd = getattr(getattr(ws, "protocol", None), "close_rcvd", None)
        if close_rcvd is not None:
            code = close_rcvd.code
            reason = close_rcvd.reason or ""
        elif aborted:
            code = 1006
    return code, reason


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
        # The token the upstream connection opened with, if any.
        self.upstream_token: get_credentials.AccessToken | None = None
        logging.info("Websocket handler initialized for session: %s", self.session_id)

    async def proxy_task(
        self, source_websocket, target_websocket, service_name: str, pending=()
    ) -> None:
        """Forwards pending, then messages from source to target, until either side closes.

        Messages are forwarded as-is, without parsing: video frames are large,
        and re-encoding them cost more CPU than the rest of the proxy combined.
        The one change is that upstream (s->c) binary frames that hold UTF-8
        text (the Live API sends its JSON that way) become text frames, since
        the browser client only handles text frames.
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
        if service_name == "s->c" and isinstance(message, bytes):
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
        # The target closed. Anything else is a bug: it propagates, and
        # create_proxy logs it and ends the session with 1011.
        except _TARGET_CLOSED_ERRORS as e:
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
            # The local gateway (ws://127.0.0.1) never goes through a proxy.
            "proxy": None,
        }
        if token is not None:
            options["additional_headers"] = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            }
        if self.liveapi_service_url.startswith("wss://"):
            options["ssl"] = ssl.create_default_context(cafile=certifi.where())
            options["proxy"] = upstream_proxy(self.liveapi_service_url)
        return _NoRedirectConnect(self.liveapi_service_url, **options)

    async def _open_upstream(self):
        """Opens the upstream connection; None (with close_code set) if it fails."""
        token = None
        if not self.liveapi_service_url.startswith("ws://"):
            try:
                token = await get_credentials.fetch_access_token()
            except Exception as e:
                # Its text has each source's error: gcloud's stderr, file
                # paths. Only the log gets it.
                self.close_code = 1011
                self.close_reason = CREDENTIALS_ERROR_REASON
                logging.warning(
                    "No access token for session %s: %s", self.session_id, e
                )
                return None
        try:
            try:
                upstream = await self._connect_upstream(token.token if token else None)
            except websockets.InvalidStatus as e:
                if token is None or e.response.status_code != 401:
                    raise
                token = await self._replace_rejected_token(token)
                if token is None:
                    raise
                upstream = await self._connect_upstream(token.token)
            self.upstream_token = token
            return upstream
        except Exception as e:
            self.close_code = 1011
            self.close_reason = describe_connect_error(e)
            logging.warning(
                "Upstream connection failed for session %s: %s",
                self.session_id,
                connect_error_detail(e),
            )
            return None

    def _drop_rejected_token(self, rejected, how: str) -> None:
        """Drops a token the upstream rejected from the cache.

        A cached token can stop working before its expiry: revoked, the ADC
        account changed, or a lifetime that was only assumed. Kept, it would
        fail every session until then.
        """
        get_credentials.invalidate(rejected)
        logging.warning(
            "Upstream rejected the access token from %s (%s) for session %s; "
            "dropped it from the cache",
            rejected.source,
            how,
            self.session_id,
        )

    async def _replace_rejected_token(self, rejected):
        """A token to retry with after the upstream answered 401; None if none.

        The rejected token is dropped from the cache, and the handshake is
        retried once with a different token.
        """
        self._drop_rejected_token(rejected, "HTTP 401")
        try:
            token = await get_credentials.fetch_access_token()
        except Exception as e:
            logging.warning(
                "No other access token for session %s: %s", self.session_id, e
            )
            return None
        if token.token == rejected.token:
            # A source can keep handing out its own cached copy.
            logging.warning(
                "Token sources returned the rejected token again for session %s",
                self.session_id,
            )
            return None
        return token

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
            message_bytes = (
                len(message)
                if isinstance(message, bytes) or message.isascii()
                else len(message.encode("utf-8"))
            )
            pending_bytes += message_bytes + PENDING_MESSAGE_OVERHEAD_BYTES
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
            try:
                await asyncio.gather(watch, connect, return_exceptions=True)
            except BaseException:
                for task in (watch, connect):
                    if task.done() and not task.cancelled():
                        task.exception()
                if (
                    connect.done()
                    and not connect.cancelled()
                    and connect.exception() is None
                ):
                    upstream = connect.result()
                    if upstream is not None:
                        _abort_websocket(upstream)
                raise
            upstream = None
            if not connect.cancelled() and connect.exception() is None:
                upstream = connect.result()
            # Keep it only if the browser was still there when it opened
            # (watch had to be cancelled) and this task isn't being cancelled.
            if upstream is not None and not (waited and watch.cancelled()):
                try:
                    await upstream.close(1001)
                except BaseException:
                    _abort_websocket(upstream)
                    raise
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
            aborted = False
            try:
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
            except BaseException:
                # A second cancel (e.g. end_websocket() during shutdown while
                # upstream close is awaiting) interrupts close() before
                # websockets aborts the socket; tear it down immediately so it
                # cannot leak open.
                aborted = True
                _abort_websocket(server_websocket)
                raise
            finally:
                # If cancellation interrupted gather(), still retrieve any
                # finished relay task's exception so it is logged and not lost.
                for task in (client_to_server, server_to_client):
                    if task.done() and not task.cancelled():
                        exc = task.exception()
                        if isinstance(exc, Exception) and error is None:
                            error = exc
                            logging.error(
                                "Proxy failed for session %s",
                                self.session_id,
                                exc_info=exc,
                            )
                self.server_websocket = None
                self.close_code, self.close_reason = _upstream_close_info(
                    server_websocket, aborted=aborted
                )
                if (
                    self.upstream_token is not None
                    and self.close_code == 1008
                    and _INVALID_TOKEN_REASON in self.close_reason.lower()
                ):
                    self._drop_rejected_token(self.upstream_token, "close code 1008")
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
