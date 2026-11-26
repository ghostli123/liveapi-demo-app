// @ts-check
/* global randomId -- from gemini-live-api.js (see index.html) */
/* exported LiveAudioOutputManager, LiveAudioInputManager, MicLevelMeter, LiveVideoManager,
   LiveScreenManager, LiveVideoOutputManager, G3RtcWebRtcManager, parseIntervalMs,
   AUDIO_INTERVAL_MS, VIDEO_INTERVAL_MS */

// A playback worklet crash this long after the player started is treated as a
// new problem: the wait before rebuilding starts over at 1 s.
const PLAYER_CRASH_RESET_MS = 60000;

class LiveAudioOutputManager {
    constructor() {
        this.audioContext = null;
        this.workletNode = null;
        /** @type {Promise<AudioWorkletNode> | null} */
        this.ready = null; // Resolves to workletNode; see initializeAudioContext().
        this.generation = 0; // Invalidates an in-flight addModule() when resume() restarts it.
        // After a failed start: the rejection returned until retryAt (a
        // performance.now() time), and the current wait between retries.
        /** @type {Promise<AudioWorkletNode> | null} */
        this.failed = null;
        this.retryAt = 0;
        this.retryDelayMs = 0;
        // The wait after the worklet crashes, doubling per crash until the
        // next Connect or a crash long after the last start; see
        // processorFailed(). startedAt is the performance.now() time the current
        // worklet node was created.
        this.crashDelayMs = 0;
        this.startedAt = 0;
        this.crashReported = false;
        // Called with a message for the user the first time after a Connect
        // that the player crashes or a chunk is dropped because it couldn't
        // start; see reportFailure().
        /** @type {(message: string) => void} */
        this.onPlayerError = () => {};
    }

    /**
     * Queues a chunk of base64 16-bit little-endian 24 kHz PCM for playback.
     * Chunks play in the order this is called.
     */
    playAudioChunk(base64AudioChunk) {
        if (typeof base64AudioChunk !== "string") return;
        let float32Data;
        try {
            const arrayBuffer =
                LiveAudioOutputManager.base64ToArrayBuffer(base64AudioChunk);
            float32Data = LiveAudioOutputManager.convertPCM16LEToFloat32(arrayBuffer);
        } catch (error) {
            console.error("Error decoding audio chunk:", error);
            return;
        }
        const ready = this.initializeAudioContext();
        const generation = this.generation;
        const audioContext = this.audioContext;
        ready
            .then(
                (workletNode) => {
                    if (this.generation !== generation || audioContext?.state === "closed") return;
                    workletNode.port.postMessage(float32Data, [float32Data.buffer]);
                },
                // Logged once per attempt by initializeAudioContext(); the
                // chunk is dropped. Reported here rather than there because
                // WebRTC sessions also start this player (on Connect) but
                // get their audio from the peer connection.
                () => {
                    if (this.generation !== generation) return;
                    this.reportFailure();
                }
            )
            .catch((error) => console.error("Error playing audio chunk:", error));
        this.resumeContext();
    }

    /** Drops audio that hasn't played yet, e.g. when the model is interrupted. */
    clear() {
        // Through the same promise as playAudioChunk(), so chunks queued
        // before this call are posted (and dropped) before the clear.
        if (this.ready && this.audioContext?.state !== "closed") {
            const generation = this.generation;
            const audioContext = this.audioContext;
            this.ready
                .then((workletNode) => {
                    if (this.generation !== generation || audioContext?.state === "closed") return;
                    workletNode.port.postMessage("clear");
                })
                .catch(() => {}); // The worklet failed to load; nothing to clear.
        }
    }

    /**
     * Stops playback and closes the audio context so the browser can release
     * the output device between sessions. Also invalidates any in-flight
     * worklet load or queued chunks so they can't start or report errors after
     * Disconnect.
     */
    close() {
        this.generation++;
        const workletNode = this.workletNode;
        const audioContext = this.audioContext;
        this.workletNode = null;
        this.audioContext = null;
        this.ready = null;
        this.failed = null;
        this.retryAt = 0;
        this.retryDelayMs = 0;
        this.crashDelayMs = 0;
        this.startedAt = 0;
        this.crashReported = false;
        if (workletNode) {
            workletNode.onprocessorerror = null;
            if (audioContext && audioContext.state !== "closed") {
                try {
                    workletNode.port.postMessage("clear");
                } catch {
                    // Best effort; the context is closing below.
                }
            }
            if (typeof workletNode.disconnect === "function") {
                try {
                    workletNode.disconnect();
                } catch (error) {
                    console.error("Error disconnecting audio output node:", error);
                }
            }
        }
        this._closeAudioContext(audioContext);
    }

    /** @param {AudioContext | null} audioContext */
    _closeAudioContext(audioContext) {
        if (!audioContext || audioContext.state === "closed") return;
        try {
            audioContext.close()?.catch(() => {});
        } catch (error) {
            console.error("Error closing audio output context:", error);
        }
    }

    /**
     * Resumes playback if the browser suspended the context. Call from a user
     * gesture (e.g. the Connect click) so autoplay rules allow it.
     */
    resume() {
        // A new Connect retries a player that failed to start right away, and
        // abandons an in-flight worklet load or externally closed context from
        // a prior connection so it starts cleanly.
        if (this.audioContext?.state === "closed" || (this.ready && !this.workletNode)) {
            this.close();
        } else {
            this.failed = null;
            this.retryDelayMs = 0;
            this.crashDelayMs = 0;
            this.crashReported = false;
        }
        this.resumeContext();
    }

    resumeContext() {
        // Failures are logged where they happen; Connect goes on without sound.
        this.initializeAudioContext().catch(() => {});
        if (this.audioContext?.state === "suspended") {
            try {
                this.audioContext.resume()?.catch((error) => {
                    console.warn("Could not resume audio playback:", error);
                });
            } catch (error) {
                console.warn("Could not resume audio playback:", error);
            }
        }
    }

