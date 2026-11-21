const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

const { G3RtcWebRtcManager } = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"]);

test("fixAnswerSdp gives candidates with an empty foundation one", () => {
    const sdp = [
        "a=ice-lite",
        "a=candidate: 1 udp 2113932031 74.125.247.233 19305 typ host generation 0",
        "a=candidate:7 1 udp 2113932031 74.125.247.233 19306 typ host generation 0",
        "",
    ].join("\r\n");
    assert.equal(
        G3RtcWebRtcManager.fixAnswerSdp(sdp),
        [
            "a=ice-lite",
            "a=candidate:0 1 udp 2113932031 74.125.247.233 19305 typ host generation 0",
            "a=candidate:7 1 udp 2113932031 74.125.247.233 19306 typ host generation 0",
            "",
        ].join("\r\n")
    );
});

test("applyG3rtcAttributesToSdp tags each grouped m-section", () => {
    const sdp = ["m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1"].join("\r\n");
    const out = G3RtcWebRtcManager.applyG3rtcAttributesToSdp(sdp, new Map([["0", "g1"]]));
    assert.equal(
        out,
        ["m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "a=g3rtc-attrs group-id:g1", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1"].join("\r\n")
    );
});

// A MediaStreamTrack stand-in. Like a real one, stop() doesn't fire "ended";
// end() is the device being unplugged or the browser ending it.
function fakeTrack() {
    const listeners = [];
    return {
        readyState: "live",
        stop() { this.readyState = "ended"; },
        addEventListener: (type, listener) => listeners.push(listener),
        end() { this.readyState = "ended"; listeners.forEach((l) => l()); },
    };
}

// A fake getUserMedia whose calls stay pending until the test resolves them,
// like a permission prompt the user hasn't answered yet.
function pendingMediaDevices() {
    const requests = [];
    const getUserMedia = () =>
        new Promise((resolve, reject) => {
            const track = fakeTrack();
            const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [track] };
            const deny = (name = "NotAllowedError") => reject(Object.assign(new Error(name), { name }));
            requests.push({ track, stream, grant: () => resolve(stream), deny });
        });
    return { requests, mediaDevices: { getUserMedia } };
}

function webRtcManagerWithPendingMic() {
    const devices = pendingMediaDevices();
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        navigator: { mediaDevices: devices.mediaDevices },
        document: { getElementById: () => null },
        clearTimeout,
        clearInterval,
    });
    const manager = new context.G3RtcWebRtcManager(null);
    const sent = [];
    manager.audioSender = { replaceTrack: async (track) => sent.push(track) };
    return { manager, requests: devices.requests, sent };
}

test("startMicrophone sends the granted microphone", async () => {
    const { manager, requests, sent } = webRtcManagerWithPendingMic();
    const starting = manager.startMicrophone();
    requests[0].grant();
    await starting;
    assert.equal(manager.micStream.getAudioTracks()[0], requests[0].track);
    assert.equal(sent.at(-1), requests[0].track);
    assert.equal(requests[0].track.readyState, "live");
});

test("a microphone granted after stopMicrophone() is stopped, not sent", async () => {
    const { manager, requests, sent } = webRtcManagerWithPendingMic();
    const starting = manager.startMicrophone();
    manager.stopMicrophone(); // Mic turned off while the prompt is open.
    requests[0].grant();
    await starting;
    assert.equal(manager.micStream, null);
    assert.equal(requests[0].track.readyState, "ended");
    assert.ok(!sent.includes(requests[0].track));
});

test("a microphone granted after close() is stopped", async () => {
    const { manager, requests } = webRtcManagerWithPendingMic();
    const starting = manager.startMicrophone();
    manager.close(); // Disconnect while the prompt is open.
    requests[0].grant();
    await starting;
    assert.equal(manager.micStream, null);
    assert.equal(requests[0].track.readyState, "ended");
});

test("only the newest of two overlapping startMicrophone() calls keeps its stream", async () => {
    const { manager, requests, sent } = webRtcManagerWithPendingMic();
    const first = manager.startMicrophone("a");
    const second = manager.startMicrophone("b"); // e.g. a device change.
    requests[1].grant();
    await second;
    requests[0].grant();
    await first;
    assert.equal(manager.micStream.getAudioTracks()[0], requests[1].track);
    assert.equal(requests[0].track.readyState, "ended");
    assert.equal(requests[1].track.readyState, "live");
    assert.equal(sent.at(-1), requests[1].track);
});

