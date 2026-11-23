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
    const getUserMedia = (constraints) =>
        new Promise((resolve, reject) => {
            const track = fakeTrack();
            const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [track] };
            const deny = (name = "NotAllowedError") => reject(Object.assign(new Error(name), { name }));
            requests.push({ constraints, track, stream, grant: () => resolve(stream), deny });
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
    assert.equal(manager.onSendersDropped.size, 0); // Nothing left for close() to call.
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

test("startMicrophone returns when the connection closes during its replaceTrack()", async () => {
    const { manager, requests } = webRtcManagerWithPendingMic();
    // Firefox never settles a replaceTrack() that is pending when pc.close() runs.
    manager.audioSender = { replaceTrack: () => new Promise(() => {}) };
    const starting = manager.startMicrophone();
    requests[0].grant();
    await settle();
    manager.close({ keepLocalMedia: true }); // A resume renegotiating.
    const outcome = await Promise.race([starting.then(() => "returned"), settle().then(() => "pending")]);
    assert.equal(outcome, "returned"); // Pending left "Start speaking" waiting for good.
    assert.equal(manager.micStream.getAudioTracks()[0], requests[0].track); // The next connection sends it.
    assert.equal(requests[0].track.readyState, "live");
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

/**
 * A LiveAudioInputManager (WebSocket mic) on fake audio nodes.
 * @param {{addModule?: () => Promise<void>}} [options] - The worklet loader.
 */
function audioInputWithPendingMic({ addModule = async () => {} } = {}) {
    const devices = pendingMediaDevices();
    const intervals = new Set();
    class FakeAudioContext {
        constructor() {
            this.state = "running";
            this.audioWorklet = { addModule };
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
        btoa,
        navigator: { mediaDevices: devices.mediaDevices },
        AudioContext: FakeAudioContext,
        AudioWorkletNode: FakeWorkletNode,
        setInterval: (callback, ms) => {
            const id = { ms, callback };
            intervals.add(id);
            return id;
        },
        clearInterval: (id) => intervals.delete(id),
    });
    return { manager: new context.LiveAudioInputManager(), requests: devices.requests, intervals };
}

/** Switches a LiveAudioInputManager to another device the way script.js's startAudioInput does. */
function switchMicrophone(manager, deviceId) {
    manager.deviceId = deviceId;
    return manager.updateAudioInterval("1000"); // Disconnects, then connects.
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

test("a WebSocket microphone that ends while the worklet loads is reported", async () => {
    let finishLoad;
    const { manager, requests, intervals } = audioInputWithPendingMic({
        addModule: () => new Promise((resolve) => (finishLoad = resolve)),
    });
    let ended = 0;
    // Like script.js, which turns the mic off and shows a dialog.
    manager.onMicrophoneEnded = () => {
        ended++;
        manager.disconnectMicrophone();
    };
    const connecting = manager.connectMicrophone();
    requests[0].grant();
    await new Promise((resolve) => setImmediate(resolve)); // Now inside addModule().
    requests[0].track.end(); // Unplugged before the "ended" listener exists.
    finishLoad();
    await connecting;
    assert.equal(ended, 1);
    assert.equal(manager.stream, null);
    assert.equal(intervals.size, 0);
});

test("a WebSocket microphone turned off while the worklet loads is released at once", async () => {
    const loads = [];
    const { manager, requests, intervals } = audioInputWithPendingMic({
        addModule: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
    });
    const connecting = manager.connectMicrophone();
    requests[0].grant();
    await new Promise((resolve) => setImmediate(resolve)); // Now inside addModule().
    const context = manager.audioContext;
    manager.disconnectMicrophone();
    // The browser's mic indicator stayed on until the module load settled.
    assert.equal(requests[0].track.readyState, "ended");
    assert.equal(context.state, "closed");
    loads[0].resolve();
    await connecting;
    assert.equal(manager.stream, null);
    assert.equal(manager.processor, null);
    assert.equal(intervals.size, 0);
});

test("a superseded worklet load that ends late doesn't touch the newer WebSocket microphone", async () => {
    for (const outcome of ["resolve", "reject"]) {
        const loads = [];
        const { manager, requests, intervals } = audioInputWithPendingMic({
            addModule: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
        });
        const first = manager.connectMicrophone();
        requests[0].grant();
        await new Promise((resolve) => setImmediate(resolve));
        const second = switchMicrophone(manager, "b");
        assert.equal(requests[0].track.readyState, "ended");
        requests[1].grant();
        await new Promise((resolve) => setImmediate(resolve));
        loads[1].resolve();
        await second;
        loads[0][outcome](new Error("load failed"));
        await first; // Settles quietly either way.
        assert.equal(manager.stream, requests[1].stream, outcome);
        assert.equal(manager.audioContext.state, "running", outcome);
        assert.equal(requests[1].track.readyState, "live", outcome);
        assert.equal(intervals.size, 1, outcome);
    }
});

test("a WebSocket microphone whose worklet fails to load is released and the error thrown", async () => {
    const loads = [];
    const { manager, requests, intervals } = audioInputWithPendingMic({
        addModule: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
    });
    const connecting = manager.connectMicrophone();
    requests[0].grant();
    await new Promise((resolve) => setImmediate(resolve));
    const context = manager.audioContext;
    loads[0].reject(new Error("module fetch failed"));
    await assert.rejects(connecting, /module fetch failed/);
    assert.equal(requests[0].track.readyState, "ended");
    assert.equal(context.state, "closed");
    assert.equal(manager.stream, null);
    assert.equal(manager.audioContext, null);
    assert.equal(intervals.size, 0);
});

test("a WebSocket microphone refused after it was superseded doesn't throw or touch the newer one", async () => {
    const { manager, requests, intervals } = audioInputWithPendingMic();
    const first = manager.connectMicrophone();
    const second = switchMicrophone(manager, "b");
    assert.deepEqual(JSON.parse(JSON.stringify(requests[1].constraints.audio.deviceId)), { exact: "b" });
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

test("WebSocket microphone audio is still sent when the browser throttles the send timer", async () => {
    const { manager, requests, intervals } = audioInputWithPendingMic();
    const updating = manager.updateAudioInterval("200"); // 3,200 samples at 16 kHz.
    requests[0].grant();
    await updating;
    const sentSamples = [];
    manager.onNewAudioRecordingChunk = (b64) => sentSamples.push(Buffer.from(b64, "base64").length / 2);
    const quantum = (n) => manager.processor.port.onmessage({ data: new Int16Array(128).fill(n) });

    // On time: the timer sends each interval's audio; the worklet sends nothing.
    const [timer] = intervals;
    for (let i = 0; i < 25; i++) quantum(1);
    timer.callback();
    assert.deepEqual(sentSamples, [3200]);

    // Throttled (a hidden tab): a minute without the timer. Audio leaves in
    // two-interval chunks instead of piling up for the next timer run.
    sentSamples.length = 0;
    for (let i = 0; i < (60 * 16000) / 128; i++) quantum(i % 2);
    assert.equal(sentSamples.length, 150);
    assert.ok(sentSamples.every((n) => n === 6400), String(new Set(sentSamples)));
    assert.equal(manager.pcmData.length, 0);
});

test("audio the old capture worklet queued doesn't reach the next microphone", async () => {
    const { manager, requests, intervals } = audioInputWithPendingMic();
    let connecting = manager.connectMicrophone();
    requests[0].grant();
    await connecting;
    const sentSamples = [];
    manager.onNewAudioRecordingChunk = (b64) => sentSamples.push(Buffer.from(b64, "base64").length / 2);
    // A browser dispatches queued messages to whatever handler the port has then.
    const deliverQueued = (port) => port.onmessage?.({ data: new Int16Array(128).fill(7) });

    // A device switch: messages the old worklet posted before it was disconnected.
    const oldPort = manager.processor.port;
    connecting = switchMicrophone(manager, "b");
    deliverQueued(oldPort);
    requests[1].grant();
    await connecting;
    deliverQueued(oldPort);
    assert.equal(manager.pcmData.length, 0);
    [...intervals][0].callback();
    assert.deepEqual(sentSamples, []);

    // Mic off: they'd otherwise wait in pcmData and go out at the next Mic on.
    const lastPort = manager.processor.port;
    manager.disconnectMicrophone();
    deliverQueued(lastPort);
    assert.equal(manager.pcmData.length, 0);
});

test("a WebSocket microphone whose capture worklet throws is reported once; an old one isn't", async () => {
    const { manager, requests } = audioInputWithPendingMic();
    let failed = 0;
    manager.onMicrophoneFailed = () => failed++;
    let connecting = manager.connectMicrophone();
    requests[0].grant();
    await connecting;
    // The browser stopped the processor; before, nothing noticed and no audio was sent.
    manager.processor.onprocessorerror(new Event("processorerror"));
    assert.equal(failed, 1);

    // A processor from before a device switch or Mic off doesn't touch the current one.
    const oldProcessor = manager.processor;
    connecting = switchMicrophone(manager, "b");
    requests[1].grant();
    await connecting;
    oldProcessor.onprocessorerror(new Event("processorerror"));
    const lastProcessor = manager.processor;
    manager.disconnectMicrophone();
    lastProcessor.onprocessorerror(new Event("processorerror"));
    assert.equal(failed, 1);
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

test("a camera opened for WebRTC starts sending frames once media moves to the WebSocket", async () => {
    const { manager, requests, intervals } = cameraManagerWithPendingCamera();
    manager.startSendingFrames(); // Not started: nothing to send.
    assert.equal(intervals.size, 0);
    const starting = manager.startWebcam({ sendFrames: false });
    requests[0].grant();
    await starting;
    assert.equal(intervals.size, 0);
    manager.startSendingFrames();
    manager.startSendingFrames(); // Already sending: no second timer.
    assert.equal(intervals.size, 1);
    manager.stopWebcam();
    assert.equal(intervals.size, 0);
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

test("a WebRTC renegotiation keeps the avatar muted if the user muted it", async () => {
    class FakePeerConnection {
        constructor() {
            this.iceGatheringState = "complete";
            this.connectionState = "new";
            this.localDescription = { sdp: "v=0\r\n" };
        }
        createDataChannel() { return { close() {} }; }
        addTransceiver() { return { sender: { replaceTrack: async () => {} }, receiver: { track: {} }, mid: null }; }
        async setLocalDescription() {}
        async setRemoteDescription() {}
        close() {}
    }
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: () => null },
        RTCPeerConnection: FakePeerConnection,
        MediaStream: class { addTrack() {} },
        randomId: () => "id",
        setTimeout: () => ({}),
        clearTimeout: () => {},
        setInterval: () => ({}),
        clearInterval: () => {},
        performance: { now: () => 0 },
    });
    const video = {
        muted: false,
        srcObject: null,
        plays: 0,
        removeAttribute() {},
        play() {
            this.plays++;
            return Promise.resolve();
        },
    };
    const manager = new context.G3RtcWebRtcManager(video);
    await manager.initiateSession();
    await manager.completeSession("v=0\r\n");
    assert.equal(video.muted, false);
    video.muted = true; // The user mutes from the player's controls.
    await manager.initiateSession(); // A GoAway or 1001 resume renegotiates.
    await manager.completeSession("v=0\r\n");
    assert.equal(video.muted, true);
    assert.equal(video.plays, 2);
    assert.equal(video.srcObject, manager.remoteStream);
});

// A WebRTC manager with a negotiated session whose timers the test fires.
async function webRtcSessionWithManualTimers() {
    const timeouts = new Map();
    let pc;
    class FakePeerConnection {
        constructor() {
            pc = this;
            this.iceGatheringState = "complete";
            this.connectionState = "new";
            this.localDescription = { sdp: "v=0\r\n" };
        }
        createDataChannel() { return { close() {} }; }
        addTransceiver() { return { sender: { replaceTrack: async () => {} }, receiver: { track: {} }, mid: null }; }
        async setLocalDescription() {}
        async setRemoteDescription() {}
        close() {}
    }
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: () => null },
        RTCPeerConnection: FakePeerConnection,
        MediaStream: class { addTrack() {} },
        randomId: () => "id",
        setTimeout: (fn, ms) => {
            const id = {};
            timeouts.set(id, { fn, ms });
            return id;
        },
        clearTimeout: (id) => timeouts.delete(id),
        setInterval: () => ({}),
        clearInterval: () => {},
        performance: { now: () => 0 },
    });
    const manager = new context.G3RtcWebRtcManager(null);
    const failures = [];
    manager.onConnectionFailed = () => failures.push(pc.connectionState);
    await manager.initiateSession();
    await manager.completeSession("v=0\r\n");
    const setState = (state) => {
        pc.connectionState = state;
        pc.onconnectionstatechange();
    };
    const fireConnectTimeout = () => {
        for (const [id, { fn, ms }] of timeouts) {
            if (ms === 15000) {
                timeouts.delete(id);
                fn();
            }
        }
    };
    return { failures, setState, fireConnectTimeout };
}

test("a WebRTC session that never connects is reported after the connect timeout", async () => {
    const { failures, setState, fireConnectTimeout } = await webRtcSessionWithManualTimers();
    setState("connecting");
    fireConnectTimeout();
    assert.deepEqual(failures, ["connecting"]);
});

test("a WebRTC session that connected isn't failed by the connect timeout while disconnected", async () => {
    const { failures, setState, fireConnectTimeout } = await webRtcSessionWithManualTimers();
    setState("connecting");
    setState("connected");
    // A network blip at the 15 s mark; ICE may still recover.
    setState("disconnected");
    fireConnectTimeout();
    assert.deepEqual(failures, []);
    setState("failed"); // It didn't recover.
    assert.deepEqual(failures, ["failed"]);
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
// test sets; appendBuffer() throws `appendError` when it's set. With `removed`
// set, both throw, as Chrome does once the SourceBuffer leaves its MediaSource.
function videoOutputWithFakeMediaSource({ codecSupported = true, addSourceBufferError = null } = {}) {
    const fake = { mediaSources: [], appendError: null, buffered: null, removed: false };
    const removedError = () => Object.assign(new Error("removed"), { name: "InvalidStateError" });
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
                    if (fake.removed) throw removedError();
                    const range = fake.buffered;
                    return range
                        ? { length: 1, start: () => range[0], end: () => range[1] }
                        : { length: 0 };
                },
                addEventListener: (type, listener) => listeners.push(listener),
                appendBuffer(chunk) {
                    if (fake.removed) throw removedError();
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
    // `src` stands in for the attribute; `paused` follows play() and pause().
    const video = {
        style: {},
        currentTime: 0,
        src: null,
        paused: true,
        loads: 0,
        addEventListener() {},
        play() {
            this.paused = false;
            return Promise.resolve();
        },
        pause() { this.paused = true; },
        load() { this.loads++; },
        getAttribute(name) { return name === "src" ? this.src : null; },
        removeAttribute(name) { if (name === "src") this.src = null; },
    };
    fake.revoked = [];
    fake.bitrate = { textContent: "--" }; // The recommended bitrate readout.
    let urls = 0;
    const elementsById = { video_player: video, "recommended-video-bitrate": fake.bitrate };
    const context = loadScript("live-media-manager.js", ["LiveVideoOutputManager"], {
        window: { MediaSource: FakeMediaSource, atob },
        document: { getElementById: (id) => elementsById[id] ?? null },
        URL: { createObjectURL: () => `blob:${++urls}`, revokeObjectURL: (url) => fake.revoked.push(url) },
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

test("an unsupported codec isn't reported for streams without MP4 chunks", () => {
    const { manager, video, errors } = videoOutputWithFakeMediaSource({ codecSupported: false });
    manager.initMediaSource(); // Every WebSocket session, avatar or not.
    assert.deepEqual(errors, []);
    // JPEG frames are drawn in an <img>, without MSE.
    for (const mimeType of ["image/jpeg", "video/jpeg"]) manager.playVideoChunk(VIDEO_CHUNK, mimeType);
    assert.deepEqual(errors, []);
    assert.equal(video.style.display, "none");
    assert.equal(manager.chunkQueue.length, 0);

    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /can't play the avatar video/);
});

test("a failed addSourceBuffer() is reported at the first MP4 chunk, not at sourceopen", () => {
    const error = Object.assign(new Error("unsupported"), { name: "NotSupportedError" });
    const { manager, fake, errors } = videoOutputWithFakeMediaSource({ addSourceBufferError: error });
    manager.initMediaSource();
    fake.mediaSources[0].open();
    manager.playVideoChunk(VIDEO_CHUNK, "image/jpeg");
    assert.deepEqual(errors, []);
    for (let i = 0; i < 100; i++) manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /can't play the avatar video/);

    manager.resetPlayer(); // Disconnect; the next stream starts unreported.
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(manager.chunkQueue.length, 1);
    assert.equal(errors.length, 1);
});

test("resetPlayer() stops the stream's playback and revokes its URL; a new stream plays", () => {
    const { manager, fake, video } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    fake.mediaSources[0].open();
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(video.src, "blob:1");
    assert.equal(video.paused, false);
    fake.bitrate.textContent = "81920.00"; // From a stall in this stream.

    manager.resetPlayer(); // Disconnect.
    assert.equal(fake.bitrate.textContent, "--");
    assert.equal(video.paused, true); // The buffered tail would keep playing.
    assert.equal(video.src, null);
    assert.equal(video.loads, 1);
    assert.deepEqual(fake.revoked, ["blob:1"]);
    assert.equal(manager.objectUrl, null);

    manager.initMediaSource(); // Connect again.
    fake.mediaSources[1].open();
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(video.src, "blob:2");
    assert.equal(video.paused, false);
    assert.equal(fake.mediaSources[1].sourceBuffer.appended.length, 1);
    assert.deepEqual(fake.revoked, ["blob:1"]);
});

test("resetPlayer() leaves a video that isn't playing its stream alone", () => {
    const { manager, video } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    video.removeAttribute("src"); // WebRTC took over the element (srcObject).
    video.paused = false;
    manager.resetPlayer();
    assert.equal(video.paused, false);
    assert.equal(video.loads, 0);
    assert.equal(manager.objectUrl, null);
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

test("a non-quota append error is reported once and stops queuing; a new stream plays", () => {
    const { manager, fake, errors } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    fake.mediaSources[0].open();
    const sourceBuffer = fake.mediaSources[0].sourceBuffer;
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    fake.appendError = Object.assign(new Error("bad state"), { name: "InvalidStateError" });
    for (let i = 0; i < 100; i++) manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(sourceBuffer.appended.length, 1);
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(manager.playbackFailed, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /stopped after a playback error/);

    fake.appendError = null;
    manager.initMediaSource();
    fake.mediaSources[1].open();
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    assert.equal(fake.mediaSources[1].sourceBuffer.appended.length, 1);
    assert.equal(errors.length, 1);
});

test("a SourceBuffer removed from an open MediaSource is reported once without throwing", () => {
    const { manager, fake, video, errors } = videoOutputWithFakeMediaSource();
    manager.initMediaSource();
    fake.mediaSources[0].open();
    fake.buffered = [0, 5];
    video.currentTime = 4;
    manager.playVideoChunk(VIDEO_CHUNK, "video/mp4");
    fake.removed = true; // readyState stays "open"; buffered and appendBuffer throw.
    for (let i = 0; i < 100; i++) {
        assert.doesNotThrow(() => manager.playVideoChunk(VIDEO_CHUNK, "video/mp4"));
    }
    assert.equal(manager.chunkQueue.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /stopped after a playback error/);
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
// next addModule() reject (`fake.failAllLoads` every one); like Chrome and
// Firefox, a context whose load failed keeps rejecting. `fake.noWorklet` leaves
// out `audioWorklet`, as on an insecure page. `fake.now` is the script's
// performance.now(), `fake.wallNow` its Date.now().
function audioOutputWithFakeContexts() {
    const fake = {
        contexts: [],
        loads: 0,
        failNextLoad: false,
        failAllLoads: false,
        refuseContexts: false,
        noWorklet: false,
        errors: [],
        now: 0,
        wallNow: 0,
    };
    class FakeAudioContext {
        constructor() {
            if (fake.refuseContexts) throw new Error("NotSupportedError");
            this.state = "suspended";
            this.destination = {};
            let failed = false;
            this.audioWorklet = fake.noWorklet
                ? undefined
                : {
                      addModule: async () => {
                          fake.loads++;
                          if (fake.failNextLoad || fake.failAllLoads) {
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
        performance: { now: () => fake.now },
        Date: { now: () => fake.wallNow },
        console: { log() {}, warn() {}, error: (message) => fake.errors.push(message) },
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

        // Chunks right after the failure wait for the retry delay.
        manager.playAudioChunk(AUDIO_CHUNK);
        await settle();
        assert.equal(fake.contexts.length, 1);

        fake.now = 1000;
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

test("a page without AudioWorklet rejects instead of throwing, and closes the context", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        // Plain http from another machine: browsers leave out audioWorklet.
        fake.noWorklet = true;
        manager.resume(); // The Connect click; a throw here stopped Connect.
        manager.playAudioChunk(AUDIO_CHUNK);
        await settle();
        assert.equal(fake.contexts[0].state, "closed");
        assert.equal(manager.ready, null);
        assert.ok(fake.errors.includes("Could not load the audio player:"));
        await assert.rejects(manager.initializeAudioContext(), /AudioWorklet is unavailable/);
        assert.equal(fake.contexts.length, 1); // Backing off, not a context per chunk.
        assert.deepEqual(unhandled, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("a refused AudioContext rejects instead of throwing, and is retried later", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        fake.refuseContexts = true;
        manager.resume(); // The Connect click; a throw here left Connect stuck.
        manager.playAudioChunk(AUDIO_CHUNK);
        await assert.rejects(manager.initializeAudioContext(), /NotSupportedError/);
        manager.clear();
        await settle();
        assert.equal(manager.ready, null);
        assert.equal(manager.audioContext, null);
        assert.ok(fake.errors.includes("Could not create the audio player:"));

        fake.refuseContexts = false;
        manager.playAudioChunk(AUDIO_CHUNK); // Within the retry delay: dropped.
        await settle();
        assert.equal(fake.contexts.length, 0);
        assert.equal(fake.errors.filter((e) => e === "Could not create the audio player:").length, 1);

        fake.now = 1000;
        manager.playAudioChunk(AUDIO_CHUNK);
        await settle();
        assert.equal(fake.contexts.length, 1);
        assert.equal(manager.workletNode.posted.length, 1);
        assert.deepEqual(unhandled, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("a worklet that keeps failing is retried with a growing delay, and at once on Connect", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    fake.failAllLoads = true;
    manager.resume(); // The Connect click.
    await settle();
    for (let i = 0; i < 20; i++) manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    // Before, each chunk built a context, refetched the worklet and logged twice.
    assert.equal(fake.contexts.length, 1);
    assert.equal(fake.loads, 1);
    assert.deepEqual(fake.errors, ["Could not load the audio player:"]);

    const loadsAt = async (now) => {
        fake.now = now;
        manager.playAudioChunk(AUDIO_CHUNK);
        await settle();
        return fake.loads;
    };
    assert.equal(await loadsAt(999), 1);
    assert.equal(await loadsAt(1000), 2); // Then wait 2 s.
    assert.equal(await loadsAt(2999), 2);
    assert.equal(await loadsAt(3000), 3); // 4 s.
    assert.equal(await loadsAt(7000), 4); // 8 s.
    assert.equal(await loadsAt(15000), 5); // 16 s.
    assert.equal(await loadsAt(31000), 6); // 30 s from here on.
    assert.equal(await loadsAt(60999), 6);
    assert.equal(await loadsAt(61000), 7);
    assert.ok(fake.contexts.slice(0, -1).every((context) => context.state === "closed"));

    manager.resume(); // A new Connect doesn't wait.
    await settle();
    assert.equal(fake.loads, 8);

    fake.failAllLoads = false;
    fake.now += 1000;
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    assert.equal(fake.loads, 9);
    assert.equal(manager.workletNode.posted.length, 1);
    assert.equal(manager.workletNode.context.state, "running");
    // A later failure (after a success) starts again at 1 s.
    assert.equal(manager.retryDelayMs, 0);
});

test("a player that can't start is reported once per Connect, when a chunk is dropped", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    const reports = [];
    manager.onPlayerError = (message) => reports.push(message);
    fake.failAllLoads = true;
    manager.resume(); // The Connect click. WebRTC sessions stop here: no chunk, no report.
    await settle();
    assert.deepEqual(reports, []);

    manager.playAudioChunk(AUDIO_CHUNK); // Within the retry delay: dropped.
    manager.playAudioChunk(AUDIO_CHUNK);
    fake.now = 1000;
    manager.playAudioChunk(AUDIO_CHUNK); // A new attempt that fails too.
    await settle();
    assert.equal(fake.loads, 2);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /couldn't start, so the model's speech isn't playing/);

    // A refused context is reported the same way.
    fake.refuseContexts = true;
    manager.resume(); // The next Connect.
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    assert.equal(reports.length, 2);

    // A crash after a failed start in the same Connect isn't reported again.
    fake.refuseContexts = false;
    fake.failAllLoads = false;
    fake.now = 2000;
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    manager.workletNode.onprocessorerror(new Event("processorerror"));
    assert.equal(reports.length, 2);
});

test("a wall clock stepped back doesn't extend the playback retry delay", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    manager.resume(); // The Connect click.
    await settle();
    manager.workletNode.onprocessorerror(new Event("processorerror"));
    fake.wallNow = -3600000; // E.g. NTP sets the system clock back an hour.
    fake.now = 1000;
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    assert.equal(fake.contexts.length, 2);
    assert.equal(manager.workletNode.posted.length, 1);
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

test("a playback worklet that throws is rebuilt after a growing delay and reported once per Connect", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    const reports = [];
    manager.onPlayerError = (message) => reports.push(message);
    const crash = (node) => node.onprocessorerror(new Event("processorerror"));
    manager.resume(); // The Connect click.
    await settle();
    const first = manager.workletNode;
    crash(first);
    assert.equal(fake.contexts[0].state, "closed");
    assert.equal(manager.workletNode, null);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /audio player stopped/);
    assert.ok(fake.errors.includes("The audio player stopped:"));

    manager.playAudioChunk(AUDIO_CHUNK); // Within 1 s: dropped.
    await settle();
    assert.equal(fake.contexts.length, 1);
    fake.now = 1000;
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    assert.equal(fake.contexts.length, 2);
    assert.equal(manager.workletNode.posted.length, 1);

    // A late event from the old node doesn't drop the new player.
    crash(first);
    assert.equal(manager.workletNode.context, fake.contexts[1]);

    // A worklet that throws on every chunk isn't rebuilt per chunk.
    crash(manager.workletNode);
    fake.now = 2999;
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    assert.equal(fake.contexts.length, 2);
    fake.now = 3000;
    manager.playAudioChunk(AUDIO_CHUNK);
    await settle();
    assert.equal(fake.contexts.length, 3);
    assert.equal(reports.length, 1);

    // The next Connect rebuilds at once and reports again.
    crash(manager.workletNode);
    manager.resume();
    await settle();
    assert.equal(fake.contexts.length, 4);
    crash(manager.workletNode);
    assert.equal(reports.length, 2);
    assert.equal(manager.crashDelayMs, 1000);
});

test("a playback worklet crash long after the last start waits 1 s again", async () => {
    const { manager, fake } = audioOutputWithFakeContexts();
    const crash = () => manager.workletNode.onprocessorerror(new Event("processorerror"));
    // Whether a chunk at `now` builds a new player.
    const rebuildsAt = async (now) => {
        const contexts = fake.contexts.length;
        fake.now = now;
        manager.playAudioChunk(AUDIO_CHUNK);
        await settle();
        return fake.contexts.length > contexts;
    };
    manager.resume(); // The Connect click, at 0.
    await settle();
    crash(); // Waits 1 s, then 2 s, then 4 s while it keeps crashing at once.
    assert.ok(await rebuildsAt(1000));
    crash();
    assert.ok(await rebuildsAt(3000));
    crash();
    assert.ok(await rebuildsAt(7000));

    // Just under a minute of playing is still the same problem: 8 s.
    fake.now = 7000 + 59999;
    crash();
    assert.equal(await rebuildsAt(66999 + 7999), false);
    assert.ok(await rebuildsAt(66999 + 8000));

    // A minute of playing: 1 s, not 16 s (before, the delay only reset at
    // the next Connect, so a long session's rare crashes reached 30 s each).
    fake.now = 74999 + 60000;
    crash();
    assert.equal(manager.crashDelayMs, 1000);
    assert.equal(await rebuildsAt(134999 + 999), false);
    assert.ok(await rebuildsAt(134999 + 1000));
});

test("a mic level meter the browser refuses throws and leaves nothing running", () => {
    const contexts = [];
    let refuseContext = false;
    class FakeAudioContext {
        constructor() {
            if (refuseContext) throw new Error("no audio device");
            this.state = "running";
            this.closed = 0;
            contexts.push(this);
        }
        createAnalyser() {
            return { fftSize: 0 };
        }
        createMediaStreamSource() {
            throw new Error("stream has no audio track");
        }
        close() {
            this.closed++;
            return Promise.resolve();
        }
    }
    const frames = [];
    const { MicLevelMeter } = loadScript("live-media-manager.js", ["MicLevelMeter"], {
        window: { AudioContext: FakeAudioContext },
        requestAnimationFrame: (callback) => frames.push(callback),
        cancelAnimationFrame() {},
    });
    const levels = [];
    const meter = new MicLevelMeter((level) => levels.push(level));

    assert.throws(() => meter.start({}), /stream has no audio track/);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].closed, 1);
    assert.equal(meter.context, null);
    assert.equal(frames.length, 0);
    assert.deepEqual(levels, [0, 0]);

    refuseContext = true;
    assert.throws(() => meter.start({}), /no audio device/);
    assert.equal(meter.context, null);
    meter.stop(); // Turning the mic off afterwards is still fine.
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

test("the WebRTC state reads negotiating while a session is set up, not closed", async () => {
    const stateEl = { textContent: "negotiating" }; // What connectBtnClick shows.
    let finishOffer;
    let pc;
    class FakePeerConnection {
        constructor() {
            pc = this;
            this.iceGatheringState = "complete";
            this.connectionState = "new";
            this.localDescription = { sdp: "v=0\r\n" };
        }
        createDataChannel() { return { close() {} }; }
        addTransceiver() { return { sender: { replaceTrack: async () => {} }, receiver: { track: {} }, mid: null }; }
        setLocalDescription() { return new Promise((resolve) => (finishOffer = resolve)); }
        close() {}
    }
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: (id) => (id === "webrtc-state" ? stateEl : null) },
        RTCPeerConnection: FakePeerConnection,
        MediaStream: class { addTrack() {} },
        randomId: () => "id",
        clearTimeout,
        clearInterval,
    });
    const manager = new context.G3RtcWebRtcManager(null);
    const offering = manager.initiateSession();
    assert.equal(stateEl.textContent, "negotiating"); // close() of the old session ran first.
    finishOffer();
    await settle();
    finishOffer();
    await offering;
    assert.equal(stateEl.textContent, "negotiating");
    pc.connectionState = "connecting";
    pc.onconnectionstatechange();
    assert.equal(stateEl.textContent, "connecting");
    manager.close();
    assert.equal(stateEl.textContent, "closed");
});

test("close() of a session whose media used the WebSocket leaves the WebRTC state alone", () => {
    const stateEl = { textContent: "n/a" }; // What connectBtnClick and the fallback show.
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: (id) => (id === "webrtc-state" ? stateEl : null) },
        clearTimeout,
        clearInterval,
    });
    const manager = new context.G3RtcWebRtcManager(null);
    manager.close({ markClosed: false });
    assert.equal(stateEl.textContent, "n/a");
    manager.close();
    assert.equal(stateEl.textContent, "closed");
});

// A WebRTC manager whose peer connections hold every replaceTrack() until the
// test releases it. Chrome resolves a held one even after pc.close().
function webRtcManagerWithHeldReplaceTrack() {
    const pcs = [];
    const held = [];
    class FakePeerConnection {
        constructor() {
            pcs.push(this);
            this.transceivers = [];
            this.iceGatheringState = "complete";
            this.localDescription = { sdp: "v=0\r\n" };
        }
        createDataChannel() { return { close() {} }; }
        addTransceiver(kind, { direction }) {
            const sender = { replaceTrack: () => new Promise((resolve) => held.push(resolve)) };
            const transceiver = { kind, direction, sender, receiver: { track: {} }, mid: null };
            this.transceivers.push(transceiver);
            return transceiver;
        }
        async setLocalDescription() {}
        close() {}
    }
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: () => null },
        RTCPeerConnection: FakePeerConnection,
        MediaStream: class { addTrack() {} },
        randomId: () => "id",
        clearTimeout,
        clearInterval,
    });
    const manager = new context.G3RtcWebRtcManager(null);
    manager.micStream = { getAudioTracks: () => [fakeTrack()], getTracks: () => [] };
    const releaseAll = () => held.splice(0).forEach((resolve) => resolve());
    return { manager, pcs, releaseAll };
}

test("close() while initiateSession sends the mic ends it with the closed error and no new stream", async () => {
    const { manager, releaseAll } = webRtcManagerWithHeldReplaceTrack();
    const offering = manager.initiateSession().catch((error) => error);
    await settle();
    manager.close({ keepLocalMedia: true }); // Disconnect while the mic is attached.
    releaseAll();
    const error = await offering;
    assert.equal(error.message, "The WebRTC session was closed.");
    assert.equal(manager.remoteStream, null);
});

test("an initiateSession overtaken by a newer one leaves the newer connection alone", async () => {
    const { manager, pcs, releaseAll } = webRtcManagerWithHeldReplaceTrack();
    const first = manager.initiateSession().catch((error) => error);
    await settle();
    const second = manager.initiateSession();
    await settle();
    releaseAll();
    await settle();
    releaseAll();
    assert.equal((await first).message, "The WebRTC session was closed.");
    await second;
    assert.equal(manager.pc, pcs[1]);
    const recvonly = (pc) => pc.transceivers.filter((t) => t.direction === "recvonly").length;
    assert.equal(recvonly(pcs[0]), 0);
    assert.equal(recvonly(pcs[1]), 2); // Audio and video, once.
});

test("stats that arrive after close() aren't shown", async () => {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, { textContent: "--" });
        return elements.get(id);
    };
    const ticks = [];
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: element },
        setInterval: (fn) => ticks.push(fn),
        clearInterval() {},
        clearTimeout,
        performance: { now: () => 0 },
    });
    const manager = new context.G3RtcWebRtcManager(null);
    let deliverStats;
    manager.pc = {
        getStats: () => new Promise((resolve) => (deliverStats = resolve)),
        close() {},
    };
    manager.startStatsPolling();
    const polling = ticks[0]();
    manager.close(); // Disconnect while getStats() is pending.
    deliverStats(new Map([["in", { type: "inbound-rtp", kind: "video", bytesReceived: 4096, packetsLost: 3, framesPerSecond: 30 }]]));
    await polling;
    assert.equal(element("download-speed").textContent, "--");
    assert.equal(element("webrtc-packet-loss").textContent, "0"); // As close() reset it.
    assert.equal(element("webrtc-fps").textContent, "--");
});

test("close() resets the WebRTC frame rate and packet loss readouts", async () => {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, { textContent: "" });
        return elements.get(id);
    };
    const ticks = [];
    let now = 0;
    const context = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"], {
        document: { getElementById: element },
        setInterval: (fn) => ticks.push(fn),
        clearInterval() {},
        clearTimeout,
        performance: { now: () => now },
    });
    const manager = new context.G3RtcWebRtcManager(null);
    const report = { type: "inbound-rtp", kind: "video", bytesReceived: 4096, packetsLost: 3, framesPerSecond: 30 };
    manager.pc = { getStats: async () => new Map([["in", report]]), close() {} };
    manager.startStatsPolling();
    now = 2000;
    await ticks[0]();
    assert.equal(element("webrtc-fps").textContent, "30.0");
    assert.equal(element("webrtc-packet-loss").textContent, "3");
    manager.close();
    assert.equal(element("webrtc-fps").textContent, "--");
    assert.equal(element("webrtc-packet-loss").textContent, "0");
});
