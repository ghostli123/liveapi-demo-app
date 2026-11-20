class LiveAudioOutputManager {
    constructor() {
        this.audioContext = null;
        this.workletNode = null;
        this.ready = null; // Promise for the worklet; see initializeAudioContext().
    }

    /**
     * Queues a chunk of base64 16-bit little-endian 24 kHz PCM for playback.
     * Chunks play in the order this is called.
     */
    playAudioChunk(base64AudioChunk) {
        let float32Data;
        try {
            const arrayBuffer =
                LiveAudioOutputManager.base64ToArrayBuffer(base64AudioChunk);
            float32Data = LiveAudioOutputManager.convertPCM16LEToFloat32(arrayBuffer);
        } catch (error) {
            console.error("Error decoding audio chunk:", error);
            return;
        }
        this.initializeAudioContext()
            .then(() => {
                this.workletNode.port.postMessage(float32Data, [float32Data.buffer]);
            })
            .catch((error) => console.error("Error playing audio chunk:", error));
        this.resume();
    }

    /** Drops audio that hasn't played yet, e.g. when the model is interrupted. */
    clear() {
        // Through the same promise as playAudioChunk(), so chunks queued
        // before this call are posted (and dropped) before the clear.
        if (this.ready) {
            this.ready
                .then(() => this.workletNode.port.postMessage("clear"))
                .catch(() => {}); // The worklet failed to load; nothing to clear.
        }
    }

    /**
     * Resumes playback if the browser suspended the context. Call from a user
     * gesture (e.g. the Connect click) so autoplay rules allow it.
     */
    resume() {
        this.initializeAudioContext();
        if (this.audioContext.state === "suspended") {
            this.audioContext.resume().catch((error) => {
                console.warn("Could not resume audio playback:", error);
            });
        }
    }

    /**
     * Creates the audio context and worklet once; later calls return the same
     * promise, so concurrent chunks can't create a second context.
     */
    initializeAudioContext() {
        if (!this.ready) {
            this.audioContext = new (window.AudioContext ||
                window.webkitAudioContext)({ sampleRate: 24000 });
            this.ready = this.audioContext.audioWorklet
                .addModule("/frontend/pcm-processor.js")
                .then(() => {
                    this.workletNode = new AudioWorkletNode(
                        this.audioContext,
                        "pcm-processor",
                        { outputChannelCount: [1] }
                    );
                    this.workletNode.connect(this.audioContext.destination);
                });
        }
        return this.ready;
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
        this.generation = 0;

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
        this.intervalMs = parseInt(interval, 10) || 1000;
        this.disconnectMicrophone();
        await this.connectMicrophone();
    }

    async connectMicrophone() {
        // disconnectMicrophone() bumps this, abandoning a connect still in flight.
        const generation = ++this.generation;
        const audioContext = new AudioContext({
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

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            await audioContext.audioWorklet.addModule("/frontend/input-processor.js");
        } catch (error) {
            if (stream) stream.getTracks().forEach((track) => track.stop());
            audioContext.close();
            throw error;
        }
        if (generation !== this.generation) {
            stream.getTracks().forEach((track) => track.stop());
            audioContext.close();
            return;
        }
        this.audioContext = audioContext;
        this.stream = stream;
        const source = this.audioContext.createMediaStreamSource(this.stream);

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
        this.onNewAudioRecordingChunk(b64AudioData);
    }

    recordChunk() {
        if (this.pcmData.length === 0) return;
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
        this.generation++;
        try {
            if (this.stream) {
                this.stream.getTracks().forEach((track) => {
                    track.stop();
                });
            }
            if (this.processor) {
                this.processor.disconnect();
            }
            if (this.audioContext && this.audioContext.state !== "closed") {
                this.audioContext.close();
            }
        } catch (error) {
            console.error("Error disconnecting microphone", error);
        }
        this.stream = null;
        this.processor = null;
        this.audioContext = null;
        this.pcmData = [];

        clearInterval(this.interval);
        this.interval = null;
    }

    async updateMicrophoneDevice(deviceId) {
        this.deviceId = deviceId;
        this.disconnectMicrophone();
        await this.connectMicrophone();
    }
}

/** Reports a microphone stream's loudness (0-1) about 60 times a second. */
class MicLevelMeter {
    constructor(onLevel) {
        this.onLevel = onLevel;
        this.context = null;
        this.frame = null;
    }

    start(stream) {
        this.stop();
        if (!stream) return;
        this.context = new AudioContext();
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 512;
        this.context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const tick = () => {
            analyser.getFloatTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) sum += sample * sample;
            // Map -60..0 dBFS to 0..1: perceived loudness is logarithmic,
            // and a linear scale pins loud microphones at the top.
            const dbfs = 10 * Math.log10(sum / samples.length + 1e-12);
            this.onLevel(Math.min(1, Math.max(0, (dbfs + 60) / 60)));
            this.frame = requestAnimationFrame(tick);
        };
        tick();
    }

    stop() {
        cancelAnimationFrame(this.frame);
        this.frame = null;
        if (this.context) {
            this.context.close();
            this.context = null;
        }
        this.onLevel(0);
    }
}

