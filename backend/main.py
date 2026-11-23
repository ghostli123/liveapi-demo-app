"""Backend for the Gemini Live API demo: serves the frontend and proxies sessions."""

import asyncio
import functools
import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
from typing import Any, TypeGuard
import urllib.parse

from aiohttp import web
from absl import app, flags, logging
from google import genai
from google.genai import errors as genai_errors
import websockets

import get_credentials
import session_management
import websocket_handler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Navigate to the frontend folder (assuming it's a sibling to the backend folder)
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
COMMON_BAG_PROXY_PAR = os.path.join(BASE_DIR, "common_bag_ws_proxy.par")
# Constants
SERVICE_URL = "wss://{host}/ws/google.cloud.aiplatform.internal.LlmBidiService/BidiGenerateContent"
COMMON_BAG_ENVIRONMENTS = frozenset(
    {
        "autopush-common",
        "staging-common",
        "autopush-vertex-bidi",
        "autopush-vertex-us-bidi",
    }
)
# Global Vertex hosts. For the "us" and "eu" multi-regions they map to
# {prefix}aiplatform.{location}.rep.{rest}.
VERTEX_HOSTS = frozenset(
    {
        "autopush-aiplatform.sandbox.googleapis.com",
        "staging-aiplatform.sandbox.googleapis.com",
        "aiplatform.googleapis.com",
    }
)
DEFAULT_PROJECT_ID = "live-api-webrtc-testing"
# Preview models are served from the global endpoint only, whatever the
# Live API session's location.
FR_SIMULATOR_LOCATION = "global"
FR_SIMULATOR_PROMPT = """
You're a function response simulator, your job is to provide a simulated function response, you'll be provided with all function names and their descriptions.

Then you'll be given a function name to be triggered and input arguments. You should generate a function response based your understanding of the function.

If a function response should follow a specific format, it will be described in the function description. If you cannot find any function response format, just return a string that you think best fit the function response.
If there are any issues with the arguments, such as type is incorrect, required arguments not provided, in these kind of cases, you should return a string like raise Exception.

"""
# Deadline for one fr_generate request, waiting for its turn included. Under
# the browser's 30 s (FUNCTION_RESPONSE_TIMEOUT_MS in script.js), so the user
# sees why the call failed.
FR_SIMULATOR_TIMEOUT_S = 25
# Max size of one WebSocket message from the browser (custom avatar images are large).
MAX_CLIENT_MESSAGE_BYTES = 64 * 1024 * 1024
# A session record is removed if its WebSocket doesn't open within this time.
PENDING_SESSION_TTL_S = 60
# How long shutdown waits for handlers after closing sessions. Cloud Run sends
# SIGKILL 10 s after SIGTERM.
SHUTDOWN_TIMEOUT_S = 5

_LOCATION_RE = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

SESSION_MANAGER = session_management.SessionManager()

# Flags
PROJECT_ID = flags.DEFINE_string(
    "project_id",
    None,
    "Google Cloud project for Live API sessions. Defaults to $GOOGLE_CLOUD_PROJECT, "
    f"then {DEFAULT_PROJECT_ID}.",
)
COMMON_BAG_WS_PORT = flags.DEFINE_integer(
    "common_bag_ws_port",
    8765,
    "Local WebSocket port for the Beyond common BAG Stubby gateway.",
)
ALLOWED_HOST_SUFFIXES = flags.DEFINE_list(
    "allowed_host_suffixes",
    [".googleapis.com"],
    "Upstream hosts the proxy may connect to. The proxy sends its access token "
    "to these hosts, so keep this list tight. Each entry is a domain that "
    "matches itself and its subdomains (example.com and .example.com both "
    "match live.example.com, not evilexample.com).",
)
ALLOWED_HOSTS = flags.DEFINE_list(
    "allowed_hosts",
    [],
    "Extra host names browsers may use to reach this server, e.g. a custom "
    "domain or the public host of a proxy that rewrites Host. Always allowed: "
    "localhost, IP addresses, this machine's names, and *.run.app on Cloud Run. "
    "'*' allows any Host header, which disables DNS-rebinding protection; "
    "pages on other origins still need their host listed by name. A port in "
    "an entry admits only pages on that port.",
)
FR_SIMULATOR_MODEL = flags.DEFINE_string(
    "fr_simulator_model",
    "gemini-3-flash-preview",
    "Model that simulates function responses. The Live model waits for each "
    "response, so a fast model keeps the conversation moving.",
)
FR_SIMULATOR_THINKING = flags.DEFINE_string(
    "fr_simulator_thinking_level",
    "low",
    "Thinking level for the function-response simulator (Gemini 3 models). "
    "Empty uses the model's default. 'low' answers in ~1 s instead of ~6 s.",
)
WS_HEARTBEAT_S = flags.DEFINE_float(
    "ws_heartbeat_s",
    20,
    "Seconds between WebSocket pings on both legs of a session, browser and "
    "upstream. Keeps quiet sessions (mic muted, text only) from being dropped "
    "by proxies and load balancers that close idle connections, and detects "
    "dead peers: the session ends if the browser doesn't answer a ping within "
    "half this time, or upstream within this time. 0 disables pings.",
    lower_bound=0,
)
MAX_SESSIONS = flags.DEFINE_integer(
    "max_sessions",
    0,
    "Most sessions the server holds at once, counting ones whose WebSocket "
    "hasn't opened yet. Further /api/control requests get 503 until a browser "
    "disconnects (its upstream connection may take up to 10 s more to close). "
    "Bounds the upstream connections and memory one instance can be made to "
    "use. 0 means no limit.",
    lower_bound=0,
)
IDLE_TIMEOUT_S = flags.DEFINE_integer(
    "idle_timeout_s",
    900,
    "Seconds without conversation or user input (typing, clicks, speech the "
    "model answers) after which the browser ends a session, so an abandoned "
    "tab doesn't hold its upstream connection and --max_sessions slot. The "
    "frontend enforces it, since the proxy can't tell: WebRTC media bypasses "
    "it, and avatar video and an open microphone stream while nobody is "
    "there. 0 disables.",
    lower_bound=0,
)
HOST = flags.DEFINE_string(
    "host",
    None,
    "Address to listen on. Defaults to every interface on Cloud Run ($K_SERVICE "
    "set) and to 127.0.0.1 elsewhere: the server has no login and starts "
    "sessions on its own credentials, so other machines on the network "
    "shouldn't reach it unless you say so. Use 0.0.0.0 (or :: for IPv6 too) "
    "to accept them, e.g. inside a Docker container.",
)
DEBUG = flags.DEFINE_bool(
    "debug", False, "Log at debug level, including a preview of every proxied message."
)


def project_id() -> str:
    return (
        PROJECT_ID.value or os.environ.get("GOOGLE_CLOUD_PROJECT") or DEFAULT_PROJECT_ID
    )


def _allowed_suffix_domain(entry: str) -> str:
    """One --allowed_host_suffixes entry as a bare domain; "" for a blank."""
    return entry.strip().lower().strip(".")


def _is_in_domain(host: str, domain: str) -> bool:
    # A plain endswith would let "googleapis.com" match "evilgoogleapis.com",
    # a host anyone can register, and hand it the access token.
    return bool(domain) and (host == domain or host.endswith("." + domain))


def _validate_allowed_host_suffixes(entries: list[str]) -> bool:
    for entry in entries:
        domain = _allowed_suffix_domain(entry)
        if domain and not _HOSTNAME_RE.fullmatch(domain):
            raise flags.ValidationError(
                f"invalid entry {entry!r}; expected a domain with at least two "
                "labels, e.g. .googleapis.com"
            )
    return True


# Checked when flags are parsed, so a typo stops the server at startup.
flags.register_validator(ALLOWED_HOST_SUFFIXES, _validate_allowed_host_suffixes)


def _validate_host(value: str | None) -> bool:
    if value is None:
        return True
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        pass
    # A single label ("localhost", this machine's name) is fine here.
    if re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?", value) or (
        _HOSTNAME_RE.fullmatch(value.lower())
    ):
        return True
    raise flags.ValidationError(
        f"invalid address {value!r}; expected an IP address or host name "
        "without a port, e.g. 0.0.0.0 (set the port with $PORT)"
    )