test("a microphone refused after a newer start doesn't throw or touch the newer one", async () => {
    const { manager, requests, sent } = webRtcManagerWithPendingMic();
    const first = manager.startMicrophone("a");
    const second = manager.startMicrophone("b");
    requests[1].grant();
    await second;
    requests[0].deny("NotFoundError"); // e.g. the first device was unplugged.
    await first; // A rejection here made script.js turn the working mic off.
    assert.equal(manager.micStream.getAudioTracks()[0], requests[1].track);
    assert.equal(requests[1].track.readyState, "live");
    assert.equal(sent.at(-1), requests[1].track);

    const third = manager.startMicrophone();
    requests[2].deny();
    await assert.rejects(third, { name: "NotAllowedError" }); // Still reported when current.
});

test("a microphone that ends on its own is reported; a replaced one isn't", async () => {
    const { manager, requests } = webRtcManagerWithPendingMic();
    let ended = 0;
    manager.onMicrophoneEnded = () => ended++;
    const first = manager.startMicrophone("a");
    requests[0].grant();
    await first;
    const second = manager.startMicrophone("b"); // A device change.
    requests[1].grant();
    await second;
    requests[0].track.end(); // Ending the replaced device changes nothing.
    assert.equal(ended, 0);
    requests[1].track.end(); // The microphone in use is unplugged.
    assert.equal(ended, 1);
});

/** A LiveAudioInputManager (WebSocket mic) on fake audio nodes. */
function audioInputWithPendingMic() {
    const devices = pendingMediaDevices();
    const intervals = new Set();
    class FakeAudioContext {
        constructor() {
            this.state = "running";
            this.audioWorklet = { addModule: async () => {} };
        }
        createMediaStreamSource() {
            return { connect() {} };
        }
        close() {
            this.state = "closed";
        }
    }
    class FakeWorkletNode {
        constructor() {
            this.port = {};
        }
        disconnect() {}
    }
    const context = loadScript("live-media-manager.js", ["LiveAudioInputManager"], {
        navigator: { mediaDevices: devices.mediaDevices },
        AudioContext: FakeAudioContext,
        AudioWorkletNode: FakeWorkletNode,
        setInterval: (callback, ms) => {
            const id = { ms };
            intervals.add(id);
            return id;
        },
        clearInterval: (id) => intervals.delete(id),
    });
    return { manager: new context.LiveAudioInputManager(), requests: devices.requests, intervals };
}

test("a WebSocket microphone that ends on its own is reported; one turned off isn't", async () => {
    const { manager, requests, intervals } = audioInputWithPendingMic();
    let ended = 0;
    manager.onMicrophoneEnded = () => ended++;
    let connecting = manager.connectMicrophone();
    requests[0].grant();
    await connecting;
    assert.equal(intervals.size, 1);
    manager.disconnectMicrophone();
    requests[0].track.end();
    assert.equal(ended, 0);

    connecting = manager.connectMicrophone();
    requests[1].grant();
    await connecting;
    requests[1].track.end();
    assert.equal(ended, 1);
});

test("a WebSocket microphone refused after it was superseded doesn't throw or touch the newer one", async () => {
    const { manager, requests, intervals } = audioInputWithPendingMic();
    const first = manager.connectMicrophone();
    const second = manager.updateMicrophoneDevice("b"); // Disconnects, then connects.
    requests[1].grant();
    await second;
    requests[0].deny("NotFoundError");
    await first; // A rejection here made script.js turn the working mic off.
    assert.equal(manager.stream, requests[1].stream);
    assert.equal(requests[1].track.readyState, "live");
    assert.equal(intervals.size, 1);

    manager.disconnectMicrophone();
    const third = manager.connectMicrophone();
    requests[2].deny();
    await assert.rejects(third, { name: "NotAllowedError" });
});

test("parseIntervalMs clamps typed intervals and falls back on unusable ones", () => {
    const context = loadScript("live-media-manager.js", ["parseIntervalMs", "AUDIO_INTERVAL_MS", "VIDEO_INTERVAL_MS"]);
    const audio = (value) => context.parseIntervalMs(value, context.AUDIO_INTERVAL_MS);
    const video = (value) => context.parseIntervalMs(value, context.VIDEO_INTERVAL_MS);
    // parseInt read "1e3" as 1 and "-5" as -5: an audio frame per render quantum.
    assert.equal(audio("1e3"), 1000);
    assert.equal(audio("1"), 20);
    assert.equal(audio("-5"), 200);
    assert.equal(audio("0"), 200);
    assert.equal(audio(""), 200);
    assert.equal(audio(null), 200);
    assert.equal(audio(undefined), 200);
    assert.equal(audio("abc"), 200);
    assert.equal(audio("Infinity"), 200);
    assert.equal(audio("2147483647"), 1000); // Never fired while the mic showed on.
    assert.equal(audio("99.6"), 100);
    assert.equal(audio(" 300 "), 300);
    assert.equal(video("-5"), 400);
    assert.equal(video("3"), 100);
    assert.equal(video("1500"), 1500);
    assert.equal(video("1e9"), 60000);
});

