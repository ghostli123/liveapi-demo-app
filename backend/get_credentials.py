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
# Lifetime assumed when a source doesn't report one.
_ASSUMED_LIFETIME = datetime.timedelta(minutes=30)


@dataclasses.dataclass(frozen=True)
class AccessToken:
    token: str
    expiry: datetime.datetime  # Timezone-aware UTC.
    source: str


_lock = threading.Lock()
_cached_token: AccessToken | None = None
_adc_credentials: google.auth.credentials.Credentials | None = None


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _as_utc(expiry: datetime.datetime | None) -> datetime.datetime:
    if expiry is None:
        return _utcnow() + _ASSUMED_LIFETIME
    if expiry.tzinfo is None:
        return expiry.replace(tzinfo=datetime.timezone.utc)
    return expiry


def _token_from_adc() -> AccessToken:
    global _adc_credentials
    if _adc_credentials is None:
        _adc_credentials, _ = google.auth.default(scopes=list(_SCOPES))
    # Only called when the cache is stale, so always refresh.
    _adc_credentials.refresh(google.auth.transport.requests.Request())
    return AccessToken(_adc_credentials.token, _as_utc(_adc_credentials.expiry), "adc")


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


def get_access_token() -> AccessToken:
    """Returns a cached or freshly fetched token. Blocks; call off the event loop."""
    global _cached_token
    with _lock:
        if _cached_token and _cached_token.expiry - _utcnow() > _EXPIRY_MARGIN:
            return _cached_token
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
            _cached_token = token
            return token
        raise RuntimeError("No access token available. " + " | ".join(errors))


class ChainCredentials(google.auth.credentials.Credentials):
    """google-auth credentials backed by get_access_token(), for the genai client."""

    def refresh(self, request) -> None:
        del request  # Unused; get_access_token() picks its own transport.
        token = get_access_token()
        self.token = token.token
        # google-auth compares expiry against naive UTC datetimes.
        self.expiry = token.expiry.astimezone(datetime.timezone.utc).replace(
            tzinfo=None
        )
