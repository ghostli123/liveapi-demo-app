/**
 * Global application state and UI coordinator for the Gemini Realtime Demo web application.
 * Manages WebSocket connections, media devices (camera/mic/screen), Cookie persistence,
 * tool/function calling declarations, and secure DOM manipulations.
 */

// --- Application Configuration ---
const isHttps = window.location.protocol === "https:";
const wsProtocol = isHttps ? "wss:" : "ws:";
const host = window.location.host;

const AppConfig = {
    PROXY_URL: `${wsProtocol}//${host}/ws`,
    CONTROL_URL: "/api/control",
    FR_SERVICE_URL: "/api/post_endpoint",
};

// --- Application State Coordinator ---
const AppState = {
    geminiLiveApi: null,
    liveAudioOutputManager: null,
    liveVideoOutputManager: null,
    liveAudioInputManager: null,
    liveVideoManager: null,
    liveScreenManager: null,
    customVoiceBase64: "",
    functionCallDefinition: null,
    mediaRecorder: null,
    audioChunks: [],
    isRecording: false,
    recordingStartTime: null,
};

// --- Secure UI Management ---
const AppUI = {
    getElement(id) {
        return document.getElementById(id);
    },
    setHidden(id, hidden) {
        const el = this.getElement(id);
        if (el) el.hidden = hidden;
    },
    setDisabled(id, disabled) {
        const el = this.getElement(id);
        if (el) el.disabled = disabled;
    },
    setText(id, text) {
        const el = this.getElement(id);
        if (el) el.textContent = text; // Secure against XSS
    },
    getValue(id, fallback = "") {
        const el = this.getElement(id);
        return el ? el.value : fallback;
    },
    getChecked(id, fallback = false) {
        const el = this.getElement(id);
        return el ? el.checked : fallback;
    },
    showModal(message) {
        const dialog = this.getElement("dialog");
        const dialogMessage = this.getElement("dialogMessage");
        if (dialogMessage) {
            dialogMessage.textContent = message; // Secure against XSS
        }
        if (dialog && typeof dialog.show === "function") {
            dialog.show();
        }
    },
    setButtonWithIcon(id, iconName, text) {
        const button = this.getElement(id);
        if (!button) return;
        button.replaceChildren(); // Safe DOM construction
        if (iconName) {
            const span = document.createElement("span");
            span.className = "material-icons";
            span.textContent = iconName;
            button.appendChild(span);
        }
        button.appendChild(document.createTextNode(" " + text));
    },
};

// --- Immediate Manager Initialization ---
function initApplicationManagers() {
    AppState.geminiLiveApi = new GeminiLiveAPI(
        AppConfig.PROXY_URL,
        AppConfig.CONTROL_URL,
        AppConfig.FR_SERVICE_URL
    );

    AppState.geminiLiveApi.onErrorMessage = (message) => {
        AppUI.showModal(message);
        newErrorMessage(message);
        endSession();
    };

    AppState.geminiLiveApi.onReceiveResponse = handleReceiveResponse;
    AppState.geminiLiveApi.onTransportFallback = () => {
        AppState.liveVideoOutputManager.initMediaSource();
        AppUI.setText("active-transport", "WebSocket");
        AppUI.setText("webrtc-state", "n/a");
        newSystemMessage("This endpoint didn't accept WebRTC, so media uses the WebSocket.");
    };
    AppState.geminiLiveApi.onReconnectNeeded = () => {
        newSystemMessage("The server restarted. Resuming the session...");
        handleSessionResumptionReconnect();
    };

    AppState.liveAudioOutputManager = new LiveAudioOutputManager();
    AppState.liveVideoOutputManager = new LiveVideoOutputManager();
    AppState.liveAudioInputManager = new LiveAudioInputManager();

    const showAutoplayBlocked = () => {
        AppUI.showModal(
            "The browser blocked audio and video playback. Press play on the avatar video to start it."
        );
    };
    AppState.liveVideoOutputManager.onAutoplayBlocked = showAutoplayBlocked;
    if (AppState.geminiLiveApi.webRtcManager) {
        AppState.geminiLiveApi.webRtcManager.onAutoplayBlocked = showAutoplayBlocked;
    }

    AppState.liveAudioInputManager.onNewAudioRecordingChunk = (audioData) => {
        AppState.geminiLiveApi.sendAudioMessage(audioData);
    };

    const videoElement = AppUI.getElement("video");
    const canvasElement = AppUI.getElement("canvas");

    AppState.liveVideoManager = new LiveVideoManager(videoElement, canvasElement);
    AppState.liveScreenManager = new LiveScreenManager(videoElement, canvasElement);

    AppState.liveVideoManager.onNewFrame = (b64Image) => {
        AppState.geminiLiveApi.sendImageMessage(b64Image);
    };

    AppState.liveScreenManager.onNewFrame = (b64Image) => {
        AppState.geminiLiveApi.sendImageMessage(b64Image);
    };
}

initApplicationManagers();