test("updateAudioInterval sends audio at the clamped interval", async () => {
    const { manager, requests, intervals } = audioInputWithPendingMic();
    const cases = [
        ["1e3", 1000],
        ["1", 20],
        ["-5", 200],
        ["2147483647", 1000],
    ];
    for (const [i, [typed, ms]] of cases.entries()) {
        const updating = manager.updateAudioInterval(typed);
        requests[i].grant();
        await updating;
        assert.deepEqual(
            [...intervals].map((id) => id.ms),
            [ms],
            `typed ${typed}`
        );
    }
});

/** A LiveVideoManager whose getUserMedia() calls wait for the test. */
function cameraManagerWithPendingCamera() {
    const devices = pendingMediaDevices();
    const intervals = new Set();
    const context = loadScript("live-media-manager.js", ["LiveVideoManager"], {
        navigator: { mediaDevices: devices.mediaDevices },
        setInterval: () => {
            const id = {};
            intervals.add(id);
            return id;
        },
        clearInterval: (id) => intervals.delete(id),
    });
    const video = { srcObject: null };
    const manager = new context.LiveVideoManager(video, { getContext: () => ({}) });
    return { manager, requests: devices.requests, intervals, video };
}

test("a camera that ends on its own is detached and reported with its track", async () => {
    const { manager, requests, intervals, video } = cameraManagerWithPendingCamera();
    const ended = [];
    manager.onEnded = (track) => ended.push(track);
    const starting = manager.startWebcam({ sendFrames: true });
    requests[0].grant();
    await starting;
    assert.equal(video.srcObject, requests[0].stream);
    assert.equal(intervals.size, 1);
    requests[0].track.end(); // Unplugged, or access revoked.
    assert.deepEqual(ended, [requests[0].track]);
    assert.equal(manager.stream, null);
    assert.equal(video.srcObject, null);
    assert.equal(intervals.size, 0);
});

test("a camera stopped by the app isn't reported when its track ends later", async () => {
    const { manager, requests } = cameraManagerWithPendingCamera();
    const ended = [];
    manager.onEnded = (track) => ended.push(track);
    let starting = manager.startWebcam();
    requests[0].grant();
    await starting;
    manager.stopWebcam();
    starting = manager.startWebcam();
    requests[1].grant();
    await starting;
    requests[0].track.end();
    assert.deepEqual(ended, []);
    assert.equal(manager.stream.getVideoTracks()[0], requests[1].track);
});

test("a camera refused after stopWebcam() doesn't throw or touch the newer one", async () => {
    const { manager, requests, intervals } = cameraManagerWithPendingCamera();
    const first = manager.startWebcam();
    manager.stopWebcam(); // A device change: startCameraCapture() stops, then starts.
    const second = manager.startWebcam();
    requests[1].grant();
    await second;
    requests[0].deny("NotFoundError");
    await first; // A rejection here made script.js stop the working camera.
    assert.equal(manager.stream.getVideoTracks()[0], requests[1].track);
    assert.equal(requests[1].track.readyState, "live");
    assert.equal(intervals.size, 1);

    manager.stopWebcam();
    const third = manager.startWebcam();
    requests[2].deny();
    await assert.rejects(third, { name: "NotAllowedError" });
});

test("completeSession after close() starts no stats polling or connect timer", async () => {
    let finishSetRemote;
    const timers = new Set();
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: () => null },
        setInterval: () => {
            const id = {};
            timers.add(id);
            return id;
        },
        clearInterval: (id) => timers.delete(id),
        setTimeout: () => {
            const id = {};
            timers.add(id);
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        performance: { now: () => 0 },
    });
    const manager = new context.G3RtcWebRtcManager(null);
    manager.pc = {
        connectionState: "new",
        setRemoteDescription: () => new Promise((resolve) => (finishSetRemote = resolve)),
        close() {},
    };
    const completing = manager.completeSession("v=0\r\n");
    manager.close(); // Disconnect while the answer is being applied.
    finishSetRemote();
    await completing;
    assert.equal(timers.size, 0);
});

