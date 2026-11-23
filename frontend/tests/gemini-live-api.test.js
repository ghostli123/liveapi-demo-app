const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor() {
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
    }
    send(data) {
        this.sent.push(JSON.parse(data));
    }
}

// Timeouts are recorded rather than run, so tests can fire them on demand.
const timers = [];
// Recorded, not run: the bandwidth meter's interval would keep the test alive.
const intervals = [];
// The page's elements, created on first lookup with the HTML's initial text.
const elements = new Map();
const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "0.00" });
    return elements.get(id);
};
const { GeminiLiveAPI, GeminiLiveResponseMessage } = loadScript(
    "gemini-live-api.js",
    ["GeminiLiveAPI", "GeminiLiveResponseMessage"],
    {
        WebSocket: FakeWebSocket,
        document: { getElementById: element },
        setInterval: (fn) => intervals.push(fn),
        clearInterval: () => {},
        setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
        clearTimeout: (id) => {
            if (timers[id - 1]) timers[id - 1].cleared = true;
        },
    }
);

// Values created inside the VM context have that context's prototypes, which
// strict deep equality rejects; copy them into this realm first.
const plain = (value) => JSON.parse(JSON.stringify(value));
const types = (events) => plain(events.map((e) => e.type));

test("session IDs are UUIDs even where crypto.randomUUID is missing", () => {
    // Plain http from another machine isn't a secure context, so browsers
    // leave out crypto.randomUUID; getRandomValues is always there. Calling
    // randomUUID at construction used to stop the whole page from loading.
    const insecure = loadScript("gemini-live-api.js", ["GeminiLiveAPI", "randomId"], {
        crypto: { getRandomValues: (array) => globalThis.crypto.getRandomValues(array) },
    });
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const api = new insecure.GeminiLiveAPI("ws://host/ws", "/api/control", "/api/post_endpoint");
    assert.match(api.sessionId, uuidV4);
    const ids = new Set(Array.from({ length: 100 }, () => insecure.randomId()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, uuidV4);

    // Where randomUUID exists, it's used as is.
    const secure = loadScript("gemini-live-api.js", ["randomId"], { crypto: { randomUUID: () => "from-randomUUID" } });
    assert.equal(secure.randomId(), "from-randomUUID");
});

test("parseAll returns every event in a message, in order", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        serverContent: {
            outputTranscription: { text: "five." },
            turnComplete: true,
        },
        usageMetadata: { totalTokenCount: 42 },
    });
    assert.deepEqual(types(events), ["OUTPUT_TRANSCRIPTION", "END_OF_TURN", "USAGE"]);
    assert.equal(events[0].data, "five.");
    assert.equal(events[2].data.totalTokenCount, 42);
});

test("parseAll emits one event per model turn part", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        serverContent: {
            modelTurn: {
                parts: [
                    { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } },
                    { inlineData: { mimeType: "video/mp4", data: "BBB=" } },
                    { text: "hi" },
                ],
            },
        },
    });
    assert.deepEqual(types(events), ["AUDIO", "VIDEO", "TEXT"]);
    assert.equal(events[1].mimeType, "video/mp4");
});

test("parseAll accepts snake_case and reads the WebRTC answer", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        setup_complete: { session_id: "s-1", rtc_setup_complete: { answer_sdp: "v=0" } },
    });
    assert.deepEqual(types(events), ["SETUP COMPLETE"]);
    assert.equal(events[0].answerSdp, "v=0");
    assert.equal(events[0].sessionId, "s-1");
});

test("parseAll handles the remaining server message types", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        serverContent: {
            generationStarted: { generationId: "1" },
            inputTranscription: { finished: true },
            interrupted: true,
        },
        toolCall: { functionCalls: [{ id: "c1", name: "f", args: {} }] },
        toolCallCancellation: { ids: ["c0"] },
        goAway: { timeLeft: "10s" },
        sessionResumptionUpdate: { newHandle: "h1", resumable: true },
    });
    assert.deepEqual(types(events), [
        "FUNCTION_CALL",
        "FUNCTION_CALL_CANCELLATION",
        "GENERATION_STARTED",
        "INPUT_TRANSCRIPTION",
        "INTERRUPT",
        "RESUMPTION",
        "GO_AWAY",
    ]);
    assert.equal(events[3].finished, true);
    assert.equal(events[5].data, "h1");
});

test("parseAll reads the server's voice activity frames", () => {
    // As the real endpoint sends them (cycle 107 probe), in either case.
    const start = GeminiLiveResponseMessage.parseAll({
        voiceActivity: { type: "ACTIVITY_START", audioOffset: "0.200s" },
    });
    assert.deepEqual(types(start), ["VOICE_ACTIVITY"]);
    assert.equal(start[0].data, "ACTIVITY_START");
    assert.equal(start[0].audioOffset, "0.200s");

    const end = GeminiLiveResponseMessage.parseAll({ voice_activity: { type: "ACTIVITY_END", audio_offset: "20.640s" } });
    assert.deepEqual(types(end), ["VOICE_ACTIVITY"]);
    assert.equal(end[0].data, "ACTIVITY_END");
    assert.equal(end[0].audioOffset, "20.640s");

    // A frame without a type, or with a malformed one, is skipped.
    for (const voiceActivity of [{}, { type: 3 }, null, "ACTIVITY_END"]) {
        assert.deepEqual(types(GeminiLiveResponseMessage.parseAll({ voiceActivity })), []);
    }
});

test("parseAll ignores resumption updates without a handle", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        sessionResumptionUpdate: { resumable: false },
        serverContent: { generationComplete: true },
    });
    assert.equal(events.length, 0);
});

test("parseAll skips malformed parts and keeps the rest of the message", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        setupComplete: { sessionId: 7 },
        serverContent: {
            modelTurn: {
                parts: [
                    null,
                    "text",
                    { inlineData: { mimeType: 5, data: "AAA=" } },
                    { inlineData: { mimeType: "video/mp4", data: { bad: 1 } } },
                    { text: ["not", "a", "string"] },
                    { text: "hi" },
                ],
            },
            outputTranscription: { text: 3 },
            turnComplete: true,
        },
    });
    assert.deepEqual(types(events), [
        "SETUP COMPLETE",
        "AUDIO",
        "TEXT",
        "OUTPUT_TRANSCRIPTION",
        "END_OF_TURN",
    ]);
    assert.equal(events[0].sessionId, "");
    assert.equal(events[1].mimeType, "");
    assert.equal(events[2].data, "hi");
    assert.equal(events[3].data, "");
});

