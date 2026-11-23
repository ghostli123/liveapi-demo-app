// @ts-check
/**
 * Global application state and UI coordinator for the Gemini Realtime Demo web application.
 * Manages WebSocket connections, media devices (camera/mic/screen), Cookie persistence,
 * tool/function calling declarations, and secure DOM manipulations.
 */

/* global GeminiLiveAPI, LiveAudioOutputManager, LiveVideoOutputManager, LiveAudioInputManager,
   MicLevelMeter, LiveVideoManager, LiveScreenManager, getAvatarVideoElement, parseIntervalMs,
   AUDIO_INTERVAL_MS, VIDEO_INTERVAL_MS -- from
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
    /**
     * Disables a Material select and says so in aria-disabled, which axe
     * reads (it doesn't count a custom element's `disabled`), so the dimmed
     * label of an inactive select isn't reported as low contrast.
     */
    setSelectDisabled(id, disabled) {
        const el = this.getControl(id);
        if (!el) return;
        el.disabled = disabled;
        el.setAttribute("aria-disabled", String(disabled));
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
            span.setAttribute("aria-hidden", "true"); // The ligature name isn't a label.
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
    // The avatar for the next Connect; an empty image means the stock avatar.
    // Applied in connectBtnClick, so a choice made while connected doesn't
    // reach the current session's resumes.
    customAvatar: { image: "", mimeType: "image/png" },
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
    /** @type {HTMLElement | null} */
    modalOpener: null, // Had focus when the branded-voice dialog opened; gets it back on close
    turnStarting: false, // "Start speaking" is waiting for the microphone
    turnAttempt: 0, // Advanced by each "Start speaking" wait and by the end of a session
    /** @type {string | null} */
    preferredTransport: null, // The transport the user last picked
    recordingStartTime: 0, // performance.now() when the voice recording started
    // Advanced by each choice of that kind, so a slow read that a later choice
    // superseded is dropped rather than applied when it finishes.
    avatarAttempt: 0, // Avatar file, sample image or stock avatar
    voiceAttempt: 0, // Voice file, recorded take or voice picked from the dropdown
    fcAttempt: 0, // Function declarations file or Remove
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
        // On a resume, input that was on went over the peer connection, which
        // is closed now (with the WebRTC mic). Send it over the WebSocket.
        if (isMicOn()) startAudioInput();
        AppState.liveVideoManager.startSendingFrames();
        AppState.liveScreenManager.startSendingFrames();
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
    AppState.liveAudioOutputManager.onPlayerError = (message) => newErrorMessage(message);
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

    AppState.liveAudioInputManager.onMicrophoneEnded = () => microphoneEnded();
    AppState.liveAudioInputManager.onMicrophoneFailed = () => microphoneEnded(MIC_FAILED_MESSAGE);
    if (AppState.geminiLiveApi.webRtcManager) {
        AppState.geminiLiveApi.webRtcManager.onMicrophoneEnded = () => microphoneEnded();
    }
    AppState.liveVideoManager.onEnded = (track) => {
        stopSendingVideoTrack(track);
        showCameraState(false);
        AppUI.showModal(CAMERA_ENDED_MESSAGE);
    };
    // The user ended the share with the browser's "Stop sharing" button.
    AppState.liveScreenManager.onEnded = stopSendingVideoTrack;
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
            try {
                if (saved[id] === undefined) saved[id] = decodeURIComponent(match[1]);
            } catch {
                // Not percent-encoded by us (any app on this host can set it); drop it.
            }
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
    // Kept apart from transportMode, which a WebSocket-only environment overrides.
    if (AppState.preferredTransport) settings.preferredTransport = AppState.preferredTransport;
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
    const radios = [...getResponseModalityRadios()];
    // An unknown saved value would leave every radio unchecked.
    const restoreModality = radios.some((radio) => radio.value === saved.responseModality);
    for (const radio of radios) {
        if (restoreModality) radio.checked = radio.value === saved.responseModality;
        radio.addEventListener("change", saveSettings);
    }
    toggleAvatarMode(); // Apply the restored avatar-mode layout.
    for (const id of PERSISTED_FIELDS) {
        const element = AppUI.getControl(id);
        if (!element) continue;
        await element.updateComplete;
        const value = saved[id];
        // Skip choices the page no longer offers, e.g. a retired model.
        if (typeof value === "string" && offersValue(element, value)) {
            element.value = value;
        }
        element.addEventListener("input", saveSettings);
        element.addEventListener("change", saveSettings);
    }
    // The default or restored transport counts as the user's choice, so leaving
    // a WebSocket-only environment returns to it without a change event.
    const transportSelect = AppUI.getControl("transportMode");
    if (transportSelect) {
        const preferred = saved.preferredTransport;
        AppState.preferredTransport =
            typeof preferred === "string" && offersValue(transportSelect, preferred)
                ? preferred
                : transportSelect.value;
    }
    saveSettings();
}

/**
 * True if `element` accepts `value`: any value for a text field, a listed one for a select.
 * @param {FormControl} element
 * @param {string} value
 */