// A LiveScreenManager whose getDisplayMedia() calls stay pending until the
// test resolves them, like a screen picker the user hasn't answered yet.
function screenManagerWithPendingPicker() {
    const requests = [];
    const intervals = new Set();
    const getDisplayMedia = () =>
        new Promise((resolve, reject) => {
            const track = fakeTrack();
            const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
            const cancel = () => reject(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
            requests.push({ track, stream, pick: () => resolve(stream), cancel });
        });
    const context = loadScript("live-media-manager.js", ["LiveScreenManager"], {
        navigator: { mediaDevices: { getDisplayMedia } },
        setInterval: () => {
            const id = {};
            intervals.add(id);
            return id;
        },
        clearInterval: (id) => intervals.delete(id),
    });
    const video = { srcObject: null };
    const canvas = { getContext: () => ({}) };
    const manager = new context.LiveScreenManager(video, canvas);
    return { manager, requests, intervals, video };
}

test("startCapture shares the picked screen and sends frames", async () => {
    const { manager, requests, intervals, video } = screenManagerWithPendingPicker();
    const starting = manager.startCapture({ sendFrames: true });
    requests[0].pick();
    assert.equal(await starting, true);
    assert.equal(manager.stream, requests[0].stream);
    assert.equal(video.srcObject, requests[0].stream);
    assert.equal(intervals.size, 1);
});

test("a screen picked after stopCapture() is stopped, not shared", async () => {
    const { manager, requests, intervals, video } = screenManagerWithPendingPicker();
    const starting = manager.startCapture({ sendFrames: true });
    manager.stopCapture(); // Disconnect while the picker is open.
    requests[0].pick();
    assert.equal(await starting, false);
    assert.equal(manager.stream, null);
    assert.equal(video.srcObject, null);
    assert.equal(intervals.size, 0);
    assert.equal(requests[0].track.readyState, "ended");
});

test("a new pick replaces a running share; cancelling keeps it", async () => {
    const { manager, requests, intervals } = screenManagerWithPendingPicker();
    const first = manager.startCapture();
    requests[0].pick();
    await first;
    const cancelled = manager.startCapture();
    requests[1].cancel();
    await assert.rejects(cancelled, { name: "NotAllowedError" });
    assert.equal(manager.stream, requests[0].stream);
    assert.equal(requests[0].track.readyState, "live");
    const second = manager.startCapture();
    assert.equal(requests[0].track.readyState, "live"); // Shared until the pick.
    requests[2].pick();
    assert.equal(await second, true);
    assert.equal(manager.stream, requests[2].stream);
    assert.equal(requests[0].track.readyState, "ended");
    assert.equal(intervals.size, 1);
});

test("a picker that fails after stopCapture() reports false, not an error", async () => {
    const { manager, requests } = screenManagerWithPendingPicker();
    const starting = manager.startCapture();
    manager.stopCapture(); // Disconnect while the picker is open.
    requests[0].cancel();
    assert.equal(await starting, false);
    assert.equal(manager.stream, null);
});

test("ending a share from the browser doesn't drop a pick in progress", async () => {
    const { manager, requests } = screenManagerWithPendingPicker();
    const first = manager.startCapture();
    requests[0].pick();
    await first;
    const ended = [];
    manager.onEnded = (track) => ended.push(track);
    const second = manager.startCapture();
    requests[0].track.end(); // The browser's "Stop sharing" on the old share.
    assert.equal(manager.stream, null);
    assert.deepEqual(ended, [requests[0].track]);
    requests[1].pick();
    assert.equal(await second, true);
    assert.equal(manager.stream, requests[1].stream);
});

// A LiveVideoOutputManager on a fake MediaSource. `buffered` is one range the
// test sets; appendBuffer() throws `appendError` when it's set.
function videoOutputWithFakeMediaSource({ codecSupported = true, addSourceBufferError = null } = {}) {
    const fake = { mediaSources: [], appendError: null, buffered: null };
    class FakeMediaSource {
        static isTypeSupported() { return codecSupported; }
        constructor() {
            this.readyState = "closed";
            this.listeners = {};
            fake.mediaSources.push(this);
        }
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
        open() {
            this.readyState = "open";
            (this.listeners.sourceopen || []).forEach((l) => l());
        }
        addSourceBuffer() {
            if (addSourceBufferError) throw addSourceBufferError;
            const listeners = [];
            this.sourceBuffer = {
                updating: false,
                appended: [],
                removed: [],
                get buffered() {
                    const range = fake.buffered;
                    return range
                        ? { length: 1, start: () => range[0], end: () => range[1] }
                        : { length: 0 };
                },
                addEventListener: (type, listener) => listeners.push(listener),
                appendBuffer(chunk) {
                    if (fake.appendError) throw fake.appendError;
                    this.appended.push(chunk);
                },
                remove(start, end) {
                    this.removed.push([start, end]);
                    this.updating = true;
                },
                // Finishes a pending remove(), as the browser does later.
                finishUpdate() {
                    this.updating = false;
                    listeners.forEach((l) => l());
                },
            };
            return this.sourceBuffer;
        }
        endOfStream() { this.readyState = "ended"; }
    }
    const video = { style: {}, currentTime: 0, addEventListener() {}, play: () => Promise.resolve() };
    const context = loadScript("live-media-manager.js", ["LiveVideoOutputManager"], {
        window: { MediaSource: FakeMediaSource, atob },
        document: { getElementById: (id) => (id === "video_player" ? video : null) },
        URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    });
    const manager = new context.LiveVideoOutputManager();
    const errors = [];
    manager.onPlaybackError = (message) => errors.push(message);
    return { manager, fake, video, errors };
}

const VIDEO_CHUNK = Buffer.from("fake mp4 fragment").toString("base64");

test("an unsupported codec is reported once and chunks aren't queued", () => {
    const { manager, fake, errors } = videoOutputWithFakeMediaSource({ codecSupported: false });
    manager.recordingEnabled = true;
    manager.initMediaSource();
    for (let i = 0; i < 100; i++) manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(fake.mediaSources.length, 0);
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /can't play the avatar video/);
    // Recording doesn't need the player, so it still works.
    assert.equal(manager.recordedChunks.length, 100);
});

test("a failed addSourceBuffer() is reported once and chunks aren't queued", () => {
    const error = Object.assign(new Error("unsupported"), { name: "NotSupportedError" });
    const { manager, fake, errors } = videoOutputWithFakeMediaSource({ addSourceBufferError: error });
    manager.initMediaSource();
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4"); // Queued until sourceopen.
    fake.mediaSources[0].open();
    for (let i = 0; i < 100; i++) manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(errors.length, 1);
});

test("a MediaSource that ends mid-stream is reported and stops queuing; a new stream plays", () => {
    const { manager, fake, errors } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    fake.mediaSources[0].open();
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(fake.mediaSources[0].sourceBuffer.appended.length, 1);
    fake.mediaSources[0].readyState = "ended"; // What a decode error does.
    for (let i = 0; i < 100; i++) manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /stopped after a playback error/);

    manager.initMediaSource(); // A resume streams a new MP4.
    fake.mediaSources[1].open();
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(fake.mediaSources[1].sourceBuffer.appended.length, 1);
    assert.equal(errors.length, 1);
});

