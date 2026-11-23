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
    sendAudioStreamEnd() {
        if (!this.isSetupComplete) return false;
        this.sent.push(["audio_stream_end"]);
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
        this.sendingFrames = false;
    }

    startSendingFrames() {
        if (this.stream) this.sendingFrames = true; // Like the real one: a no-op until started.
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
        querySelector: () => null,
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
        "micOffBtnClick",
        "handleFunctionCallRequest",
        "initDOMEventListeners",
        "startCameraCapture",
        "startScreenCapture",
        "setAppStatus",
        "connectBtnClick",
        "handleAudioFileInputChange",
        "handleAvatarFileInputChange",
        "handleFcFileInputChange",
        "useSampleAvatar",
        "useStockAvatar",
        "removeFunctionDeclarations",
        "AppUI",
        "toggleSchedulingDisable",
        "endSession",
        "refreshDeviceLists",
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
 * `timers` holds the callbacks script.js scheduled.
 */
function fakeRecordingDevices() {
    const prompts = [];
    const recorders = [];
    const timers = [];
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
        timers,
        globals: {
            navigator: { mediaDevices: { getUserMedia } },
            MediaRecorder: FakeMediaRecorder,
            setTimeout: (callback, ms) => timers.push({ callback, ms }) - 1,
            clearTimeout: (id) => {
                if (timers[id]) timers[id].cleared = true;
            },
        },
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

test("a drag between the voice name and the backdrop doesn't close the dialog or stop the recording", async () => {
    const devices = fakeRecordingDevices();
    const { context, element } = loadApp(devices.globals);
    context.initDOMEventListeners();
    const modal = element("brandedVoiceModal");
    const name = element("newVoiceName");
    const fire = (type, target) => {
        for (const listener of modal.listeners[type] || []) listener({ target });
    };
    // Chrome sends the click of a drag to the common ancestor, the backdrop.
    const gesture = (pressOn, releaseOn, clickOn = modal) => {
        fire("pointerdown", pressOn);
        fire("pointerup", releaseOn);
        fire("click", clickOn);
    };

    context.openModal();
    name.value = "Kai";
    const click = context.handleRecordClick();
    devices.prompts[0].grant();
    await click;

    gesture(name, modal);
    gesture(modal, name);
    gesture(name, name, name);
    assert.equal(modal.style.display, "flex");
    assert.equal(devices.recorders[0].state, "recording");

    // A plain click on the backdrop still closes it.
    gesture(modal, modal);
    assert.equal(modal.style.display, "none");
    assert.equal(context.AppState.isRecording, false);
});

test("disabling a Material select also sets aria-disabled, so axe treats it as inactive", () => {
    const { context, element } = loadApp();
    const scheduling = element("fcScheduling");
    element("toolBehavior").value = "BLOCKING";
    context.toggleSchedulingDisable();
    assert.equal(scheduling.disabled, true);
    assert.equal(scheduling.attributes["aria-disabled"], "true");
    element("toolBehavior").value = "NON_BLOCKING";
    context.toggleSchedulingDisable();
    assert.equal(scheduling.disabled, false);
    assert.equal(scheduling.attributes["aria-disabled"], "false");

    context.AppUI.setSelectDisabled("s2stTargetLanguage", false);
    assert.equal(element("s2stTargetLanguage").attributes["aria-disabled"], "false");
    context.AppUI.setSelectDisabled("missing", true); // No element: no throw.
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

test("a malformed old settings cookie is skipped and deleted; restore goes on", async () => {
    const storage = fakeStorage();
    const app = loadApp({ localStorage: storage });
    const writes = [];
    Object.defineProperty(app.document, "cookie", {
        get: () => "CookieJar_systemInstructions=%E0%A4%A; CookieJar_location=us-east5",
        set: (value) => {
            writes.push(value);
        },
    });
    app.element("location").value = "us-central1";
    app.element("systemInstructions").value = "Page default";
    await app.context.restoreSettings();

    assert.deepEqual(
        writes.map((cookie) => cookie.split("=")[0]),
        ["CookieJar_systemInstructions", "CookieJar_location"]
    );
    assert.ok(writes.every((cookie) => cookie.includes("expires=Thu, 01 Jan 1970")));
    assert.equal(app.element("systemInstructions").value, "Page default");
    assert.equal(app.element("location").value, "us-east5");
    // Change listeners are attached, so later edits are saved.
    app.element("systemInstructions").value = "Edited";
    for (const listener of app.element("systemInstructions").listeners.input) listener();
    assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).systemInstructions, "Edited");
});

/** The "Start speaking" / text input path, with a microphone that starts when the test says. */
function loadSession(globals = {}) {
    const mic = { starts: [], fails: [] };
    const app = loadApp({
        navigator: {},
        performance,
        clearInterval, // Disconnect stops the connection timer.
        ...globals,
        requestAnimationFrame: () => 0, // Device lists refresh once the mic starts.
        LiveAudioInputManager: class {
            updateAudioInterval() {
                return new Promise((resolve, reject) => {
                    mic.starts.push(resolve);
                    mic.fails.push(reject);
                });
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

/** A session whose clock the test sets, and a way to deliver server events at a time. */
function loadLatencySession() {
    const clock = { now: 0 };
    const session = loadSession({ performance: { now: () => clock.now } });
    session.api.isSetupComplete = true;
    const at = (ms, type, data = "", extra = {}) => {
        clock.now = ms;
        session.context.handleReceiveResponse({ type, data, ...extra });
    };
    return { ...session, clock, at, latency: () => session.element("response-latency").textContent };
}

test("response latency counts from the server's end of speech; transcripts around it don't move it", () => {
    const { at, latency } = loadLatencySession();
    // As the real endpoint sends them: the transcript just before ACTIVITY_END.
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(1000, "INPUT_TRANSCRIPTION", "How much wood");
    at(1010, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1300, "INPUT_TRANSCRIPTION", " would a woodchuck chuck?"); // A trailing transcript.
    at(1560, "TEXT", "A lot.");
    assert.equal(latency(), "550 ms after end of speech");
});

test("speech that starts again before the model answers moves the end of the turn", () => {
    const { context, element, at, clock, latency } = loadLatencySession();
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(1000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1500, "VOICE_ACTIVITY", "ACTIVITY_START"); // A pause, not the end.
    at(1600, "INPUT_TRANSCRIPTION", "and then");
    at(3000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(3400, "TEXT", "So?");
    assert.equal(latency(), "400 ms after end of speech");

    // A typed message the model never answered doesn't count for the speech after it.
    at(4000, "END_OF_TURN");
    clock.now = 4500;
    element("text-message").value = "hello?";
    context.newUserMessage();
    at(5000, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(6000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(6250, "TEXT", "ok");
    assert.equal(latency(), "250 ms after end of speech");
});

test("with Start speaking, latency counts from Done speaking, not the server's echoed end of speech", async () => {
    const { context, element, at, clock, latency } = loadLatencySession();
    element("micBtn").hidden = false; // The mic is already on.
    await context.turnBtnClick();
    at(100, "VOICE_ACTIVITY", "ACTIVITY_START");
    clock.now = 2000;
    await context.turnBtnClick(); // Done speaking.
    at(2150, "INPUT_TRANSCRIPTION", "hello");
    at(2200, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(2600, "TEXT", "Hi.");
    assert.equal(latency(), "600 ms after Done speaking");
});

test("without voice activity frames, latency counts from the last input transcript", () => {
    const { at, latency } = loadLatencySession();
    at(1000, "INPUT_TRANSCRIPTION", "hello");
    at(1200, "INPUT_TRANSCRIPTION", " there");
    at(1500, "TEXT", "Hi.");
    assert.equal(latency(), "300 ms after last transcript");
});

test("speech over the model that it answers without an interruption gets its own latency", () => {
    const { context, at, latency } = loadLatencySession();
    context.AppState.liveAudioOutputManager.playAudioChunk = () => {};
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(1000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1200, "AUDIO", "");
    assert.equal(latency(), "200 ms after end of speech");
    // With interruption off, the user talks over the answer, which goes on.
    at(2000, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(2500, "INPUT_TRANSCRIPTION", "wait");
    at(3000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(3100, "INPUT_TRANSCRIPTION", ", stop"); // A trailing transcript.
    at(3200, "AUDIO", ""); // Still the first answer.
    assert.equal(latency(), "200 ms after end of speech");
    at(4000, "END_OF_TURN");
    at(4700, "AUDIO", "");
    assert.equal(latency(), "1,700 ms after end of speech");
    // Its own trailing transcripts don't start a turn.
    at(4800, "INPUT_TRANSCRIPTION", " please");
    at(5000, "END_OF_TURN");
    at(5500, "TEXT", "Anything else?");
    assert.equal(latency(), "1,700 ms after end of speech");
});

test("speech over the model whose end arrives before the interruption gets its own latency", () => {
    const { context, at, latency } = loadLatencySession();
    context.AppState.liveAudioOutputManager.clear = () => {};
    at(0, "TEXT", "Once upon a time");
    at(500, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(1500, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1550, "INTERRUPT");
    at(1900, "TEXT", "Yes?");
    assert.equal(latency(), "400 ms after end of speech");

    // The usual order: the interruption while the user is still speaking.
    at(3000, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(3100, "INTERRUPT");
    at(4000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(4250, "TEXT", "Sure.");
    assert.equal(latency(), "250 ms after end of speech");
});

test("an answer ended without speech over it leaves no turn end for the next answer", () => {
    const { at, latency } = loadLatencySession();
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(1000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1300, "TEXT", "Hi.");
    at(1400, "END_OF_TURN");
    at(5000, "TEXT", "Still there?"); // Unprompted; nothing to time it from.
    assert.equal(latency(), "300 ms after end of speech");
});

test("Start speaking over the model counts from Done speaking for the next answer", async () => {
    const { context, element, at, clock, latency } = loadLatencySession();
    element("micBtn").hidden = false; // The mic is already on.
    at(0, "TEXT", "Once upon a time");
    clock.now = 500;
    await context.turnBtnClick();
    clock.now = 1500;
    await context.turnBtnClick(); // Done speaking, before the server's echo.
    at(1600, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1700, "TEXT", " there was"); // With interruption off, the answer goes on.
    at(2000, "END_OF_TURN");
    at(2300, "TEXT", "Yes?");
    assert.equal(latency(), "800 ms after Done speaking");
});

/** Types and sends `text` at `ms` on a loadLatencySession() session. */
function typeAt({ context, element, clock }, ms, text) {
    clock.now = ms;
    element("text-message").value = text;
    context.newUserMessage();
}

test("text typed over the model's answer is timed when the model answers it after the interruption", () => {
    const session = loadLatencySession();
    const { context, at, latency } = session;
    context.AppState.liveAudioOutputManager.playAudioChunk = () => {};
    context.AppState.liveAudioOutputManager.clear = () => {};
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(500, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(800, "AUDIO", "");
    assert.equal(latency(), "300 ms after end of speech");
    typeAt(session, 1000, "wait, what about X?");
    at(1050, "AUDIO", ""); // Still the old answer.
    assert.equal(latency(), "300 ms after end of speech");
    at(1100, "INTERRUPT");
    at(1600, "AUDIO", "");
    assert.equal(latency(), "600 ms after text");
});

test("text typed over the model's answer is timed when the model answers it after the old answer ends", () => {
    const session = loadLatencySession();
    const { context, at, latency } = session;
    context.AppState.liveAudioOutputManager.playAudioChunk = () => {};
    at(0, "TEXT", "Once upon a time");
    typeAt(session, 1000, "and X?");
    at(1500, "TEXT", " there was"); // With interruption off, the answer goes on.
    at(2000, "END_OF_TURN");
    at(2600, "AUDIO", ""); // The answer to the text.
    assert.equal(latency(), "1,600 ms after text");
});

test("'hearing you' shows while the server hears speech, also over the model", () => {
    const { context, element, at } = loadLatencySession();
    const hearing = () => !element("hearing").hidden;
    context.AppState.liveAudioOutputManager.clear = () => {};
    element("hearing").hidden = true;
    element("connected").hidden = false;
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    assert.equal(hearing(), true);
    at(1000, "VOICE_ACTIVITY", "ACTIVITY_END");
    assert.equal(hearing(), false);

    at(1500, "TEXT", "Well,");
    assert.equal(element("speaking").hidden, false);
    at(2000, "VOICE_ACTIVITY", "ACTIVITY_START"); // The user talks over the model.
    assert.equal(hearing(), true);
    at(2100, "INTERRUPT"); // Still speaking: only ACTIVITY_END says it stopped.
    assert.equal(hearing(), true);
    at(3000, "VOICE_ACTIVITY", "ACTIVITY_END");
    assert.equal(hearing(), false);
});

test("'hearing you' clears when no ACTIVITY_END will come: Mic off, a GoAway resume, Disconnect", () => {
    const app = sessionWithBufferedAudio();
    const { context, element, api } = app;
    const hearing = () => !element("hearing").hidden;
    const start = () => context.handleReceiveResponse({ type: "VOICE_ACTIVITY", data: "ACTIVITY_START" });

    start();
    assert.equal(hearing(), true);
    context.micBtnClick();
    assert.equal(hearing(), false);
    start(); // Sent before the mic stopped: nothing will end it over WebRTC.
    assert.equal(hearing(), false);
    context.showMicState(true);

    start();
    assert.equal(hearing(), true);
    api.goAwayAction = () => "resume";
    api.resume = async () => {};
    context.AppState.liveVideoOutputManager.initMediaSource = () => {};
    context.handleReceiveResponse({ type: "GO_AWAY", data: "10s" });
    assert.equal(hearing(), false);

    start();
    assert.equal(hearing(), true);
    reconnect(app);
    assert.equal(hearing(), false);
});

test("connection age stops when a GoAway resume drops the connection and restarts with the new one", () => {
    const clock = { now: 0 };
    const intervals = new Map();
    let nextId = 1;
    const { context, element, api } = loadSession({
        performance: { now: () => clock.now },
        setInterval: (tick) => {
            intervals.set(nextId, tick);
            return nextId++;
        },
        clearInterval: (id) => intervals.delete(id),
    });
    const tick = (ms) => {
        clock.now = ms;
        for (const run of intervals.values()) run();
    };
    const age = () => element("connection-age").textContent;
    const resumes = [];
    api.goAwayAction = () => "resume";
    api.resume = async (handle) => resumes.push(handle);
    api.latestResumptionHandle = "handle-1";
    context.AppState.liveVideoOutputManager.initMediaSource = () => {};

    context.handleReceiveResponse({ type: "SETUP COMPLETE" });
    tick(75000);
    assert.equal(age(), "1:15");

    context.handleReceiveResponse({ type: "GO_AWAY", data: "10s" });
    assert.deepEqual(resumes, ["handle-1"]);
    assert.equal(age(), "--");
    assert.equal(intervals.size, 0);
    tick(80000); // Still resuming: the old connection's age doesn't come back.
    assert.equal(age(), "--");

    context.handleReceiveResponse({ type: "SETUP COMPLETE" });
    assert.equal(age(), "0:00");
    tick(83000);
    assert.equal(age(), "0:03");
    assert.equal(intervals.size, 1);
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

/** Disconnect, then Connect again, in a `loadSession()` app; the new session is set up. */
function reconnect({ context, element, api }) {
    api.disconnect = () => {
        api.isSetupComplete = false;
    };
    const { AppState } = context;
    AppState.micLevelMeter.stop = () => {};
    AppState.liveVideoManager.stopWebcam = () => {};
    AppState.liveScreenManager.stopCapture = () => {};
    AppState.liveAudioOutputManager.clear = () => {};
    Object.assign(AppState.liveVideoOutputManager, {
        getRecordings: () => [],
        clearRecordedChunks() {},
        resetPlayer() {},
    });
    context.endSession();
    element("disconnected").hidden = true;
    api.isSetupComplete = true;
}

test("Start speaking works in the next session while the last one's microphone prompt is still open", async () => {
    const app = loadSession();
    const { context, element, api, mic, dialogText } = app;
    api.isSetupComplete = true;
    element("micBtn").hidden = true; // The mic is off, so the click starts it.
    const stale = context.turnBtnClick();
    assert.equal(mic.starts.length, 1);
    reconnect(app);
    assert.equal(element("micBtn").hidden, true);

    const click = context.turnBtnClick();
    assert.equal(mic.starts.length, 2, "the click in the new session starts the microphone");
    mic.starts[1]();
    await click;
    assert.deepEqual(api.sent, [["activity", true]]);
    assert.equal(context.AppState.userTurnActive, true);
    assert.equal(element("turnBtn").textContent, "Done speaking");

    // The old prompt settling changes nothing in the new session.
    mic.starts[0]();
    await stale;
    assert.deepEqual(api.sent, [["activity", true]]);
    assert.equal(context.AppState.userTurnActive, true);
    assert.equal(context.AppState.turnStarting, false);
    assert.equal(dialogText(), undefined);
});

test("a microphone prompt from the last session doesn't start a turn in the next one", async () => {
    const app = loadSession();
    const { context, element, api, mic, dialogText } = app;
    api.isSetupComplete = true;
    element("micBtn").hidden = true;
    const stale = context.turnBtnClick();
    reconnect(app);
    element("micBtn").hidden = false; // The user turned the mic on in the new session.
    element("micOffBtn").hidden = true;

    mic.starts[0]();
    await stale;
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(context.AppState.turnStarting, false);
    assert.equal(dialogText(), undefined);

    await context.turnBtnClick(); // A click of its own still starts a turn.
    assert.deepEqual(api.sent, [["activity", true]]);
});

test("a session's last handle moves from the field into the chat when it ends", () => {
    const app = loadSession();
    const chat = [];
    app.element("text-chat").appendChild = (line) => chat.push(line.textContent);
    app.api.latestResumptionHandle = "server-handle";
    app.element("handle").value = "server-handle"; // RESUMPTION writes it there too.
    reconnect(app);
    assert.equal(app.element("handle").value, "");
    assert.deepEqual(chat, [
        "To resume this conversation later, enter this handle in Advanced Settings: server-handle",
    ]);

    reconnect(app); // Ending again (e.g. a late error) doesn't repeat it.
    assert.equal(chat.length, 1);
});

test("a pasted handle stays in the field when Connect fails or is cancelled", () => {
    const app = loadSession();
    const chat = [];
    app.element("text-chat").appendChild = (line) => chat.push(line.textContent);
    // connect() clears the last session's handle; this one never got one.
    app.api.latestResumptionHandle = "";
    app.element("handle").value = "pasted-handle";
    reconnect(app);
    assert.equal(app.element("handle").value, "pasted-handle");
    assert.deepEqual(chat, []);
});

test("a microphone that stops on its own ends the turn, turns the mic off and says why", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    api.disableDetection = true; // "Start speaking" is only shown then.
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

test("a failed capture worklet turns the mic off and says why; a failed player is reported in the chat", () => {
    const { context, element, mic, dialogText } = loadSession();
    const chat = [];
    element("text-chat").appendChild = (line) => chat.push(line.textContent);
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;
    mic.stops = 0;

    context.AppState.liveAudioInputManager.onMicrophoneFailed();
    assert.equal(element("micBtn").hidden, true);
    assert.equal(element("micOffBtn").hidden, false);
    assert.equal(mic.stops, 1);
    assert.match(dialogText(), /^The microphone stopped: the browser's audio processing for it failed/);

    context.AppState.liveAudioOutputManager.onPlayerError("The audio player stopped.");
    assert.deepEqual(chat, ["The audio player stopped."]);
});

test("switching to a microphone that fails mid-turn ends the turn and turns the mic off", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    api.disableDetection = true; // "Start speaking" is only shown then.
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;
    await context.turnBtnClick();
    assert.deepEqual(api.sent, [["activity", true]]);

    context.newMicSelected();
    mic.fails[0](new Error("Constraints could not be satisfied."));
    await flush();
    assert.deepEqual(api.sent, [["activity", true], ["activity", false]]);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(element("turnBtn").textContent, "Start speaking");
    assert.equal(element("micBtn").hidden, true);
    assert.equal(dialogText(), "Could not start the microphone: Constraints could not be satisfied.");
});

/** A `loadSession()` app whose mic has `buffered` audio waiting for the next send. */
function sessionWithBufferedAudio() {
    const app = loadSession();
    const { context, element, api } = app;
    api.isSetupComplete = true;
    element("micBtn").hidden = false; // The mic is on.
    element("micOffBtn").hidden = true;
    const input = context.AppState.liveAudioInputManager;
    input.buffered = true;
    input.recordChunk = () => {
        if (input.buffered) api.sent.push(["audio", "buffered"]);
        input.buffered = false;
    };
    return app;
}

test("Mic off sends the buffered audio and then audio_stream_end, so the last words get an answer", () => {
    const { context, element, api } = sessionWithBufferedAudio();
    context.micBtnClick();
    assert.deepEqual(api.sent, [["audio", "buffered"], ["audio_stream_end"]]);
    assert.equal(element("micBtn").hidden, true);

    // Already off (e.g. Disconnect after Mic off): nothing more is sent.
    context.micBtnClick();
    assert.equal(api.sent.length, 2);
});

test("a microphone that stops on its own ends the audio stream too", () => {
    const { context, api, dialogText } = sessionWithBufferedAudio();
    context.AppState.liveAudioInputManager.onMicrophoneEnded();
    assert.deepEqual(api.sent, [["audio", "buffered"], ["audio_stream_end"]]);
    assert.match(dialogText(), /^The microphone stopped: it was unplugged/);
});

test("audio_stream_end is only sent for WebSocket media with automatic activity detection", () => {
    // Manual activity: activity_end ends the turn instead.
    let app = sessionWithBufferedAudio();
    app.api.disableDetection = true;
    app.context.micBtnClick();
    assert.deepEqual(app.api.sent, []);

    // WebRTC: the audio is on the peer connection, whose track stopping ends it.
    app = sessionWithBufferedAudio();
    app.api.transportMode = "webrtc";
    app.api.webRtcManager = { stopMicrophone() {} };
    app.context.micBtnClick();
    assert.deepEqual(app.api.sent, []);

    // During a resume nothing can be sent; the new connection starts a new stream.
    app = sessionWithBufferedAudio();
    app.api.isSetupComplete = false;
    app.context.micBtnClick();
    assert.deepEqual(app.api.sent, []);
});

test("switching microphones sends the old one's buffered audio first", async () => {
    const { context, api, mic } = sessionWithBufferedAudio();
    context.newMicSelected();
    assert.deepEqual(api.sent, [["audio", "buffered"]]);
    mic.starts[0]();
    await flush();
    assert.deepEqual(api.sent, [["audio", "buffered"]], "the stream continues on the new mic");
});

test("Start speaking with the mic on sends the audio captured before the click ahead of activity_start", async () => {
    const { context, api } = sessionWithBufferedAudio();
    api.disableDetection = true; // "Start speaking" is only shown then.
    await context.turnBtnClick();
    assert.deepEqual(api.sent, [["audio", "buffered"], ["activity", true]]);
    assert.equal(context.AppState.userTurnActive, true);
});

test("Start speaking over WebRTC or during a resume flushes nothing ahead of the turn", async () => {
    // WebRTC: the mic's audio is on the peer connection, with nothing buffered here.
    let app = sessionWithBufferedAudio();
    app.api.transportMode = "webrtc";
    await app.context.turnBtnClick();
    assert.deepEqual(app.api.sent, [["activity", true]]);

    // During a resume the click is refused, and the buffered audio is sent later as usual.
    app = sessionWithBufferedAudio();
    app.api.isSetupComplete = false;
    await app.context.turnBtnClick();
    assert.deepEqual(app.api.sent, []);
    assert.equal(app.context.AppState.liveAudioInputManager.buffered, true);
});

/** A media error as Chrome throws it: a name and an empty message. */
function namedError(name, message = "") {
    return Object.assign(new Error(message), { name });
}

test("a microphone that isn't available says so, though Chrome's error has no message", async () => {
    const { context, element, mic, dialogText } = loadSession();
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;

    context.newMicSelected();
    mic.fails[0](namedError("OverconstrainedError")); // The picked device was unplugged.
    await flush();
    assert.equal(dialogText(), "Could not start the microphone: the selected device isn't available");
    assert.equal(element("micBtn").hidden, true);

    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;
    context.newMicSelected();
    mic.fails[1](namedError("NotReadableError"));
    await flush();
    assert.equal(dialogText(), "Could not start the microphone: NotReadableError");
});

test("camera and screen errors without a message name the error", async () => {
    let cameraError = null;
    let screenError = null;
    const { context, element } = loadApp({
        console: { error() {} },
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {}
            async startWebcam() {
                throw cameraError;
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {}
            async startCapture() {
                throw screenError;
            }
        },
    });
    const dialogText = () => element("dialogMessage").textContent;

    cameraError = namedError("OverconstrainedError");
    await context.startCameraCapture();
    assert.equal(dialogText(), "Could not start the camera: the selected device isn't available");
    cameraError = namedError("NotReadableError");
    await context.startCameraCapture();
    assert.equal(dialogText(), "Could not start the camera: NotReadableError");
    cameraError = "no camera"; // Not an Error at all.
    await context.startCameraCapture();
    assert.equal(dialogText(), "Could not start the camera: no camera");

    screenError = namedError("NotReadableError");
    await context.startScreenCapture();
    assert.equal(dialogText(), "Could not share the screen: NotReadableError");
    screenError = namedError("AbortError", "Starting videoinput failed");
    await context.startScreenCapture();
    assert.equal(dialogText(), "Could not share the screen: Starting videoinput failed");
});

test("a mic level meter that fails to start leaves the microphone on without it", async () => {
    const errors = [];
    let micStops = 0;
    const stream = { id: "mic" };
    const { context, element } = loadApp({
        navigator: {},
        requestAnimationFrame: () => 0,
        console: { error: (...args) => errors.push(args.map(String).join(" ")), log() {}, warn() {} },
        LiveAudioInputManager: class {
            stream = stream;
            async updateAudioInterval() {}
            recordChunk() {}
            disconnectMicrophone() {
                micStops++;
            }
        },
        MicLevelMeter: class {
            start(started) {
                assert.equal(started, stream);
                throw new Error("no audio device");
            }
            stop() {}
        },
    });
    context.AppState.geminiLiveApi.transportMode = "websocket";
    element("micLevel").hidden = true;

    context.micOffBtnClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(element("micBtn").hidden, false);
    assert.equal(element("micOffBtn").hidden, true);
    assert.equal(element("micLevel").hidden, true);
    assert.equal(micStops, 0);
    assert.equal(element("dialogMessage").textContent, undefined);
    assert.deepEqual(errors, ["Could not start the microphone level meter: Error: no audio device"]);
});

for (const transport of ["websocket", "webrtc"]) {
    test(`a ${transport} mic start superseded during its prompt leaves the level meter hidden`, async () => {
        // Each start waits on its own prompt; a superseded one ends without a
        // stream, as the real managers do after their generation check.
        const prompts = [];
        let liveStream = null;
        const startMic = async () => {
            liveStream = null;
            const prompt = Promise.withResolvers();
            prompts.push(prompt);
            const stream = await prompt.promise;
            if (prompt === prompts.at(-1)) liveStream = stream;
        };
        const meterStreams = [];
        const { context, element } = loadApp({
            navigator: {},
            requestAnimationFrame: () => 0,
            LiveAudioInputManager: class {
                get stream() {
                    return liveStream;
                }
                updateAudioInterval = startMic;
                recordChunk() {}
                disconnectMicrophone() {
                    liveStream = null;
                }
            },
            MicLevelMeter: class {
                start(stream) {
                    meterStreams.push(stream);
                }
                stop() {}
            },
        });
        const api = context.AppState.geminiLiveApi;
        api.transportMode = transport;
        if (transport === "webrtc") {
            api.webRtcManager = {
                get micStream() {
                    return liveStream;
                },
                startMicrophone: startMic,
                stopMicrophone() {
                    liveStream = null;
                },
            };
        }
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        element("micLevel").hidden = true;

        context.micOffBtnClick(); // Mic on: the first prompt opens.
        context.micBtnClick(); // Mic off...
        context.micOffBtnClick(); // ...and on again before answering it.
        await settle();
        assert.equal(prompts.length, 2);
        prompts[0].resolve({ id: "first" }); // The superseded prompt is granted.
        await settle();
        assert.equal(element("micLevel").hidden, true);
        assert.deepEqual(meterStreams, []);

        prompts[1].resolve({ id: "second" });
        await settle();
        assert.equal(element("micLevel").hidden, false);
        assert.deepEqual(
            meterStreams.map((stream) => stream.id),
            ["second"]
        );
    });
}

test("a resume that falls back to WebSocket media restarts the mic and camera frames over the WebSocket", async () => {
    const { GeminiLiveAPI } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        setInterval: () => 1,
        clearInterval() {},
    });
    const mic = { starts: 0, stops: 0 };
    const frames = { camera: 0, screen: 0 };
    const meterStreams = [];
    const { context, element } = loadApp({
        navigator: {},
        requestAnimationFrame: () => 0,
        GeminiLiveAPI,
        LiveAudioInputManager: class {
            stream = { id: "websocket mic" };
            async updateAudioInterval() {
                mic.starts++;
            }
            recordChunk() {}
            disconnectMicrophone() {
                mic.stops++;
            }
        },
        MicLevelMeter: class {
            start(stream) {
                meterStreams.push(stream);
            }
            stop() {}
        },
        LiveVideoManager: class extends FakeFrameSource {
            startSendingFrames() {
                frames.camera++;
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            startSendingFrames() {
                frames.screen++;
            }
        },
    });
    context.AppState.liveVideoOutputManager.initMediaSource = () => {};
    const api = context.AppState.geminiLiveApi;
    // A WebRTC session with the mic on; closing the peer connection stops its mic.
    let webRtcMicLive = true;
    api.webRtcManager = {
        close({ keepLocalMedia = false } = {}) {
            if (!keepLocalMedia) webRtcMicLive = false;
        },
        stopMicrophone() {},
    };
    api.transportMode = "webrtc";
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;

    api.fallBackToWebSocketMedia(); // The resumed session's setupComplete had no SDP answer.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(webRtcMicLive, false);
    assert.equal(mic.starts, 1, "the mic restarts on the WebSocket");
    assert.deepEqual(
        meterStreams.map((stream) => stream.id),
        ["websocket mic"]
    );
    assert.equal(element("micBtn").hidden, false);
    assert.deepEqual(frames, { camera: 1, screen: 1 });

    // With the mic off, the fallback leaves it off.
    element("micBtn").hidden = true;
    element("micOffBtn").hidden = false;
    api.transportMode = "webrtc";
    api.fallBackToWebSocketMedia();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mic.starts, 1);
});

/** loadApp with a WebRTC manager stand-in that records what it was told. */
function loadWithWebRtcManager(globals = {}) {
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
            recordChunk() {}
            disconnectMicrophone() {}
        },
        ...globals,
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

test("a camera that fails to start stops the WebRTC video the screen share or old camera was sending", async () => {
    const tracks = { screen: { kind: "video", readyState: "live" }, camera: { kind: "video", readyState: "live" } };
    let cameraError = null;
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager({
        console: { error() {} },
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {
                if (this.stream) tracks.camera.readyState = "ended";
                this.stream = null;
            }
            async startWebcam() {
                if (cameraError) throw cameraError;
                tracks.camera.readyState = "live";
                this.stream = { getVideoTracks: () => [tracks.camera] };
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                tracks.screen.readyState = "ended";
            }
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    webRtc.attachVideoStream = async (stream) => {
        webRtc.videoTrack = stream.getVideoTracks()[0];
    };

    // Screen shared, then the camera can't be opened.
    webRtc.videoTrack = tracks.screen;
    cameraError = new Error("Device in use");
    await context.startCameraCapture();
    assert.equal(tracks.screen.readyState, "ended");
    assert.deepEqual(webRtc.detached, [tracks.screen]);
    assert.equal(webRtc.videoTrack, null);
    assert.equal(dialogText(), "Could not start the camera: Device in use");
    assert.equal(element("cameraBtn").hidden, true);

    // Camera on, then a switch to a camera that can't be opened.
    cameraError = null;
    await context.startCameraCapture();
    assert.equal(webRtc.videoTrack, tracks.camera);
    cameraError = new Error("Device in use");
    await context.startCameraCapture();
    assert.equal(tracks.camera.readyState, "ended");
    assert.deepEqual(webRtc.detached, [tracks.screen, tracks.camera]);
    assert.equal(webRtc.videoTrack, null);
});

test("a camera or screen started over WebRTC sends frames if media falls back to the WebSocket during its prompt", async () => {
    const prompts = [];
    const prompt = () => {
        const pending = Promise.withResolvers();
        prompts.push(pending);
        return pending.promise;
    };
    const { context, element, webRtc } = loadWithWebRtcManager({
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {
                this.stream = null;
            }
            async startWebcam({ sendFrames }) {
                await prompt();
                this.stream = { getVideoTracks: () => [{ kind: "video" }] };
                if (sendFrames) this.startSendingFrames();
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                this.stream = null;
            }
            async startCapture({ sendFrames }) {
                await prompt();
                this.stream = { getVideoTracks: () => [{ kind: "video" }] };
                if (sendFrames) this.startSendingFrames();
                return true;
            }
        },
    });
    const api = context.AppState.geminiLiveApi;
    const camera = context.AppState.liveVideoManager;
    const screen = context.AppState.liveScreenManager;
    context.AppState.liveVideoOutputManager = { initMediaSource() {} };
    element("micBtn").hidden = true; // Mic off: the fallback leaves it alone.
    webRtc.attachVideoStream = async () => {};
    const fallBack = () => {
        api.transportMode = "websocket";
        api.onTransportFallback();
    };

    // Still WebRTC when the camera opens: the track goes over the peer connection.
    api.transportMode = "webrtc";
    const onWebRtc = context.startCameraCapture();
    prompts[0].resolve();
    await onWebRtc;
    assert.equal(camera.sendingFrames, false);

    // Falls back while the camera prompt is open.
    camera.stream = null;
    const camStart = context.startCameraCapture();
    fallBack();
    prompts[1].resolve();
    await camStart;
    assert.equal(camera.sendingFrames, true);

    // Same for the screen picker.
    api.transportMode = "webrtc";
    const screenStart = context.startScreenCapture();
    fallBack();
    prompts[2].resolve();
    await screenStart;
    assert.equal(screen.sendingFrames, true);
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

test("an earlier device-list refresh that finishes last doesn't replace a newer list", async () => {
    const enumerations = [];
    const { context, element, document } = loadApp({
        navigator: {
            mediaDevices: {
                enumerateDevices: () => {
                    const pending = Promise.withResolvers();
                    enumerations.push(pending.resolve);
                    return pending.promise;
                },
            },
        },
        requestAnimationFrame: () => 0,
    });
    // An md-select-option holds its label in a headline <div>.
    document.createElement = (tag) => {
        const node = fakeElement("");
        node.appendChild = (headline) => {
            node.textContent = headline.textContent;
        };
        return tag === "div" ? {} : node;
    };
    const options = (id) => {
        const select = element(id);
        select.children ??= [];
        select.replaceChildren = () => {
            select.children = [];
        };
        select.appendChild = (option) => select.children.push(option.textContent);
        return () => select.children;
    };
    const mics = options("audioSource");
    const cameras = options("cameraSource");
    const device = (kind, deviceId, label) => ({ kind, deviceId, label });
    const before = [device("audioinput", "mic", "Built-in mic")];
    const after = [...before, device("audioinput", "headset", "Headset"), device("videoinput", "cam", "Webcam")];

    // A device change starts a refresh; the headset's second change starts
    // another, and its enumeration (two calls: cameras and mics) answers first.
    const first = context.refreshDeviceLists();
    const second = context.refreshDeviceLists();
    assert.equal(enumerations.length, 4);
    enumerations[2](after);
    enumerations[3](after);
    await second;
    assert.deepEqual(plainJson(mics()), ["Built-in mic", "Headset"]);
    assert.deepEqual(plainJson(cameras()), ["Webcam"]);

    enumerations[0](before);
    enumerations[1](before);
    await first;
    assert.deepEqual(plainJson(mics()), ["Built-in mic", "Headset"]);
    assert.deepEqual(plainJson(cameras()), ["Webcam"]);
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
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "", mimeType: "image/png" });
    await choose({ name: "face.jpg", type: "image/jpeg", size: 3, bytes: "abc" });
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/jpeg" });
    assert.equal(element("avatarName").textContent, "Avatar: face.jpg");
});

test("a voice file over the size limit is refused before it is read", async () => {
    const { context, element } = loadApp({ OfflineAudioContext: fakeOfflineAudioContext(12), FileReader: FakeFileReader });
    let read = false;
    const file = {
        name: "huge.wav",
        size: 200 * 1024 * 1024 + 1,
        arrayBuffer: async () => {
            read = true;
            return new ArrayBuffer(8);
        },
    };
    await context.handleAudioFileInputChange({ target: { value: file.name, files: [file] } });
    assert.equal(read, false);
    assert.equal(
        element("dialogMessage").textContent,
        'Could not use "huge.wav" as a voice sample: it is 200.1 MB; files are limited to 200 MB.'
    );
    assert.equal(context.AppState.customVoiceBase64, "");
});

test("a function declarations file that can't be read is reported, and the same file can be picked again", async () => {
    // Reads through `file.text()`, like the browser's reader reads the file.
    class TextFileReader {
        readAsText(file) {
            file.text().then(
                (text) => {
                    this.result = text;
                    this.onload?.();
                },
                (error) => {
                    this.error = error;
                    this.onerror?.();
                }
            );
        }
    }
    const { context, element } = loadApp({
        FileReader: TextFileReader,
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            static toFunctionDeclarations = (json) => (Array.isArray(json) ? json : [json]);
        },
    });
    const notReadable = Object.assign(new Error("The requested file could not be read."), { name: "NotReadableError" });
    let contents = Promise.reject(notReadable);
    contents.catch(() => {});
    const input = { value: "tools.json", files: [{ name: "tools.json", text: () => contents }] };
    await context.handleFcFileInputChange({ target: input });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        element("dialogMessage").textContent,
        'Could not use "tools.json": the file can\'t be read (The requested file could not be read.)'
    );
    assert.equal(input.value, "");
    assert.equal(context.AppState.functionCallDefinition, null);

    contents = Promise.resolve('[{"name": "get_weather"}]');
    input.value = "tools.json";
    await context.handleFcFileInputChange({ target: input });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(element("dialogMessage").textContent, /^Loaded 1 function declaration\(s\) from "tools.json"/);
    assert.equal(element("fcFileName").textContent, "File: tools.json (get_weather)");
    assert.equal(input.value, "");
});

/** Records every message the app shows in its dialog. */
function recordDialogs(context) {
    const dialogs = [];
    const showModal = context.AppUI.showModal;
    context.AppUI.showModal = function (message) {
        dialogs.push(message);
        return showModal.call(this, message);
    };
    return dialogs;
}

test("the last avatar choice wins over a slower earlier one, which shows no dialog", async () => {
    let download = Promise.withResolvers();
    const { context, element } = loadApp({ FileReader: FakeFileReader, fetch: () => download.promise });
    const dialogs = recordDialogs(context);

    // "Use the sample image", then a file picked while the sample downloads.
    const sample = context.useSampleAvatar();
    const file = { name: "face.jpg", type: "image/jpeg", size: 3, bytes: "abc" };
    await context.handleAvatarFileInputChange({ target: { value: file.name, files: [file] } });
    download.resolve({ ok: true, blob: async () => ({ type: "image/png", size: 3, bytes: "png" }) });
    await sample;
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/jpeg" });
    assert.equal(element("avatarName").textContent, "Avatar: face.jpg");

    // A sample that fails after "Use the stock avatar" says nothing.
    download = Promise.withResolvers();
    const failing = context.useSampleAvatar();
    context.useStockAvatar();
    download.resolve({ ok: false, status: 500 });
    await failing;
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "", mimeType: "image/png" });
    assert.equal(element("avatarName").textContent, "Avatar: Piper (stock)");
    assert.deepEqual(dialogs, []);
});

test("an avatar chosen while connected applies from the next Connect, not the current session's resumes", async () => {
    const avatars = [];
    const { context, element } = loadApp({
        FileReader: FakeFileReader,
        getAvatarVideoElement: () => null, // From live-media-manager.js.
        // connectBtnClick configures the session through many setters.
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            constructor(...args) {
                super(...args);
                return new Proxy(this, { get: (target, name) => (name in target ? target[name] : () => {}) });
            }
            setCustomizedAvatar(image, mimeType) {
                avatars.push([image, mimeType]);
            }
        },
    });
    context.AppState.liveAudioOutputManager.resume = () => {};
    element("location").value = "us-central1";

    context.connectBtnClick();
    assert.deepEqual(plainJson(avatars), [["", "image/png"]]);
    // resume() rebuilds the setup from the API object, so a choice made now
    // must not reach it until the user connects again.
    const file = { name: "face.jpg", type: "image/jpeg", size: 3, bytes: "abc" };
    await context.handleAvatarFileInputChange({ target: { value: file.name, files: [file] } });
    assert.equal(element("avatarName").textContent, "Avatar: face.jpg");
    assert.equal(avatars.length, 1);

    context.connectBtnClick();
    assert.deepEqual(plainJson(avatars.slice(1)), [["YWJj", "image/jpeg"]]);
    context.useStockAvatar();
    assert.equal(avatars.length, 2);
    context.connectBtnClick();
    assert.deepEqual(plainJson(avatars.slice(2)), [["", "image/png"]]);
});

test("a voice file superseded by another file or a dropdown choice while it is read is dropped", async () => {
    const { context, element, document } = loadApp({ OfflineAudioContext: fakeOfflineAudioContext(12), FileReader: FakeFileReader });
    document.querySelector = (selector) => (selector.startsWith("#") ? element(selector.slice(1)) : null);
    context.initDOMEventListeners();
    const dropdown = element("voice-dropdown");
    const added = [];
    dropdown.appendChild = (option) => added.push(option.textContent);
    const dialogs = recordDialogs(context);
    const pick = (file) => context.handleAudioFileInputChange({ target: { value: file.name, files: [file] } });
    const slowFile = (name) => {
        const read = Promise.withResolvers();
        return { read, file: { name, size: 8, arrayBuffer: () => read.promise } };
    };

    const slow = slowFile("slow.wav");
    const first = pick(slow.file);
    await pick({ name: "fast.wav", size: 8, arrayBuffer: async () => new ArrayBuffer(8) });
    slow.read.resolve(new ArrayBuffer(8));
    await first;
    assert.deepEqual(added, ["fast.wav"]);
    assert.equal(dropdown.value, "custom-1");

    // A voice picked from the dropdown while a file is read stays selected.
    const later = slowFile("later.wav");
    const second = pick(later.file);
    dropdown.value = "Puck";
    for (const listener of dropdown.listeners.change) listener({ target: dropdown });
    later.read.resolve(new ArrayBuffer(8));
    await second;
    assert.deepEqual(added, ["fast.wav"]);
    assert.equal(dropdown.value, "Puck");
    assert.equal(context.AppState.customVoiceBase64, "");
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /^Branded voice "fast.wav" is selected/);
});

test("a function declarations file superseded by another file or Remove while it is read is dropped", async () => {
    const { context, element } = loadApp({
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            static toFunctionDeclarations = (json) => json;
        },
    });
    const dialogs = recordDialogs(context);
    const pick = (name, text) => context.handleFcFileInputChange({ target: { value: name, files: [{ name, text }] } });

    const slow = Promise.withResolvers();
    const first = pick("slow.json", () => slow.promise);
    await pick("tools.json", async () => '[{"name": "fast_fn"}]');
    slow.resolve('[{"name": "slow_fn"}]');
    await first;
    assert.equal(element("fcFileName").textContent, "File: tools.json (fast_fn)");
    assert.deepEqual(plainJson(context.AppState.functionCallDefinition), [{ name: "fast_fn" }]);

    // Remove during a read wins, and the read's later failure says nothing.
    const later = Promise.withResolvers();
    const second = pick("later.json", () => later.promise);
    context.removeFunctionDeclarations();
    later.reject(new Error("The operation was aborted."));
    await second;
    assert.equal(context.AppState.functionCallDefinition, null);
    assert.equal(element("fcFileName").textContent, "");
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /^Loaded 1 function declaration\(s\) from "tools.json"/);
});

test("a recording stops itself at the sample limit and is kept, cut to the limit", async () => {
    const devices = fakeRecordingDevices();
    const { timers } = devices;
    const renders = [];
    const OfflineAudioContext = class extends fakeOfflineAudioContext(300.02) {
        async startRendering() {
            renders.push(this.length);
            const samples = new Float32Array(1); // Rendering all 7.2 M samples only slows the test.
            return { numberOfChannels: 1, length: 1, sampleRate: this.sampleRate, getChannelData: () => samples };
        }
    };
    const { context, element } = loadApp({ ...devices.globals, OfflineAudioContext, FileReader: FakeFileReader, Blob });
    context.openModal();
    element("newVoiceName").value = "Kai";
    const click = context.handleRecordClick();
    devices.prompts[0].grant();
    await click;
    assert.match(element("recordStatus").textContent, /it stops at 5 min/);
    assert.deepEqual(plainJson(timers.map((t) => t.ms)), [300000]);

    timers[0].callback();
    assert.equal(devices.recorders[0].state, "inactive");
    assert.equal(context.AppState.isRecording, false);
    await flush();
    assert.equal(devices.prompts[0].track.stopped, true);
    assert.deepEqual(renders, [300 * 24000]);
    assert.ok(context.AppState.customVoiceBase64.length > 0);
    assert.equal(
        element("dialogMessage").textContent,
        'Recording stopped at the 5 min limit. New branded voice "Kai" has been created and selected. ' +
            "It applies from the next connection."
    );
});

test("closing the dialog cancels the recording's limit timer", async () => {
    const devices = fakeRecordingDevices();
    const { timers } = devices;
    const { context, element } = loadApp(devices.globals);
    context.openModal();
    element("newVoiceName").value = "Kai";
    const click = context.handleRecordClick();
    devices.prompts[0].grant();
    await click;
    context.closeModal();
    await flush();
    assert.equal(timers[0].cleared, true);
    timers[0].callback(); // Even if it had fired, it must not touch the closed dialog.
    assert.notEqual(element("recordStatus").textContent, "Processing recorded sample...");
});

test("Stop works after the voice name is cleared, and the voice keeps the name it started with", async () => {
    const devices = fakeRecordingDevices();
    const OfflineAudioContext = fakeOfflineAudioContext(12);
    const { context, element } = loadApp({ ...devices.globals, OfflineAudioContext, FileReader: FakeFileReader, Blob });
    const voices = [];
    element("voice-dropdown").appendChild = (option) => voices.push(option.textContent);
    context.openModal();
    element("newVoiceName").value = "Kai";
    const click = context.handleRecordClick();
    devices.prompts[0].grant();
    await click;
    context.AppState.recordingStartTime -= 11000; // Past the 10 s minimum.

    element("newVoiceName").value = "  ";
    await context.handleRecordClick();
    assert.equal(devices.recorders[0].state, "inactive");
    assert.equal(context.AppState.isRecording, false);
    await flush();
    assert.equal(devices.prompts[0].track.stopped, true);
    assert.ok(context.AppState.customVoiceBase64.length > 0);
    assert.deepEqual(voices, ["Kai"]);
    assert.match(element("dialogMessage").textContent, /^New branded voice "Kai" has been created/);

    // Starting a take still needs a name.
    context.openModal();
    await context.handleRecordClick();
    assert.equal(devices.prompts.length, 1);
    assert.equal(element("dialogMessage").textContent, "Please enter a name for the reference voice.");
});

test("a take the microphone ended is refused under 10 s and saved with a note past it", async () => {
    for (const [durationS, saved] of [
        [4, false],
        [12, true],
    ]) {
        const devices = fakeRecordingDevices();
        const OfflineAudioContext = fakeOfflineAudioContext(durationS);
        const { context, element } = loadApp({ ...devices.globals, OfflineAudioContext, FileReader: FakeFileReader, Blob });
        const voices = [];
        element("voice-dropdown").appendChild = (option) => voices.push(option.textContent);
        context.openModal();
        element("newVoiceName").value = "Kai";
        const click = context.handleRecordClick();
        devices.prompts[0].grant();
        await click;

        // The track ended, so the recorder stopped without a Stop click.
        devices.recorders[0].stop();
        await flush();
        assert.equal(devices.prompts[0].track.stopped, true, `${durationS} s`);
        assert.equal(devices.timers[0].cleared, true, `${durationS} s`);
        assert.equal(context.AppState.isRecording, false, `${durationS} s`);
        const message = element("dialogMessage").textContent;
        assert.match(message, new RegExp(`^The microphone stopped after ${durationS}\\.0 s: it was unplugged`));
        if (saved) {
            assert.deepEqual(voices, ["Kai"]);
            assert.ok(context.AppState.customVoiceBase64.length > 0);
            assert.match(message, /turned off\. New branded voice "Kai" has been created and selected\./);
        } else {
            assert.deepEqual(voices, []);
            assert.equal(context.AppState.customVoiceBase64, "");
            assert.match(message, /at least 10 seconds is required, so this one was discarded/);
            // Ready for another take under the same name.
            assert.equal(element("recordButton").disabled, false);
            assert.equal(element("recordStatus").textContent, "");
            assert.equal(element("newVoiceName").value, "Kai");
        }
    }
});

test("a take still processing when the dialog closes doesn't touch a newer recording", async () => {
    for (const outcome of ["decoded", "failed"]) {
        const devices = fakeRecordingDevices();
        let finishDecode;
        const OfflineAudioContext = class extends fakeOfflineAudioContext(12) {
            decodeAudioData() {
                return new Promise((resolve, reject) => {
                    finishDecode = () => (outcome === "decoded" ? resolve({ duration: 12 }) : reject(new Error("bad audio")));
                });
            }
        };
        const { context, element } = loadApp({ ...devices.globals, OfflineAudioContext, FileReader: FakeFileReader, Blob });
        context.openModal();
        element("newVoiceName").value = "First";
        const first = context.handleRecordClick();
        devices.prompts[0].grant();
        await first;
        context.AppState.recordingStartTime -= 11000; // Past the 10 s minimum.
        await context.handleRecordClick(); // Stop: the take is now decoding.
        await flush();

        // Close during "Processing...", reopen, and record again.
        context.closeModal();
        context.openModal();
        element("newVoiceName").value = "Second";
        const second = context.handleRecordClick();
        devices.prompts[1].grant();
        await second;
        element("dialogMessage").textContent = "";

        finishDecode();
        await flush();
        assert.equal(devices.recorders[1].state, "recording", outcome);
        assert.equal(devices.prompts[1].track.stopped, false, outcome);
        assert.equal(context.AppState.isRecording, true, outcome);
        assert.equal(context.AppState.customVoiceBase64, "", outcome);
        assert.equal(element("dialogMessage").textContent, "", outcome);
        context.closeModal();
        await flush();
        assert.equal(devices.prompts[1].track.stopped, true, outcome);
    }
});