    /**
     * Creates the audio context and worklet once; later calls return the same
     * promise, so concurrent chunks can't create a second context. If the
     * worklet fails to load (e.g. during a deploy), or the browser refuses
     * the context, calls return that rejection for a while (1 s, doubling to
     * 30 s), so a response's chunks don't each build a context and refetch
     * the worklet; the first call after that, or a resume(), starts over.
     */
    initializeAudioContext() {
        if (this.audioContext?.state === "closed") {
            this.close();
        }
        if (this.ready) return this.ready;
        if (this.failed && performance.now() < this.retryAt) return this.failed;
        const generation = this.generation;
        let audioContext;
        try {
            audioContext = new (window.AudioContext ||
                window.webkitAudioContext)({ sampleRate: 24000 });
        } catch (error) {
            // E.g. no audio device, an unsupported sample rate, or a browser
            // without Web Audio. Callers get a rejection rather than a throw,
            // so Connect still opens the session.
            console.error("Could not create the audio player:", error);
            const failed = Promise.reject(error);
            failed.catch(() => {});
            this.backOff(failed);
            return failed;
        }
        // Browsers leave out audioWorklet on insecure pages (plain http from
        // another machine); reject like a failed load rather than throw.
        let loaded;
        try {
            loaded = audioContext.audioWorklet
                ? Promise.resolve(audioContext.audioWorklet.addModule("/frontend/pcm-processor.js"))
                : Promise.reject(new Error("AudioWorklet is unavailable: the page needs HTTPS or localhost"));
        } catch (error) {
            console.error("Could not load the audio player:", error);
            this._closeAudioContext(audioContext);
            const failed = Promise.reject(error);
            failed.catch(() => {});
            this.backOff(failed);
            return failed;
        }
        const ready = loaded.then(() => {
            if (this.generation !== generation) {
                this._closeAudioContext(audioContext);
                throw new Error("Audio player initialization superseded");
            }
            if (audioContext.state === "closed") {
                this.generation++;
                this.audioContext = null;
                this.ready = null;
                throw new Error("Audio context closed during initialization");
            }
            const workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
                outputChannelCount: [1],
            });
            workletNode.onprocessorerror = (event) => this.processorFailed(workletNode, event);
            workletNode.connect(audioContext.destination);
            this.workletNode = workletNode;
            this.startedAt = performance.now();
            this.failed = null;
            this.retryDelayMs = 0;
            return workletNode;
        });
        ready.catch((error) => {
            if (this.generation !== generation) {
                this._closeAudioContext(audioContext);
                return;
            }
            console.error("Could not load the audio player:", error);
            // Chrome and Firefox remember a failed module fetch per
            // context and reject a retry without fetching, so the next
            // attempt needs a new context.
            this.audioContext = null;
            this.ready = null;
            this.backOff(ready);
            this._closeAudioContext(audioContext);
        });
        this.audioContext = audioContext;
        this.ready = ready;
        return ready;
    }

    /**
     * The worklet threw (in its constructor or process()), so the browser
     * stopped it and the node plays nothing from now on. Drops the context so
     * a later chunk builds a new one, after 1 s, doubling to 30 s across
     * crashes (so a worklet that throws on every chunk isn't rebuilt per
     * chunk), and reports the first crash since Connect. A player that ran
     * for PLAYER_CRASH_RESET_MS before crashing waits 1 s again, so a few
     * crashes spread over a long session don't each mute it for 30 s.
     * @param {AudioWorkletNode} workletNode
     * @param {Event} event
     */
    processorFailed(workletNode, event) {
        if (this.workletNode !== workletNode) return; // Already replaced.
        console.error("The audio player stopped:", event);
        this.generation++;
        const audioContext = this.audioContext;
        this.audioContext = null;
        this.ready = null;
        this.workletNode = null;
        this._closeAudioContext(audioContext);
        if (performance.now() - this.startedAt >= PLAYER_CRASH_RESET_MS) this.crashDelayMs = 0;
        this.crashDelayMs = Math.min(30000, this.crashDelayMs * 2 || 1000);
        const failed = Promise.reject(new Error("The audio player stopped"));
        failed.catch(() => {});
        this.failed = failed;
        this.retryAt = performance.now() + this.crashDelayMs;
        this.reportFailure("The audio player stopped, so some of the model's speech wasn't played.");
    }

    /**
     * Tells the user, once per Connect, that the player crashed or couldn't
     * start (e.g. its worklet failed to load during a deploy), so the model's
     * speech is being dropped while its transcript goes on.
     */
    reportFailure(reason = "The audio player couldn't start, so the model's speech isn't playing.") {
        if (this.crashReported) return;
        this.crashReported = true;
        this.onPlayerError(`${reason} It restarts on its own; if the model stays silent, disconnect and connect again.`);
    }

    /** @param {Promise<AudioWorkletNode>} failed */
    backOff(failed) {
        this.retryDelayMs = Math.min(30000, this.retryDelayMs * 2 || 1000);
        this.retryAt = performance.now() + this.retryDelayMs;
        this.failed = failed;
    }

    static base64ToArrayBuffer(base64) {
        if (typeof base64 !== "string") {
            throw new TypeError("Base64 data must be a string");
        }
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

/**
 * Calls `listener(track)` when one of `tracks` ends without the app stopping
 * it: a device unplugged, access revoked, or the browser's own "Stop" button.
 * MediaStreamTrack.stop() doesn't fire "ended", so turning a source off
 * doesn't reach the listener.
 * @param {MediaStreamTrack[]} tracks
 * @param {(track: MediaStreamTrack) => void} listener
 */
function onTrackEnded(tracks, listener) {
    for (const track of tracks) {
        track.addEventListener("ended", () => listener(track));
    }
}

// How often WebSocket mode sends buffered microphone audio and camera or
// screen frames, in ms. Below the minimums the app sends a frame per audio
// render quantum or a 1024 px JPEG every few ms; above the audio maximum the
// model hears the user late.
const AUDIO_INTERVAL_MS = { min: 20, max: 1000, fallback: 200 };
const VIDEO_INTERVAL_MS = { min: 100, max: 60000, fallback: 400 };
// The WebSocket microphone's capture rate, in samples per second.
const MIC_SAMPLE_RATE = 16000;

/**
 * Parses an interval typed in the settings. Blank, non-numeric, zero and
 * negative values give `fallback`; others are rounded into [min, max].
 * @param {unknown} value
 * @param {{min: number, max: number, fallback: number}} limits
 * @returns {number}
 */
function parseIntervalMs(value, { min, max, fallback }) {
    let ms;
    if (typeof value === "number") {
        ms = value;
    } else if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return fallback;
        ms = Number(trimmed);
    } else {
        return fallback;
    }
    if (!Number.isFinite(ms) || ms <= 0) return fallback;
    return Math.min(max, Math.max(min, Math.round(ms)));
}

class LiveAudioInputManager {
    constructor() {
        this.audioContext = null;
        this.processor = null;
        this.pcmData = [];
        this.generation = 0;

        this.deviceId = null;

        this.interval = null;
        this.stream = null;
        this.intervalMs = 1000;

        /** @type {(b64AudioData: string) => void} */
        this.onNewAudioRecordingChunk = () => {
            console.log("New audio recording ");
        };
        // Called when the microphone stops on its own (unplugged, access revoked).
        this.onMicrophoneEnded = () => {};
        // Called when the capture worklet throws and stops sending audio.
        this.onMicrophoneFailed = () => {};
    }

