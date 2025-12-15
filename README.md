# Multimodal Live API Demo

In this tutorial, you will be building a web application that enables you to use your voice and camera to talk to Gemini 2.0 through the [Multimodal Live API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live).

The [Multimodal Live API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live) is a low-latency bidirectional streaming API that supports audio and video streaming inputs and can output audio.

## Architecture

-   **Backend (Python WebSockets Server):** Handles authentication and acts as an intermediary between your frontend and the Gemini API.
-   **Frontend (HTML/JavaScript):** Provides the user interface and interacts with the backend via WebSockets.

## Pre-requisites

While some web development experience, particularly with localhost, port numbers, and the distinction between WebSockets and HTTP requests, can be beneficial for this tutorial, don't worry if you're not familiar with these concepts. We'll provide guidance along the way to ensure you can successfully follow along.

### File Structure

-   `backend/main.py`: The Python backend code
-   `backend/requirements.txt`: Lists the required Python dependencies

-   `frontend/index.html`: The frontend HTML app
-   `frontend/script.js`: Main frontend JavaScript code
-   `frontend/gemini-live-api.js`: Script for interacting with the Gemini API
-   `frontend/live-media-manager.js`: Script for handling media input and output
-   `frontend/pcm-processor.js`: Script for processing PCM audio
-   `frontend/cookieJar.js`: Script for managing cookies

![Demo](/img/ui.jpg)

## Setup instructions

You can set up this app locally or via Cloud Shell.

### Setup locally

1. Clone the repository and cd into the correct directory

1. Create a new virtual environment and activate it. The code is tested under `Python 3.9.6` and `Python 3.11`.

    ```sh
    python3 -m venv env
    source env/bin/activate
    ```

1. Install dependencies:

    ```sh
    pip install -r backend/requirements.txt
    ```

1. Set google project on your local device:
   Run the following command in a terminal with gcloud installed to set your project.

    ```sh
    gcloud components update
    gcloud components install beta
    gcloud config set project YOUR-PROJECT-ID
    ```

1. Start the service:

    ```sh
    python3 backend/main.py --project_id=$PROJECT_ID --location=$LOCATION --alsologtostderr 
    ```

1. Open your browser and navigate to `localhost:8080`.

1. Connect and interact with the demo:

    - You should type your project ID and location into the corresponding fields, select the LiveAPI model and environment you want to test.

    - Press the connect button to connect your web app. Now you should be able to interact with the Multimodal Live API.

    - **Caution**: to enable `branded voice` by uploading a `.wav` file, make sure you upload the file when the app is at `Disconnected` state, and then click
      the `connect` button. This restriction is because our code instantite the client only when the `Connect` button is clicked, during which it sends LiveAPI a setup message with the sample voice.
      This is also true if you want to record you own voice as "branded voice".

    - For function call, you can provide a json file with list of function definitions, following OpenAI FC format, check example json `f`c_definition.json` as example.

1. To interact with the app, you can do the following:

    - Text input: You can write a text prompt to send to the model by entering your message in the box and pressing the send arrow. The model will then respond via audio (turn up your volume!).
    - Voice input: Press the microphone button to stop speaking. The model will respond via audio. If you would like to mute your microphone, press the button with a slash through the microphone.
    - Video input: The model will also capture your camera input and send it to Gemini. You can ask questions about current or previous video footage. For more details on how this works, visit the [documentation page for the Multimodal Live API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live).

### Setup in Cloud Run

1. Clone the repository and cd into the correct directory

1. Execute in terminal

    ```sh
    gcloud builds submit --tag gcr.io/project_id/service_id .
    ```

1. Execute in terminal

    ```sh
    gcloud run deploy service_name \
    --image gcr.io/project_id/service_id \
    --region us-central1 \
    --concurrency=10 \
    --session-affinity
    ```