// --- Cookie Persistence ---
if (typeof CookieJar !== "undefined") {
    CookieJar.init("systemInstructions");
    CookieJar.init("location");
}

// --- Page Load Event Initialization ---
window.addEventListener("load", () => {
    console.log("Hello Gemini Realtime Demo!");

    initDOMEventListeners();
    refreshDeviceLists();
    if (navigator.mediaDevices) {
        navigator.mediaDevices.addEventListener("devicechange", refreshDeviceLists);
    }
    toggleAvatarMode();
});

// --- DOM Event Listeners Setup ---
function initDOMEventListeners() {
    const audioFileInput = AppUI.getElement("audioFileInput");
    if (audioFileInput) {
        audioFileInput.addEventListener("change", handleAudioFileInputChange);
    }

    const fcFileInput = AppUI.getElement("fcFileInput");
    if (fcFileInput) {
        fcFileInput.addEventListener("change", handleFcFileInputChange);
    }

    const createVoiceBtn = AppUI.getElement("createVoiceBtn");
    if (createVoiceBtn) {
        createVoiceBtn.addEventListener("click", openModal);
    }

    const closeModalBtn = AppUI.getElement("closeModalBtn");
    if (closeModalBtn) {
        closeModalBtn.addEventListener("click", closeModal);
    }

    const brandedVoiceModal = AppUI.getElement("brandedVoiceModal");
    if (brandedVoiceModal) {
        window.addEventListener("click", (event) => {
            if (event.target === brandedVoiceModal) {
                closeModal();
            }
        });
    }

    const recordButton = AppUI.getElement("recordButton");
    if (recordButton) {
        recordButton.addEventListener("click", handleRecordClick);
    }

    const envSelect = AppUI.getElement("envApiHost");
    if (envSelect) {
        envSelect.addEventListener("change", handleEnvironmentChange);
    }

    const modelSelect = AppUI.getElement("liveApiModel");
    if (modelSelect) {
        modelSelect.addEventListener("change", handleModelChange);
    }

    const textMessage = AppUI.getElement("text-message");
    if (textMessage) {
        textMessage.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                newUserMessage();
            }
        });
    }
}

const COMMON_ONLY_MODELS = new Set([
    "live_avatar_rev23_rc4",
    "live_avatar_v2_rev25_rc2",
    "gemini_api_beyond_live_rev23_rc3",
    "gemini_live_rev25",
]);

const US_CENTRAL1_REGIONAL_ONLY_MODELS = new Set([
    "gemini-3.5-live-early-exp",
]);

function isCommonEnvironment(envVal) {
    return (
        envVal === "autopush-common" ||
        envVal === "staging-common" ||
        envVal === "autopush-vertex-bidi" ||
        envVal === "autopush-vertex-us-bidi"
    );
}

// Prod Vertex does not support WebRTC yet, so it always uses WebSocket.
function isWebSocketOnlyEnvironment(envVal) {
    return envVal === "prod";
}

// On prod mREP, gemini-3.8-live is served by the GRoot "bidi" pool, which
// supports WebRTC; gemini-3.1 models go to "genai-rapid", which does not.
const PROD_US_REP_MODEL = "gemini-3.8-live";

function handleEnvironmentChange() {
    const envVal = AppUI.getValue("envApiHost");
    const modelSelect = AppUI.getElement("liveApiModel");
    if (!modelSelect) return;
    const isCommon = isCommonEnvironment(envVal);
    const currentModel = modelSelect.value;
    if (envVal === "prod-us-rep") {
        modelSelect.value = PROD_US_REP_MODEL;
    } else if (!isCommon && COMMON_ONLY_MODELS.has(currentModel)) {
        modelSelect.value = "gemini-3.1-flash-live-preview-04-2026";
    } else if (isCommon && !COMMON_ONLY_MODELS.has(currentModel)) {
        modelSelect.value = "live_avatar_v2_rev25_rc2";
    } else if (
        US_CENTRAL1_REGIONAL_ONLY_MODELS.has(currentModel) &&
        (envVal === "autopush-us-rep" || envVal === "staging-us-rep")
    ) {
        modelSelect.value = "gemini-3.1-flash-live-preview-04-2026";
    }
    if (isWebSocketOnlyEnvironment(envVal)) {
        const transportSelect = AppUI.getElement("transportMode");
        if (transportSelect && transportSelect.value === "webrtc") {
            transportSelect.value = "websocket";
        }
    }
}

function handleModelChange() {
    const selectedModel = AppUI.getValue("liveApiModel");
    if (!US_CENTRAL1_REGIONAL_ONLY_MODELS.has(selectedModel)) {
        return;
    }

    const locationInput = AppUI.getElement("location");
    if (locationInput && locationInput.value !== "us-central1") {
        locationInput.value = "us-central1";
    }

    const envSelect = AppUI.getElement("envApiHost");
    if (!envSelect) return;
    const envVal = envSelect.value;
    if (envVal === "staging-us-rep" || envVal === "staging-common") {
        envSelect.value = "staging";
    } else if (envVal === "autopush-us-rep" || isCommonEnvironment(envVal)) {
        envSelect.value = "autopush";
    } else if (envVal === "prod-us-rep") {
        envSelect.value = "prod";
    }
}