function offersValue(element, value) {
    return !element.options || [...element.options].some((option) => option.value === value);
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
        ["#audioInterval", "change", (event) => showIntervalUsed(event.target, AUDIO_INTERVAL_MS)],
        ["#videoInterval", "change", (event) => showIntervalUsed(event.target, VIDEO_INTERVAL_MS)],
        [
            "#enableS2ST",
            "change",
            (event) => AppUI.setSelectDisabled("s2stTargetLanguage", !event.target.checked),
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
        // A click on the backdrop closes the dialog only if the press and the
        // release were both on it: a drag between the dialog and the backdrop
        // (selecting the voice name, say) sends its click to their common
        // ancestor, the backdrop, and must not cancel a recording.
        let pressOnBackdrop = false;
        let releaseOnBackdrop = false;
        brandedVoiceModal.addEventListener("pointerdown", (event) => {
            pressOnBackdrop = event.target === brandedVoiceModal;
        });
        brandedVoiceModal.addEventListener("pointerup", (event) => {
            releaseOnBackdrop = event.target === brandedVoiceModal;
        });
        brandedVoiceModal.addEventListener("click", (event) => {
            const close = event.target === brandedVoiceModal && pressOnBackdrop && releaseOnBackdrop;
            pressOnBackdrop = releaseOnBackdrop = false;
            if (close) closeModal();
        });
        // Escape in the message dialog on top of it doesn't reach here.
        brandedVoiceModal.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
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
        voiceDropdown.addEventListener("change", () => {
            AppState.voiceAttempt++; // A voice file still being read doesn't replace this choice.
            selectBrandedVoice();
        });
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

    initMetricsDisclosure();
}

/** Opens or closes the metrics panel and tells assistive technology which. */
function setMetricsOpen(open) {
    AppUI.getElement("metrics-panel")?.classList[open ? "add" : "remove"]("open");
    AppUI.getElement("metrics-icon")?.setAttribute("aria-expanded", String(open));
}

/**
 * The 📊 icon is a disclosure button: click, Enter or Space toggles the panel
 * (hover still previews it), Escape closes it, and so does moving focus away.
 */
function initMetricsDisclosure() {
    const icon = AppUI.getElement("metrics-icon");
    const panel = AppUI.getElement("metrics-panel");
    const container = icon?.parentElement;
    if (!icon || !panel || !container) return;
    const toggle = () => setMetricsOpen(!panel.classList.contains("open"));
    icon.addEventListener("click", toggle);
    icon.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault(); // Space would scroll the page.
            toggle();
        }
    });
    container.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && panel.classList.contains("open")) {
            event.preventDefault();
            setMetricsOpen(false);
            icon.focus();
        }
    });
    // The panel is focusable (tabindex -1), so selecting the session ID in it
    // keeps focus inside and the panel open.
    container.addEventListener("focusout", (event) => {
        if (!container.contains(/** @type {Node | null} */ (event.relatedTarget))) setMetricsOpen(false);
    });
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
            if (!AppState.preferredTransport) AppState.preferredTransport = transportSelect.value;
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
// The voice sample and avatar image travel base64-encoded in the setup message,
// which the backend caps at 64 MB (MAX_CLIENT_MESSAGE_BYTES in main.py). These
// limits keep both together well under it: 5 min of 24 kHz 16-bit WAV is
// 19 MB as base64, a 20 MB image 27 MB.
const MAX_VOICE_SAMPLE_S = 300;
// Checked before a voice file is read, so a huge file is refused without
// decoding it all into memory first. 5 min of uncompressed 96 kHz 24-bit
// stereo WAV is 173 MB.
const MAX_VOICE_FILE_BYTES = 200 * 1024 * 1024;
const MAX_AVATAR_IMAGE_BYTES = 20 * 1024 * 1024;
const AVATAR_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
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
 * Audio longer than MAX_VOICE_SAMPLE_S is refused, or with `clip` cut to it.
 * @param {ArrayBuffer} audioData
 * @param {{clip?: boolean}} [options]
 * @returns {Promise<{base64: string, durationS: number}>}
 */
async function toVoiceSample(audioData, { clip = false } = {}) {
    // Offline contexts can decode too, and need no closing; Chrome limits how
    // many realtime AudioContexts a page may hold.
    const decoded = await new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE).decodeAudioData(
        audioData
    );
    if (decoded.duration > MAX_VOICE_SAMPLE_S && !clip) {
        throw new Error(
            `it is ${formatMinutes(decoded.duration)} long; samples are limited to ` +
            `${formatMinutes(MAX_VOICE_SAMPLE_S)}.`
        );
    }
    const durationS = Math.min(decoded.duration, MAX_VOICE_SAMPLE_S);
    const offline = new OfflineAudioContext(
        1, // Mixing to a mono destination downmixes stereo input.
        Math.ceil(durationS * VOICE_SAMPLE_RATE), // Rendering stops here, cutting longer audio.
        VOICE_SAMPLE_RATE
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return { base64: await blobToBase64(bufferToWave(rendered)), durationS };
}

