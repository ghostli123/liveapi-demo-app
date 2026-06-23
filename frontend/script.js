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
        setAppStatus("disconnected");
        stopAudioInput();

        AppUI.setHidden("micBtn", true);
        AppUI.setHidden("micOffBtn", false);
        const micOffBtn = AppUI.getElement("micOffBtn");
        if (micOffBtn) {
            const iconBtn = micOffBtn.querySelector("md-filled-icon-button");
            if (iconBtn) iconBtn.disabled = true;
        }

        AppUI.setHidden("cameraBtn", true);
        AppUI.setHidden("cameraOffBtn", false);
        const cameraOffBtn = AppUI.getElement("cameraOffBtn");
        if (cameraOffBtn) {
            const iconBtn = cameraOffBtn.querySelector("md-filled-icon-button");
            if (iconBtn) iconBtn.disabled = true;
        }

        const screenBtn = AppUI.getElement("screenBtn");
        if (screenBtn) {
            const iconBtn = screenBtn.querySelector("md-filled-icon-button");
            if (iconBtn) iconBtn.disabled = true;
        }
    };

    AppState.geminiLiveApi.onReceiveResponse = handleReceiveResponse;

    AppState.liveAudioOutputManager = new LiveAudioOutputManager();
    AppState.liveVideoOutputManager = new LiveVideoOutputManager();
    AppState.liveAudioInputManager = new LiveAudioInputManager();

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
    setAvailableCamerasOptions();
    setAvailableMicrophoneOptions();
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
function handleReceiveResponse(messageResponse) {
    console.log("Message response received, type: " + messageResponse.type);

    switch (messageResponse.type) {
        case "AUDIO":
            if (AppState.liveAudioOutputManager) {
                AppState.liveAudioOutputManager.playAudioChunk(messageResponse.data);
            }
            break;
        case "VIDEO":
            if (AppState.liveVideoOutputManager) {
                AppState.liveVideoOutputManager.playVideoChunk(messageResponse.data);
            }
            break;
        case "TEXT":
            console.log("Gemini said: ", messageResponse.data);
            newModelMessage(messageResponse.data);
            break;
        case "RESUMPTION":
            console.log("Resumption handle received: ", messageResponse.data);
            const enableResumption = AppUI.getElement("resumption");
            if (enableResumption) enableResumption.checked = true;

            const resumptionHandle = AppUI.getElement("handle");
            if (resumptionHandle) resumptionHandle.value = messageResponse.data;

            newModelMessage("New Resumption Handle ID: " + messageResponse.data);
            break;
        case "GO_AWAY":
            console.log("GoAway message received. Time left: ", messageResponse.data);
            newModelMessage("Connection expiring. Reconnecting for session resumption...");
            handleSessionResumptionReconnect();
            break;
        case "INPUT_TRANSCRIPTION":
            console.log("Input transcription received: ", messageResponse.data);
            newModelMessage("Input Transcription: " + messageResponse.data);
            break;
        case "OUTPUT_TRANSCRIPTION":
            console.log("Output transcription received: ", messageResponse.data);
            newModelMessage("Output Transcription: " + messageResponse.data);
            break;
        case "END_OF_TURN":
            console.log("End of turn");
            newModelMessage("End of turn!");
            break;
        case "INTERRUPT":
            console.log("Interrupted!");
            newModelMessage("Interrupted!");
            break;
        case "VAD_SIGNAL":
            console.log("VAD signal");
            newModelMessage("VAD signal received");
            break;
        case "FUNCTION_CALL":
            handleFunctionCallRequest(messageResponse.data);
            break;
        default:
            console.warn("Unhandled message type:", messageResponse.type);
            break;
    }
}

async function handleSessionResumptionReconnect() {
    const api = AppState.geminiLiveApi;
    if (!api) return;

    setAppStatus("connecting");

    // 1. Cleanly close the old WebSocket without triggering error/disconnected UI
    if (api.webSocket) {
        const oldWs = api.webSocket;
        const closePromise = new Promise((resolve) => {
            if (oldWs.readyState === WebSocket.CLOSED) {
                resolve();
                return;
            }
            oldWs.onclose = () => {
                resolve();
            };
            oldWs.onerror = () => {
                resolve();
            };
            oldWs.close();
        });
        await closePromise;
        api.webSocket = null;
    }

    // Stop bandwidth updates for the old connection
    api.stopUpdateBandwidthUsage();

    // Re-initialize video output manager to reset the MediaSource and player state for the new stream
    if (AppState.liveVideoOutputManager) {
        AppState.liveVideoOutputManager.initMediaSource();
    }

    // 2. Ensure session resumption is configured with the latest handle from UI
    api.setResumption(true, AppUI.getValue("handle"));

    // 3. Generate a new session ID for the new connection to avoid backend race conditions/collisions
    api.sessionId = crypto.randomUUID();

    // 4. Initiate the new connection
    await api.connect();
}