flags.register_validator(HOST, _validate_host)


def listen_host() -> str | None:
    """The address to bind; None means every interface (IPv4 and IPv6)."""
    if HOST.value is not None:
        return HOST.value
    return None if os.environ.get("K_SERVICE") else "127.0.0.1"


def resolve_ws_host(endpoint: Any, location: Any) -> str:
    """Maps the frontend's endpoint and location to the upstream WebSocket host.

    Raises:
      ValueError: the result would be a host outside --allowed_host_suffixes.
        Without this check, anyone who can reach the server could have it send
        its access token to a host of their choosing.
    """
    if not isinstance(endpoint, str) or not endpoint:
        raise ValueError("Missing endpoint")
    if endpoint in COMMON_BAG_ENVIRONMENTS:
        return endpoint
    if not isinstance(location, str) or not _LOCATION_RE.fullmatch(location):
        raise ValueError(f"Invalid location: {location!r}")

    if ".rep." in endpoint or endpoint.startswith("global-"):
        ws_host = endpoint
    elif endpoint in VERTEX_HOSTS and location in ("us", "eu"):
        prefix, rest = endpoint.split("aiplatform.", 1)
        ws_host = f"{prefix}aiplatform.{location}.rep.{rest}"
    elif endpoint in VERTEX_HOSTS and location == "global":
        ws_host = endpoint
    else:
        ws_host = f"{location}-{endpoint}"

    if not _HOSTNAME_RE.fullmatch(ws_host) or not any(
        _is_in_domain(ws_host, _allowed_suffix_domain(suffix))
        for suffix in ALLOWED_HOST_SUFFIXES.value
    ):
        raise ValueError(
            f"{ws_host!r} is not an allowed Live API host (see --allowed_host_suffixes)"
        )
    return ws_host


