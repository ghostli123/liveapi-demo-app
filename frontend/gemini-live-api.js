class GeminiLiveResponseMessage {
    constructor(data) {
        this.data = "";
        this.type = "";
        this.endOfTurn = data?.serverContent?.turnComplete;
        this.interrupt = data?.serverContent?.interrupted;

        const parts = data?.serverContent?.modelTurn?.parts;
        const tool_calls = data?.toolCall?.functionCalls;

        if (data?.setupComplete) {
            this.type = "SETUP COMPLETE";
        } else if (tool_calls) {
            this.data = tool_calls;
            this.type = "FUNCTION_CALL";
        } else if (data?.voiceActivityDetectionSignal) {
            this.type = "VAD_SIGNAL";
        } else if (parts?.length && parts[0].text) {
            this.data = parts[0].text;
            this.type = "TEXT";
        } else if (parts?.length && parts[0].inlineData) {
            this.data = parts[0].inlineData.data;
            this.type = "AUDIO";
        } else if (data?.sessionResumptionUpdate) {
            this.type = "RESUMPTION";
            this.data = data?.sessionResumptionUpdate?.newHandle;
        } else if (data?.serverContent?.inputTranscription) {
            this.type = "INPUT_TRANSCRIPTION";
            if (data?.serverContent?.inputTranscription?.text) {
                this.data = data?.serverContent?.inputTranscription?.text;
            } else if (data?.serverContent?.inputTranscription?.finished) {
                this.data = data?.serverContent?.inputTranscription?.finished;
            }
        } else if (data?.serverContent?.outputTranscription) {
            this.type = "OUTPUT_TRANSCRIPTION";
            if (data?.serverContent?.outputTranscription?.text) {
                this.data = data?.serverContent?.outputTranscription?.text;
            } else if (data?.serverContent?.outputTranscription?.finished) {
                this.data =
                    "Finished: " +
                    data?.serverContent?.outputTranscription?.finished;
            }
        } else if (this.endOfTurn) {
            this.data = "END OF TURN";
            this.type = "END_OF_TURN";
        } else if (this.interrupt) {
            this.data = "INTERRUPT";
            this.type = "INTERRUPT";
        }
    }
}

class GeminiLiveAPI {
    constructor(proxyUrl, controlUrl, frUrl) {
        this.proxyUrl = proxyUrl;
        this.controlUrl = controlUrl;
        this.frUrl = frUrl;

        this.sessionId = crypto.randomUUID();
        this.projectId = null;
        this.model = null;

        this.environment = null;

        this.responseModalities = ["AUDIO"];
        this.systemInstructions = "";

        this.apiHost = null;

        this.onReceiveResponse = (message) => {
            console.log("Default message received callback", message);
        };

        this.onConnectionStarted = () => {
            console.log("Default onConnectionStarted");
        };

        this.onErrorMessage = (message) => {
            alert(message);
        };

        this.websocket = null;
        this.location = null;

        this.enableInputTranscript = false;
        this.enableOutputTranscript = false;
        this.voiceName = "";
        this.voiceLocale = "";
        this.enableSessionResumption = false;
        this.customVoiceSample = "";
        this.resumptionHandle = "";
        this.disableDetection = false;
        this.disableInterruption = false;
        this.startSensitivity = "";
        this.endSensitivity = "";
        this.enableProactiveVideo = false;
        this.enableS2ST = false;
        this.s2stTargetLanguage = "";
        this.functionCallDefinition = null;

        console.log("Created Gemini Live API object: ", this);
    }

    setLocation(location) {
        this.location = location;
        this.setApiHost(this.environment);
    }
    setProjectId(projectId) {
        this.projectId = projectId;
    }
    setModel(model) {
        this.model = model;
    }

    setApiHost(environment) {
        this.environment = environment;
        if (this.environment === "autopush") {
            this.apiHost = `${this.location}-autopush-aiplatform.sandbox.googleapis.com`;
        } else if (this.environment === "staging") {
            this.apiHost = `${this.location}-staging-aiplatform.sandbox.googleapis.com`;
        } else if (this.environment === "prod") {
            this.apiHost = `${this.location}-aiplatform.googleapis.com`;
        } else {
            console.error(
                `Unknown environment: ${this.environment}. Using production API host.`
            );
            this.apiHost = `${this.location}-aiplatform.googleapis.com`; // Default to production
        }
    }