// --- Input Handlers ---
function handleAudioFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        if (typeof e.target.result === "string") {
            AppState.customVoiceBase64 = e.target.result.split(",")[1] || "";
            AppUI.setText("fileName", `File: ${file.name}`);
        }
    };
    reader.readAsDataURL(file);

    AppUI.showModal(`New branded voice "${file.name}" has been successfully uploaded.`);
}

function handleFcFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            AppState.functionCallDefinition = JSON.parse(e.target.result);
            console.log("Function call definition loaded:", AppState.functionCallDefinition);
            AppUI.setText("fcFileName", `File: ${file.name}`);
            AppUI.showModal(`Function call definition "${file.name}" has been successfully uploaded.`);
        } catch (error) {
            AppUI.showModal(`Error parsing JSON file: ${error.message}`);
        }
    };
    reader.readAsText(file);
}

function getSelectedResponseModality() {
    const radioButtons = document.querySelectorAll('md-radio[name="responseModality"]');
    let selectedValue = "VIDEO";
    for (const radioButton of radioButtons) {
        if (radioButton.checked) {
            selectedValue = radioButton.value;
            break;
        }
    }
    return selectedValue;
}

// --- Live API Response Coordinator ---
function isWebRtcTransport() {
    return AppState.geminiLiveApi && AppState.geminiLiveApi.transportMode === "webrtc";
}

function handleReceiveResponse(messageResponse) {
    switch (messageResponse.type) {
        case "SETUP COMPLETE":
            if (isWebRtcTransport() && messageResponse.answerSdp) {
                newSystemMessage("Setup complete (WebRTC SDP answer negotiated).");
            } else {
                newSystemMessage("Setup complete.");
            }
            break;
        case "GENERATION_STARTED":
            closeTranscriptLine("input");
            setModelSpeaking(true);
            break;
        case "AUDIO":
            setModelSpeaking(true);
            if (isWebRtcTransport()) {
                break;
            }
            if (AppState.liveAudioOutputManager) {
                AppState.liveAudioOutputManager.playAudioChunk(messageResponse.data);
            }
            break;
        case "VIDEO":
            if (isWebRtcTransport()) {
                break;
            }
            if (AppState.liveVideoOutputManager) {
                AppState.liveVideoOutputManager.playVideoChunk(
                    messageResponse.data,
                    messageResponse.mimeType || ""
                );
            }
            break;
        case "TEXT":
            closeTranscriptLine("input");
            setModelSpeaking(true);
            appendTranscript("output", messageResponse.data);
            break;
        case "RESUMPTION": {
            console.log("Resumption handle received: ", messageResponse.data);
            const enableResumption = AppUI.getElement("resumption");
            if (enableResumption) enableResumption.checked = true;

            const resumptionHandle = AppUI.getElement("handle");
            if (resumptionHandle) resumptionHandle.value = messageResponse.data;
            break;
        }
        case "GO_AWAY":
            console.log("GoAway message received. Time left: ", messageResponse.data);
            if (AppState.geminiLiveApi.canResume()) {
                newSystemMessage("Connection expiring. Reconnecting for session resumption...");
                handleSessionResumptionReconnect();
            } else {
                newSystemMessage(
                    "The server will close this connection soon. Enable session resumption " +
                    "to continue the conversation on a new connection."
                );
            }
            break;
        case "INPUT_TRANSCRIPTION":
            appendTranscript("input", messageResponse.data);
            if (messageResponse.finished) closeTranscriptLine("input");
            break;
        case "OUTPUT_TRANSCRIPTION":
            closeTranscriptLine("input");
            setModelSpeaking(true);
            appendTranscript("output", messageResponse.data);
            if (messageResponse.finished) closeTranscriptLine("output");
            break;
        case "END_OF_TURN":
            closeTranscriptLine("output");
            setModelSpeaking(false);
            break;
        case "INTERRUPT":
            if (AppState.liveAudioOutputManager) {
                AppState.liveAudioOutputManager.clear();
            }
            closeTranscriptLine("output");
            setModelSpeaking(false);
            newSystemMessage("Interrupted.");
            break;
        case "VAD_SIGNAL":
            console.log("VAD signal");
            break;
        case "FUNCTION_CALL":
            closeTranscriptLine("input");
            handleFunctionCallRequest(messageResponse.data);
            break;
        case "FUNCTION_CALL_CANCELLATION":
            newSystemMessage("Function calls cancelled: " + messageResponse.data.join(", "));
            break;
        case "USAGE":
            showUsage(messageResponse.data);
            break;
        default:
            console.warn("Unhandled message type:", messageResponse.type);
            break;
    }
}

function showUsage(usage) {
    const prompt = usage.promptTokenCount ?? usage.prompt_token_count ?? 0;
    const total = usage.totalTokenCount ?? usage.total_token_count ?? 0;
    AppUI.setText("usage-tokens", `${prompt.toLocaleString()} in / ${total.toLocaleString()} total`);
}