def upstream_url(ws_host: str) -> str:
    if ws_host in COMMON_BAG_ENVIRONMENTS:
        return f"ws://127.0.0.1:{COMMON_BAG_WS_PORT.value}/{ws_host}"
    return SERVICE_URL.format(host=ws_host)


def _json_error(message: str, status: int) -> web.Response:
    return web.json_response({"error": message}, status=status)


async def _read_json_object(request: web.Request) -> dict[str, Any] | None:
    # ValueError covers invalid JSON, invalid UTF-8 and integers over Python's
    # digit limit; RecursionError deep nesting; LookupError an unknown charset.
    try:
        body = await request.json()
    except (ValueError, RecursionError, LookupError):
        return None
    return body if isinstance(body, dict) else None


def _is_valid_session_id(session_id: Any) -> TypeGuard[str]:
    # fullmatch: with match, "$" also matches before a trailing newline.
    return isinstance(session_id, str) and bool(_SESSION_ID_RE.fullmatch(session_id))


# --- ADAPTER CLASS ---


class AiohttpToWebsocketsAdapter:
    """Gives an aiohttp WebSocketResponse the send/recv interface of a websockets connection."""

    def __init__(self, aio_ws: web.WebSocketResponse, request_path="/ws"):
        self.aio_ws = aio_ws
        self._path = request_path

    async def send(self, data):
        if isinstance(data, bytes):
            await self.aio_ws.send_bytes(data)
        else:
            await self.aio_ws.send_str(data)

    async def recv(self):
        msg = await self.aio_ws.receive()
        if msg.type in (web.WSMsgType.TEXT, web.WSMsgType.BINARY):
            return msg.data
        # CLOSE, CLOSING, CLOSED or ERROR: the browser side is gone.
        raise websockets.exceptions.ConnectionClosed(None, None)

    async def close(self, code=1000, reason=""):
        await self.aio_ws.close(code=code, message=reason.encode())

    @property
    def path(self):
        return self._path


# --- HANDLERS ---


