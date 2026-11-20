/* global G3RtcWebRtcManager -- from live-media-manager.js (see index.html) */
/* exported GeminiLiveAPI */

/**
 * One event from a Gemini Live API server message. A single server message can
 * hold several events (e.g. a transcript and the end of the turn), so messages
 * are parsed with GeminiLiveResponseMessage.parseAll().
 */
class GeminiLiveResponseMessage {
    /**
     * @param {string} type - Event type, e.g. "AUDIO" or "END_OF_TURN".
     * @param {*} [data=""] - Event payload.
     * @param {Object} [extra] - Extra fields such as mimeType, answerSdp, finished.
     */
    constructor(type, data = "", extra = {}) {
        this.type = type;
        this.data = data;
        Object.assign(this, extra);
    }

    /**
     * Splits a raw server message into events, in the order the UI should
     * handle them. Accepts both camelCase and snake_case field names.
     * @param {Object} raw - Parsed JSON message from the WebSocket.
     * @returns {GeminiLiveResponseMessage[]}
     */
    static parseAll(raw) {
        const events = [];
        const add = (type, data, extra) =>
            events.push(new GeminiLiveResponseMessage(type, data, extra));
        const field = (obj, camel, snake) => obj?.[camel] ?? obj?.[snake];

        const setupComplete = field(raw, "setupComplete", "setup_complete");
        if (setupComplete) {
            const rtc = field(setupComplete, "rtcSetupComplete", "rtc_setup_complete");
            add("SETUP COMPLETE", "", {
                answerSdp: field(rtc, "answerSdp", "answer_sdp") || "",
                sessionId: field(setupComplete, "sessionId", "session_id") || "",
            });
        }

        const toolCall = field(raw, "toolCall", "tool_call");
        const functionCalls = field(toolCall, "functionCalls", "function_calls");
        if (functionCalls) {
            add("FUNCTION_CALL", functionCalls);
        }
        const cancellation = field(raw, "toolCallCancellation", "tool_call_cancellation");
        if (cancellation) {
            add("FUNCTION_CALL_CANCELLATION", cancellation.ids || []);
        }

        if (field(raw, "voiceActivityDetectionSignal", "voice_activity_detection_signal")) {
            add("VAD_SIGNAL");
        }

        const content = field(raw, "serverContent", "server_content");
        if (content) {
            if (field(content, "generationStarted", "generation_started")) {
                add("GENERATION_STARTED");
            }
            const inputTranscription = field(content, "inputTranscription", "input_transcription");
            if (inputTranscription) {
                add("INPUT_TRANSCRIPTION", inputTranscription.text || "", {
                    finished: !!inputTranscription.finished,
                });
            }
            for (const part of field(content, "modelTurn", "model_turn")?.parts || []) {
                if (part.text) {
                    add("TEXT", part.text);
                }
                const inline = part.inlineData || part.inline_data || part.video;
                if (inline?.data) {
                    const mimeType = inline.mimeType || inline.mime_type || "";
                    const isVideo = mimeType.startsWith("video/") || mimeType.startsWith("image/");
                    add(isVideo ? "VIDEO" : "AUDIO", inline.data, { mimeType });
                }
            }
            const outputTranscription = field(content, "outputTranscription", "output_transcription");
            if (outputTranscription) {
                add("OUTPUT_TRANSCRIPTION", outputTranscription.text || "", {
                    finished: !!outputTranscription.finished,
                });
            }
            if (content.interrupted) {
                add("INTERRUPT");
            }
            if (field(content, "turnComplete", "turn_complete")) {
                add("END_OF_TURN");
            }
        }

        const resumption = field(raw, "sessionResumptionUpdate", "session_resumption_update");
        const newHandle = field(resumption, "newHandle", "new_handle");
        if (newHandle) {
            add("RESUMPTION", newHandle);
        }

        const goAway = field(raw, "goAway", "go_away");
        if (goAway) {
            add("GO_AWAY", field(goAway, "timeLeft", "time_left") || "");
        }

        const usage = field(raw, "usageMetadata", "usage_metadata");
        if (usage) {
            add("USAGE", usage);
        }
        return events;
    }
}

// How long to wait for setupComplete after the WebSocket opens.
const SETUP_TIMEOUT_MS = 30000;
// Most automatic resumes (after close code 1001) allowed per minute.
const AUTO_RESUME_LIMIT = 3;

/**
 * Main Client API class for interacting with Gemini Live Realtime connections.
 * Manages WebSocket connections, HTTP backend control requests, tool declarations,
 * and real-time bandwidth statistics.
 */
