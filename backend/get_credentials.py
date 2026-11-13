import datetime
import os
import subprocess

import google.auth
import google.auth.credentials
import google.auth.transport.requests

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROXY_PAR = os.path.join(_BASE_DIR, "common_bag_ws_proxy.par")


class _SimpleCredentials:
    def __init__(self, token: str, expiry: datetime.datetime) -> None:
        self.token = token
        self.expiry = expiry
        self.valid = True


def _get_loas_oauth_credentials():
    if not os.path.exists(_PROXY_PAR):
        raise RuntimeError(f"LOAS OAuth helper not found at {_PROXY_PAR}")
    out = subprocess.check_output(
        [_PROXY_PAR, "--print_oauth_token"],
        text=True,
        timeout=15.0,
    ).strip()
    token = out.splitlines()[-1].strip()
    if not token:
        raise RuntimeError("Empty OAuth token from LOAS helper")
    expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        minutes=50
    )
    return _SimpleCredentials(token=token, expiry=expiry), "live-api-webrtc-testing"


def get_credentials():
    # 1. Get credentials using Application Default Credentials
    # ADC automatically finds credentials in your environment (Service Account, gcloud, etc.)
    try:
        credentials, project_id = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        if not credentials.valid:
            credentials.refresh(google.auth.transport.requests.Request())
        return credentials, project_id
    except Exception:
        return _get_loas_oauth_credentials()