async def aiohttp_websocket_handler(request: web.Request) -> web.StreamResponse:
    """Bridges a browser WebSocket to the upstream Live API session."""
    session_id = request.query.get("session_id")
    if not _is_valid_session_id(session_id):
        return web.Response(text="Missing or invalid session_id", status=400)

    session_handler = await SESSION_MANAGER.search_item(session_id)
    if not session_handler:
        return web.Response(text="No config record for session", status=404)
    if session_handler.websocket_handler:
        return web.Response(text="Session already has a WebSocket", status=409)

    heartbeat_s = WS_HEARTBEAT_S.value or None
    # aiohttp pings every heartbeat_s and closes the connection if the pong
    # takes longer than heartbeat_s / 2.
    ws = web.WebSocketResponse(
        max_msg_size=MAX_CLIENT_MESSAGE_BYTES, heartbeat=heartbeat_s
    )
    # Refused before the claim: a plain GET (a link preview, a curl) would fail
    # in ws.prepare, and that cleanup ends the browser's pending session.
    if not ws.can_prepare(request).ok:
        return web.Response(text="Expected a WebSocket upgrade request", status=400)
    wb_handler = websocket_handler.WebsocketHandler(
        upstream_url(session_handler.ws_host),
        session_id,
        AiohttpToWebsocketsAdapter(ws, request_path=request.path_qs),
        debug_mode=DEBUG.value,
        keepalive_s=heartbeat_s,
        # Frees the slot under --max_sessions without waiting for the upstream
        # close, so a resume's new session isn't refused meanwhile.
        on_client_closed=functools.partial(
            SESSION_MANAGER.release, session_id, session_handler
        ),
    )
    # Claimed before the first await (ws.prepare), so a second /ws for this
    # session gets 409 instead of a second upstream connection.
    if not await SESSION_MANAGER.claim_websocket(
        session_id, session_handler, wb_handler
    ):
        return web.Response(text="Session already has a WebSocket", status=409)
    try:
        await ws.prepare(request)
    except BaseException:
        await SESSION_MANAGER.delete_item(session_id, session_handler)
        raise

    try:
        await wb_handler.start_websocket()
        close_code, close_reason = wb_handler.client_close_frame()
    except Exception as e:
        logging.exception("Error in bridged websocket handler")
        close_code = 1011
        # Logged above; its text can name internal hosts or files.
        close_reason = f"Proxy error: {type(e).__name__}"
    finally:
        logging.info("WebSocket connection cleanup for session %s", session_id)
        # Always clean up the session to prevent memory leaks, however the
        # connection ended.
        await SESSION_MANAGER.delete_item(session_id, session_handler)

    # Relay how upstream ended the session (e.g. a quota or permission error),
    # which the frontend shows to the user.
    if not ws.closed:
        await ws.close(code=close_code, message=close_reason.encode("utf-8"))
    return ws


async def handle_fr_post_request(request: web.Request):
    """Simulates function responses with a Gemini chat, one per session.

    Objectives:
      fc_definition: stores the session's function declarations. No model
        call, so connecting doesn't wait on the simulator.
      fr_generate: asks the model for a plausible response to one call. The
        first request also gives the model the stored declarations.
    """
    request_body = await _read_json_object(request)
    if request_body is None:
        return _json_error("Request body must be a JSON object", 400)

    session_id = request_body.pop("session_id", None)
    if not _is_valid_session_id(session_id):
        return _json_error("Missing or invalid session_id", 400)
    chat_session = await SESSION_MANAGER.search_item(session_id)
    if not chat_session:
        return _json_error("Unknown session", 404)

    query_object = request_body.pop("objective", None)
    query = json.dumps(request_body)
    logging.debug("Received %s query for Gemini:\n%s", query_object, query)
    if query_object == "fc_definition":
        chat_session.fc_definitions = query
        return web.json_response({"response": "Function definitions stored."})
    if query_object != "fr_generate":
        return _json_error(f"Unknown query objective type {query_object!r}", 400)

    # One request at a time per session (see SessionBaseModel.fr_lock). The
    # checks run inside the lock: the session may end while a request waits.
    # The deadline covers the wait too: the genai client has no timeout, so a
    # call that never returns would hold the lock, and every later call,
    # forever. Cancelling leaves the chat as it was; it records a turn only
    # once the reply arrives.
    try:
        async with asyncio.timeout(FR_SIMULATOR_TIMEOUT_S):
            async with chat_session.fr_lock:
                if not chat_session.fr_session:
                    return _json_error(
                        f"Function response simulator unavailable ({chat_session.fr_error or 'not initialized'}); see the server log",
                        503,
                    )
                current_content = []
                send_definitions = (
                    chat_session.fc_definitions and not chat_session.fc_definitions_sent
                )
                if send_definitions:
                    current_content += [
                        genai.types.Part(text="The definition of the functions are:"),
                        genai.types.Part(text=chat_session.fc_definitions),
                    ]
                current_content += [
                    genai.types.Part(
                        text="Now generate function response this function call."
                    ),
                    genai.types.Part(text=query),
                ]
                try:
                    response = await _send_simulator_message(
                        chat_session.fr_session, current_content, session_id
                    )
                except Exception as e:
                    logging.exception("Function response simulator request failed")
                    return _json_error(_simulator_error(e), 502)
                if send_definitions:
                    chat_session.fc_definitions_sent = True
    except TimeoutError:
        logging.warning(
            "Function response simulator gave no answer within %s s (session %s)",
            FR_SIMULATOR_TIMEOUT_S,
            session_id,
        )
        return _json_error(
            f"Function response simulator didn't answer within {FR_SIMULATOR_TIMEOUT_S} s",
            504,
        )
    logging.debug("Sending back frontend with response:\n%s", response.text)
    return web.json_response({"response": response.text})


