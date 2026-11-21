// @ts-check
/**
 * Global application state and UI coordinator for the Gemini Realtime Demo web application.
 * Manages WebSocket connections, media devices (camera/mic/screen), Cookie persistence,
 * tool/function calling declarations, and secure DOM manipulations.
 */

/* global GeminiLiveAPI, LiveAudioOutputManager, LiveVideoOutputManager, LiveAudioInputManager,
   MicLevelMeter, LiveVideoManager, LiveScreenManager, getAvatarVideoElement -- from
   gemini-live-api.js and live-media-manager.js, loaded before this script (see index.html) */

// --- Application Configuration ---
const isHttps = window.location.protocol === "https:";
const wsProtocol = isHttps ? "wss:" : "ws:";
const host = window.location.host;

const AppConfig = {
    PROXY_URL: `${wsProtocol}//${host}/ws`,
    CONTROL_URL: "/api/control",
    FR_SERVICE_URL: "/api/post_endpoint",
};

// --- Secure UI Management ---
/**
 * The members this script uses on form controls: native inputs and selects,
 * and their Material Web counterparts (md-outlined-select, md-checkbox, ...),
 * which tsc has no types for. Not every control has every member.
 * @typedef {HTMLElement & {
 *     value: string,
 *     checked: boolean,
 *     disabled: boolean,
 *     options?: Iterable<{value: string}>,
 *     updateComplete?: Promise<unknown>,
 * }} FormControl
 */