    // Update the audio interval in milliseconds (based on user input)
    async updateAudioInterval(interval) {
        this.intervalMs = parseIntervalMs(interval, AUDIO_INTERVAL_MS);
        this.disconnectMicrophone();
        await this.connectMicrophone();
    }

    async connectMicrophone() {
        // Release any active mic/interval and bump generation to abandon a
        // connect still in flight.
        this.disconnectMicrophone();
        const generation = this.generation;
        const audioContext = new AudioContext({
            sampleRate: MIC_SAMPLE_RATE,
        });
        // Held before getUserMedia() so disconnectMicrophone() while the
        // permission prompt is open closes it right away.
        this.audioContext = audioContext;

        let constraints = {
            audio: {
                channelCount: 1,
                sampleRate: MIC_SAMPLE_RATE,
            },
        };

        if (this.deviceId) {
            constraints.audio.deviceId = { exact: this.deviceId };
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
            if (this.audioContext === audioContext) this.audioContext = null;
            this._closeAudioContext(audioContext);
            // A refusal for a connect that was superseded while the prompt was
            // open isn't reported: the caller would turn off the newer mic.
            if (generation !== this.generation) return;
            throw error;
        }
        if (generation !== this.generation) {
            stream.getTracks().forEach((track) => track.stop());
            if (this.audioContext === audioContext) this.audioContext = null;
            this._closeAudioContext(audioContext);
            return;
        }
        // Held before the worklet module loads, so a disconnectMicrophone()
        // during the load releases the mic at once, not when the load ends.
        this.stream = stream;
        try {
            await audioContext.audioWorklet.addModule("/frontend/input-processor.js");
        } catch (error) {
            // Superseded: disconnectMicrophone() already released both, and
            // the fields may hold a newer connect's stream.
            if (generation !== this.generation) return;
            this.disconnectMicrophone();
            throw error;
        }
        if (generation !== this.generation) return;
        try {
            const source = this.audioContext.createMediaStreamSource(this.stream);

            // Force mono downmix at the node input: input-processor.js reads only
            // channel 0, so a stereo mic whose left channel is silent would send
            // silence under the default channelCountMode ("max").
            const processor = new AudioWorkletNode(this.audioContext, "input-processor", {
                channelCount: 1,
                channelCountMode: "explicit",
            });
            this.processor = processor;
            // A worklet that throws is stopped by the browser and sends nothing
            // more, with the mic still on.
            processor.onprocessorerror = (event) => {
                if (this.processor !== processor) return;
                console.error("The microphone's audio processor stopped:", event);
                this.onMicrophoneFailed();
            };

            // Listen for messages (the PCM data) from the worklet. These keep
            // arriving in a hidden tab, where the browser throttles the timer below
            // (Chrome: to once a second, once a minute after 5 minutes hidden), so
            // audio the timer hasn't sent within two intervals is sent from here.
            this.processor.port.onmessage = (event) => {
                this.pcmData.push(...event.data);
                if (this.pcmData.length >= (2 * this.intervalMs * MIC_SAMPLE_RATE) / 1000) this.recordChunk();
            };

            // Connect the microphone source to the worklet.
            source.connect(this.processor);
        } catch (error) {
            this.disconnectMicrophone();
            throw error;
        }

        onTrackEnded(stream.getAudioTracks(), () => {
            if (this.stream === stream) this.onMicrophoneEnded();
        });

        this.interval = setInterval(
            this.recordChunk.bind(this),
            this.intervalMs
        );

        // A track that ended while the worklet module loaded fired "ended"
        // before the listener above existed; report it like a later unplug.
        if (stream.getAudioTracks().some((track) => track.readyState === "ended")) {
            this.onMicrophoneEnded();
        }
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
            binaryString += String.fromCharCode(...chunk);
        }

        const base64 = btoa(binaryString);
        this.pcmData = [];
        this.newAudioRecording(base64);
    }

    /** @param {AudioContext | null} audioContext */
    _closeAudioContext(audioContext) {
        if (!audioContext || audioContext.state === "closed") return;
        try {
            audioContext.close()?.catch(() => {});
        } catch (error) {
            console.error("Error closing microphone audio context", error);
        }
    }

    disconnectMicrophone() {
        this.generation++;
        const stream = this.stream;
        const processor = this.processor;
        const audioContext = this.audioContext;
        this.stream = null;
        this.processor = null;
        this.audioContext = null;
        this.pcmData = [];

        clearInterval(this.interval);
        this.interval = null;

        if (stream) {
            try {
                for (const track of stream.getTracks()) {
                    try {
                        track.stop();
                    } catch (error) {
                        console.error("Error stopping microphone track", error);
                    }
                }
            } catch (error) {
                console.error("Error disconnecting microphone stream", error);
            }
        }
        if (processor) {
            // Messages the worklet posted before this are still queued; without
            // a handler they don't land in the next connection's pcmData.
            if (processor.port) processor.port.onmessage = null;
            try {
                processor.disconnect();
            } catch (error) {
                console.error("Error disconnecting microphone processor", error);
            }
        }
        this._closeAudioContext(audioContext);
    }
}

/** Reports a microphone stream's loudness (0-1) about 60 times a second. */
class MicLevelMeter {
    constructor(onLevel) {
        this.onLevel = onLevel;
        this.context = null;
        this.frame = null;
        this.stopping = false;
        this.generation = 0;
    }

    /** Throws if the browser refuses the audio context or the stream; nothing is left running then. */
    start(stream) {
        const generation = ++this.generation;
        this.stop();
        if (!stream || this.generation !== generation) return;
        try {
            this.context = new (window.AudioContext || window.webkitAudioContext)();
            // Created after awaiting getUserMedia, i.e. possibly without a user
            // gesture, so it can start suspended (always in Safari).
            if (this.context.state === "suspended") {
                this.context.resume()?.catch(() => {});
            }
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 512;
            this.context.createMediaStreamSource(stream).connect(analyser);
            const context = this.context;
            const samples = new Float32Array(analyser.fftSize);
            const tick = () => {
                if (this.context !== context) return;
                analyser.getFloatTimeDomainData(samples);
                let sum = 0;
                for (const sample of samples) sum += sample * sample;
                // Map -60..0 dBFS to 0..1: perceived loudness is logarithmic,
                // and a linear scale pins loud microphones at the top.
                const dbfs = 10 * Math.log10(sum / samples.length + 1e-12);
                this.onLevel(Math.min(1, Math.max(0, (dbfs + 60) / 60)));
                if (this.context === context) {
                    this.frame = requestAnimationFrame(tick);
                }
            };
            tick();
        } catch (error) {
            if (this.generation === generation) {
                try {
                    this.stop();
                } catch {
                    // Keep the original start() error if onLevel(0) also throws.
                }
            }
            throw error;
        }
    }