test("parseAll ignores parts, calls and ids that aren't lists", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        serverContent: { modelTurn: { parts: { text: "x" } } },
        toolCall: { functionCalls: { id: "c1" } },
        toolCallCancellation: { ids: "c0" },
        goAway: { timeLeft: 10 },
    });
    assert.deepEqual(types(events), ["FUNCTION_CALL_CANCELLATION", "GO_AWAY"]);
    assert.deepEqual(plain(events[0].data), []);
    assert.equal(events[1].data, "");
});

test("parseAll drops function calls that aren't objects and keeps the rest", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        toolCall: { functionCalls: [null, "f", 3, { id: "c1", name: "f" }] },
    });
    assert.deepEqual(types(events), ["FUNCTION_CALL"]);
    assert.deepEqual(plain(events[0].data), [{ id: "c1", name: "f" }]);

    assert.deepEqual(types(GeminiLiveResponseMessage.parseAll({ toolCall: { functionCalls: [null] } })), []);
});

test("a non-string resumption handle is ignored, not offered for a resume", () => {
    // A stored non-string handle made the resume's setup throw on .trim().
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.enableSessionResumption = true;
    const received = [];
    api.onReceiveResponse = (message) => received.push(message.type);
    api.onConnectionStarted = () => {};
    api.onReceiveMessage({
        data: JSON.stringify({
            setupComplete: {},
            sessionResumptionUpdate: { newHandle: { id: "h1" } },
        }),
    });
    assert.deepEqual(received, ["SETUP COMPLETE"]);
    assert.equal(api.canResume(), false);

    api.onReceiveMessage({
        data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h2" } }),
    });
    assert.equal(api.latestResumptionHandle, "h2");
    assert.equal(api.canResume(), true);
});

test("tools put behavior on each function declaration, only for NON_BLOCKING", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.setFunctionCall([{ name: "f" }, { name: "g" }]);
    api.toolBehavior = "BLOCKING";
    assert.deepEqual(plain(api._buildToolsConfig()), [
        { function_declarations: [{ name: "f" }, { name: "g" }] },
    ]);

    api.toolBehavior = "NON_BLOCKING";
    api.googleSearchEnabled = true;
    const tools = plain(api._buildToolsConfig());
    assert.deepEqual(Object.keys(tools[0]), ["googleSearch"]);
    assert.deepEqual(
        tools[1].function_declarations.map((d) => d.behavior),
        ["NON_BLOCKING", "NON_BLOCKING"]
    );
    assert.equal(tools[1].behavior, undefined);
});

test("realtime input is dropped until the server confirms setup", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.sendAudioMessage("AAA=");
    assert.equal(api.webSocket.sent.length, 0);

    api.onReceiveResponse = () => {};
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    api.sendAudioMessage("AAA=");
    api.sendTextMessage("hello");
    assert.equal(api.webSocket.sent.length, 2);
    assert.equal(api.webSocket.sent[0].realtime_input.media_chunks[0].data, "AAA=");
});

test("text and push-to-talk aren't sent until the server confirms setup", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.lastActivityAt = 0;
    assert.equal(api.sendTextMessage("hello"), false);
    assert.equal(api.sendVoiceActivityMessage(true), false);
    assert.equal(api.webSocket.sent.length, 0);
    assert.equal(api.lastActivityAt, 0); // Dropped input isn't activity.

    api.onReceiveResponse = () => {};
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.equal(api.sendTextMessage("hello"), true);
    assert.equal(api.sendVoiceActivityMessage(true), true);
    assert.deepEqual(plain(api.webSocket.sent.map((m) => Object.keys(m.realtime_input || m))), [
        ["client_content"],
        ["activity_start"],
    ]);

    // During a resume there is no connection until the new one is set up.
    api.webSocket = null;
    assert.equal(api.sendVoiceActivityMessage(false), false);
});

test("audio_stream_end is sent as realtime input once set up", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    assert.equal(api.sendAudioStreamEnd(), false);
    assert.equal(api.webSocket.sent.length, 0);

    api.onReceiveResponse = () => {};
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.equal(api.sendAudioStreamEnd(), true);
    assert.deepEqual(plain(api.webSocket.sent), [{ realtime_input: { audio_stream_end: true } }]);
});

test("onConnectionStarted runs on setupComplete", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    let started = 0;
    api.onConnectionStarted = () => started++;
    api.onReceiveResponse = () => {};
    api.onReceiveMessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    assert.equal(started, 0);
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.equal(started, 1);
});

test("onConnectionStarted runs even if the setupComplete handler throws", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    let started = 0;
    api.onConnectionStarted = () => started++;
    api.onReceiveResponse = () => {
        throw new Error("UI handler failed");
    };
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.equal(started, 1);
});

test("a failing onConnectionStarted is reported, not left 'connecting'", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors = [];
    const handled = [];
    api.onErrorMessage = (message) => errors.push(message);
    api.onReceiveResponse = (message) => handled.push(message.type);
    api.onConnectionStarted = () => {
        throw new Error("no buttons");
    };
    api.onReceiveMessage({
        data: JSON.stringify({ setupComplete: {}, sessionResumptionUpdate: { newHandle: "h" } }),
    });
    assert.deepEqual(plain(errors), ["Could not start the session: no buttons"]);
    assert.deepEqual(plain(handled), ["SETUP COMPLETE"]); // Nothing after the session ended.
});

test("a failing onTransportFallback is reported, not left 'connecting'", () => {
    // WebRTC was offered but setupComplete had no SDP answer, so media falls
    // back to the WebSocket; the page's fallback handler throws.
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    let closed = 0;
    api.transportMode = "webrtc";
    api.webRtcManager = { close: () => closed++ };
    const errors = [];
    const handled = [];
    let started = 0;
    api.onErrorMessage = (message) => errors.push(message);
    api.onReceiveResponse = (message) => handled.push(message.type);
    api.onConnectionStarted = () => started++;
    api.onTransportFallback = () => {
        throw new Error("no media source");
    };
    api.onReceiveMessage({
        data: JSON.stringify({ setupComplete: {}, sessionResumptionUpdate: { newHandle: "h" } }),
    });
    assert.deepEqual(plain(errors), ["Could not switch media to the WebSocket: no media source"]);
    assert.equal(api.transportMode, "websocket");
    assert.equal(closed, 1);
    assert.deepEqual(plain(handled), []); // Nothing after the session ended.
    assert.equal(started, 0);
});

