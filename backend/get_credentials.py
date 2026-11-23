"""OAuth access tokens for the upstream Live API connection.

Token sources are tried in order:

1. Application Default Credentials through google-auth.
2. The gcloud CLI's ADC token. On machines that enforce certificate-based
   access, google-auth's own refresh is rejected ("Account restricted") while
   gcloud refreshes through its mTLS token endpoint and still works.
3. The LOAS helper (common_bag_ws_proxy.par), if present next to this file.

The token is cached and shared by every session until shortly before it
expires, so opening a session doesn't cost a token fetch.
"""

import asyncio
import concurrent.futures
import dataclasses
import datetime
import json
import os
import shutil
import subprocess
import threading

from absl import logging
import google.auth
import google.auth.credentials
import google.auth.transport.requests

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROXY_PAR = os.path.join(_BASE_DIR, "common_bag_ws_proxy.par")
_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)

# A cached token is reused until it is this close to expiring.
_EXPIRY_MARGIN = datetime.timedelta(minutes=2)
# If refreshing it fails, it is still handed out while it has this long left:
# the upstream only checks the token at the handshake.
_MIN_REMAINING = datetime.timedelta(seconds=30)
# Lifetime assumed when a source doesn't report one.
_ASSUMED_LIFETIME = datetime.timedelta(minutes=30)
# Callers give up on a token after this many seconds, including the wait for
# another caller's fetch. With the upstream handshake's 10 s this stays under
# the browser's 30 s setup timeout.
FETCH_TIMEOUT_S = 15
# Per HTTP request of an ADC refresh; google-auth's default is 120 s, all of
# it spent holding _lock while every new session waits.
ADC_REQUEST_TIMEOUT_S = 10

# Threads for fetch_access_token(). A stuck source holds one for up to 30 s
# (gcloud) and every waiter one for up to FETCH_TIMEOUT_S; in the default
# executor they would delay /api/control's simulator setup. One fetch runs at
# a time (_lock), so a few threads are enough; calls queued behind them fall
# back at their deadline like the waiters do.
_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="token"
)


@dataclasses.dataclass(frozen=True)
class AccessToken:
    token: str
    expiry: datetime.datetime  # Timezone-aware UTC.
    source: str


_lock = threading.Lock()
_cached_token: AccessToken | None = None
# Guards writes to _cached_token, which invalidate() makes from the event loop
# while a fetch may hold _lock for many seconds.
_cache_lock = threading.Lock()
# Failed fetches so far, and the last one's error. Callers that waited on _lock
# while a fetch failed get its error instead of each trying every source again.
_failed_fetches = 0
_last_failure = ""
_adc_credentials: google.auth.credentials.Credentials | None = None


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _as_utc(expiry: datetime.datetime | None) -> datetime.datetime:
    if expiry is None:
        return _utcnow() + _ASSUMED_LIFETIME
    if expiry.tzinfo is None:
        return expiry.replace(tzinfo=datetime.timezone.utc)
    return expiry


class _TimedRequest(google.auth.transport.requests.Request):
    """A google-auth transport whose default timeout is ADC_REQUEST_TIMEOUT_S."""

    def __call__(
        self,
        url,
        method="GET",
        body=None,
        headers=None,
        timeout=ADC_REQUEST_TIMEOUT_S,
        **kwargs,
    ):
        return super().__call__(url, method, body, headers, timeout, **kwargs)


def _token_from_adc() -> AccessToken:
    global _adc_credentials
    credentials = _adc_credentials
    if credentials is None:
        credentials, _ = google.auth.default(scopes=list(_SCOPES))
        _adc_credentials = credentials
    # Only called when the cache is stale, so always refresh.
    credentials.refresh(_TimedRequest())
    if not credentials.token:
        raise RuntimeError("ADC refresh returned no token")
    return AccessToken(credentials.token, _as_utc(credentials.expiry), "adc")


