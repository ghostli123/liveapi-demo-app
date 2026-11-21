const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

// script.js uses these live-media-manager.js helpers as they are.
const intervalHelpers = (({ parseIntervalMs, AUDIO_INTERVAL_MS, VIDEO_INTERVAL_MS }) => ({
    parseIntervalMs,
    AUDIO_INTERVAL_MS,
    VIDEO_INTERVAL_MS,
}))(loadScript("live-media-manager.js", ["parseIntervalMs", "AUDIO_INTERVAL_MS", "VIDEO_INTERVAL_MS"]));

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
        dataset: {},
        listeners: {},
        addEventListener(type, listener) {
            (this.listeners[type] ||= []).push(listener);
        },
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
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
        if (!elements.has(id)) {
            const element = fakeElement(id);
            element.focus = () => {
                document.activeElement = element;
            };
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const document = {
        getElementById,
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => radios,
        createElement: () => fakeElement(""),
        createTextNode: () => ({}),
        cookie: "",
        /** @type {object | null} */
        activeElement: null,
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
        "handleFunctionCallRequest",
        "initDOMEventListeners",
        "startCameraCapture",
        "startScreenCapture",
        "setAppStatus",
        "connectBtnClick",
        "handleAudioFileInputChange",
        "handleAvatarFileInputChange",
    ];
    const context = loadScript("script.js", exportNames, {
        window: { location: { protocol: "http:", host: "localhost:1234" }, addEventListener() {} },
        document,
        localStorage: fakeStorage(),
        customElements: { whenDefined: () => Promise.resolve() },
        GeminiLiveAPI: FakeGeminiLiveAPI,
        LiveAudioOutputManager: FakeManager,
        LiveVideoOutputManager: FakeManager,
        LiveAudioInputManager: FakeManager,
        MicLevelMeter: FakeMicLevelMeter,
        LiveVideoManager: class extends FakeFrameSource {},
        LiveScreenManager: class extends FakeFrameSource {},
        ...intervalHelpers,
        ...globals,
    });
    return { context, element: getElementById, document };
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

test("the branded-voice dialog takes focus, makes the page inert, and gives focus back on Escape", () => {
    const { context, element, document } = loadApp();
    context.initDOMEventListeners();
    const modal = element("brandedVoiceModal");
    const opener = element("createVoiceBtn");
    opener.focus();
    const recordButtonParts = [];
    element("recordButton").appendChild = (child) => recordButtonParts.push(child);

    context.openModal();
    assert.equal(modal.style.display, "flex");
    assert.equal(document.activeElement, element("newVoiceName"));
    assert.equal(element("appHeader").inert, true);
    assert.equal(element("appContainer").inert, true);
    // The icon's ligature text ("mic") isn't part of the button's name.
    assert.equal(recordButtonParts[0].textContent, "mic");
    assert.equal(recordButtonParts[0].attributes["aria-hidden"], "true");

    // Reopened after a failed recording: focus still goes back to the opener.
    context.openModal();
    const press = (key) => {
        const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const listener of modal.listeners.keydown) listener(event);
        return event;
    };
    assert.equal(press("Enter").defaultPrevented, false);
    assert.equal(modal.style.display, "flex");
    assert.equal(press("Escape").defaultPrevented, true);
    assert.equal(modal.style.display, "none");
    assert.equal(element("appHeader").inert, false);
    assert.equal(element("appContainer").inert, false);
    assert.equal(document.activeElement, opener);

    // Closing it again (a finished recording after Escape) leaves focus alone.
    element("text-message").focus();
    context.closeModal();
    assert.equal(document.activeElement, element("text-message"));
});