async def handle_control_request(request: web.Request):
    """Creates the server-side record for a session before its WebSocket opens."""
    request_body = await _read_json_object(request)
    if request_body is None:
        return _json_error("Request body must be a JSON object", 400)
    session_id = request_body.get("session_id")
    if not _is_valid_session_id(session_id):
        return _json_error("Missing or invalid session_id", 400)
    command = request_body.get("command")
    if command == "disconnect":
        # Sent by a browser that abandoned a session before opening its
        # WebSocket (e.g. Disconnect while connecting).
        removed = await SESSION_MANAGER.remove_pending(session_id)
        return web.json_response({"removed": removed})
    if command != "connect":
        return _json_error("Invalid command", 400)

    location = request_body.get("location")
    if isinstance(location, str):
        location = location.strip().lower()
    endpoint = request_body.get("endpoint")
    try:
        ws_host = resolve_ws_host(endpoint, location)
    except ValueError as e:
        return _json_error(str(e), 400)
    logging.info("Websocket host for session %s is set to: %s", session_id, ws_host)

    session_handler = await SESSION_MANAGER.search_item(session_id)
    if session_handler and session_handler.websocket_handler:
        return _json_error("Already running", 409)
    # Before the simulator init: a rejected connect shouldn't build a chat.
    try:
        await SESSION_MANAGER.check_can_add(session_id, MAX_SESSIONS.value)
    except session_management.SessionAddError as e:
        return _add_refused_response(session_id, e)

    fr_session, fr_error = None, ""
    try:
        fr_session = await asyncio.to_thread(initialize_gemini_chat_session)
    except Exception as err:
        # Only the type goes to the browser (see _simulator_error).
        fr_error = type(err).__name__
        logging.warning(
            "Skipping FR chat session init for endpoint %s: %s: %s",
            endpoint,
            fr_error,
            err,
        )
    session_handler = session_management.SessionBaseModel(
        session_id=session_id, ws_host=ws_host, fr_session=fr_session, fr_error=fr_error
    )
    # Checked again after the await above: a /ws may have attached meanwhile.
    try:
        added = await SESSION_MANAGER.add_unless_connected(
            session_id, session_handler, max_sessions=MAX_SESSIONS.value
        )
    except session_management.SessionAddError as e:
        return _add_refused_response(session_id, e)
    if not added:
        return _json_error("Already running", 409)
    session_handler.expiry_task = asyncio.create_task(
        _remove_if_never_connected(session_id, session_handler)
    )
    return web.json_response(
        {
            "status": "Session initialized.",
            "project_id": project_id(),
            "idle_timeout_s": IDLE_TIMEOUT_S.value,
        }
    )


async def _send_simulator_message(chat, content, session_id: str):
    """Sends one simulator turn; on HTTP 401 drops the rejected token and retries once.

    The genai client reuses one ChainCredentials instance across calls, so a
    revoked token would fail every simulator call until it expires. Dropping it
    from the shared cache forces ChainCredentials (and new Live API sessions)
    to fetch a fresh token on the retry; if the sources hand back the same
    token, the original 401 is raised instead of sending a duplicate request.
    """
    token_before = get_credentials.cached_token()
    try:
        return await chat.send_message(content)
    except genai_errors.APIError as e:
        if e.code != 401:
            raise
        # A call whose token was fetched inside send_message() had no cached
        # token before the call; read the cache again to catch it too.
        rejected = get_credentials.cached_token() or token_before
        if rejected is None:
            raise
        # If another caller already replaced the cached token while this call
        # was in flight, invalidate() is a no-op and fetch_access_token()
        # immediately returns the replacement without refetching.
        if token_before is not None and token_before.token != rejected.token:
            logging.warning(
                "Simulator rejected an earlier access token (HTTP 401) for session %s; "
                "retrying with the newer cached token from %s",
                session_id,
                rejected.source,
            )
            return await chat.send_message(content)
        get_credentials.invalidate(rejected)
        logging.warning(
            "Simulator rejected the access token from %s (HTTP 401) for session %s; "
            "dropped it from the cache",
            rejected.source,
            session_id,
        )
        try:
            replacement = await get_credentials.fetch_access_token()
        except Exception as fetch_err:
            logging.warning(
                "No other access token for simulator (session %s): %s",
                session_id,
                fetch_err,
            )
            raise e from None
        if replacement.token == rejected.token:
            logging.warning(
                "Token sources returned the rejected token again for simulator (session %s)",
                session_id,
            )
            raise
        return await chat.send_message(content)