    stop() {
        cancelAnimationFrame(this.frame);
        this.frame = null;
        if (this.context) {
            const context = this.context;
            this.context = null;
            if (context.state !== "closed") {
                try {
                    context.close()?.catch(() => {});
                } catch {
                    // Best effort; the meter is already stopped.
                }
            }
        }
        if (this.stopping) return;
        this.stopping = true;
        try {
            this.onLevel(0);
        } finally {
            this.stopping = false;
        }
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
        /** @type {(b64JpegData: string) => void} */
        this.onNewFrame = () => {};
        /**
         * Called after the source stopped on its own (camera unplugged, access
         * revoked, the browser's "Stop sharing") and was detached.
         * @type {(track: MediaStreamTrack) => void}
         */
        this.onEnded = () => {};
    }

    /** Shows `stream` in the preview and, if asked, starts sending frames. */
    _attach(stream, sendFrames) {
        this.stream = stream;
        this.previewVideoElement.srcObject = stream;
        if (sendFrames) {
            this.startSendingFrames();
        }
        onTrackEnded(stream.getVideoTracks(), (track) => {
            if (this.stream !== stream) return; // Already replaced or stopped.
            this._detach();
            this.onEnded(track);
        });
    }

    /**
     * Sends JPEG frames every intervalMs from the running source, e.g. one
     * started for WebRTC when media moves to the WebSocket. No-op if stopped.
     */
    startSendingFrames() {
        if (this.stream && !this.interval) {
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
     * Opens the camera. Throws if the camera can't be opened, unless
     * stopWebcam() ran while waiting for it.
     * @param {{sendFrames?: boolean}} [options] - sendFrames: send JPEG frames
     *     every intervalMs (WebSocket mode).
     */
    async startWebcam({ sendFrames = true } = {}) {
        if (this.stream) {
            return; // Already started
        }
        const generation = ++this.generation;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: this.deviceId ? { deviceId: { exact: this.deviceId } } : true,
            });
        } catch (error) {
            // Abandoned (e.g. by a device change); the caller would stop the newer camera.
            if (generation !== this.generation) return;
            throw error;
        }
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
    constructor(previewVideoElement, previewCanvasElement) {
        super(previewVideoElement, previewCanvasElement);
        this.generation = 0;
    }

    /**
     * Asks the user for a screen to share. Throws if they cancel.
     * @param {{sendFrames?: boolean}} [options] - See LiveVideoManager.startWebcam.
     * @returns {Promise<boolean>} False if stopCapture() or a newer
     *     startCapture() ran while the picker was open; the pick, or the
     *     picker's failure, is dropped.
     */
    async startCapture({ sendFrames = true } = {}) {
        const generation = ++this.generation;
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia();
        } catch (error) {
            if (generation !== this.generation) return false;
            throw error;
        }
        if (generation !== this.generation) {
            // The session ended (or the camera took over) during the picker.
            stream.getTracks().forEach((track) => track.stop());
            return false;
        }
        this._detach(); // A share already running is replaced.
        this._attach(stream, sendFrames);
        return true;
    }

    stopCapture() {
        this.generation++; // Abandons a startCapture() still in the picker.
        this._detach();
    }
}

// Seconds of already-played avatar video kept in the MSE buffer. Older data is
// removed so a long session doesn't fill the buffer quota (~1 MB/s of video).
const VIDEO_BACK_BUFFER_S = 10;
// When playback starts this far behind the newest video, skip to the newest.
const VIDEO_MAX_LAG_S = 2;
const VIDEO_UNSUPPORTED_MESSAGE =
    "This browser can't play the avatar video over the WebSocket transport. " +
    "Audio and transcripts still work; try the WebRTC transport or another browser.";
const VIDEO_STOPPED_MESSAGE =
    "The avatar video stopped after a playback error. Audio and transcripts still work; " +
    "reconnect to restart the video.";
// "Save avatar video" keeps the video in memory until Disconnect, about 1 MB
// per second even while the avatar is idle, so it stops at this size (about
// 8-10 minutes) rather than let a long session run the tab out of memory.
const MAX_RECORDED_VIDEO_BYTES = 512 * 1024 * 1024;
// Cap pending MP4 chunks waiting for sourceopen or a busy SourceBuffer (~16 s
// at ~1 MB/s) so a stalled player can't grow tab memory without bound.
const MAX_QUEUED_VIDEO_BYTES = 16 * 1024 * 1024;

/**
 * Extracts a non-empty human-readable description from a caught error or
 * rejection value without throwing on null, symbols, or null-prototype objects.
 * @param {*} error
 * @returns {string}
 */
function formatMediaError(error) {
    if (error && typeof error === "object") {
        try {
            if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
            if (typeof error.name === "string" && error.name.trim()) return error.name.trim();
        } catch {
            // E.g. an error object with a throwing getter.
        }
    }
    if (error !== null && error !== undefined) {
        try {
            const text = String(error).trim();
            if (text && text !== "[object Object]") return text;
        } catch {
            // E.g. Object.create(null) or a throwing toString().
        }
    }
    return "unknown error";
}

/** @returns {HTMLVideoElement | null} The avatar's <video>, shared by both transports. */
function getAvatarVideoElement() {
    return /** @type {HTMLVideoElement | null} */ (document.getElementById("video_player"));
}

/** @returns {HTMLImageElement | null} Shows avatar JPEG frames (WebSocket mode). */
function getAvatarFrameElement() {
    return /** @type {HTMLImageElement | null} */ (document.getElementById("avatar_frame_img"));
}

