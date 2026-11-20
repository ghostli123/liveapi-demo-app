# Gemini Live API Demo

A web app for talking to Gemini through the [Gemini Live API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live) with your voice, camera, or screen. The model can answer with audio, text, or a talking avatar video.

![Demo](/img/ui.jpg)

## Architecture

- **Frontend** (`frontend/`): plain HTML and JavaScript with Material Web components. It captures the microphone, camera, or screen, plays the model's audio and video, and shows the conversation.
- **Backend** (`backend/`): an aiohttp server that serves the frontend and proxies each session's WebSocket to the Live API, adding the OAuth token. The browser never sees the token.

Two transports are available:

- **WebSocket**: audio, camera frames (JPEG), and the model's audio and MP4 video all travel as JSON over the WebSocket.
- **WebRTC**: the WebSocket only carries setup and control messages; media flows over a WebRTC peer connection, which gives lower latency. Not every endpoint supports it.

Both transports are tested in Chrome and Firefox. Safari support is intended but untested.

## Run locally

Requires Python 3.11 or later.

1. Install dependencies:

    ```sh
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r backend/requirements.txt
    ```

1. Set up Application Default Credentials for an account with access to Vertex AI:

    ```sh
    gcloud auth application-default login
    ```

1. Start the server:

    ```sh
    python backend/main.py --project_id=YOUR_PROJECT_ID
    ```

1. Open http://localhost:8080 and click **Connect**.

### Server options

| Option | Default | Purpose |
| --- | --- | --- |
| `--project_id` | `$GOOGLE_CLOUD_PROJECT`, then `live-api-webrtc-testing` | Project used for Live API sessions and the function-call simulator. |
| `--allowed_host_suffixes` | `.googleapis.com` | Upstream hosts the proxy may connect to. The proxy sends its access token to these hosts, so keep the list tight. |
| `--allowed_hosts` | none | Extra host names browsers may use to reach the server, such as a custom domain or the public host of a proxy that rewrites `Host`. localhost, IP addresses, this machine's names, and `*.run.app` on Cloud Run are always allowed. |
| `--debug` | off | Debug logging, including a preview of every proxied message. |
| `PORT` (env) | `8080` | Port to listen on. |

The API and WebSocket only accept browser requests from the app's own pages, under an allowed host name, so other websites (including through DNS rebinding) can't use the server's credentials. Clients that send no `Origin` header, such as `scripts/smoke_test.py`, are allowed.

### Credentials

The backend tries, in order: Application Default Credentials through google-auth, then `gcloud auth application-default print-access-token`, then the LOAS helper `backend/common_bag_ws_proxy.par` if present. The gcloud fallback matters on machines with certificate-based access, where google-auth's own token refresh fails with "Account restricted" but gcloud works. The server log says which source it used.

## Using the app

- **Connection**: pick the transport, location, environment (endpoint), and model, then **Connect**. Changing the environment adjusts the model to one it serves.
- **Text**: type in the message box and press Enter.
- **Voice**: click the microphone button to start or stop sending audio. Turn on input and output transcripts in **Advanced Settings** to see what was heard and said.
- **Camera and screen**: the camera button sends your camera; the screen button shares a screen or window. Only one runs at a time.
- **Response type** (in **Model Behavior**): Video (avatar), Audio, or Text.
- **Branded voice**: upload an audio file (any format the browser can decode; it is converted to 24 kHz mono WAV) or record one with **Create a new branded voice**, then pick it in the **Voice** dropdown, or pick **None** to use the prebuilt voice. The sample is sent in the session's setup message, so changes apply to the next connection. The project must be allowlisted for replicated voice; otherwise the session closes with "not allowlisted for replicated voice".
- **Function calling**: upload a JSON list of function declarations before connecting; `fc_definition.json` is an example. When the model calls a function, the backend asks `gemini-3-flash-preview` (with low thinking, about a second) to simulate a plausible response and sends it back to the model. Change the model with `--fr_simulator_model` and `--fr_simulator_thinking_level`.
- **Session resumption**: on by default. When the Live API announces it will close the connection (GoAway), or the backend restarts (e.g. a deploy), the app reconnects with the session's latest resumption handle and the conversation continues. Disconnect ends the conversation; the chat log shows its handle, which you can enter under **Advanced Settings** before connecting to resume it.
- **Saving the avatar video**: with **Save avatar video** checked, the avatar's MP4 stream (WebSocket transport) is downloaded when you disconnect.
- **Metrics**: hover over 📊 to see transport, bandwidth, frame rate, packet loss, token usage for the last turn, and response latency: the time from sending a message (or, for speech, the last input transcript) to the model's first audio or text.

If the server ends a session, the app shows the close code and the reason the Live API gave, such as a missing model or a permission error.

## Deploy to Cloud Run

```sh
gcloud run deploy SERVICE_NAME \
  --source . \
  --region us-central1 \
  --project YOUR_PROJECT_ID \
  --set-env-vars PROJECT_ID=YOUR_PROJECT_ID \
  --timeout 3600 \
  --concurrency 10 \
  --session-affinity
```

- `--timeout 3600`: Cloud Run ends a request, including a WebSocket, after the timeout. The default of 300 seconds cuts every session at 5 minutes.
- `--session-affinity`: keeps a browser's control request and WebSocket on the same instance, which holds the session state.
- The service account needs the Vertex AI User role (`roles/aiplatform.user`) in `PROJECT_ID`.
- Anyone who can reach the service can start sessions billed to your project. Add `--no-allow-unauthenticated` or put it behind IAP unless the demo is meant to be public.

## Development

```sh
pip install -r backend/requirements-dev.txt
python -m pytest                          # backend tests
ruff check backend scripts && ruff format --check backend scripts
node --test frontend/tests/*.test.js      # frontend tests (Node 18+)
```

`scripts/smoke_test.py` runs a real session through a running server, the way the browser does, and reports setup latency, media received, and the transcript:

```sh
python scripts/smoke_test.py --environment=prod-us-rep --model=gemini-3.8-live --modality=VIDEO
```

`scripts/browser_e2e.js` drives the app in headless Chrome against a running server and a real endpoint: text turns over both transports, resumption, function calling, error reporting, and (with `--speech=file.wav`) a spoken turn through the fake microphone:

```sh
npm install
npm run e2e -- --server=http://localhost:8080 --speech=sample.wav
```

GitHub Actions runs the unit tests, lint, and a container build on every push; the end-to-end checks need credentials, so they run locally.

### Files

| Path | Contents |
| --- | --- |
| `backend/main.py` | HTTP routes, endpoint validation, function-call simulator. |
| `backend/websocket_handler.py` | Proxy between the browser and Live API WebSockets. |
| `backend/get_credentials.py` | Access token sources and caching. |
| `backend/session_management.py` | Per-session state. |
| `frontend/index.html` | Page layout and settings. |
| `frontend/script.js` | UI logic: connect, media controls, chat. |
| `frontend/gemini-live-api.js` | Live API client: setup message, message parsing, reconnects. |
| `frontend/live-media-manager.js` | Microphone, camera, screen, audio and video playback, WebRTC. |
| `frontend/pcm-processor.js`, `frontend/input-processor.js` | Audio worklets for playback and capture. |
| `feature/Live_API_Branded_Voice.ipynb` | Notebook showing branded voice through the API directly. |