def _simulator_error(error: Exception) -> str:
    """The browser's text for a failed simulator call; the log has the rest.

    A Gemini API error keeps its HTTP code and status (e.g. 429
    RESOURCE_EXHAUSTED). Other errors, a failed token fetch among them, carry
    gcloud's output, file paths or internal hosts, so only their type is shown.
    """
    if isinstance(error, genai_errors.APIError):
        return f"Function response simulator failed ({error.code} {error.status})"
    return f"Function response simulator failed ({type(error).__name__}); see the server log"


def _add_refused_response(
    session_id: str, error: session_management.SessionAddError
) -> web.Response:
    if not isinstance(error, session_management.SessionLimitError):
        # A disconnect arrived first; the browser no longer waits for this.
        logging.info("Refused session %s: %s", session_id, error)
        return _json_error(str(error), 409)
    logging.warning("Rejected session %s: %s", session_id, error)
    # The frontend retries 503s, which also covers a resume whose old
    # session hasn't been removed yet.
    response = _json_error(f"{error}; try again later", 503)
    response.headers["Retry-After"] = "1"
    return response


async def _remove_if_never_connected(
    session_id: str, session: session_management.SessionBaseModel
) -> None:
    """Drops a session record whose WebSocket never arrived, so it can't leak."""
    await asyncio.sleep(PENDING_SESSION_TTL_S)
    if session.websocket_handler is None:
        logging.info("Session %s never opened a WebSocket; removing it", session_id)
        await SESSION_MANAGER.delete_item(session_id, session)


@functools.cache
def _genai_client() -> genai.Client:
    return genai.Client(
        vertexai=True,
        project=project_id(),
        location=FR_SIMULATOR_LOCATION,
        credentials=get_credentials.ChainCredentials(),
    )


def initialize_gemini_chat_session():
    logging.info("Initializing Gemini chat session with project %s...", project_id())
    thinking = FR_SIMULATOR_THINKING.value
    return _genai_client().aio.chats.create(
        model=FR_SIMULATOR_MODEL.value,
        config=genai.types.GenerateContentConfig(
            system_instruction=FR_SIMULATOR_PROMPT,
            thinking_config=(
                genai.types.ThinkingConfig(
                    thinking_level=genai.types.ThinkingLevel(thinking)
                )
                if thinking
                else None
            ),
        ),
    )


async def serve_index(request):
    return web.FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


async def health_check(request):
    return web.Response(text="ok")


# The page runs only its own scripts and Material Web from the CDN (esm.run
# redirects to cdn.jsdelivr.net), so an injected <script> or on* attribute
# can't run and read the user's session. Inline style attributes stay allowed:
# index.html and Material Web's templates use them. blob: and data: cover the
# avatar video (MediaSource) and its JPEG frames. Other sites may not frame the
# page: a framed page could trick the user into clicking Connect or allowing
# the microphone.
CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' https://esm.run https://cdn.jsdelivr.net",
        "style-src 'self' https://fonts.googleapis.com",
        "style-src-attr 'unsafe-inline'",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
    ]
)


@web.middleware
async def revalidate_static_files(request: web.Request, handler):
    """Makes browsers revalidate the frontend so they never run stale JS after a deploy."""
    response = await handler(request)
    if request.path == "/" or request.path.startswith("/frontend/"):
        response.headers.setdefault("Cache-Control", "no-cache")
        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


@functools.cache
def _machine_hostnames() -> frozenset[str]:
    return frozenset(
        {"localhost", socket.gethostname().lower(), socket.getfqdn().lower()}
    )


def _normalize_hostname(hostname: str | None) -> str:
    return (hostname or "").strip().lower().rstrip(".")


def _allowed_host_entry(entry: str) -> tuple[str, int | None]:
    """One --allowed_hosts entry as (bare host name, port or None).

    The host is "" for a blank entry and "*" for any host.

    Raises:
      ValueError: the entry isn't a host name with an optional port.
    """
    entry = entry.strip()
    if entry in ("", "*"):
        return entry, None
    parts = urllib.parse.urlsplit("//" + entry)  # Raises for e.g. "[".
    port = parts.port  # Raises for a non-numeric or out-of-range port.
    # A scheme or path ("https://demo.example") would otherwise parse to a
    # different host ("https") and silently allow nothing useful.
    if (
        parts.netloc != entry
        or "@" in entry
        or any(c.isspace() for c in entry)
        or not parts.hostname
    ):
        raise ValueError("not a host name")
    return _normalize_hostname(parts.hostname), port