function handleFunctionCallRequest(functionCalls) {
    console.log("Function call requested: ", functionCalls);
    newModelMessage("Function Call: " + JSON.stringify(functionCalls));

    const schedulingVal = AppUI.getValue("fcScheduling", "WHEN_IDLE");
    console.log("Processing function calls with scheduling:", schedulingVal);

    const allResponsesPromise = functionCalls.reduce(
        (promiseChain, funcCall) => {
            return promiseChain.then((allResponses) => {
                const postData = {
                    objective: "fr_generate",
                    functionName: funcCall.name,
                    functionArgs: funcCall.args,
                };

                return AppState.geminiLiveApi
                    .sendPostRequest(AppState.geminiLiveApi.frUrl, postData)
                    .then((result) => {
                        allResponses.push({
                            id: funcCall.id,
                            name: funcCall.name,
                            response: {
                                result: result,
                                scheduling: schedulingVal,
                            },
                        });
                        return allResponses;
                    });
            });
        },
        Promise.resolve([])
    );

    allResponsesPromise
        .then((fcResponseList) => {
            const responseDict = {
                toolResponse: {
                    functionResponses: fcResponseList,
                },
            };
            AppState.geminiLiveApi.sendMessage(responseDict);
        })
        .catch((error) => {
            console.error("Error processing function calls:", error);
            newModelMessage("Error processing function calls: " + error.message);
        });
}

// --- Chat Interface Helpers ---
function addMessageToChat(message) {
    const textChat = AppUI.getElement("text-chat");
    if (!textChat) return;

    const newParagraph = document.createElement("p");
    newParagraph.textContent = message; // Secure against XSS
    textChat.appendChild(newParagraph);
}

function newModelMessage(message) {
    addMessageToChat(">> " + message);
}

function newUserMessage() {
    const textMessage = AppUI.getElement("text-message");
    if (!textMessage) return;

    const val = textMessage.value;
    if (val.trim() === "") return;

    addMessageToChat("User: " + val);
    AppState.geminiLiveApi.sendTextMessage(val);

    textMessage.value = "";
}

// --- Audio Input Operations ---
function startAudioInput() {
    const intervalVal = AppUI.getValue("audioInterval", "1000");
    if (AppState.liveAudioInputManager) {
        AppState.liveAudioInputManager.updateAudioInterval(intervalVal);
    }
}

function stopAudioInput() {
    if (AppState.liveAudioInputManager) {
        AppState.liveAudioInputManager.disconnectMicrophone();
    }
}

function micBtnClick() {
    console.log("micBtnClick");
    stopAudioInput();
    AppUI.setHidden("micBtn", true);
    AppUI.setHidden("micOffBtn", false);
}