test("a full buffer with the playhead stopped drops stale video and keeps the live chunk", () => {
    const { manager, fake, video, errors } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    fake.mediaSources[0].open();
    const sourceBuffer = fake.mediaSources[0].sourceBuffer;
    // 150 s buffered while paused (or autoplay blocked) at 0, so nothing is
    // behind the playhead to trim.
    fake.buffered = [0, 150];
    fake.appendError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.deepEqual(sourceBuffer.removed, [[0, 140]]);
    assert.ok(video.currentTime > 149, `playhead at ${video.currentTime}, not the live edge`);
    assert.equal(manager.chunkQueue.length, 1); // Retried after the removal.

    fake.appendError = null;
    fake.buffered = [140, 150];
    sourceBuffer.finishUpdate();
    assert.equal(sourceBuffer.appended.length, 1);
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(errors.length, 0);
});

test("a full buffer while playing trims behind the playhead and leaves it alone", () => {
    const { manager, fake, video } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    fake.mediaSources[0].open();
    const sourceBuffer = fake.mediaSources[0].sourceBuffer;
    fake.buffered = [0, 15];
    video.currentTime = 12;
    fake.appendError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.deepEqual(sourceBuffer.removed, [[0, 11]]);
    assert.equal(video.currentTime, 12);
    assert.equal(manager.chunkQueue.length, 1);
});