def _validate_allowed_hosts(entries: list[str]) -> bool:
    for entry in entries:
        try:
            _allowed_host_entry(entry)
        except ValueError as e:
            raise flags.ValidationError(
                f"invalid entry {entry!r} ({e}); expected a host name with an "
                "optional port, e.g. demo.example.com or demo.example.com:8443"
            ) from e
    return True


# Checked when flags are parsed, so a bad entry stops the server at startup
# instead of failing every guarded request.
flags.register_validator(ALLOWED_HOSTS, _validate_allowed_hosts)


def explicitly_allowed_hosts() -> frozenset[str]:
    """--allowed_hosts as bare host names for the Host check, without ports.

    Blank entries (a trailing comma leaves one) are dropped.
    """
    hosts = {_allowed_host_entry(entry)[0] for entry in ALLOWED_HOSTS.value}
    hosts.discard("")
    return frozenset(hosts)


_DEFAULT_PORTS = {"http": 80, "https": 443}


def is_explicitly_allowed_origin(origin: str) -> bool:
    """Whether an --allowed_hosts entry names the page origin `origin`.

    An entry with a port admits only that port (an Origin without one has its
    scheme's default port), since another port on the same host is another
    origin, possibly another service. An entry without a port admits the host
    on any port. "*" admits nothing here: as an Origin wildcard it would let
    any website start sessions on the server's credentials.
    """
    try:
        parts = urllib.parse.urlsplit(origin)
        origin_host = _normalize_hostname(parts.hostname)
        origin_port = parts.port or _DEFAULT_PORTS.get(parts.scheme.lower())
    except ValueError:  # Unparsable, so it can't be a listed host.
        return False
    # "null" has no host, and a blank entry must not match it; "http://*"
    # must not match the "*" entry.
    if origin_host in ("", "*"):
        return False
    for entry in ALLOWED_HOSTS.value:
        host, port = _allowed_host_entry(entry)
        if host == origin_host and port in (None, origin_port):
            return True
    return False


def is_allowed_host(hostname: str | None) -> bool:
    """Whether browsers may reach this server under `hostname`.

    Checking Host defeats DNS rebinding: a page on evil.example whose DNS
    points at this server sends Host: evil.example, which isn't allowed.
    """
    hostname = _normalize_hostname(hostname)
    if not hostname:
        return False
    extra = explicitly_allowed_hosts()
    if "*" in extra or hostname in extra:
        return True
    if hostname in _machine_hostnames() or hostname.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(hostname)
        return True  # DNS rebinding needs a domain name.
    except ValueError:
        pass
    return bool(os.environ.get("K_SERVICE")) and hostname.endswith(".run.app")


@web.middleware
async def reject_cross_origin(request: web.Request, handler):
    """Rejects API and WebSocket requests that other websites' pages make.

    Without this, any page open in the user's browser could start sessions on
    the server's credentials and read the model's replies. Requests without an
    Origin header (scripts such as scripts/smoke_test.py) only need an allowed
    Host.
    """
    if request.method != "GET" or request.path == "/ws":
        try:
            # Host names are ASCII on the wire (IDNs as punycode); aiohttp
            # decodes other bytes to surrogates, which the reply can't encode.
            if not request.host.isascii():
                raise ValueError("non-ASCII Host")
            host = urllib.parse.urlsplit("//" + request.host).hostname
        except ValueError:  # e.g. an unclosed IPv6 bracket
            return web.Response(text="Invalid Host header", status=400)
        if not is_allowed_host(host):
            # %r: the path (percent-decoded) and headers come from the client,
            # and a newline or terminal escape in them could forge log lines.
            logging.warning(
                "Rejected %s %r for host %r", request.method, request.path, host
            )
            return web.Response(
                text=f"Host {host!r} is not allowed; start the server with --allowed_hosts={host}",
                status=403,
            )
        origin = request.headers.get("Origin")
        if origin is not None:
            try:
                origin_netloc = urllib.parse.urlsplit(origin).netloc
            except ValueError:  # Unparsable, so it can't be this server.
                origin_netloc = None
            # Only an exact match or an explicit --allowed_hosts entry: the
            # defaults above (e.g. any IP address) are fine for Host but not
            # for the page making the request.
            if origin_netloc != request.host and not is_explicitly_allowed_origin(
                origin
            ):
                logging.warning(
                    "Rejected %s %r from origin %r",
                    request.method,
                    request.path,
                    origin,
                )
                return web.Response(text="Cross-origin request rejected", status=403)
    return await handler(request)