test("onConnectionStarted runs after a WebSocket fallback", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.transportMode = "webrtc";
    api.webRtcManager = { close: () => {} };
    const order = [];
    api.onErrorMessage = (message) => order.push(`error: ${message}`);
    api.onReceiveResponse = (message) => order.push(message.type);
    api.onConnectionStarted = () => order.push("started");
    api.onTransportFallback = () => order.push("fallback");
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.deepEqual(plain(order), ["fallback", "SETUP COMPLETE", "started"]);
});

// A session whose WebSocket is still in its handshake. `api.posts` records
// control requests as [command, session_id].
function connectingApi() {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.transportMode = "websocket";
    api.webRtcManager = null;
    api.onReceiveResponse = () => {};
    api.errors = [];
    api.reconnects = 0;
    api.posts = [];
    api.onErrorMessage = (message) => api.errors.push(message);
    api.onReconnectNeeded = () => api.reconnects++;
    api.sendPostRequest = async (url, body) => {
        api.posts.push([body.command, body.session_id]);
        return {};
    };
    api.sessionId = "s-1";
    api.setupWebSocketToService();
    api.webSocket.readyState = FakeWebSocket.CONNECTING;
    return api;
}

// A session whose WebSocket has opened (setup not yet sent or confirmed).
function connectedApi() {
    const api = connectingApi();
    api.webSocket.readyState = FakeWebSocket.OPEN;
    api.sendInitialSetupMessages = async () => {};
    api.webSocket.onopen();
    delete api.sendInitialSetupMessages;
    return api;
}

test("a server restart (1001) resumes when the session has a handle", () => {
    const api = connectedApi();
    api.setResumption(true, "");
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    api.onReceiveMessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h1" } }) });
    api.webSocket.onclose({ code: 1001, reason: "Server restarting" });
    assert.equal(api.reconnects, 1);
    assert.equal(api.errors.length, 0);
    assert.equal(api.latestResumptionHandle, "h1");
});

test("a server restart without a handle is reported as an error", () => {
    const api = connectedApi();
    api.setResumption(true, "");
    api.webSocket.onclose({ code: 1001, reason: "Server restarting" });
    assert.equal(api.reconnects, 0);
    assert.deepEqual(plain(api.errors), ["Connection closed (code 1001): Server restarting"]);
});

test("disconnect() closes quietly and stops realtime input", () => {
    const api = connectedApi();
    const webSocket = api.webSocket;
    webSocket.close = () => {};
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    api.disconnect();
    assert.equal(api.webSocket, null);
    assert.equal(api.isSetupComplete, false);
    assert.equal(webSocket.onclose, null);
    assert.equal(api.errors.length, 0);
});

test("a WebSocket that closes before it opens releases its session", () => {
    // E.g. a proxy that drops upgrades: the server never saw the /ws, so its
    // record would hold a --max_sessions slot until it expires.
    const api = connectingApi();
    api.webSocket.onclose({ code: 1006, reason: "" });
    assert.deepEqual(plain(api.posts), [["disconnect", "s-1"]]);
    assert.deepEqual(plain(api.errors), ["Lost the connection to the server."]);
});

test("disconnect() while the WebSocket is connecting releases its session", () => {
    const api = connectingApi();
    let closed = 0;
    api.webSocket.close = () => closed++;
    api.disconnect();
    assert.equal(closed, 1);
    assert.deepEqual(plain(api.posts), [["disconnect", "s-1"]]);
    assert.equal(api.errors.length, 0);
});

test("a setup timeout before the WebSocket opens releases its session", () => {
    const api = connectingApi();
    api.webSocket.close = () => {};
    // As the app does: an error ends the session.
    api.onErrorMessage = (message) => {
        api.errors.push(message);
        api.disconnect();
    };
    timers[timers.length - 1].fn();
    assert.deepEqual(plain(api.errors), ["Timed out waiting for the server to set up the session."]);
    assert.deepEqual(plain(api.posts), [["disconnect", "s-1"]]);
});

test("an opened WebSocket releases nothing when it closes or is disconnected", () => {
    // The server ends the session itself when an attached WebSocket closes.
    const closedByServer = connectedApi();
    closedByServer.webSocket.onclose({ code: 1011, reason: "boom" });
    assert.deepEqual(plain(closedByServer.posts), []);
    const disconnected = connectedApi();
    disconnected.webSocket.close = () => {};
    disconnected.disconnect();
    assert.deepEqual(plain(disconnected.posts), []);
});

test("setup times out if the server never confirms it", () => {
    const api = connectedApi();
    const timer = timers[timers.length - 1];
    assert.equal(timer.ms, 30000);
    timer.fn();
    assert.deepEqual(plain(api.errors), ["Timed out waiting for the server to set up the session."]);
});

test("setupComplete cancels the setup timeout", () => {
    const api = connectedApi();
    const timer = timers[timers.length - 1];
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.equal(timer.cleared, true);
});

test("disconnect() during connect() stops it from opening a WebSocket", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const bodies = [];
    let release;
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return bodies.length === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve({});
    };
    let opened = 0;
    api.setupWebSocketToService = () => opened++;
    const connecting = api.connect();
    await Promise.resolve();
    api.disconnect();
    release({ project_id: "p" });
    await connecting;
    assert.equal(opened, 0);
    // The backend set the session up, so it is told to drop it; otherwise it
    // holds a --max_sessions slot until it expires.
    assert.deepEqual(plain(bodies.map((b) => [b.command, b.session_id])), [
        ["connect", bodies[0].session_id],
        ["disconnect", bodies[0].session_id],
    ]);
});

