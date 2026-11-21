const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

// Stand-ins for the classes gemini-live-api.js and live-media-manager.js
// define; they record what script.js does with them.
class FakeGeminiLiveAPI {
    constructor(...args) {
        this.args = args;
        this.webRtcManager = null;
        this.sent = [];
    }
    sendAudioMessage(data) {
        this.sent.push(["audio", data]);
    }
    sendImageMessage(data) {
        this.sent.push(["image", data]);
    }
    noteActivity() {}
}
class FakeManager {}
class FakeMicLevelMeter {
    constructor(onLevel) {
        this.onLevel = onLevel;
    }
}
class FakeFrameSource {
    constructor(previewVideoElement, previewCanvasElement) {
        this.previewVideoElement = previewVideoElement;
        this.previewCanvasElement = previewCanvasElement;
    }
}

function fakeElement(id) {
    return {
        id,
        hidden: false,
        style: {},
        listeners: {},
        addEventListener(type, listener) {
            (this.listeners[type] ||= []).push(listener);
        },
        replaceChildren() {},
        appendChild() {},
        focus() {},
    };
}

function loadApp(globals = {}) {
    const elements = new Map();
    const getElementById = (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement(id));
        return elements.get(id);
    };
    const exportNames = ["AppState", "handleReceiveResponse", "bufferToWave", "handleRecordClick", "openModal", "closeModal"];
    const context = loadScript("script.js", exportNames, {
        window: { location: { protocol: "http:", host: "localhost:1234" }, addEventListener() {} },
        document: {
            getElementById,
            addEventListener() {},
            querySelectorAll: () => [],
            createElement: () => fakeElement(""),
            createTextNode: () => ({}),
        },
        GeminiLiveAPI: FakeGeminiLiveAPI,
        LiveAudioOutputManager: FakeManager,
        LiveVideoOutputManager: FakeManager,
        LiveAudioInputManager: FakeManager,
        MicLevelMeter: FakeMicLevelMeter,
        LiveVideoManager: class extends FakeFrameSource {},
        LiveScreenManager: class extends FakeFrameSource {},
        ...globals,
    });
    return { context, element: getElementById };
}

test("the managers exist once the script has loaded, wired to the session", () => {
    const { context, element } = loadApp();
    const { AppState } = context;
    const api = AppState.geminiLiveApi;
    assert.ok(api instanceof FakeGeminiLiveAPI);
    assert.deepEqual(api.args, ["ws://localhost:1234/ws", "/api/control", "/api/post_endpoint"]);
    assert.equal(api.onReceiveResponse, context.handleReceiveResponse);

    // Camera and screen sharing share the preview elements.
    for (const source of [AppState.liveVideoManager, AppState.liveScreenManager]) {
        assert.equal(source.previewVideoElement, element("video"));
        assert.equal(source.previewCanvasElement, element("canvas"));
    }

    AppState.liveAudioInputManager.onNewAudioRecordingChunk("pcm");
    AppState.liveVideoManager.onNewFrame("camera-jpeg");
    AppState.liveScreenManager.onNewFrame("screen-jpeg");
    assert.deepEqual(api.sent, [
        ["audio", "pcm"],
        ["image", "camera-jpeg"],
        ["image", "screen-jpeg"],
    ]);

    AppState.micLevelMeter.onLevel(0.5);
    assert.equal(element("micLevelBar").style.transform, "scaleY(0.500)");

    for (const listener of element("video").listeners.loadedmetadata) listener();
    assert.equal(element("previewPlaceholder").hidden, true);
});

test("bufferToWave writes a 16-bit PCM WAV, clamping samples", async () => {
    const { context } = loadApp();
    const samples = Float32Array.from([0, 1, -1, 2]);
    const blob = context.bufferToWave({
        numberOfChannels: 1,
        length: samples.length,
        sampleRate: 24000,
        getChannelData: () => samples,
    });
    assert.equal(blob.type, "audio/wav");
    const view = new DataView(await blob.arrayBuffer());
    const tag = (offset) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
    assert.equal(view.byteLength, 44 + 2 * samples.length);
    assert.equal(tag(0), "RIFF");
    assert.equal(view.getUint32(4, true), view.byteLength - 8);
    assert.equal(tag(8), "WAVE");
    assert.equal(tag(12), "fmt ");
    assert.equal(view.getUint16(20, true), 1); // PCM
    assert.equal(view.getUint16(22, true), 1); // Channels
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint32(28, true), 48000); // Bytes per second
    assert.equal(view.getUint16(34, true), 16); // Bits per sample
    assert.equal(tag(36), "data");
    assert.equal(view.getUint32(40, true), 2 * samples.length);
    const pcm = [0, 1, 2, 3].map((i) => view.getInt16(44 + 2 * i, true));
    assert.deepEqual(pcm, [0, 32767, -32768, 32767]);
});

/**
 * A getUserMedia that answers when the test says, and a MediaRecorder that
 * records what happens to it; for the branded-voice recording dialog.
 */
function fakeRecordingDevices() {
    const prompts = [];
    const recorders = [];
    const getUserMedia = () =>
        new Promise((resolve) => {
            const track = { stopped: false, stop() { this.stopped = true; } };
            const stream = { track, getTracks: () => [track] };
            prompts.push({ track, grant: () => resolve(stream) });
        });
    class FakeMediaRecorder {
        constructor(stream) {
            this.stream = stream;
            this.state = "inactive";
            recorders.push(this);
        }
        start() {
            this.state = "recording";
        }
        stop() {
            this.state = "inactive";
            queueMicrotask(() => this.onstop());
        }
    }
    return {
        prompts,
        recorders,
        globals: { navigator: { mediaDevices: { getUserMedia } }, MediaRecorder: FakeMediaRecorder },
    };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a double-click on Record leaves one recording, and closing the dialog frees the mic", async () => {
    const devices = fakeRecordingDevices();
    const { context, element } = loadApp(devices.globals);
    context.openModal();
    element("newVoiceName").value = "Kai";

    const clicks = [context.handleRecordClick(), context.handleRecordClick()];
    for (const prompt of devices.prompts) prompt.grant();
    await Promise.all(clicks);
    const recording = devices.recorders.filter((r) => r.state === "recording");
    assert.equal(recording.length, 1);
    assert.equal(context.AppState.mediaRecorder, recording[0]);

    context.closeModal();
    await flush();
    assert.ok(devices.prompts.length > 0);
    for (const prompt of devices.prompts) assert.equal(prompt.track.stopped, true);
    assert.equal(context.AppState.isRecording, false);
});

test("a mic granted after the recording dialog closed is released, not recorded", async () => {
    const devices = fakeRecordingDevices();
    const { context, element } = loadApp(devices.globals);
    context.openModal();
    element("newVoiceName").value = "Kai";

    const click = context.handleRecordClick();
    context.closeModal(); // While the permission prompt is open.
    devices.prompts[0].grant();
    await click;
    assert.equal(devices.prompts[0].track.stopped, true);
    assert.equal(devices.recorders.length, 0);
    assert.equal(context.AppState.isRecording, false);
});