async function handleSessionResumptionReconnect() {
    const api = AppState.geminiLiveApi;
    if (!api) return;

    setAppStatus("connecting");
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    if (api.transportMode !== "webrtc" && AppState.liveVideoOutputManager) {
        // The new connection streams a new MP4, which needs a fresh MediaSource.
        AppState.liveVideoOutputManager.initMediaSource();
    }
    try {
        await api.resume(api.latestResumptionHandle);
    } catch (error) {
        // prepare() already reported the error and ended the session.
        console.error("Session resumption failed: ", error);
    }
}

async function simulateFunctionResponse(funcCall) {
    try {
        return {
            result: await AppState.geminiLiveApi.sendPostRequest(AppState.geminiLiveApi.frUrl, {
                objective: "fr_generate",
                session_id: AppState.geminiLiveApi.sessionId,
                functionName: funcCall.name,
                functionArgs: funcCall.args,
            }),
        };
    } catch (error) {
        console.error(`Simulating ${funcCall.name} failed:`, error);
        newErrorMessage(`Function ${funcCall.name} failed: ${error.message}`);
        // Answer anyway: with BLOCKING tools the model waits for a response.
        return { error: error.message };
    }
}

async function handleFunctionCallRequest(functionCalls) {
    console.log("Function call requested: ", functionCalls);
    const webSocket = AppState.geminiLiveApi.webSocket;
    for (const funcCall of functionCalls) {
        newSystemMessage(`Function call: ${funcCall.name}(${JSON.stringify(funcCall.args || {})})`);
    }

    const schedulingVal = AppUI.getValue("fcScheduling", "WHEN_IDLE");
    // Sequential, since the simulator is one chat session per connection.
    const functionResponses = [];
    for (const funcCall of functionCalls) {
        const response = await simulateFunctionResponse(funcCall);
        response.scheduling = schedulingVal;
        functionResponses.push({ id: funcCall.id, name: funcCall.name, response });
    }
    if (AppState.geminiLiveApi.webSocket !== webSocket) {
        // The connection that made these calls has closed or been replaced.
        console.warn("Dropping responses to calls from a previous connection.");
        return;
    }
    AppState.geminiLiveApi.sendMessage({ toolResponse: { functionResponses } });
}

// --- Chat Interface Helpers ---
const ChatState = {
    // The chat line each transcript stream is appending to, if any.
    transcriptLines: { input: null, output: null },
};

const TRANSCRIPT_LABELS = { input: "You: ", output: "Gemini: " };

/**
 * Appends a line to the chat log and keeps it scrolled to the bottom, unless
 * the user has scrolled up to read earlier messages.
 * @param {string} text
 * @param {"user"|"model"|"system"|"error"} kind
 * @returns {HTMLElement|null} The new line.
 */
function addMessageToChat(text, kind = "system") {
    const textChat = AppUI.getElement("text-chat");
    if (!textChat) return null;

    const atBottom = textChat.scrollHeight - textChat.scrollTop - textChat.clientHeight < 24;
    const line = document.createElement("p");
    line.className = `chat-line chat-${kind}`;
    line.textContent = text; // Secure against XSS
    textChat.appendChild(line);
    if (atBottom) {
        textChat.scrollTop = textChat.scrollHeight;
    }
    return line;
}

function newSystemMessage(message) {
    return addMessageToChat(message, "system");
}

function newErrorMessage(message) {
    return addMessageToChat(message, "error");
}

// Kept for callers outside this file.
function newModelMessage(message) {
    return newSystemMessage(message);
}

/** Streams transcript text into one chat line per utterance. */
function appendTranscript(stream, text) {
    if (!text) return;
    let line = ChatState.transcriptLines[stream];
    if (!line || !line.isConnected) {
        line = addMessageToChat(TRANSCRIPT_LABELS[stream], stream === "input" ? "user" : "model");
        ChatState.transcriptLines[stream] = line;
    }
    if (!line) return;
    const textChat = AppUI.getElement("text-chat");
    const atBottom = textChat.scrollHeight - textChat.scrollTop - textChat.clientHeight < 24;
    line.textContent += text;
    if (atBottom) {
        textChat.scrollTop = textChat.scrollHeight;
    }
}

/** Ends the current utterance, so the next transcript text starts a new line. */
function closeTranscriptLine(stream) {
    ChatState.transcriptLines[stream] = null;
}

function newUserMessage() {
    const textMessage = AppUI.getElement("text-message");
    if (!textMessage) return;

    const val = textMessage.value;
    if (val.trim() === "") return;

    const api = AppState.geminiLiveApi;
    if (!api.webSocket || api.webSocket.readyState !== WebSocket.OPEN) {
        AppUI.showModal("Connect before sending a message.");
        return;
    }
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    addMessageToChat("You: " + val, "user");
    api.sendTextMessage(val);

    textMessage.value = "";
}