test("a failed function declaration releases the session it set up", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    api.setFunctionCall([{ name: "f" }]);
    const posts = [];
    api.sendPostRequest = (url, body) => {
        posts.push([url, body.command || body.objective]);
        return body.objective === "fc_definition"
            ? Promise.reject(Object.assign(new Error("HTTP 400: bad"), { status: 400 }))
            : Promise.resolve({ project_id: "p" });
    };
    let opened = 0;
    api.setupWebSocketToService = () => opened++;
    await api.connect();
    assert.equal(opened, 0);
    assert.deepEqual(errors, ["Could not set up function declarations: HTTP 400: bad"]);
    assert.deepEqual(plain(posts), [
        ["/api/control", "connect"],
        ["/api/post_endpoint", "fc_definition"],
        ["/api/control", "disconnect"],
    ]);
});

test("a control request that fails releases nothing", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.onErrorMessage = () => {};
    const commands = [];
    api.sendPostRequest = (url, body) => {
        commands.push(body.command);
        return Promise.reject(Object.assign(new Error("HTTP 400: bad"), { status: 400 }));
    };
    await api.connect();
    assert.deepEqual(commands, ["connect"]);
});

// GeminiLiveAPI whose fetch() answers every POST with `reply(body)`:
// {status, type, text}, never if it returns "hang" (until the request is
// aborted, like a real fetch), or a TypeError (unreachable server) for
// "network". `posts` records the parsed request bodies;
// `timers` records timeouts, which run only when a test fires them.
function apiWithFetch(reply) {
    const posts = [];
    const timers = [];
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        posts.push(body);
        const answer = reply(body);
        if (answer === "hang") {
            return new Promise((_, reject) => {
                const abort = () => reject(init.signal.reason);
                if (init.signal?.aborted) abort();
                init.signal?.addEventListener("abort", abort);
            });
        }
        if (answer === "network") {
            throw new TypeError("Failed to fetch");
        }
        const { status = 200, type = null, text = "" } = answer;
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: "",
            headers: { get: (name) => (name.toLowerCase() === "content-type" ? type : null) },
            json: async () => JSON.parse(text),
        };
    };
    const context = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: FakeWebSocket,
        fetch,
        AbortController,
        TypeError, // So the script's instanceof check sees the fetch's errors.
        document: { getElementById: () => null },
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false, fired: false }),
        clearTimeout: (id) => {
            if (timers[id - 1]) timers[id - 1].cleared = true;
        },
    });
    const api = new context.GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    return { api, posts, timers };
}

// Lets pending promise callbacks run, then fires the oldest live timer.
async function fireNextTimer(timers) {
    await new Promise((resolve) => setImmediate(resolve));
    const timer = timers.find((t) => !t.cleared && !t.fired);
    assert.ok(timer, "no pending timer");
    timer.fired = true;
    timer.fn();
    return timer.ms;
}

test("session setup errors keep the request's error as their cause", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const original = Object.assign(new Error("HTTP 503: full"), { status: 503 });
    api.postWithRetry = () => Promise.reject(original);
    api.sendPostRequest = () => Promise.reject(original);
    api.setFunctionCall([{ name: "f" }]);
    for (const setup of [() => api.initBackendService("s1"), () => api.setupFuncDeclarationToService("s1")]) {
        await assert.rejects(setup(), (error) => error.cause === original && error.message.endsWith("HTTP 503: full"));
    }
});

test("a connect the server never answers times out, is retried once, and is reported", async () => {
    // E.g. a wedged backend, or a dead pooled connection: before, "Connecting"
    // stayed until the user clicked Disconnect.
    const { api, posts, timers } = apiWithFetch((body) => (body.command === "connect" ? "hang" : { text: "{}" }));
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    let opened = 0;
    api.setupWebSocketToService = () => opened++;
    const connecting = api.connect();
    const fired = [];
    for (let i = 0; i < 3; i++) fired.push(await fireNextTimer(timers));
    await connecting;
    // 15 s attempt, 1 s backoff, 15 s attempt.
    assert.deepEqual(fired, [15000, 1000, 15000]);
    assert.equal(opened, 0);
    assert.deepEqual(errors, ["Could not start the session: the server didn't answer within 15 s"]);
    // The server may have created the record after all; release it.
    assert.deepEqual(plain(posts.map((b) => b.command)), ["connect", "connect", "disconnect"]);
    await new Promise((resolve) => setImmediate(resolve)); // The release's reply.
    assert.ok(timers.every((t) => t.cleared || t.fired));
});