class GeminiLiveAPI {
    /**
     * @param {string} proxyUrl - WebSocket Proxy service URL.
     * @param {string} controlUrl - Backend control service HTTP URL (for session initialization).
     * @param {string} frUrl - Function registry / declaration HTTP URL.
     */
    constructor(proxyUrl, controlUrl, frUrl) {
        // Services and Endpoints
        this.proxyUrl = proxyUrl;
        this.controlUrl = controlUrl;
        this.frUrl = frUrl;
        this.endPoint = null;
        this.environment = "prod";

        // Session and Context State
        this.sessionId = crypto.randomUUID();
        this.projectId = null;
        this.model = null;
        this.location = null;

        // Features & Configuration
        this.responseModalities = ["VIDEO"];
        this.systemInstructions = "";
        this.enableInputTranscript = false;
        this.enableOutputTranscript = false;
        this.enableSessionResumption = false;
        this.resumptionHandle = "";
        this.enableProactiveVideo = false;

        // Voice and Audio/Video Settings
        this.voiceName = "";
        this.voiceLocale = "";
        this.customVoiceSample = "";
        this.audioBitrate = 0;
        this.videoBitrate = 0;

        // VAD (Voice Activity Detection) Settings
        this.disableDetection = false;
        this.disableInterruption = false;
        this.startSensitivity = "";
        this.endSensitivity = "";

        // S2ST (Speech to Speech Translation) Settings
        this.enableS2ST = false;
        this.s2stTargetLanguage = "";

        // Function Calling / Tools Settings
        this.functionCallDefinition = null;
        this.toolBehavior = "BLOCKING";

        // Avatar Customization Settings
        // Without an image (setCustomizedAvatar()) sessions use the stock
        // "Piper" avatar. Custom images need a project on the
        // EnableCustomAvatar allowlist, which the default project isn't.
        this.customizedAvatarData = "";
        this.customizedAvatarMimeType = "image/png";

        // Callbacks (Publicly overridable)
        this.onReceiveResponse = (message) => {
            console.log("Default message received callback", message);
        };
        this.onConnectionStarted = () => {
            console.log("Default onConnectionStarted");
        };
        this.onErrorMessage = (message) => {
            alert(message);
        };

        // Internal State
        this.webSocket = null;
        this.transportMode = "webrtc";
        this.webRtcManager =
            typeof G3RtcWebRtcManager !== "undefined"
                ? new G3RtcWebRtcManager()
                : null;
        if (this.webRtcManager) {
            this.webRtcManager.onConnectionFailed = () => {
                this.onErrorMessage(
                    "The WebRTC connection failed. UDP may be blocked on this network; " +
                    "try the WebSocket transport."
                );
            };
        }

        // Real-time bandwidth usage statistics
        this.intervalMs = 2000; // Update interval in milliseconds (2 seconds)
        this.bytesIn = 0; // Total bytes received (download)
        this.bytesOut = 0; // Total bytes sent (upload)
        this.intervalId = null; // Timer ID for interval updates
        this.history = []; // Array to store bandwidth history for display
        this.googleSearchEnabled = false; // Enable/disable Google Search tool
        this.isSetupComplete = false; // Whether the server confirmed the setup message
        this.latestResumptionHandle = ""; // Last handle the server sent this session
        this.connectAttempt = 0; // Bumped to cancel a connect in progress
        this.autoResumeTimes = []; // When automatic resumes happened
        this.setupTimer = null;
        // Called when the server restarts and the session can be resumed.
        this.onReconnectNeeded = () => {};
        // Called after falling back from WebRTC to WebSocket media.
        this.onTransportFallback = () => {};
        console.log("Created Gemini Live API object: ", this);
    }

    /**
     * Sets the location/region and updates the corresponding API host endpoint.
     * @param {string} location - Google Cloud location (e.g., 'us-central1').
     */
    setLocation(location) {
        this.location = location;
        this.setApiHost(this.environment);
    }

    /**
     * Sets the target Google Cloud Project ID.
     * @param {string} projectId - Google Cloud Project ID.
     */
    setProjectId(projectId) {
        this.projectId = projectId;
    }

    /**
     * Sets the Gemini Live model name.
     * @param {string} model - Gemini Live model ID.
     */
    setModel(model) {
        this.model = model;
    }

    /**
     * Sets the transport mode ('webrtc' or 'websocket').
     * @param {string} mode - Transport mode ('webrtc' or 'websocket').
     */
    setTransportMode(mode) {
        this.transportMode = mode === "websocket" ? "websocket" : "webrtc";
    }

    /**
     * Configures the API hostname based on the execution environment.
     * @param {string} environment - Target environment ('prod', 'staging', 'autopush', 'autopush-common', 'staging-common').
     */
    setApiHost(environment) {
        this.environment = environment;
        switch (this.environment) {
            case "autopush-common":
            case "staging-common":
            case "autopush-vertex-bidi":
            case "autopush-vertex-us-bidi":
                this.endPoint = this.environment;
                break;
            case "autopush-us-rep":
            case "autopush-aiplatform.us.rep.sandbox.googleapis.com":
                this.endPoint =
                    "autopush-aiplatform.us.rep.sandbox.googleapis.com";
                break;
            case "staging-us-rep":
            case "staging-aiplatform.us.rep.sandbox.googleapis.com":
                this.endPoint =
                    "staging-aiplatform.us.rep.sandbox.googleapis.com";
                break;
            case "prod-us-rep":
            case "aiplatform.us.rep.googleapis.com":
                this.endPoint = "aiplatform.us.rep.googleapis.com";
                break;
            case "autopush":
                this.endPoint = "autopush-aiplatform.sandbox.googleapis.com";
                break;
            case "staging":
                this.endPoint = "staging-aiplatform.sandbox.googleapis.com";
                break;
            case "prod":
            default:
                if (this.environment !== "prod") {
                    console.error(
                        `Unknown environment: ${this.environment}. Using production API host.`
                    );
                }
                this.endPoint = "aiplatform.googleapis.com";
                break;
        }
    }

