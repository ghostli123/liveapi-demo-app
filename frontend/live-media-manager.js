class LiveAudioOutputManager {
    constructor() {
        this.audioInputContext;
        this.workletNode;
        this.initialized = false;

        this.audioQueue = [];
        this.isPlaying = false;

        this.initializeAudioContext();
    }

    async playAudioChunk(base64AudioChunk) {
        try {
            if (!this.initialized) {
                await this.initializeAudioContext();
            }

            if (this.audioInputContext.state === "suspended") {
                await this.audioInputContext.resume();
            }

            const arrayBuffer =
                LiveAudioOutputManager.base64ToArrayBuffer(base64AudioChunk);
            const float32Data =
                LiveAudioOutputManager.convertPCM16LEToFloat32(arrayBuffer);

            this.workletNode.port.postMessage(float32Data);
        } catch (error) {
            console.error("Error processing audio chunk:", error);
        }
    }

    async initializeAudioContext() {
        if (this.initialized) return;

        console.log("initializeAudioContext...");

        this.audioInputContext = new (window.AudioContext ||
            window.webkitAudioContext)({ sampleRate: 24000 });
        await this.audioInputContext.audioWorklet.addModule("frontend/pcm-processor.js");;
        this.workletNode = new AudioWorkletNode(
            this.audioInputContext,
            "pcm-processor"
        );
        this.workletNode.connect(this.audioInputContext.destination);

        this.initialized = true;
        console.log("initializeAudioContext end");
    }

    static base64ToArrayBuffer(base64) {
        const binaryString = window.atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    static convertPCM16LEToFloat32(pcmData) {
        const inputArray = new Int16Array(pcmData);
        const float32Array = new Float32Array(inputArray.length);
        for (let i = 0; i < inputArray.length; i++) {
            float32Array[i] = inputArray[i] / 32768;
        }
        return float32Array;
    }
}

class LiveAudioInputManager {
    constructor() {
        this.audioContext;
        this.mediaRecorder;
        this.processor = null;
        this.pcmData = [];

        this.deviceId = null;

        this.interval = null;
        this.stream = null;
        this.intervalMs = 1000;

        this.onNewAudioRecordingChunk = (audioData) => {
            console.log("New audio recording ");
        };
    }

    // Update the audio interval in milliseconds (based on user input)
    async updateAudioInterval(interval) {
        this.intervalMs = parseInt(interval, 10);
        this.disconnectMicrophone();
        this.connectMicrophone();
    }

    async connectMicrophone() {
        this.audioContext = new AudioContext({
            sampleRate: 16000,
        });

        let constraints = {
            audio: {
                channelCount: 1,
                sampleRate: 16000,
            },
        };

        if (this.deviceId) {
            constraints.audio.deviceId = { exact: this.deviceId };
        }

        this.stream = await navigator.mediaDevices.getUserMedia(constraints);

        const source = this.audioContext.createMediaStreamSource(this.stream);
        await this.audioContext.audioWorklet.addModule("frontend/input-processor.js");;

        // Create an AudioWorkletNode.
        this.processor = new AudioWorkletNode(
            this.audioContext,
            "input-processor"
        );

        // Listen for messages (the PCM data) from the worklet.
        this.processor.port.onmessage = (event) => {
            this.pcmData.push(...event.data);
        };

        // Connect the microphone source to the worklet.
        source.connect(this.processor);

        this.interval = setInterval(
            this.recordChunk.bind(this),
            this.intervalMs
        );
    }

    newAudioRecording(b64AudioData) {
        console.log("newAudioRecording ");
        this.onNewAudioRecordingChunk(b64AudioData);
    }

    recordChunk() {
        const buffer = new ArrayBuffer(this.pcmData.length * 2);
        const view = new DataView(buffer);
        this.pcmData.forEach((value, index) => {
            view.setInt16(index * 2, value, true);
        });

        const uint8Array = new Uint8Array(buffer);
        let binaryString = "";
        const chunkSize = 8192; // Process in 8KB chunks
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, chunk);
        }

        const base64 = btoa(binaryString);
        this.newAudioRecording(base64);
        this.pcmData = [];
    }

    disconnectMicrophone() {
        try {
            if (this.stream) {
                this.stream.getTracks().forEach((track) => {
                    track.stop();
                });
            }
            if (this.processor) {
                this.processor.disconnect();
            }
            if (this.audioContext) {
                this.audioContext.close();
            }
            console.log("Microphone disconnected successfully.");
        } catch {
            console.error("Error disconnecting microphone");
        }

        clearInterval(this.interval);
    }

    async updateMicrophoneDevice(deviceId) {
        this.deviceId = deviceId;
        this.disconnectMicrophone();
        await this.connectMicrophone();
    }
}