/** Rounds up, so a duration over a limit never reads as equal to it. */
function formatMinutes(seconds) {
    return `${Math.ceil(seconds / 6) / 10} min`;
}

/** Rounds up, as above. */
function formatMegabytes(bytes) {
    return `${Math.ceil(bytes / 104857.6) / 10} MB`;
}

/** Adds a voice to the Branded Voice dropdown and selects it. */
function addBrandedVoice(name, base64) {
    const dropdown = AppUI.getControl("voice-dropdown");
    if (!dropdown) return;
    AppState.voiceAttempt++; // Supersedes voice files still being read.
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
/** Sets the avatar image, unless a later avatar choice than `attempt` was made meanwhile. */
async function setAvatarImage(blob, name, attempt) {
    if (!AVATAR_IMAGE_TYPES.has(blob.type)) {
        throw new Error("use a PNG, JPEG or WebP image.");
    }
    if (blob.size > MAX_AVATAR_IMAGE_BYTES) {
        throw new Error(
            `it is ${formatMegabytes(blob.size)}; images are limited to ${formatMegabytes(MAX_AVATAR_IMAGE_BYTES)}.`
        );
    }
    const base64 = await blobToBase64(blob);
    if (attempt !== AppState.avatarAttempt) return;
    AppState.customAvatar = { image: base64, mimeType: blob.type };
    AppUI.setText("avatarName", `Avatar: ${name}`);
    AppUI.setHidden("avatarStockLink", false);
}

async function handleAvatarFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ""; // So choosing the same file again fires change.
    const attempt = ++AppState.avatarAttempt;
    try {
        await setAvatarImage(file, file.name, attempt);
    } catch (error) {
        if (attempt !== AppState.avatarAttempt) return;
        AppUI.showModal(`Could not use "${file.name}" as the avatar: ${error.message}`);
    }
}

async function useSampleAvatar() {
    const attempt = ++AppState.avatarAttempt;
    try {
        const response = await fetch("/frontend/assets/avatar_image.png");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await setAvatarImage(await response.blob(), "sample image", attempt);
    } catch (error) {
        if (attempt !== AppState.avatarAttempt) return;
        AppUI.showModal(`Could not load the sample avatar image: ${error.message}`);
    }
}

function useStockAvatar() {
    AppState.avatarAttempt++;
    AppState.customAvatar = { image: "", mimeType: "image/png" };
    AppUI.setText("avatarName", "Avatar: Piper (stock)");
    AppUI.setHidden("avatarStockLink", true);
}

async function handleAudioFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ""; // So choosing the same file again fires change.
    const attempt = ++AppState.voiceAttempt;

    try {
        if (file.size > MAX_VOICE_FILE_BYTES) {
            throw new Error(
                `it is ${formatMegabytes(file.size)}; files are limited to ${formatMegabytes(MAX_VOICE_FILE_BYTES)}.`
            );
        }
        const { base64, durationS } = await toVoiceSample(await file.arrayBuffer());
        if (attempt !== AppState.voiceAttempt) return;
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
        if (attempt !== AppState.voiceAttempt) return;
        AppUI.showModal(`Could not use "${file.name}" as a voice sample: ${error.message}`);
    }
}

async function handleFcFileInputChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ""; // So choosing the same file again fires change.
    const attempt = ++AppState.fcAttempt;

    try {
        // Rejects if the file was moved or changed since it was picked. The
        // browsers' messages ("The operation was aborted.") don't say that.
        const text = await file.text().catch((error) => {
            throw new Error(`the file can't be read (${(error && (error.message || error.name)) || error})`);
        });
        if (attempt !== AppState.fcAttempt) return;
        const declarations = GeminiLiveAPI.toFunctionDeclarations(JSON.parse(text));
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
        if (attempt !== AppState.fcAttempt) return;
        AppUI.showModal(`Could not use "${file.name}": ${error.message}`);
    }
}

