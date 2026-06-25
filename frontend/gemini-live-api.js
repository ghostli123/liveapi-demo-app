/**
 * Represents a parsed response message from the Gemini Live API WebSocket connection.
 */
class GeminiLiveResponseMessage {
    /**
     * @param {Object} data - Raw JSON message received from the WebSocket.
     */
    constructor(data) {
        this.data = "";
        this.type = "";
        this.mimeType = undefined;

        const serverContent = data?.serverContent || data?.server_content;
        this.endOfTurn = serverContent?.turnComplete || serverContent?.turn_complete;
        this.interrupt = serverContent?.interrupted;

        this._parseMessage(data, serverContent);
    }

    /**
     * Internal method to parse and resolve the message type and data.
     * @param {Object} data - Raw WebSocket message data.
     * @param {Object} serverContent - Extracted server content object.
     */
    _parseMessage(data, serverContent) {
        if (this._parseSetupComplete(data)) return;
        if (this._parseFunctionCall(data)) return;
        if (this._parseVadSignal(data)) return;
        if (this._parseModelTurn(serverContent)) return;
        if (this._parseResumption(data)) return;
        if (this._parseGoAway(data)) return;
        if (this._parseInputTranscription(serverContent)) return;
        if (this._parseOutputTranscription(serverContent)) return;
        if (this._parseTurnEvents()) return;
    }

    _parseSetupComplete(data) {
        if (data?.setupComplete || data?.setup_complete) {
            this.type = "SETUP COMPLETE";
            return true;
        }
        return false;
    }

    _parseFunctionCall(data) {
        const toolCalls = data?.toolCall?.functionCalls || data?.tool_call?.function_calls;
        if (toolCalls) {
            this.data = toolCalls;
            this.type = "FUNCTION_CALL";
            return true;
        }
        return false;
    }

    _parseVadSignal(data) {
        if (data?.voiceActivityDetectionSignal || data?.voice_activity_detection_signal) {
            this.type = "VAD_SIGNAL";
            return true;
        }
        return false;
    }

    _parseModelTurn(serverContent) {
        const modelTurn = serverContent?.modelTurn || serverContent?.model_turn;
        const parts = modelTurn?.parts;
        if (!parts?.length) return false;

        const firstPart = parts[0];
        if (firstPart.text) {
            this.data = firstPart.text;
            this.type = "TEXT";
            return true;
        }

        const inlineData = firstPart.inlineData || firstPart.inline_data || firstPart.video;
        if (inlineData) {
            this.data = inlineData.data;
            const mimeType = inlineData.mimeType || inlineData.mime_type;
            if (mimeType && (mimeType.startsWith("video/") || mimeType.startsWith("image/"))) {
                this.type = "VIDEO";
                this.mimeType = mimeType;
            } else {
                this.type = "AUDIO";
                if (mimeType) {
                    this.mimeType = mimeType;
                }
            }
            return true;
        }

        return false;
    }

    _parseResumption(data) {
        const resumption = data?.sessionResumptionUpdate || data?.session_resumption_update;
        if (resumption) {
            this.type = "RESUMPTION";
            this.data = resumption.newHandle || resumption.new_handle;
            return true;
        }
        return false;
    }

    _parseGoAway(data) {
        const goAway = data?.goAway || data?.go_away;
        if (goAway) {
            this.type = "GO_AWAY";
            this.data = goAway.timeLeft || goAway.time_left;
            return true;
        }
        return false;
    }

    _parseInputTranscription(serverContent) {
        const transcription = serverContent?.inputTranscription || serverContent?.input_transcription;
        if (transcription) {
            this.type = "INPUT_TRANSCRIPTION";
            if (transcription.text) {
                this.data = transcription.text;
            } else if (transcription.finished) {
                this.data = transcription.finished;
            }
            return true;
        }
        return false;
    }