class LiveVideoManager {
    constructor(previewVideoElement, previewCanvasElement) {
        this.previewVideoElement = previewVideoElement;
        this.previewCanvasElement = previewCanvasElement;
        this.ctx = this.previewCanvasElement.getContext("2d");
        this.stream = null;
        this.interval = null;
        this.deviceId = null;
        this.intervalMs = 5000; // Default interval in milliseconds
        this.onNewFrame = (newFrame) => {
            console.log("Default new frame trigger.");
        };
    }

    async updateVideoInterval(interval) {
        this.intervalMs = parseInt(interval, 10);
        this.stopWebcam();
        this.startWebcam();
    }

    async startWebcam() {
        if (this.stream) {
            return; // Already started
        }
        try {
            const constraints = {
                video: {
                    deviceId: this.deviceId
                        ? { exact: this.deviceId }
                        : undefined,
                },
                // video: {
                //     width: { max: 640 },
                //     height: { max: 480 },
                // },
            };
            this.stream = await navigator.mediaDevices.getUserMedia(
                constraints
            );
            this.previewVideoElement.srcObject = this.stream;
            this.interval = setInterval(() => {
                this.newFrame();
            }, this.intervalMs);
        } catch (err) {
            console.error("Error accessing the webcam: ", err);
        }
    }

    stopWebcam() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.stream) {
            this.stopStream();
            this.stream = null;
        }
    }

    stopStream() {
        if (!this.stream) return;

        const tracks = this.stream.getTracks();

        tracks.forEach((track) => {
            track.stop();
        });
    }

    async updateWebcamDevice(deviceId) {
        this.deviceId = deviceId;
        this.stopWebcam();
        await this.startWebcam();
        // const constraints = {
        //     video: { deviceId: { exact: deviceId } },
        // };
        // this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        // this.previewVideoElement.srcObject = this.stream;
    }

    captureFrameB64() {
        if (this.stream == null) return "";

        this.previewCanvasElement.width = this.previewVideoElement.videoWidth;
        this.previewCanvasElement.height = this.previewVideoElement.videoHeight;
        this.ctx.drawImage(
            this.previewVideoElement,
            0,
            0,
            this.previewCanvasElement.width,
            this.previewCanvasElement.height
        );
        const imageData = this.previewCanvasElement
            .toDataURL("image/jpeg")
            .split(",")[1]
            .trim();
        return imageData;
    }

    newFrame() {
        console.log("capturing new frame");
        const frameData = this.captureFrameB64();
        this.onNewFrame(frameData);
    }
}

class LiveScreenManager {
    constructor(previewVideoElement, previewCanvasElement) {
        this.previewVideoElement = previewVideoElement;
        this.previewCanvasElement = previewCanvasElement;
        this.ctx = this.previewCanvasElement.getContext("2d");
        this.stream = null;
        this.interval = null;
        this.intervalMs = 5000; // Default interval in milliseconds
        this.onNewFrame = (newFrame) => {
            console.log("Default new frame trigger: ", newFrame);
        };
    }

    updateVideoInterval(interval) {
        this.intervalMs = parseInt(interval, 10);
        this.stopCapture();
        this.startCapture();
    }

    async startCapture() {
        if (this.interval) {
            clearInterval(this.interval);
        }

        try {
            console.log("Starting screen capture...");
            this.stream = await navigator.mediaDevices.getDisplayMedia();
            this.previewVideoElement.srcObject = this.stream;

            this.interval = setInterval(
                this.newFrame.bind(this),
                this.intervalMs
            );
        } catch (err) {
            console.error("Error accessing the webcam: ", err);
        }
    }

    stopCapture() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        if (!this.stream) return;

        const tracks = this.stream.getTracks();

        tracks.forEach((track) => {
            track.stop();
        });

        this.previewVideoElement.srcObject = null;
        this.stream = null;
    }

    captureFrameB64() {
        if (this.stream == null) return "";

        this.previewCanvasElement.width = this.previewVideoElement.videoWidth;
        this.previewCanvasElement.height = this.previewVideoElement.videoHeight;
        this.ctx.drawImage(
            this.previewVideoElement,
            0,
            0,
            this.previewCanvasElement.width,
            this.previewCanvasElement.height
        );
        const imageData = this.previewCanvasElement
            .toDataURL("image/jpeg")
            .split(",")[1]
            .trim();
        return imageData;
    }

    newFrame() {
        console.log("capturing new frame");
        const frameData = this.captureFrameB64();
        this.onNewFrame(frameData);
    }
}