test("the metrics icon toggles its panel from the keyboard and closes on Escape or focus leaving", () => {
    const { context, element, document } = loadApp();
    const icon = element("metrics-icon");
    const panel = element("metrics-panel");
    const container = fakeElement("metrics-container");
    container.contains = (node) => node === container || node === icon || node === panel;
    icon.parentElement = container;
    context.initDOMEventListeners();
    const fire = (target, type, props = {}) => {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
        for (const listener of target.listeners[type] || []) listener(event);
        return event;
    };
    const isOpen = () => panel.classList.contains("open");
    assert.equal(isOpen(), false);

    assert.equal(fire(icon, "keydown", { key: "Enter" }).defaultPrevented, true);
    assert.equal(isOpen(), true);
    assert.equal(icon.attributes["aria-expanded"], "true");
    // Space toggles too, without scrolling the page.
    assert.equal(fire(icon, "keydown", { key: " " }).defaultPrevented, true);
    assert.equal(isOpen(), false);
    assert.equal(icon.attributes["aria-expanded"], "false");
    assert.equal(fire(icon, "keydown", { key: "Tab" }).defaultPrevented, false);
    assert.equal(isOpen(), false);

    fire(icon, "click");
    assert.equal(isOpen(), true);
    // Escape from inside the panel closes it and puts focus back on the icon.
    document.activeElement = panel;
    assert.equal(fire(container, "keydown", { key: "Escape" }).defaultPrevented, true);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, icon);
    // With the panel closed, Escape is left to others.
    assert.equal(fire(container, "keydown", { key: "Escape" }).defaultPrevented, false);

    fire(icon, "click");
    fire(container, "focusout", { relatedTarget: panel }); // Selecting the session ID.
    assert.equal(isOpen(), true);
    fire(container, "focusout", { relatedTarget: element("text-message") });
    assert.equal(isOpen(), false);
    fire(icon, "click");
    fire(container, "focusout", { relatedTarget: null }); // A click on the page background.
    assert.equal(isOpen(), false);
});

test("connection changes are announced once each; model turns aren't", () => {
    const { context, element } = loadApp({
        LiveVideoOutputManager: class {
            getRecordings = () => [];
            clearRecordedChunks() {}
        },
    });
    const announcer = element("connection-announcer");
    const announced = [];
    Object.defineProperty(announcer, "textContent", {
        set: (text) => {
            announced.push(text);
        },
    });
    for (const status of ["connecting", "connected", "speaking", "connected", "speaking", "connecting", "connected"]) {
        context.setAppStatus(status);
    }
    context.setAppStatus("disconnected");
    context.setAppStatus("disconnected");
    assert.deepEqual(announced, ["Connecting", "Connected", "Connecting", "Connected", "Disconnected"]);
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
            disconnectMicrophone() {
                mic.stops = (mic.stops || 0) + 1;
            }
            recordChunk() {}
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

test("a microphone that stops on its own ends the turn, turns the mic off and says why", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;
    await context.turnBtnClick();
    assert.deepEqual(api.sent, [["activity", true]]);
    mic.stops = 0;

    context.AppState.liveAudioInputManager.onMicrophoneEnded(); // Unplugged.
    assert.deepEqual(api.sent, [["activity", true], ["activity", false]]);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(element("micBtn").hidden, true);
    assert.equal(element("micOffBtn").hidden, false);
    assert.equal(mic.stops, 1);
    assert.match(dialogText(), /^The microphone stopped: it was unplugged/);
});

/** loadApp with a WebRTC manager stand-in that records what it was told. */
function loadWithWebRtcManager() {
    const webRtc = {
        videoTrack: null,
        detached: [],
        micStops: 0,
        detachVideoStream() {
            this.detached.push(this.videoTrack);
            this.videoTrack = null;
        },
        stopMicrophone() {
            this.micStops++;
        },
    };
    const app = loadApp({
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            constructor(...args) {
                super(...args);
                this.webRtcManager = webRtc;
            }
        },
        MicLevelMeter: class {
            start() {}
            stop() {}
        },
        LiveAudioInputManager: class {
            disconnectMicrophone() {}
        },
    });
    return { ...app, webRtc, dialogText: () => app.element("dialogMessage").textContent };
}

test("a WebRTC microphone that stops on its own is turned off; a mic already off is left alone", () => {
    const { element, webRtc, dialogText } = loadWithWebRtcManager();
    element("micBtn").hidden = true; // Off: a late "ended" changes nothing.
    webRtc.onMicrophoneEnded();
    assert.equal(webRtc.micStops, 0);
    assert.equal(dialogText(), undefined);

    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;
    webRtc.onMicrophoneEnded();
    assert.equal(webRtc.micStops, 1);
    assert.equal(element("micBtn").hidden, true);
    assert.equal(element("micOffBtn").hidden, false);
    assert.match(dialogText(), /^The microphone stopped/);
});