def _token_from_gcloud() -> AccessToken:
    gcloud = shutil.which("gcloud")
    if not gcloud:
        raise RuntimeError("gcloud CLI not found on PATH")
    result = subprocess.run(
        [gcloud, "auth", "application-default", "print-access-token", "--format=json"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip().splitlines()
        raise RuntimeError(stderr[-1] if stderr else f"exit code {result.returncode}")
    data = json.loads(result.stdout)
    expiry = None
    try:
        expiry = datetime.datetime.fromisoformat(data["expiry"]["datetime"])
    except (KeyError, TypeError, ValueError):
        pass
    return AccessToken(data["token"], _as_utc(expiry), "gcloud")


def _token_from_loas() -> AccessToken:
    if not os.path.exists(_PROXY_PAR):
        raise RuntimeError(f"helper not found at {_PROXY_PAR}")
    out = subprocess.check_output(
        [_PROXY_PAR, "--print_oauth_token"], text=True, timeout=15.0
    ).strip()
    token = out.splitlines()[-1].strip() if out else ""
    if not token:
        raise RuntimeError("helper printed an empty token")
    return AccessToken(token, _utcnow() + datetime.timedelta(minutes=50), "loas")


_SOURCES = (
    ("Application Default Credentials", _token_from_adc),
    ("gcloud CLI", _token_from_gcloud),
    ("LOAS helper", _token_from_loas),
)


def _fallback_token(error: str) -> AccessToken:
    """Returns the cached token if it is still usable, else raises error."""
    token = _cached_token
    if token is None:
        raise RuntimeError(error)
    remaining = token.expiry - _utcnow()
    if remaining <= _MIN_REMAINING:
        raise RuntimeError(error)
    logging.warning(
        "Reusing the cached token from %s, which expires in %d s: %s",
        token.source,
        remaining.total_seconds(),
        error,
    )
    return token


def _fresh_cached_token() -> AccessToken | None:
    token = _cached_token
    if token and token.expiry - _utcnow() > _EXPIRY_MARGIN:
        return token
    return None


def _timeout_error() -> str:
    return f"Timed out after {FETCH_TIMEOUT_S} s waiting for an access token"


def get_access_token() -> AccessToken:
    """Returns a cached or freshly fetched token. Blocks; call off the event loop."""
    global _cached_token, _failed_fetches, _last_failure
    failed_before = _failed_fetches
    # Waiting threads would otherwise pile up behind a stuck fetch.
    if not _lock.acquire(timeout=FETCH_TIMEOUT_S):
        return _fallback_token(_timeout_error())
    try:
        if token := _fresh_cached_token():
            return token
        # A fetch failed while this call waited. The sources' timeouts (30 s
        # for gcloud) would otherwise add up per queued session.
        if _failed_fetches != failed_before:
            return _fallback_token(_last_failure)
        errors = []
        for name, fetch in _SOURCES:
            try:
                token = fetch()
            except Exception as e:  # Each source fails in its own way.
                errors.append(f"{name}: {type(e).__name__}: {e}")
                continue
            if errors:
                logging.info("Skipped token sources: %s", "; ".join(errors))
            logging.info(
                "Fetched access token from %s, expires %s",
                name,
                token.expiry.isoformat(),
            )
            with _cache_lock:
                _cached_token = token
            return token
        _last_failure = "No access token available. " + " | ".join(errors)
        _failed_fetches += 1
        return _fallback_token(_last_failure)
    finally:
        _lock.release()


def cached_token() -> AccessToken | None:
    """Returns the currently cached token without fetching, or None."""
    return _cached_token


def invalidate(token: AccessToken) -> bool:
    """Drops token from the cache if it is still cached; True if it was.

    For a token the upstream rejected (revoked, or the ADC account changed, or
    a source whose lifetime was assumed): kept, it would fail every session
    until it expires. A token another caller already replaced stays replaced.
    """
    global _cached_token
    with _cache_lock:
        if _cached_token is None or _cached_token.token != token.token:
            return False
        _cached_token = None
        return True


async def fetch_access_token(*, bounded: bool = True) -> AccessToken:
    """get_access_token() for the event loop, run on the token threads.

    A fresh cached token is returned without a thread. If bounded and no token
    arrives within FETCH_TIMEOUT_S, a still-usable cached token is returned,
    else it raises. The fetch itself can't be interrupted; if it finishes late,
    it caches the token for the next session.
    """
    if token := _fresh_cached_token():
        return token
    future = asyncio.get_running_loop().run_in_executor(_EXECUTOR, get_access_token)
    try:
        return await asyncio.wait_for(future, FETCH_TIMEOUT_S if bounded else None)
    except TimeoutError:
        return _fallback_token(_timeout_error())


class ChainCredentials(google.auth.credentials.Credentials):
    """google-auth credentials backed by get_access_token(), for the genai client.

    The genai client caches one instance for the process and checks `expired`
    (and `token`) before each request. Keeping `expired` tied to the shared
    cache lets `invalidate()` — from a Live API 1008/401 or a simulator 401 —
    force the next request to refresh instead of re-sending the rejected token.
    """

    def _stale_in_cache(self) -> bool:
        if self.token is None:
            return True
        cached = _cached_token
        return cached is None or cached.token != self.token

    @property
    def expired(self) -> bool:
        if self._stale_in_cache():
            return True
        return super().expired

    @property
    def token_state(self):
        if self._stale_in_cache():
            return google.auth.credentials.TokenState.INVALID
        return super().token_state

    def refresh(self, request) -> None:
        del request  # Unused; get_access_token() picks its own transport.
        token = get_access_token()
        self.token = token.token
        # google-auth compares expiry against naive UTC datetimes.
        self.expiry = token.expiry.astimezone(datetime.timezone.utc).replace(
            tzinfo=None
        )