// Frames sent over WebSocket are scaled so their longer side is at most this.
// Gemini downsamples larger images anyway, so full-resolution frames only
// cost bandwidth.
const MAX_FRAME_DIMENSION = 1024;
const FRAME_JPEG_QUALITY = 0.8;

/**
 * Base class for a local video source (camera or screen) that previews into a
 * <video> element and, in WebSocket mode, sends periodic JPEG frames.
 */
class LiveFrameSource {
    constructor(previewVideoElement, previewCanvasElement) {
        this.previewVideoElement = previewVideoElement;
        this.previewCanvasElement = previewCanvasElement;
        this.ctx = this.previewCanvasElement.getContext("2d");
        this.stream = null;
        this.interval = null;
        this.intervalMs = 5000;
        this.onNewFrame = () => {};
    }

    /** Shows `stream` in the preview and, if asked, starts sending frames. */
    _attach(stream, sendFrames) {
        this.stream = stream;
        this.previewVideoElement.srcObject = stream;
        if (sendFrames) {
            this.interval = setInterval(() => this.newFrame(), this.intervalMs);
        }
    }

    _detach() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (!this.stream) return;
        this.stream.getTracks().forEach((track) => track.stop());
        if (this.previewVideoElement.srcObject === this.stream) {
            this.previewVideoElement.srcObject = null;
        }
        this.stream = null;
    }

    /** @returns {string} A base64 JPEG of the current frame, or "" if none. */
    captureFrameB64() {
        const video = this.previewVideoElement;
        if (!this.stream || !video.videoWidth || !video.videoHeight) return "";

        const scale = Math.min(
            1,
            MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight)
        );
        this.previewCanvasElement.width = Math.round(video.videoWidth * scale);
        this.previewCanvasElement.height = Math.round(video.videoHeight * scale);
        this.ctx.drawImage(
            video,
            0,
            0,
            this.previewCanvasElement.width,
            this.previewCanvasElement.height
        );
        return this.previewCanvasElement
            .toDataURL("image/jpeg", FRAME_JPEG_QUALITY)
            .split(",")[1];
    }

    newFrame() {
        const frameData = this.captureFrameB64();
        if (frameData) {
            this.onNewFrame(frameData);
        }
    }
}

class LiveVideoManager extends LiveFrameSource {
    constructor(previewVideoElement, previewCanvasElement) {
        super(previewVideoElement, previewCanvasElement);
        this.deviceId = null;
        this.generation = 0;
    }

    /**
     * Opens the camera. Throws if the camera can't be opened.
     * @param {{sendFrames?: boolean}} [options] - sendFrames: send JPEG frames
     *     every intervalMs (WebSocket mode).
     */
    async startWebcam({ sendFrames = true } = {}) {
        if (this.stream) {
            return; // Already started
        }
        const generation = ++this.generation;
        const stream = await navigator.mediaDevices.getUserMedia({
            video: this.deviceId ? { deviceId: { exact: this.deviceId } } : true,
        });
        if (generation !== this.generation) {
            // stopWebcam() was called while waiting for the camera.
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        this._attach(stream, sendFrames);
    }

    stopWebcam() {
        this.generation++;
        this._detach();
    }
}

class LiveScreenManager extends LiveFrameSource {
    /**
     * Asks the user for a screen to share. Throws if they cancel.
     * @param {{sendFrames?: boolean}} [options] - See LiveVideoManager.startWebcam.
     */
    async startCapture({ sendFrames = true } = {}) {
        const stream = await navigator.mediaDevices.getDisplayMedia();
        this.stopCapture();
        this._attach(stream, sendFrames);
        // The browser's own "Stop sharing" button ends the track.
        stream.getVideoTracks().forEach((track) =>
            track.addEventListener("ended", () => {
                if (this.stream === stream) this.stopCapture();
            })
        );
    }