    setTranscript(input, output) {
        console.log("input transcript: ", input, "output transcript: ", output);
        this.enableInputTranscript = input;
        this.enableOutputTranscript = output;
    }

    setVoice(name, locale) {
        this.voiceName = name;
        this.voiceLocale = locale;
    }

    setFunctionCall(fcDefinition) {
        this.functionCallDefinition = fcDefinition;
    }

    setCustomVoice(base64Wav) {
        this.customVoiceSample = base64Wav;
    }

    setResumption(enable, handle) {
        this.enableSessionResumption = enable;
        this.resumptionHandle = handle;
    }

    setVad(disableInterruption, disableDetection, startSen, endSen) {
        this.disableDetection = disableDetection;
        this.disableInterruption = disableInterruption;
        this.startSensitivity = startSen;
        this.endSensitivity = endSen;
    }

    setProactiveVideo(enable) {
        this.enableProactiveVideo = enable;
    }

    setS2ST(enable, language) {
        console.log(`Setting S2ST to: ${enable}, Target Language: ${language}`);
        this.enableS2ST = enable;
        this.s2stTargetLanguage = language;
    }

    connect() {
        console.log("connect(): Triggering initBackendService...");
        this.initBackendService()
            .then(() => {
                console.log(
                    "connect(): initBackendService successful. Triggering setupFuncDeclarationToService..."
                );
                return this.setupFuncDeclarationToService();
            })
            .then(() => {
                console.log(
                    "connect(): setupFuncDeclarationToService successful. Triggering setupWebSocketToService."
                );
                this.setupWebSocketToService();
            })
            .catch((error) =>
                console.error("connect(): Promise chain failed.", error)
            );
    }

    initBackendService() {
        const postRequestBody = {
            command: "connect",
            session_id: this.sessionId,
            host: this.apiHost,
        };
        return this.sendPostRequest(this.controlUrl, postRequestBody)
            .then((response) => {
                if (response) {
                    if (response.project_id && response.location) {
                        this.setProjectId(response.project_id);
                        this.setLocation(response.location);
                    }
                }
            })
            .catch((error) => {
                console.error("Error in initBackendService:", error);
                this.onErrorMessage("Error initializing backend service.");
                throw error; // Re-throw the error to stop the promise chain
            });
    }

    setupFuncDeclarationToService() {
        if (this.functionCallDefinition) {
            const funcDeclarationMessage = {
                objective: "fc_definition",
                session_id: this.sessionId,
                functionDefinition: this.functionCallDefinition,
            };
            return this.sendPostRequest(
                this.frUrl,
                funcDeclarationMessage
            ).catch((error) => {
                console.error("Error in setupFuncDeclarationToService:", error);
                this.onErrorMessage("Error setting up function declaration.");
                // Re-throw the error to stop the promise chain
                throw error;
            });
        }
        // If there's no function definition, return a resolved promise so .then() can still be used.
        return Promise.resolve();
    }

    disconnect() {
        this.webSocket.close();

        const postRequestBody = {
            command: "disconnect",
            session_id: this.sessionId,
        };
        return this.sendPostRequest(this.controlUrl, postRequestBody).catch(
            (error) => {
                console.error("Error in cancelling backend services:", error);
                this.onErrorMessage("Error cancelling backend services.");
            }
        );
    }

    sendMessage(message) {
        this.webSocket.send(JSON.stringify(message));
    }

