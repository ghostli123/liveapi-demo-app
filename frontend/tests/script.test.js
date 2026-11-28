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
        "loadSavedSettings",
        "restoreSettings",
        "handleEnvironmentChange",
        "handleModelChange",
        "newUserMessage",
        "turnBtnClick",
        "micOffBtnClick",
        "handleFunctionCallRequest",
        "handleSessionResumptionReconnect",
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
function fakeRecordingDevices({ deferStop = false } = {}) {
    const prompts = [];
    const recorders = [];
    const timers = [];
    const getUserMedia = () =>
        new Promise((resolve, reject) => {
            const track = { stopped: false, stop() { this.stopped = true; } };
            const stream = { track, getTracks: () => [track] };
            prompts.push({
                track,
                grant: () => resolve(stream),
                deny: (err = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })) =>
                    reject(err),
            });
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
            if (!deferStop) queueMicrotask(() => this.onstop());
        }
        finishStop() {
            return this.onstop();
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

test("handleModelChange syncs transportMode to websocket when switching prod-us-rep to prod", async () => {
    const storage = fakeStorage(
        new Map([[SETTINGS_KEY, JSON.stringify({ envApiHost: "prod-us-rep", transportMode: "webrtc" })]])
    );
    const { context, element } = await loadWithSettings(storage);
    element("location").value = "europe-west4";
    element("liveApiModel").value = "gemini-3.5-live-early-exp";
    context.handleModelChange();

    assert.equal(element("location").value, "us-central1");
    assert.equal(element("envApiHost").value, "prod");
    assert.equal(element("transportMode").value, "websocket");
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY));
    assert.equal(saved.envApiHost, "prod");
    assert.equal(saved.transportMode, "websocket");
    assert.equal(saved.preferredTransport, "webrtc");

    // Switching back to prod-us-rep (even after a reload) restores webrtc.
    const reloaded = await loadWithSettings(fakeStorage(storage.items));
    assert.equal(reloaded.element("envApiHost").value, "prod");
    assert.equal(reloaded.element("transportMode").value, "websocket");
    reloaded.element("envApiHost").value = "prod-us-rep";
    reloaded.context.handleEnvironmentChange();
    assert.equal(reloaded.element("transportMode").value, "webrtc");

    // Works before restoreSettings populates preferredTransport too.
    const fresh = loadApp({ localStorage: fakeStorage() });
    fresh.element("envApiHost").value = "prod-us-rep";
    fresh.element("transportMode").value = "webrtc";
    fresh.element("liveApiModel").value = "gemini-3.5-live-early-exp";
    fresh.context.handleModelChange();
    assert.equal(fresh.element("envApiHost").value, "prod");
    assert.equal(fresh.element("transportMode").value, "websocket");
    assert.equal(fresh.context.AppState.preferredTransport, "webrtc");
});

test("restoreSettings reconciles a saved WebSocket-only environment with webrtc transport", async () => {
    const storage = fakeStorage(
        new Map([[SETTINGS_KEY, JSON.stringify({ envApiHost: "prod", transportMode: "webrtc" })]])
    );
    const { context, element } = await loadWithSettings(storage);

    assert.equal(element("envApiHost").value, "prod");
    assert.equal(element("transportMode").value, "websocket");
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY));
    assert.equal(saved.transportMode, "websocket");
    assert.equal(saved.preferredTransport, "webrtc");

    element("envApiHost").value = "prod-us-rep";
    context.handleEnvironmentChange();
    assert.equal(element("transportMode").value, "webrtc");
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