    stopCapture() {
        this._detach();
    }
}

// Seconds of already-played avatar video kept in the MSE buffer. Older data is
// removed so a long session doesn't fill the buffer quota (~1 MB/s of video).
const VIDEO_BACK_BUFFER_S = 10;
// When playback starts this far behind the newest video, skip to the newest.
const VIDEO_MAX_LAG_S = 2;

/** Plays the avatar's fragmented-MP4 stream (WebSocket mode) through MSE. */
class LiveVideoOutputManager {
    constructor() {
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.objectUrl = null;
        this.chunkQueue = [];
        this.initialized = false;
        this.codec = 'video/mp4; codecs="avc1.42c020, mp4a.40.2"';
        // Received video is kept for download only when this is set, since it
        // grows by about 1 MB per second.
        this.recordingEnabled = false;
        this.recordedChunks = [];
        this.finishedRecordings = [];
        this.videoListenersAttached = false;
        // Called when the browser refuses to start playback without a click.
        this.onAutoplayBlocked = () => {};
    }

    /** Starts a new stream. Each connection sends its own MP4 init segment. */
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
        if (!MediaSourceClass.isTypeSupported(this.codec)) {
            console.error('Unsupported MIME type or codec:', this.codec);
            return;
        }

        // Chunks of the previous stream can't be appended to the new one, and
        // can't share a file with it either.
        this.finishRecording();
        this.chunkQueue = [];
        this.sourceBuffer = null;
        this.initialized = false;
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
        }

        const mediaSource = new MediaSourceClass();
        this.mediaSource = mediaSource;
        mediaSource.addEventListener('sourceopen', () => {
            if (this.mediaSource !== mediaSource) return;
            try {
                this.sourceBuffer = mediaSource.addSourceBuffer(this.codec);
                this.sourceBuffer.addEventListener('updateend', () => this.processQueue());
                this.initialized = true;
                this.processQueue();
            } catch (e) {
                console.error("Error adding source buffer:", e);
            }
        });
        mediaSource.addEventListener('error', e => console.error('MediaSource error', e));