function micOffBtnClick() {
    console.log("micOffBtnClick");
    startAudioInput();
    AppUI.setHidden("micBtn", false);
    AppUI.setHidden("micOffBtn", true);
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
function startCameraCapture() {
    if (AppState.liveScreenManager) {
        AppState.liveScreenManager.stopCapture();
    }
    const intervalVal = AppUI.getValue("videoInterval", "5000");
    if (AppState.liveVideoManager) {
        AppState.liveVideoManager.updateVideoInterval(intervalVal);
    }
}

function startScreenCapture() {
    if (AppState.liveVideoManager) {
        AppState.liveVideoManager.stopWebcam();
    }
    const intervalVal = AppUI.getValue("videoInterval", "5000");
    if (AppState.liveScreenManager) {
        AppState.liveScreenManager.updateVideoInterval(intervalVal);
    }
}

function cameraBtnClick() {
    if (AppState.liveVideoManager) {
        AppState.liveVideoManager.stopWebcam();
    }
    AppUI.setHidden("cameraBtn", true);
    AppUI.setHidden("cameraOffBtn", false);
    console.log("Camera turned off");
}

function cameraOffBtnClick() {
    startCameraCapture();
    AppUI.setHidden("cameraBtn", false);
    AppUI.setHidden("cameraOffBtn", true);
    console.log("Camera turned on");
}

function screenShareBtnClick() {
    startScreenCapture();
    console.log("screenShareBtnClick");
}

function newCameraSelected() {
    const camVal = AppUI.getValue("cameraSource");
    console.log("newCameraSelected ", camVal);
    if (AppState.liveVideoManager) {
        AppState.liveVideoManager.updateWebcamDevice(camVal);
    }
}

function newMicSelected() {
    const micVal = AppUI.getValue("audioSource");
    console.log("newMicSelected", micVal);
    if (AppState.liveAudioInputManager) {
        AppState.liveAudioInputManager.updateMicrophoneDevice(micVal);
    }
}

// --- Device Enumeration ---
async function getAvailableDevices(deviceType) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
    }
    try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const devices = [];
        allDevices.forEach((device) => {
            if (device.kind === deviceType) {
                devices.push({
                    id: device.deviceId,
                    name: device.label || device.deviceId,
                });
            }
        });
        return devices;
    } catch (error) {
        console.error("Error enumerating media devices:", error);
        return [];
    }
}

async function getAvailableCameras() {
    return await getAvailableDevices("videoinput");
}

async function getAvailableAudioInputs() {
    return await getAvailableDevices("audioinput");
}

function setMaterialSelect(allOptions, selectElement) {
    if (!selectElement) return;
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
}

async function setAvailableCamerasOptions() {
    const cameras = await getAvailableCameras();
    const videoSelect = AppUI.getElement("cameraSource");
    setMaterialSelect(cameras, videoSelect);
}

async function setAvailableMicrophoneOptions() {
    const mics = await getAvailableAudioInputs();
    const audioSelect = AppUI.getElement("audioSource");
    setMaterialSelect(mics, audioSelect);
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
                const blob = AppState.liveVideoOutputManager.getRecordedBlob();
                if (blob && blob.size > 0) {
                    downloadBlob(blob, `received_video_${Date.now()}.mp4`);
                    AppState.liveVideoOutputManager.clearRecordedChunks();
                }
            }
            break;
        case "connecting":
            AppUI.setHidden("connecting", false);
            AppUI.setDisabled("connectBtn", true);
            AppUI.setDisabled("disconnectBtn", true);
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

function connectBtnClick() {
    setAppStatus("connecting");
    console.log("Connecting...");

    if (AppState.liveVideoOutputManager) {
        AppState.liveVideoOutputManager.initMediaSource();
    }
    
    AppState.geminiLiveApi.responseModalities = [getSelectedResponseModality()];

    const sysInstructions = AppUI.getValue("systemInstructions");
    if (sysInstructions !== "") {
        AppState.geminiLiveApi.systemInstructions = sysInstructions;
    }

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

    AppState.geminiLiveApi.connect();

    AppState.geminiLiveApi.onConnectionStarted = () => {
        const micOffBtn = AppUI.getElement("micOffBtn");
        if (micOffBtn) {
            const iconBtn = micOffBtn.querySelector("md-filled-icon-button");
            if (iconBtn) iconBtn.disabled = false;
        }

        const cameraOffBtn = AppUI.getElement("cameraOffBtn");
        if (cameraOffBtn) {
            const iconBtn = cameraOffBtn.querySelector("md-filled-icon-button");
            if (iconBtn) iconBtn.disabled = false;
        }

        const screenBtn = AppUI.getElement("screenBtn");
        if (screenBtn) {
            const iconBtn = screenBtn.querySelector("md-filled-icon-button");
            if (iconBtn) iconBtn.disabled = false;
        }

        setAppStatus("connected");
    };
}

function disconnectBtnClick() {
    AppState.geminiLiveApi.disconnect();
    stopAudioInput();

    AppState.customVoiceBase64 = "";
    AppState.functionCallDefinition = null;

    const audioFileInput = AppUI.getElement("audioFileInput");
    if (audioFileInput) audioFileInput.value = "";

    AppUI.setText("fileName", "");
    AppUI.setText("fcFileName", "");

    if (AppState.liveVideoOutputManager) {
        AppState.liveVideoOutputManager.resetPlayer();
    }
    setAppStatus("disconnected");
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
