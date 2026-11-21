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
    // Like the real class, input is only sent once the server confirmed setup.
    sendTextMessage(text) {
        if (!this.isSetupComplete) return false;
        this.sent.push(["text", text]);
        return true;
    }
    sendVoiceActivityMessage(start) {
        if (!this.isSetupComplete) return false;
        this.sent.push(["activity", start]);
        return true;
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
        classList: {
            names: new Set(),
            add(name) {
                this.names.add(name);
            },
            remove(name) {
                this.names.delete(name);
            },
            contains(name) {
                return this.names.has(name);
            },
        },
        listeners: {},
        addEventListener(type, listener) {
            (this.listeners[type] ||= []).push(listener);
        },
        replaceChildren() {},
        appendChild() {},
        focus() {},
    };
}

/** A localStorage stand-in; `items` survives a reload of the app. */
function fakeStorage(items = new Map()) {
    return {
        items,
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => items.set(key, String(value)),
    };
}

/** `radios` are what the page's responseModality radio query returns. */
function loadApp(globals = {}, { radios = [] } = {}) {
    const elements = new Map();
    const getElementById = (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement(id));
        return elements.get(id);
    };
    const exportNames = [
        "AppState",
        "handleReceiveResponse",
        "bufferToWave",
        "handleRecordClick",
        "openModal",
        "closeModal",
        "restoreSettings",
        "handleEnvironmentChange",
        "newUserMessage",
        "turnBtnClick",
    ];
    const context = loadScript("script.js", exportNames, {
        window: { location: { protocol: "http:", host: "localhost:1234" }, addEventListener() {} },
        document: {
            getElementById,
            addEventListener() {},
            querySelectorAll: () => radios,
            createElement: () => fakeElement(""),
            createTextNode: () => ({}),
            cookie: "",
        },
        localStorage: fakeStorage(),
        customElements: { whenDefined: () => Promise.resolve() },
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

const SETTINGS_KEY = "liveapi-demo-settings";

/** Loads the app with the page's transport and environment selects and restores `storage`. */
async function loadWithSettings(storage) {
    const app = loadApp({ localStorage: storage });
    const select = (id, value, values) =>
        Object.assign(app.element(id), { value, options: values.map((v) => ({ value: v })) });
    select("transportMode", "webrtc", ["webrtc", "websocket"]);
    select("envApiHost", "autopush", ["autopush", "prod", "prod-us-rep"]);
    app.element("liveApiModel").value = "gemini-3.1-flash-live-preview-04-2026";
    await app.context.restoreSettings();
    return app;
}

test("leaving a WebSocket-only environment returns to the default or restored transport", async () => {
    const storage = fakeStorage();
    const { context, element } = await loadWithSettings(storage);
    const switchTo = (env) => {
        element("envApiHost").value = env;
        context.handleEnvironmentChange();
        return element("transportMode").value;
    };
    // WebRTC is the default; the user never picked it, so no change event fired.
    assert.equal(switchTo("prod"), "websocket");
    assert.equal(switchTo("autopush"), "webrtc");

    // The choice also survives a reload while a WebSocket-only environment is selected.
    switchTo("prod");
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY));
    assert.equal(saved.transportMode, "websocket");
    assert.equal(saved.preferredTransport, "webrtc");
    const reloaded = await loadWithSettings(fakeStorage(storage.items));
    assert.equal(reloaded.element("envApiHost").value, "prod");
    assert.equal(reloaded.element("transportMode").value, "websocket");
    reloaded.element("envApiHost").value = "prod-us-rep";
    reloaded.context.handleEnvironmentChange();
    assert.equal(reloaded.element("transportMode").value, "webrtc");
});

test("an unknown saved response type keeps the page's default selected", async () => {
    const radios = ["VIDEO", "AUDIO", "TEXT"].map((value) => ({
        ...fakeElement(`${value}-radio`),
        value,
        checked: value === "VIDEO",
    }));
    const storage = fakeStorage(new Map([[SETTINGS_KEY, JSON.stringify({ responseModality: "IMAGE" })]]));
    const { context } = loadApp({ localStorage: storage }, { radios });
    await context.restoreSettings();
    assert.deepEqual(
        radios.map((radio) => radio.checked),
        [true, false, false]
    );
    assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).responseModality, "VIDEO");

    // A response type the page offers is still restored.
    storage.setItem(SETTINGS_KEY, JSON.stringify({ responseModality: "TEXT" }));
    await loadApp({ localStorage: storage }, { radios }).context.restoreSettings();
    assert.deepEqual(
        radios.map((radio) => radio.checked),
        [false, false, true]
    );
});

/** The "Start speaking" / text input path, with a microphone that starts when the test says. */
function loadSession() {
    const mic = { starts: [] };
    const app = loadApp({
        navigator: {},
        performance,
        requestAnimationFrame: () => 0, // Device lists refresh once the mic starts.
        LiveAudioInputManager: class {
            updateAudioInterval() {
                return new Promise((resolve) => mic.starts.push(resolve));
            }
            disconnectMicrophone() {}
        },
        MicLevelMeter: class {
            start() {}
            stop() {}
        },
    });
    const api = app.context.AppState.geminiLiveApi;
    api.transportMode = "websocket";
    app.element("disconnected").hidden = true; // A session is starting or running.
    return { ...app, api, mic, dialogText: () => app.element("dialogMessage").textContent };
}

test("text typed before the server confirms setup stays in the box", () => {
    const { context, element, api, dialogText } = loadSession();
    const chat = [];
    element("text-chat").appendChild = (line) => chat.push(line.textContent);
    element("text-message").value = "hello";

    context.newUserMessage();
    assert.deepEqual(api.sent, []);
    assert.equal(element("text-message").value, "hello");
    assert.equal(dialogText(), "The session is still connecting. Try sending a message again once it's connected.");
    assert.deepEqual(chat, []);

    api.isSetupComplete = true;
    context.newUserMessage();
    assert.deepEqual(api.sent, [["text", "hello"]]);
    assert.equal(element("text-message").value, "");
    assert.deepEqual(chat, ["You: hello"]);
});

test("text with no session asks the user to connect", () => {
    const { context, element, api, dialogText } = loadSession();
    element("disconnected").hidden = false;
    element("text-message").value = "hello";
    context.newUserMessage();
    assert.deepEqual(api.sent, []);
    assert.equal(dialogText(), "Connect before sending a message.");
});

test("Start speaking while the session resumes doesn't start a turn", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    element("micBtn").hidden = false; // The mic is already on.
    await context.turnBtnClick();
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(element("turnBtn").textContent, undefined);
    assert.equal(dialogText(), "The session is still connecting. Try speaking again once it's connected.");
    assert.equal(mic.starts.length, 0);

    api.isSetupComplete = true;
    await context.turnBtnClick();
    assert.deepEqual(api.sent, [["activity", true]]);
    assert.equal(element("turnBtn").textContent, "Done speaking");
});

test("a resume during the microphone prompt doesn't start a turn", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    element("micBtn").hidden = true; // The mic is off, so the click starts it.
    const click = context.turnBtnClick();
    assert.equal(mic.starts.length, 1);
    api.isSetupComplete = false; // A GoAway: resume() replaces the connection.
    mic.starts[0]();
    await click;
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(context.AppState.turnStarting, false);
    assert.equal(dialogText(), "The session is still connecting. Try speaking again once it's connected.");
});