test("a connect that times out once succeeds on the retry", async () => {
    let connects = 0;
    const { api, posts, timers } = apiWithFetch(() =>
        ++connects === 1 ? "hang" : { type: "application/json", text: '{"project_id": "p"}' }
    );
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    let opened = 0;
    api.setupWebSocketToService = () => opened++;
    const connecting = api.connect();
    await fireNextTimer(timers); // The first attempt's timeout.
    await fireNextTimer(timers); // The backoff.
    await connecting;
    assert.equal(opened, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(plain(posts.map((b) => b.command)), ["connect", "connect"]);
    // The answered attempt's timeout was cleared.
    assert.ok(timers.every((t) => t.cleared || t.fired));
});

test("disconnect() during a connect retry's backoff stops the retries", async () => {
    for (const [first, expected] of [
        // A timed-out attempt may still create the record, so it's released.
        ["hang", ["connect", "disconnect"]],
        ["network", ["connect"]],
    ]) {
        let connects = 0;
        const { api, posts, timers } = apiWithFetch((body) =>
            body.command === "disconnect" ? { type: "application/json", text: "{}" } : ++connects === 1 ? first : "hang"
        );
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        let opened = 0;
        api.setupWebSocketToService = () => opened++;
        const connecting = api.connect();
        if (first === "hang") await fireNextTimer(timers); // The first attempt's timeout.
        await new Promise((resolve) => setImmediate(resolve)); // Into the backoff.
        api.disconnect();
        await fireNextTimer(timers); // The backoff.
        await connecting;
        assert.equal(opened, 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(plain(posts.map((b) => b.command)), expected, first);
        await new Promise((resolve) => setImmediate(resolve)); // The release's reply.
        assert.ok(timers.every((t) => t.cleared || t.fired), first);
    }
});

test("a connect that timed out once and then failed otherwise is still released", async () => {
    // The server may create the record for the timed-out attempt late.
    let connects = 0;
    const { api, posts, timers } = apiWithFetch((body) =>
        body.command === "disconnect" ? { type: "application/json", text: "{}" } : ++connects === 1 ? "hang" : "network"
    );
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    const connecting = api.connect();
    const fired = [];
    for (let i = 0; i < 4; i++) fired.push(await fireNextTimer(timers));
    await connecting;
    // 15 s attempt, then backoffs around three network errors.
    assert.deepEqual(fired, [15000, 1000, 2000, 3000]);
    assert.deepEqual(errors, ["Could not start the session: Failed to fetch"]);
    assert.deepEqual(plain(posts.map((b) => b.command)), ["connect", "connect", "connect", "connect", "disconnect"]);
});

test("a connect that fails without a timeout isn't released", async () => {
    const { api, posts, timers } = apiWithFetch(() => "network");
    const connecting = api.connect();
    for (let i = 0; i < 3; i++) await fireNextTimer(timers);
    await connecting;
    assert.deepEqual(plain(posts.map((b) => b.command)), ["connect", "connect", "connect", "connect"]);
});

test("function declarations the server never takes fail the connect after the timeout", async () => {
    const { api, posts, timers } = apiWithFetch((body) =>
        body.objective === "fc_definition" ? "hang" : { type: "application/json", text: "{}" }
    );
    api.functionCallDefinition = [{ name: "f" }];
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    const connecting = api.connect();
    assert.equal(await fireNextTimer(timers), 15000);
    await connecting;
    assert.deepEqual(errors, ["Could not set up function declarations: the server didn't answer within 15 s"]);
    // The connect succeeded, so its record is released.
    assert.deepEqual(plain(posts.map((b) => b.command ?? b.objective)), ["connect", "fc_definition", "disconnect"]);
});

test("sendPostRequest() with a timeout still honors the caller's signal", async () => {
    const { api, timers } = apiWithFetch(() => "hang");
    const controller = new AbortController();
    const request = api.sendPostRequest("/api/post_endpoint", {}, { signal: controller.signal, timeoutMs: 15000 });
    controller.abort("cancelled");
    await assert.rejects(request, (reason) => reason === "cancelled");
    assert.ok(timers[0].cleared);
    // Without a timeout, no timer is set (the simulator has its own).
    const plainRequest = api.sendPostRequest("/api/post_endpoint", {}, { signal: AbortSignal.abort("timeout") });
    await assert.rejects(plainRequest, (reason) => reason === "timeout");
    assert.equal(timers.length, 1);
});

test("a 200 control reply that isn't JSON fails the connect instead of opening a WebSocket", async () => {
    // E.g. a captive portal or a misconfigured proxy answering for the server.
    const { api, posts } = apiWithFetch(() => ({ type: "text/html", text: "<html>Sign in</html>" }));
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    let opened = 0;
    api.setupWebSocketToService = () => opened++;
    await api.connect();
    assert.equal(opened, 0);
    assert.deepEqual(errors, [
        "Could not start the session: the server's reply wasn't JSON (HTTP 200, text/html); " +
            "a proxy or captive portal may be in the way",
    ]);
    // Not retried: the same page would come back.
    assert.deepEqual(plain(posts.map((b) => b.command)), ["connect"]);
});

test("sendPostRequest() returns a JSON object and rejects any other 2xx reply", async () => {
    const replies = {
        object: { type: "application/json", text: '{"removed": true}' },
        string: { type: "application/json", text: '"ok"' },
        null: { type: "application/json", text: "null" },
        array: { type: "application/json", text: "[]" },
        empty: { status: 204 },
    };
    const { api } = apiWithFetch((body) => replies[body.reply]);
    assert.deepEqual(plain(await api.sendPostRequest("/api/control", { reply: "object" })), { removed: true });
    for (const reply of ["string", "null", "array"]) {
        await assert.rejects(api.sendPostRequest("/api/control", { reply }), {
            message: /^the server's reply wasn't JSON \(HTTP 200, application\/json\)/,
        });
    }
    await assert.rejects(api.sendPostRequest("/api/control", { reply: "empty" }), {
        message: /^the server's reply wasn't JSON \(HTTP 204, no content type\)/,
    });
});

test("an HTTP error still reports the server's error text", async () => {
    const { api } = apiWithFetch(() => ({ status: 503, type: "application/json", text: '{"error": "Too many sessions"}' }));
    await assert.rejects(api.sendPostRequest("/api/control", {}), { message: "HTTP 503: Too many sessions", status: 503 });
});

test("disconnect() while a resume waits for the old WebSocket releases the new session", async () => {
    const api = connectedApi();
    const oldWebSocket = api.webSocket;
    oldWebSocket.close = () => {}; // Its close event arrives later.
    const bodies = [];
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return Promise.resolve({ project_id: "p" });
    };
    let opened = 0;
    api.setupWebSocketToService = () => opened++;
    const resuming = api.resume("h");
    await new Promise((resolve) => setImmediate(resolve)); // prepare() finishes.
    api.disconnect();
    oldWebSocket.onclose({ code: 1000, reason: "" });
    await resuming;
    assert.equal(opened, 0);
    assert.deepEqual(plain(bodies.map((b) => b.command)), ["connect", "disconnect"]);
    assert.equal(bodies[1].session_id, bodies[0].session_id);
});

test("a cancelled connect's failure doesn't end the next connection", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    const bodies = [];
    let failFirst;
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return bodies.length === 1
            ? new Promise((_, reject) => (failFirst = reject))
            : Promise.resolve({ project_id: "p2" });
    };
    let opened = 0;
    api.setupWebSocketToService = () => opened++;

    const first = api.connect();
    await Promise.resolve();
    api.disconnect();
    const second = api.connect();
    failFirst(Object.assign(new Error("HTTP 500"), { status: 500 }));
    await Promise.all([first, second]);

    assert.deepEqual(errors, []);
    assert.equal(opened, 1);
    assert.equal(api.projectId, "p2");
    assert.notEqual(bodies[0].session_id, bodies[1].session_id);
});

test("automatic resumes after 1001 are limited", () => {
    const api = connectedApi();
    api.setResumption(true, "");
    api.onReconnectNeeded = () => {
        api.reconnects++;
        api.setupWebSocketToService(); // Stand-in for resume().
    };
    // Three resumes are allowed; the fourth close within a minute is reported.
    for (let i = 0; i < 4; i++) {
        api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
        api.onReceiveMessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h" } }) });
        api.webSocket.onclose({ code: 1001, reason: "" });
    }
    assert.equal(api.reconnects, 3);
    assert.equal(api.errors.length, 1);
});

