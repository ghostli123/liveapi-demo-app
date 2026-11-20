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
from typing import Any, TypeGuard
import urllib.parse

from aiohttp import web
from absl import app, flags, logging
from google import genai
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
    "to these hosts, so keep this list tight.",
)
ALLOWED_HOSTS = flags.DEFINE_list(
    "allowed_hosts",
    [],
    "Extra host names browsers may use to reach this server, e.g. a custom "
    "domain or the public host of a proxy that rewrites Host. Always allowed: "
    "localhost, IP addresses, this machine's names, and *.run.app on Cloud Run. "
    "'*' allows any host, which disables DNS-rebinding protection.",
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
DEBUG = flags.DEFINE_bool(
    "debug", False, "Log at debug level, including a preview of every proxied message."
)


def project_id() -> str:
    return (
        PROJECT_ID.value or os.environ.get("GOOGLE_CLOUD_PROJECT") or DEFAULT_PROJECT_ID
    )


def resolve_ws_host(endpoint: Any, location: Any) -> str:
    """Maps the frontend's endpoint and location to the upstream WebSocket host.

    Raises:
      ValueError: the result would be a host outside --allowed_host_suffixes.
        Without this check, anyone who can reach the server could have it send
        its access token to a host of their choosing.
    """
    if endpoint in COMMON_BAG_ENVIRONMENTS:
        return endpoint
    if not isinstance(endpoint, str) or not endpoint:
        raise ValueError("Missing endpoint")
    if not isinstance(location, str) or not _LOCATION_RE.match(location):
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

    if not _HOSTNAME_RE.match(ws_host) or not any(
        ws_host.endswith(suffix) for suffix in ALLOWED_HOST_SUFFIXES.value
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
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


def _is_valid_session_id(session_id: Any) -> TypeGuard[str]:
    return isinstance(session_id, str) and bool(_SESSION_ID_RE.match(session_id))


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
    await ws.prepare(request)

    wb_handler = websocket_handler.WebsocketHandler(
        upstream_url(session_handler.ws_host),
        session_id,
        AiohttpToWebsocketsAdapter(ws, request_path=request.path_qs),
        debug_mode=DEBUG.value,
        keepalive_s=heartbeat_s,
    )
    session_handler.websocket_handler = wb_handler
    try:
        await wb_handler.start_websocket()
        close_code, close_reason = wb_handler.client_close_frame()
    except Exception as e:
        logging.exception("Error in bridged websocket handler")
        close_code = 1011
        close_reason = websocket_handler.truncate_close_reason(
            f"{type(e).__name__}: {e}"
        )
    finally:
        logging.info("WebSocket connection cleanup for session %s", session_id)
        # Always clean up the session to prevent memory leaks if the client
        # disconnects without sending a 'disconnect' command.
        await SESSION_MANAGER.delete_item(session_id)

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

    if not chat_session.fr_session:
        return _json_error(
            f"Function response simulator unavailable: {chat_session.fr_error or 'not initialized'}",
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
        genai.types.Part(text="Now generate function response this function call."),
        genai.types.Part(text=query),
    ]
    try:
        response = await chat_session.fr_session.send_message(current_content)
    except Exception as e:
        logging.exception("Function response simulator request failed")
        return _json_error(f"Function response simulator failed: {e}", 502)
    if send_definitions:
        chat_session.fc_definitions_sent = True
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
    if request_body.get("command") != "connect":
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

    fr_session, fr_error = None, ""
    try:
        fr_session = await asyncio.to_thread(initialize_gemini_chat_session)
    except Exception as err:
        fr_error = f"{type(err).__name__}: {err}"
        logging.warning(
            "Skipping FR chat session init for endpoint %s: %s", endpoint, fr_error
        )
    session_handler = session_management.SessionBaseModel(
        session_id=session_id, ws_host=ws_host, fr_session=fr_session, fr_error=fr_error
    )
    await SESSION_MANAGER.add_item(session_id, session_handler)
    session_handler.expiry_task = asyncio.create_task(
        _remove_if_never_connected(session_id, session_handler)
    )
    return web.json_response(
        {"status": "Session initialized.", "project_id": project_id()}
    )


async def _remove_if_never_connected(
    session_id: str, session: session_management.SessionBaseModel
) -> None:
    """Drops a session record whose WebSocket never arrived, so it can't leak."""
    await asyncio.sleep(PENDING_SESSION_TTL_S)
    if (
        await SESSION_MANAGER.search_item(session_id) is session
        and session.websocket_handler is None
    ):
        logging.info("Session %s never opened a WebSocket; removing it", session_id)
        await SESSION_MANAGER.delete_item(session_id)


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


@web.middleware
async def revalidate_static_files(request: web.Request, handler):
    """Makes browsers revalidate the frontend so they never run stale JS after a deploy."""
    response = await handler(request)
    if request.path == "/" or request.path.startswith("/frontend/"):
        response.headers.setdefault("Cache-Control", "no-cache")
        # Other sites may not frame the page: a framed page could trick the
        # user into clicking Connect or allowing the microphone.
        response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'self'")
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


def explicitly_allowed_hosts() -> frozenset[str]:
    """--allowed_hosts as bare host names, ignoring blanks and ports.

    Dropping blanks matters: a trailing comma would otherwise add "", which
    matches the empty host of `Origin: null` (sent by sandboxed iframes).
    """
    hosts = set()
    for entry in ALLOWED_HOSTS.value:
        entry = entry.strip()
        if entry == "*":
            hosts.add("*")
        elif entry:
            hosts.add(_normalize_hostname(urllib.parse.urlsplit("//" + entry).hostname))
    hosts.discard("")
    return frozenset(hosts)


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
        host = urllib.parse.urlsplit("//" + request.host).hostname
        if not is_allowed_host(host):
            logging.warning(
                "Rejected %s %s for host %s", request.method, request.path, host
            )
            return web.Response(
                text=f"Host {host!r} is not allowed; start the server with --allowed_hosts={host}",
                status=403,
            )
        origin = request.headers.get("Origin")
        if origin is not None:
            parts = urllib.parse.urlsplit(origin)
            # Only an exact match or an explicit --allowed_hosts entry: the
            # defaults above (e.g. any IP address) are fine for Host but not
            # for the page making the request.
            extra = explicitly_allowed_hosts()
            origin_host = _normalize_hostname(parts.hostname)
            explicitly_allowed = bool(origin_host) and (
                "*" in extra or origin_host in extra
            )
            if parts.netloc != request.host and not explicitly_allowed:
                logging.warning(
                    "Rejected %s %s from origin %s",
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
    site = web.TCPSite(runner, None, port)
    await site.start()

    logging.info(
        "Serving on port %d; project %s; allowed upstream hosts: %s",
        port,
        project_id(),
        ", ".join(ALLOWED_HOST_SUFFIXES.value),
    )
    # Fetch a token now so the first session doesn't wait for it (seconds when
    # it comes from the gcloud fallback). Failures are retried per session.
    prefetch = asyncio.create_task(asyncio.to_thread(get_credentials.get_access_token))
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
    try:
        await stop.wait()
        logging.info("Shutting down...")
    finally:
        await runner.cleanup()
        if proxy_proc is not None and proxy_proc.poll() is None:
            proxy_proc.terminate()


if __name__ == "__main__":
    app.run(lambda argv: asyncio.run(main_async()))