function removeFunctionDeclarations() {
    AppState.fcAttempt++;
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
            endModelResponse();
            break;
        case "INTERRUPT":
            if (AppState.liveAudioOutputManager) {
                AppState.liveAudioOutputManager.clear();
            }
            endModelResponse();
            closeTranscriptLine("output");
            setModelSpeaking(false);
            newSystemMessage("Interrupted.");
            break;
        case "VAD_SIGNAL":
            console.log("VAD signal");
            break;
        case "VOICE_ACTIVITY":
            if (messageResponse.data === "ACTIVITY_START") {
                markUserSpeechStart();
                // A frame in flight at Mic off would bring the badge back after
                // stopAudioInput() hid it, with no ACTIVITY_END to come over WebRTC.
                showHearingUser(isMicOn());
            } else if (messageResponse.data === "ACTIVITY_END") {
                markUserTurnEnd("end of speech");
                showHearingUser(false);
            }
            break;
        case "FUNCTION_CALL":
            closeTranscriptLine("input");
            handleFunctionCallRequest(messageResponse.data);
            break;
        case "FUNCTION_CALL_CANCELLATION":
            cancelFunctionCalls(messageResponse.data);
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
// For speech, the end is the server's end-of-speech signal (voice activity
// detection), or else the last input transcript.
const LatencyState = {
    /** @type {number | null} */
    turnEndedAt: null,
    source: "",
    responding: false,
    // The user spoke or typed while the model was responding, so a turn end
    // recorded during this response is for the model's next one.
    speechOverModel: false,
};

// How exact each turn end is. A less exact one doesn't move a turn end already
// recorded: transcripts trail the end of speech, and with manual activity the
// server echoes ACTIVITY_END ~200 ms after the Done speaking click.
const TURN_END_RANK = { speech: 0, "end of speech": 1, "end of turn": 2, text: 2 };

/**
 * Records (or moves) the end of the user's turn. Once the model is answering,
 * turn ends (trailing transcripts, an echoed ACTIVITY_END) belong to the turn
 * it is answering and are ignored, unless the user spoke again over it.
 * With `force` (a typed message) the turn end is always recorded; over the
 * model's answer it counts for the model's next response, like speech over it.
 */
function markUserTurnEnd(source, { force = false } = {}) {
    if (force && LatencyState.responding) LatencyState.speechOverModel = true;
    if (LatencyState.responding && !LatencyState.speechOverModel) return;
    if (!force && LatencyState.turnEndedAt !== null && TURN_END_RANK[source] < TURN_END_RANK[LatencyState.source]) {
        return;
    }
    LatencyState.turnEndedAt = performance.now();
    LatencyState.source = source;
}

/** The user (re)started speaking, so their turn hasn't ended yet. */
function markUserSpeechStart() {
    LatencyState.turnEndedAt = null;
    if (LatencyState.responding) LatencyState.speechOverModel = true;
}

/** The model's first response in a turn; `what` names it if not audio/text. */
function markModelResponse(what = "") {
    if (LatencyState.responding) return; // A later part of the same response.
    LatencyState.responding = true;
    LatencyState.speechOverModel = false;
    if (LatencyState.turnEndedAt === null) return;
    const ms = Math.round(performance.now() - LatencyState.turnEndedAt);
    LatencyState.turnEndedAt = null;
    const after = {
        text: "after text",
        speech: "after last transcript",
        "end of speech": "after end of speech",
        "end of turn": "after Done speaking",
    }[LatencyState.source];
    AppUI.setText("response-latency", `${ms.toLocaleString()} ms ${after}${what ? ` (to ${what})` : ""}`);
}

function resetLatencyTurn() {
    LatencyState.turnEndedAt = null;
    LatencyState.responding = false;
    LatencyState.speechOverModel = false;
}

/**
 * The model's response ended (turn complete or interrupted). Speech over it
 * that already ended is the turn the next response answers, e.g. with
 * interruption off, or when ACTIVITY_END arrives before INTERRUPT.
 */
function endModelResponse() {
    if (!LatencyState.speechOverModel) LatencyState.turnEndedAt = null;
    LatencyState.responding = false;
    LatencyState.speechOverModel = false;
}

// --- Connection age ---
// Time since the current connection was set up (reset by resumption). The
// server sends GoAway based on connection age, so this helps when testing it.
/** @type {number | null} */
let connectionTimer = null;

function startConnectionTimer() {
    stopConnectionTimer();
    const startedAt = performance.now();
    const tick = () => {
        const seconds = Math.floor((performance.now() - startedAt) / 1000);
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
    // The age is the old connection's, which is being dropped; the new one's
    // starts at its SETUP COMPLETE.
    stopConnectionTimer();
    AppUI.setText("connection-age", "--");
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    setUserTurnActive(false); // The new session never saw activity_start.
    showHearingUser(false); // Nor the speech: its ACTIVITY_END won't come.
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

// The simulator is a Gemini call; with BLOCKING tools the model waits for it.
const FUNCTION_RESPONSE_TIMEOUT_MS = 30000;

// Function calls waiting for or running their simulation, by call ID, so a
// toolCallCancellation can stop them.
/** @type {Map<string, AbortController>} */
const pendingFunctionCalls = new Map();

/** Handles a toolCallCancellation: the calls with these IDs get no response. */
function cancelFunctionCalls(ids) {
    for (const id of ids) {
        pendingFunctionCalls.get(id)?.abort("cancelled");
    }
    newSystemMessage("Function calls cancelled: " + ids.join(", "));
}

/**
 * Asks the backend's simulator for a function's response. Returns null if the
 * server cancelled the call meanwhile.
 * @param {AbortController} controller - Aborted with "cancelled" or "timeout".
 */
async function simulateFunctionResponse(funcCall, sessionId, controller) {
    const timer = setTimeout(() => controller.abort("timeout"), FUNCTION_RESPONSE_TIMEOUT_MS);
    try {
        return {
            result: await AppState.geminiLiveApi.sendPostRequest(
                AppState.geminiLiveApi.frUrl,
                {
                    objective: "fr_generate",
                    session_id: sessionId,
                    functionName: funcCall.name,
                    functionArgs: funcCall.args,
                },
                { signal: controller.signal }
            ),
        };
    } catch (error) {
        if (controller.signal.reason === "cancelled") return null;
        const message =
            controller.signal.reason === "timeout"
                ? `the simulator didn't answer within ${FUNCTION_RESPONSE_TIMEOUT_MS / 1000} s`
                : error.message;
        console.error(`Simulating ${funcCall.name} failed:`, error);
        // After a reconnect the old session is gone; that isn't the function's fault.
        if (AppState.geminiLiveApi.sessionId === sessionId) {
            newErrorMessage(`Function ${funcCall.name} failed: ${message}`);
        }
        // Answer anyway: with BLOCKING tools the model waits for a response.
        return { error: message };
    } finally {
        clearTimeout(timer);
    }
}

async function handleFunctionCallRequest(functionCalls) {
    console.log("Function call requested: ", functionCalls);
    const api = AppState.geminiLiveApi;
    const webSocket = api.webSocket;
    const sessionId = api.sessionId;
    const controllers = functionCalls.map((funcCall) => {
        newSystemMessage(`Function call: ${funcCall.name}(${JSON.stringify(funcCall.args || {})})`);
        const controller = new AbortController();
        if (funcCall.id) pendingFunctionCalls.set(funcCall.id, controller);
        return controller;
    });

    // Scheduling only applies to NON_BLOCKING functions.
    const schedulingVal =
        AppState.geminiLiveApi.toolBehavior === "NON_BLOCKING"
            ? AppUI.getValue("fcScheduling", "WHEN_IDLE")
            : null;
    // Sequential, since the simulator is one chat session per connection.
    const responses = [];
    for (const [i, funcCall] of functionCalls.entries()) {
        if (api.webSocket !== webSocket) break;
        if (controllers[i].signal.aborted) continue; // Cancelled before it started.
        const response = await simulateFunctionResponse(funcCall, sessionId, controllers[i]);
        if (!response) continue;
        if (schedulingVal) response.scheduling = schedulingVal;
        responses.push({ controller: controllers[i], item: { id: funcCall.id, name: funcCall.name, response } });
    }
    for (const [i, funcCall] of functionCalls.entries()) {
        if (pendingFunctionCalls.get(funcCall.id) === controllers[i]) pendingFunctionCalls.delete(funcCall.id);
    }
    // Calls cancelled while a later one ran aren't answered either.
    const functionResponses = responses
        .filter(({ controller }) => controller.signal.reason !== "cancelled")
        .map(({ item }) => item);
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
    if (!functionResponses.length) return; // All cancelled.
    AppState.geminiLiveApi.sendMessage({ toolResponse: { functionResponses } });
}

// --- Chat Interface Helpers ---
const ChatState = {
    // The chat line each transcript stream is appending to, if any.
    /** @type {{input: HTMLElement | null, output: HTMLElement | null}} */
    transcriptLines: { input: null, output: null },
    // The last session's "Saved avatar video" links. Each blob URL keeps its
    // MP4 in memory until revoked, so the next Connect releases them.
    /** @type {HTMLAnchorElement[]} */
    savedVideoLinks: [],
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

/**
 * Explains why input wasn't sent: the session only takes it once the server
 * has confirmed the setup, which a resume or a WebRTC connect waits for.
 * @param {string} action - What the user tried, e.g. "speaking".
 */
function notReadyMessage(action) {
    return AppUI.isHidden("disconnected")
        ? `The session is still connecting. Try ${action} again once it's connected.`
        : `Connect before ${action}.`;
}

function newUserMessage() {
    const textMessage = AppUI.getControl("text-message");
    if (!textMessage) return;

    const val = textMessage.value;
    if (val.trim() === "") return;

    const api = AppState.geminiLiveApi;
    if (!api.sendTextMessage(val)) {
        AppUI.showModal(notReadyMessage("sending a message"));
        return; // The text stays in the box to send later.
    }
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    addMessageToChat("You: " + val, "user");
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

/**
 * Why a getUserMedia/getDisplayMedia call failed, for an error dialog. Chrome's
 * OverconstrainedError has an empty message; the only exact constraint the app
 * sets is the picked deviceId, so it means that device is gone (e.g. unplugged).
 */
function deviceErrorReason(err) {
    if (err && err.name === "OverconstrainedError") return "the selected device isn't available";
    return (err && (err.message || err.name)) || String(err);
}

async function startAudioInput() {
    const deviceId = AppUI.getValue("audioSource") || null;
    try {
        const webRtcManager = webRtcManagerIfActive();
        if (webRtcManager) {
            await webRtcManager.startMicrophone(deviceId);
        } else {
            // Switching mics: send what the old one captured before it's dropped.
            AppState.liveAudioInputManager.recordChunk();
            AppState.liveAudioInputManager.deviceId = deviceId;
            await AppState.liveAudioInputManager.updateAudioInterval(AppUI.getValue("audioInterval"));
        }
        if (isMicOn()) {
            startMicLevelMeter(webRtcManager ? webRtcManager.micStream : AppState.liveAudioInputManager.stream);
        }
        // Device names are only visible once the user has granted access.
        refreshDeviceLists();
    } catch (err) {
        console.error("Failed to start microphone:", err);
        AppUI.showModal(`Could not start the microphone: ${deviceErrorReason(err)}`);
        // E.g. switching to another mic mid-turn: like turning the mic off,
        // this ends the turn, or it stays open with nothing being sent.
        endUserTurn();
        stopAudioInput();
        showMicState(false);
    }
}

/** The level meter is decorative: if the browser refuses it, the mic stays on without it. */
function startMicLevelMeter(stream) {
    // A start superseded while its permission prompt was open returns without
    // a stream; the newer start shows the meter once it has one.
    if (!stream) return;
    try {
        AppState.micLevelMeter.start(stream);
    } catch (err) {
        console.error("Could not start the microphone level meter:", err);
        return;
    }
    AppUI.setHidden("micLevel", false);
}

// With automatic activity detection the server ends a spoken turn after a
// stretch of quiet audio, so when WebSocket media stops mid-sentence it keeps
// waiting and the last words get no answer. audio_stream_end tells it the audio
// stopped; the buffered audio goes first. Over WebRTC the server sees the
// track stop, and with detection off endUserTurn()'s activity_end does this.
function endAudioStream() {
    const api = AppState.geminiLiveApi;
    if (!api || !api.isSetupComplete || api.disableDetection || isWebRtcTransport() || !isMicOn()) return;
    AppState.liveAudioInputManager.recordChunk();
    api.sendAudioStreamEnd();
}

function stopAudioInput() {
    endAudioStream();
    AppState.micLevelMeter.stop();
    AppUI.setHidden("micLevel", true);
    // Over WebRTC a stopped track sends nothing, so ACTIVITY_END may never come.
    showHearingUser(false);
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

const MIC_ENDED_MESSAGE =
    "The microphone stopped: it was unplugged or the browser's access to it was turned off. " +
    "Turn the mic back on to keep talking.";
const MIC_FAILED_MESSAGE =
    "The microphone stopped: the browser's audio processing for it failed. Turn the mic back on to keep talking.";
const CAMERA_ENDED_MESSAGE =
    "The camera stopped: it was unplugged or the browser's access to it was turned off. " +
    "Turn the camera back on to keep sharing video.";

// The microphone's track ended, or its capture worklet failed, without the app
// stopping it: turn the mic off and say why.
function microphoneEnded(message = MIC_ENDED_MESSAGE) {
    if (!isMicOn()) return;
    micBtnClick();
    AppUI.showModal(message);
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
    if (!AppState.geminiLiveApi.isSetupComplete) {
        AppUI.showModal(notReadyMessage("speaking"));
        return;
    }
    const attempt = ++AppState.turnAttempt;
    AppState.turnStarting = true;
    try {
        if (!isMicOn()) {
            showMicState(true);
            await startAudioInput();
            // The session ended during the permission prompt; a click in the
            // next session owns the turn now.
            if (attempt !== AppState.turnAttempt) return;
            if (!isMicOn()) return; // The microphone failed to start.
        }
        // Over WebSocket, audio is sent every audioInterval ms; send what the mic
        // captured before the click first, or it arrives inside the turn.
        if (!isWebRtcTransport()) AppState.liveAudioInputManager.recordChunk();
        // The session may have started resuming during the permission prompt.
        if (!AppState.geminiLiveApi.sendVoiceActivityMessage(true)) {
            AppUI.showModal(notReadyMessage("speaking"));
            return;
        }
        setUserTurnActive(true);
        markUserSpeechStart(); // Also over the model; the server's echo may lag.
    } finally {
        if (attempt === AppState.turnAttempt) AppState.turnStarting = false;
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
    return parseIntervalMs(AppUI.getValue("videoInterval"), VIDEO_INTERVAL_MS);
}

// Replaces a typed interval with the one the app will use: clamped, or the
// default for a blank or unusable value.
function showIntervalUsed(field, limits) {
    field.value = String(parseIntervalMs(field.value, limits));
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
        AppUI.showModal(`Could not start the camera: ${deviceErrorReason(err)}`);
        camera.stopWebcam();
        showCameraState(false);
        // The screen share or previous camera was stopped above; the WebRTC
        // sender still holds its ended track, and no "ended" event will come.
        const webRtcManager = webRtcManagerIfActive();
        if (webRtcManager) {
            webRtcManager.detachVideoStream();
        }
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
            AppUI.showModal(`Could not share the screen: ${deviceErrorReason(err)}`);
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

// A camera or screen track ended; stop the WebRTC sender if it was sending it,
// so the session (and a renegotiated one after resumption) doesn't keep it.
function stopSendingVideoTrack(track) {
    const webRtcManager = AppState.geminiLiveApi.webRtcManager;
    if (webRtcManager && webRtcManager.videoTrack === track) {
        webRtcManager.detachVideoStream();
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
const CONNECTION_ANNOUNCEMENTS = {
    disconnected: "Disconnected",
    connecting: "Connecting",
    connected: "Connected",
};
let lastConnectionAnnouncement = "";

/**
 * Puts a connection change in the status live region for screen readers.
 * "Model speaking" counts as connected: announcing every model turn would
 * talk over the model.
 */
function announceConnectionStatus(status) {
    const text = CONNECTION_ANNOUNCEMENTS[status === "speaking" ? "connected" : status];
    if (!text || text === lastConnectionAnnouncement) return;
    lastConnectionAnnouncement = text;
    AppUI.setText("connection-announcer", text);
}

function setAppStatus(status) {
    announceConnectionStatus(status);
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
                    // Not newSystemMessage: collapsing into an earlier such
                    // line would replace its text, links included.
                    const line = addMessageToChat("Saved avatar video:", "system");
                    recordings.forEach((blob, i) => {
                        const link = document.createElement("a");
                        link.href = URL.createObjectURL(blob);
                        link.download = `received_video_${stamp}_part${i + 1}.mp4`;
                        link.textContent = `part ${i + 1}`;
                        if (line) line.append(" ", link);
                        ChatState.savedVideoLinks.push(link);
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

/** Frees the last session's saved-video blobs; their links become plain text. */
function releaseSavedVideoLinks() {
    for (const link of ChatState.savedVideoLinks) {
        URL.revokeObjectURL(link.href);
        link.removeAttribute("href");
        link.removeAttribute("download");
        link.textContent += " (expired)";
    }
    ChatState.savedVideoLinks = [];
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

/**
 * Shows "hearing you" while the server's voice activity detection hears speech,
 * so the user can tell their microphone reaches the model even with input
 * transcription off. Not announced: it would talk over the user.
 */
function showHearingUser(hearing) {
    AppUI.setHidden("hearing", !hearing);
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
    // A "Start speaking" still waiting for the microphone belongs to this session.
    AppState.turnAttempt++;
    AppState.turnStarting = false;
    closeTranscriptLine("input");
    closeTranscriptLine("output");
    AppState.liveAudioOutputManager.clear();
    // The next Connect starts a new conversation unless the user pastes a
    // handle back in, so keep the last one where they can find it. Only a
    // handle the server sent this session counts: after a Connect that failed
    // or was cancelled, the field still holds what the user pasted.
    const handle = AppState.geminiLiveApi.latestResumptionHandle;
    const handleInput = AppUI.getControl("handle");
    if (handle && handleInput) {
        newSystemMessage(`To resume this conversation later, enter this handle in Advanced Settings: ${handle}`);
        handleInput.value = "";
        AppState.geminiLiveApi.latestResumptionHandle = ""; // Posted once.
    }
    // Before resetPlayer(), which discards the recorded video this saves.
    setAppStatus("disconnected");
    AppState.liveVideoOutputManager.resetPlayer();
}

function connectBtnClick() {
    setAppStatus("connecting");
    console.log("Connecting...");
    releaseSavedVideoLinks();
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
    AppState.geminiLiveApi.setCustomizedAvatar(AppState.customAvatar.image, AppState.customAvatar.mimeType);
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
// The page behind the branded-voice dialog; inert while it's open, so Tab
// and screen readers stay in the dialog.
const MODAL_BACKGROUND_IDS = ["appHeader", "appContainer"];

function isModalOpen() {
    const modal = AppUI.getElement("brandedVoiceModal");
    return Boolean(modal && modal.style.display === "flex");
}

/** @param {boolean} open */
function setModalOpen(open) {
    const modal = AppUI.getElement("brandedVoiceModal");
    if (!modal || open === isModalOpen()) return;
    if (open) AppState.modalOpener = /** @type {HTMLElement | null} */ (document.activeElement);
    modal.style.display = open ? "flex" : "none";
    for (const id of MODAL_BACKGROUND_IDS) {
        const element = AppUI.getElement(id);
        if (element) element.inert = open;
    }
    if (!open && AppState.modalOpener) {
        AppState.modalOpener.focus();
        AppState.modalOpener = null;
    }
}

function openModal() {
    setModalOpen(true);

    const nameInput = AppUI.getControl("newVoiceName");
    if (nameInput) {
        nameInput.value = "";
        nameInput.focus();
    }

    resetRecordButton();

    AppState.isRecording = false;
    AppState.audioChunks = [];
}

/** Shows the Record button ready for a new take. */
function resetRecordButton() {
    AppUI.setDisabled("recordButton", false);
    AppUI.setButtonWithIcon("recordButton", "mic", "Record reference voice");
    AppUI.setText("recordStatus", "");
    AppUI.setHidden("processingSpinner", true);
}

function closeModal() {
    setModalOpen(false);
    // Closing the dialog abandons a recording in progress, or one still
    // waiting for the microphone.
    AppState.recordingAttempt++;
    if (AppState.cancelRecording) AppState.cancelRecording();
    AppState.isRecording = false;
}

async function handleRecordClick() {
    if (AppState.isRecording) {
        // The take is saved under the name it started with, so Stop works
        // even if the name box has since been cleared.
        const duration = (performance.now() - AppState.recordingStartTime) / 1000;
        if (duration < 10) {
            AppUI.showModal(
                "A recording of at least 10 seconds is required to ensure reference voice quality."
            );
            return;
        }

        stopRecording();
    } else {
        const nameInput = AppUI.getControl("newVoiceName");
        const voiceName = nameInput ? nameInput.value.trim() : "";
        if (voiceName === "") {
            AppUI.showModal("Please enter a name for the reference voice.");
            if (nameInput) nameInput.focus();
            return;
        }

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
            let reachedLimit = false;
            // Stop at the sample limit rather than refuse the whole recording
            // once the user stops it.
            const limitTimer = setTimeout(() => {
                if (attempt !== AppState.recordingAttempt || !AppState.isRecording) return;
                reachedLimit = true;
                stopRecording();
            }, MAX_VOICE_SAMPLE_S * 1000);
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
                clearTimeout(limitTimer);
                AppState.cancelRecording = null;
                if (cancelled) {
                    AppState.audioChunks = [];
                    return;
                }
                // Stop and the sample limit end the take through stopRecording();
                // otherwise the microphone's track ended (unplugged, or access
                // turned off) and the recorder stopped by itself.
                const micEnded = AppState.isRecording;
                if (micEnded) showRecordingProcessing();
                const audioBlob = new Blob(AppState.audioChunks, { type: recorder.mimeType });
                AppState.audioChunks = [];
                // Closing the dialog while the take is processed abandons it
                // too, and the dialog may since hold a newer recording, which
                // the closeModal()/openModal() below would stop or orphan.
                const abandoned = () => attempt !== AppState.recordingAttempt;
                try {
                    // The encoder can add a few milliseconds past the limit.
                    const { base64, durationS } = await toVoiceSample(await audioBlob.arrayBuffer(), { clip: true });
                    if (abandoned()) return;
                    const micStopped = micEnded
                        ? `The microphone stopped after ${durationS.toFixed(1)} s: it was unplugged or ` +
                          "the browser's access to it was turned off. "
                        : "";
                    if (micEnded && durationS < MIN_VOICE_SAMPLE_S) {
                        // Stop refuses takes this short too; keep the name for another take.
                        resetRecordButton();
                        AppUI.showModal(
                            micStopped +
                            `A recording of at least ${MIN_VOICE_SAMPLE_S} seconds is required, so this one ` +
                            "was discarded. Check the microphone and record again."
                        );
                        return;
                    }
                    addBrandedVoice(voiceName, base64);
                    // Close first, so the message dialog returns focus to the page.
                    closeModal();
                    AppUI.showModal(
                        (reachedLimit ? `Recording stopped at the ${formatMinutes(MAX_VOICE_SAMPLE_S)} limit. ` : "") +
                        micStopped +
                        `New branded voice "${voiceName}" has been created and selected. ` +
                        "It applies from the next connection."
                    );
                } catch (error) {
                    console.error("Could not process the recording:", error);
                    if (abandoned()) return;
                    AppUI.showModal(`Could not process the recording: ${error.message}`);
                    openModal();
                }
            };

            recorder.start();
            AppState.recordingStartTime = performance.now();
            AppState.isRecording = true;

            AppUI.setButtonWithIcon("recordButton", "stop", "Stop Recording");
            AppUI.setText(
                "recordStatus",
                `Recording... (Please speak for at least 10 seconds; it stops at ${formatMinutes(MAX_VOICE_SAMPLE_S)})`
            );
        } catch (error) {
            console.error("Could not start the reference voice recording:", error);
            if (stream) stream.getTracks().forEach((track) => track.stop());
            AppUI.showModal(
                error.name === "NotAllowedError"
                    ? "Could not access the microphone. Please check your browser permissions."
                    : `Could not start recording: ${deviceErrorReason(error)}`
            );
        }
    }
}

/** Stops the voice recording in progress; its onstop handler processes it. */
function stopRecording() {
    if (AppState.mediaRecorder) {
        AppState.mediaRecorder.stop();
    }
    showRecordingProcessing();
}

/** The take is over; its onstop handler is processing it. */
function showRecordingProcessing() {
    AppUI.setDisabled("recordButton", true);
    AppUI.setText("recordStatus", "Processing recorded sample...");
    AppUI.setHidden("processingSpinner", false);
    AppUI.setButtonWithIcon("recordButton", "hourglass_empty", "Processing...");

    AppState.isRecording = false;
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
    AppUI.setSelectDisabled("fcScheduling", AppUI.getValue("toolBehavior") === "BLOCKING");
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