/** Plays the avatar's fragmented-MP4 stream (WebSocket mode) through MSE. */
class LiveVideoOutputManager {
    constructor() {
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.objectUrl = null;
        /** @type {ArrayBuffer[]} */
        this.chunkQueue = [];
        this.queuedBytes = 0;
        this.maxQueuedBytes = MAX_QUEUED_VIDEO_BYTES;
        this.initialized = false;
        this.codec = 'video/mp4; codecs="avc1.42c020, mp4a.40.2"';
        // Received video is kept for download only when this is set, since it
        // grows by about 1 MB per second.
        this.recordingEnabled = false;
        this.recordedChunks = [];
        this.finishedRecordings = [];
        // Bytes in recordedChunks and finishedRecordings, which both stay in
        // memory until clearRecordedChunks().
        this.recordedBytes = 0;
        this.maxRecordedBytes = MAX_RECORDED_VIDEO_BYTES;
        // Set once recordedBytes would pass maxRecordedBytes; later chunks
        // aren't recorded until clearRecordedChunks().
        this.recordingLimitReached = false;
        // Called once when recording stops at maxRecordedBytes, with a message
        // for the user.
        /** @type {(message: string) => void} */
        this.onRecordingLimit = () => {};
        this.videoListenersAttached = false;
        // Called when the browser refuses to start playback without a click.
        this.onAutoplayBlocked = () => {};
        // Set once the current stream can't be played; its chunks are then
        // dropped instead of queued (they arrive at about 1 MB per second).
        this.playbackFailed = false;
        // Why MSE can't play this stream, when it can't. The user is told at the
        // first MP4 chunk: audio-only and JPEG-frame streams never need MSE.
        /** @type {?string} */
        this.unplayableDetail = null;
        // Called once per stream with a message for the user when it can't be
        // played. Audio and transcripts keep working.
        /** @type {(message: string) => void} */
        this.onPlaybackError = () => {};
    }

    /** Hides and clears the JPEG avatar frame image, if one was created. */
    hideAvatarFrame() {
        const imgEl = getAvatarFrameElement();
        if (imgEl) {
            imgEl.style.display = "none";
            // Not `src = ""`, which resolves to the page URL and fires an image error event.
            imgEl.removeAttribute("src");
        }
    }

    /** Starts a new stream. Each connection sends its own MP4 init segment. */
    initMediaSource() {
        // Chunks of the previous stream can't be appended to the new one, and
        // can't share a file with it either.
        this.finishRecording();
        this.chunkQueue = [];
        this.queuedBytes = 0;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.initialized = false;
        this.playbackFailed = false;
        this.unplayableDetail = null;
        this.hideAvatarFrame();

        const video = getAvatarVideoElement();
        if (!video) {
            this.failPlayback("video_player element not found for LiveVideoOutputManager", null);
            return;
        }

        const MediaSourceClass = window.ManagedMediaSource || window.MediaSource;
        if (!MediaSourceClass || !MediaSourceClass.isTypeSupported(this.codec)) {
            this.markUnplayable(`Media Source Extensions can't play ${this.codec}`);
            return;
        }

        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
        }

        const mediaSource = new MediaSourceClass();
        this.mediaSource = mediaSource;
        mediaSource.addEventListener('sourceopen', () => {
            if (
                this.mediaSource !== mediaSource ||
                this.sourceBuffer ||
                this.playbackFailed ||
                this.unplayableDetail
            ) {
                return;
            }
            try {
                const sourceBuffer = mediaSource.addSourceBuffer(this.codec);
                this.sourceBuffer = sourceBuffer;
                sourceBuffer.addEventListener('updateend', () => {
                    if (this.sourceBuffer === sourceBuffer) this.processQueue();
                });
                this.initialized = true;
                this.processQueue();
            } catch (e) {
                this.markUnplayable(`Error adding source buffer: ${formatMediaError(e)}`);
            }
        });
        mediaSource.addEventListener('error', e => console.error('MediaSource error', e));