    onReceiveMessage(messageEvent) {
        console.log("Message received: ", messageEvent);
        const messageData = JSON.parse(messageEvent.data);
        const message = new GeminiLiveResponseMessage(messageData);
        console.log("onReceiveMessageCallBack this ", this);
        this.onReceiveResponse(message);
    }

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
    }

    sendInitialSetupMessages() {
        console.log("start setting up");
        console.log("Setting up voice sample:" + this.customVoiceSample);

        const modelUri = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${this.model}`;
        const sessionSetupMessage = {
            setup: {
                model: modelUri,
                realtime_input_config: {},
                explicit_vad_signal: true,
                generation_config: {
                    response_modalities: this.responseModalities,
                    speech_config: {
                        voice_config: this.customVoiceSample
                            ? {
                                  replicated_voice_config: {
                                      voice_sample_audio:
                                          this.customVoiceSample,
                                      mime_type: "audio/pcm;rate=24000",
                                  },
                              }
                            : {
                                  prebuilt_voice_config: {
                                      voice_name: this.voiceName,
                                  },
                              },
                        language_code: this.voiceLocale,
                    },
                },
            },
        };
        if (this.functionCallDefinition) {
            sessionSetupMessage.setup.tools = [
                { functionDeclarations: this.functionCallDefinition },
            ];
        }
        console.log(sessionSetupMessage);

        if (this.systemInstructions && this.systemInstructions.trim()) {
            sessionSetupMessage.setup.system_instruction = {
                parts: [{ text: this.systemInstructions }],
            };
        }

        if (this.enableInputTranscript) {
            sessionSetupMessage.setup.input_audio_transcription = {};
        }
        if (this.enableOutputTranscript) {
            sessionSetupMessage.setup.output_audio_transcription = {};
        }
        if (this.enableSessionResumption) {
            sessionSetupMessage.setup.session_resumption = {
                handle: this.resumptionHandle,
            };
        }

        sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection =
            {};
        if (this.disableDetection) {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.disabled = true;
        }
        if (this.disableInterruption) {
            sessionSetupMessage.setup.realtime_input_config.activity_handling = 2;
        }

        if (this.startSensitivity === "") {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.start_of_speech_sensitivity = 0;
        } else if (this.startSensitivity === "low") {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.start_of_speech_sensitivity = 2;
        } else if (this.startSensitivity === "high") {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.start_of_speech_sensitivity = 1;
        }

        if (this.endSensitivity === "") {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.end_of_speech_sensitivity = 0;
        } else if (this.endSensitivity === "low") {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.end_of_speech_sensitivity = 2;
        } else if (this.endSensitivity === "high") {
            sessionSetupMessage.setup.realtime_input_config.automatic_activity_detection.end_of_speech_sensitivity = 1;
        }

        if (this.enableProactiveVideo) {
            sessionSetupMessage.setup.proactivity = {
                proactive_video: true,
            };
        }

        if (this.enableS2ST) {
            sessionSetupMessage.setup.enable_speech_to_speech_translation = true;
            sessionSetupMessage.setup.generation_config.speech_config.language_code =
                this.s2stTargetLanguage;
        }

        console.log("setup message: " + sessionSetupMessage);
        this.sendMessage(sessionSetupMessage);
    }

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

    sendVoiceActivityMessage(start) {
        if (start) {
            const startMessage = {
                realtime_input: {
                    activity_start: {},
                },
            };
            this.sendMessage(startMessage);
        } else {
            const endMessage = {
                realtime_input: {
                    activity_end: {},
                },
            };
            this.sendMessage(endMessage);
        }
    }

    sendRealtimeInputMessage(data, mime_type) {
        const message = {
            realtime_input: {
                media_chunks: [
                    {
                        mime_type: mime_type,
                        data: data,
                    },
                ],
            },
        };
        this.sendMessage(message);
    }

    sendAudioMessage(base64PCM) {
        this.sendRealtimeInputMessage(base64PCM, "audio/pcm");
    }

    sendImageMessage(base64Image, mime_type = "image/jpeg") {
        this.sendRealtimeInputMessage(base64Image, mime_type);
    }

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

            const received_data = await response.json();
            console.log("Received data:", received_data);
            return received_data;
        } catch (error) {
            console.error("Error sending POST request:", error);
            this.onErrorMessage(`Error sending POST request: ${error.message}`);
            throw error; // Re-throw the error to reject the promise
        }
    }
}

console.log("loaded gemini-live-api.js");