test("GoAway resumes are limited, sharing the budget with 1001 resumes", () => {
    const api = connectedApi();
    assert.equal(api.goAwayAction(), "unavailable"); // Resumption is off.
    api.setResumption(true, "");
    assert.equal(api.goAwayAction(), "unavailable"); // No handle yet.
    api.latestResumptionHandle = "h";
    assert.equal(api.goAwayAction(), "resume");
    assert.equal(api.goAwayAction(), "resume");
    // A server restart takes the third resume of the minute...
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    api.webSocket.onclose({ code: 1001, reason: "" });
    assert.equal(api.reconnects, 1);
    // ...so the next GoAway doesn't resume, and neither does the next restart.
    assert.equal(api.goAwayAction(), "limited");
    api.setupWebSocketToService();
    api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    api.webSocket.onclose({ code: 1001, reason: "" });
    assert.equal(api.reconnects, 1);
    assert.equal(api.errors.length, 1);
});

test("connect() restores the automatic resume budget", async () => {
    const api = connectedApi();
    api.setResumption(true, "");
    api.latestResumptionHandle = "h";
    for (let i = 0; i < 3; i++) assert.equal(api.goAwayAction(), "resume");
    assert.equal(api.goAwayAction(), "limited");
    api.postWithRetry = async () => ({});
    api.setupWebSocketToService = () => {};
    await api.connect();
    api.latestResumptionHandle = "h2";
    assert.equal(api.goAwayAction(), "resume");
});

test("1001 before setup completed is an error, not a resume", () => {
    const api = connectedApi();
    api.setResumption(true, "");
    api.latestResumptionHandle = "h";
    api.webSocket.onclose({ code: 1001, reason: "" });
    assert.equal(api.reconnects, 0);
    assert.equal(api.errors.length, 1);
});

test("a session's end marks WebRTC closed only when its media used WebRTC", () => {
    const closes = [];
    const end = (transportMode, how) => {
        const api = connectedApi();
        api.transportMode = transportMode; // "websocket" also after a fallback.
        api.webRtcManager = { close: (options) => closes.push([transportMode, how, options.markClosed]) };
        api.webSocket.close = () => {};
        if (how === "disconnect") api.disconnect();
        else api.webSocket.onclose({ code: 1011, reason: "Internal error" });
    };
    for (const transportMode of ["webrtc", "websocket"]) {
        for (const how of ["disconnect", "server close"]) end(transportMode, how);
    }
    assert.deepEqual(plain(closes), [
        ["webrtc", "disconnect", true],
        ["webrtc", "server close", true],
        ["websocket", "disconnect", false],
        ["websocket", "server close", false],
    ]);
});

test("resume() closes the old WebRTC connection before prepare(), keeping local media", async () => {
    for (const transportMode of ["webrtc", "websocket"]) {
        const closes = [];
        let finishPrepare;
        const api = connectedApi();
        api.transportMode = transportMode;
        api.webRtcManager = { close: (options) => closes.push(options) };
        const oldWebSocket = api.webSocket;
        oldWebSocket.close = () => oldWebSocket.onclose?.();
        api.prepare = () => new Promise((resolve) => (finishPrepare = resolve));
        const resuming = api.resume("h1");
        // Closed synchronously before prepare() finishes so the old peer
        // connection's stats polling and failure events stop immediately.
        assert.deepEqual(plain(closes), [
            { keepLocalMedia: true, markClosed: transportMode === "webrtc" },
        ]);
        finishPrepare(false);
        await resuming;
    }
});

test("a session's end resets the speed readouts and counters for the next session", () => {
    const send = (api) => api.webSocket.send(JSON.stringify({ realtimeInput: { text: "x".repeat(4096) } }));
    const receive = (api) => api.onReceiveMessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    const ends = {
        disconnect: (api) => api.disconnect(),
        "server close": (api) => api.webSocket.onclose({ code: 1011, reason: "Internal error" }),
        resume: (api) => {
            api.resume("h1").catch(() => {});
        },
    };
    for (const [how, end] of Object.entries(ends)) {
        const api = connectedApi();
        api.webSocket.close = () => {};
        api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
        send(api);
        receive(api);
        intervals[intervals.length - 1]();
        assert.notEqual(element("upload-speed").textContent, "0.00", how);
        assert.notEqual(element("download-speed").textContent, "0.00", how);
        send(api); // Counted, but the session ends before the next reading.
        receive(api);
        end(api);
        assert.equal(element("upload-speed").textContent, "0.00", how);
        assert.equal(element("download-speed").textContent, "0.00", how);
        assert.equal(api.bytesOut, 0, how);
        assert.equal(api.bytesIn, 0, how);
        assert.equal(api.history.length, 0, how);
    }
});

test("Disconnect during WebRTC ICE gathering neither sends setup nor reports an error", async () => {
    const api = connectedApi();
    api.transportMode = "webrtc";
    let finishGathering;
    api.webRtcManager = {
        initiateSession: () => new Promise((resolve) => (finishGathering = resolve)),
        close() {},
    };
    const webSocket = api.webSocket;
    webSocket.close = () => {};
    const opening = webSocket.onopen();
    api.disconnect();
    finishGathering("v=0");
    await opening;
    assert.equal(webSocket.sent.length, 0);
    assert.equal(api.errors.length, 0);
    assert.equal(webSocket.onopen, null);
});

test("toFunctionDeclarations accepts Gemini and OpenAI-style tool files", () => {
    const decl = { name: "f", description: "d", parameters: { type: "object" } };
    const cases = [
        [[decl], [decl]],
        [decl, [decl]],
        [[{ type: "function", function: decl }], [decl]],
        [{ tools: [{ type: "function", function: decl }] }, [decl]],
    ];
    for (const [input, expected] of cases) {
        assert.deepEqual(plain(GeminiLiveAPI.toFunctionDeclarations(input)), expected);
    }
});