const AppUI = {
    getElement(id) {
        return document.getElementById(id);
    },
    /** @returns {FormControl | null} */
    getControl(id) {
        return /** @type {FormControl | null} */ (document.getElementById(id));
    },
    /** True if the element is hidden or missing. */
    isHidden(id) {
        const el = this.getElement(id);
        return el ? el.hidden : true;
    },
    setHidden(id, hidden) {
        const el = this.getElement(id);
        if (el) el.hidden = hidden;
    },
    setDisabled(id, disabled) {
        const el = this.getControl(id);
        if (el) el.disabled = disabled;
    },
    setText(id, text) {
        const el = this.getElement(id);
        if (el) el.textContent = text; // Secure against XSS
    },
    getValue(id, fallback = "") {
        const el = this.getControl(id);
        return el ? el.value : fallback;
    },
    getChecked(id, fallback = false) {
        const el = this.getControl(id);
        return el ? el.checked : fallback;
    },
    showModal(message) {
        const dialog = /** @type {(HTMLElement & {show?: () => void}) | null} */ (
            this.getElement("dialog")
        );
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

// --- Application State Coordinator ---
// The managers are created as the script loads (it is deferred, so the DOM is
// parsed); initApplicationManagers() then wires their callbacks.
const AppState = {
    geminiLiveApi: new GeminiLiveAPI(AppConfig.PROXY_URL, AppConfig.CONTROL_URL, AppConfig.FR_SERVICE_URL),
    liveAudioOutputManager: new LiveAudioOutputManager(),
    liveVideoOutputManager: new LiveVideoOutputManager(),
    liveAudioInputManager: new LiveAudioInputManager(),
    micLevelMeter: new MicLevelMeter(() => {}), // onLevel is set in initApplicationManagers().
    // Camera and screen sharing share the preview <video> and <canvas>.
    liveVideoManager: new LiveVideoManager(AppUI.getElement("video"), AppUI.getElement("canvas")),
    liveScreenManager: new LiveScreenManager(AppUI.getElement("video"), AppUI.getElement("canvas")),
    customVoiceBase64: "",
    /** @type {object[] | null} */
    functionCallDefinition: null,
    /** @type {MediaRecorder | null} */
    mediaRecorder: null,
    /** @type {Blob[]} */
    audioChunks: [],
    isRecording: false,
    userTurnActive: false, // Between "Start speaking" and "Done speaking"
    /** @type {(() => void) | null} */
    cancelRecording: null, // Stops the voice recording in progress, if any
    recordingAttempt: 0, // Advanced by each Record click and by closing the dialog
    turnStarting: false, // "Start speaking" is waiting for the microphone
    /** @type {string | null} */
    preferredTransport: null, // The transport the user last picked
    recordingStartTime: 0, // Date.now() when the voice recording started
};

// --- Manager Callbacks ---
function initApplicationManagers() {
    AppState.geminiLiveApi.onErrorMessage = (message) => {
        AppUI.showModal(message);
        newErrorMessage(message);
        endSession();
    };

    AppState.geminiLiveApi.onIdleTimeout = (message) => {
        AppUI.showModal(message);
        newSystemMessage(message);
        endSession();
    };
    // Using the page counts as activity for the idle timeout. Capture, so
    // controls that stop propagation still count.
    for (const type of ["pointerdown", "keydown", "wheel"]) {
        document.addEventListener(type, () => AppState.geminiLiveApi.noteActivity(), {
            capture: true,
            passive: true,
        });
    }

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

    const showAutoplayBlocked = () => {
        AppUI.showModal(
            "The browser blocked audio and video playback. Press play on the avatar video to start it."
        );
    };
    AppState.liveVideoOutputManager.onAutoplayBlocked = showAutoplayBlocked;
    AppState.liveVideoOutputManager.onPlaybackError = (message) => newErrorMessage(message);
    if (AppState.geminiLiveApi.webRtcManager) {
        AppState.geminiLiveApi.webRtcManager.onAutoplayBlocked = showAutoplayBlocked;
    }

    const micLevelBar = AppUI.getElement("micLevelBar");
    AppState.micLevelMeter.onLevel = (level) => {
        if (micLevelBar) micLevelBar.style.transform = `scaleY(${level.toFixed(3)})`;
    };

    AppState.liveAudioInputManager.onNewAudioRecordingChunk = (audioData) => {
        AppState.geminiLiveApi.sendAudioMessage(audioData);
    };

    const videoElement = AppState.liveVideoManager.previewVideoElement;
    // Covers both camera and screen sharing, which share this element.
    videoElement.addEventListener("loadedmetadata", () => AppUI.setHidden("previewPlaceholder", true));
    videoElement.addEventListener("emptied", () => AppUI.setHidden("previewPlaceholder", false));

    AppState.liveVideoManager.onNewFrame = (b64Image) => {
        AppState.geminiLiveApi.sendImageMessage(b64Image);
    };

    AppState.liveScreenManager.onNewFrame = (b64Image) => {
        AppState.geminiLiveApi.sendImageMessage(b64Image);
    };
}

initApplicationManagers();

// --- Settings Persistence ---
// Fields restored on reload, kept in localStorage (not cookies, which went to
// the server with every request).
const PERSISTED_FIELDS = [
    "transportMode",
    "location",
    "envApiHost",
    "liveApiModel",
    "voiceName",
    "voiceLocale",
    "systemInstructions",
];
const PERSISTED_CHECKBOXES = [
    "enableGoogleSearch",
    "enableAvatarMode",
    "inputTranscript",
    "outputTranscript",
];
const SETTINGS_KEY = "liveapi-demo-settings";

function loadSavedSettings() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") || {};
    } catch {
        // Missing or corrupt; start from the page defaults.
    }
    // One-time migration from the cookies earlier versions used.
    for (const id of ["systemInstructions", "location"]) {
        const match = document.cookie.match(new RegExp(`(?:^|;\\s*)CookieJar_${id}=([^;]*)`));
        if (match) {
            if (saved[id] === undefined) saved[id] = decodeURIComponent(match[1]);
            document.cookie = `CookieJar_${id}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        }
    }
    return saved;
}

function saveSettings() {
    const settings = {};
    for (const id of PERSISTED_FIELDS) {
        const element = AppUI.getControl(id);
        if (element) settings[id] = element.value;
    }
    for (const id of PERSISTED_CHECKBOXES) {
        const element = AppUI.getControl(id);
        if (element) settings[id] = element.checked;
    }
    settings.responseModality = getSelectedResponseModality();
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.warn("Could not save settings:", error);
    }
}

async function restoreSettings() {
    const saved = loadSavedSettings();
    await Promise.all(
        ["md-outlined-select", "md-outlined-text-field", "md-checkbox", "md-radio"].map((name) =>
            customElements.whenDefined(name)
        )
    );
    for (const id of PERSISTED_CHECKBOXES) {
        const element = AppUI.getControl(id);
        if (!element) continue;
        if (typeof saved[id] === "boolean") element.checked = saved[id];
        element.addEventListener("change", saveSettings);
    }
    for (const radio of getResponseModalityRadios()) {
        if (typeof saved.responseModality === "string") {
            radio.checked = radio.value === saved.responseModality;
        }
        radio.addEventListener("change", saveSettings);
    }
    toggleAvatarMode(); // Apply the restored avatar-mode layout.
    for (const id of PERSISTED_FIELDS) {
        const element = AppUI.getControl(id);
        if (!element) continue;
        await element.updateComplete;
        const value = saved[id];
        // Skip choices the page no longer offers, e.g. a retired model.
        const offered =
            !element.options || [...element.options].some((option) => option.value === value);
        if (typeof value === "string" && offered) {
            element.value = value;
        }
        element.addEventListener("input", saveSettings);
        element.addEventListener("change", saveSettings);
    }
    saveSettings();
}

// --- Page Load Event Initialization ---
window.addEventListener("load", () => {
    console.log("Hello Gemini Realtime Demo!");

    initDOMEventListeners();
    restoreSettings();
    refreshDeviceLists();
    if (navigator.mediaDevices) {
        navigator.mediaDevices.addEventListener("devicechange", refreshDeviceLists);
    }
    toggleAvatarMode();
});

// --- DOM Event Listeners Setup ---
function initDOMEventListeners() {
    // index.html has no inline on* handlers: the Content-Security-Policy
    // (backend/main.py) blocks them.
    const clickToOpen = (inputId) => () => AppUI.getElement(inputId)?.click();
    /** @type {[string, string, (event: any) => void][]} */
    const listeners = [
        ["#cameraSource", "change", newCameraSelected],
        ["#audioSource", "change", newMicSelected],
        ["#micBtn md-filled-icon-button", "click", micBtnClick],
        ["#micOffBtn md-filled-icon-button", "click", micOffBtnClick],
        ["#cameraBtn md-filled-icon-button", "click", cameraBtnClick],
        ["#cameraOffBtn md-filled-icon-button", "click", cameraOffBtnClick],
        ["#turnBtn", "click", turnBtnClick],
        ["#screenBtn md-filled-icon-button", "click", screenShareBtnClick],
        ["#sendMessageBtn", "click", newUserMessage],
        ["#connectBtn", "click", connectBtnClick],
        ["#disconnectBtn", "click", disconnectBtnClick],
        ["#audioUploadBtn", "click", clickToOpen("audioFileInput")],
        ["#fcUploadBtn", "click", clickToOpen("fcFileInput")],
        ["#fcRemove", "click", removeFunctionDeclarations],
        ["#toolBehavior", "change", toggleSchedulingDisable],
        ["#enableAvatarMode", "change", toggleAvatarMode],
        ["#avatarUploadBtn", "click", clickToOpen("avatarFileInput")],
        ["#avatarSampleLink", "click", useSampleAvatar],
        ["#avatarStockLink", "click", useStockAvatar],
        [
            "#enableS2ST",
            "change",
            (event) => AppUI.setDisabled("s2stTargetLanguage", !event.target.checked),
        ],
    ];
    for (const [selector, type, handler] of listeners) {
        const element = document.querySelector(selector);
        if (element) {
            element.addEventListener(type, handler);
        } else {
            console.warn(`No element for ${selector}`);
        }
    }

    const audioFileInput = AppUI.getElement("audioFileInput");
    if (audioFileInput) {
        audioFileInput.addEventListener("change", handleAudioFileInputChange);
    }

    const fcFileInput = AppUI.getElement("fcFileInput");
    if (fcFileInput) {
        fcFileInput.addEventListener("change", handleFcFileInputChange);
    }

    const avatarFileInput = AppUI.getElement("avatarFileInput");
    if (avatarFileInput) {
        avatarFileInput.addEventListener("change", handleAvatarFileInputChange);
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

    const voiceDropdown = AppUI.getElement("voice-dropdown");
    if (voiceDropdown) {
        voiceDropdown.addEventListener("change", selectBrandedVoice);
    }

    const envSelect = AppUI.getControl("envApiHost");
    if (envSelect) {
        envSelect.addEventListener("change", handleEnvironmentChange);
    }

    const modelSelect = AppUI.getControl("liveApiModel");
    if (modelSelect) {
        modelSelect.addEventListener("change", handleModelChange);
    }

    const transportSelect = AppUI.getControl("transportMode");
    if (transportSelect) {
        transportSelect.addEventListener("change", () => {
            AppState.preferredTransport = transportSelect.value;
        });
    }

    const textMessage = AppUI.getControl("text-message");
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
    const modelSelect = AppUI.getControl("liveApiModel");
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
    const transportSelect = AppUI.getControl("transportMode");
    if (transportSelect) {
        if (isWebSocketOnlyEnvironment(envVal)) {
            if (transportSelect.value === "webrtc") transportSelect.value = "websocket";
        } else if (AppState.preferredTransport) {
            // Back from a WebSocket-only environment: restore the user's choice.
            transportSelect.value = AppState.preferredTransport;
        }
    }
    saveSettings(); // Programmatic changes don't fire change events.
}

function handleModelChange() {
    const selectedModel = AppUI.getValue("liveApiModel");
    if (!US_CENTRAL1_REGIONAL_ONLY_MODELS.has(selectedModel)) {
        return;
    }

    const locationInput = AppUI.getControl("location");
    if (locationInput && locationInput.value !== "us-central1") {
        locationInput.value = "us-central1";
    }

    const envSelect = AppUI.getControl("envApiHost");
    if (!envSelect) return;
    const envVal = envSelect.value;
    if (envVal === "staging-us-rep" || envVal === "staging-common") {
        envSelect.value = "staging";
    } else if (envVal === "autopush-us-rep" || isCommonEnvironment(envVal)) {
        envSelect.value = "autopush";
    } else if (envVal === "prod-us-rep") {
        envSelect.value = "prod";
    }
    saveSettings(); // Programmatic changes don't fire change events.
}

// --- Input Handlers ---
// --- Branded voice samples ---
// Samples are sent as 24 kHz mono 16-bit WAV, the format used by
// feature/Live_API_Branded_Voice.ipynb, whatever format the user provides.
const VOICE_SAMPLE_RATE = 24000;
const MIN_VOICE_SAMPLE_S = 10;
const BrandedVoices = new Map(); // voice-dropdown value -> base64 WAV

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * Converts any audio the browser can decode to a 24 kHz mono WAV sample.
 * @param {ArrayBuffer} audioData
 * @returns {Promise<{base64: string, durationS: number}>}
 */
async function toVoiceSample(audioData) {
    // Offline contexts can decode too, and need no closing; Chrome limits how
    // many realtime AudioContexts a page may hold.
    const decoded = await new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE).decodeAudioData(
        audioData
    );
    const offline = new OfflineAudioContext(
        1, // Mixing to a mono destination downmixes stereo input.
        Math.ceil(decoded.duration * VOICE_SAMPLE_RATE),
        VOICE_SAMPLE_RATE
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return { base64: await blobToBase64(bufferToWave(rendered)), durationS: decoded.duration };
}

/** Adds a voice to the Branded Voice dropdown and selects it. */
function addBrandedVoice(name, base64) {
    const dropdown = AppUI.getControl("voice-dropdown");
    if (!dropdown) return;
    const id = `custom-${BrandedVoices.size + 1}`;
    BrandedVoices.set(id, base64);
    const option = document.createElement("option");
    option.value = id;
    option.textContent = name;
    dropdown.appendChild(option);
    dropdown.value = id;
    selectBrandedVoice();
}

function selectBrandedVoice() {
    const dropdown = AppUI.getControl("voice-dropdown");
    AppState.customVoiceBase64 = (dropdown && BrandedVoices.get(dropdown.value)) || "";
}

// --- Custom avatar image ---
async function setAvatarImage(blob, name) {
    AppState.geminiLiveApi.setCustomizedAvatar(await blobToBase64(blob), blob.type || "image/png");
    AppUI.setText("avatarName", `Avatar: ${name}`);
    AppUI.setHidden("avatarStockLink", false);
}

async function handleAvatarFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ""; // So choosing the same file again fires change.
    try {
        await setAvatarImage(file, file.name);
    } catch (error) {
        AppUI.showModal(`Could not read "${file.name}": ${error.message}`);
    }
}

async function useSampleAvatar() {
    try {
        const response = await fetch("/frontend/assets/avatar_image.png");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await setAvatarImage(await response.blob(), "sample image");
    } catch (error) {
        AppUI.showModal(`Could not load the sample avatar image: ${error.message}`);
    }
}

function useStockAvatar() {
    AppState.geminiLiveApi.setCustomizedAvatar("", "image/png");
    AppUI.setText("avatarName", "Avatar: Piper (stock)");
    AppUI.setHidden("avatarStockLink", true);
}

async function handleAudioFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ""; // So choosing the same file again fires change.

    try {
        const { base64, durationS } = await toVoiceSample(await file.arrayBuffer());
        addBrandedVoice(file.name, base64);
        AppUI.setText("fileName", `File: ${file.name} (${durationS.toFixed(1)} s)`);
        AppUI.showModal(
            durationS < MIN_VOICE_SAMPLE_S
                ? `"${file.name}" is ${durationS.toFixed(1)} s long. It is selected, but a ` +
                  `sample of at least ${MIN_VOICE_SAMPLE_S} s gives a more faithful voice.`
                : `Branded voice "${file.name}" is selected. It applies from the next connection.`
        );
    } catch (error) {
        console.error("Could not read voice sample:", error);
        AppUI.showModal(`Could not read "${file.name}" as audio: ${error.message}`);
    }
}

function handleFcFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const declarations = GeminiLiveAPI.toFunctionDeclarations(JSON.parse(String(reader.result)));
            const unnamed = declarations.filter((d) => !d || typeof d.name !== "string");
            if (declarations.length === 0 || unnamed.length > 0) {
                throw new Error("expected a list of function declarations, each with a name");
            }
            AppState.functionCallDefinition = declarations;
            const names = declarations.map((d) => d.name).join(", ");
            AppUI.setText("fcFileName", `File: ${file.name} (${names})`);
            AppUI.setHidden("fcRemove", false);
            AppUI.showModal(
                `Loaded ${declarations.length} function declaration(s) from "${file.name}". ` +
                "They apply from the next connection."
            );
        } catch (error) {
            AppUI.showModal(`Could not use "${file.name}": ${error.message}`);
        }
        event.target.value = ""; // So choosing the same file again fires change.
    };
    reader.readAsText(file);
}

function removeFunctionDeclarations() {
    AppState.functionCallDefinition = null;
    AppUI.setText("fcFileName", "");
    AppUI.setHidden("fcRemove", true);
}

/** @returns {NodeListOf<FormControl>} */
function getResponseModalityRadios() {
    return document.querySelectorAll('md-radio[name="responseModality"]');
}

function getSelectedResponseModality() {
    let selectedValue = "VIDEO";
    for (const radioButton of getResponseModalityRadios()) {
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
        case "SETUP COMPLETE": {
            const api = AppState.geminiLiveApi;
            const transport = isWebRtcTransport() ? "WebRTC" : "WebSocket";
            // The server's session ID finds this session in server-side logs.
            const session = messageResponse.sessionId ? `, session ${messageResponse.sessionId}` : "";
            newSystemMessage(
                `Setup complete: ${api.resolvedModel || api.model} on ${api.endPoint} over ${transport}${session}.`
            );
            AppUI.setText("server-session-id", messageResponse.sessionId || "--");
            startConnectionTimer();
            break;
        }
        case "GENERATION_STARTED":
            // Over WebRTC without output transcripts, this is the only sign
            // of the response the client sees (audio arrives over RTP).
            if (isWebRtcTransport() && !AppState.geminiLiveApi.enableOutputTranscript) {
                markModelResponse("generation start");
            }
            closeTranscriptLine("input");
            setModelSpeaking(true);
            break;
        case "AUDIO":
            markModelResponse();
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
            markModelResponse();
            closeTranscriptLine("input");
            setModelSpeaking(true);
            // Model text is exact, unlike transcripts; leave its spacing alone.
            appendTranscript("output", messageResponse.data, { fixSpacing: false });
            break;
        case "RESUMPTION": {
            console.log("Resumption handle received: ", messageResponse.data);
            const enableResumption = AppUI.getControl("resumption");
            if (enableResumption) enableResumption.checked = true;

            const resumptionHandle = AppUI.getControl("handle");
            if (resumptionHandle) resumptionHandle.value = messageResponse.data;
            break;
        }
        case "GO_AWAY":
            console.log("GoAway message received. Time left: ", messageResponse.data);
            switch (AppState.geminiLiveApi.goAwayAction()) {
                case "resume":
                    newSystemMessage("Connection expiring. Reconnecting for session resumption...");
                    handleSessionResumptionReconnect();
                    break;
                case "limited":
                    newErrorMessage(
                        "The server keeps closing connections, so the session won't be resumed " +
                        "again; it ends when the server closes this connection."
                    );
                    break;
                default:
                    newSystemMessage(
                        "The server will close this connection soon. Enable session resumption " +
                        "to continue the conversation on a new connection."
                    );
            }
            break;
        case "INPUT_TRANSCRIPTION":
            if (messageResponse.data) markUserTurnEnd("speech");
            appendTranscript("input", messageResponse.data);
            if (messageResponse.finished) closeTranscriptLine("input");
            break;
        case "OUTPUT_TRANSCRIPTION":
            markModelResponse();
            closeTranscriptLine("input");
            setModelSpeaking(true);
            appendTranscript("output", messageResponse.data);
            if (messageResponse.finished) closeTranscriptLine("output");
            break;
        case "END_OF_TURN":
            closeTranscriptLine("output");
            setModelSpeaking(false);
            resetLatencyTurn();
            break;
        case "INTERRUPT":
            if (AppState.liveAudioOutputManager) {
                AppState.liveAudioOutputManager.clear();
            }
            resetLatencyTurn();
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

// --- Response latency ---
// Time from the end of the user's turn to the model's first audio or text.
// For speech, the end is approximated by the last input transcript.
const LatencyState = {
    /** @type {number | null} */
    turnEndedAt: null,
    source: "",
    responding: false,
};

/**
 * Records (or moves) the end of the user's turn. Input transcripts trail the
 * speech, so ones that arrive once the model is answering are ignored.
 */
function markUserTurnEnd(source, { force = false } = {}) {
    if (LatencyState.responding && !force) return;
    if (force) LatencyState.responding = false;
    LatencyState.turnEndedAt = performance.now();
    LatencyState.source = source;
}

/** The model's first response in a turn; `what` names it if not audio/text. */
function markModelResponse(what = "") {
    LatencyState.responding = true;
    if (LatencyState.turnEndedAt === null) return;
    const ms = Math.round(performance.now() - LatencyState.turnEndedAt);
    LatencyState.turnEndedAt = null;
    const after = {
        text: "after text",
        speech: "after last transcript",
        "end of turn": "after Done speaking",
    }[LatencyState.source];
    AppUI.setText("response-latency", `${ms.toLocaleString()} ms ${after}${what ? ` (to ${what})` : ""}`);
}

function resetLatencyTurn() {
    LatencyState.turnEndedAt = null;
    LatencyState.responding = false;
}

// --- Connection age ---
// Time since the current connection was set up (reset by resumption). The
// server sends GoAway based on connection age, so this helps when testing it.
/** @type {number | null} */
let connectionTimer = null;

function startConnectionTimer() {
    stopConnectionTimer();
    const startedAt = Date.now();
    const tick = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        AppUI.setText(
            "connection-age",
            `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
        );
    };
    tick();
    connectionTimer = setInterval(tick, 1000);
}