    /**
     * Enables or disables live transcription of user input and model output.
     * @param {boolean} input - Whether to enable input transcripts.
     * @param {boolean} output - Whether to enable output transcripts.
     */
    setTranscript(input, output) {
        console.log("input transcript: ", input, "output transcript: ", output);
        this.enableInputTranscript = input;
        this.enableOutputTranscript = output;
    }

    /**
     * Sets the preferred TTS voice name and locale.
     * @param {string} name - TTS voice name (e.g., 'Aoede').
     * @param {string} locale - Voice language/locale code (e.g., 'en-US').
     */
    setVoice(name, locale) {
        this.voiceName = name;
        this.voiceLocale = locale;
    }

    /**
     * Sets the function call / tool definition schema for the session.
     * @param {Object} fcDefinition - Function calling definitions.
     */
    setFunctionCall(fcDefinition) {
        this.functionCallDefinition = fcDefinition;
    }

    /**
     * Normalizes an uploaded tools file to a list of Gemini function
     * declarations. Accepts that list itself, a single declaration, or an
     * OpenAI-style tool list ({type: "function", function: {...}}, optionally
     * under "tools").
     * @param {*} json - The parsed file.
     * @returns {Object[]}
     */
    static toFunctionDeclarations(json) {
        const list = Array.isArray(json) ? json : Array.isArray(json?.tools) ? json.tools : [json];
        return list.map((entry) =>
            entry && entry.type === "function" && entry.function ? entry.function : entry
        );
    }

    /**
     * Sets a custom voice sample audio payload for replicated voice synthesis.
     * @param {string} base64Wav - Base64 encoded WAV audio sample.
     */
    setCustomVoice(base64Wav) {
        this.customVoiceSample = base64Wav;
    }

    /**
     * Configures session resumption parameters.
     * @param {boolean} enable - Whether session resumption is enabled.
     * @param {string} handle - Resumption handle string from a prior session.
     */
    setResumption(enable, handle) {
        this.enableSessionResumption = enable;
        this.resumptionHandle = handle;
    }

    /**
     * Configures audio and video bitrates for the connection.
     * @param {number} audioBitrate - Audio bitrate in bits per second.
     * @param {number} videoBitrate - Video bitrate in bits per second.
     */
    setBitrates(audioBitrate, videoBitrate) {
        this.audioBitrate = Number(audioBitrate) || 0;
        this.videoBitrate = Number(videoBitrate) || 0;
    }

    /**
     * Sets Voice Activity Detection (VAD) configuration options.
     * @param {boolean} disableInterruption - Whether to disable interruption handling.
     * @param {boolean} disableDetection - Whether to completely disable VAD.
     * @param {string} startSen - Speech start sensitivity ('low', 'high', or empty).
     * @param {string} endSen - Speech end sensitivity ('low', 'high', or empty).
     */
    setVad(disableInterruption, disableDetection, startSen, endSen) {
        this.disableInterruption = disableInterruption;
        this.disableDetection = disableDetection;
        this.startSensitivity = startSen;
        this.endSensitivity = endSen;
    }

    /**
     * Enables or disables proactive video generation.
     * @param {boolean} enable - Whether to enable proactive video.
     */
    setProactiveVideo(enable) {
        this.enableProactiveVideo = enable;
    }

    /**
     * Configures Speech-to-Speech Translation (S2ST).
     * @param {boolean} enable - Whether S2ST is enabled.
     * @param {string} language - Target translation language code.
     */
    setS2ST(enable, language) {
        console.log(`Setting S2ST to: ${enable}, Target Language: ${language}`);
        this.enableS2ST = enable;
        this.s2stTargetLanguage = language;
    }

    /**
     * Sets customized avatar image and MIME type.
     * @param {string} imageData - Base64 encoded image data.
     * @param {string} [mimeType="image/png"] - Image MIME type.
     */
    setCustomizedAvatar(imageData, mimeType = "image/png") {
        this.customizedAvatarData = imageData;
        this.customizedAvatarMimeType = mimeType;
    }

    /**
     * Initiates the overall connection process: loads custom avatar,
     * initializes backend service, posts tool declarations, and establishes WebSocket.
     */
    /**
     * Performs all asynchronous HTTP and media initialization steps required before
     * establishing the WebSocket connection.
     * @returns {Promise<boolean>} Whether the session is ready for its
     *     WebSocket; false if disconnect() abandoned the attempt meanwhile.
     */
    async prepare(attempt = this.connectAttempt) {
        // An attempt that disconnect() abandoned must neither report errors
        // (which would end the next attempt's session) nor touch its state.
        const isCurrent = () => attempt === this.connectAttempt;
        const sessionId = this.sessionId;
        let created = false;
        try {
            console.log("prepare(): Initializing backend service...");
            const projectId = await this.initBackendService(sessionId);
            created = true;
            if (!isCurrent()) {
                this.abandonSession(sessionId);
                return false;
            }
            if (projectId) {
                this.setProjectId(projectId);
            }

            console.log("prepare(): Setting up function declarations...");
            await this.setupFuncDeclarationToService(sessionId);
        } catch (error) {
            if (created) {
                this.abandonSession(sessionId);
            }
            if (isCurrent()) {
                this.onErrorMessage(error.message);
            }
            throw error;
        }
        if (!isCurrent()) {
            this.abandonSession(sessionId);
            return false;
        }
        return true;
    }