class LiveVideoOutputManager {
    constructor() {
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.chunkQueue = [];
        this.initialized = false;
        this.codec = 'video/mp4; codecs="avc1.42c020, mp4a.40.2"';
        this.recordedChunks = [];
    }

    initMediaSource() {
        const video = document.getElementById('video_player');
        if (!video) {
            console.error("video_player element not found for LiveVideoOutputManager");
            return;
        }

        const MediaSourceClass = window.ManagedMediaSource || window.MediaSource;
        if (!MediaSourceClass) {
            console.error('MediaSource API not supported in this browser');
            return;
        }

        const isMMS = !!window.ManagedMediaSource;
        console.log(`Using ${isMMS ? 'ManagedMediaSource' : 'MediaSource'} interface`);

        if (MediaSourceClass.isTypeSupported(this.codec)) {
            this.mediaSource = new MediaSourceClass();
            video.src = URL.createObjectURL(this.mediaSource);

            this.mediaSource.addEventListener('sourceopen', () => {
                console.log('MediaSource opened');
                try {
                    this.sourceBuffer = this.mediaSource.addSourceBuffer(this.codec);
                    this.sourceBuffer.addEventListener('updateend', () => {
                        this.processQueue();
                    });
                    this.initialized = true;
                    this.processQueue();
                } catch (e) {
                    console.error("Error adding source buffer:", e);
                }
            });

            this.mediaSource.addEventListener('sourceclose', () => console.log('MediaSource closed'));
            this.mediaSource.addEventListener('error', e => console.error('MediaSource error', e));
        } else {
            console.error('Unsupported MIME type or codec:', this.codec);
        }

        video.addEventListener('waiting', () => {
            let downloadSpeed = 0;
            let uploadSpeed = 0;
            const uploadSpeedElement = document.getElementById('upload-speed');
            const downloadSpeedElement = document.getElementById('download-speed');
            if (uploadSpeedElement) {
                uploadSpeed = uploadSpeedElement.textContent;
            }
            if (downloadSpeedElement) {
                downloadSpeed = downloadSpeedElement.textContent;
            }

            const bitrate = downloadSpeed * 1024 * 8 * 0.5;
            const recommendedBitrateElement = document.getElementById('recommended-video-bitrate');
            if (recommendedBitrateElement) {
                recommendedBitrateElement.textContent = bitrate.toFixed(2);
            }
        });

        video.addEventListener('playing', () => {
            const recommendedBitrateElement = document.getElementById('recommended-video-bitrate');
            if (recommendedBitrateElement) {
                recommendedBitrateElement.textContent = "0";
            }
        });
    }

    playVideoChunk(base64Chunk, mimeType = "") {
        if (
            mimeType === "video/jpeg2000" ||
            mimeType === "video/jpeg" ||
            mimeType.startsWith("image/")
        ) {
            let imgEl = document.getElementById("avatar_frame_img");
            const video = document.getElementById("video_player");
            if (!imgEl && video && video.parentElement) {
                imgEl = document.createElement("img");
                imgEl.id = "avatar_frame_img";
                imgEl.style.width = "100%";
                imgEl.style.height = "100%";
                imgEl.style.objectFit = "contain";
                video.parentElement.appendChild(imgEl);
            }
            if (video) {
                video.style.display = "none";
            }
            if (imgEl) {
                imgEl.style.display = "block";
                imgEl.src = `data:image/jpeg;base64,${base64Chunk}`;
            }
            return;
        }
        const arrayBuffer = LiveVideoOutputManager.base64ToArrayBuffer(base64Chunk);
        this.chunkQueue.push(arrayBuffer);
        this.recordedChunks.push(arrayBuffer);
        this.processQueue();
    }

    processQueue() {
        if (!this.initialized || !this.sourceBuffer) return;
        if (this.sourceBuffer.updating) return;

        if (this.chunkQueue.length > 0) {
            const chunk = this.chunkQueue.shift();
            try {
                this.sourceBuffer.appendBuffer(chunk);
            } catch (e) {
                console.error("Error appending buffer:", e);
            }
        }
    }

    getRecordedBlob() {
        return new Blob(this.recordedChunks, { type: "video/mp4" });
    }

    clearRecordedChunks() {
        this.recordedChunks = [];
    }