// A LiveAudioOutputManager on fake AudioContexts. `fake.failNextLoad` makes the
// next addModule() reject; like Chrome and Firefox, a context whose load
// failed keeps rejecting.
function audioOutputWithFakeContexts() {
    const fake = { contexts: [], failNextLoad: false };
    class FakeAudioContext {
        constructor() {
            this.state = "suspended";
            this.destination = {};
            let failed = false;
            this.audioWorklet = {
                addModule: async () => {
                    if (fake.failNextLoad) {
                        fake.failNextLoad = false;
                        failed = true;
                    }
                    if (failed) throw new Error("503");
                },
            };
            fake.contexts.push(this);
        }
        resume() {
            this.state = "running";
            return Promise.resolve();
        }
        close() {
            this.state = "closed";
            return Promise.resolve();
        }
    }
    class FakeWorkletNode {
        constructor(context) {
            this.context = context;
            this.posted = [];
            this.port = { postMessage: (message) => this.posted.push(message) };
        }
        connect() {}
    }
    const context = loadScript("live-media-manager.js", ["LiveAudioOutputManager"], {
        window: { AudioContext: FakeAudioContext, atob },
        AudioWorkletNode: FakeWorkletNode,
    });
    return { manager: new context.LiveAudioOutputManager(), fake };
}

const AUDIO_CHUNK = Buffer.alloc(8).toString("base64");
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a failed audio worklet load is retried on a new context", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        fake.failNextLoad = true;
        manager.resume(); // The Connect click.
        await settle();
        assert.equal(fake.contexts[0].state, "closed");

        manager.playAudioChunk(AUDIO_CHUNK);
        await settle();
        assert.equal(fake.contexts.length, 2);
        assert.equal(manager.workletNode.context, fake.contexts[1]);
        assert.equal(manager.workletNode.posted.length, 1);
        assert.equal(fake.contexts[1].state, "running");
        assert.deepEqual(unhandled, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("audio chunks share one context and worklet", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    manager.playAudioChunk(AUDIO_CHUNK);
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    manager.clear();
    await settle();
    assert.equal(fake.contexts.length, 1);
    assert.equal(manager.workletNode.posted.length, 3);
    assert.equal(manager.workletNode.posted[2], "clear");
});

test("recordChunk sends the buffered samples as base64 16-bit little-endian PCM", () => {
    const context = loadScript("live-media-manager.js", ["LiveAudioInputManager"], { btoa });
    const manager = new context.LiveAudioInputManager();
    const sent = [];
    manager.onNewAudioRecordingChunk = (b64AudioData) => sent.push(b64AudioData);
    // 10,000 bytes: more than one of recordChunk's 8 KB conversion slices.
    const samples = Array.from({ length: 5000 }, (_, i) => ((i * 37) % 65536) - 32768);
    manager.pcmData = samples.slice();
    manager.recordChunk();
    const expected = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => expected.writeInt16LE(sample, i * 2));
    assert.deepEqual(sent, [expected.toString("base64")]);
    assert.equal(manager.pcmData.length, 0);
});

function fakeGatheringPeerConnection() {
    const listeners = new Set();
    return {
        iceGatheringState: "gathering",
        listeners,
        addEventListener: (type, listener) => listeners.add(listener),
        removeEventListener: (type, listener) => listeners.delete(listener),
        finishGathering() {
            this.iceGatheringState = "complete";
            [...listeners].forEach((listener) => listener());
        },
    };
}

function webRtcManagerWithManualTimeout() {
    const timeout = { fire: null };
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: () => null },
        setTimeout: (fn) => {
            timeout.fire = fn;
            return 1;
        },
        clearTimeout: () => (timeout.fire = null),
    });
    return { manager: new context.G3RtcWebRtcManager(null), timeout };
}

test("waitForIceGathering resolves when gathering completes and removes its listener", async () => {
    const { manager, timeout } = webRtcManagerWithManualTimeout();
    const pc = fakeGatheringPeerConnection();
    manager.pc = pc;
    let resolved = false;
    const waiting = manager.waitForIceGathering().then(() => (resolved = true));
    await settle();
    assert.equal(resolved, false);
    pc.finishGathering();
    await waiting;
    assert.equal(pc.listeners.size, 0);
    assert.equal(timeout.fire, null);
});

test("waitForIceGathering times out after close() and removes its listener", async () => {
    const { manager, timeout } = webRtcManagerWithManualTimeout();
    const pc = fakeGatheringPeerConnection();
    manager.pc = pc;
    const waiting = manager.waitForIceGathering();
    manager.pc = null; // What close() leaves; a closed pc fires no more events.
    timeout.fire();
    await waiting;
    assert.equal(pc.listeners.size, 0);
});