test("realtime input config sends only what the user chose", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.setVad(false, false, "", "");
    assert.equal(api._buildRealtimeInputConfig(), null);

    api.setVad(false, false, "high", "");
    assert.deepEqual(plain(api._buildRealtimeInputConfig()), {
        automatic_activity_detection: { start_of_speech_sensitivity: "START_SENSITIVITY_HIGH" },
    });

    api.setVad(true, true, "", "low");
    assert.deepEqual(plain(api._buildRealtimeInputConfig()), {
        automatic_activity_detection: { end_of_speech_sensitivity: "END_SENSITIVITY_LOW", disabled: true },
        activity_handling: "NO_INTERRUPTION",
    });
});

test("describeClose explains how the server ended the session", () => {
    assert.equal(
        GeminiLiveAPI.describeClose({ code: 1008, reason: "Quota exceeded" }),
        "Connection closed (code 1008): Quota exceeded"
    );
    assert.equal(
        GeminiLiveAPI.describeClose({ code: 1000, reason: "" }),
        "The session was closed by the server."
    );
    assert.equal(
        GeminiLiveAPI.describeClose({ code: 1006, reason: "" }),
        "Lost the connection to the server."
    );
    assert.equal(
        GeminiLiveAPI.describeClose({ code: 1009, reason: "" }),
        "Connection closed (code 1009): a message was larger than the server accepts (64 MB)."
    );
});

test("setApiHost maps environments to hosts", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const cases = {
        prod: "aiplatform.googleapis.com",
        staging: "staging-aiplatform.sandbox.googleapis.com",
        "prod-us-rep": "aiplatform.us.rep.googleapis.com",
        "autopush-us-rep": "autopush-aiplatform.us.rep.sandbox.googleapis.com",
        "autopush-common": "autopush-common",
    };
    for (const [environment, host] of Object.entries(cases)) {
        api.setApiHost(environment);
        assert.equal(api.endPoint, host, environment);
    }
});

test("setup message carries the configured fields", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.transportMode = "websocket";
    api.projectId = "p";
    api.location = "us-central1";
    api.setApiHost("prod");
    api.setModel("gemini-live-2.5-flash-native-audio");
    api.responseModalities = ["AUDIO"];
    api.setVoice("puck", "en-US");
    api.setBitrates("", "");
    api.systemInstructions = "Be brief.";
    await api.sendInitialSetupMessages();
    const { setup } = api.webSocket.sent[0];
    assert.equal(
        setup.model,
        "projects/p/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio"
    );
    assert.equal(setup.avatar_config, undefined);
    assert.deepEqual(plain(setup.system_instruction), { parts: [{ text: "Be brief." }] });
    assert.equal(setup.generation_config.speech_config.voice_config.prebuilt_voice_config.voice_name, "puck");
});

test("a pasted resumption handle is sent without surrounding whitespace", async () => {
    const sentResumption = async (handle) => {
        const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        api.webSocket = new FakeWebSocket();
        api.transportMode = "websocket";
        api.setBitrates("", "");
        api.setResumption(true, handle);
        await api.sendInitialSetupMessages();
        return plain(api.webSocket.sent[0].setup.session_resumption);
    };
    assert.deepEqual(await sentResumption("  abc123\n"), { handle: "abc123" });
    // Blank means "start a resumable session", not a resume of handle " ".
    assert.deepEqual(await sentResumption(" \t\n"), {});
    assert.deepEqual(await sentResumption(""), {});
});

test("typed bitrates are sent as positive integers or not at all", async () => {
    const sentBitrates = async (audio, video) => {
        const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        api.webSocket = new FakeWebSocket();
        api.transportMode = "websocket";
        api.responseModalities = ["AUDIO", "VIDEO"];
        api.setBitrates(audio, video);
        await api.sendInitialSetupMessages();
        // Parsed from the wire string, so a float or Infinity shows up as 64000.5 or null.
        const { audio_bitrate_bps, video_bitrate_bps } = api.webSocket.sent[0].setup.avatar_config;
        return [audio_bitrate_bps, video_bitrate_bps];
    };
    assert.deepEqual(await sentBitrates("64000.5", "1e5"), [64001, 100000]);
    assert.deepEqual(await sentBitrates(" 32000 ", 500000), [32000, 500000]);
    assert.deepEqual(await sentBitrates("-64000", "Infinity"), [undefined, undefined]);
    assert.deepEqual(await sentBitrates("0.4", "abc"), [undefined, undefined]);
    assert.deepEqual(await sentBitrates("", ""), [undefined, undefined]);
});

// A connected session whose server set --idle_timeout_s=idleS.
async function idleApi(idleS = 120) {
    const api = connectedApi();
    api.idleMessages = [];
    api.onIdleTimeout = (message) => api.idleMessages.push(message);
    api.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: idleS });
    api.setupWebSocketToService = () => {};
    await api.connect();
    return api;
}

// Fires the pending idle timer as if no activity happened since `idleAgoMs`.
function fireIdleTimer(api, idleAgoMs) {
    const timer = timers[api.idleTimer - 1];
    assert.equal(timer.cleared, false);
    api.lastActivityAt = performance.now() - idleAgoMs;
    timer.fn();
}

test("a session ends after the server's idle timeout without activity", async () => {
    const api = await idleApi(120);
    assert.equal(api.idleTimeoutMs, 120000);
    assert.equal(timers[api.idleTimer - 1].ms, 120000);
    fireIdleTimer(api, 120000);
    assert.deepEqual(plain(api.idleMessages), ["Disconnected after 2 minutes without activity."]);
    assert.equal(api.idleTimer, null);
});

test("conversation events and user input postpone the idle timeout", async () => {
    const api = await idleApi(60);
    api.isSetupComplete = true; // Input is only sent once set up.
    const activities = {
        "input transcript": { serverContent: { inputTranscription: { text: "hi" } } },
        "output transcript": { serverContent: { outputTranscription: { text: "hello" } } },
        "model text": { serverContent: { modelTurn: { parts: [{ text: "hello" }] } } },
        "turn end": { serverContent: { turnComplete: true } },
        // Speech the server detects counts even with input transcription off.
        "voice activity": { voiceActivity: { type: "ACTIVITY_START", audioOffset: "0.200s" } },
        interruption: { serverContent: { interrupted: true } },
        "function call": { toolCall: { functionCalls: [{ id: "1", name: "f", args: {} }] } },
    };
    const userInput = {
        "text message": () => api.sendTextMessage("hi"),
        "push-to-talk": () => api.sendVoiceActivityMessage(true),
        "page input": () => api.noteActivity(),
    };
    for (const [name, act] of [
        ...Object.entries(activities).map(([name, raw]) => [
            name,
            () => api.onReceiveMessage({ data: JSON.stringify(raw) }),
        ]),
        ...Object.entries(userInput),
    ]) {
        api.lastActivityAt = 0;
        act();
        assert.ok(performance.now() - api.lastActivityAt < 1000, name);
    }
    // With the last activity 30 s ago, the timer waits out the other 30 s.
    fireIdleTimer(api, 30000);
    assert.deepEqual(plain(api.idleMessages), []);
    assert.ok(Math.abs(timers[api.idleTimer - 1].ms - 30000) < 1000);
});