function stopConnectionTimer() {
    clearInterval(connectionTimer);
    connectionTimer = null;
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
    setUserTurnActive(false); // The new session never saw activity_start.
    resetLatencyTurn();
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

async function simulateFunctionResponse(funcCall, sessionId) {
    try {
        return {
            result: await AppState.geminiLiveApi.sendPostRequest(AppState.geminiLiveApi.frUrl, {
                objective: "fr_generate",
                session_id: sessionId,
                functionName: funcCall.name,
                functionArgs: funcCall.args,
            }),
        };
    } catch (error) {
        console.error(`Simulating ${funcCall.name} failed:`, error);
        // After a reconnect the old session is gone; that isn't the function's fault.
        if (AppState.geminiLiveApi.sessionId === sessionId) {
            newErrorMessage(`Function ${funcCall.name} failed: ${error.message}`);
        }
        // Answer anyway: with BLOCKING tools the model waits for a response.
        return { error: error.message };
    }
}

async function handleFunctionCallRequest(functionCalls) {
    console.log("Function call requested: ", functionCalls);
    const api = AppState.geminiLiveApi;
    const webSocket = api.webSocket;
    const sessionId = api.sessionId;
    for (const funcCall of functionCalls) {
        newSystemMessage(`Function call: ${funcCall.name}(${JSON.stringify(funcCall.args || {})})`);
    }

    // Scheduling only applies to NON_BLOCKING functions.
    const schedulingVal =
        AppState.geminiLiveApi.toolBehavior === "NON_BLOCKING"
            ? AppUI.getValue("fcScheduling", "WHEN_IDLE")
            : null;
    // Sequential, since the simulator is one chat session per connection.
    const functionResponses = [];
    for (const funcCall of functionCalls) {
        if (api.webSocket !== webSocket) break;
        const response = await simulateFunctionResponse(funcCall, sessionId);
        if (schedulingVal) response.scheduling = schedulingVal;
        functionResponses.push({ id: funcCall.id, name: funcCall.name, response });
    }
    if (AppState.geminiLiveApi.webSocket !== webSocket) {
        // The connection that made these calls has closed or been replaced;
        // the new one doesn't know their IDs.
        console.warn("Dropping responses to calls from a previous connection.");
        if (AppUI.isHidden("disconnected")) {
            newSystemMessage(
                "The connection was replaced while function calls were running, so their " +
                "results weren't sent. Ask again if the model is waiting for them."
            );
        }
        return;
    }
    AppState.geminiLiveApi.sendMessage({ toolResponse: { functionResponses } });
}

// --- Chat Interface Helpers ---
const ChatState = {
    // The chat line each transcript stream is appending to, if any.
    /** @type {{input: HTMLElement | null, output: HTMLElement | null}} */
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
    // Collapse repeats (e.g. several interruptions in a row) into a count.
    const textChat = AppUI.getElement("text-chat");
    const last = /** @type {HTMLElement | null} */ (textChat && textChat.lastElementChild);
    if (last && last.classList.contains("chat-system") && last.dataset.message === message) {
        last.dataset.count = String(Number(last.dataset.count || 1) + 1);
        last.textContent = `${message} (×${last.dataset.count})`;
        return last;
    }
    const line = addMessageToChat(message, "system");
    if (line) line.dataset.message = message;
    return line;
}

function newErrorMessage(message) {
    return addMessageToChat(message, "error");
}

/**
 * Streams transcript text into one chat line per utterance.
 * @param {"input"|"output"} stream
 * @param {string} text
 * @param {{fixSpacing?: boolean}} [options] - fixSpacing: add the space that
 *     transcript fragments sometimes omit after a sentence.
 */
function appendTranscript(stream, text, { fixSpacing = true } = {}) {
    const textChat = AppUI.getElement("text-chat");
    if (!text || !textChat) return;
    let line = ChatState.transcriptLines[stream];
    if (!line || !line.isConnected) {
        line = addMessageToChat(TRANSCRIPT_LABELS[stream], stream === "input" ? "user" : "model");
        ChatState.transcriptLines[stream] = line;
    }
    if (!line) return;
    const atBottom = textChat.scrollHeight - textChat.scrollTop - textChat.clientHeight < 24;
    // Fragments don't always carry the space after a sentence ("dog.She").
    if (fixSpacing && /[.!?]$/.test(line.textContent) && /^\p{L}/u.test(text)) {
        text = " " + text;
    }
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
    const textMessage = AppUI.getControl("text-message");
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
    markUserTurnEnd("text", { force: true });

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
                AppUI.getValue("audioInterval") || "200"
            );
        }
        if (isMicOn()) {
            AppState.micLevelMeter.start(
                webRtcManager ? webRtcManager.micStream : AppState.liveAudioInputManager.stream
            );
            AppUI.setHidden("micLevel", false);
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
    AppState.micLevelMeter.stop();
    AppUI.setHidden("micLevel", true);
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
    endUserTurn(); // Turning the mic off mid-turn ends the turn.
    stopAudioInput();
    showMicState(false);
}