        this.objectUrl = URL.createObjectURL(mediaSource);
        video.style.display = "block";
        video.src = this.objectUrl;
        this.attachVideoListeners(video);
        video.play().catch((err) => {
            if (err.name === "NotAllowedError") this.onAutoplayBlocked();
        });
    }

    attachVideoListeners(video) {
        if (this.videoListenersAttached) return;
        this.videoListenersAttached = true;

        video.addEventListener('waiting', () => {
            const downloadSpeedElement = document.getElementById('download-speed');
            const downloadKBps = downloadSpeedElement ? Number(downloadSpeedElement.textContent) || 0 : 0;
            const bitrate = downloadKBps * 1024 * 8 * 0.5;
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

        // After a pause (or blocked autoplay) the playhead is behind the
        // stream; jump to the live edge instead of playing stale video.
        video.addEventListener('play', () => {
            if (!this.sourceBuffer || video.srcObject) return;
            const buffered = this.sourceBuffer.buffered;
            if (buffered.length === 0) return;
            const liveEdge = buffered.end(buffered.length - 1);
            if (liveEdge - video.currentTime > VIDEO_MAX_LAG_S) {
                video.currentTime = liveEdge - 0.3;
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
        if (this.recordingEnabled) {
            this.recordedChunks.push(arrayBuffer);
        }
        this.processQueue();
    }

    /**
     * Removes played video older than keepSeconds before the playhead.
     * @returns {boolean} Whether a removal started (wait for updateend).
     */
    trimBuffer(keepSeconds) {
        const video = document.getElementById("video_player");
        const buffered = this.sourceBuffer.buffered;
        if (!video || buffered.length === 0) return false;
        const removeEnd = video.currentTime - keepSeconds;
        if (removeEnd <= buffered.start(0)) return false;
        try {
            this.sourceBuffer.remove(buffered.start(0), removeEnd);
            return true;
        } catch (e) {
            console.warn("Error trimming video buffer:", e);
            return false;
        }
    }

    processQueue() {
        if (!this.initialized || !this.sourceBuffer) return;
        if (this.sourceBuffer.updating) return;
        if (this.mediaSource.readyState !== "open") return;

        // Trim in batches of VIDEO_BACK_BUFFER_S rather than on every append.
        if (this.trimBufferIfLarge()) return;

        if (this.chunkQueue.length > 0) {
            const chunk = this.chunkQueue.shift();
            try {
                this.sourceBuffer.appendBuffer(chunk);
            } catch (e) {
                if (e.name === "QuotaExceededError") {
                    // Make room and retry the same chunk on updateend.
                    this.chunkQueue.unshift(chunk);
                    if (!this.trimBuffer(1)) {
                        console.error("Video buffer full and nothing to trim; dropping chunk.");
                        this.chunkQueue.shift();
                    }
                } else {
                    console.error("Error appending buffer:", e);
                }
            }
        }
    }

    trimBufferIfLarge() {
        const video = document.getElementById("video_player");
        const buffered = this.sourceBuffer.buffered;
        if (!video || buffered.length === 0) return false;
        if (video.currentTime - buffered.start(0) < 2 * VIDEO_BACK_BUFFER_S) return false;
        return this.trimBuffer(VIDEO_BACK_BUFFER_S);
    }

    /** Closes the current stream's recording; each stream is its own MP4. */
    finishRecording() {
        if (this.recordedChunks.length > 0) {
            this.finishedRecordings.push(new Blob(this.recordedChunks, { type: "video/mp4" }));
            this.recordedChunks = [];
        }
    }

    /** @returns {Blob[]} One MP4 per stream received since the last clear. */
    getRecordings() {
        this.finishRecording();
        return this.finishedRecordings;
    }

    clearRecordedChunks() {
        this.recordedChunks = [];
        this.finishedRecordings = [];
    }

    resetPlayer() {
        if (this.mediaSource && this.mediaSource.readyState === "open") {
            try {
                // endOfStream() throws while an append is in progress.
                if (this.sourceBuffer && this.sourceBuffer.updating) {
                    this.sourceBuffer.abort();
                }
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
        this.clearRecordedChunks();
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

// How long a WebRTC session may take to connect after the SDP answer.
const WEBRTC_CONNECT_TIMEOUT_MS = 15000;

class G3RtcWebRtcManager {
    constructor(videoPlayerElement) {
        this.videoPlayerElement = videoPlayerElement;
        this.pc = null;
        this.dataChannel = null;
        this.audioSender = null;
        this.videoSender = null;
        this.remoteStream = null;
        this.micStream = null;
        this.videoTrack = null;
        this.statsInterval = null;
        // Called when the peer connection fails, e.g. UDP is blocked.
        this.onConnectionFailed = () => {};
        // Called when the browser refuses to start playback without a click.
        this.onAutoplayBlocked = () => {};
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
        // Session resumption renegotiates; keep sending the same mic and camera.
        this.close({ keepLocalMedia: true });

        this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        const pc = this.pc;
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log("[WebRTC] connectionState:", state);
            if (this.pc !== pc) return; // A newer session replaced this one.
            const stateEl = document.getElementById("webrtc-state");
            if (stateEl) {
                stateEl.textContent = state;
            }
            if (state === "failed") {
                this.onConnectionFailed();
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

        const micTrack = this.micStream && this.micStream.getAudioTracks()[0];
        if (micTrack && micTrack.readyState === "live") {
            await this.audioSender.replaceTrack(micTrack);
        }
        if (this.videoTrack && this.videoTrack.readyState === "live") {
            await this.videoSender.replaceTrack(this.videoTrack);
        }

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
                if (err.name === "NotAllowedError") this.onAutoplayBlocked();
            });
        }
        this.startStatsPolling();

        // If no candidate pair works, the connection can sit in "connecting"
        // without ever reaching "failed", so give up after a timeout.
        const pc = this.pc;
        clearTimeout(this.connectTimer);
        this.connectTimer = setTimeout(() => {
            if (this.pc === pc && pc.connectionState !== "connected") {
                console.warn("[WebRTC] Not connected after", WEBRTC_CONNECT_TIMEOUT_MS, "ms");
                this.onConnectionFailed();
            }
        }, WEBRTC_CONNECT_TIMEOUT_MS);
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
        if (!stream) return;
        // Remembered so a renegotiated session (resumption) keeps sending it.
        this.videoTrack = stream.getVideoTracks()[0] || null;
        if (this.videoSender) {
            await this.videoSender.replaceTrack(this.videoTrack);
        }
    }

    detachVideoStream() {
        this.videoTrack = null;
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

    /**
     * Closes the peer connection.
     * @param {{keepLocalMedia?: boolean}} [options] - keepLocalMedia: keep the
     *     microphone and camera tracks for the next initiateSession().
     */
    close({ keepLocalMedia = false } = {}) {
        this.stopStatsPolling();
        clearTimeout(this.connectTimer);
        if (!keepLocalMedia) {
            this.stopMicrophone();
            this.detachVideoStream();
        }
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

