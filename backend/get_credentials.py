import google.auth
import google.auth.credentials
import google.auth.transport.requests


def get_credentials():
    # 1. Get credentials using Application Default Credentials
    # ADC automatically finds credentials in your environment (Service Account, gcloud, etc.)
    credentials: google.auth.credentials.Credentials

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )

    # 2. Refresh the token if necessary (usually handled automatically, but good practice)

    if not credentials.valid:
        credentials.refresh(google.auth.transport.requests.Request())

    # 3. The access token is available in the 'token' attribute
    return credentials