    /**
     * Tells the backend that a session it set up will never open its
     * WebSocket, so the session doesn't count against the server's session
     * limit until it expires.
     * @param {string} sessionId
     */
    abandonSession(sessionId) {
        this.sendPostRequest(this.controlUrl, { command: "disconnect", session_id: sessionId })
            .catch((error) => console.warn(`Could not release session ${sessionId}:`, error));
    }

    /**
     * Initiates the overall connection process: prepares the session and establishes the WebSocket.
     */
    async connect() {
        // A fresh ID per connection, so cleanup of the previous connection on
        // the backend can't remove this one.
        this.sessionId = crypto.randomUUID();
        this.latestResumptionHandle = "";
        const attempt = ++this.connectAttempt;
        this.autoResumeTimes = [];
        try {
            if (!(await this.prepare(attempt))) return; // Cancelled by disconnect().
            console.log("connect(): Preparation successful. Starting WebSocket connection...");
            this.setupWebSocketToService();
        } catch (error) {
            console.error("connect(): Connection sequence failed.", error);
        }
    }

    /**
     * Whether the current session can be resumed: resumption is on and the
     * server has sent this session a handle.
     * @returns {boolean}
     */
    canResume() {
        return this.enableSessionResumption && !!this.latestResumptionHandle;
    }

    /**
     * Rate-limits automatic resumes to AUTO_RESUME_LIMIT a minute, so a server
     * that keeps closing connections can't cause a reconnect loop.
     * @returns {boolean} Whether another automatic resume is allowed now.
     */
    takeAutoResume() {
        const now = Date.now();
        this.autoResumeTimes = this.autoResumeTimes.filter((t) => now - t < 60000);
        if (this.autoResumeTimes.length >= AUTO_RESUME_LIMIT) {
            return false;
        }
        this.autoResumeTimes.push(now);
        return true;
    }

    /**
     * Decides what to do about a GoAway. Resuming counts against the same
     * limit as resumes after a server restart, so a server that sends GoAway
     * right after every setup can't cause a reconnect loop.
     * @returns {"resume"|"unavailable"|"limited"} "resume" if the caller
     *     should resume now, "unavailable" if the session has no handle or
     *     resumption is off, "limited" if too many resumes happened recently.
     */
    goAwayAction() {
        if (!this.canResume()) return "unavailable";
        return this.takeAutoResume() ? "resume" : "limited";
    }

    /**
     * Replaces the current connection with one that resumes the session from
     * `handle`, e.g. after a GoAway. The old connection is closed quietly.
     * @param {string} handle - Session resumption handle.
     * @returns {Promise<void>} Rejects if the new session could not be prepared.
     */
    async resume(handle) {
        const oldWebSocket = this.webSocket;
        this.webSocket = null;
        this.isSetupComplete = false;
        this.stopUpdateBandwidthUsage();
        const closed = oldWebSocket
            ? new Promise((resolve) => {
                oldWebSocket.onopen = null;
                oldWebSocket.onmessage = null;
                oldWebSocket.onclose = () => resolve();
                oldWebSocket.onerror = () => resolve();
                if (oldWebSocket.readyState === WebSocket.CLOSED) {
                    resolve();
                } else {
                    oldWebSocket.close(1000);
                }
            })
            : Promise.resolve();

        this.setResumption(true, handle);
        // A new session ID keeps the backend from mixing up the two connections.
        const sessionId = crypto.randomUUID();
        this.sessionId = sessionId;
        const attempt = ++this.connectAttempt;
        // Close the old connection while the backend prepares the new session.
        const [, ready] = await Promise.all([closed, this.prepare(attempt)]);
        if (!ready) return; // Cancelled by disconnect().
        if (attempt !== this.connectAttempt) {
            // Cancelled while the old connection was still closing.
            this.abandonSession(sessionId);
            return;
        }
        this.setupWebSocketToService();
    }

    /**
     * Initializes backend control session to retrieve Project ID or other session metadata.
     * @returns {Promise<void>}
     */
    async initBackendService(sessionId = this.sessionId) {
        if (this.model === "gemini-3.5-live-early-exp") {
            this.location = "us-central1";
            if (
                this.environment === "staging-us-rep" ||
                this.environment === "staging-common"
            ) {
                this.setApiHost("staging");
            } else if (
                this.environment === "autopush-us-rep" ||
                this.environment === "autopush-common" ||
                this.environment === "autopush-vertex-bidi" ||
                this.environment === "autopush-vertex-us-bidi"
            ) {
                this.setApiHost("autopush");
            } else if (this.environment === "prod-us-rep") {
                this.setApiHost("prod");
            }
        }
        const postRequestBody = {
            command: "connect",
            session_id: sessionId,
            endpoint: this.endPoint,
            location: this.location,
        };
        try {
            const response = await this.postWithRetry(this.controlUrl, postRequestBody);
            return response?.project_id;
        } catch (error) {
            console.error("Error in initBackendService:", error);
            throw new Error(`Could not start the session: ${error.message}`);
        }
    }