test("loadSavedSettings ignores non-object localStorage JSON and preserves cookie migration", async () => {
    for (const raw of ["123", '"abc"', "true", "[1,2]", "null", "false", "0", '""']) {
        const storage = fakeStorage(new Map([[SETTINGS_KEY, raw]]));
        const app = loadApp({ localStorage: storage });
        const saved = app.context.loadSavedSettings();
        assert.equal(typeof saved, "object", `raw=${raw} should yield an object`);
        assert.notEqual(saved, null, `raw=${raw} should not yield null`);
        assert.equal(Array.isArray(saved), false, `raw=${raw} should not yield an array`);
        assert.deepEqual(JSON.parse(JSON.stringify(saved)), {});

        const writes = [];
        Object.defineProperty(app.document, "cookie", {
            get: () => "CookieJar_location=europe-west1; CookieJar_systemInstructions=Be%20brief",
            set: (value) => {
                writes.push(value);
            },
        });
        Object.assign(app.element("location"), {
            value: "us-central1",
            options: [{ value: "us-central1" }, { value: "europe-west1" }],
        });
        app.element("systemInstructions").value = "Page default";

        await app.context.restoreSettings();
        assert.equal(app.element("location").value, "europe-west1", `raw=${raw} dropped CookieJar_location`);
        assert.equal(
            app.element("systemInstructions").value,
            "Be brief",
            `raw=${raw} dropped CookieJar_systemInstructions`
        );
        assert.deepEqual(
            writes.map((cookie) => cookie.split("=")[0]),
            ["CookieJar_systemInstructions", "CookieJar_location"]
        );
        const persisted = JSON.parse(storage.getItem(SETTINGS_KEY));
        assert.equal(persisted.location, "europe-west1");
        assert.equal(persisted.systemInstructions, "Be brief");
    }

    // A valid saved object still takes precedence over legacy cookies.
    const validStorage = fakeStorage(
        new Map([[SETTINGS_KEY, JSON.stringify({ location: "us-west1", enableAvatarMode: false })]])
    );
    const validApp = loadApp({ localStorage: validStorage });
    validApp.document.cookie = "CookieJar_location=europe-west1; CookieJar_systemInstructions=From%20cookie";
    const merged = validApp.context.loadSavedSettings();
    assert.deepEqual(JSON.parse(JSON.stringify(merged)), {
        location: "us-west1",
        enableAvatarMode: false,
        systemInstructions: "From cookie",
    });
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

test("late ACTIVITY_START after Mic off or Done speaking doesn't clear turnEndedAt or re-show hearing you", async () => {
    const { context, element, api, at, clock, latency } = loadLatencySession();
    const hearing = () => !element("hearing").hidden;
    element("hearing").hidden = true;
    element("connected").hidden = false;
    element("micBtn").hidden = false;
    api.disableDetection = true;

    // Manual turn ended by Mic off before the server's echoed ACTIVITY_START arrives.
    clock.now = 1000;
    await context.turnBtnClick();
    clock.now = 1050;
    context.micBtnClick();
    at(1250, "VOICE_ACTIVITY", "ACTIVITY_START");
    assert.equal(hearing(), false);
    at(1450, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(1650, "TEXT", "Hi.");
    assert.equal(latency(), "600 ms after Done speaking");

    // Manual turn ended by Done speaking (mic stays on) before the echoed ACTIVITY_START arrives.
    at(1700, "END_OF_TURN");
    context.showMicState(true);
    clock.now = 2000;
    await context.turnBtnClick();
    clock.now = 2100;
    await context.turnBtnClick();
    at(2250, "VOICE_ACTIVITY", "ACTIVITY_START");
    assert.equal(hearing(), false);
    at(2350, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(2600, "TEXT", "Sure.");
    assert.equal(latency(), "500 ms after Done speaking");

    // Automatic detection: late ACTIVITY_START after Mic off doesn't wipe a recorded transcript end.
    at(2700, "END_OF_TURN");
    api.disableDetection = false;
    at(3000, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(3100, "INPUT_TRANSCRIPTION", "hello");
    clock.now = 3150;
    context.micBtnClick();
    at(3200, "VOICE_ACTIVITY", "ACTIVITY_START");
    assert.equal(hearing(), false);
    at(3500, "TEXT", "Hey.");
    assert.equal(latency(), "400 ms after last transcript");
});

test("empty OUTPUT_TRANSCRIPTION frames don't mark model speaking or responding, but still close finished output lines", () => {
    const { element, at, latency } = loadLatencySession();
    const lines = [];
    element("text-chat").appendChild = (line) => {
        line.isConnected = true;
        lines.push(line);
    };
    element("connected").hidden = false;
    element("speaking").hidden = true;

    // Empty output transcription while the user is speaking doesn't close the
    // open input line, show "model speaking", or consume the pending turn end.
    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(500, "INPUT_TRANSCRIPTION", "hello");
    at(600, "OUTPUT_TRANSCRIPTION", "", { finished: false });
    assert.equal(element("speaking").hidden, true);
    assert.equal(element("connected").hidden, false);
    at(700, "INPUT_TRANSCRIPTION", " world");
    at(800, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(850, "OUTPUT_TRANSCRIPTION", "", { finished: true });
    assert.equal(element("speaking").hidden, true);
    assert.deepEqual(lines.map((l) => l.textContent), ["You: hello world"]);

    // First real output transcript measures latency, closes input, and marks speaking.
    at(1100, "OUTPUT_TRANSCRIPTION", "Hi there.", { finished: false });
    assert.equal(latency(), "300 ms after end of speech");
    assert.equal(element("speaking").hidden, false);
    assert.equal(element("connected").hidden, true);

    // An empty finish-only frame mid-turn still closes the output transcript line.
    at(1200, "OUTPUT_TRANSCRIPTION", "", { finished: true });
    assert.equal(element("speaking").hidden, false);
    at(1300, "OUTPUT_TRANSCRIPTION", "More.", { finished: false });
    assert.deepEqual(lines.map((l) => l.textContent), [
        "You: hello world",
        "Gemini: Hi there.",
        "Gemini: More.",
    ]);

    // After END_OF_TURN, a trailing empty finish-only frame must not re-enable
    // "model speaking" or set responding=true (which would drop the next turn's latency).
    at(1400, "END_OF_TURN");
    assert.equal(element("speaking").hidden, true);
    assert.equal(element("connected").hidden, false);
    at(1500, "OUTPUT_TRANSCRIPTION", "", { finished: true });
    assert.equal(element("speaking").hidden, true);
    assert.equal(element("connected").hidden, false);

    // Next user turn still records its latency cleanly.
    at(2000, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(2500, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(2750, "OUTPUT_TRANSCRIPTION", "Next.", { finished: true });
    assert.equal(latency(), "250 ms after end of speech");
    assert.equal(element("speaking").hidden, false);
    assert.deepEqual(lines.map((l) => l.textContent), [
        "You: hello world",
        "Gemini: Hi there.",
        "Gemini: More.",
        "Gemini: Next.",
    ]);
});

test("empty OUTPUT_TRANSCRIPTION finish frame after INTERRUPT leaves speaking badge off and next turn timed", () => {
    const { context, element, at, latency } = loadLatencySession();
    context.AppState.liveAudioOutputManager.clear = () => {};
    element("connected").hidden = false;
    element("speaking").hidden = true;

    at(0, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(500, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(800, "OUTPUT_TRANSCRIPTION", "First answer", { finished: false });
    assert.equal(element("speaking").hidden, false);
    assert.equal(latency(), "300 ms after end of speech");

    at(1000, "INTERRUPT");
    assert.equal(element("speaking").hidden, true);
    assert.equal(element("connected").hidden, false);
    at(1050, "OUTPUT_TRANSCRIPTION", "", { finished: true });
    assert.equal(element("speaking").hidden, true);
    assert.equal(element("connected").hidden, false);

    at(1500, "VOICE_ACTIVITY", "ACTIVITY_START");
    at(2000, "VOICE_ACTIVITY", "ACTIVITY_END");
    at(2200, "OUTPUT_TRANSCRIPTION", "Second answer", { finished: true });
    assert.equal(latency(), "200 ms after end of speech");
    assert.equal(element("speaking").hidden, false);
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
    AppState.liveAudioOutputManager.close = () => {};
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

test("turning the mic off cancels a pending Start speaking prompt and ignores it if Mic On follows", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    element("micBtn").hidden = true;
    element("micOffBtn").hidden = false;

    const first = context.turnBtnClick();
    assert.equal(mic.starts.length, 1);
    assert.equal(context.AppState.turnStarting, true);

    // Cancelling with Mic Off clears turnStarting immediately so a new Start speaking click works.
    context.micBtnClick();
    assert.equal(context.AppState.turnStarting, false);

    const second = context.turnBtnClick();
    assert.equal(mic.starts.length, 2, "a new Start speaking click starts a fresh mic prompt");
    assert.equal(context.AppState.turnStarting, true);

    // The first prompt settling while the second is pending doesn't send activity_start or clear turnStarting.
    mic.starts[0]();
    await first;
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(context.AppState.turnStarting, true);

    // Cancel the second prompt and turn the mic on normally; the stale second prompt must not start a turn.
    context.micBtnClick();
    assert.equal(context.AppState.turnStarting, false);
    context.micOffBtnClick();
    assert.equal(mic.starts.length, 3);

    mic.starts[1]();
    await second;
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(context.AppState.turnStarting, false);
    assert.equal(dialogText(), undefined);

    mic.starts[2]();
    await Promise.resolve();
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
});

test("a GoAway resume cancels a pending Start speaking prompt so it doesn't start a turn on the new connection", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    api.resume = async () => {
        api.isSetupComplete = false;
    };
    context.AppState.liveVideoOutputManager.initMediaSource = () => {};
    element("micBtn").hidden = true;
    element("micOffBtn").hidden = false;

    const stale = context.turnBtnClick();
    assert.equal(mic.starts.length, 1);
    assert.equal(context.AppState.turnStarting, true);

    await context.handleSessionResumptionReconnect();
    assert.equal(context.AppState.turnStarting, false);

    // New connection finishes setup before the pre-resume mic prompt is answered.
    api.isSetupComplete = true;
    mic.starts[0]();
    await stale;
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(context.AppState.turnStarting, false);
    assert.equal(dialogText(), undefined);

    // A fresh Start speaking click on the resumed connection works normally.
    await context.turnBtnClick();
    assert.deepEqual(api.sent, [["activity", true]]);
    assert.equal(context.AppState.userTurnActive, true);
});

test("switching the microphone cancels a pending Start speaking prompt", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true;
    element("micBtn").hidden = true;
    element("micOffBtn").hidden = false;

    const stale = context.turnBtnClick();
    assert.equal(mic.starts.length, 1);
    assert.equal(context.AppState.turnStarting, true);

    element("audioSource").value = "mic-2";
    context.newMicSelected();
    assert.equal(mic.starts.length, 2);
    assert.equal(context.AppState.turnStarting, false);

    // Stale prompt #0 resolves before prompt #1: must not start a turn.
    mic.starts[0]();
    await stale;
    assert.deepEqual(api.sent, []);
    assert.equal(context.AppState.userTurnActive, false);
    assert.equal(context.AppState.turnStarting, false);
    assert.equal(dialogText(), undefined);

    // Prompt #1 resolves; a fresh Start speaking click now starts the turn.
    mic.starts[1]();
    await Promise.resolve();
    await context.turnBtnClick();
    assert.deepEqual(api.sent, [["activity", true]]);
    assert.equal(context.AppState.userTurnActive, true);
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

    // Once disconnected, late player errors do not append into the ended session's chat.
    element("disconnected").hidden = false;
    context.AppState.liveAudioOutputManager.onPlayerError("Late post-disconnect player error.");
    assert.deepEqual(chat, ["The audio player stopped."]);
});

test("endSession() closes the audio output manager and suppresses post-disconnect player errors", () => {
    const app = loadSession();
    const { context, element, api } = app;
    const chat = [];
    element("text-chat").appendChild = (line) => chat.push(line.textContent);
    let closed = 0;
    let cleared = 0;
    api.disconnect = () => {
        api.isSetupComplete = false;
    };
    const { AppState } = context;
    AppState.micLevelMeter.stop = () => {};
    AppState.liveVideoManager.stopWebcam = () => {};
    AppState.liveScreenManager.stopCapture = () => {};
    AppState.liveAudioOutputManager.clear = () => {
        cleared++;
    };
    AppState.liveAudioOutputManager.close = () => {
        closed++;
    };
    Object.assign(AppState.liveVideoOutputManager, {
        getRecordings: () => [],
        clearRecordedChunks() {},
        resetPlayer() {},
    });

    context.endSession();
    assert.equal(closed, 1);
    assert.equal(cleared, 0);
    assert.equal(element("disconnected").hidden, false);

    AppState.liveAudioOutputManager.onPlayerError("The audio player stopped.");
    assert.deepEqual(chat, []);
});

test("the avatar video recording limit is reported in the chat", () => {
    const { context, element } = loadSession();
    const chat = [];
    element("text-chat").appendChild = (line) => chat.push([line.className, line.textContent]);
    context.AppState.liveVideoOutputManager.onRecordingLimit("Stopped saving the avatar video at 512 MB.");
    assert.equal(chat.length, 1);
    assert.match(chat[0][0], /chat-system/);
    assert.equal(chat[0][1], "Stopped saving the avatar video at 512 MB.");
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
    input.processor = {}; // Its capture node is connected: audio is being sent.
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

test("a failed microphone switch ends the old mic's audio stream", async () => {
    const { context, element, api, mic, dialogText } = sessionWithBufferedAudio();
    context.newMicSelected();
    mic.fails[0](new Error("Constraints could not be satisfied."));
    await flush();
    assert.deepEqual(api.sent, [["audio", "buffered"], ["audio_stream_end"]]);
    assert.equal(element("micBtn").hidden, true);
    assert.equal(dialogText(), "Could not start the microphone: Constraints could not be satisfied.");
});

test("a microphone that fails to start sends no audio_stream_end: no audio was sent", async () => {
    const { context, element, api, mic, dialogText } = loadSession();
    api.isSetupComplete = true; // Automatic activity detection, WebSocket media.
    element("micBtn").hidden = true; // The mic is off.
    element("micOffBtn").hidden = false;
    context.micOffBtnClick();
    assert.equal(element("micBtn").hidden, false, "shown as on during the permission prompt");
    mic.fails[0](new Error("Permission denied"));
    await flush();
    assert.deepEqual(api.sent, []);
    assert.equal(element("micBtn").hidden, true);
    assert.equal(dialogText(), "Could not start the microphone: Permission denied");

    // A later Mic off click (already off) sends nothing either.
    context.micBtnClick();
    assert.deepEqual(api.sent, []);
});

test("overlapped WebSocket mic switches still send audio_stream_end when the replacement fails", async () => {
    const { context, element, api, mic, dialogText } = sessionWithBufferedAudio();
    const input = context.AppState.liveAudioInputManager;
    // Like the real LiveAudioInputManager: updateAudioInterval() disconnects the
    // old capture node (clearing processor) before awaiting the replacement mic.
    let gen = 0;
    input.disconnectMicrophone = () => {
        gen++;
        input.processor = null;
        mic.stops = (mic.stops || 0) + 1;
    };
    input.updateAudioInterval = () => {
        input.disconnectMicrophone();
        const myGen = gen;
        return new Promise((resolve, reject) => {
            mic.starts.push(() => {
                if (myGen === gen) input.processor = {};
                resolve();
            });
            mic.fails.push((err) => {
                if (myGen !== gen) return resolve();
                reject(err);
            });
        });
    };

    // Switch A -> B: disconnects A (processor becomes null) without ending the stream.
    context.newMicSelected();
    assert.equal(input.processor, null);
    assert.deepEqual(api.sent, [["audio", "buffered"]]);

    // While B is pending, switch to C which fails: A's open stream must still end.
    context.newMicSelected();
    mic.fails[1](namedError("OverconstrainedError"));
    await flush();
    assert.deepEqual(api.sent, [["audio", "buffered"], ["audio_stream_end"]]);
    assert.equal(element("micBtn").hidden, true);
    assert.equal(dialogText(), "Could not start the microphone: the selected device isn't available");

    // Superseded B settling later leaves no active stream, so a new failed start sends none.
    mic.starts[0]();
    await flush();
    assert.equal(input.processor, null);
    context.micOffBtnClick();
    mic.fails[2](new Error("Permission denied"));
    await flush();
    assert.deepEqual(api.sent, [["audio", "buffered"], ["audio_stream_end"]]);
});

test("Mic off during a pending switch ends the active stream, not a pending initial start", async () => {
    // Pending initial start cancelled with Mic off: no audio was sent.
    let app = loadSession();
    app.api.isSetupComplete = true;
    app.element("micBtn").hidden = true;
    app.element("micOffBtn").hidden = false;
    app.context.micOffBtnClick();
    app.context.micBtnClick();
    assert.deepEqual(app.api.sent, []);

    // Pending switch from an active mic cancelled with Mic off: ends the old mic's stream.
    app = sessionWithBufferedAudio();
    const input = app.context.AppState.liveAudioInputManager;
    const origUpdate = input.updateAudioInterval.bind(input);
    input.updateAudioInterval = () => {
        input.processor = null;
        return origUpdate();
    };
    app.context.newMicSelected();
    assert.equal(input.processor, null);
    app.context.micBtnClick();
    assert.deepEqual(app.api.sent, [["audio", "buffered"], ["audio_stream_end"]]);
});

test("a GoAway resume while a mic switch is pending doesn't send audio_stream_end on the new connection", async () => {
    const app = sessionWithBufferedAudio();
    const { context, api, mic } = app;
    const input = context.AppState.liveAudioInputManager;
    const origUpdate = input.updateAudioInterval.bind(input);
    input.updateAudioInterval = () => {
        input.processor = null;
        return origUpdate();
    };
    api.resume = async () => {};
    context.AppState.liveVideoOutputManager.initMediaSource = () => {};

    // Start switching from active Mic A to pending Mic B.
    context.newMicSelected();
    assert.deepEqual(api.sent, [["audio", "buffered"]]);

    // Session resumes on a fresh connection before B finishes; A never streamed on it.
    await context.handleSessionResumptionReconnect();
    api.isSetupComplete = true;

    mic.fails[0](new Error("Permission denied"));
    await flush();
    assert.deepEqual(api.sent, [["audio", "buffered"]]);
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

test("an insecure page says why at load, and why the camera can't start", async () => {
    // Plain http from another machine: browsers hide navigator.mediaDevices,
    // so getUserMedia fails with a TypeError about undefined.
    const loadHandlers = [];
    const window = {
        location: { protocol: "http:", host: "192.168.1.5:8080" },
        isSecureContext: false,
        addEventListener: (type, handler) => type === "load" && loadHandlers.push(handler),
    };
    const { context, element } = loadApp({
        window,
        console: { log() {}, warn() {}, error() {} },
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {}
            async startWebcam() {
                throw new TypeError("Cannot read properties of undefined (reading 'getUserMedia')");
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {}
        },
    });
    const dialogText = () => element("dialogMessage").textContent;
    let shown = 0;
    element("dialog").show = () => shown++;

    assert.equal(loadHandlers.length, 1);
    loadHandlers[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shown, 1);
    assert.match(dialogText(), /^This page was opened over plain http from another machine/);
    assert.match(dialogText(), /HTTPS, or at http:\/\/localhost/);

    await context.startCameraCapture();
    assert.equal(
        dialogText(),
        "Could not start the camera: browsers allow it only on pages opened over HTTPS or at http://localhost"
    );

    // A secure page (HTTPS or localhost) shows nothing at load.
    window.isSecureContext = true;
    loadHandlers.length = 0;
    const secure = loadApp({ window, console: { log() {}, warn() {}, error() {} }, navigator: {}, requestAnimationFrame: () => 0 });
    let secureShown = 0;
    secure.element("dialog").show = () => secureShown++;
    loadHandlers[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secureShown, 0);
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
    let attachCalls = 0;
    webRtc.attachVideoStream = async (stream) => {
        attachCalls++;
        webRtc.videoTrack = stream.getVideoTracks()[0];
    };
    const fallBack = () => {
        api.transportMode = "websocket";
        webRtc.videoTrack = null;
        api.onTransportFallback();
    };

    // Still WebRTC when the camera opens: the track goes over the peer connection.
    api.transportMode = "webrtc";
    const onWebRtc = context.startCameraCapture();
    prompts[0].resolve();
    await onWebRtc;
    assert.equal(camera.sendingFrames, false);
    assert.equal(attachCalls, 1);
    assert.ok(webRtc.videoTrack);

    // Falls back while the camera prompt is open: sends frames, doesn't attach to the closed manager.
    camera.stream = null;
    const camStart = context.startCameraCapture();
    fallBack();
    prompts[1].resolve();
    await camStart;
    assert.equal(camera.sendingFrames, true);
    assert.equal(attachCalls, 1);
    assert.equal(webRtc.videoTrack, null);

    // Same for the screen picker.
    api.transportMode = "webrtc";
    const screenStart = context.startScreenCapture();
    fallBack();
    prompts[2].resolve();
    await screenStart;
    assert.equal(screen.sendingFrames, true);
    assert.equal(attachCalls, 1);
    assert.equal(webRtc.videoTrack, null);
});

test("startScreenCapture handles attachVideoStream failures by stopping the share, detaching video, and showing a dialog", async () => {
    const tracks = { camera: { kind: "video", readyState: "live" }, screen: { kind: "video", readyState: "live" } };
    let stopCaptureCalls = 0;
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager({
        console: { error() {} },
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {
                if (this.stream) tracks.camera.readyState = "ended";
                this.stream = null;
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                stopCaptureCalls++;
                if (this.stream) tracks.screen.readyState = "ended";
                this.stream = null;
            }
            async startCapture() {
                tracks.screen.readyState = "live";
                this.stream = { getVideoTracks: () => [tracks.screen] };
                return true;
            }
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    context.AppState.liveVideoManager.stream = { getVideoTracks: () => [tracks.camera] };
    element("cameraBtn").hidden = false;
    webRtc.videoTrack = tracks.camera;
    webRtc.attachVideoStream = async () => {
        throw Object.assign(new Error("sender rejected track"), { name: "InvalidModificationError" });
    };

    await context.startScreenCapture();

    assert.equal(stopCaptureCalls, 1);
    assert.equal(tracks.screen.readyState, "ended");
    assert.equal(tracks.camera.readyState, "ended");
    assert.equal(context.AppState.liveScreenManager.stream, null);
    assert.equal(context.AppState.liveScreenManager.sendingFrames, false);
    assert.equal(element("cameraBtn").hidden, true);
    assert.deepEqual(webRtc.detached, [tracks.camera]);
    assert.equal(webRtc.videoTrack, null);
    assert.equal(dialogText(), "Could not share the screen: sender rejected track");
});

test("superseded startCameraCapture and startScreenCapture attachVideoStream failures do not detach the active video source", async () => {
    const camTrack = { kind: "video", id: "cam-1", readyState: "live" };
    const scrTrack = { kind: "video", id: "scr-1", readyState: "live" };
    const camTrack2 = { kind: "video", id: "cam-2", readyState: "live" };
    let camStarts = 0;
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager({
        console: { error() {} },
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {
                this.stream = null;
            }
            async startWebcam() {
                const track = camStarts++ === 0 ? camTrack : camTrack2;
                this.stream = { getVideoTracks: () => [track] };
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                this.stream = null;
            }
            async startCapture() {
                this.stream = { getVideoTracks: () => [scrTrack] };
                return true;
            }
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    const attaches = [];
    webRtc.attachVideoStream = (stream) => {
        webRtc.videoTrack = stream.getVideoTracks()[0];
        const deferred = Promise.withResolvers();
        attaches.push(deferred);
        return deferred.promise;
    };

    // F1a: camera attach hangs, screen share takes over and attaches, then stale camera attach rejects.
    const tick = () => new Promise((r) => setImmediate(r));
    const cam1 = context.startCameraCapture();
    await tick();
    assert.equal(attaches.length, 1);

    const scr1 = context.startScreenCapture();
    await tick();
    assert.equal(attaches.length, 2);
    attaches[1].resolve();
    await scr1;
    assert.equal(webRtc.videoTrack, scrTrack);

    attaches[0].reject(new Error("InvalidStateError: camera track stopped"));
    await cam1;
    assert.equal(webRtc.videoTrack, scrTrack);
    assert.deepEqual(webRtc.detached, []);
    assert.equal(dialogText(), undefined);

    // F1b: screen share attach hangs, camera takes over and attaches, then stale screen attach rejects.
    const scr2 = context.startScreenCapture();
    await tick();
    assert.equal(attaches.length, 3);

    element("cameraBtn").hidden = false;
    const cam2 = context.startCameraCapture();
    await tick();
    assert.equal(attaches.length, 4);
    attaches[3].resolve();
    await cam2;
    assert.equal(webRtc.videoTrack, camTrack2);

    attaches[2].reject(new Error("InvalidStateError: screen track stopped"));
    await scr2;
    assert.equal(webRtc.videoTrack, camTrack2);
    assert.deepEqual(webRtc.detached, []);
    assert.equal(element("cameraBtn").hidden, false);
    assert.equal(dialogText(), undefined);

    // Turning the camera off while attachVideoStream is pending suppresses a stale attach rejection.
    const cam3 = context.startCameraCapture();
    await tick();
    assert.equal(attaches.length, 5);
    context.cameraBtnClick();
    attaches[4].reject(new Error("sender closed"));
    await cam3;
    assert.equal(dialogText(), undefined);
});

test("superseded startCameraCapture during getUserMedia does not re-attach the newer camera, and a cancelled screen picker leaves camera in flight", async () => {
    const prompts = [];
    let screenCancel = false;
    const camTracks = [
        { kind: "video", id: "cam-1" },
        { kind: "video", id: "cam-2" },
        { kind: "video", id: "cam-3" },
    ];
    let enumerateCalls = 0;
    const { context, webRtc } = loadWithWebRtcManager({
        navigator: {
            mediaDevices: {
                async enumerateDevices() {
                    enumerateCalls++;
                    return [];
                },
            },
        },
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            constructor(...args) {
                super(...args);
                this.generation = 0;
            }
            stopWebcam() {
                this.generation++;
                this.stream = null;
            }
            async startWebcam() {
                const gen = ++this.generation;
                const deferred = Promise.withResolvers();
                prompts.push({ gen, deferred, track: camTracks[prompts.length] });
                await deferred.promise;
                if (gen !== this.generation) return;
                this.stream = { getVideoTracks: () => [camTracks[prompts.findIndex((p) => p.gen === gen)]] };
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                this.stream = null;
            }
            async startCapture() {
                if (screenCancel) throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
                return false;
            }
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    let attachCalls = 0;
    webRtc.attachVideoStream = async (stream) => {
        attachCalls++;
        webRtc.videoTrack = stream.getVideoTracks()[0];
    };

    // Two overlapping camera starts: second finishes first, first finishes late and must be a no-op.
    const cam1 = context.startCameraCapture();
    const cam2 = context.startCameraCapture();
    assert.equal(prompts.length, 2);
    prompts[1].deferred.resolve();
    await cam2;
    assert.equal(attachCalls, 1);
    assert.equal(webRtc.videoTrack, camTracks[1]);
    const enumAfterSecond = enumerateCalls;

    prompts[0].deferred.resolve();
    await cam1;
    assert.equal(attachCalls, 1);
    assert.equal(enumerateCalls, enumAfterSecond);

    // Cancelling the screen picker while a camera prompt is open must not invalidate the camera start.
    screenCancel = true;
    const cam3 = context.startCameraCapture();
    assert.equal(prompts.length, 3);
    await context.startScreenCapture();
    prompts[2].deferred.resolve();
    await cam3;
    assert.equal(attachCalls, 2);
    assert.equal(webRtc.videoTrack, camTracks[2]);
});

test("superseded WebRTC startAudioInput replaceTrack failure does not stop the newer mic or show a dialog", async () => {
    const starts = [];
    let stopMicCalls = 0;
    let meterStarts = 0;
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager({
        console: { error() {} },
        navigator: {},
        requestAnimationFrame: () => 0,
        MicLevelMeter: class {
            start() {
                meterStarts++;
            }
            stop() {}
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    webRtc.startMicrophone = () => {
        const stream = { id: `mic-${starts.length + 1}` };
        webRtc.micStream = stream;
        const deferred = Promise.withResolvers();
        starts.push({ stream, deferred });
        return deferred.promise;
    };
    webRtc.stopMicrophone = () => {
        stopMicCalls++;
        webRtc.micStream = null;
    };

    // Mic 1 hangs in replaceTrack, mic 2 supersedes and succeeds, then mic 1 rejects.
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;
    const mic1 = context.startAudioInput();
    const mic2 = context.startAudioInput();
    assert.equal(starts.length, 2);
    starts[1].deferred.resolve();
    await mic2;
    assert.equal(meterStarts, 1);

    starts[0].deferred.reject(new Error("InvalidStateError: track stopped"));
    await mic1;
    assert.equal(element("micBtn").hidden, false);
    assert.equal(webRtc.micStream, starts[1].stream);
    assert.equal(stopMicCalls, 0);
    assert.equal(dialogText(), undefined);

    // Turning the mic off while startMicrophone is pending also suppresses a late rejection.
    const mic3 = context.startAudioInput();
    context.micBtnClick();
    assert.equal(stopMicCalls, 1);
    starts[2].deferred.reject(new Error("track stopped"));
    await mic3;
    assert.equal(dialogText(), undefined);
});

test("superseded startAudioInput during getUserMedia does not restart MicLevelMeter or mark WebSocket stream active", async () => {
    const prompts = [];
    let meterStarts = 0;
    const { context, element } = loadApp({
        navigator: {},
        requestAnimationFrame: () => 0,
        MicLevelMeter: class {
            start() {
                meterStarts++;
            }
            stop() {}
        },
        LiveAudioInputManager: class {
            constructor() {
                this.generation = 0;
                this.stream = null;
                this.processor = null;
            }
            recordChunk() {}
            disconnectMicrophone() {
                this.generation++;
                this.stream = null;
                this.processor = null;
            }
            async updateAudioInterval() {
                this.disconnectMicrophone();
                const gen = ++this.generation;
                const deferred = Promise.withResolvers();
                prompts.push({ gen, deferred });
                await deferred.promise;
                if (gen !== this.generation) return;
                this.stream = { id: `ws-mic-${gen}` };
                this.processor = { id: gen };
            }
        },
    });
    const api = context.AppState.geminiLiveApi;
    api.transportMode = "websocket";
    api.isSetupComplete = true;
    element("micBtn").hidden = false;
    element("micOffBtn").hidden = true;

    // Overlapped mic switch: second resolves first, first resolves late and must not restart the meter.
    const mic1 = context.startAudioInput();
    const mic2 = context.startAudioInput();
    assert.equal(prompts.length, 2);
    prompts[1].deferred.resolve();
    await mic2;
    assert.equal(meterStarts, 1);
    assert.equal(context.AppState.wsAudioStreamActive, true);

    prompts[0].deferred.resolve();
    await mic1;
    assert.equal(meterStarts, 1);

    // Stopping the mic while a start is pending prevents it from marking wsAudioStreamActive when it resolves.
    const mic3 = context.startAudioInput();
    context.stopAudioInput();
    assert.equal(context.AppState.wsAudioStreamActive, false);
    prompts[2].deferred.resolve();
    await mic3;
    assert.equal(context.AppState.wsAudioStreamActive, false);
    assert.equal(meterStarts, 1);
});

/**
 * A connected session whose function-response simulator answers when the test
 * says; `timers` holds the callbacks script.js scheduled.
 */
function loadFunctionCalls({ abortRejects = true } = {}) {
    const timers = [];
    const errors = [];
    const controllers = [];
    class TrackedAbortController extends AbortController {
        constructor() {
            super();
            controllers.push(this);
        }
    }
    const app = loadApp({
        AbortController: TrackedAbortController,
        clearInterval() {},
        setTimeout: (callback, ms) => timers.push({ callback, ms }) - 1,
        clearTimeout: (id) => {
            if (timers[id]) timers[id].cleared = true;
        },
        console: {
            log() {},
            warn() {},
            error: (...args) =>
                errors.push(
                    args
                        .map((a) => {
                            try {
                                return String(a);
                            } catch {
                                return "[unprintable]";
                            }
                        })
                        .join(" ")
                ),
        },
    });
    const { AppState } = app.context;
    const api = AppState.geminiLiveApi;
    api.webSocket = {};
    api.sessionId = "s-1";
    api.frUrl = "/api/post_endpoint";
    // Match real GeminiLiveAPI: disconnect() clears webSocket but keeps sessionId.
    api.disconnect = () => {
        api.webSocket = null;
        api.isSetupComplete = false;
    };
    api.resume = async () => {
        api.webSocket = null;
        api.sessionId = "s-2";
        api.isSetupComplete = false;
    };
    AppState.micLevelMeter.stop = () => {};
    AppState.liveAudioInputManager.disconnectMicrophone = () => {};
    AppState.liveVideoManager.stopWebcam = () => {};
    AppState.liveScreenManager.stopCapture = () => {};
    AppState.liveAudioOutputManager.clear = () => {};
    AppState.liveAudioOutputManager.close = () => {};
    Object.assign(AppState.liveVideoOutputManager, {
        getRecordings: () => [],
        clearRecordedChunks() {},
        resetPlayer() {},
        initMediaSource() {},
    });
    const posts = [];
    api.sendPostRequest = (url, data, { signal }) =>
        new Promise((resolve, reject) => {
            posts.push({ name: data.functionName, signal, resolve, reject });
            if (abortRejects) {
                signal.addEventListener("abort", () => reject(new Error("aborted")));
            }
        });
    api.sendMessage = (message) => api.sent.push(message);
    const chat = [];
    app.element("text-chat").appendChild = (line) => chat.push(line.textContent);
    return { ...app, api, posts, timers, chat, errors, controllers };
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

test("endSession() aborts in-flight function-simulator calls, clears timers, and posts no failure", async () => {
    const { context, api, posts, timers, chat, errors } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([
        { id: "c1", name: "slow", args: {} },
        { id: "c2", name: "next", args: {} },
    ]);
    assert.equal(posts.length, 1);

    context.endSession();
    await done;

    assert.equal(posts.length, 1, "subsequent call in batch must not start after endSession");
    assert.equal(posts[0].signal.aborted, true);
    assert.equal(posts[0].signal.reason, "disconnected");
    assert.equal(timers[0].cleared, true);
    assert.deepEqual(api.sent, []);
    assert.deepEqual(
        chat.filter((line) => /failed:|connection was replaced/i.test(line)),
        []
    );
    assert.deepEqual(errors, []);
});

test("a late 404 after endSession() posts no function-failed error, even for calls without an ID", async () => {
    const { context, api, posts, chat, errors } = loadFunctionCalls({ abortRejects: false });
    const doneWithId = context.handleFunctionCallRequest([{ id: "c1", name: "withId", args: {} }]);
    const doneNoId = context.handleFunctionCallRequest([{ name: "noId", args: {} }]);
    assert.equal(posts.length, 2);

    context.endSession();
    assert.equal(posts[0].signal.aborted, true);
    assert.equal(posts[1].signal.aborted, true);

    posts[0].reject(new Error("HTTP 404: Unknown session"));
    posts[1].reject(new Error("HTTP 404: Unknown session"));
    await Promise.all([doneWithId, doneNoId]);

    assert.deepEqual(api.sent, []);
    assert.deepEqual(
        chat.filter((line) => /failed:|connection was replaced/i.test(line)),
        []
    );
    assert.deepEqual(errors, []);
});

test("reconnecting right after endSession() does not post a connection-replaced notice for old calls", async () => {
    const { context, element, api, posts, chat, errors } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "slow", args: {} }]);

    context.endSession();
    // Simulate an immediate Connect before handleFunctionCallRequest resumes.
    element("disconnected").hidden = true;
    api.webSocket = {};
    api.sessionId = "s-2";
    await done;

    assert.equal(posts[0].signal.aborted, true);
    assert.deepEqual(api.sent, []);
    assert.deepEqual(
        chat.filter((line) => /failed:|connection was replaced/i.test(line)),
        []
    );
    assert.deepEqual(errors, []);
});

test("a GoAway resume aborts in-flight simulator calls immediately and posts the connection-replaced notice", async () => {
    const { context, api, posts, timers, chat, errors } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([
        { id: "c1", name: "slow", args: {} },
        { id: "c2", name: "next", args: {} },
    ]);
    assert.equal(posts.length, 1);

    await context.handleSessionResumptionReconnect();
    await done;

    assert.equal(posts.length, 1, "subsequent call in batch must not start after resume");
    assert.equal(posts[0].signal.aborted, true);
    assert.equal(posts[0].signal.reason, "replaced");
    assert.equal(timers[0].cleared, true);
    assert.deepEqual(api.sent, []);
    assert.deepEqual(
        chat.filter((line) => /failed:/i.test(line)),
        []
    );
    assert.ok(
        chat.some((line) => /The connection was replaced while function calls were running/.test(line)),
        `expected connection-replaced notice, got: ${JSON.stringify(chat)}`
    );
    assert.deepEqual(errors, []);
});

test("endSession() after a simulator timeout still suppresses the stale chat error and replaced notice", async () => {
    const { context, element, api, posts, timers, chat } = loadFunctionCalls({ abortRejects: false });
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "hung", args: {} }]);

    // Timer fires first (locking signal.reason to "timeout"), then Disconnect + Connect happen
    // before the request rejection settles.
    timers[0].callback();
    assert.equal(posts[0].signal.reason, "timeout");
    context.endSession();
    element("disconnected").hidden = true;
    api.webSocket = {};
    api.sessionId = "s-2";
    posts[0].reject(new Error("aborted"));
    await done;

    assert.deepEqual(api.sent, []);
    assert.deepEqual(
        chat.filter((line) => /failed:|connection was replaced/i.test(line)),
        []
    );
});

test("cancelling a timed-out call mid-batch omits it from toolResponse", async () => {
    const { context, api, posts, timers } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([
        { id: "c1", name: "hung", args: {} },
        { id: "c2", name: "next", args: {} },
    ]);
    assert.equal(posts.length, 1);

    // c1 times out (locking signal.reason to "timeout") and c2 begins.
    timers[0].callback();
    await settle();
    assert.equal(posts.length, 2);
    assert.equal(posts[0].signal.reason, "timeout");

    // Server cancels c1 while c2 is still running.
    context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c1"] });
    posts[1].resolve({ response: "ok" });
    await done;

    assert.deepEqual(
        plainJson(api.sent.map((m) => m.toolResponse.functionResponses.map((r) => r.id))),
        [["c2"]]
    );
});

test("cancelling every call after an earlier call timed out sends no toolResponse and suppresses replaced notice", async () => {
    const { context, api, posts, timers, chat } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([
        { id: "c1", name: "hung", args: {} },
        { id: "c2", name: "next", args: {} },
    ]);
    timers[0].callback();
    await settle();
    assert.equal(posts.length, 2);

    context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c1", "c2"] });
    await done;
    assert.deepEqual(api.sent, []);

    // Also when a GoAway resume replaces the socket after all calls were cancelled.
    const replaced = loadFunctionCalls({ abortRejects: false });
    const done2 = replaced.context.handleFunctionCallRequest([
        { id: "c1", name: "hung", args: {} },
        { id: "c2", name: "next", args: {} },
    ]);
    replaced.timers[0].callback();
    replaced.posts[0].reject(new Error("aborted"));
    await settle();
    assert.equal(replaced.posts.length, 2);

    replaced.context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c1", "c2"] });
    await replaced.context.handleSessionResumptionReconnect();
    replaced.posts[1].reject(new Error("aborted"));
    await done2;

    assert.deepEqual(replaced.api.sent, []);
    assert.deepEqual(
        replaced.chat.filter((line) => /connection was replaced/i.test(line)),
        []
    );
    assert.ok(chat.includes("Function calls cancelled: c1, c2"));
});

test("cancelling a call after its timeout fired but before rejection settles suppresses failure and response", async () => {
    const { context, api, posts, timers, chat } = loadFunctionCalls({ abortRejects: false });
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "hung", args: {} }]);

    timers[0].callback();
    assert.equal(posts[0].signal.reason, "timeout");
    context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c1"] });
    posts[0].reject(new Error("aborted"));
    await done;

    assert.deepEqual(api.sent, []);
    assert.deepEqual(
        chat.filter((line) => /failed:/i.test(line)),
        []
    );
});

test("fcScheduling is snapshotted at Connect and ignores mid-session select changes", async () => {
    const posts = [];
    const app = loadApp({
        AbortController,
        clearInterval() {},
        setTimeout: () => 0,
        clearTimeout() {},
        getAvatarVideoElement: () => null,
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            constructor(...args) {
                super(...args);
                return new Proxy(this, { get: (target, name) => (name in target ? target[name] : () => {}) });
            }
        },
    });
    const { context, element } = app;
    const { AppState } = context;
    const api = AppState.geminiLiveApi;
    AppState.liveAudioOutputManager.resume = () => {};
    AppState.liveVideoOutputManager.clearRecordedChunks = () => {};
    AppState.liveVideoOutputManager.getRecordings = () => [];
    element("text-chat").appendChild = () => {};
    element("location").value = "us-central1";
    api.sendPostRequest = (url, data, { signal }) =>
        new Promise((resolve) => {
            posts.push({ name: data.functionName, signal, resolve });
        });
    api.sendMessage = (message) => api.sent.push(message);

    // Connect with NON_BLOCKING + INTERRUPT, then change the selects mid-session.
    element("toolBehavior").value = "NON_BLOCKING";
    element("fcScheduling").value = "INTERRUPT";
    context.connectBtnClick();

    api.webSocket = {};
    api.sessionId = "s-1";
    element("fcScheduling").value = "SILENT";
    element("toolBehavior").value = "BLOCKING";

    const first = context.handleFunctionCallRequest([{ id: "c1", name: "lookup", args: {} }]);
    posts[0].resolve({ response: "ok" });
    await first;
    assert.deepEqual(plainJson(api.sent[0].toolResponse.functionResponses[0].response), {
        result: { response: "ok" },
        scheduling: "INTERRUPT",
    });
    assert.equal(api.toolBehavior, "NON_BLOCKING");
    assert.equal(api.fcScheduling, "INTERRUPT");

    // Reconnecting with SILENT + NON_BLOCKING picks up the new snapshot.
    element("toolBehavior").value = "NON_BLOCKING";
    element("fcScheduling").value = "SILENT";
    context.connectBtnClick();
    api.webSocket = {};
    api.sessionId = "s-2";
    element("fcScheduling").value = "WHEN_IDLE";

    const second = context.handleFunctionCallRequest([{ id: "c2", name: "lookup", args: {} }]);
    posts[1].resolve({ response: "ok2" });
    await second;
    assert.deepEqual(plainJson(api.sent[1].toolResponse.functionResponses[0].response), {
        result: { response: "ok2" },
        scheduling: "SILENT",
    });

    // Reconnecting with BLOCKING omits scheduling even if the select changes mid-session.
    element("toolBehavior").value = "BLOCKING";
    element("fcScheduling").value = "INTERRUPT";
    context.connectBtnClick();
    api.webSocket = {};
    api.sessionId = "s-3";
    element("toolBehavior").value = "NON_BLOCKING";

    const third = context.handleFunctionCallRequest([{ id: "c3", name: "lookup", args: {} }]);
    posts[2].resolve({ response: "ok3" });
    await third;
    assert.deepEqual(plainJson(api.sent[2].toolResponse.functionResponses[0].response), {
        result: { response: "ok3" },
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
        this.onload?.();
        this.onloadend?.();
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

test("empty avatar images are refused and parameterized or uppercase MIME types are normalized", async () => {
    let readerCalls = 0;
    class CountingFileReader extends FakeFileReader {
        readAsDataURL(blob) {
            readerCalls++;
            return super.readAsDataURL(blob);
        }
    }
    let sampleBlob = { type: "IMAGE/PNG; charset=binary", size: 3, bytes: "png" };
    const { context, element } = loadApp({
        FileReader: CountingFileReader,
        fetch: async () => ({ ok: true, blob: async () => sampleBlob }),
    });
    const dialogs = recordDialogs(context);
    element("avatarStockLink").hidden = true;
    element("avatarName").textContent = "Avatar: Piper (stock)";

    // A 0-byte file is refused before reading and leaves the stock avatar untouched.
    await context.handleAvatarFileInputChange({
        target: { value: "empty.png", files: [{ name: "empty.png", type: "image/png", size: 0, bytes: "" }] },
    });
    assert.equal(readerCalls, 0);
    assert.deepEqual(dialogs.splice(0), ['Could not use "empty.png" as the avatar: the image is empty.']);
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "", mimeType: "image/png" });
    assert.equal(element("avatarName").textContent, "Avatar: Piper (stock)");
    assert.equal(element("avatarStockLink").hidden, true);

    // Parameterized uppercase MIME types (e.g. from fetch Content-Type) are accepted and normalized.
    await context.useSampleAvatar();
    assert.deepEqual(dialogs.splice(0), []);
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "cG5n", mimeType: "image/png" });
    assert.equal(element("avatarName").textContent, "Avatar: sample image");
    assert.equal(element("avatarStockLink").hidden, false);

    await context.handleAvatarFileInputChange({
        target: {
            value: "pic.webp",
            files: [{ name: "pic.webp", type: "  Image/WebP ; version=1 ", size: 3, bytes: "abc" }],
        },
    });
    assert.deepEqual(dialogs.splice(0), []);
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/webp" });
    assert.equal(element("avatarName").textContent, "Avatar: pic.webp");

    // Empty base64 (even with non-zero reported size) is refused and keeps the previous avatar.
    await context.handleAvatarFileInputChange({
        target: { value: "blank.png", files: [{ name: "blank.png", type: "image/png", size: 4, bytes: "" }] },
    });
    assert.deepEqual(dialogs.splice(0), ['Could not use "blank.png" as the avatar: the image is empty.']);
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/webp" });
    assert.equal(element("avatarName").textContent, "Avatar: pic.webp");

    // A 0-byte sample response is refused and keeps the previous avatar.
    sampleBlob = { type: "image/png; charset=binary", size: 0, bytes: "" };
    await context.useSampleAvatar();
    assert.deepEqual(dialogs.splice(0), ["Could not load the sample avatar image: the image is empty."]);
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/webp" });
    assert.equal(element("avatarName").textContent, "Avatar: pic.webp");

    // Non-string MIME type is cleanly rejected with the unsupported-type message.
    await context.handleAvatarFileInputChange({
        target: { value: "notype.png", files: [{ name: "notype.png", type: null, size: 3, bytes: "abc" }] },
    });
    assert.deepEqual(dialogs.splice(0), [
        'Could not use "notype.png" as the avatar: use a PNG, JPEG or WebP image.',
    ]);
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/webp" });
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

test("a function declarations file over the size limit is refused before it is read and keeps prior declarations", async () => {
    const { context, element } = loadApp({
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            static toFunctionDeclarations = (json) => (Array.isArray(json) ? json : [json]);
        },
    });
    const dialogs = recordDialogs(context);

    // Load a file right at the 512 KB limit first.
    const atLimitInput = {
        value: "at_limit.json",
        files: [{ name: "at_limit.json", size: 512 * 1024, text: async () => '[{"name": "ok_fn"}]' }],
    };
    await context.handleFcFileInputChange({ target: atLimitInput });
    assert.deepEqual(plainJson(context.AppState.functionCallDefinition), [{ name: "ok_fn" }]);
    assert.equal(element("fcFileName").textContent, "File: at_limit.json (ok_fn)");
    assert.equal(element("fcRemove").hidden, false);

    // A file 1 byte over the limit is refused without calling file.text(), keeping the prior upload.
    let read = false;
    const hugeInput = {
        value: "huge.json",
        files: [
            {
                name: "huge.json",
                size: 512 * 1024 + 1,
                text: async () => {
                    read = true;
                    return '[{"name": "never_read"}]';
                },
            },
        ],
    };
    await context.handleFcFileInputChange({ target: hugeInput });
    assert.equal(read, false);
    assert.equal(hugeInput.value, "");
    assert.equal(
        dialogs.at(-1),
        'Could not use "huge.json": it is 513 KB; files are limited to 512 KB.'
    );
    assert.deepEqual(plainJson(context.AppState.functionCallDefinition), [{ name: "ok_fn" }]);
    assert.equal(element("fcFileName").textContent, "File: at_limit.json (ok_fn)");

    // Picking an oversized file also supersedes an earlier slow read in flight.
    const slow = Promise.withResolvers();
    const slowPick = context.handleFcFileInputChange({
        target: { value: "slow.json", files: [{ name: "slow.json", size: 64, text: () => slow.promise }] },
    });
    await context.handleFcFileInputChange({
        target: { value: "oversized.json", files: [{ name: "oversized.json", size: 600 * 1024, text: async () => "[]" }] },
    });
    slow.resolve('[{"name": "stale_fn"}]');
    await slowPick;
    assert.deepEqual(plainJson(context.AppState.functionCallDefinition), [{ name: "ok_fn" }]);
    assert.equal(element("fcFileName").textContent, "File: at_limit.json (ok_fn)");
    assert.equal(dialogs.length, 3);
    assert.equal(
        dialogs[2],
        'Could not use "oversized.json": it is 600 KB; files are limited to 512 KB.'
    );
});

test("function declarations with empty or whitespace-only names are refused and keep prior declarations", async () => {
    const { context, element } = loadApp({
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            static toFunctionDeclarations = (json) => {
                const list = Array.isArray(json) ? json : Array.isArray(json?.tools) ? json.tools : [json];
                return list.map((entry) =>
                    entry && entry.type === "function" && entry.function ? entry.function : entry
                );
            };
        },
    });
    const pick = async (name, body) => {
        const input = { value: name, files: [{ name, size: body.length, text: async () => body }] };
        await context.handleFcFileInputChange({ target: input });
        return element("dialogMessage").textContent;
    };

    // Seed a valid declaration so we verify rejections leave it intact.
    await pick("valid.json", '[{"name": " get_weather "}]');
    assert.equal(element("fcFileName").textContent, "File: valid.json (get_weather)");

    for (const [filename, body] of [
        ["empty_name.json", '[{"name": ""}]'],
        ["spaces_name.json", '[{"name": "   "}]'],
        ["tabs_name.json", '[{"name": "\\t\\n"}]'],
        ["mixed.json", '[{"name": "good_fn"}, {"name": "   "}]'],
        ["openai_blank.json", '{"tools": [{"type": "function", "function": {"name": "  "}}]}'],
    ]) {
        const dialog = await pick(filename, body);
        assert.equal(
            dialog,
            `Could not use "${filename}": expected a list of function declarations, each with a non-empty name`
        );
        assert.deepEqual(plainJson(context.AppState.functionCallDefinition), [{ name: " get_weather " }]);
        assert.equal(element("fcFileName").textContent, "File: valid.json (get_weather)");
    }
});

test("handleFcFileInputChange loads Gemini functionDeclarations tool wrappers and rejects empty or unnamed wrappers", async () => {
    const { GeminiLiveAPI: RealGeminiLiveAPI } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        window: {},
        document: {},
        performance: { now: () => 0 },
    });
    const { context, element } = loadApp({
        GeminiLiveAPI: class extends FakeGeminiLiveAPI {
            static toFunctionDeclarations = (json) => RealGeminiLiveAPI.toFunctionDeclarations(json);
        },
    });
    const pick = async (name, body) => {
        const input = { value: name, files: [{ name, size: body.length, text: async () => body }] };
        await context.handleFcFileInputChange({ target: input });
        return element("dialogMessage").textContent;
    };

    for (const [filename, body, expectedNames] of [
        [
            "camel.json",
            '{"functionDeclarations": [{"name": "get_weather"}, {"name": "set_alarm"}]}',
            ["get_weather", "set_alarm"],
        ],
        [
            "snake.json",
            '{"function_declarations": [{"name": "lookup_order"}]}',
            ["lookup_order"],
        ],
        [
            "tools_wrapper.json",
            '{"tools": [{"functionDeclarations": [{"name": "book_table"}]}, {"function_declarations": [{"name": "cancel_table"}]}]}',
            ["book_table", "cancel_table"],
        ],
        [
            "tool_list.json",
            '[{"function_declarations": [{"name": "check_stock"}]}]',
            ["check_stock"],
        ],
    ]) {
        const dialog = await pick(filename, body);
        assert.match(dialog, new RegExp(`^Loaded ${expectedNames.length} function declaration\\(s\\) from "${filename}"`));
        assert.equal(element("fcFileName").textContent, `File: ${filename} (${expectedNames.join(", ")})`);
        assert.equal(element("fcRemove").hidden, false);
        assert.deepEqual(
            plainJson(context.AppState.functionCallDefinition).map((d) => d.name),
            expectedNames
        );
    }

    for (const [filename, body] of [
        ["empty_camel.json", '{"functionDeclarations": []}'],
        ["empty_tools.json", '{"tools": [{"function_declarations": []}]}'],
        ["non_array.json", '{"functionDeclarations": "bad"}'],
        ["unnamed_inside.json", '{"functionDeclarations": [{"name": "ok"}, {"description": "missing name"}]}'],
    ]) {
        const dialog = await pick(filename, body);
        assert.equal(
            dialog,
            `Could not use "${filename}": expected a list of function declarations, each with a non-empty name`
        );
        assert.deepEqual(
            plainJson(context.AppState.functionCallDefinition).map((d) => d.name),
            ["check_stock"]
        );
        assert.equal(element("fcFileName").textContent, "File: tool_list.json (check_stock)");
    }
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

test("an abandoned recording's delayed stop doesn't break or mix chunks into a newer recording", async () => {
    // Closing the modal cancels rec1, but its async ondataavailable/onstop arrive
    // after rec2 has already started: rec2 must still cancel cleanly on close.
    {
        const devices = fakeRecordingDevices({ deferStop: true });
        const { context, element } = loadApp(devices.globals);
        context.openModal();
        element("newVoiceName").value = "First";
        const first = context.handleRecordClick();
        devices.prompts[0].grant();
        await first;

        context.closeModal();
        context.openModal();
        element("newVoiceName").value = "Second";
        const second = context.handleRecordClick();
        devices.prompts[1].grant();
        await second;

        devices.recorders[0].ondataavailable({ data: new Blob(["old"]) });
        await devices.recorders[0].finishStop();

        assert.equal(context.AppState.isRecording, true);
        assert.equal(context.AppState.mediaRecorder, devices.recorders[1]);
        context.closeModal();
        assert.equal(devices.recorders[1].state, "inactive");
        await devices.recorders[1].finishStop();
        assert.equal(devices.prompts[1].track.stopped, true);
    }

    // And if rec2 finishes normally after rec1's delayed stop, rec2 decodes only its own chunks.
    {
        const devices = fakeRecordingDevices({ deferStop: true });
        const decodedTexts = [];
        const OfflineAudioContext = class extends fakeOfflineAudioContext(12) {
            async decodeAudioData(buffer) {
                decodedTexts.push(Buffer.from(buffer).toString("utf8"));
                return { duration: 12 };
            }
        };
        const { context, element } = loadApp({
            ...devices.globals,
            OfflineAudioContext,
            FileReader: FakeFileReader,
            Blob,
        });
        context.openModal();
        element("newVoiceName").value = "First";
        const first = context.handleRecordClick();
        devices.prompts[0].grant();
        await first;

        context.closeModal();
        context.openModal();
        element("newVoiceName").value = "Second";
        const second = context.handleRecordClick();
        devices.prompts[1].grant();
        await second;

        devices.recorders[1].ondataavailable({ data: new Blob(["new-audio"]) });
        devices.recorders[0].ondataavailable({ data: new Blob(["old-audio"]) });
        await devices.recorders[0].finishStop();

        context.AppState.recordingStartTime -= 11000;
        await context.handleRecordClick();
        await devices.recorders[1].finishStop();
        await flush();
        assert.deepEqual(decodedTexts, ["new-audio"]);
    }
});

test("a superseded or closed recording prompt rejection shows no error dialog", async () => {
    // Closed before denial.
    {
        const devices = fakeRecordingDevices();
        const { context, element } = loadApp(devices.globals);
        const dialogs = recordDialogs(context);
        context.openModal();
        element("newVoiceName").value = "Closed";
        const click = context.handleRecordClick();
        context.closeModal();
        devices.prompts[0].deny();
        await click;
        assert.deepEqual(dialogs, []);
    }

    // Superseded by a second Record click that succeeds before the first rejects.
    {
        const devices = fakeRecordingDevices();
        const { context, element } = loadApp(devices.globals);
        const dialogs = recordDialogs(context);
        context.openModal();
        element("newVoiceName").value = "Double";
        const first = context.handleRecordClick();
        const second = context.handleRecordClick();
        devices.prompts[1].grant();
        await second;
        devices.prompts[0].deny();
        await first;
        assert.deepEqual(dialogs, []);
        assert.equal(context.AppState.isRecording, true);
        context.closeModal();
        await flush();
        assert.equal(devices.prompts[1].track.stopped, true);
    }
});

test("a failing MediaRecorder.start() clears the limit timer and cancel handle", async () => {
    const devices = fakeRecordingDevices();
    class ThrowingMediaRecorder extends devices.globals.MediaRecorder {
        start() {
            throw new Error("encoder unavailable");
        }
    }
    const { context, element } = loadApp({ ...devices.globals, MediaRecorder: ThrowingMediaRecorder });
    const dialogs = recordDialogs(context);
    context.openModal();
    element("newVoiceName").value = "Broken";
    const click = context.handleRecordClick();
    devices.prompts[0].grant();
    await click;

    assert.equal(devices.prompts[0].track.stopped, true);
    assert.equal(devices.timers[0].cleared, true);
    assert.equal(context.AppState.cancelRecording, null);
    assert.equal(context.AppState.mediaRecorder, null);
    assert.equal(context.AppState.isRecording, false);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /encoder unavailable/);
});

test("zero-duration or non-finite voice audio is rejected cleanly without a 0-frame OfflineAudioContext", async () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const constructedLengths = [];
        class SpecOfflineAudioContext {
            constructor(channels, length, sampleRate) {
                constructedLengths.push(length);
                if (!Number.isFinite(length) || length < 1) {
                    throw Object.assign(
                        new Error(`Failed to construct 'OfflineAudioContext': length (${length}) < 1`),
                        { name: "NotSupportedError" }
                    );
                }
                this.length = length;
                this.sampleRate = sampleRate;
            }
            async decodeAudioData() {
                return { duration };
            }
        }

        // Upload path.
        const upload = loadApp({ OfflineAudioContext: SpecOfflineAudioContext, FileReader: FakeFileReader });
        const input = { value: "empty.wav", files: [{ name: "empty.wav", arrayBuffer: async () => new ArrayBuffer(44) }] };
        await upload.context.handleAudioFileInputChange({ target: input });
        assert.equal(
            upload.element("dialogMessage").textContent,
            'Could not use "empty.wav" as a voice sample: it contains no audio.',
            `upload duration=${duration}`
        );
        assert.equal(upload.context.AppState.customVoiceBase64, "", `upload duration=${duration}`);
        assert.deepEqual(constructedLengths, [1], `upload duration=${duration}`);

        // Recording path.
        constructedLengths.length = 0;
        const devices = fakeRecordingDevices();
        const rec = loadApp({
            ...devices.globals,
            OfflineAudioContext: SpecOfflineAudioContext,
            FileReader: FakeFileReader,
            Blob,
        });
        rec.element("dialog").show = () => {
            rec.document.activeElement = rec.element("dialog");
        };
        rec.context.openModal();
        rec.element("newVoiceName").value = "Kai";
        const click = rec.context.handleRecordClick();
        devices.prompts[0].grant();
        await click;
        devices.recorders[0].stop();
        await flush();

        assert.equal(
            rec.element("dialogMessage").textContent,
            "Could not process the recording: it contains no audio.",
            `record duration=${duration}`
        );
        assert.equal(rec.element("newVoiceName").value, "Kai", `record duration=${duration}`);
        assert.equal(rec.document.activeElement, rec.element("dialog"), `record duration=${duration}`);
        assert.equal(rec.element("recordButton").disabled, false, `record duration=${duration}`);
        assert.equal(rec.element("recordStatus").textContent, "", `record duration=${duration}`);
        assert.equal(rec.element("processingSpinner").hidden, true, `record duration=${duration}`);
        assert.equal(rec.context.AppState.isRecording, false, `record duration=${duration}`);
        assert.deepEqual(constructedLengths, [1], `record duration=${duration}`);
    }
});

test("a recording decode error preserves the voice name, keeps focus on the error dialog, and resets the record button", async () => {
    for (const stopMode of ["micEnded", "stopClick"]) {
        const devices = fakeRecordingDevices();
        class RejectOfflineAudioContext {
            async decodeAudioData() {
                throw Object.assign(new Error("Unable to decode audio data"), { name: "EncodingError" });
            }
        }
        const { context, element, document } = loadApp({
            ...devices.globals,
            OfflineAudioContext: RejectOfflineAudioContext,
            FileReader: FakeFileReader,
            Blob,
        });
        element("dialog").show = () => {
            document.activeElement = element("dialog");
        };
        context.openModal();
        element("newVoiceName").value = "My Custom Voice";
        const click = context.handleRecordClick();
        devices.prompts[0].grant();
        await click;

        if (stopMode === "stopClick") {
            context.AppState.recordingStartTime -= 11000;
            await context.handleRecordClick();
        } else {
            devices.recorders[0].stop();
        }
        await flush();

        assert.equal(
            element("dialogMessage").textContent,
            "Could not process the recording: Unable to decode audio data",
            stopMode
        );
        assert.equal(element("newVoiceName").value, "My Custom Voice", stopMode);
        assert.equal(document.activeElement, element("dialog"), stopMode);
        assert.equal(element("brandedVoiceModal").style.display, "flex", stopMode);
        assert.equal(element("recordButton").disabled, false, stopMode);
        assert.equal(element("recordStatus").textContent, "", stopMode);
        assert.equal(element("processingSpinner").hidden, true, stopMode);
        assert.equal(context.AppState.isRecording, false, stopMode);

        // Ready for another take without retyping the name.
        const retry = context.handleRecordClick();
        devices.prompts[1].grant();
        await retry;
        assert.equal(context.AppState.isRecording, true, stopMode);
        context.closeModal();
        await flush();
        assert.equal(devices.prompts[1].track.stopped, true, stopMode);
    }
});

test("a throw before api.resume() during resumption ends the session instead of sticking in connecting", async () => {
    const app = loadSession();
    const { context, element, api, dialogText } = app;
    const chat = [];
    element("text-chat").appendChild = (line) => chat.push([line.className, line.textContent]);
    let resumed = 0;
    let disconnected = 0;
    api.transportMode = "websocket";
    api.latestResumptionHandle = "h1";
    api.resume = async () => resumed++;
    reconnect(app);
    api.disconnect = () => {
        disconnected++;
        api.isSetupComplete = false;
    };
    context.AppState.liveVideoOutputManager.initMediaSource = () => {
        throw new Error("MediaSource failed");
    };

    // 1001 close path (via onReconnectNeeded -> handleSessionResumptionReconnect).
    await context.handleSessionResumptionReconnect();

    assert.equal(resumed, 0);
    assert.equal(disconnected, 1);
    assert.equal(element("connecting").hidden, true);
    assert.equal(element("disconnected").hidden, false);
    assert.equal(element("connectBtn").disabled, false);
    assert.equal(element("disconnectBtn").disabled, true);
    assert.equal(dialogText(), "Could not resume the session: MediaSource failed");
    assert.ok(
        chat.some(
            ([cls, text]) =>
                cls.includes("chat-error") && text === "Could not resume the session: MediaSource failed"
        ),
        `expected error line in chat, got: ${JSON.stringify(chat)}`
    );

    // GO_AWAY path: calling handleReceiveResponse(GO_AWAY) must also end cleanly without an unhandled rejection.
    api.goAwayAction = () => "resume";
    api.latestResumptionHandle = "h2";
    context.setAppStatus("connected");
    context.handleReceiveResponse({ type: "GO_AWAY", data: "10s" });
    await flush();

    assert.equal(resumed, 0);
    assert.equal(disconnected, 2);
    assert.equal(element("connecting").hidden, true);
    assert.equal(element("disconnected").hidden, false);
});

test("onErrorMessage and onIdleTimeout end the session even if showModal throws", () => {
    for (const [callback, expectedClass] of [
        ["onErrorMessage", "chat-error"],
        ["onIdleTimeout", "chat-system"],
    ]) {
        const app = loadSession();
        const { context, element, api } = app;
        const chat = [];
        element("text-chat").appendChild = (line) => chat.push([line.className, line.textContent]);
        let disconnected = 0;
        reconnect(app);
        api.disconnect = () => {
            disconnected++;
            api.isSetupComplete = false;
        };
        context.setAppStatus("connected");
        element("dialog").show = () => {
            throw new Error("dialog broken");
        };

        assert.throws(() => api[callback]("session ended"), /dialog broken/);
        assert.equal(disconnected, 1, `${callback} should disconnect before showModal`);
        assert.equal(element("disconnected").hidden, false, `${callback} should show disconnected`);
        assert.equal(element("connectBtn").disabled, false, `${callback} should re-enable Connect`);
        assert.ok(
            chat.some(([cls, text]) => cls.includes(expectedClass) && text === "session ended"),
            `${callback} should log message in chat before showModal`
        );
    }
});

test("showUsage formats finite counts and ignores malformed usage payloads", () => {
    const { context, element } = loadSession();
    const usageText = () => element("usage-tokens").textContent;

    context.handleReceiveResponse({ type: "USAGE", data: { promptTokenCount: 1200, totalTokenCount: 3450 } });
    assert.equal(usageText(), `${(1200).toLocaleString()} in / ${(3450).toLocaleString()} total`);

    context.handleReceiveResponse({ type: "USAGE", data: { prompt_token_count: 10, total_token_count: 25 } });
    assert.equal(usageText(), "10 in / 25 total");

    for (const bad of [null, undefined, "bad", 42, [1, 2]]) {
        assert.doesNotThrow(() => context.handleReceiveResponse({ type: "USAGE", data: bad }));
        assert.equal(usageText(), "10 in / 25 total");
    }

    assert.doesNotThrow(() =>
        context.handleReceiveResponse({
            type: "USAGE",
            data: { promptTokenCount: { toLocaleString: 123 }, totalTokenCount: 5 },
        })
    );
    assert.equal(usageText(), "0 in / 5 total");

    assert.doesNotThrow(() =>
        context.handleReceiveResponse({
            type: "USAGE",
            data: { promptTokenCount: Number.NaN, totalTokenCount: Number.POSITIVE_INFINITY },
        })
    );
    assert.equal(usageText(), "0 in / 0 total");

    assert.doesNotThrow(() =>
        context.handleReceiveResponse({
            type: "USAGE",
            data: { promptTokenCount: "100", totalTokenCount: null },
        })
    );
    assert.equal(usageText(), "0 in / 0 total");
});

test("cancelFunctionCalls filters non-string IDs and ignores empty or non-array payloads", async () => {
    const { context, api, posts, chat } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "slow", args: {} }]);
    assert.equal(posts.length, 1);
    const initialChatCount = chat.length;

    for (const bad of [null, undefined, "c1", {}, [], [{ toString: null }, null, 123, ""]]) {
        assert.doesNotThrow(() => context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: bad }));
    }
    assert.equal(posts[0].signal.aborted, false);
    assert.equal(chat.length, initialChatCount);

    assert.doesNotThrow(() =>
        context.handleReceiveResponse({
            type: "FUNCTION_CALL_CANCELLATION",
            data: [{ toString: null }, null, 123, "", "c1"],
        })
    );
    assert.equal(posts[0].signal.aborted, true);
    assert.equal(chat[chat.length - 1], "Function calls cancelled: c1");
    await done;
    assert.equal(api.sent.length, 0);
});

test("handleFunctionCallRequest ignores malformed entries and runs valid ones without rejecting", async () => {
    const { context, api, posts, chat } = loadFunctionCalls();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        for (const bad of [
            null,
            undefined,
            "fn",
            {},
            [],
            [
                null,
                [],
                { id: "c0" },
                { id: "c1", name: "" },
                { id: "c2", name: "   " },
                { id: "c3", name: 123 },
                { id: "c4", name: { toString: null }, args: {} },
            ],
        ]) {
            assert.doesNotThrow(() => context.handleReceiveResponse({ type: "FUNCTION_CALL", data: bad }));
        }
        await settle();
        assert.equal(posts.length, 0);
        assert.equal(chat.length, 0);

        const circular = {};
        circular.self = circular;
        const done = context.handleFunctionCallRequest([
            { id: "bad", name: { toString: null }, args: {} },
            { id: "c1", name: "ok", args: { a: 1 } },
            { id: { toString: null }, name: "badId", args: circular },
        ]);
        assert.equal(posts.length, 1);
        assert.equal(posts[0].name, "ok");
        posts[0].resolve({ response: "first" });
        await settle();
        assert.equal(posts.length, 2);
        assert.equal(posts[1].name, "badId");
        posts[1].resolve({ response: "second" });
        await done;

        assert.deepEqual(plainJson(api.sent), [
            {
                toolResponse: {
                    functionResponses: [
                        { id: "c1", name: "ok", response: { result: { response: "first" } } },
                        { name: "badId", response: { result: { response: "second" } } },
                    ],
                },
            },
        ]);
        assert.ok(chat.includes('Function call: ok({"a":1})'));
        assert.ok(chat.includes("Function call: badId({})"));
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
});

test("handleReceiveResponse catches unexpected rejections from handleFunctionCallRequest and cleans up", async () => {
    const { context, api, posts, errors, element, controllers } = loadFunctionCalls();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        api.sendMessage = () => {
            throw new Error("socket send failed");
        };
        context.handleReceiveResponse({
            type: "FUNCTION_CALL",
            data: [{ id: "c1", name: "ok", args: {} }],
        });
        assert.equal(posts.length, 1);
        posts[0].resolve({ response: "done" });
        await settle();
        await settle();

        assert.ok(
            errors.some((line) => line.includes("Failed to handle function call request:") && line.includes("socket send failed")),
            `expected logged error, got ${JSON.stringify(errors)}`
        );

        // If chat rendering throws mid-batch, already-registered calls are still cleaned up.
        let calls = 0;
        element("text-chat").appendChild = () => {
            if (++calls === 2) throw new Error("dom boom");
        };
        context.handleReceiveResponse({
            type: "FUNCTION_CALL",
            data: [
                { id: "c2", name: "first", args: {} },
                { id: "c3", name: "second", args: {} },
            ],
        });
        await settle();
        assert.equal(posts.length, 1, "failed setup must not start simulator requests");
        assert.equal(controllers.length, 2);
        assert.ok(
            errors.some((line) => line.includes("Failed to handle function call request:") && line.includes("dom boom")),
            `expected logged dom boom error, got ${JSON.stringify(errors)}`
        );
        // Neither cancellation nor endSession should touch c2's controller if it was cleaned up.
        context.handleReceiveResponse({ type: "FUNCTION_CALL_CANCELLATION", data: ["c2"] });
        context.endSession();
        assert.equal(controllers[1].signal.aborted, false);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
});

test("simulateFunctionResponse handles non-Error rejections without throwing", async () => {
    const { context, api, posts, chat } = loadFunctionCalls();
    const done = context.handleFunctionCallRequest([{ id: "c1", name: "failNonError", args: {} }]);
    posts[0].reject("plain failure");
    await done;
    assert.deepEqual(plainJson(api.sent), [
        {
            toolResponse: {
                functionResponses: [{ id: "c1", name: "failNonError", response: { error: "plain failure" } }],
            },
        },
    ]);
    assert.ok(chat.includes("Function failNonError failed: plain failure"));
});

test("upload and recording error dialogs handle null and empty-message rejections without throwing", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
        let readerError = null;
        let readerSyncThrow = false;
        class FailingFileReader {
            readAsDataURL() {
                if (readerSyncThrow) throw null;
                this.error = readerError;
                queueMicrotask(() => {
                    this.onerror?.();
                    this.onloadend?.();
                });
            }
        }
        let fetchImpl = async () => {
            throw null;
        };
        let decodeRejection = null;
        class RejectDecodeOfflineAudioContext {
            async decodeAudioData() {
                throw decodeRejection;
            }
        }
        let fcDeclImpl = () => {
            throw null;
        };
        const devices = fakeRecordingDevices();
        const { context, element } = loadApp({
            ...devices.globals,
            FileReader: FailingFileReader,
            OfflineAudioContext: RejectDecodeOfflineAudioContext,
            Blob,
            fetch: (...args) => fetchImpl(...args),
            GeminiLiveAPI: class extends FakeGeminiLiveAPI {
                static toFunctionDeclarations = (json) => fcDeclImpl(json);
            },
        });
        const dialogs = recordDialogs(context);

        // 1. handleAvatarFileInputChange: FileReader.onerror with null error, empty-message DOMException, and sync null throw.
        const avatarFile = { name: "face.png", type: "image/png", size: 12 };
        readerError = null;
        await context.handleAvatarFileInputChange({ target: { value: "face.png", files: [avatarFile] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "face.png" as the avatar: could not read the file.']);

        readerError = { name: "NotReadableError", message: "" };
        await context.handleAvatarFileInputChange({ target: { value: "face.png", files: [avatarFile] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "face.png" as the avatar: NotReadableError']);

        readerSyncThrow = true;
        await context.handleAvatarFileInputChange({ target: { value: "face.png", files: [avatarFile] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "face.png" as the avatar: unknown error']);
        readerSyncThrow = false;

        // 2. useSampleAvatar: null fetch rejection, empty-message blob() rejection, and null FileReader error.
        fetchImpl = async () => {
            throw null;
        };
        await context.useSampleAvatar();
        assert.deepEqual(dialogs.splice(0), ["Could not load the sample avatar image: unknown error"]);

        fetchImpl = async () => ({
            ok: true,
            blob: async () => {
                throw { name: "AbortError", message: "   " };
            },
        });
        await context.useSampleAvatar();
        assert.deepEqual(dialogs.splice(0), ["Could not load the sample avatar image: AbortError"]);

        readerError = null;
        fetchImpl = async () => ({
            ok: true,
            blob: async () => ({ type: "image/png", size: 8 }),
        });
        await context.useSampleAvatar();
        assert.deepEqual(dialogs.splice(0), ["Could not load the sample avatar image: could not read the file."]);

        // 3. handleAudioFileInputChange: Safari-style null decodeAudioData() rejection and empty-message EncodingError.
        const voiceFile = { name: "a.wav", size: 64, arrayBuffer: async () => new ArrayBuffer(64) };
        decodeRejection = null;
        await context.handleAudioFileInputChange({ target: { value: "a.wav", files: [voiceFile] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "a.wav" as a voice sample: unknown error']);

        decodeRejection = { name: "EncodingError", message: "" };
        await context.handleAudioFileInputChange({ target: { value: "a.wav", files: [voiceFile] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "a.wav" as a voice sample: EncodingError']);

        // 4. handleFcFileInputChange: null / whitespace-message file.text() rejection and null / empty-message parse error.
        const rejectText = (reason) => ({
            name: "tools.json",
            size: 16,
            text: async () => {
                throw reason;
            },
        });
        await context.handleFcFileInputChange({ target: { value: "tools.json", files: [rejectText(null)] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "tools.json": the file can\'t be read (unknown error)']);

        await context.handleFcFileInputChange({
            target: { value: "tools.json", files: [rejectText({ name: "NotReadableError", message: "   " })] },
        });
        assert.deepEqual(dialogs.splice(0), [
            'Could not use "tools.json": the file can\'t be read (NotReadableError)',
        ]);

        const okText = { name: "tools.json", size: 16, text: async () => "{}" };
        fcDeclImpl = () => {
            throw null;
        };
        await context.handleFcFileInputChange({ target: { value: "tools.json", files: [okText] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "tools.json": unknown error']);

        fcDeclImpl = () => {
            throw { name: "SyntaxError", message: "" };
        };
        await context.handleFcFileInputChange({ target: { value: "tools.json", files: [okText] } });
        assert.deepEqual(dialogs.splice(0), ['Could not use "tools.json": SyntaxError']);

        // 5. recorder.onstop: null and empty-message decodeAudioData() rejections still show dialog and reset button.
        for (const [reason, expected] of [
            [null, "Could not process the recording: unknown error"],
            [{ name: "EncodingError", message: "" }, "Could not process the recording: EncodingError"],
        ]) {
            decodeRejection = reason;
            context.openModal();
            element("newVoiceName").value = "Kai";
            const click = context.handleRecordClick();
            devices.prompts.at(-1).grant();
            await click;
            devices.recorders.at(-1).stop();
            await flush();
            assert.deepEqual(dialogs.splice(0), [expected]);
            assert.equal(element("recordButton").disabled, false);
            assert.equal(element("processingSpinner").hidden, true);
            assert.equal(element("newVoiceName").value, "Kai");
        }
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
});

test("resumption, simulator, screen, and recording start errors handle null and empty-message rejections", async () => {
    // handleSessionResumptionReconnect: empty-message DOMException and null throw before api.resume().
    for (const [thrown, expected] of [
        [{ name: "InvalidStateError", message: "" }, "Could not resume the session: InvalidStateError"],
        [null, "Could not resume the session: unknown error"],
    ]) {
        const app = loadSession();
        const { context, api, dialogText } = app;
        api.transportMode = "websocket";
        api.latestResumptionHandle = "h1";
        api.resume = async () => {
            throw new Error("should not reach resume");
        };
        reconnect(app);
        context.AppState.liveVideoOutputManager.initMediaSource = () => {
            throw thrown;
        };
        await context.handleSessionResumptionReconnect();
        assert.equal(dialogText(), expected);
    }

    // simulateFunctionResponse: empty-message DOMException, blank/plain objects, null/undefined, throwing getters, and throwing toString.
    const throwingMsgWithName = { name: "GetterName" };
    Object.defineProperty(throwingMsgWithName, "message", {
        get() {
            throw new Error("message getter exploded");
        },
    });
    const throwingBothGetters = Object.create(null);
    Object.defineProperty(throwingBothGetters, "message", {
        get() {
            throw new Error("message getter exploded");
        },
    });
    Object.defineProperty(throwingBothGetters, "name", {
        get() {
            throw new Error("name getter exploded");
        },
    });
    for (const [reason, expected] of [
        [{ name: "AbortError", message: "  " }, "AbortError"],
        [{ name: "  ", message: "  " }, "unknown error"],
        [{}, "unknown error"],
        [null, "unknown error"],
        [undefined, "unknown error"],
        [Object.create(null), "unknown error"],
        [throwingMsgWithName, "GetterName"],
        [throwingBothGetters, "unknown error"],
        [{ toString() { throw new Error("nope"); } }, "unknown error"],
        [{ toString() { return "  custom failure  "; } }, "custom failure"],
        ["", "unknown error"],
        ["   ", "unknown error"],
    ]) {
        const { context, api, posts, chat } = loadFunctionCalls();
        const done = context.handleFunctionCallRequest([{ id: "c1", name: "failEdge", args: {} }]);
        posts[0].reject(reason);
        await done;
        assert.deepEqual(plainJson(api.sent), [
            {
                toolResponse: {
                    functionResponses: [{ id: "c1", name: "failEdge", response: { error: expected } }],
                },
            },
        ]);
        assert.ok(chat.includes(`Function failEdge failed: ${expected}`));
    }

    // startScreenCapture & handleRecordClick: null rejections don't crash on .name check.
    const { context } = loadApp({
        navigator: {
            mediaDevices: {
                getUserMedia: async () => {
                    throw null;
                },
            },
        },
        LiveScreenManager: class extends FakeFrameSource {
            async startCapture() {
                throw null;
            }
        },
    });
    const dialogs = recordDialogs(context);
    context.AppState.liveScreenManager = new context.LiveScreenManager();
    await context.startScreenCapture();
    assert.deepEqual(dialogs.splice(0), ["Could not share the screen: unknown error"]);

    context.openModal();
    context.AppUI.getElement("newVoiceName").value = "Kai";
    await context.handleRecordClick();
    assert.deepEqual(dialogs.splice(0), ["Could not start recording: unknown error"]);
});

test("already-ended camera or screen picks detach replaced WebRTC tracks without stopping an unrelated live camera", async () => {
    const tracks = {
        screen: { kind: "video", readyState: "live" },
        camera: { kind: "video", readyState: "live" },
        endedCam: { kind: "video", readyState: "ended" },
        endedScreen: { kind: "video", readyState: "ended" },
    };
    let screenMode = "ended";
    let attachCalls = 0;
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager({
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {
                if (this.stream) tracks.camera.readyState = "ended";
                this.stream = null;
            }
            async startWebcam() {
                this.onEnded(tracks.endedCam);
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                if (this.stream) tracks.screen.readyState = "ended";
                this.stream = null;
            }
            async startCapture() {
                if (screenMode === "replace-ended") {
                    this.stopCapture();
                }
                this.onEnded(tracks.endedScreen);
                return false;
            }
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    webRtc.attachVideoStream = async () => {
        attachCalls++;
    };

    // 1. Replacing a running WebRTC screen share with a camera whose track arrives already ended
    // detaches the stopped screen share, turns the camera button off, and does not attach null.
    context.AppState.liveScreenManager.stream = { getVideoTracks: () => [tracks.screen] };
    webRtc.videoTrack = tracks.screen;
    element("cameraBtn").hidden = false;
    element("cameraOffBtn").hidden = true;
    await context.startCameraCapture();
    assert.equal(attachCalls, 0);
    assert.equal(tracks.screen.readyState, "ended");
    assert.deepEqual(webRtc.detached, [tracks.screen]);
    assert.equal(webRtc.videoTrack, null);
    assert.equal(element("cameraBtn").hidden, true);
    assert.equal(element("cameraOffBtn").hidden, false);
    assert.match(dialogText(), /^The camera stopped/);

    // 2. Starting a screen share that resolves with an already-ended track while a live camera is running
    // leaves the live camera running and attached on WebRTC.
    context.AppState.liveVideoManager.stream = { getVideoTracks: () => [tracks.camera] };
    webRtc.videoTrack = tracks.camera;
    element("cameraBtn").hidden = false;
    element("cameraOffBtn").hidden = true;
    screenMode = "ended";
    await context.startScreenCapture();
    assert.equal(attachCalls, 0);
    assert.equal(tracks.camera.readyState, "live");
    assert.ok(context.AppState.liveVideoManager.stream);
    assert.equal(webRtc.videoTrack, tracks.camera);
    assert.equal(element("cameraBtn").hidden, false);

    // 3. Replacing a running WebRTC screen share with an already-ended screen pick detaches the old share.
    tracks.screen.readyState = "live";
    context.AppState.liveScreenManager.stream = { getVideoTracks: () => [tracks.screen] };
    webRtc.videoTrack = tracks.screen;
    screenMode = "replace-ended";
    await context.startScreenCapture();
    assert.equal(attachCalls, 0);
    assert.equal(tracks.screen.readyState, "ended");
    assert.deepEqual(webRtc.detached, [tracks.screen, tracks.screen]);
    assert.equal(webRtc.videoTrack, null);
});

test("empty voice files, aborted FileReader reads, and empty voice base64 payloads are rejected", async () => {
    let readerMode = "normal"; // "normal" | "abort-null" | "abort-err" | "empty-data" | "null-result"
    class ScriptedFileReader extends FakeFileReader {
        async readAsDataURL(blob) {
            if (readerMode === "normal") return super.readAsDataURL(blob);
            if (readerMode === "abort-null" || readerMode === "abort-err") {
                this.result = null;
                this.error =
                    readerMode === "abort-err"
                        ? Object.assign(new Error("The operation was aborted."), { name: "AbortError" })
                        : null;
                this.onabort?.();
                this.onloadend?.();
                return;
            }
            this.result = readerMode === "empty-data" ? "data:audio/wav;base64," : null;
            this.onload?.();
            this.onloadend?.();
        }
    }

    let decodeCalls = 0;
    const BaseOffline = fakeOfflineAudioContext(0.1);
    class CountingOfflineAudioContext extends BaseOffline {
        async decodeAudioData(...args) {
            decodeCalls++;
            return super.decodeAudioData(...args);
        }
    }

    const devices = fakeRecordingDevices();
    const { context, element } = loadApp({
        ...devices.globals,
        OfflineAudioContext: CountingOfflineAudioContext,
        FileReader: ScriptedFileReader,
        Blob,
        fetch: async () => ({ ok: true, blob: async () => ({ type: "image/png", size: 3, bytes: "png" }) }),
    });
    const dialogs = recordDialogs(context);
    const addedVoices = [];
    const dropdown = element("voice-dropdown");
    dropdown.appendChild = (option) => addedVoices.push(option.textContent);

    // Seed a working voice and avatar first so we can verify rejected reads keep them intact.
    await context.handleAudioFileInputChange({
        target: { value: "good.wav", files: [{ name: "good.wav", size: 8, arrayBuffer: async () => new ArrayBuffer(8) }] },
    });
    const goodVoice = context.AppState.customVoiceBase64;
    assert.ok(goodVoice.length > 0);
    assert.deepEqual(addedVoices, ["good.wav"]);
    assert.match(dialogs.splice(0)[0], /"good\.wav" is 0\.1 s long\. It is selected/);

    await context.handleAvatarFileInputChange({
        target: { value: "good.png", files: [{ name: "good.png", type: "image/png", size: 3, bytes: "abc" }] },
    });
    assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/png" });
    assert.deepEqual(dialogs.splice(0), []);

    // 1. A 0-byte voice file is refused before reading or constructing an OfflineAudioContext.
    let readEmpty = false;
    decodeCalls = 0;
    const emptyInput = {
        value: "empty.wav",
        files: [
            {
                name: "empty.wav",
                size: 0,
                arrayBuffer: async () => {
                    readEmpty = true;
                    return new ArrayBuffer(0);
                },
            },
        ],
    };
    await context.handleAudioFileInputChange({ target: emptyInput });
    assert.equal(emptyInput.value, "");
    assert.equal(readEmpty, false);
    assert.equal(decodeCalls, 0);
    assert.deepEqual(dialogs.splice(0), ['Could not use "empty.wav" as a voice sample: the file is empty.']);
    assert.equal(context.AppState.customVoiceBase64, goodVoice);
    assert.deepEqual(addedVoices, ["good.wav"]);

    // 2. An aborted FileReader read (with null reader.error or DOMException) rejects instead of resolving "".
    for (const [mode, expectedReason] of [
        ["abort-null", "the file read was aborted."],
        ["abort-err", "The operation was aborted."],
    ]) {
        readerMode = mode;
        await context.handleAudioFileInputChange({
            target: {
                value: "aborted.wav",
                files: [{ name: "aborted.wav", size: 8, arrayBuffer: async () => new ArrayBuffer(8) }],
            },
        });
        assert.deepEqual(dialogs.splice(0), [`Could not use "aborted.wav" as a voice sample: ${expectedReason}`]);
        assert.equal(context.AppState.customVoiceBase64, goodVoice);
        assert.deepEqual(addedVoices, ["good.wav"]);

        await context.handleAvatarFileInputChange({
            target: { value: "aborted.png", files: [{ name: "aborted.png", type: "image/png", size: 3, bytes: "xyz" }] },
        });
        assert.deepEqual(dialogs.splice(0), [`Could not use "aborted.png" as the avatar: ${expectedReason}`]);
        assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/png" });

        await context.useSampleAvatar();
        assert.deepEqual(dialogs.splice(0), [`Could not load the sample avatar image: ${expectedReason}`]);
        assert.deepEqual(plainJson(context.AppState.customAvatar), { image: "YWJj", mimeType: "image/png" });
    }

    // 3. Empty base64 or null FileReader.result from onload is rejected in toVoiceSample() on upload and recording paths.
    for (const mode of ["empty-data", "null-result"]) {
        readerMode = mode;
        await context.handleAudioFileInputChange({
            target: {
                value: "blank.wav",
                files: [{ name: "blank.wav", size: 8, arrayBuffer: async () => new ArrayBuffer(8) }],
            },
        });
        assert.deepEqual(dialogs.splice(0), ['Could not use "blank.wav" as a voice sample: it contains no audio.']);
        assert.equal(context.AppState.customVoiceBase64, goodVoice);
        assert.deepEqual(addedVoices, ["good.wav"]);

        context.openModal();
        element("newVoiceName").value = "Silent Take";
        const click = context.handleRecordClick();
        devices.prompts.at(-1).grant();
        await click;
        context.AppState.recordingStartTime -= 11000;
        await context.handleRecordClick();
        await flush();
        assert.deepEqual(dialogs.splice(0), ["Could not process the recording: it contains no audio."]);
        assert.equal(element("newVoiceName").value, "Silent Take");
        assert.equal(element("recordButton").disabled, false);
        assert.equal(context.AppState.customVoiceBase64, goodVoice);
        assert.deepEqual(addedVoices, ["good.wav"]);
    }

    // 4. An aborted FileReader during recording processing resets the record button and does not add an empty voice.
    readerMode = "abort-null";
    context.openModal();
    element("newVoiceName").value = "Aborted Take";
    const click = context.handleRecordClick();
    devices.prompts.at(-1).grant();
    await click;
    context.AppState.recordingStartTime -= 11000;
    await context.handleRecordClick();
    await flush();
    assert.deepEqual(dialogs.splice(0), ["Could not process the recording: the file read was aborted."]);
    assert.equal(element("newVoiceName").value, "Aborted Take");
    assert.equal(element("recordButton").disabled, false);
    assert.equal(context.AppState.customVoiceBase64, goodVoice);
    assert.deepEqual(addedVoices, ["good.wav"]);
});

test("already-ended screen picks do not invalidate an in-flight camera start, but do cancel an active screen share", async () => {
    const tracks = {
        oldCam: { kind: "video", readyState: "live" },
        newCam: { kind: "video", readyState: "live" },
        cam2: { kind: "video", readyState: "live" },
        screen1: { kind: "video", readyState: "live" },
        endedScreen: { kind: "video", readyState: "ended" },
    };
    let camDeferred = null;
    let attachDeferred = null;
    let screenMode = "ended";
    let frameStarts = 0;
    let screenFrameStarts = 0;
    const attachedStreams = [];
    const { context, element, webRtc, dialogText } = loadWithWebRtcManager({
        navigator: {},
        requestAnimationFrame: () => 0,
        LiveVideoManager: class extends FakeFrameSource {
            stopWebcam() {
                if (this.stream) this.stream.getVideoTracks().forEach((t) => (t.readyState = "ended"));
                this.stream = null;
            }
            async startWebcam() {
                camDeferred = Promise.withResolvers();
                const track = await camDeferred.promise;
                this.stream = { getVideoTracks: () => [track] };
            }
            startSendingFrames() {
                if (this.stream) frameStarts++;
            }
        },
        LiveScreenManager: class extends FakeFrameSource {
            stopCapture() {
                if (this.stream) this.stream.getVideoTracks().forEach((t) => (t.readyState = "ended"));
                this.stream = null;
            }
            async startCapture() {
                if (screenMode === "live") {
                    tracks.screen1.readyState = "live";
                    this.stream = { getVideoTracks: () => [tracks.screen1] };
                    return true;
                }
                if (screenMode === "replace-ended") {
                    this.stopCapture();
                }
                this.onEnded(tracks.endedScreen);
                return false;
            }
            startSendingFrames() {
                if (this.stream) screenFrameStarts++;
            }
        },
    });
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    webRtc.attachVideoStream = async (stream) => {
        attachedStreams.push(stream);
        webRtc.videoTrack = stream.getVideoTracks()[0];
        if (attachDeferred) {
            await attachDeferred.promise;
        }
    };

    // 1. Camera start awaiting getUserMedia() (even while replacing an older camera whose track
    // was stopped) is NOT invalidated by a concurrent already-ended screen pick.
    context.AppState.liveVideoManager.stream = { getVideoTracks: () => [tracks.oldCam] };
    webRtc.videoTrack = tracks.oldCam;
    element("cameraBtn").hidden = false;
    element("cameraOffBtn").hidden = true;
    const camStart1 = context.startCameraCapture();
    const attemptAfterCam1 = context.AppState.videoAttempt;
    screenMode = "ended";
    await context.startScreenCapture();
    camDeferred.resolve(tracks.newCam);
    await camStart1;
    assert.equal(attachedStreams.length, 1);
    assert.equal(webRtc.videoTrack, tracks.newCam);
    assert.equal(context.AppState.videoAttempt, attemptAfterCam1);
    assert.equal(element("cameraBtn").hidden, false);
    assert.equal(context.AppState.videoOwner, "camera");

    // 2. Camera start awaiting attachVideoStream() with a WebSocket fallback after attach is
    // NOT invalidated by a concurrent already-ended screen pick.
    attachDeferred = Promise.withResolvers();
    const camStart2 = context.startCameraCapture();
    const attemptAfterCam2 = context.AppState.videoAttempt;
    camDeferred.resolve(tracks.cam2);
    await flush();
    assert.equal(webRtc.videoTrack, tracks.cam2);
    await context.startScreenCapture();
    context.AppState.geminiLiveApi.transportMode = "websocket";
    attachDeferred.resolve();
    attachDeferred = null;
    await camStart2;
    assert.equal(frameStarts, 1);
    assert.equal(context.AppState.videoAttempt, attemptAfterCam2);
    assert.equal(webRtc.videoTrack, tracks.cam2);

    // 3. Replacing an in-flight screen share's attachVideoStream() with an already-ended screen
    // pick DOES bump videoAttempt, clear videoOwner, detach the old share, and suppress the old
    // attach's rejection dialog and frame sending.
    context.AppState.geminiLiveApi.transportMode = "webrtc";
    attachDeferred = Promise.withResolvers();
    screenMode = "live";
    const screenStart1 = context.startScreenCapture();
    await flush();
    const attemptAfterScreen1 = context.AppState.videoAttempt;
    assert.equal(webRtc.videoTrack, tracks.screen1);
    screenMode = "replace-ended";
    await context.startScreenCapture();
    assert.equal(tracks.screen1.readyState, "ended");
    assert.equal(webRtc.videoTrack, null);
    assert.equal(context.AppState.videoAttempt, attemptAfterScreen1 + 1);
    assert.equal(context.AppState.videoOwner, null);
    attachDeferred.reject(new Error("sender closed"));
    attachDeferred = null;
    await screenStart1;
    assert.equal(dialogText(), undefined);
    assert.equal(screenFrameStarts, 0);
});