async def close_sessions_on_shutdown(app: web.Application) -> None:
    """Ends open sessions with 1001 (going away), so browsers can reconnect.

    Otherwise aiohttp waits shutdown_timeout for them and then drops the
    connections, which browsers see as an abnormal close (1006).
    """
    sessions = await SESSION_MANAGER.all_items()
    if sessions:
        logging.info("Closing %d session(s) for shutdown", len(sessions))
    closing = asyncio.gather(
        *(
            session.websocket_handler.client_websocket.close(
                code=1001, reason="Server restarting"
            )
            for session in sessions
            if session.websocket_handler
        ),
        return_exceptions=True,
    )
    # close() waits for each browser to acknowledge; don't let one that has
    # gone silent (asleep, offline) hold up the shutdown.
    try:
        await asyncio.wait_for(closing, timeout=2)
    except TimeoutError:
        logging.warning("Some sessions didn't acknowledge the close in time")


async def create_app():
    app = web.Application(middlewares=[reject_cross_origin, revalidate_static_files])
    app.on_shutdown.append(close_sessions_on_shutdown)

    # API and WS Routes
    app.router.add_post("/api/post_endpoint", handle_fr_post_request)
    app.router.add_post("/api/control", handle_control_request)
    app.router.add_get("/ws", aiohttp_websocket_handler)
    app.router.add_get("/healthz", health_check)

    # Static Files
    app.router.add_get("/", serve_index)
    app.router.add_static("/frontend/", path=FRONTEND_DIR, name="frontend")

    return app


async def main_async():
    logging.set_verbosity(logging.DEBUG if DEBUG.value else logging.INFO)
    proxy_proc = None
    runner = None
    # Everything after the gateway starts is inside the try, so a failed start
    # (e.g. the port is in use) doesn't leave the gateway running.
    try:
        if os.path.exists(COMMON_BAG_PROXY_PAR):
            logging.info(
                "Starting local Common BAG Stubby gateway (%s) on port %d...",
                COMMON_BAG_PROXY_PAR,
                COMMON_BAG_WS_PORT.value,
            )
            proxy_proc = subprocess.Popen(
                [
                    COMMON_BAG_PROXY_PAR,
                    f"--port={COMMON_BAG_WS_PORT.value}",
                ]
            )

        app = await create_app()
        port = int(os.environ.get("PORT", 8080))

        runner = web.AppRunner(app, shutdown_timeout=SHUTDOWN_TIMEOUT_S)
        await runner.setup()
        host = listen_host()
        site = web.TCPSite(runner, host, port)
        await site.start()

        logging.info(
            "Serving on %s port %d; project %s; allowed upstream hosts: %s",
            host or "all interfaces,",
            port,
            project_id(),
            ", ".join(ALLOWED_HOST_SUFFIXES.value),
        )
        # Fetch a token now so the first session doesn't wait for it (seconds
        # when it comes from the gcloud fallback). Failures are retried per
        # session.
        prefetch = asyncio.create_task(
            get_credentials.fetch_access_token(bounded=False)
        )
        prefetch.add_done_callback(
            lambda task: (
                task.cancelled()
                or task.exception() is None
                or logging.warning("Token prefetch failed: %s", task.exception())
            )
        )
        stop = asyncio.Event()

        def on_signal():
            if stop.is_set():
                # A second Ctrl-C quits without waiting.
                if proxy_proc is not None and proxy_proc.poll() is None:
                    proxy_proc.terminate()
                os._exit(1)
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, on_signal)
        await stop.wait()
        logging.info("Shutting down...")
    finally:
        try:
            if runner is not None:
                await runner.cleanup()
        finally:
            if proxy_proc is not None and proxy_proc.poll() is None:
                proxy_proc.terminate()


def serve(argv) -> None:
    """Runs the server until SIGINT or SIGTERM, then exits the process."""
    del argv  # Unused.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(main_async())
    # The server and the gateway are closed by now. A token fetch can still
    # be running in a worker thread (gcloud times out after 30 s), and threads
    # can't be cancelled: asyncio.run and interpreter exit would both wait for
    # it, past Cloud Run's 10 s between SIGTERM and SIGKILL.
    logging.flush()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    app.run(serve)