    /**
     * Posts tool / function declarations to the function registry service.
     * @returns {Promise<void>}
     */
    async setupFuncDeclarationToService(sessionId = this.sessionId) {
        if (!this.functionCallDefinition) {
            return;
        }
        const funcDeclarationMessage = {
            objective: "fc_definition",
            session_id: sessionId,
            functionDefinition: this.functionCallDefinition,
        };
        try {
            await this.sendPostRequest(this.frUrl, funcDeclarationMessage);
        } catch (error) {
            console.error("Error in setupFuncDeclarationToService:", error);
            throw new Error(`Could not set up function declarations: ${error.message}`);
        }
    }

    /**
     * Closes the connection at the user's request. Unlike a close initiated by
     * the server, this doesn't report an error.
     */
    disconnect() {
        this.connectAttempt++; // Abandons a connect() or resume() in progress.
        this.stopUpdateBandwidthUsage();
        if (this.webRtcManager) {
            this.webRtcManager.close();
        }
        const webSocket = this.webSocket;
        this.webSocket = null;
        this.isSetupComplete = false;
        if (webSocket) {
            webSocket.onopen = null;
            webSocket.onclose = null;
            webSocket.onerror = null;
            webSocket.onmessage = null;
            webSocket.close(1000);
        }
    }

    /**
     * Sends a structured JSON message over the WebSocket connection.
     * @param {Object} message - Message object to serialize and send.
     */
    sendMessage(message) {
        if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
            this.webSocket.send(JSON.stringify(message));
        } else {
            console.warn("sendMessage(): WebSocket is not open. Cannot send message:", message);
        }
    }

    /**
     * Handler for incoming WebSocket message events.
     * @param {MessageEvent} messageEvent - The WebSocket message event.
     */
    onReceiveMessage(messageEvent) {
        this.bytesIn += this.calculateByteSize(messageEvent.data);

        if (typeof messageEvent.data !== "string") {
            console.warn("Received binary message, ignoring: ", messageEvent.data);
            return;
        }

        let events;
        try {
            events = GeminiLiveResponseMessage.parseAll(JSON.parse(messageEvent.data));
        } catch (error) {
            console.error("Failed to parse incoming WebSocket message as JSON:", error);
            return;
        }
        for (const message of events) {
            if (message.type === "SETUP COMPLETE") {
                this.isSetupComplete = true;
                clearTimeout(this.setupTimer);
                if (this.transportMode === "webrtc" && !message.answerSdp) {
                    this.fallBackToWebSocketMedia();
                }
            } else if (message.type === "RESUMPTION") {
                this.latestResumptionHandle = message.data;
            }
            if (
                message.type === "SETUP COMPLETE" &&
                this.transportMode === "webrtc" &&
                message.answerSdp &&
                this.webRtcManager
            ) {
                console.log(
                    "[WebRTC] Received answerSdp in setupComplete, completing WebRTC session..."
                );
                this.webRtcManager
                    .completeSession(message.answerSdp)
                    .catch((err) => {
                        console.error(
                            "[WebRTC] Failed to complete session with answerSdp:",
                            err
                        );
                        this.onErrorMessage(
                            `WebRTC answer negotiation failed: ${err.message}`
                        );
                    });
            }
            try {
                this.onReceiveResponse(message);
            } catch (error) {
                console.error(`Error handling ${message.type} event:`, error);
            }
            if (message.type === "SETUP COMPLETE") {
                // Only now does the server accept input. This runs even if
                // the handler above failed, or the UI would stay "connecting".
                try {
                    this.onConnectionStarted();
                } catch (error) {
                    console.error("Error starting the connection:", error);
                    this.onErrorMessage(`Could not start the session: ${error.message}`);
                    return; // The session has ended; drop the rest.
                }
            }
        }
    }

    /**
     * Switches media to the WebSocket when the server ignored the WebRTC offer
     * (setupComplete without an SDP answer). It then streams audio and video
     * over the WebSocket, which would otherwise be dropped.
     */
    fallBackToWebSocketMedia() {
        console.warn("[WebRTC] setupComplete has no SDP answer; using WebSocket media.");
        this.transportMode = "websocket";
        if (this.webRtcManager) {
            this.webRtcManager.close();
        }
        this.updateBandwidthUsage();
        this.onTransportFallback();
    }

    /**
     * Describes why the server closed the connection, for showing to the user.
     * @param {CloseEvent} event
     * @returns {string}
     */
    static describeClose(event) {
        if (event.code === 1000 && !event.reason) {
            return "The session was closed by the server.";
        }
        if (event.code === 1006) {
            return "Lost the connection to the server.";
        }
        return `Connection closed (code ${event.code})${event.reason ? `: ${event.reason}` : "."}`;
    }

    /**
     * Establishes the WebSocket connection to the proxy service and binds event handlers.
     */
    setupWebSocketToService() {
        console.log("connecting: ", this.proxyUrl);

        const wsUrl = new URL(this.proxyUrl);
        wsUrl.searchParams.append("session_id", this.sessionId);
        const webSocket = new WebSocket(wsUrl);
        this.webSocket = webSocket;
        this.isSetupComplete = false;
        clearTimeout(this.setupTimer);
        this.setupTimer = setTimeout(() => {
            if (this.webSocket === webSocket && !this.isSetupComplete) {
                this.onErrorMessage("Timed out waiting for the server to set up the session.");
            }
        }, SETUP_TIMEOUT_MS);

        webSocket.onclose = (event) => {
            console.log("websocket closed: ", event.code, event.reason);
            if (this.webSocket !== webSocket) {
                return; // Superseded by disconnect() or resume().
            }
            const wasSetUp = this.isSetupComplete;
            this.webSocket = null;
            this.isSetupComplete = false;
            this.stopUpdateBandwidthUsage();
            // 1001 means the server is going away (e.g. the backend restarts
            // for a deploy); resume the session on a new connection if this
            // one worked and we aren't already resuming in a loop.
            const resumable =
                event.code === 1001 && wasSetUp && this.canResume() && this.takeAutoResume();
            if (this.webRtcManager) {
                this.webRtcManager.close({ keepLocalMedia: resumable });
            }
            if (resumable) {
                this.onReconnectNeeded();
                return;
            }
            this.onErrorMessage(GeminiLiveAPI.describeClose(event));
        };

        // An error is always followed by a close event, which reports it.
        webSocket.onerror = (event) => {
            console.warn("websocket error: ", event);
        };

        webSocket.onopen = async () => {
            console.log("websocket open");
            try {
                // onConnectionStarted() runs when the server confirms setup.
                await this.sendInitialSetupMessages(webSocket);
            } catch (err) {
                if (this.webSocket !== webSocket) return; // Cancelled meanwhile.
                console.error("Failed during initial setup:", err);
                this.onErrorMessage(`Setup failed: ${err.message}`);
            }
        };

        webSocket.onmessage = this.onReceiveMessage.bind(this);

        // Override send to track outbound bandwidth
        const originalSend = webSocket.send.bind(webSocket);
        webSocket.send = (data) => {
            this.bytesOut += this.calculateByteSize(data);
            originalSend(data);
        };

        // Start periodic bandwidth updates for WebSocket mode
        if (this.transportMode !== "webrtc") {
            this.updateBandwidthUsage();
        }
    }

    /**
     * Starts periodic calculation and DOM reporting of upload/download bandwidth usage.
     */
    updateBandwidthUsage() {
        if (this.intervalId) return;

        this.intervalId = setInterval(() => {
            const timeSec = this.intervalMs / 1000;

            // Convert to Kilobytes per second (KB/s)
            const uploadSpeed = (this.bytesOut / 1024) / timeSec;
            const downloadSpeed = (this.bytesIn / 1024) / timeSec;

            const stats = {
                uploadKbps: uploadSpeed,
                downloadKbps: downloadSpeed,
                totalKbps: uploadSpeed + downloadSpeed,
            };

            this.history.push(stats);
            if (this.history.length > 60) this.history.shift(); // Keep last minute of history

            const uploadSpeedElement = document.getElementById("upload-speed");
            const downloadSpeedElement = document.getElementById("download-speed");

            if (uploadSpeedElement) {
                uploadSpeedElement.textContent = uploadSpeed.toFixed(2);
            }
            if (downloadSpeedElement) {
                downloadSpeedElement.textContent = downloadSpeed.toFixed(2);
            }

            // Reset counters for the next interval
            this.bytesIn = 0;
            this.bytesOut = 0;
        }, this.intervalMs);
    }

    /**
     * Stops the periodic bandwidth reporting interval.
     */
    stopUpdateBandwidthUsage() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Constructs and sends the initial WebSocket session setup message.
     */
    async sendInitialSetupMessages(webSocket = this.webSocket) {
        console.log("start setting up");

        const isCommonBag =
            this.environment === "autopush-common" ||
            this.environment === "staging-common" ||
            this.environment === "autopush-vertex-bidi" ||
            this.environment === "autopush-vertex-us-bidi";
        let resolvedModel = this.model;
        if (
            !isCommonBag &&
            (resolvedModel === "live_avatar_rev23_rc4" ||
                resolvedModel === "live_avatar_v2_rev25_rc2" ||
                resolvedModel === "gemini_api_beyond_live_rev23_rc3" ||
                resolvedModel === "gemini_live_rev25")
        ) {
            // On prod mREP, gemini-3.8-live is served by the GRoot "bidi" pool,
            // which supports WebRTC; gemini-3.1 models go to "genai-rapid".
            resolvedModel =
                this.environment === "prod-us-rep"
                    ? "gemini-3.8-live"
                    : "gemini-3.1-flash-live-preview-04-2026";
        }
        this.resolvedModel = resolvedModel;
        const modelUri = isCommonBag
            ? `models/${resolvedModel}`
            : `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${resolvedModel}`;

        const sessionSetupMessage = {
            setup: {
                model: modelUri,
                generation_config: this._buildGenerationConfig(),
            },
        };
        const avatarConfig = this._buildAvatarConfig();
        if (avatarConfig && Object.keys(avatarConfig).length > 0) {
            sessionSetupMessage.setup.avatar_config = avatarConfig;
        }

        if (this.enableInputTranscript) {
            sessionSetupMessage.setup.input_audio_transcription = {};
        }
        if (this.enableOutputTranscript) {
            sessionSetupMessage.setup.output_audio_transcription = {};
        }

        if (this.transportMode === "webrtc" && this.webRtcManager) {
            const wantsVideo = this.responseModalities.includes("VIDEO");
            console.log(
                `[WebRTC] Generating SDP offer (wantsVideo=${wantsVideo})...`
            );
            const offerSdp = await this.webRtcManager.initiateSession({
                wantsVideo,
            });
            // ICE gathering takes up to 3 s; the user may have disconnected.
            if (this.webSocket !== webSocket) return;
            sessionSetupMessage.setup.rtc_setup = {
                offer_sdp: offerSdp,
            };
        }

        const toolsConfig = this._buildToolsConfig();
        if (toolsConfig) {
            sessionSetupMessage.setup.tools = toolsConfig;
        }

        const sysInstruction = this._buildSystemInstructionConfig();
        if (sysInstruction) {
            sessionSetupMessage.setup.system_instruction = sysInstruction;
        }

        const sessionResumption = this._buildSessionResumptionConfig();
        if (sessionResumption) {
            sessionSetupMessage.setup.session_resumption = sessionResumption;
        }

        const realtimeInputConfig = this._buildRealtimeInputConfig();
        if (realtimeInputConfig) {
            sessionSetupMessage.setup.realtime_input_config = realtimeInputConfig;
        }

        const proactivityConfig = this._buildProactivityConfig();
        if (proactivityConfig) {
            sessionSetupMessage.setup.proactivity = proactivityConfig;
        }

        if (this.enableS2ST) {
            sessionSetupMessage.setup.enable_speech_to_speech_translation = true;
        }

        // Abbreviate base64 payloads (voice sample, avatar image) in the log.
        console.log(
            "setup message: ",
            JSON.stringify(sessionSetupMessage, (key, value) =>
                typeof value === "string" && value.length > 500
                    ? `<${value.length} chars>`
                    : value
            )
        );
        this.sendMessage(sessionSetupMessage);
    }

    _buildGenerationConfig() {
        const voiceConfig = this.customVoiceSample
            ? {
                replicated_voice_config: {
                    voice_sample_audio: this.customVoiceSample,
                    mime_type: "audio/pcm;rate=24000",
                },
            }
            : {
                prebuilt_voice_config: {
                    voice_name: this.voiceName,
                },
            };

        const languageCode = this.enableS2ST
            ? this.s2stTargetLanguage
            : this.voiceLocale;

        return {
            response_modalities: this.responseModalities,
            speech_config: {
                voice_config: voiceConfig,
                language_code: languageCode,
            },
        };
    }

    _buildAvatarConfig() {
        if (!this.responseModalities.includes("VIDEO")) {
            return null;
        }
        const config = {};
        if (this.customizedAvatarData) {
            config.customized_avatar = {
                image_mime_type: this.customizedAvatarMimeType,
                image_data: this.customizedAvatarData,
            };
        } else {
            config.avatar_name = "Piper";
        }
        if (this.audioBitrate > 0) {
            config.audio_bitrate_bps = this.audioBitrate;
        }
        if (this.videoBitrate > 0) {
            config.video_bitrate_bps = this.videoBitrate;
        }
        return config;
    }

    _buildToolsConfig() {
        let fcDef = null;

        if (this.googleSearchEnabled) {
            fcDef = [{ googleSearch: {} }];
        }

        if (this.functionCallDefinition) {
            if (!fcDef) {
                fcDef = [];
            }
            const declarations = Array.isArray(this.functionCallDefinition)
                ? this.functionCallDefinition
                : [this.functionCallDefinition];
            // `behavior` belongs to each FunctionDeclaration, not the Tool.
            // BLOCKING is the default, so it is only sent for NON_BLOCKING.
            fcDef.push({
                function_declarations:
                    this.toolBehavior === "NON_BLOCKING"
                        ? declarations.map((d) => ({ ...d, behavior: "NON_BLOCKING" }))
                        : declarations,
            });
        }
        return fcDef;
    }

    _buildSystemInstructionConfig() {
        if (!this.systemInstructions || !this.systemInstructions.trim()) {
            return null;
        }
        return {
            parts: [{ text: this.systemInstructions }],
        };
    }

    _buildSessionResumptionConfig() {
        if (!this.enableSessionResumption) {
            return null;
        }
        const config = {};
        if (this.resumptionHandle && this.resumptionHandle.trim() !== "") {
            config.handle = this.resumptionHandle;
        }
        return config;
    }

    _buildRealtimeInputConfig() {
        const hasDetectionConfig =
            this.disableDetection ||
            this.startSensitivity !== "" ||
            this.endSensitivity !== "";

        const hasInterruptionConfig = this.disableInterruption;

        if (!hasDetectionConfig && !hasInterruptionConfig) {
            return null;
        }

        const getStartSensitivity = (sens) => {
            switch (sens?.toLowerCase()) {
                case "low": return "START_SENSITIVITY_LOW";
                case "high": return "START_SENSITIVITY_HIGH";
                default: return "START_SENSITIVITY_UNSPECIFIED";
            }
        };

        const getEndSensitivity = (sens) => {
            switch (sens?.toLowerCase()) {
                case "low": return "END_SENSITIVITY_LOW";
                case "high": return "END_SENSITIVITY_HIGH";
                default: return "END_SENSITIVITY_UNSPECIFIED";
            }
        };

        const config = {};

        if (hasDetectionConfig) {
            // Only what the user chose; the rest keeps the server's defaults.
            config.automatic_activity_detection = {};
            if (this.startSensitivity) {
                config.automatic_activity_detection.start_of_speech_sensitivity =
                    getStartSensitivity(this.startSensitivity);
            }
            if (this.endSensitivity) {
                config.automatic_activity_detection.end_of_speech_sensitivity =
                    getEndSensitivity(this.endSensitivity);
            }
            if (this.disableDetection) {
                config.automatic_activity_detection.disabled = true;
            }
        }

        if (hasInterruptionConfig) {
            config.activity_handling = "NO_INTERRUPTION";
        }

        return config;
    }

    _buildProactivityConfig() {
        if (!this.enableProactiveVideo) {
            return null;
        }
        return {
            proactive_video: true,
        };
    }

    /**
     * Sends a text interaction message from the user.
     * @param {string} text - User message text.
     */
    sendTextMessage(text) {
        const textMessage = {
            client_content: {
                turns: [
                    {
                        role: "user",
                        parts: [{ text: text }],
                    },
                ],
                turn_complete: true,
            },
        };
        this.sendMessage(textMessage);
    }

    /**
     * Sends a VAD activity signal (speech start or end).
     * @param {boolean} start - True for activity start, false for activity end.
     */
    sendVoiceActivityMessage(start) {
        const activityMessage = {
            realtime_input: start ? { activity_start: {} } : { activity_end: {} },
        };
        this.sendMessage(activityMessage);
    }

    /**
     * Helper to send real-time input media chunks (audio or images).
     * @param {string} data - Base64 encoded media payload.
     * @param {string} mimeType - Media MIME type.
     * @param {boolean} [isVideo=false] - Whether the input should be formatted as a video frame or media chunk.
     */
    sendRealtimeInputMessage(data, mimeType, isVideo = false) {
        if (!this.isSetupComplete) {
            // The server rejects input before setup completes, e.g. while
            // reconnecting for session resumption. Drop it.
            return;
        }
        const message = {
            realtime_input: isVideo
                ? { video: { mime_type: mimeType, data: data } }
                : { media_chunks: [{ mime_type: mimeType, data: data }] },
        };
        this.sendMessage(message);
    }

    /**
     * Sends a stream of PCM audio data.
     * @param {string} base64PCM - Base64 encoded 16kHz PCM audio chunk.
     */
    sendAudioMessage(base64PCM) {
        this.sendRealtimeInputMessage(base64PCM, "audio/pcm;rate=16000");
    }

    /**
     * Sends an image frame or picture message.
     * @param {string} base64Image - Base64 encoded image data.
     * @param {string} [mimeType="image/jpeg"] - Image MIME type.
     */
    sendImageMessage(base64Image, mimeType = "image/jpeg") {
        this.sendRealtimeInputMessage(base64Image, mimeType, true);
    }

    /**
     * Executes an HTTP POST request and parses the JSON response.
     * @param {string} url - Target HTTP URL.
     * @param {Object} data - JSON payload to post.
     * @returns {Promise<Object>} Parsed JSON response.
     */
    async sendPostRequest(url, data) {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
        });

        let receivedData = null;
        try {
            receivedData = await response.json();
        } catch {
            // Not JSON; fall through to the status check.
        }
        if (!response.ok) {
            const detail = receivedData?.error || response.statusText;
            const error = new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
            error.status = response.status;
            throw error;
        }
        console.log("Received data:", receivedData);
        return receivedData;
    }

    /**
     * Like sendPostRequest(), but retries network failures (not HTTP errors),
     * e.g. while the backend restarts.
     * @param {string} url
     * @param {Object} data
     * @param {number} [attempts=4]
     * @returns {Promise<Object>}
     */
    async postWithRetry(url, data, attempts = 4) {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.sendPostRequest(url, data);
            } catch (error) {
                // fetch() rejects with a TypeError when the server is
                // unreachable; a proxy in front of it answers 502-504.
                const transient =
                    error instanceof TypeError || [502, 503, 504].includes(error.status);
                if (!transient || attempt >= attempts) {
                    throw error;
                }
                console.warn(`POST ${url} failed (${error.message}); retrying...`);
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    /**
     * Calculates the approximate byte size of a payload.
     * @param {string|ArrayBuffer|ArrayBufferView|Blob} data - Payload to measure.
     * @returns {number} Payload size in bytes.
     */
    calculateByteSize(data) {
        if (typeof data === "string") {
            return new Blob([data]).size;
        }
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            return data.byteLength;
        }
        if (data instanceof Blob) {
            return data.size;
        }
        return 0;
    }
}

console.log("loaded gemini-live-api.js");