// --- Audio Input Operations ---
function webRtcManagerIfActive() {
    return isWebRtcTransport() ? AppState.geminiLiveApi.webRtcManager : null;
}

function isMicOn() {
    const micBtn = AppUI.getElement("micBtn");
    return !!micBtn && !micBtn.hidden;
}

function isCameraOn() {
    const cameraBtn = AppUI.getElement("cameraBtn");
    return !!cameraBtn && !cameraBtn.hidden;
}

function showMicState(on) {
    AppUI.setHidden("micBtn", !on);
    AppUI.setHidden("micOffBtn", on);
}

function showCameraState(on) {
    AppUI.setHidden("cameraBtn", !on);
    AppUI.setHidden("cameraOffBtn", on);
}

async function startAudioInput() {
    const deviceId = AppUI.getValue("audioSource") || null;
    try {
        const webRtcManager = webRtcManagerIfActive();
        if (webRtcManager) {
            await webRtcManager.startMicrophone(deviceId);
        } else {
            AppState.liveAudioInputManager.deviceId = deviceId;
            await AppState.liveAudioInputManager.updateAudioInterval(
                AppUI.getValue("audioInterval", "1000")
            );
        }
        // Device names are only visible once the user has granted access.
        refreshDeviceLists();
    } catch (err) {
        console.error("Failed to start microphone:", err);
        AppUI.showModal(`Could not start the microphone: ${err.message}`);
        stopAudioInput();
        showMicState(false);
    }
}

function stopAudioInput() {
    if (
        AppState.geminiLiveApi &&
        AppState.geminiLiveApi.webRtcManager
    ) {
        AppState.geminiLiveApi.webRtcManager.stopMicrophone();
    }
    if (AppState.liveAudioInputManager) {
        AppState.liveAudioInputManager.disconnectMicrophone();
    }
}

function micBtnClick() {
    stopAudioInput();
    showMicState(false);
}

function micOffBtnClick() {
    showMicState(true);
    startAudioInput();
}

function audioStartButtonClick() {
    console.log("start voice activity...");
    AppState.geminiLiveApi.sendVoiceActivityMessage(true);
}

function audioEndButtonClick() {
    console.log("end voice activity...");
    AppState.geminiLiveApi.sendVoiceActivityMessage(false);
}

// --- Video & Screen Capturing ---
function videoIntervalMs() {
    return parseInt(AppUI.getValue("videoInterval", "5000"), 10) || 5000;
}

async function startCameraCapture() {
    AppState.liveScreenManager.stopCapture();
    const camera = AppState.liveVideoManager;
    camera.stopWebcam();
    camera.deviceId = AppUI.getValue("cameraSource") || null;
    camera.intervalMs = videoIntervalMs();
    try {
        const webRtcManager = webRtcManagerIfActive();
        // WebRTC sends the camera track itself; WebSocket sends JPEG frames.
        await camera.startWebcam({ sendFrames: !webRtcManager });
        if (webRtcManager) {
            await webRtcManager.attachVideoStream(camera.stream);
        }
        refreshDeviceLists();
    } catch (err) {
        console.error("Failed to start camera:", err);
        AppUI.showModal(`Could not start the camera: ${err.message}`);
        camera.stopWebcam();
        showCameraState(false);
    }
}

async function startScreenCapture() {
    const screen = AppState.liveScreenManager;
    const webRtcManager = webRtcManagerIfActive();
    screen.intervalMs = videoIntervalMs();
    try {
        await screen.startCapture({ sendFrames: !webRtcManager });
    } catch (err) {
        // NotAllowedError means the user closed the picker.
        if (err.name !== "NotAllowedError") {
            AppUI.showModal(`Could not share the screen: ${err.message}`);
        }
        return;
    }
    // The camera and the screen share the preview, so only one runs at a time.
    AppState.liveVideoManager.stopWebcam();
    showCameraState(false);
    if (webRtcManager) {
        await webRtcManager.attachVideoStream(screen.stream);
    }
}

function cameraBtnClick() {
    const webRtcManager = webRtcManagerIfActive();
    if (webRtcManager) {
        webRtcManager.detachVideoStream();
    }
    AppState.liveVideoManager.stopWebcam();
    showCameraState(false);
}

function cameraOffBtnClick() {
    showCameraState(true);
    startCameraCapture();
}

function screenShareBtnClick() {
    startScreenCapture();
}

function newCameraSelected() {
    AppState.liveVideoManager.deviceId = AppUI.getValue("cameraSource") || null;
    if (isCameraOn()) {
        startCameraCapture();
    }
}

function newMicSelected() {
    AppState.liveAudioInputManager.deviceId = AppUI.getValue("audioSource") || null;
    if (isMicOn()) {
        startAudioInput();
    }
}

// --- Device Enumeration ---
async function getAvailableDevices(deviceType, fallbackName) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
    }
    try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        return allDevices
            .filter((device) => device.kind === deviceType)
            .map((device, index) => ({
                id: device.deviceId,
                // Labels (and IDs) are blank until the user grants access.
                name: device.label || `${fallbackName} ${index + 1}`,
            }));
    } catch (error) {
        console.error("Error enumerating media devices:", error);
        return [];
    }
}