test("audio, avatar video and usage reports don't postpone the idle timeout", async () => {
    const api = await idleApi(60);
    const longAgo = performance.now() - 60000;
    api.lastActivityAt = longAgo;
    for (const raw of [
        { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AA==" } }] } } },
        { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "video/mp4", data: "AA==" } }] } } },
        { usageMetadata: { totalTokenCount: 1 } },
        { sessionResumptionUpdate: { newHandle: "h" } },
    ]) {
        api.onReceiveMessage({ data: JSON.stringify(raw) });
    }
    assert.equal(api.lastActivityAt, longAgo);
    timers[api.idleTimer - 1].fn();
    assert.equal(api.idleMessages.length, 1);
});

test("an idle timeout beyond setTimeout's limit waits in steps instead of spinning", async () => {
    // Browsers run a delay above 2^31-1 ms at once, so check() would re-arm
    // itself in a tight loop for the whole session.
    const api = await idleApi(30 * 86400); // 30 days.
    const limit = 2 ** 31 - 1;
    assert.equal(timers[api.idleTimer - 1].ms, limit);
    fireIdleTimer(api, 1000); // Recent activity: the re-armed wait is capped too.
    assert.deepEqual(plain(api.idleMessages), []);
    assert.equal(timers[api.idleTimer - 1].ms, limit);
    fireIdleTimer(api, 30 * 86400 * 1000);
    assert.deepEqual(plain(api.idleMessages), ["Disconnected after 43200 minutes without activity."]);
});

test("idle and resume-limit times follow the monotonic clock, not the wall clock", () => {
    const clock = { now: 0, wallNow: 0 };
    const recorded = [];
    const { GeminiLiveAPI } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: FakeWebSocket,
        setTimeout: (fn, ms) => recorded.push({ fn, ms }),
        clearTimeout: () => {},
        performance: { now: () => clock.now },
        Date: { now: () => clock.wallNow },
    });
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const messages = [];
    api.onIdleTimeout = (message) => messages.push(message);
    api.idleTimeoutMs = 60000;
    api.startIdleTimer();

    // A wall clock set an hour ahead doesn't end the session...
    clock.wallNow = 3600000;
    clock.now = 1000;
    recorded.at(-1).fn();
    assert.deepEqual(messages, []);
    assert.equal(recorded.at(-1).ms, 59000);
    // ...and one set back doesn't postpone the end.
    clock.wallNow = -3600000;
    clock.now = 60000;
    recorded.at(-1).fn();
    assert.equal(messages.length, 1);

    // Nor does a forward step make room for more automatic resumes.
    for (let i = 0; i < 3; i++) assert.equal(api.takeAutoResume(), true);
    clock.wallNow += 120000;
    assert.equal(api.takeAutoResume(), false);
    clock.now += 60000;
    assert.equal(api.takeAutoResume(), true);
});

test("disconnect() stops the idle timer, and idle_timeout_s 0 disables it", async () => {
    const api = await idleApi(120);
    const timer = timers[api.idleTimer - 1];
    api.webSocket.close = () => {};
    api.disconnect();
    assert.equal(timer.cleared, true);
    assert.equal(api.idleTimer, null);

    const off = await idleApi(0);
    assert.equal(off.idleTimeoutMs, 0);
    assert.equal(off.idleTimer, null);
});

// Resumes `api` from a server that now sets --idle_timeout_s=idleS.
async function resumeWithIdle(api, idleS) {
    api.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: idleS });
    if (api.webSocket) {
        api.webSocket.close = () => {};
        api.webSocket.readyState = FakeWebSocket.CLOSED;
    }
    await api.resume("h"); // setupWebSocketToService is a no-op: no new socket.
}

test("a resume keeps the conversation's last activity", async () => {
    const api = await idleApi(120);
    const lastActivityAt = performance.now() - 30000;
    api.lastActivityAt = lastActivityAt;
    await resumeWithIdle(api, 120);
    assert.equal(api.lastActivityAt, lastActivityAt);
    // The deadline stays 120 s after the last activity, not after the resume.
    assert.ok(Math.abs(timers[api.idleTimer - 1].ms - 90000) < 1000);
    fireIdleTimer(api, 120000);
    assert.deepEqual(plain(api.idleMessages), ["Disconnected after 2 minutes without activity."]);
});

test("a resume that turns the idle timeout off stops the timer", async () => {
    const api = await idleApi(120);
    const old = timers[api.idleTimer - 1];
    await resumeWithIdle(api, 0);
    assert.equal(old.cleared, true);
    assert.equal(api.idleTimer, null);
    // Had it fired while the resume was still preparing, it ends nothing.
    old.fn();
    assert.deepEqual(plain(api.idleMessages), []);
});

test("a resume that turns the idle timeout on or changes it re-arms the timer", async () => {
    const api = await idleApi(0);
    assert.equal(api.idleTimer, null);
    api.lastActivityAt = performance.now() - 10000;
    await resumeWithIdle(api, 60);
    assert.ok(Math.abs(timers[api.idleTimer - 1].ms - 50000) < 1000);

    const old = timers[api.idleTimer - 1];
    await resumeWithIdle(api, 20);
    assert.equal(old.cleared, true);
    assert.ok(Math.abs(timers[api.idleTimer - 1].ms - 10000) < 1000);
    // Already idle longer than the new timeout: it fires on the next tick.
    api.lastActivityAt = performance.now() - 30000;
    await resumeWithIdle(api, 20);
    assert.equal(timers[api.idleTimer - 1].ms, 0);
    timers[api.idleTimer - 1].fn();
    assert.deepEqual(plain(api.idleMessages), ["Disconnected after 20 seconds without activity."]);
});