        this.objectUrl = URL.createObjectURL(mediaSource);
        video.style.display = "block";
        video.src = this.objectUrl;
        this.attachVideoListeners(video);
        video.play()?.catch((err) => {
            if (err?.name === "NotAllowedError") this.onAutoplayBlocked();
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
            if (!this.sourceBuffer || this.playbackFailed || video.srcObject) return;
            let buffered;
            try {
                buffered = this.sourceBuffer.buffered;
            } catch {
                // Chrome throws InvalidStateError if the SourceBuffer was
                // removed from its MediaSource before processQueue() noticed.
                return;
            }
            if (buffered.length === 0) return;
            const liveEdge = buffered.end(buffered.length - 1);
            if (liveEdge - video.currentTime > VIDEO_MAX_LAG_S) {
                video.currentTime = liveEdge - 0.3;
            }
        });
    }

    playVideoChunk(base64Chunk, mimeType = "") {
        if (typeof base64Chunk !== "string") return;
        const mime =
            typeof mimeType === "string"
                ? mimeType.split(";", 1)[0].trim().toLowerCase()
                : "";
        if (
            mime === "video/jpeg2000" ||
            mime === "video/jpeg" ||
            mime.startsWith("image/")
        ) {
            let imgEl = getAvatarFrameElement();
            const video = getAvatarVideoElement();
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
        let arrayBuffer;
        try {
            arrayBuffer = LiveVideoOutputManager.base64ToArrayBuffer(base64Chunk);
        } catch (error) {
            console.error("Error decoding video chunk:", error);
            return;
        }
        // Recording is the user's choice and doesn't need the player.
        if (this.recordingEnabled && !this.recordingLimitReached) this.recordChunk(arrayBuffer);
        if (this.playbackFailed) return;
        if (this.unplayableDetail) {
            this.failPlayback(this.unplayableDetail, VIDEO_UNSUPPORTED_MESSAGE);
            return;
        }
        if (this.queuedBytes + arrayBuffer.byteLength > this.maxQueuedBytes) {
            const detail = this.initialized
                ? `Video buffer queue exceeded ${this.maxQueuedBytes} bytes`
                : `MediaSource did not open before queued video exceeded ${this.maxQueuedBytes} bytes`;
            const userMessage = this.initialized ? VIDEO_STOPPED_MESSAGE : VIDEO_UNSUPPORTED_MESSAGE;
            this.failPlayback(detail, userMessage);
            return;
        }
        this.chunkQueue.push(arrayBuffer);
        this.queuedBytes += arrayBuffer.byteLength;
        this.processQueue();
    }

    /**
     * Records that MSE can't play the current stream. Reported at once if MP4
     * chunks are already waiting, else at the first one (see playVideoChunk).
     * @param {string} detail - Logged to the console when reported.
     */
    markUnplayable(detail) {
        this.unplayableDetail = detail;
        if (this.chunkQueue.length > 0) this.failPlayback(detail, VIDEO_UNSUPPORTED_MESSAGE);
    }

    /**
     * Gives up on playing the current stream: drops queued chunks and stops
     * queuing new ones until the next initMediaSource().
     * @param {string} detail - Logged to the console.
     * @param {?string} userMessage - Passed to onPlaybackError, if set.
     */
    failPlayback(detail, userMessage) {
        this.chunkQueue = [];
        this.queuedBytes = 0;
        if (this.playbackFailed) return;
        this.playbackFailed = true;
        console.error(detail);
        if (userMessage) this.onPlaybackError(userMessage);
    }

    /**
     * Removes played video older than keepSeconds before the playhead.
     * @returns {boolean} Whether a removal started (wait for updateend).
     */
    trimBuffer(keepSeconds) {
        const video = getAvatarVideoElement();
        const sourceBuffer = this.sourceBuffer;
        if (!video || !sourceBuffer || sourceBuffer.buffered.length === 0) return false;
        const buffered = sourceBuffer.buffered;
        const removeEnd = video.currentTime - keepSeconds;
        if (removeEnd <= buffered.start(0)) return false;
        try {
            sourceBuffer.remove(buffered.start(0), removeEnd);
            return true;
        } catch (e) {
            console.warn("Error trimming video buffer:", e);
            return false;
        }
    }

    processQueue() {
        // mediaSource is set whenever sourceBuffer is.
        if (!this.initialized || !this.sourceBuffer || !this.mediaSource) return;
        if (this.sourceBuffer.updating) return;
        // Once open, a MediaSource only leaves "open" on a playback error
        // (e.g. a decode error ends it); resetPlayer() clears it first.
        if (this.mediaSource.readyState !== "open") {
            this.failPlayback(`MediaSource is ${this.mediaSource.readyState}`, VIDEO_STOPPED_MESSAGE);
            return;
        }

        try {
            // Trim in batches of VIDEO_BACK_BUFFER_S rather than on every append.
            if (this.trimBufferIfLarge()) return;
            if (this.chunkQueue.length > 0) this.appendNextChunk(this.sourceBuffer);
        } catch (e) {
            // Besides a full buffer, the SourceBuffer only throws when it can't
            // take data any more (removed from its MediaSource, or the video
            // element has an error), so later chunks would fail the same way.
            this.failPlayback(`Error appending video: ${formatMediaError(e)}`, VIDEO_STOPPED_MESSAGE);
        }
    }

    /**
     * Appends the oldest queued chunk; a full buffer is trimmed and the chunk retried.
     * @param {SourceBuffer} sourceBuffer - this.sourceBuffer.
     */
    appendNextChunk(sourceBuffer) {
        const chunk = this.chunkQueue.shift();
        if (!chunk) return;
        this.queuedBytes = Math.max(0, this.queuedBytes - chunk.byteLength);
        try {
            sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            if (e?.name !== "QuotaExceededError") throw e;
            // Make room and retry the same chunk on updateend.
            this.chunkQueue.unshift(chunk);
            this.queuedBytes += chunk.byteLength;
            if (!this.trimBuffer(1) && !this.dropStaleBuffer()) {
                console.error("Video buffer full and nothing to trim; dropping chunk.");
                const dropped = this.chunkQueue.shift();
                if (dropped) this.queuedBytes = Math.max(0, this.queuedBytes - dropped.byteLength);
            }
        }
    }

    /**
     * Makes room when the playhead isn't moving (paused, autoplay blocked)
     * and so nothing is behind it to trim: removes all but the newest
     * VIDEO_BACK_BUFFER_S and moves the playhead to the live edge, so playback
     * resumes on live video instead of the buffer filling up for good.
     * @returns {boolean} Whether a removal started (wait for updateend).
     */
    dropStaleBuffer() {
        const video = getAvatarVideoElement();
        const sourceBuffer = this.sourceBuffer;
        if (!video || !sourceBuffer || sourceBuffer.buffered.length === 0) return false;
        const buffered = sourceBuffer.buffered;
        const liveEdge = buffered.end(buffered.length - 1);
        const removeEnd = liveEdge - VIDEO_BACK_BUFFER_S;
        if (removeEnd <= buffered.start(0)) return false;
        try {
            sourceBuffer.remove(buffered.start(0), removeEnd);
        } catch (e) {
            console.warn("Error dropping stale video:", e);
            return false;
        }
        if (video.currentTime < removeEnd) {
            video.currentTime = liveEdge - 0.3;
        }
        return true;
    }

    trimBufferIfLarge() {
        const video = getAvatarVideoElement();
        const sourceBuffer = this.sourceBuffer;
        if (!video || !sourceBuffer || sourceBuffer.buffered.length === 0) return false;
        const buffered = sourceBuffer.buffered;
        if (video.currentTime - buffered.start(0) < 2 * VIDEO_BACK_BUFFER_S) return false;
        return this.trimBuffer(VIDEO_BACK_BUFFER_S);
    }

    /**
     * Adds a chunk to the current stream's recording, or stops recording if it
     * would take the recorded video past maxRecordedBytes.
     * @param {ArrayBuffer} chunk
     */
    recordChunk(chunk) {
        if (this.recordedBytes + chunk.byteLength > this.maxRecordedBytes) {
            this.recordingLimitReached = true;
            // Ends the file like Disconnect does, between two chunks; this
            // stream's later chunks are all left out.
            this.finishRecording();
            const megabytes = Math.round(this.maxRecordedBytes / (1024 * 1024));
            this.onRecordingLimit(
                `Stopped saving the avatar video at ${megabytes} MB to keep the page from running out of ` +
                    "memory. The video so far is saved when you disconnect."
            );
            return;
        }
        this.recordedChunks.push(chunk);
        this.recordedBytes += chunk.byteLength;
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
        this.recordedBytes = 0;
        this.recordingLimitReached = false;
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
        this.hideAvatarFrame();
        const video = getAvatarVideoElement();
        if (video) {
            video.style.display = "block";
            // Ending the stream doesn't stop playback: without this, the
            // buffered tail keeps playing, sound included, after Disconnect.
            // A WebRTC stream is on srcObject, which the WebRTC manager clears.
            if (this.objectUrl && video.getAttribute("src") === this.objectUrl) {
                video.pause();
                // Not `src = ""`, which makes Firefox try to load the page as media.
                video.removeAttribute("src");
                video.load();
            }
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
        this.chunkQueue = [];
        this.queuedBytes = 0;
        this.clearRecordedChunks();
        // Derived from the ended stream's stalls; the next one starts fresh.
        const recommendedBitrateElement = document.getElementById("recommended-video-bitrate");
        if (recommendedBitrateElement) recommendedBitrateElement.textContent = "--";
        this.sourceBuffer = null;
        this.mediaSource = null;
        this.initialized = false;
        this.playbackFailed = false;
        this.unplayableDetail = null;
    }

    static base64ToArrayBuffer(base64) {
        if (typeof base64 !== "string") {
            throw new TypeError("Base64 data must be a string");
        }
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
        this.micGeneration = 0;
        // Called by close(), which closes pc and drops the senders; wakes
        // pending _replaceTrack() and waitForIceGathering() calls.
        /** @type {Set<() => void>} */
        this.onSendersDropped = new Set();
        this.videoTrack = null;
        this.videoGeneration = 0;
        this.statsInterval = null;
        /** @type {number | null} */
        this.connectTimer = null;
        this.hasConnected = false;
        this.inConnectionFailed = false;
        // Called when the peer connection fails, e.g. UDP is blocked.
        this.onConnectionFailed = () => {};
        // Called when the browser refuses to start playback without a click.
        this.onAutoplayBlocked = () => {};
        // Called when the microphone stops on its own (unplugged, access revoked).
        this.onMicrophoneEnded = () => {};
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

    /**
     * The server's answer lists candidates with an empty foundation
     * ("a=candidate: 1 udp ..."). Chrome accepts them, but Firefox drops them
     * and then has nothing to connect to. Give each one a foundation.
     * @param {string} sdp
     * @returns {string}
     */
    static fixAnswerSdp(sdp) {
        return sdp.replace(/^a=candidate: /gm, "a=candidate:0 ");
    }

    async initiateSession({ wantsVideo = true } = {}) {
        // Session resumption renegotiates; keep sending the same mic and camera.
        this.close({ keepLocalMedia: true });

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        this.pc = pc;
        // close() (e.g. Disconnect) or a newer initiateSession() may run while
        // this awaits; stop then instead of touching the newer connection.
        const ensureOpen = () => {
            if (this.pc !== pc) throw new Error("The WebRTC session was closed.");
        };

        try {
            // close() above showed "closed"; this connection is still being set up.
            G3RtcWebRtcManager.showState("negotiating");
            pc.onconnectionstatechange = () => {
                const state = pc.connectionState;
                console.log("[WebRTC] connectionState:", state);
                if (this.pc !== pc) return; // A newer session replaced this one.
                if (state === "failed") {
                    this.clearConnectTimer();
                    this._failConnection();
                    return;
                }
                G3RtcWebRtcManager.showState(state);
                if (state === "connected") {
                    this.hasConnected = true;
                    // The connect timeout only covers getting connected. A later
                    // drop shows as "disconnected", which can recover, and then
                    // "failed" if it doesn't.
                    this.clearConnectTimer();
                }
            };

            this.dataChannel = pc.createDataChannel("g3rtc-media-stats");

            const transceiverToGroupId = new Map();
            const sendStreamGroupId = randomId();

            const sendAudioTransceiver = pc.addTransceiver("audio", {
                direction: "sendonly",
            });
            this.audioSender = sendAudioTransceiver.sender;
            transceiverToGroupId.set(sendAudioTransceiver, sendStreamGroupId);

            const sendVideoTransceiver = pc.addTransceiver("video", {
                direction: "sendonly",
            });
            this.videoSender = sendVideoTransceiver.sender;
            transceiverToGroupId.set(sendVideoTransceiver, sendStreamGroupId);

            const micTrack = this.micStream && this.micStream.getAudioTracks()[0];
            if (micTrack && micTrack.readyState === "live") {
                await this._replaceTrack(sendAudioTransceiver.sender, micTrack);
                ensureOpen();
            }
            if (this.videoTrack && this.videoTrack.readyState === "live") {
                await this._replaceTrack(sendVideoTransceiver.sender, this.videoTrack);
                ensureOpen();
            }

            const remoteStream = new MediaStream();
            this.remoteStream = remoteStream;
            const recvGroupId = remoteStream.id || randomId();

            const recvAudioTransceiver = pc.addTransceiver("audio", {
                direction: "recvonly",
            });
            remoteStream.addTrack(recvAudioTransceiver.receiver.track);
            transceiverToGroupId.set(recvAudioTransceiver, recvGroupId);

            if (wantsVideo) {
                const recvVideoTransceiver = pc.addTransceiver("video", {
                    direction: "recvonly",
                });
                remoteStream.addTrack(recvVideoTransceiver.receiver.track);
                transceiverToGroupId.set(recvVideoTransceiver, recvGroupId);
            }

            await pc.setLocalDescription();
            ensureOpen();
            await this.waitForIceGathering(3000);
            ensureOpen();
            await pc.setLocalDescription();
            ensureOpen();

            const midToGroupId = new Map();
            for (const [transceiver, groupId] of transceiverToGroupId.entries()) {
                if (transceiver.mid) {
                    midToGroupId.set(transceiver.mid, groupId);
                }
            }

            const rawSdp = pc.localDescription ? pc.localDescription.sdp : "";
            return G3RtcWebRtcManager.applyG3rtcAttributesToSdp(rawSdp, midToGroupId);
        } catch (error) {
            if (this.pc === pc) {
                this.close({ keepLocalMedia: true });
            }
            throw error;
        }
    }

    waitForIceGathering(timeoutMs = 3000) {
        if (!this.pc || this.pc.iceGatheringState === "complete") {
            return Promise.resolve();
        }
        const pc = this.pc;
        return /** @type {Promise<void>} */ (new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                pc.removeEventListener("icegatheringstatechange", checkState);
                this.onSendersDropped.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            const checkState = () => {
                if (this.pc !== pc || pc.iceGatheringState === "complete") {
                    finish();
                }
            };
            pc.addEventListener("icegatheringstatechange", checkState);
            this.onSendersDropped.add(finish);
        }));
    }

    async completeSession(answerSdp) {
        const pc = this.pc;
        if (!pc) {
            throw new Error("RTCPeerConnection is not initialized");
        }
        await pc.setRemoteDescription({
            type: "answer",
            sdp: G3RtcWebRtcManager.fixAnswerSdp(answerSdp),
        });
        // close() (e.g. Disconnect) or a newer session ran meanwhile; don't
        // start polling or a connect timer for a connection that's gone.
        if (this.pc !== pc) return;

        const videoEl =
            this.videoPlayerElement || document.getElementById("video_player");
        if (videoEl && this.remoteStream) {
            // Not `src = ""`, which makes Firefox try to load the page as media.
            videoEl.removeAttribute("src");
            videoEl.srcObject = this.remoteStream;
            // Leave `muted` alone: Connect unmutes in its click (script.js),
            // and a resume renegotiates, so unmuting here would undo a mute
            // the user set from the player's controls.
            videoEl.play()?.catch((err) => {
                console.warn("[WebRTC] Auto-play warning on video_player:", err);
                if (err?.name === "NotAllowedError") this.onAutoplayBlocked();
            });
        }
        this.startStatsPolling();

        // If no candidate pair works, the connection can sit in "connecting"
        // without ever reaching "failed", so give up after a timeout. Cleared
        // once connected (see onconnectionstatechange above), and skipped if
        // the connection already connected or ended during setRemoteDescription.
        this.clearConnectTimer();
        if (
            !this.hasConnected &&
            pc.connectionState !== "connected" &&
            pc.connectionState !== "failed" &&
            pc.connectionState !== "closed"
        ) {
            this.connectTimer = setTimeout(() => {
                this.connectTimer = null;
                if (this.pc === pc && !this.hasConnected && pc.connectionState !== "connected") {
                    console.warn("[WebRTC] Not connected after", WEBRTC_CONNECT_TIMEOUT_MS, "ms");
                    this._failConnection();
                }
            }, WEBRTC_CONNECT_TIMEOUT_MS);
        }
    }

    /** @param {string | null} [deviceId] - The microphone to use; null for the default. */
    async startMicrophone(deviceId = null) {
        this.stopMicrophone();
        const generation = this.micGeneration;
        const audioConstraints = {
            channelCount: 1,
            sampleRate: 16000,
        };
        if (deviceId) {
            audioConstraints.deviceId = { exact: deviceId };
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
            });
        } catch (error) {
            // Superseded while the prompt was open (see below); reporting the
            // refusal would make the caller turn off the newer mic.
            if (generation !== this.micGeneration) return;
            throw error;
        }
        if (generation !== this.micGeneration) {
            // stopMicrophone() (mic off, Disconnect) or a newer start ran
            // while the permission prompt was open; don't send this one.
            stream.getTracks().forEach((t) => t.stop());
            return;
        }
        this.micStream = stream;
        onTrackEnded(stream.getAudioTracks(), () => {
            if (this.micStream === stream) this.onMicrophoneEnded();
        });
        // A track that ended before the listener above existed won't fire
        // "ended"; report it like a later unplug instead of sending it.
        if (stream.getAudioTracks().some((track) => track.readyState === "ended")) {
            if (this.micStream === stream) this.onMicrophoneEnded();
            return;
        }
        const audioTrack = this.micStream.getAudioTracks()[0] || null;
        if (this.audioSender && audioTrack) {
            try {
                await this._replaceTrack(this.audioSender, audioTrack);
            } catch (error) {
                if (this.micStream === stream) {
                    this.micStream = null;
                }
                stream.getTracks().forEach((t) => t.stop());
                if (generation !== this.micGeneration) return;
                throw error;
            }
        }
    }

    /**
     * Replaces a sender's track, stopping early if close() drops the senders.
     * Firefox never settles a replaceTrack() that is pending when pc.close()
     * runs (e.g. a resume renegotiating), which would leave callers like
     * "Start speaking", Camera, or Screen share waiting for good. The next
     * connection sends micStream / videoTrack anyway.
     * @param {RTCRtpSender} sender
     * @param {MediaStreamTrack | null} track
     */
    async _replaceTrack(sender, track) {
        let markDropped = () => {};
        const dropped = new Promise((resolve) => (markDropped = () => resolve(undefined)));
        this.onSendersDropped.add(markDropped);
        try {
            await Promise.race([sender.replaceTrack(track), dropped]);
        } finally {
            this.onSendersDropped.delete(markDropped);
        }
    }

    stopMicrophone() {
        this.micGeneration++; // Abandons a startMicrophone() still in flight.
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
        const generation = ++this.videoGeneration;
        // Remembered so a renegotiated session (resumption) keeps sending it.
        const track = stream.getVideoTracks()[0] || null;
        this.videoTrack = track;
        if (this.videoSender) {
            try {
                await this._replaceTrack(this.videoSender, track);
            } catch (error) {
                if (this.videoTrack === track && generation === this.videoGeneration) {
                    this.videoTrack = null;
                }
                if (generation !== this.videoGeneration) return;
                throw error;
            }
        }
    }

    detachVideoStream() {
        this.videoGeneration++;
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
            const pc = this.pc;
            if (!pc) return;
            try {
                const stats = await pc.getStats();
                // Chrome still delivers stats after close(); a newer session
                // reset the counters, and a closed one shows nothing.
                if (this.pc !== pc) return;
                let bytesReceived = 0;
                let bytesSent = 0;
                let packetsLost = 0;
                let framesPerSecond = /** @type {number | null} */ (null);

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

    clearConnectTimer() {
        if (this.connectTimer !== null) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
    }

    /**
     * Marks the metrics state as "failed" and runs onConnectionFailed() without
     * letting synchronous teardown close() calls overwrite "failed" with "closed".
     */
    _failConnection() {
        G3RtcWebRtcManager.showState("failed");
        this.inConnectionFailed = true;
        try {
            this.onConnectionFailed();
        } finally {
            this.inConnectionFailed = false;
        }
    }

    /**
     * Closes the peer connection.
     * @param {{keepLocalMedia?: boolean, markClosed?: boolean}} [options] -
     *     keepLocalMedia: keep the microphone and camera tracks for the next
     *     initiateSession(). markClosed: show "closed" in the metrics panel;
     *     false for a session whose media went over the WebSocket, which
     *     shows "n/a" there.
     */
    close({ keepLocalMedia = false, markClosed = true } = {}) {
        this.stopStatsPolling();
        this.clearConnectTimer();
        this.hasConnected = false;
        if (!keepLocalMedia) {
            this.stopMicrophone();
            this.detachVideoStream();
        }
        if (this.dataChannel) {
            try {
                this.dataChannel.close();
            } catch {
                // Closing is best effort; the channel is dropped either way.
            }
            this.dataChannel = null;
        }
        if (this.pc) {
            try {
                this.pc.close();
            } catch {
                // Closing is best effort; the connection is dropped either way.
            }
            this.pc = null;
        }
        this.audioSender = null;
        this.videoSender = null;
        this.onSendersDropped.forEach((markDropped) => markDropped());
        this.remoteStream = null;
        const videoEl =
            this.videoPlayerElement || document.getElementById("video_player");
        if (videoEl && videoEl.srcObject) {
            videoEl.srcObject = null;
        }
        // The speed readouts are reset by GeminiLiveAPI, which owns them for
        // both transports; these two are WebRTC's alone.
        const fpsEl = document.getElementById("webrtc-fps");
        if (fpsEl) fpsEl.textContent = "--";
        const lossEl = document.getElementById("webrtc-packet-loss");
        if (lossEl) lossEl.textContent = "0";
        if (markClosed && !this.inConnectionFailed) G3RtcWebRtcManager.showState("closed");
    }

    /** Shows the connection state in the metrics panel. */
    static showState(state) {
        const stateEl = document.getElementById("webrtc-state");
        if (stateEl) {
            stateEl.textContent = state;
        }
    }
}

console.log("loaded live-media-manager.js");