    _parseOutputTranscription(serverContent) {
        const transcription = serverContent?.outputTranscription || serverContent?.output_transcription;
        if (transcription) {
            this.type = "OUTPUT_TRANSCRIPTION";
            if (transcription.text) {
                this.data = transcription.text;
            } else if (transcription.finished) {
                this.data = "Finished: " + transcription.finished;
            }
            return true;
        }
        return false;
    }

    _parseTurnEvents() {
        if (this.endOfTurn) {
            this.data = "END OF TURN";
            this.type = "END_OF_TURN";
            return true;
        }
        if (this.interrupt) {
            this.data = "INTERRUPT";
            this.type = "INTERRUPT";
            return true;
        }
        return false;
    }
}

const DUMMY_AVATAR_16_9 =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAABnTYUvAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAMSURBVBhXYwQDAAACAAHnSm8jAAAAAElFTkSuQmCC";

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
        this.avatarMode = false;
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

        // Real-time bandwidth usage statistics
        this.intervalMs = 2000; // Update interval in milliseconds (2 seconds)
        this.bytesIn = 0; // Total bytes received (download)
        this.bytesOut = 0; // Total bytes sent (upload)
        this.intervalId = null; // Timer ID for interval updates
        this.history = []; // Array to store bandwidth history for display
        this.googleSearchEnabled = false; // Enable/disable Google Search tool
        console.log("Created Gemini Live API object: ", this);
    }

    /**
     * Loads a custom avatar image and extracts its base64 data.
     * @param {string} [url] - URL to fetch avatar image from.
     * @returns {Promise<void>}
     */
    async loadCustomAvatar(url = "/frontend/assets/avatar_image.png?v=" + Date.now()) {
        if (this.customizedAvatarData) {
            console.log("Custom avatar already loaded, skipping fetch.");
            return;
        }
        try {
            console.log("Loading custom avatar from:", url);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to load avatar image: ${response.statusText}`);
            }
            const blob = await response.blob();
            this.customizedAvatarMimeType = blob.type;
            
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64data = reader.result.split(",")[1];
                    this.customizedAvatarData = base64data;
                    console.log("Custom avatar image loaded successfully.");
                    resolve();
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            console.error("Error loading custom avatar:", error);
            this.onErrorMessage("Error loading custom avatar image.");
            throw error;
        }
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
     * Configures the API hostname based on the execution environment.
     * @param {string} environment - Target environment ('prod', 'staging', 'autopush').
     */
    setApiHost(environment) {
        this.environment = environment;
        switch (this.environment) {
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
        this.audioBitrate = audioBitrate;
        this.videoBitrate = videoBitrate;
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
     * @returns {Promise<void>}
     */
    async prepare() {
        console.log("prepare(): Loading custom avatar...");
        await this.loadCustomAvatar();

        console.log("prepare(): Avatar loaded. Initializing backend service...");
        await this.initBackendService();

        console.log("prepare(): initBackendService successful. Setting up function declarations...");
        await this.setupFuncDeclarationToService();
    }

    /**
     * Initiates the overall connection process: prepares the session and establishes the WebSocket.
     */
    async connect() {
        try {
            await this.prepare();
            console.log("connect(): Preparation successful. Starting WebSocket connection...");
            this.setupWebSocketToService();
        } catch (error) {
            console.error("connect(): Connection sequence failed.", error);
        }
    }

    /**
     * Initializes backend control session to retrieve Project ID or other session metadata.
     * @returns {Promise<void>}
     */
    async initBackendService() {
        const postRequestBody = {
            command: "connect",
            session_id: this.sessionId,
            endpoint: this.endPoint,
            location: this.location,
        };
        try {
            const response = await this.sendPostRequest(this.controlUrl, postRequestBody);
            if (response?.project_id) {
                this.setProjectId(response.project_id);
            }
        } catch (error) {
            console.error("Error in initBackendService:", error);
            this.onErrorMessage("Error initializing backend service.");
            throw error;
        }
    }

    /**
     * Posts tool / function declarations to the function registry service.
     * @returns {Promise<void>}
     */
    async setupFuncDeclarationToService() {
        if (!this.functionCallDefinition) {
            return;
        }
        const funcDeclarationMessage = {
            objective: "fc_definition",
            session_id: this.sessionId,
            functionDefinition: this.functionCallDefinition,
        };
        try {
            await this.sendPostRequest(this.frUrl, funcDeclarationMessage);
        } catch (error) {
            console.error("Error in setupFuncDeclarationToService:", error);
            this.onErrorMessage("Error setting up function declaration.");
            throw error;
        }
    }

    /**
     * Closes the active WebSocket connection and stops bandwidth tracking.
     */
    disconnect() {
        if (this.webSocket) {
            this.webSocket.close();
        }
        this.stopUpdateBandwidthUsage();
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
        console.log("Message received: ", messageEvent);

        this.bytesIn += this.calculateByteSize(messageEvent.data);

        if (typeof messageEvent.data !== "string") {
            console.warn("Received binary message, ignoring: ", messageEvent.data);
            return;
        }

        try {
            const messageData = JSON.parse(messageEvent.data);
            const message = new GeminiLiveResponseMessage(messageData);
            console.log("onReceiveMessageCallBack this ", this);
            this.onReceiveResponse(message);
        } catch (error) {
            console.error("Failed to parse incoming WebSocket message as JSON:", error);
        }
    }

    /**
     * Establishes the WebSocket connection to the proxy service and binds event handlers.
     */
    setupWebSocketToService() {
        console.log("connecting: ", this.proxyUrl);

        const wsUrl = new URL(this.proxyUrl);
        wsUrl.searchParams.append("session_id", this.sessionId);
        this.webSocket = new WebSocket(wsUrl);

        this.webSocket.onclose = (event) => {
            console.log("websocket closed: ", event);
            this.onErrorMessage("Connection closed");
        };

        this.webSocket.onerror = (event) => {
            console.log("websocket error: ", event);
            this.onErrorMessage("Connection error");
        };

        this.webSocket.onopen = (event) => {
            console.log("websocket open: ", event);
            this.sendInitialSetupMessages();
            this.onConnectionStarted();
        };

        this.webSocket.onmessage = this.onReceiveMessage.bind(this);

        // Override send to track outbound bandwidth
        const originalSend = this.webSocket.send.bind(this.webSocket);
        this.webSocket.send = (data) => {
            this.bytesOut += this.calculateByteSize(data);
            originalSend(data);
        };

        // Start periodic bandwidth updates
        this.updateBandwidthUsage();
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
    sendInitialSetupMessages() {
        console.log("start setting up");
        console.log("Setting up voice sample:" + this.customVoiceSample);

        const modelUri = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${this.model}`;

        const sessionSetupMessage = {
            setup: {
                model: modelUri,
                generation_config: this._buildGenerationConfig(),
                avatar_config: this._buildAvatarConfig(),
            },
        };

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

        console.log("setup message: ", JSON.stringify(sessionSetupMessage));
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
        const config = {
            avatar_name: "Piper",
        };
    // Customized avatar config option (currently commented out in original specs):
    // if (this.customizedAvatarData) {
    //     config.customized_avatar = {
    //         image_mime_type: this.customizedAvatarMimeType,
    //         image_data: this.customizedAvatarData,
        //     };
        // }
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
            fcDef.push({
                function_declarations: this.functionCallDefinition,
                behavior: this.toolBehavior,
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
            config.automatic_activity_detection = {
                start_of_speech_sensitivity: getStartSensitivity(this.startSensitivity),
                end_of_speech_sensitivity: getEndSensitivity(this.endSensitivity),
            };
            if (this.disableDetection) {
                config.automatic_activity_detection.disabled = true;
            }
        }

        if (hasInterruptionConfig) {
            config.activity_handling = 2;
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
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const receivedData = await response.json();
            console.log("Received data:", receivedData);
            return receivedData;
        } catch (error) {
            console.error("Error sending POST request:", error);
            this.onErrorMessage(`Error sending POST request: ${error.message}`);
            throw error;
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