function setMaterialSelect(allOptions, selectElement) {
    if (!selectElement) return;
    // Keep the current choice if it still exists; otherwise show the first.
    const previousValue = selectElement.value;
    const selectedId = allOptions.some((o) => o.id === previousValue)
        ? previousValue
        : allOptions.length > 0
            ? allOptions[0].id
            : "";
    selectElement.replaceChildren(); // Clean old options securely
    allOptions.forEach((optionData) => {
        const option = document.createElement("md-select-option");
        option.value = optionData.id;

        const slotDiv = document.createElement("div");
        slotDiv.slot = "headline";
        slotDiv.textContent = optionData.name; // Secure against XSS
        option.appendChild(slotDiv);

        selectElement.appendChild(option);
    });
    // The select registers new options asynchronously; setting its value
    // after that updates the displayed text too.
    selectElement.value = selectedId;
    requestAnimationFrame(() => {
        if (selectElement.value === selectedId) selectElement.value = selectedId;
    });
}

async function refreshDeviceLists() {
    const [cameras, mics] = await Promise.all([
        getAvailableDevices("videoinput", "Camera"),
        getAvailableDevices("audioinput", "Microphone"),
    ]);
    setMaterialSelect(cameras, AppUI.getElement("cameraSource"));
    setMaterialSelect(mics, AppUI.getElement("audioSource"));
}

// --- App Lifecycle Handlers (Connect / Disconnect) ---
function setAppStatus(status) {
    AppUI.setHidden("disconnected", true);
    AppUI.setHidden("connecting", true);
    AppUI.setHidden("connected", true);
    AppUI.setHidden("speaking", true);

    switch (status) {
        case "disconnected":
            AppUI.setHidden("disconnected", false);
            AppUI.setDisabled("connectBtn", false);
            AppUI.setDisabled("disconnectBtn", true);

            if (AppState.liveVideoOutputManager) {
                const recordings = AppState.liveVideoOutputManager.getRecordings();
                const stamp = Date.now();
                recordings.forEach((blob, i) => {
                    const part = recordings.length > 1 ? `_part${i + 1}` : "";
                    downloadBlob(blob, `received_video_${stamp}${part}.mp4`);
                });
                AppState.liveVideoOutputManager.clearRecordedChunks();
            }
            break;
        case "connecting":
            AppUI.setHidden("connecting", false);
            AppUI.setDisabled("connectBtn", true);
            // Disconnect cancels a connect that is taking too long.
            AppUI.setDisabled("disconnectBtn", false);
            break;
        case "connected":
            AppUI.setHidden("connected", false);
            AppUI.setDisabled("connectBtn", true);
            AppUI.setDisabled("disconnectBtn", false);
            break;
        case "speaking":
            AppUI.setHidden("speaking", false);
            break;
        default:
            break;
    }
}

/** Switches between the "connected" and "model speaking" badges. */
function setModelSpeaking(speaking) {
    const connected = !AppUI.getElement("connected").hidden;
    const speakingNow = !AppUI.getElement("speaking").hidden;
    if (speaking && connected) {
        setAppStatus("speaking");
    } else if (!speaking && speakingNow) {
        setAppStatus("connected");
    }
}

function setMediaButtonsEnabled(enabled) {
    for (const id of ["micOffBtn", "cameraOffBtn", "screenBtn"]) {
        const element = AppUI.getElement(id);
        const iconBtn = element && element.querySelector("md-filled-icon-button");
        if (iconBtn) iconBtn.disabled = !enabled;
    }
}

/** Tears down media and UI state when a session ends, for whatever reason. */
function endSession() {
    AppState.geminiLiveApi.disconnect();
    stopAudioInput();
    AppState.liveVideoManager.stopWebcam();
    AppState.liveScreenManager.stopCapture();
    showMicState(false);
    showCameraState(false);
    setMediaButtonsEnabled(false);
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    AppState.liveAudioOutputManager.clear();
    // The next Connect starts a new conversation unless the user pastes a
    // handle back in, so keep the last one where they can find it.
    const handleInput = AppUI.getElement("handle");
    if (handleInput && handleInput.value) {
        newSystemMessage(
            `To resume this conversation later, enter this handle in Advanced Settings: ${handleInput.value}`
        );
        handleInput.value = "";
    }
    // Before resetPlayer(), which discards the recorded video this saves.
    setAppStatus("disconnected");
    AppState.liveVideoOutputManager.resetPlayer();
}