function micOffBtnClick() {
    showMicState(true);
    startAudioInput();
}

// With automatic activity detection disabled, the server only knows where a
// spoken turn starts and ends from activity_start/activity_end messages.
function setUserTurnActive(active) {
    AppState.userTurnActive = active;
    AppUI.setText("turnBtn", active ? "Done speaking" : "Start speaking");
}

async function turnBtnClick() {
    if (AppState.userTurnActive) {
        endUserTurn();
        return;
    }
    if (AppState.turnStarting) return; // Already waiting for the microphone.
    AppState.turnStarting = true;
    try {
        if (!isMicOn()) {
            showMicState(true);
            await startAudioInput();
            if (!isMicOn()) return; // The microphone failed to start.
        }
        AppState.geminiLiveApi.sendVoiceActivityMessage(true);
        setUserTurnActive(true);
    } finally {
        AppState.turnStarting = false;
    }
}

function endUserTurn() {
    if (!AppState.userTurnActive) return;
    // Over WebSocket, audio is sent every audioInterval ms; send what is
    // buffered first, or the end of the utterance arrives after activity_end.
    if (!isWebRtcTransport()) AppState.liveAudioInputManager.recordChunk();
    AppState.geminiLiveApi.sendVoiceActivityMessage(false);
    markUserTurnEnd("end of turn");
    setUserTurnActive(false);
}