test("a camera that stops on its own stops the WebRTC video and says why; Stop sharing doesn't ask", () => {
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager();
    const camera = { kind: "video" };
    webRtc.videoTrack = camera;
    element("cameraBtn").hidden = false;
    element("cameraOffBtn").hidden = true;
    context.AppState.liveVideoManager.onEnded(camera);
    assert.deepEqual(webRtc.detached, [camera]);
    assert.equal(element("cameraBtn").hidden, true);
    assert.equal(element("cameraOffBtn").hidden, false);
    assert.match(dialogText(), /^The camera stopped/);

    element("dialogMessage").textContent = undefined;
    const screen = { kind: "video" };
    webRtc.videoTrack = screen;
    context.AppState.liveScreenManager.onEnded({ kind: "video" }); // Not the one being sent.
    assert.deepEqual(webRtc.detached, [camera]);
    context.AppState.liveScreenManager.onEnded(screen);
    assert.deepEqual(webRtc.detached, [camera, screen]);
    assert.equal(dialogText(), undefined); // The user ended the share themselves.
});

/**
 * A connected session whose function-response simulator answers when the test
 * says; `timers` holds the callbacks script.js scheduled.
 */
function loadFunctionCalls() {
    const timers = [];
    const app = loadApp({
        AbortController,
        setTimeout: (callback, ms) => timers.push({ callback, ms }) - 1,
        clearTimeout: (id) => {
            if (timers[id]) timers[id].cleared = true;
        },
    });
    const api = app.context.AppState.geminiLiveApi;
    api.webSocket = {};
    api.sessionId = "s-1";
    api.frUrl = "/api/post_endpoint";
    const posts = [];
    api.sendPostRequest = (url, data, { signal }) =>
        new Promise((resolve, reject) => {
            posts.push({ name: data.functionName, signal, resolve });
            signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
    api.sendMessage = (message) => api.sent.push(message);
    const chat = [];
    app.element("text-chat").appendChild = (line) => chat.push(line.textContent);
    return { ...app, api, posts, timers, chat };
}

/** Lets the awaits between one simulator answer and the next request run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a function call the server cancels is aborted and not answered", async () => {
    const { context, api, posts } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([
        { id: "c1", name: "slow", args: {} },
        { id: "c2", name: "next", args: {} },
    ]);
    assert.equal(posts.length, 1);
    context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c1"] });
    assert.equal(posts[0].signal.aborted, true);
    await settle();
    posts[1].resolve({ response: "ok" });
    await done;
    assert.deepEqual(
        plainJson(api.sent.map((m) => m.toolResponse.functionResponses.map((r) => r.id))),
        [["c2"]]
    );
});

test("calls cancelled before or after their simulation get no response", async () => {
    const { context, api, posts, chat } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([
        { id: "c1", name: "first" },
        { id: "c2", name: "second" },
        { id: "c3", name: "third" },
    ]);
    posts[0].resolve({ response: "one" });
    await settle();
    // c1 has its answer; c2 is being simulated; c3 hasn't started.
    context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c1", "c3"] });
    posts[1].resolve({ response: "two" });
    await done;
    assert.deepEqual(
        posts.map((p) => p.name),
        ["first", "second"]
    );
    assert.deepEqual(
        plainJson(api.sent.map((m) => m.toolResponse.functionResponses.map((r) => r.id))),
        [["c2"]]
    );
    assert.ok(chat.includes("Function calls cancelled: c1, c3"));

    // Once every call is cancelled, nothing is sent.
    const all = context.handleFunctionCallRequest([{ id: "c4", name: "fourth" }]);
    context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c4"] });
    await all;
    assert.equal(api.sent.length, 1);
});

test("a simulator that doesn't answer times out, and the model still gets a response", async () => {
    const { context, api, posts, timers, chat } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "hung" }]);
    assert.equal(posts.length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30000);
    timers[0].callback();
    await done;
    assert.deepEqual(plainJson(api.sent), [
        {
            toolResponse: {
                functionResponses: [
                    { id: "c1", name: "hung", response: { error: "the simulator didn't answer within 30 s" } },
                ],
            },
        },
    ]);
    assert.ok(chat.includes("Function hung failed: the simulator didn't answer within 30 s"));
});

test("an answered call clears its timeout", async () => {
    const { context, api, posts, timers } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "quick" }]);
    posts[0].resolve({ response: "ok" });
    await done;
    assert.equal(timers[0].cleared, true);
    assert.deepEqual(plainJson(api.sent[0].toolResponse.functionResponses[0].response), {
        result: { response: "ok" },
    });
});

/** Objects from the VM context have another realm's prototypes. */
function plainJson(value) {
    return JSON.parse(JSON.stringify(value));
}

test("camera and screen frames are sent at the clamped video interval", async () => {
    const started = [];
    const { context, element } = loadApp({
        navigator: {},
        requestAnimationFrame: () => 0, // Device lists refresh once the camera starts.
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {}
            async startWebcam() {
                started.push(["camera", this.intervalMs]);
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {}
            async startCapture() {
                started.push(["screen", this.intervalMs]);
                return false; // Dropped, so the test needs no camera stand-in to stop.
            }
        },
    });
    // parseInt read "-5" as -5 and "1e3" as 1: a 1024 px JPEG every few ms.
    for (const typed of ["-5", "1e3", "3", ""]) {
        element("videoInterval").value = typed;
        await context.startCameraCapture();
        await context.startScreenCapture();
    }
    assert.deepEqual(plainJson(started), [
        ["camera", 400],
        ["screen", 400],
        ["camera", 1000],
        ["screen", 1000],
        ["camera", 100],
        ["screen", 100],
        ["camera", 400],
        ["screen", 400],
    ]);
});

test("a typed interval is replaced by the one the app will use", () => {
    const { context, element, document } = loadApp();
    document.querySelector = (selector) => (selector.startsWith("#") ? element(selector.slice(1)) : null);
    context.initDOMEventListeners();
    const change = (id, typed) => {
        const field = element(id);
        field.value = typed;
        for (const listener of field.listeners.change) listener({ target: field });
        return field.value;
    };
    assert.equal(change("audioInterval", "5000"), "1000");
    assert.equal(change("audioInterval", "1e2"), "100");
    assert.equal(change("audioInterval", ""), "200");
    assert.equal(change("videoInterval", "-5"), "400");
    assert.equal(change("videoInterval", "7"), "100");
});

test("multi-part avatar recordings become links, released by the next Connect", () => {
    const urls = { created: [], revoked: [] };
    const { context, element, document } = loadApp({
        URL: {
            createObjectURL(blob) {
                urls.created.push(blob);
                return `blob:${urls.created.length}`;
            },
            revokeObjectURL: (url) => urls.revoked.push(url),
        },
        getAvatarVideoElement: () => null, // From live-media-manager.js.
        // connectBtnClick configures the session through many setters.
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            constructor(...args) {
                super(...args);
                return new Proxy(this, { get: (target, name) => (name in target ? target[name] : () => {}) });
            }
        },
    });
    document.createElement = () => {
        const link = fakeElement("");
        link.removeAttribute = (name) => {
            delete link[name];
        };
        return link;
    };
    const lines = [];
    element("text-chat").appendChild = (line) => {
        line.children = [];
        line.append = (...nodes) => line.children.push(...nodes.filter((node) => typeof node !== "string"));
        lines.push(line);
    };
    let recordings = ["mp4 one", "mp4 two"];
    const { AppState } = context;
    AppState.liveVideoOutputManager.getRecordings = () => recordings;
    AppState.liveVideoOutputManager.clearRecordedChunks = () => {
        recordings = [];
    };
    AppState.liveAudioOutputManager.resume = () => {};
    element("location").value = "us-central1";

    context.setAppStatus("disconnected");
    assert.equal(lines.length, 1);
    const links = lines[0].children;
    assert.deepEqual(urls.created, ["mp4 one", "mp4 two"]);
    assert.deepEqual(links.map((link) => [link.href, link.textContent]), [
        ["blob:1", "part 1"],
        ["blob:2", "part 2"],
    ]);
    assert.match(links[1].download, /^received_video_\d+_part2\.mp4$/);
    assert.deepEqual(urls.revoked, []);

    // A second multi-part session gets its own line rather than collapsing
    // into the first one, which would replace its links.
    context.connectBtnClick();
    assert.deepEqual(urls.revoked, ["blob:1", "blob:2"]);
    assert.deepEqual(links.map((link) => [link.href, link.download, link.textContent]), [
        [undefined, undefined, "part 1 (expired)"],
        [undefined, undefined, "part 2 (expired)"],
    ]);
    recordings = ["mp4 three", "mp4 four"];
    context.setAppStatus("disconnected");
    assert.equal(lines.length, 2);
    assert.equal(lines[0].textContent, "Saved avatar video:");
    assert.deepEqual(lines[1].children.map((link) => link.href), ["blob:3", "blob:4"]);
    context.connectBtnClick();
    assert.deepEqual(urls.revoked, ["blob:1", "blob:2", "blob:3", "blob:4"]);
});

/** A FileReader that reads a Blob-like `{ type, size, bytes }` as a data URL. */
class FakeFileReader {
    async readAsDataURL(blob) {
        const bytes = blob instanceof Blob ? Buffer.from(await blob.arrayBuffer()) : Buffer.from(blob.bytes);
        this.result = `data:${blob.type};base64,${bytes.toString("base64")}`;
        this.onloadend();
    }
}

/** An OfflineAudioContext whose decoded audio lasts `durationS`. */
function fakeOfflineAudioContext(durationS) {
    return class {
        constructor(channels, length, sampleRate) {
            this.length = length;
            this.sampleRate = sampleRate;
        }
        async decodeAudioData() {
            return { duration: durationS };
        }
        createBufferSource() {
            return { connect() {}, start() {} };
        }
        async startRendering() {
            const samples = new Float32Array(this.length);
            return { numberOfChannels: 1, length: this.length, sampleRate: this.sampleRate, getChannelData: () => samples };
        }
    };
}

test("a voice sample too long for the setup message is refused; one within the limit is selected", async () => {
    for (const [durationS, selected] of [
        [301, false],
        [12, true],
    ]) {
        const { context, element } = loadApp({ OfflineAudioContext: fakeOfflineAudioContext(durationS), FileReader: FakeFileReader });
        const input = { value: "long.wav", files: [{ name: "long.wav", arrayBuffer: async () => new ArrayBuffer(8) }] };
        await context.handleAudioFileInputChange({ target: input });
        assert.equal(input.value, "");
        const text = element("dialogMessage").textContent;
        if (selected) {
            assert.match(text, /Branded voice "long.wav" is selected/);
            assert.ok(context.AppState.customVoiceBase64.length > 0);
        } else {
            assert.equal(text, 'Could not use "long.wav" as a voice sample: it is 5.1 min long; samples are limited to 5 min.');
            assert.equal(context.AppState.customVoiceBase64, "");
        }
    }
});

test("an avatar image too large or of an unsupported type is refused and the previous avatar kept", async () => {
    const { context, element } = loadApp({ FileReader: FakeFileReader });
    const avatars = [];
    context.AppState.geminiLiveApi.setCustomizedAvatar = (data, type) => avatars.push([data, type]);
    const choose = async (file) => {
        await context.handleAvatarFileInputChange({ target: { value: file.name, files: [file] } });
        return element("dialogMessage").textContent;
    };
    assert.equal(
        await choose({ name: "big.png", type: "image/png", size: 20 * 1024 * 1024 + 1, bytes: "" }),
        'Could not use "big.png" as the avatar: it is 20.1 MB; images are limited to 20 MB.'
    );
    assert.equal(
        await choose({ name: "face.gif", type: "image/gif", size: 1000, bytes: "" }),
        'Could not use "face.gif" as the avatar: use a PNG, JPEG or WebP image.'
    );
    assert.equal(avatars.length, 0);
    await choose({ name: "face.jpg", type: "image/jpeg", size: 3, bytes: "abc" });
    assert.deepEqual(JSON.parse(JSON.stringify(avatars)), [["YWJj", "image/jpeg"]]);
    assert.equal(element("avatarName").textContent, "Avatar: face.jpg");
});