function connectBtnClick() {
    setAppStatus("connecting");
    console.log("Connecting...");
    // Runs inside the click, so the browser's autoplay policy allows audio.
    // Safari also needs play() on the video element during the click, or it
    // refuses to start the avatar's sound when the stream arrives later.
    AppState.liveAudioOutputManager.resume();
    const avatarVideo = AppUI.getElement("video_player");
    if (avatarVideo) {
        avatarVideo.muted = false;
        avatarVideo.play().catch(() => {}); // No source yet; this only unlocks.
    }
    AppUI.setText("usage-tokens", "--");

    handleModelChange();

    let transportMode = AppUI.getValue("transportMode", "webrtc");
    if (
        isWebSocketOnlyEnvironment(AppUI.getValue("envApiHost")) &&
        transportMode === "webrtc"
    ) {
        transportMode = "websocket";
        const transportSelect = AppUI.getElement("transportMode");
        if (transportSelect) {
            transportSelect.value = "websocket";
        }
    }
    AppState.geminiLiveApi.setTransportMode(transportMode);
    AppUI.setText(
        "active-transport",
        transportMode === "webrtc" ? "WebRTC" : "WebSocket"
    );
    AppUI.setText(
        "webrtc-state",
        transportMode === "webrtc" ? "negotiating" : "n/a"
    );

    AppState.liveVideoOutputManager.recordingEnabled = AppUI.getChecked("saveAvatarVideo");
    if (transportMode === "websocket") {
        AppState.liveVideoOutputManager.initMediaSource();
    }

    AppState.geminiLiveApi.responseModalities = [getSelectedResponseModality()];
    AppState.geminiLiveApi.systemInstructions = AppUI.getValue("systemInstructions");

    AppState.geminiLiveApi.setModel(AppUI.getValue("liveApiModel"));
    AppState.geminiLiveApi.setTranscript(
        AppUI.getChecked("inputTranscript"),
        AppUI.getChecked("outputTranscript")
    );
    AppState.geminiLiveApi.setResumption(
        AppUI.getChecked("resumption"),
        AppUI.getValue("handle")
    );
    AppState.geminiLiveApi.setBitrates(
        AppUI.getValue("audioBitrate"),
        AppUI.getValue("videoBitrate")
    );
    AppState.geminiLiveApi.setVoice(
        AppUI.getValue("voiceName"),
        AppUI.getValue("voiceLocale")
    );
    AppState.geminiLiveApi.setVad(
        AppUI.getChecked("disableInterruption"),
        AppUI.getChecked("disableDetection"),
        AppUI.getValue("startSensitivity"),
        AppUI.getValue("endSensitivity")
    );
    AppState.geminiLiveApi.setCustomVoice(AppState.customVoiceBase64);
    AppState.geminiLiveApi.setFunctionCall(AppState.functionCallDefinition);
    AppState.geminiLiveApi.toolBehavior = AppUI.getValue("toolBehavior", "BLOCKING");
    AppState.geminiLiveApi.setProactiveVideo(AppUI.getChecked("proactiveVideo"));
    AppState.geminiLiveApi.setS2ST(
        AppUI.getChecked("enableS2ST"),
        AppUI.getValue("s2stTargetLanguage")
    );
    AppState.geminiLiveApi.setLocation(AppUI.getValue("location"));
    AppState.geminiLiveApi.setApiHost(AppUI.getValue("envApiHost"));
    AppState.geminiLiveApi.avatarMode = AppUI.getChecked("enableAvatarMode");
    AppState.geminiLiveApi.googleSearchEnabled = AppUI.getChecked("enableGoogleSearch");

    AppState.geminiLiveApi.onConnectionStarted = () => {
        setMediaButtonsEnabled(true);
        setAppStatus("connected");
    };
    AppState.geminiLiveApi.connect();
}

function disconnectBtnClick() {
    endSession();

    AppState.customVoiceBase64 = "";
    AppState.functionCallDefinition = null;

    for (const id of ["audioFileInput", "fcFileInput"]) {
        const input = AppUI.getElement(id);
        if (input) input.value = "";
    }

    AppUI.setText("fileName", "");
    AppUI.setText("fcFileName", "");
}

// --- Branded Voice / Reference Voice Modal Operations ---
function openModal() {
    const modal = AppUI.getElement("brandedVoiceModal");
    if (modal) modal.style.display = "flex";

    const nameInput = AppUI.getElement("newVoiceName");
    if (nameInput) nameInput.value = "";

    AppUI.setDisabled("recordButton", false);
    AppUI.setButtonWithIcon("recordButton", "mic", "Record reference voice");
    AppUI.setText("recordStatus", "");
    AppUI.setHidden("processingSpinner", true);

    AppState.isRecording = false;
    AppState.audioChunks = [];
}

function closeModal() {
    const modal = AppUI.getElement("brandedVoiceModal");
    if (modal) modal.style.display = "none";
}