// --- Video & Screen Capturing ---
function videoIntervalMs() {
    return parseInt(AppUI.getValue("videoInterval"), 10) || 400;
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
        // False: the session ended or the camera started while the picker
        // was open, and the pick was dropped.
        if (!(await screen.startCapture({ sendFrames: !webRtcManager }))) return;
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
        const option = /** @type {FormControl} */ (document.createElement("md-select-option"));
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
                if (recordings.length === 1) {
                    downloadBlob(recordings[0], `received_video_${stamp}.mp4`);
                } else if (recordings.length > 1) {
                    // Several automatic downloads trigger the browser's
                    // "download multiple files" prompt; offer links instead.
                    const line = newSystemMessage("Saved avatar video:");
                    recordings.forEach((blob, i) => {
                        const link = document.createElement("a");
                        link.href = URL.createObjectURL(blob);
                        link.download = `received_video_${stamp}_part${i + 1}.mp4`;
                        link.textContent = `part ${i + 1}`;
                        if (line) line.append(" ", link);
                    });
                }
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
    const connected = !AppUI.isHidden("connected");
    const speakingNow = !AppUI.isHidden("speaking");
    if (speaking && connected) {
        setAppStatus("speaking");
    } else if (!speaking && speakingNow) {
        setAppStatus("connected");
    }
}

