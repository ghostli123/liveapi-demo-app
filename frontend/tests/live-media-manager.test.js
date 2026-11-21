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

// A fake getUserMedia whose calls stay pending until the test resolves them,
// like a permission prompt the user hasn't answered yet.
function pendingMediaDevices() {
    const requests = [];
    const getUserMedia = () =>
        new Promise((resolve) => {
            const track = { readyState: "live", stop() { this.readyState = "ended"; } };
            const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
            requests.push({ track, grant: () => resolve(stream) });
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

// A LiveScreenManager whose getDisplayMedia() calls stay pending until the
// test resolves them, like a screen picker the user hasn't answered yet.
function screenManagerWithPendingPicker() {
    const requests = [];
    const intervals = new Set();
    const getDisplayMedia = () =>
        new Promise((resolve, reject) => {
            const listeners = [];
            const track = {
                readyState: "live",
                stop() { this.readyState = "ended"; },
                addEventListener: (type, listener) => listeners.push(listener),
                end() { this.readyState = "ended"; listeners.forEach((l) => l()); },
            };
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

test("ending a share from the browser doesn't drop a pick in progress", async () => {
    const { manager, requests } = screenManagerWithPendingPicker();
    const first = manager.startCapture();
    requests[0].pick();
    await first;
    const second = manager.startCapture();
    requests[0].track.end(); // The browser's "Stop sharing" on the old share.
    assert.equal(manager.stream, null);
    requests[1].pick();
    assert.equal(await second, true);
    assert.equal(manager.stream, requests[1].stream);
});