    resetPlayer() {
        if (this.mediaSource && this.mediaSource.readyState === "open") {
            try {
                this.mediaSource.endOfStream();
            } catch (e) {
                console.warn("resetPlayer endOfStream warning:", e);
            }
        }
        const imgEl = document.getElementById("avatar_frame_img");
        if (imgEl) {
            imgEl.style.display = "none";
            imgEl.src = "";
        }
        const video = document.getElementById("video_player");
        if (video) {
            video.style.display = "block";
        }
        this.chunkQueue = [];
        this.recordedChunks = [];
        this.sourceBuffer = null;
        this.mediaSource = null;
        this.initialized = false;
    }

    static base64ToArrayBuffer(base64) {
        const binaryString = window.atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

class G3RtcWebRtcManager {
    constructor(videoPlayerElement) {
        this.videoPlayerElement = videoPlayerElement;
        this.pc = null;
        this.dataChannel = null;
        this.audioSender = null;
        this.videoSender = null;
        this.remoteStream = null;
        this.micStream = null;
        this.statsInterval = null;
        this.lastBytesReceived = 0;
        this.lastBytesSent = 0;
        this.lastStatsTimeMs = 0;
    }

    static applyG3rtcAttributesToSdp(sdp, midToGroupId) {
        const lines = sdp.split("\r\n");
        const resultLines = [];
        for (const line of lines) {
            resultLines.push(line);
            if (line.startsWith("a=mid:")) {
                const mid = line.substring(6).trim();
                const groupId = midToGroupId.get(mid);
                if (groupId) {
                    resultLines.push(`a=g3rtc-attrs group-id:${groupId}`);
                }
            }
        }
        return resultLines.join("\r\n");
    }

    async initiateSession({ wantsVideo = true } = {}) {
        this.close();

        this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        this.pc.onconnectionstatechange = () => {
            const state = this.pc ? this.pc.connectionState : "closed";
            console.log("[WebRTC] connectionState:", state);
            const stateEl = document.getElementById("webrtc-state");
            if (stateEl) {
                stateEl.textContent = state;
            }
        };

        this.dataChannel = this.pc.createDataChannel("g3rtc-media-stats");

        const transceiverToGroupId = new Map();
        const sendStreamGroupId = crypto.randomUUID();

        const sendAudioTransceiver = this.pc.addTransceiver("audio", {
            direction: "sendonly",
        });
        this.audioSender = sendAudioTransceiver.sender;
        transceiverToGroupId.set(sendAudioTransceiver, sendStreamGroupId);

        const sendVideoTransceiver = this.pc.addTransceiver("video", {
            direction: "sendonly",
        });
        this.videoSender = sendVideoTransceiver.sender;
        transceiverToGroupId.set(sendVideoTransceiver, sendStreamGroupId);

        this.remoteStream = new MediaStream();
        const recvGroupId = this.remoteStream.id || crypto.randomUUID();

        const recvAudioTransceiver = this.pc.addTransceiver("audio", {
            direction: "recvonly",
        });
        this.remoteStream.addTrack(recvAudioTransceiver.receiver.track);
        transceiverToGroupId.set(recvAudioTransceiver, recvGroupId);

        if (wantsVideo) {
            const recvVideoTransceiver = this.pc.addTransceiver("video", {
                direction: "recvonly",
            });
            this.remoteStream.addTrack(recvVideoTransceiver.receiver.track);
            transceiverToGroupId.set(recvVideoTransceiver, recvGroupId);
        }

        await this.pc.setLocalDescription();
        await this.waitForIceGathering(3000);
        await this.pc.setLocalDescription();

        const midToGroupId = new Map();
        for (const [transceiver, groupId] of transceiverToGroupId.entries()) {
            if (transceiver.mid) {
                midToGroupId.set(transceiver.mid, groupId);
            }
        }

        const rawSdp = this.pc.localDescription ? this.pc.localDescription.sdp : "";
        return G3RtcWebRtcManager.applyG3rtcAttributesToSdp(rawSdp, midToGroupId);
    }

    waitForIceGathering(timeoutMs = 3000) {
        if (!this.pc || this.pc.iceGatheringState === "complete") {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.pc) {
                    this.pc.removeEventListener("icegatheringstatechange", checkState);
                }
                resolve();
            }, timeoutMs);
            const checkState = () => {
                if (!this.pc || this.pc.iceGatheringState === "complete") {
                    clearTimeout(timer);
                    if (this.pc) {
                        this.pc.removeEventListener("icegatheringstatechange", checkState);
                    }
                    resolve();
                }
            };
            this.pc.addEventListener("icegatheringstatechange", checkState);
        });
    }

    async completeSession(answerSdp) {
        if (!this.pc) {
            throw new Error("RTCPeerConnection is not initialized");
        }
        await this.pc.setRemoteDescription({
            type: "answer",
            sdp: answerSdp,
        });

        const videoEl =
            this.videoPlayerElement || document.getElementById("video_player");
        if (videoEl && this.remoteStream) {
            videoEl.src = "";
            videoEl.srcObject = this.remoteStream;
            videoEl.muted = false;
            videoEl.play().catch((err) => {
                console.warn("[WebRTC] Auto-play warning on video_player:", err);
            });
        }
        this.startStatsPolling();
    }

    async startMicrophone(deviceId = null) {
        this.stopMicrophone();
        const audioConstraints = {
            channelCount: 1,
            sampleRate: 16000,
        };
        if (deviceId) {
            audioConstraints.deviceId = { exact: deviceId };
        }
        this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
        });
        const audioTrack = this.micStream.getAudioTracks()[0] || null;
        if (this.audioSender && audioTrack) {
            await this.audioSender.replaceTrack(audioTrack);
        }
    }

    stopMicrophone() {
        if (this.micStream) {
            this.micStream.getTracks().forEach((t) => t.stop());
            this.micStream = null;
        }
        if (this.audioSender) {
            this.audioSender.replaceTrack(null).catch(() => {});
        }
    }

    async attachVideoStream(stream) {
        if (!this.videoSender || !stream) return;
        const videoTrack = stream.getVideoTracks()[0] || null;
        await this.videoSender.replaceTrack(videoTrack);
    }

    detachVideoStream() {
        if (this.videoSender) {
            this.videoSender.replaceTrack(null).catch(() => {});
        }
    }

    startStatsPolling() {
        this.stopStatsPolling();
        this.lastBytesReceived = 0;
        this.lastBytesSent = 0;
        this.lastStatsTimeMs = performance.now();

        this.statsInterval = setInterval(async () => {
            if (!this.pc) return;
            try {
                const stats = await this.pc.getStats();
                let bytesReceived = 0;
                let bytesSent = 0;
                let packetsLost = 0;
                let framesPerSecond = null;

                stats.forEach((report) => {
                    if (report.type === "inbound-rtp") {
                        bytesReceived += report.bytesReceived || 0;
                        packetsLost += report.packetsLost || 0;
                        if (
                            report.kind === "video" &&
                            typeof report.framesPerSecond === "number"
                        ) {
                            framesPerSecond = report.framesPerSecond;
                        }
                    } else if (report.type === "outbound-rtp") {
                        bytesSent += report.bytesSent || 0;
                    }
                });

                const nowMs = performance.now();
                const elapsedSec = Math.max(0.001, (nowMs - this.lastStatsTimeMs) / 1000);
                const downKbps =
                    Math.max(0, bytesReceived - this.lastBytesReceived) /
                    1024 /
                    elapsedSec;
                const upKbps =
                    Math.max(0, bytesSent - this.lastBytesSent) / 1024 / elapsedSec;

                this.lastBytesReceived = bytesReceived;
                this.lastBytesSent = bytesSent;
                this.lastStatsTimeMs = nowMs;

                const downEl = document.getElementById("download-speed");
                const upEl = document.getElementById("upload-speed");
                const fpsEl = document.getElementById("webrtc-fps");
                const lossEl = document.getElementById("webrtc-packet-loss");

                if (downEl) downEl.textContent = downKbps.toFixed(2);
                if (upEl) upEl.textContent = upKbps.toFixed(2);
                if (fpsEl) {
                    fpsEl.textContent =
                        framesPerSecond !== null ? framesPerSecond.toFixed(1) : "--";
                }
                if (lossEl) lossEl.textContent = String(packetsLost);
            } catch (err) {
                console.warn("[WebRTC] stats polling error:", err);
            }
        }, 2000);
    }

    stopStatsPolling() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }

    close() {
        this.stopStatsPolling();
        this.stopMicrophone();
        this.detachVideoStream();
        if (this.dataChannel) {
            try {
                this.dataChannel.close();
            } catch (e) {}
            this.dataChannel = null;
        }
        if (this.pc) {
            try {
                this.pc.close();
            } catch (e) {}
            this.pc = null;
        }
        this.audioSender = null;
        this.videoSender = null;
        this.remoteStream = null;
        const videoEl =
            this.videoPlayerElement || document.getElementById("video_player");
        if (videoEl && videoEl.srcObject) {
            videoEl.srcObject = null;
        }
        const stateEl = document.getElementById("webrtc-state");
        if (stateEl) {
            stateEl.textContent = "closed";
        }
    }
}

console.log("loaded live-media-manager.js");