async function handleRecordClick() {
    const nameInput = AppUI.getElement("newVoiceName");
    const voiceName = nameInput ? nameInput.value.trim() : "";
    if (voiceName === "") {
        AppUI.showModal("Please enter a name for the reference voice.");
        if (nameInput) nameInput.focus();
        return;
    }

    if (AppState.isRecording) {
        const duration = (new Date() - AppState.recordingStartTime) / 1000;
        if (duration < 10) {
            AppUI.showModal(
                "A recording of at least 10 seconds is required to ensure reference voice quality."
            );
            return;
        }

        if (AppState.mediaRecorder) {
            AppState.mediaRecorder.stop();
        }

        AppUI.setDisabled("recordButton", true);
        AppUI.setText("recordStatus", "Processing recorded sample...");
        AppUI.setHidden("processingSpinner", false);
        AppUI.setButtonWithIcon("recordButton", "hourglass_empty", "Processing...");

        AppState.isRecording = false;
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = MediaRecorder.isTypeSupported("audio/wav")
                ? "audio/wav"
                : "audio/webm";
            AppState.mediaRecorder = new MediaRecorder(stream, { mimeType });

            AppState.mediaRecorder.ondataavailable = (event) => {
                AppState.audioChunks.push(event.data);
            };

            AppState.mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(AppState.audioChunks, { type: mimeType });
                console.log("Audio resampling started...");

                const targetSampleRate = 24000;
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const decodedBuffer = await audioContext.decodeAudioData(
                    await audioBlob.arrayBuffer()
                );

                const offlineContext = new OfflineAudioContext(
                    decodedBuffer.numberOfChannels,
                    decodedBuffer.duration * targetSampleRate,
                    targetSampleRate
                );
                const source = offlineContext.createBufferSource();
                source.buffer = decodedBuffer;
                source.connect(offlineContext.destination);
                source.start();
                const resampledBuffer = await offlineContext.startRendering();

                const wavBlob = bufferToWave(resampledBuffer);
                console.log("Audio resampling finished.");

                const reader = new FileReader();
                reader.onloadend = () => {
                    if (typeof reader.result === "string") {
                        AppState.customVoiceBase64 = reader.result.split(",")[1] || "";
                    }

                    const newOption = document.createElement("option");
                    newOption.value = voiceName.toLowerCase().replace(/\s/g, "-");
                    newOption.textContent = voiceName;
                    newOption.selected = true;

                    const voiceDropdown = AppUI.getElement("voice-dropdown");
                    if (voiceDropdown) voiceDropdown.appendChild(newOption);

                    AppUI.showModal(
                        `New branded voice "${voiceName}" has been successfully created and selected!`
                    );
                    closeModal();
                    AppState.audioChunks = [];
                };
                reader.readAsDataURL(wavBlob);
            };

            AppState.mediaRecorder.start();
            AppState.recordingStartTime = new Date();
            AppState.isRecording = true;

            AppUI.setButtonWithIcon("recordButton", "stop", "Stop Recording");
            AppUI.setText("recordStatus", "Recording... (Please speak for at least 10 seconds)");
        } catch (error) {
            console.error("Error accessing microphone for reference voice recording:", error);
            AppUI.showModal("Could not access microphone. Please check your browser permissions.");
        }
    }
}

function bufferToWave(abuffer) {
    const numOfChan = abuffer.numberOfChannels;
    const length = abuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let i;
    let sample;
    let offset = 0;
    let pos = 0;

    function setUint16(data) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data) {
        view.setUint32(pos, data, true);
        pos += 4;
    }

    // write WAVE header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit

    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); // chunk length

    // write interleaved data
    for (i = 0; i < abuffer.numberOfChannels; i++) {
        channels.push(abuffer.getChannelData(i));
    }

    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
            sample = (sample < 0 ? sample * 32768 : sample * 32767) | 0;
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset++;
    }

    return new Blob([view], { type: "audio/wav" });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

function toggleSchedulingDisable() {
    const toolBehaviorVal = AppUI.getValue("toolBehavior");
    const fcScheduling = AppUI.getElement("fcScheduling");
    if (fcScheduling) {
        fcScheduling.disabled = (toolBehaviorVal === "BLOCKING");
    }
}

function toggleAvatarMode() {
    const isChecked = AppUI.getChecked("enableAvatarMode", true);
    const videoContainer = AppUI.getElement("video-preview-container");
    if (!videoContainer) return;

    if (isChecked) {
        videoContainer.classList.add("avatar-mode");
    } else {
        videoContainer.classList.remove("avatar-mode");
    }
}

function showDialogWithMessage(messageText) {
    AppUI.showModal(messageText);
}

// --- Expose Public HTML Interface on Global Window Scope ---
window.AppState = AppState;
window.AppUI = AppUI;
window.connectBtnClick = connectBtnClick;
window.disconnectBtnClick = disconnectBtnClick;
window.micBtnClick = micBtnClick;
window.micOffBtnClick = micOffBtnClick;
window.cameraBtnClick = cameraBtnClick;
window.cameraOffBtnClick = cameraOffBtnClick;
window.screenShareBtnClick = screenShareBtnClick;
window.newUserMessage = newUserMessage;
window.newCameraSelected = newCameraSelected;
window.newMicSelected = newMicSelected;
window.toggleSchedulingDisable = toggleSchedulingDisable;
window.toggleAvatarMode = toggleAvatarMode;
window.showDialogWithMessage = showDialogWithMessage;
