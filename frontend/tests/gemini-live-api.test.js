const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

class FakeWebSocket {
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
const { GeminiLiveAPI, GeminiLiveResponseMessage } = loadScript(
    "gemini-live-api.js",
    ["GeminiLiveAPI", "GeminiLiveResponseMessage"],
    {
        WebSocket: FakeWebSocket,
        // Inert: the bandwidth meter's interval would keep the test alive.
        setInterval: () => 1,
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

function connectedApi() {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.transportMode = "websocket";
    api.webRtcManager = null;
    api.onReceiveResponse = () => {};
    api.errors = [];
    api.reconnects = 0;
    api.onErrorMessage = (message) => api.errors.push(message);
    api.onReconnectNeeded = () => api.reconnects++;
    api.setupWebSocketToService();
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
    api.lastActivityAt = Date.now() - idleAgoMs;
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
        assert.ok(Date.now() - api.lastActivityAt < 1000, name);
    }
    // With the last activity 30 s ago, the timer waits out the other 30 s.
    fireIdleTimer(api, 30000);
    assert.deepEqual(plain(api.idleMessages), []);
    assert.ok(Math.abs(timers[api.idleTimer - 1].ms - 30000) < 1000);
});

test("audio, avatar video and usage reports don't postpone the idle timeout", async () => {
    const api = await idleApi(60);
    api.lastActivityAt = 0;
    for (const raw of [
        { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AA==" } }] } } },
        { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "video/mp4", data: "AA==" } }] } } },
        { usageMetadata: { totalTokenCount: 1 } },
        { sessionResumptionUpdate: { newHandle: "h" } },
    ]) {
        api.onReceiveMessage({ data: JSON.stringify(raw) });
    }
    assert.equal(api.lastActivityAt, 0);
    timers[api.idleTimer - 1].fn();
    assert.equal(api.idleMessages.length, 1);
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

test("a resume keeps the conversation's idle timer", async () => {
    const api = await idleApi(120);
    const timer = api.idleTimer;
    api.lastActivityAt = 12345;
    api.webSocket.close = () => {};
    api.webSocket.readyState = FakeWebSocket.CLOSED;
    await api.resume("h");
    assert.equal(api.idleTimer, timer);
    assert.equal(timers[timer - 1].cleared, false);
    assert.equal(api.lastActivityAt, 12345);
});