function setMediaButtonsEnabled(enabled) {
    for (const id of ["micOffBtn", "cameraOffBtn", "screenBtn"]) {
        const element = AppUI.getElement(id);
        /** @type {FormControl | null} */
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
    stopConnectionTimer();
    AppUI.setText("connection-age", "--");
    AppUI.setHidden("turnBtnWrap", true);
    setUserTurnActive(false);
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    AppState.liveAudioOutputManager.clear();
    // The next Connect starts a new conversation unless the user pastes a
    // handle back in, so keep the last one where they can find it.
    const handleInput = AppUI.getControl("handle");
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
    const avatarVideo = getAvatarVideoElement();
    if (avatarVideo) {
        avatarVideo.muted = false;
        avatarVideo.play().catch(() => {}); // No source yet; this only unlocks.
    }
    AppUI.setText("usage-tokens", "--");
    AppUI.setText("response-latency", "--");
    AppUI.setText("server-session-id", "--");
    resetLatencyTurn();

    handleModelChange();

    let transportMode = AppUI.getValue("transportMode", "webrtc");
    if (
        isWebSocketOnlyEnvironment(AppUI.getValue("envApiHost")) &&
        transportMode === "webrtc"
    ) {
        transportMode = "websocket";
        const transportSelect = AppUI.getControl("transportMode");
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
    // The backend normalizes the location for the host; use the same value in
    // the model URI.
    const locationInput = AppUI.getControl("location");
    if (locationInput) locationInput.value = locationInput.value.trim().toLowerCase();
    AppState.geminiLiveApi.setLocation(AppUI.getValue("location"));
    AppState.geminiLiveApi.setApiHost(AppUI.getValue("envApiHost"));
    AppState.geminiLiveApi.googleSearchEnabled = AppUI.getChecked("enableGoogleSearch");

    AppState.geminiLiveApi.onConnectionStarted = () => {
        setMediaButtonsEnabled(true);
        AppUI.setHidden("turnBtnWrap", !AppState.geminiLiveApi.disableDetection);
        setAppStatus("connected");
    };
    AppState.geminiLiveApi.connect();
}

function disconnectBtnClick() {
    // Branded voices and function declarations stay for the next connection;
    // their own controls remove them.
    endSession();
}

// --- Branded Voice / Reference Voice Modal Operations ---
function openModal() {
    const modal = AppUI.getElement("brandedVoiceModal");
    if (modal) modal.style.display = "flex";

    const nameInput = AppUI.getControl("newVoiceName");
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
    // Closing the dialog abandons a recording in progress, or one still
    // waiting for the microphone.
    AppState.recordingAttempt++;
    if (AppState.cancelRecording) AppState.cancelRecording();
    AppState.isRecording = false;
}

async function handleRecordClick() {
    const nameInput = AppUI.getControl("newVoiceName");
    const voiceName = nameInput ? nameInput.value.trim() : "";
    if (voiceName === "") {
        AppUI.showModal("Please enter a name for the reference voice.");
        if (nameInput) nameInput.focus();
        return;
    }

    if (AppState.isRecording) {
        const duration = (Date.now() - AppState.recordingStartTime) / 1000;
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
        /** @type {MediaStream | null} */
        let stream = null;
        // A second click while the first waits for the microphone supersedes it.
        const attempt = ++AppState.recordingAttempt;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (attempt !== AppState.recordingAttempt) {
                // The dialog was closed, or Record clicked again, meanwhile.
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            // Let the browser choose the format (Safari records audio/mp4,
            // not WAV or WebM); toVoiceSample() decodes whatever it is.
            const recorder = new MediaRecorder(stream);
            AppState.mediaRecorder = recorder;
            AppState.audioChunks = [];
            let cancelled = false;
            AppState.cancelRecording = () => {
                cancelled = true;
                recorder.stop();
            };

            recorder.ondataavailable = (event) => {
                AppState.audioChunks.push(event.data);
            };

            recorder.onstop = async () => {
                // Release the microphone; otherwise the browser keeps showing
                // it as in use.
                recorder.stream.getTracks().forEach((track) => track.stop());
                AppState.cancelRecording = null;
                if (cancelled) {
                    AppState.audioChunks = [];
                    return;
                }
                const audioBlob = new Blob(AppState.audioChunks, { type: recorder.mimeType });
                AppState.audioChunks = [];
                try {
                    const { base64 } = await toVoiceSample(await audioBlob.arrayBuffer());
                    addBrandedVoice(voiceName, base64);
                    AppUI.showModal(
                        `New branded voice "${voiceName}" has been created and selected. ` +
                        "It applies from the next connection."
                    );
                    closeModal();
                } catch (error) {
                    console.error("Could not process the recording:", error);
                    AppUI.showModal(`Could not process the recording: ${error.message}`);
                    openModal();
                }
            };

            recorder.start();
            AppState.recordingStartTime = Date.now();
            AppState.isRecording = true;

            AppUI.setButtonWithIcon("recordButton", "stop", "Stop Recording");
            AppUI.setText("recordStatus", "Recording... (Please speak for at least 10 seconds)");
        } catch (error) {
            console.error("Could not start the reference voice recording:", error);
            if (stream) stream.getTracks().forEach((track) => track.stop());
            AppUI.showModal(
                error.name === "NotAllowedError"
                    ? "Could not access the microphone. Please check your browser permissions."
                    : `Could not start recording: ${error.message}`
            );
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
    const fcScheduling = AppUI.getControl("fcScheduling");
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

// --- Expose Public HTML Interface on Global Window Scope ---
// Top-level functions are already properties of window; the consts aren't.
Object.assign(window, { AppState, AppUI });
