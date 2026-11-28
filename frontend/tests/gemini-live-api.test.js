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

test("parseAll classifies inline media MIME types case-insensitively with parameters", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        serverContent: {
            modelTurn: {
                parts: [
                    { inlineData: { mimeType: "Image/JPEG; charset=binary", data: "AAA=" } },
                    { inlineData: { mimeType: " Video/MP4 ; codecs=avc1", data: "BBB=" } },
                    { inlineData: { mime_type: "VIDEO/JPEG2000; rate=30", data: "CCC=" } },
                    { inlineData: { mimeType: "AUDIO/PCM; rate=24000", data: "DDD=" } },
                ],
            },
        },
    });
    assert.deepEqual(types(events), ["VIDEO", "VIDEO", "VIDEO", "AUDIO"]);
    assert.equal(events[0].mimeType, "Image/JPEG; charset=binary");
    assert.equal(events[1].mimeType, " Video/MP4 ; codecs=avc1");
    assert.equal(events[2].mimeType, "VIDEO/JPEG2000; rate=30");
    assert.equal(events[3].mimeType, "AUDIO/PCM; rate=24000");
});

test("parseAll ignores empty or whitespace-only inline media data and trims padded base64", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        serverContent: {
            modelTurn: {
                parts: [
                    { inlineData: { mimeType: "audio/pcm;rate=24000", data: "" } },
                    { inlineData: { mimeType: "audio/pcm;rate=24000", data: "   \t\r\n" } },
                    { inline_data: { mime_type: "video/mp4", data: "   " } },
                    { video: { mimeType: "image/jpeg", data: "\u00a0" } },
                    { inlineData: { mimeType: "audio/pcm;rate=24000", data: "  AAA=\n" } },
                    { inline_data: { mime_type: "image/png", data: "\tBBB= " } },
                    { text: "  keep spaces  " },
                ],
            },
        },
    });
    assert.deepEqual(types(events), ["AUDIO", "VIDEO", "TEXT"]);
    assert.equal(events[0].data, "AAA=");
    assert.equal(events[0].mimeType, "audio/pcm;rate=24000");
    assert.equal(events[1].data, "BBB=");
    assert.equal(events[1].mimeType, "image/png");
    assert.equal(events[2].data, "  keep spaces  ");
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

test("parseAll drops function calls that aren't plain objects and keeps the rest", () => {
    const events = GeminiLiveResponseMessage.parseAll({
        toolCall: { functionCalls: [null, "f", 3, [], ["not-an-object"], { id: "c1", name: "f" }] },
    });
    assert.deepEqual(types(events), ["FUNCTION_CALL"]);
    assert.deepEqual(plain(events[0].data), [{ id: "c1", name: "f" }]);

    assert.deepEqual(
        types(GeminiLiveResponseMessage.parseAll({ toolCall: { functionCalls: [null, [], ["x"]] } })),
        []
    );
});

test("parseAll drops function calls without a non-empty string name", () => {
    const bad = [
        { id: "c0" },
        { id: "c1", name: "" },
        { id: "c2", name: "   " },
        { id: "c3", name: 42 },
        { id: "c4", name: { toString: null }, args: {} },
        { id: "c5", name: ["fn"] },
    ];
    const events = GeminiLiveResponseMessage.parseAll({
        toolCall: { functionCalls: [...bad, { id: "c6", name: "ok", args: { a: 1 } }] },
    });
    assert.deepEqual(types(events), ["FUNCTION_CALL"]);
    assert.deepEqual(plain(events[0].data), [{ id: "c6", name: "ok", args: { a: 1 } }]);

    assert.deepEqual(types(GeminiLiveResponseMessage.parseAll({ toolCall: { functionCalls: bad } })), []);
    assert.deepEqual(types(GeminiLiveResponseMessage.parseAll({ tool_call: { function_calls: bad } })), []);
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

test("empty functionCallDefinition omits function_declarations and skips fc_definition POST", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.setFunctionCall([]);
    assert.equal(api._buildToolsConfig(), null);

    api.googleSearchEnabled = true;
    assert.deepEqual(plain(api._buildToolsConfig()), [{ googleSearch: {} }]);

    let posted = 0;
    api.sendPostRequest = async () => {
        posted++;
        return {};
    };
    await api.setupFuncDeclarationToService("s1");
    assert.equal(posted, 0);
});

test("malformed entries in functionCallDefinition are filtered from tools config and fc_definition POST", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const namedArray = Object.assign([], { name: "arr" });
    const nullProto = Object.assign(Object.create(null), { name: "null_proto" });
    const namedFn = function named() {};
    const valid = { name: "ok", description: "runs ok" };
    const invalidEntries = [
        null,
        undefined,
        123,
        "str",
        true,
        [],
        namedArray,
        namedFn,
        {},
        { name: "" },
        { name: "   " },
        { name: 123 },
        { name: null },
        { name: { toString: () => "coerced" } },
    ];

    api.setFunctionCall([valid, ...invalidEntries, nullProto]);
    api.toolBehavior = "BLOCKING";
    assert.deepEqual(plain(api._buildToolsConfig()), [
        { function_declarations: [{ name: "ok", description: "runs ok" }, { name: "null_proto" }] },
    ]);

    api.toolBehavior = "NON_BLOCKING";
    assert.deepEqual(plain(api._buildToolsConfig()), [
        {
            function_declarations: [
                { name: "ok", description: "runs ok", behavior: "NON_BLOCKING" },
                { name: "null_proto", behavior: "NON_BLOCKING" },
            ],
        },
    ]);

    const posted = [];
    api.sendPostRequest = async (_url, body) => {
        posted.push(body);
        return {};
    };
    await api.setupFuncDeclarationToService("s1");
    assert.deepEqual(plain(posted), [
        {
            objective: "fc_definition",
            session_id: "s1",
            functionDefinition: [{ name: "ok", description: "runs ok" }, { name: "null_proto" }],
        },
    ]);

    // A single valid declaration object is normalized into a one-element list.
    posted.length = 0;
    api.setFunctionCall({ name: "solo" });
    api.toolBehavior = "BLOCKING";
    assert.deepEqual(plain(api._buildToolsConfig()), [{ function_declarations: [{ name: "solo" }] }]);
    await api.setupFuncDeclarationToService("s1");
    assert.deepEqual(plain(posted), [
        { objective: "fc_definition", session_id: "s1", functionDefinition: [{ name: "solo" }] },
    ]);

    // When no valid declarations remain, omit tools (or keep only googleSearch) and skip POST.
    posted.length = 0;
    for (const bad of [invalidEntries, 123, "foo", true, {}, { name: "   " }, namedArray, namedFn]) {
        api.setFunctionCall(bad);
        api.googleSearchEnabled = false;
        api.toolBehavior = "BLOCKING";
        assert.equal(api._buildToolsConfig(), null);
        api.toolBehavior = "NON_BLOCKING";
        assert.equal(api._buildToolsConfig(), null);

        api.googleSearchEnabled = true;
        assert.deepEqual(plain(api._buildToolsConfig()), [{ googleSearch: {} }]);

        await api.setupFuncDeclarationToService("s1");
    }
    assert.equal(posted.length, 0);
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

test("disconnect() inside onTransportFallback stops setupComplete and trailing events", () => {
    const api = connectedApi();
    api.webSocket.close = () => {};
    api.transportMode = "webrtc";
    api.webRtcManager = { close: () => {} };
    const seen = [];
    let started = 0;
    api.onTransportFallback = () => {
        seen.push("fallback");
        api.disconnect();
    };
    api.onReceiveResponse = (message) => seen.push(message.type);
    api.onConnectionStarted = () => started++;

    api.webSocket.onmessage({
        data: JSON.stringify({
            setupComplete: {},
            sessionResumptionUpdate: { newHandle: "h1" },
            usageMetadata: { totalTokenCount: 10 },
        }),
    });

    assert.deepEqual(plain(seen), ["fallback"]);
    assert.equal(started, 0);
    assert.equal(api.latestResumptionHandle, "");
    assert.equal(api.isSetupComplete, false);
});

test("disconnect() inside onReceiveResponse stops onConnectionStarted and trailing events", () => {
    const api = connectedApi();
    api.webSocket.close = () => {};
    const seen = [];
    let started = 0;
    api.onReceiveResponse = (message) => {
        seen.push(message.type);
        if (message.type === "SETUP COMPLETE") api.disconnect();
    };
    api.onConnectionStarted = () => started++;

    api.webSocket.onmessage({
        data: JSON.stringify({
            setupComplete: {},
            serverContent: { modelTurn: { parts: [{ text: "hi" }] } },
            sessionResumptionUpdate: { newHandle: "h1" },
        }),
    });

    assert.deepEqual(plain(seen), ["SETUP COMPLETE"]);
    assert.equal(started, 0);
    assert.equal(api.latestResumptionHandle, "");
});

test("resume() inside GO_AWAY stops trailing events in the same frame", async () => {
    const api = connectedApi();
    const oldSocket = api.webSocket;
    oldSocket.close = () => oldSocket.onclose?.();
    api.setResumption(true, "");
    const seen = [];
    let resumePromise;
    // Keep prepare() pending so resume() stays mid-flight while the frame unwinds.
    const pendingPost = Promise.withResolvers();
    api.sendPostRequest = () => pendingPost.promise;
    api.onReceiveResponse = (message) => {
        seen.push(message.type);
        if (message.type === "GO_AWAY") {
            resumePromise = api.resume(api.latestResumptionHandle);
        }
    };
    api.onConnectionStarted = () => {};

    oldSocket.onmessage({
        data: JSON.stringify({
            setupComplete: {},
            sessionResumptionUpdate: { newHandle: "h1" },
            goAway: { timeLeft: "5s" },
            usageMetadata: { totalTokenCount: 99 },
        }),
    });

    assert.deepEqual(plain(seen), ["SETUP COMPLETE", "RESUMPTION", "GO_AWAY"]);
    api.disconnect();
    pendingPost.resolve({});
    await resumePromise;
});

test("disconnect() inside onConnectionStarted stops trailing events in the same frame", () => {
    const api = connectedApi();
    api.webSocket.close = () => {};
    const seen = [];
    api.onReceiveResponse = (message) => seen.push(message.type);
    api.onConnectionStarted = () => {
        seen.push("started");
        api.disconnect();
    };

    api.webSocket.onmessage({
        data: JSON.stringify({
            setupComplete: {},
            serverContent: { modelTurn: { parts: [{ text: "hi" }] } },
            sessionResumptionUpdate: { newHandle: "h1" },
        }),
    });

    assert.deepEqual(plain(seen), ["SETUP COMPLETE", "started"]);
    assert.equal(api.latestResumptionHandle, "");
});

test("a late completeSession() rejection after disconnect() does not report an error", async () => {
    const api = connectedApi();
    api.webSocket.close = () => {};
    api.transportMode = "webrtc";
    let rejectComplete;
    api.webRtcManager = {
        close: () => {},
        completeSession: () =>
            new Promise((_, reject) => {
                rejectComplete = reject;
            }),
    };
    api.onConnectionStarted = () => {};

    api.webSocket.onmessage({
        data: JSON.stringify({ setupComplete: { rtcSetupComplete: { answerSdp: "v=0" } } }),
    });
    api.disconnect();
    rejectComplete(new Error("late SDP failure"));
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(plain(api.errors), []);
});

test("onmessage on a superseded WebSocket is ignored", () => {
    const api = connectedApi();
    const oldSocket = api.webSocket;
    const seen = [];
    api.onReceiveResponse = (message) => seen.push(message.type);
    api.onConnectionStarted = () => {};

    // Replace the socket without going through disconnect() (e.g. a second connect).
    api.setupWebSocketToService();
    const bytesBefore = api.bytesIn;
    oldSocket.onmessage({
        data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: "stale" }] } } }),
    });

    assert.deepEqual(plain(seen), []);
    assert.equal(api.bytesIn, bytesBefore);
});

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
    assert.equal(api.setupTimer, null);
});

test("disconnect(), resume(), and webSocket.onclose clear the pending setup timeout", async () => {
    const onDisconnect = connectedApi();
    const disconnectTimer = timers[timers.length - 1];
    onDisconnect.webSocket.close = () => {};
    onDisconnect.disconnect();
    assert.equal(disconnectTimer.cleared, true);
    assert.equal(onDisconnect.setupTimer, null);

    const onClose = connectedApi();
    const closeTimer = timers[timers.length - 1];
    onClose.webSocket.onclose({ code: 1011, reason: "boom" });
    assert.equal(closeTimer.cleared, true);
    assert.equal(onClose.setupTimer, null);

    const onResume = connectedApi();
    const resumeTimer = timers[timers.length - 1];
    onResume.webSocket.readyState = FakeWebSocket.CLOSED;
    onResume.sendPostRequest = () => new Promise(() => {}); // Hang in prepare() so no new timer is armed.
    onResume.resume("h");
    assert.equal(resumeTimer.cleared, true);
    assert.equal(onResume.setupTimer, null);
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
        const { status = 200, statusText = "", type = null, text = "" } = answer;
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText,
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

test("disconnect() during a connect retry's backoff stops the retries and clears the timer", async () => {
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
        assert.ok(timers.some((t) => !t.cleared && !t.fired), first);
        api.disconnect();
        // The backoff timer is cleared immediately instead of waiting 1-3 s.
        assert.ok(timers.every((t) => t.cleared || t.fired), first);
        await connecting;
        assert.equal(opened, 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(plain(posts.map((b) => b.command)), expected, first);
        await new Promise((resolve) => setImmediate(resolve)); // The release's reply.
        assert.ok(timers.every((t) => t.cleared || t.fired), first);
    }
});

test("disconnect() during a hung prepare() POST aborts it and releases the session immediately", async () => {
    for (const [hung, expected] of [
        ["connect", ["connect", "disconnect"]],
        ["fc_definition", ["connect", "fc_definition", "disconnect"]],
    ]) {
        const { api, posts, timers } = apiWithFetch((body) =>
            (body.command ?? body.objective) === hung ? "hang" : { type: "application/json", text: '{"project_id":"p"}' }
        );
        api.functionCallDefinition = [{ name: "f" }];
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        let opened = 0;
        api.setupWebSocketToService = () => opened++;
        const connecting = api.connect();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(posts.length, expected.length - 1, hung);
        api.disconnect();
        // Resolves without waiting for the 15 s request timeout.
        await connecting;
        assert.equal(opened, 0, hung);
        assert.deepEqual(errors, [], hung);
        assert.deepEqual(plain(posts.map((b) => b.command ?? b.objective)), expected, hung);
        assert.equal(posts.at(-1).session_id, posts[0].session_id, hung);
        await new Promise((resolve) => setImmediate(resolve)); // The release's reply.
        assert.ok(timers.every((t) => t.cleared), hung);
    }
});

test("disconnect() during a resume's hung prepare() aborts it, releases the new session, and resolves cleanly", async () => {
    let connects = 0;
    const { api, posts, timers } = apiWithFetch((body) => {
        if (body.command === "connect") {
            return ++connects === 1 ? { type: "application/json", text: '{"project_id":"p1"}' } : "hang";
        }
        return { type: "application/json", text: "{}" };
    });
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    api.setupWebSocketToService = () => {
        api.webSocket = new FakeWebSocket();
        api.webSocket.close = () => api.webSocket.onclose?.();
    };
    await api.connect();
    const firstId = api.sessionId;
    const oldWs = api.webSocket;
    oldWs.close = () => oldWs.onclose?.();

    const resuming = api.resume("h1");
    await new Promise((resolve) => setImmediate(resolve));
    const resumedId = api.sessionId;
    assert.notEqual(resumedId, firstId);
    api.disconnect();
    await resuming;
    assert.deepEqual(errors, []);
    assert.deepEqual(plain(posts.map((b) => b.command)), ["connect", "connect", "disconnect"]);
    assert.equal(posts[2].session_id, resumedId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timers.every((t) => t.cleared));
});

test("a new connect() aborts an earlier hung prepare() without cancelling itself", async () => {
    let connects = 0;
    const { api, posts, timers } = apiWithFetch((body) => {
        if (body.command === "connect") {
            return ++connects === 1 ? "hang" : { type: "application/json", text: '{"project_id":"p2"}' };
        }
        return { type: "application/json", text: "{}" };
    });
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    let opened = 0;
    api.setupWebSocketToService = () => opened++;

    const first = api.connect();
    const firstId = api.sessionId;
    await new Promise((resolve) => setImmediate(resolve));
    const second = api.connect();
    const secondId = api.sessionId;
    await Promise.all([first, second]);

    assert.deepEqual(errors, []);
    assert.equal(opened, 1);
    assert.equal(api.projectId, "p2");
    assert.notEqual(firstId, secondId);
    const disconnect = posts.find((b) => b.command === "disconnect");
    assert.ok(disconnect);
    assert.equal(disconnect.session_id, firstId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timers.every((t) => t.cleared));
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

test("sendPostRequest() propagates abort during response.json() instead of reporting non-JSON", async () => {
    const timers = [];
    const fetch = async (url, init) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        json: () =>
            new Promise((_, reject) => {
                const abort = () => reject(init.signal.reason);
                if (init.signal?.aborted) abort();
                init.signal?.addEventListener("abort", abort);
            }),
    });
    const context = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: FakeWebSocket,
        fetch,
        document: { getElementById: () => null },
        setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false, fired: false }),
        clearTimeout: (id) => {
            if (timers[id - 1]) timers[id - 1].cleared = true;
        },
    });
    const api = new context.GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");

    const controller = new AbortController();
    const aborted = api.sendPostRequest("/api/control", {}, { signal: controller.signal, timeoutMs: 15000 });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort("cancelled");
    await assert.rejects(aborted, (reason) => reason === "cancelled");

    const timedOut = api.sendPostRequest("/api/control", {}, { timeoutMs: 15000 });
    await fireNextTimer(timers);
    await assert.rejects(timedOut, { timeout: true, message: "the server didn't answer within 15 s" });
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

test("fetchJson() normalizes nested, non-string, and blank HTTP error fields", async () => {
    const cases = {
        nestedMessage: {
            reply: {
                status: 500,
                statusText: "Internal Server Error",
                type: "application/json",
                text: '{"error": {"message": "  Backend failed  ", "status": "INTERNAL"}}',
            },
            message: "HTTP 500: Backend failed",
        },
        nestedStatus: {
            reply: {
                status: 429,
                statusText: "Too Many Requests",
                type: "application/json",
                text: '{"error": {"message": "   ", "status": " RESOURCE_EXHAUSTED "}}',
            },
            message: "HTTP 429: RESOURCE_EXHAUSTED",
        },
        nestedNonString: {
            reply: {
                status: 500,
                statusText: "Internal Server Error",
                type: "application/json",
                text: '{"error": {"code": 500, "message": null, "status": 42}}',
            },
            message: "HTTP 500: Internal Server Error",
        },
        trimmedError: {
            reply: {
                status: 400,
                statusText: "Bad Request",
                type: "application/json",
                text: '{"error": "  bad field  "}',
            },
            message: "HTTP 400: bad field",
        },
        whitespaceError: {
            reply: {
                status: 502,
                statusText: "  Bad Gateway  ",
                type: "application/json",
                text: '{"error": "   "}',
            },
            message: "HTTP 502: Bad Gateway",
        },
        whitespaceBoth: {
            reply: {
                status: 502,
                statusText: "   ",
                type: "application/json",
                text: '{"error": "   "}',
            },
            message: "HTTP 502",
        },
        numericError: {
            reply: {
                status: 500,
                statusText: "Internal Server Error",
                type: "application/json",
                text: '{"error": 123}',
            },
            message: "HTTP 500: Internal Server Error",
        },
        arrayError: {
            reply: {
                status: 500,
                statusText: "Internal Server Error",
                type: "application/json",
                text: '{"error": ["a", "b"]}',
            },
            message: "HTTP 500: Internal Server Error",
        },
        nonObjectBody: {
            reply: {
                status: 502,
                statusText: "Bad Gateway",
                type: "application/json",
                text: '["raw"]',
            },
            message: "HTTP 502: Bad Gateway",
        },
        nonJsonBlankStatus: {
            reply: {
                status: 504,
                statusText: "  ",
                type: "text/plain",
                text: "not json",
            },
            message: "HTTP 504",
        },
    };
    const { api } = apiWithFetch((body) => cases[body.kind].reply);
    for (const [kind, expected] of Object.entries(cases)) {
        await assert.rejects(api.sendPostRequest("/api/control", { kind }), {
            message: expected.message,
            status: expected.reply.status,
        });
    }
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

test("a throwing onReconnectNeeded in 1001 onclose is reported and releases WebRTC media", () => {
    const api = connectedApi();
    api.transportMode = "webrtc";
    const closeOpts = [];
    api.webRtcManager = {
        close: (opts) => closeOpts.push(opts),
        completeSession: async () => {},
    };
    api.setResumption(true, "");
    api.onReceiveMessage({
        data: JSON.stringify({ setupComplete: { rtcSetupComplete: { answerSdp: "v=0" } } }),
    });
    api.onReceiveMessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h" } }) });
    api.onReconnectNeeded = () => {
        throw new Error("resume setup broke");
    };
    assert.doesNotThrow(() => api.webSocket.onclose({ code: 1001, reason: "" }));
    assert.deepEqual(plain(api.errors), ["Could not resume the session: resume setup broke"]);
    assert.deepEqual(plain(closeOpts), [
        { keepLocalMedia: true, markClosed: true },
        { markClosed: true },
    ]);
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
    const decl2 = { name: "g", description: "d2", parameters: { type: "object" } };
    const cases = [
        [[decl], [decl]],
        [decl, [decl]],
        [{ type: "function", function: decl }, [decl]],
        [[{ type: "function", function: decl }], [decl]],
        [{ tools: [{ type: "function", function: decl }] }, [decl]],
        [{ functionDeclarations: [decl, decl2] }, [decl, decl2]],
        [{ function_declarations: [decl, decl2] }, [decl, decl2]],
        [[{ functionDeclarations: [decl] }, { function_declarations: [decl2] }], [decl, decl2]],
        [{ tools: [{ functionDeclarations: [decl] }, { function_declarations: [decl2] }] }, [decl, decl2]],
        [{ tools: [{ functionDeclarations: [decl] }, decl2] }, [decl, decl2]],
        [{ functionDeclarations: [decl], function_declarations: [decl2] }, [decl, decl2]],
        [{ functionDeclarations: [{ type: "function", function: decl }] }, [decl]],
        [{ functionDeclarations: [] }, []],
        [{ function_declarations: [] }, []],
        [{ tools: [{ functionDeclarations: [] }] }, []],
        [{ functionDeclarations: "not-an-array" }, [{ functionDeclarations: "not-an-array" }]],
        [{ function_declarations: null }, [{ function_declarations: null }]],
        [null, [null]],
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

    api.setVad(false, false, undefined, undefined);
    assert.equal(api._buildRealtimeInputConfig(), null);

    api.startSensitivity = undefined;
    api.endSensitivity = null;
    assert.equal(api._buildRealtimeInputConfig(), null);
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

test("setLocation and setup/control requests normalize whitespace, case, and non-string locations", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.transportMode = "websocket";
    api.projectId = "p";
    api.setApiHost("prod");
    api.setModel("gemini-live-2.5-flash-native-audio");
    api.responseModalities = ["AUDIO"];
    const posted = [];
    api.postWithRetry = async (_url, body) => {
        posted.push(plain(body));
        return { project_id: "p", idle_timeout_s: 0 };
    };

    api.setLocation("  US-CENTRAL1  ");
    assert.equal(api.location, "us-central1");
    await api.initBackendService("s1");
    await api.sendInitialSetupMessages();
    assert.equal(posted[0].location, "us-central1");
    assert.equal(
        api.webSocket.sent[0].setup.model,
        "projects/p/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio"
    );

    api.setLocation("\tEU\n");
    assert.equal(api.location, "eu");

    for (const bad of [null, undefined, 123, {}, ["us-central1"]]) {
        api.setLocation(bad);
        assert.equal(api.location, "");
    }

    // Direct property mutation is also normalized when building control and setup messages.
    api.location = "  US-EAST1\t";
    await api.initBackendService("s2");
    await api.sendInitialSetupMessages();
    assert.equal(posted[1].location, "us-east1");
    assert.equal(
        api.webSocket.sent[1].setup.model,
        "projects/p/locations/us-east1/publishers/google/models/gemini-live-2.5-flash-native-audio"
    );

    api.location = null;
    await api.initBackendService("s3");
    await api.sendInitialSetupMessages();
    assert.equal(posted[2].location, "");
    assert.equal(
        api.webSocket.sent[2].setup.model,
        "projects/p/locations//publishers/google/models/gemini-live-2.5-flash-native-audio"
    );
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
    assert.deepEqual(await sentBitrates("   ", "\t\n"), [undefined, undefined]);
    assert.deepEqual(await sentBitrates("2147483647", 2147483647.4), [2147483647, 2147483647]);
    assert.deepEqual(await sentBitrates("2147483648", 2147483647.5), [undefined, undefined]);
    assert.deepEqual(await sentBitrates("1e30", 1e30), [undefined, undefined]);
});

test("setBitrates and avatar config reject non-numeric coercion and int32 overflow", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.transportMode = "websocket";
    api.responseModalities = ["AUDIO", "VIDEO"];

    for (const bad of [
        true,
        false,
        null,
        undefined,
        [64000],
        { valueOf: () => 64000 },
        Symbol("bps"),
        Object.create(null),
        64000n,
        "1e30",
        2147483648,
        "2147483648",
    ]) {
        api.setBitrates(bad, bad);
        assert.equal(api.audioBitrate, 0);
        assert.equal(api.videoBitrate, 0);
    }

    // Even direct property mutation outside int32 range or non-numeric is omitted.
    api.audioBitrate = 1e30;
    api.videoBitrate = true;
    await api.sendInitialSetupMessages();
    const { audio_bitrate_bps, video_bitrate_bps } = api.webSocket.sent[0].setup.avatar_config;
    assert.equal(audio_bitrate_bps, undefined);
    assert.equal(video_bitrate_bps, undefined);
});

// A connected session whose server set --idle_timeout_s=idleS.
async function idleApi(idleS = 120) {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.setTransportMode("websocket");
    api.idleMessages = [];
    api.onIdleTimeout = (message) => api.idleMessages.push(message);
    api.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: idleS });
    api.setupWebSocketToService = () => {
        api.webSocket = new FakeWebSocket();
    };
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
        "voice activity start": { voiceActivity: { type: "ACTIVITY_START", audioOffset: "0.200s" } },
        "voice activity end": { voice_activity: { type: "ACTIVITY_END", audio_offset: "1.000s" } },
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

test("unknown voiceActivity types don't postpone the idle timeout", async () => {
    const api = await idleApi(60);
    const received = [];
    api.onReceiveResponse = (message) => received.push([message.type, message.data]);
    const longAgo = performance.now() - 60000;
    api.lastActivityAt = longAgo;
    for (const raw of [
        { voiceActivity: { type: "ACTIVITY_TYPE_UNSPECIFIED" } },
        { voice_activity: { type: "FUTURE_SIGNAL" } },
    ]) {
        api.onReceiveMessage({ data: JSON.stringify(raw) });
    }
    assert.deepEqual(received, [
        ["VOICE_ACTIVITY", "ACTIVITY_TYPE_UNSPECIFIED"],
        ["VOICE_ACTIVITY", "FUTURE_SIGNAL"],
    ]);
    assert.equal(api.lastActivityAt, longAgo);
    timers[api.idleTimer - 1].fn();
    assert.equal(api.idleMessages.length, 1);
});

test("empty transcription frames don't postpone the idle timeout", async () => {
    const api = await idleApi(60);
    const received = [];
    api.onReceiveResponse = (message) =>
        received.push([message.type, message.data, Boolean(message.finished)]);
    const longAgo = performance.now() - 60000;
    api.lastActivityAt = longAgo;
    for (const raw of [
        { serverContent: { inputTranscription: { text: "" } } },
        { serverContent: { inputTranscription: { text: "", finished: true } } },
        { server_content: { input_transcription: { finished: true } } },
        { serverContent: { inputTranscription: { text: null } } },
        { serverContent: { outputTranscription: { text: "" } } },
        { serverContent: { outputTranscription: { text: "", finished: true } } },
        { server_content: { output_transcription: { finished: true } } },
        { serverContent: { outputTranscription: {} } },
    ]) {
        api.onReceiveMessage({ data: JSON.stringify(raw) });
    }
    assert.deepEqual(received, [
        ["INPUT_TRANSCRIPTION", "", false],
        ["INPUT_TRANSCRIPTION", "", true],
        ["INPUT_TRANSCRIPTION", "", true],
        ["INPUT_TRANSCRIPTION", "", false],
        ["OUTPUT_TRANSCRIPTION", "", false],
        ["OUTPUT_TRANSCRIPTION", "", true],
        ["OUTPUT_TRANSCRIPTION", "", true],
        ["OUTPUT_TRANSCRIPTION", "", false],
    ]);
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

test("webSocket.onclose clears the idle timer when ending the session, but keeps it for a 1001 resume", async () => {
    // Non-resumable close: idle timer is cleared even if onErrorMessage does not call disconnect().
    const ended = await idleApi(120);
    ended.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    ended.setupWebSocketToService();
    const endedTimer = timers[ended.idleTimer - 1];
    ended.onErrorMessage = (message) => ended.errors.push(message);
    ended.errors = [];
    ended.webSocket.onclose({ code: 1011, reason: "boom" });
    assert.equal(endedTimer.cleared, true);
    assert.equal(ended.idleTimer, null);

    // Resumable 1001 close: idle timer stays armed while onReconnectNeeded resumes;
    // if onReconnectNeeded throws, it is cleared.
    const resuming = await idleApi(120);
    resuming.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    resuming.setupWebSocketToService();
    resuming.setResumption(true, "");
    resuming.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    resuming.onReceiveMessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h" } }) });
    const resumingTimer = timers[resuming.idleTimer - 1];
    let reconnected = 0;
    resuming.onReconnectNeeded = () => reconnected++;
    resuming.webSocket.onclose({ code: 1001, reason: "" });
    assert.equal(reconnected, 1);
    assert.equal(resumingTimer.cleared, false);
    assert.ok(resuming.idleTimer !== null);

    const brokenResume = await idleApi(120);
    brokenResume.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    brokenResume.setupWebSocketToService();
    brokenResume.setResumption(true, "");
    brokenResume.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    brokenResume.onReceiveMessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h" } }) });
    const brokenTimer = timers[brokenResume.idleTimer - 1];
    brokenResume.onErrorMessage = () => {};
    brokenResume.onReconnectNeeded = () => {
        throw new Error("resume setup broke");
    };
    brokenResume.webSocket.onclose({ code: 1001, reason: "" });
    assert.equal(brokenTimer.cleared, true);
    assert.equal(brokenResume.idleTimer, null);
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

test("a sync throw in setupWebSocketToService() during connect() releases the session and reports an error", async () => {
    // 1. Relative proxyUrl throws TypeError in new URL().
    const api = new GeminiLiveAPI("/ws", "/api/control", "/api/post_endpoint");
    const bodies = [];
    const errors = [];
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return Promise.resolve({ project_id: "p", idle_timeout_s: 120 });
    };
    api.onErrorMessage = (message) => {
        errors.push(message);
        api.disconnect();
    };
    await api.connect();
    assert.deepEqual(
        plain(bodies.map((b) => [b.command, b.session_id])),
        [
            ["connect", bodies[0].session_id],
            ["disconnect", bodies[0].session_id],
        ]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Could not open the WebSocket connection:/);
    assert.equal(api.webSocket, null);
    assert.equal(api.idleTimer, null);

    // 2. new WebSocket() throwing SecurityError after prepare().
    function ThrowingWebSocket() {
        throw new DOMException("Insecure WebSocket blocked", "SecurityError");
    }
    ThrowingWebSocket.CONNECTING = 0;
    ThrowingWebSocket.OPEN = 1;
    ThrowingWebSocket.CLOSING = 2;
    ThrowingWebSocket.CLOSED = 3;
    const { GeminiLiveAPI: SecureAPI } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: ThrowingWebSocket,
        setTimeout: () => 1,
        clearTimeout: () => {},
        document: { getElementById: () => null },
    });
    const secApi = new SecureAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const secBodies = [];
    const secErrors = [];
    secApi.sendPostRequest = (url, body) => {
        secBodies.push(body);
        return Promise.resolve({ project_id: "p", idle_timeout_s: 120 });
    };
    secApi.onErrorMessage = (message) => {
        secErrors.push(message);
        secApi.disconnect();
    };
    await secApi.connect();
    assert.deepEqual(
        plain(secBodies.map((b) => [b.command, b.session_id])),
        [
            ["connect", secBodies[0].session_id],
            ["disconnect", secBodies[0].session_id],
        ]
    );
    assert.deepEqual(secErrors, ["Could not open the WebSocket connection: Insecure WebSocket blocked"]);
    assert.equal(secApi.webSocket, null);
    assert.equal(secApi.idleTimer, null);
});

test("a sync throw in setupWebSocketToService() during resume() releases the session, clears timers/WebRTC, and reports an error", async () => {
    const api = await idleApi(120);
    const oldTimer = timers[api.idleTimer - 1];
    api.webSocket.close = () => {};
    api.webSocket.readyState = FakeWebSocket.CLOSED;
    api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    api.proxyUrl = "/ws"; // Throws TypeError in new URL() after prepare().
    api.transportMode = "webrtc";
    const rtcCloses = [];
    api.webRtcManager = { close: (opts) => rtcCloses.push(opts) };
    const bodies = [];
    const errors = [];
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return Promise.resolve({ project_id: "p", idle_timeout_s: 120 });
    };
    api.onErrorMessage = (message) => errors.push(message);

    await assert.rejects(() => api.resume("h"), /Invalid URL/i);
    assert.deepEqual(
        plain(bodies.map((b) => [b.command, b.session_id])),
        [
            ["connect", bodies[0].session_id],
            ["disconnect", bodies[0].session_id],
        ]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Could not open the WebSocket connection:/);
    assert.equal(oldTimer.cleared, true);
    assert.equal(api.idleTimer, null);
    assert.equal(api.webSocket, null);
    assert.deepEqual(plain(rtcCloses), [
        { keepLocalMedia: true, markClosed: true },
        { markClosed: true },
    ]);
});

test("a throw after WebSocket construction in setupWebSocketToService() closes the partial socket without double-abandoning", async () => {
    const localTimers = [];
    const createdSockets = [];
    class HalfBrokenWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = HalfBrokenWebSocket.CONNECTING;
            this.closedWith = null;
            // Omit `send` so webSocket.send.bind(webSocket) throws after this.webSocket and setupTimer are set.
            createdSockets.push(this);
        }
        close(code) {
            this.closedWith = code;
        }
    }
    HalfBrokenWebSocket.CONNECTING = 0;
    HalfBrokenWebSocket.OPEN = 1;
    HalfBrokenWebSocket.CLOSING = 2;
    HalfBrokenWebSocket.CLOSED = 3;

    const { GeminiLiveAPI: BrokenAPI } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: HalfBrokenWebSocket,
        setTimeout: (fn, ms) => {
            const entry = { fn, ms, cleared: false };
            localTimers.push(entry);
            return localTimers.length;
        },
        clearTimeout: (id) => {
            if (localTimers[id - 1]) localTimers[id - 1].cleared = true;
        },
        document: { getElementById: () => null },
    });
    const api = new BrokenAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const bodies = [];
    const errors = [];
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return Promise.resolve({ project_id: "p", idle_timeout_s: 0 });
    };
    api.onErrorMessage = (message) => {
        errors.push(message);
        api.disconnect();
    };

    await api.connect();
    assert.equal(createdSockets.length, 1);
    assert.equal(createdSockets[0].closedWith, 1000);
    assert.equal(createdSockets[0].onclose, null);
    assert.equal(api.webSocket, null);
    assert.equal(api.setupTimer, null);
    assert.equal(localTimers[0].cleared, true);
    assert.deepEqual(
        plain(bodies.map((b) => [b.command, b.session_id])),
        [
            ["connect", bodies[0].session_id],
            ["disconnect", bodies[0].session_id],
        ]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Could not open the WebSocket connection:/);
});

test("disconnect() while a resume waits on a stalled old WebSocket releases the new session immediately", async () => {
    const api = connectedApi();
    const oldWebSocket = api.webSocket;
    oldWebSocket.close = () => {}; // Never emits onclose (e.g. half-open TCP).
    const bodies = [];
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        return Promise.resolve({ project_id: "p" });
    };
    let opened = 0;
    api.setupWebSocketToService = () => opened++;

    const resuming = api.resume("h");
    await new Promise((resolve) => setImmediate(resolve)); // prepare() finishes while oldWebSocket is still closing.
    api.disconnect();
    await resuming; // Resolves without waiting for oldWebSocket.onclose.

    assert.equal(opened, 0);
    assert.deepEqual(plain(bodies.map((b) => b.command)), ["connect", "disconnect"]);
    assert.equal(bodies[1].session_id, bodies[0].session_id);
});

test("resume() finishes cleanly if oldWebSocket.close() throws synchronously", async () => {
    const api = connectedApi();
    const oldWebSocket = api.webSocket;
    oldWebSocket.close = () => {
        throw new Error("close failed");
    };
    const bodies = [];
    let resolveConnect;
    api.sendPostRequest = (url, body) => {
        bodies.push(body);
        if (body.command === "connect") {
            return new Promise((resolve) => (resolveConnect = resolve));
        }
        return Promise.resolve({});
    };
    let opened = 0;
    api.setupWebSocketToService = () => opened++;

    const resuming = api.resume("h");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].command, "connect");
    resolveConnect({ project_id: "p", idle_timeout_s: 0 });
    await resuming;

    assert.equal(opened, 1);
    assert.equal(bodies.length, 1);
});

test("prepare() failure during resume() clears idleTimer even if onErrorMessage does not call disconnect()", async () => {
    const api = await idleApi(120);
    const oldTimer = timers[api.idleTimer - 1];
    api.webSocket.close = () => {};
    api.webSocket.readyState = FakeWebSocket.CLOSED;
    api.sendPostRequest = () => Promise.reject(Object.assign(new Error("HTTP 400: bad"), { status: 400 }));
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message); // Standalone caller: no disconnect().

    await assert.rejects(() => api.resume("h"), /Could not start the session/);
    assert.equal(errors.length, 1);
    assert.equal(oldTimer.cleared, true);
    assert.equal(api.idleTimer, null);
});

test("setupTimer timeout, onopen setup failure, and setup-callback errors tear down resources without caller disconnect()", async () => {
    // 1. setupTimer timeout
    const onTimeout = await idleApi(120);
    onTimeout.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    onTimeout.setupWebSocketToService();
    const timeoutIdle = timers[onTimeout.idleTimer - 1];
    const timeoutSetup = timers[onTimeout.setupTimer - 1];
    let closedCount = 0;
    onTimeout.webSocket.close = () => closedCount++;
    onTimeout.errors = [];
    onTimeout.onErrorMessage = (message) => onTimeout.errors.push(message);
    timeoutSetup.fn();
    assert.equal(onTimeout.errors.length, 1);
    assert.equal(onTimeout.webSocket, null);
    assert.equal(closedCount, 1);
    assert.equal(timeoutIdle.cleared, true);
    assert.equal(onTimeout.idleTimer, null);
    assert.equal(onTimeout.intervalId, null);

    // 2. webSocket.onopen setup failure
    const onOpenFail = await idleApi(120);
    onOpenFail.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    onOpenFail.setupWebSocketToService();
    const openIdle = timers[onOpenFail.idleTimer - 1];
    const openSetup = timers[onOpenFail.setupTimer - 1];
    let openClosed = 0;
    onOpenFail.webSocket.close = () => openClosed++;
    onOpenFail.sendInitialSetupMessages = async () => {
        throw new Error("ICE failed");
    };
    onOpenFail.errors = [];
    onOpenFail.onErrorMessage = (message) => onOpenFail.errors.push(message);
    await onOpenFail.webSocket.onopen();
    assert.deepEqual(plain(onOpenFail.errors), ["Setup failed: ICE failed"]);
    assert.equal(onOpenFail.webSocket, null);
    assert.equal(openClosed, 1);
    assert.equal(openSetup.cleared, true);
    assert.equal(onOpenFail.setupTimer, null);
    assert.equal(openIdle.cleared, true);
    assert.equal(onOpenFail.idleTimer, null);

    // 3. completeSession rejection after setupComplete
    const onRtcFail = await idleApi(120);
    onRtcFail.transportMode = "webrtc";
    onRtcFail.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    onRtcFail.setupWebSocketToService();
    const rtcIdle = timers[onRtcFail.idleTimer - 1];
    let rtcWsClosed = 0;
    let rtcClosed = 0;
    onRtcFail.webSocket.close = () => rtcWsClosed++;
    onRtcFail.webRtcManager = {
        close: () => rtcClosed++,
        completeSession: () => Promise.reject(new Error("bad SDP")),
    };
    onRtcFail.onConnectionStarted = () => {};
    onRtcFail.errors = [];
    onRtcFail.onErrorMessage = (message) => onRtcFail.errors.push(message);
    onRtcFail.webSocket.onmessage({
        data: JSON.stringify({ setupComplete: { rtcSetupComplete: { answerSdp: "v=0" } } }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(plain(onRtcFail.errors), ["WebRTC answer negotiation failed: bad SDP"]);
    assert.equal(onRtcFail.webSocket, null);
    assert.equal(rtcWsClosed, 1);
    assert.equal(rtcClosed, 1);
    assert.equal(rtcIdle.cleared, true);
    assert.equal(onRtcFail.idleTimer, null);

    // 4. onConnectionStarted throw
    const onStartFail = await idleApi(120);
    onStartFail.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    onStartFail.setupWebSocketToService();
    const startIdle = timers[onStartFail.idleTimer - 1];
    let startWsClosed = 0;
    onStartFail.webSocket.close = () => startWsClosed++;
    onStartFail.onConnectionStarted = () => {
        throw new Error("UI crashed");
    };
    onStartFail.errors = [];
    onStartFail.onErrorMessage = (message) => onStartFail.errors.push(message);
    onStartFail.webSocket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.deepEqual(plain(onStartFail.errors), ["Could not start the session: UI crashed"]);
    assert.equal(onStartFail.webSocket, null);
    assert.equal(startWsClosed, 1);
    assert.equal(startIdle.cleared, true);
    assert.equal(onStartFail.idleTimer, null);

    // 5. onTransportFallback throw
    const onFallbackFail = await idleApi(120);
    onFallbackFail.transportMode = "webrtc";
    onFallbackFail.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    onFallbackFail.setupWebSocketToService();
    const fbIdle = timers[onFallbackFail.idleTimer - 1];
    let fbWsClosed = 0;
    let fbRtcClosed = 0;
    onFallbackFail.webSocket.close = () => fbWsClosed++;
    onFallbackFail.webRtcManager = { close: () => fbRtcClosed++ };
    onFallbackFail.onTransportFallback = () => {
        throw new Error("fallback crashed");
    };
    onFallbackFail.errors = [];
    onFallbackFail.onErrorMessage = (message) => onFallbackFail.errors.push(message);
    onFallbackFail.webSocket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.deepEqual(plain(onFallbackFail.errors), ["Could not switch media to the WebSocket: fallback crashed"]);
    assert.equal(onFallbackFail.webSocket, null);
    assert.equal(fbWsClosed, 1);
    assert.equal(fbRtcClosed, 1);
    assert.equal(fbIdle.cleared, true);
    assert.equal(onFallbackFail.idleTimer, null);
    assert.equal(onFallbackFail.intervalId, null);
});

test("idle timeout tears down session resources and cancels an in-flight resume() without caller disconnect()", async () => {
    // 1. Active session with open WebSocket, bandwidth interval, setupTimer, and WebRTC.
    const api = await idleApi(10);
    api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    api.setupWebSocketToService();
    const ws = api.webSocket;
    const setupTimer = timers[api.setupTimer - 1];
    let wsClosed = 0;
    let rtcClosed = 0;
    ws.close = () => wsClosed++;
    api.webRtcManager = { close: () => rtcClosed++ };
    assert.notEqual(api.intervalId, null);

    fireIdleTimer(api, 10000);
    assert.deepEqual(plain(api.idleMessages), ["Disconnected after 10 seconds without activity."]);
    assert.equal(api.webSocket, null);
    assert.equal(wsClosed, 1);
    assert.equal(setupTimer.cleared, true);
    assert.equal(api.setupTimer, null);
    assert.equal(api.intervalId, null);
    assert.equal(rtcClosed, 1);
    assert.equal(api.idleTimer, null);

    // 2. Idle timer fires mid-resume() while prepare() is pending.
    const resuming = await idleApi(10);
    resuming.webSocket.close = () => {};
    resuming.webSocket.readyState = FakeWebSocket.CLOSED;
    let resolveConnect;
    const abandoned = [];
    let opened = 0;
    resuming.setupWebSocketToService = () => opened++;
    resuming.sendPostRequest = (url, body) => {
        if (body.command === "disconnect") {
            abandoned.push(body.session_id);
            return Promise.resolve({});
        }
        return new Promise((resolve) => {
            resolveConnect = () => resolve({ project_id: "p", idle_timeout_s: 10 });
        });
    };
    const resumePromise = resuming.resume("h1");
    await new Promise((resolve) => setImmediate(resolve));
    const resumedId = resuming.sessionId;

    fireIdleTimer(resuming, 10000);
    resolveConnect();
    await resumePromise;

    assert.equal(resuming.idleMessages.length, 1);
    assert.equal(opened, 0);
    assert.equal(resuming.webSocket, null);
    assert.deepEqual(plain(abandoned), [resumedId]);
});

test("overlapping connect() tears down the previous session before starting a new one", async () => {
    const api = await idleApi(60);
    api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
    api.setupWebSocketToService();
    const ws1 = api.webSocket;
    const firstId = api.sessionId;
    const firstSetup = timers[api.setupTimer - 1];
    const firstIdle = timers[api.idleTimer - 1];
    let ws1Closed = 0;
    let rtcClosed = 0;
    ws1.readyState = FakeWebSocket.CONNECTING;
    ws1.close = () => ws1Closed++;
    api.webRtcManager = { close: () => rtcClosed++ };
    const abandoned = [];
    api.sendPostRequest = (url, body) => {
        if (body.command === "disconnect") abandoned.push(body.session_id);
        return Promise.resolve({ project_id: "p", idle_timeout_s: 60 });
    };

    await api.connect();
    assert.notEqual(api.webSocket, ws1);
    assert.equal(ws1Closed, 1);
    assert.equal(ws1.onmessage, null);
    assert.equal(ws1.onclose, null);
    assert.equal(firstSetup.cleared, true);
    assert.equal(firstIdle.cleared, true);
    assert.equal(rtcClosed, 1);
    assert.deepEqual(plain(abandoned), [firstId]);
    api.disconnect();
});

test("resume() while the old WebSocket is still CONNECTING abandons the old pending session", async () => {
    const api = await idleApi(60);
    const oldId = api.sessionId;
    const ws1 = api.webSocket;
    ws1.readyState = FakeWebSocket.CONNECTING;
    ws1.close = () => {
        ws1.readyState = FakeWebSocket.CLOSED;
        ws1.onclose?.();
    };
    const commands = [];
    api.sendPostRequest = (url, body) => {
        commands.push([body.command, body.session_id]);
        return Promise.resolve({ project_id: "p", idle_timeout_s: 60 });
    };

    await api.resume("h1");
    assert.deepEqual(
        plain(commands),
        [
            ["disconnect", oldId],
            ["connect", api.sessionId],
        ]
    );
    api.disconnect();
});

test("describeDuration formats sub-second positive durations as seconds, not 0 minutes", async () => {
    const api = await idleApi(0.4);
    fireIdleTimer(api, 1000);
    assert.deepEqual(plain(api.idleMessages), ["Disconnected after 0 seconds without activity."]);

    const oneSec = await idleApi(1);
    fireIdleTimer(oneSec, 1000);
    assert.deepEqual(plain(oneSec.idleMessages), ["Disconnected after 1 second without activity."]);

    const oneMin = await idleApi(60);
    fireIdleTimer(oneMin, 60000);
    assert.deepEqual(plain(oneMin.idleMessages), ["Disconnected after 1 minute without activity."]);
});

test("catch blocks in GeminiLiveAPI format null and non-Error throws without crashing", async () => {
    const nullProto = Object.create(null);

    // 1. prepare() catch when initBackendService rejects with null / string / null-proto / named blank error.
    for (const [thrown, expected] of [
        [null, "unknown error"],
        ["  plain failure  ", "plain failure"],
        [nullProto, "unknown error"],
        [{ name: "CustomError", message: "   " }, "CustomError"],
    ]) {
        const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        api.initBackendService = () => Promise.reject(thrown);
        await assert.rejects(() => api.prepare(api.connectAttempt), (err) => err === thrown);
        assert.deepEqual(plain(errors), [expected]);
    }

    // 2. openPreparedWebSocket() catch with null and null-prototype throws.
    for (const thrown of [null, nullProto]) {
        const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        const errors = [];
        const abandoned = [];
        api.onErrorMessage = (message) => errors.push(message);
        api.abandonSession = (id) => abandoned.push(id);
        api.setupWebSocketToService = () => {
            throw thrown;
        };
        assert.throws(() => api.openPreparedWebSocket("s-open"), (err) => err === thrown);
        assert.deepEqual(plain(errors), ["Could not open the WebSocket connection: unknown error"]);
        assert.deepEqual(plain(abandoned), ["s-open"]);
    }

    // 3. initBackendService() and setupFuncDeclarationToService() with null and string rejections.
    {
        const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        api.setFunctionCall([{ name: "f" }]);
        api.postWithRetry = () => Promise.reject(null);
        await assert.rejects(
            () => api.initBackendService("s-init"),
            (err) => err?.name === "Error" && err.message === "Could not start the session: unknown error" && err.cause === null
        );
        api.sendPostRequest = () => Promise.reject(null);
        await assert.rejects(
            () => api.setupFuncDeclarationToService("s-init"),
            (err) =>
                err?.name === "Error" &&
                err.message === "Could not set up function declarations: unknown error" &&
                err.cause === null
        );
        api.sendPostRequest = () => Promise.reject("quota exceeded");
        await assert.rejects(
            () => api.setupFuncDeclarationToService("s-init"),
            (err) =>
                err?.name === "Error" &&
                err.message === "Could not set up function declarations: quota exceeded" &&
                err.cause === "quota exceeded"
        );
    }

    // 4. onTransportFallback() throws null during setupComplete fallback.
    {
        const api = await idleApi(120);
        api.transportMode = "webrtc";
        api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
        api.setupWebSocketToService();
        api.webRtcManager = { close: () => {} };
        api.onTransportFallback = () => {
            throw null;
        };
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        api.webSocket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
        assert.deepEqual(plain(errors), ["Could not switch media to the WebSocket: unknown error"]);
        assert.equal(api.webSocket, null);
    }

    // 5. completeSession() rejects with null after setupComplete.
    {
        const api = await idleApi(120);
        api.transportMode = "webrtc";
        api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
        api.setupWebSocketToService();
        api.webRtcManager = {
            close: () => {},
            completeSession: () => Promise.reject(null),
        };
        api.onConnectionStarted = () => {};
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        api.webSocket.onmessage({
            data: JSON.stringify({ setupComplete: { rtcSetupComplete: { answerSdp: "v=0" } } }),
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(plain(errors), ["WebRTC answer negotiation failed: unknown error"]);
        assert.equal(api.webSocket, null);
    }

    // 6. onConnectionStarted() throws null during setupComplete.
    {
        const api = await idleApi(120);
        api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
        api.setupWebSocketToService();
        api.onConnectionStarted = () => {
            throw null;
        };
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        api.webSocket.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
        assert.deepEqual(plain(errors), ["Could not start the session: unknown error"]);
        assert.equal(api.webSocket, null);
    }

    // 7. onReconnectNeeded() throws null / null-prototype on close 1001.
    for (const thrown of [null, nullProto]) {
        const api = await idleApi(120);
        api.setResumption(true, "h1");
        api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
        api.setupWebSocketToService();
        api.isSetupComplete = true;
        api.latestResumptionHandle = "h1";
        api.onReconnectNeeded = () => {
            throw thrown;
        };
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        api.webSocket.onclose({ code: 1001, reason: "restart" });
        assert.deepEqual(plain(errors), ["Could not resume the session: unknown error"]);
        assert.equal(api.idleTimer, null);
    }

    // 8. sendInitialSetupMessages() rejects with null in webSocket.onopen.
    {
        const api = await idleApi(120);
        api.setupWebSocketToService = GeminiLiveAPI.prototype.setupWebSocketToService;
        api.setupWebSocketToService();
        api.sendInitialSetupMessages = () => Promise.reject(null);
        const errors = [];
        api.onErrorMessage = (message) => errors.push(message);
        await api.webSocket.onopen();
        assert.deepEqual(plain(errors), ["Setup failed: unknown error"]);
        assert.equal(api.webSocket, null);
    }
});

test("postWithRetry() guards null, non-Error, and frozen rejections and formats retry warnings", async () => {
    const warnings = [];
    const retryTimers = [];
    const context = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: FakeWebSocket,
        AbortController,
        TypeError,
        console: { log: () => {}, warn: (...args) => warnings.push(args.join(" ")), error: () => {} },
        document: { getElementById: () => null },
        setTimeout: (fn, ms) => retryTimers.push({ fn, ms, cleared: false, fired: false }),
        clearTimeout: (id) => {
            if (retryTimers[id - 1]) retryTimers[id - 1].cleared = true;
        },
    });

    // 1. Timeout followed by a null rejection preserves timeouts count so initBackendService still abandons.
    {
        const api = new context.GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        const abandoned = [];
        api.abandonSession = (id) => abandoned.push(id);
        let calls = 0;
        api.sendPostRequest = () =>
            ++calls === 1
                ? Promise.reject(Object.assign(new Error("timed out"), { timeout: true }))
                : Promise.reject(null);
        const p = api.initBackendService("s-null-after-timeout");
        await fireNextTimer(retryTimers);
        await assert.rejects(
            () => p,
            (err) => err.message === "Could not start the session: unknown error" && err.cause?.timeouts === 1
        );
        assert.deepEqual(plain(abandoned), ["s-null-after-timeout"]);
    }

    // 2. Frozen transient object retries with a clean warning and wraps cleanly on exhaustion.
    {
        warnings.length = 0;
        const api = new context.GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        const frozen503 = Object.freeze({ status: 503 });
        api.sendPostRequest = () => Promise.reject(frozen503);
        const p = api.postWithRetry("/api/control", {}, { attempts: 2 });
        await fireNextTimer(retryTimers);
        await assert.rejects(
            () => p,
            (err) => err.message === "unknown error" && err.status === 503 && err.timeouts === 0 && err.cause === frozen503
        );
        assert.deepEqual(plain(warnings), ["POST /api/control failed (unknown error); retrying..."]);
    }

    // 3. Empty-message TypeError logs its name instead of empty parens.
    {
        warnings.length = 0;
        const api = new context.GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
        let calls = 0;
        api.sendPostRequest = () => (++calls === 1 ? Promise.reject(new TypeError("")) : Promise.resolve({ ok: true }));
        const p = api.postWithRetry("/api/control", {}, { attempts: 2 });
        await fireNextTimer(retryTimers);
        assert.deepEqual(plain(await p), { ok: true });
        assert.deepEqual(plain(warnings), ["POST /api/control failed (TypeError); retrying..."]);
    }
});

test("prepare() trims valid control.project_id and ignores blank, non-string, or non-object values", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.setProjectId("existing-project");

    for (const control of [
        null,
        undefined,
        "my-project",
        123,
        ["my-project"],
        {},
        { project_id: "" },
        { project_id: "   \t\n  " },
        { project_id: 123 },
        { project_id: true },
        { project_id: {} },
        { project_id: ["p"] },
        { project_id: null },
    ]) {
        api.sendPostRequest = async () => control;
        assert.equal(await api.prepare(), true);
        assert.equal(api.projectId, "existing-project", `control=${JSON.stringify(control)}`);
    }

    api.sendPostRequest = async () => ({ project_id: "  trimmed-project \t " });
    assert.equal(await api.prepare(), true);
    assert.equal(api.projectId, "trimmed-project");
});

test("prepare() validates control.idle_timeout_s and rejects booleans, non-numbers, non-finite, and overflowing values", async () => {
    for (const [label, control] of [
        ["null control", null],
        ["array control", [60]],
        ["string control", "60"],
        ["missing", { project_id: "p" }],
        ["true", { project_id: "p", idle_timeout_s: true }],
        ["false", { project_id: "p", idle_timeout_s: false }],
        ["numeric string", { project_id: "p", idle_timeout_s: "60" }],
        ["blank string", { project_id: "p", idle_timeout_s: "   " }],
        ["array", { project_id: "p", idle_timeout_s: [60] }],
        ["object", { project_id: "p", idle_timeout_s: { valueOf: () => 60 } }],
        ["null", { project_id: "p", idle_timeout_s: null }],
        ["zero", { project_id: "p", idle_timeout_s: 0 }],
        ["negative", { project_id: "p", idle_timeout_s: -10 }],
        ["NaN", { project_id: "p", idle_timeout_s: NaN }],
        ["Infinity", { project_id: "p", idle_timeout_s: Infinity }],
        ["-Infinity", { project_id: "p", idle_timeout_s: -Infinity }],
        ["1e308 overflow", { project_id: "p", idle_timeout_s: 1e308 }],
        ["MAX_VALUE overflow", { project_id: "p", idle_timeout_s: Number.MAX_VALUE }],
    ]) {
        const api = await idleApi(120);
        assert.equal(api.idleTimeoutMs, 120000, label);
        const prevTimer = timers[api.idleTimer - 1];
        api.sendPostRequest = async () => control;
        api.webSocket.close = () => {};
        api.webSocket.readyState = FakeWebSocket.CLOSED;
        await api.resume("h");
        assert.equal(api.idleTimeoutMs, 0, label);
        assert.equal(prevTimer.cleared, true, label);
        assert.equal(api.idleTimer, null, label);
    }

    // Valid finite positive numbers (including fractional seconds) still work.
    const fractional = await idleApi(0.5);
    assert.equal(fractional.idleTimeoutMs, 500);
    assert.equal(timers[fractional.idleTimer - 1].ms, 500);
});

test("startIdleTimer() ignores direct non-finite or non-positive idleTimeoutMs", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    for (const bad of [0, -100, NaN, Infinity, -Infinity]) {
        api.idleTimeoutMs = bad;
        api.startIdleTimer();
        assert.equal(api.idleTimer, null, `idleTimeoutMs=${bad}`);
    }
});

test("setVad and _buildRealtimeInputConfig normalize padded sensitivities and omit blank, unknown, or non-string values", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");

    // Whitespace-only and unknown sensitivities must not emit *_UNSPECIFIED.
    for (const [start, end] of [
        ["   ", "\t\n"],
        ["medium", "auto"],
        ["START_SENSITIVITY_LOW", "END_SENSITIVITY_HIGH"],
        [123, true],
        [{}, []],
    ]) {
        api.setVad(false, false, start, end);
        assert.equal(api.startSensitivity, "");
        assert.equal(api.endSensitivity, "");
        assert.equal(api._buildRealtimeInputConfig(), null);
    }

    // With disableInterruption or disableDetection set, invalid sensitivities are still omitted.
    api.setVad(true, false, "   ", "medium");
    assert.deepEqual(plain(api._buildRealtimeInputConfig()), {
        activity_handling: "NO_INTERRUPTION",
    });
    api.setVad(false, true, "  ", "unknown");
    assert.deepEqual(plain(api._buildRealtimeInputConfig()), {
        automatic_activity_detection: { disabled: true },
    });

    // Padded and mixed-case valid sensitivities are trimmed and lowercased.
    api.setVad(false, false, "  high\t", "\nLOW ");
    assert.equal(api.startSensitivity, "high");
    assert.equal(api.endSensitivity, "low");
    assert.deepEqual(plain(api._buildRealtimeInputConfig()), {
        automatic_activity_detection: {
            start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
            end_of_speech_sensitivity: "END_SENSITIVITY_LOW",
        },
    });

    // Direct property mutations bypass setVad() and must still normalize safely.
    api.startSensitivity = 123;
    api.endSensitivity = "   ";
    assert.equal(api._buildRealtimeInputConfig(), null);

    api.startSensitivity = " LoW ";
    api.endSensitivity = "unknown";
    assert.deepEqual(plain(api._buildRealtimeInputConfig()), {
        automatic_activity_detection: {
            start_of_speech_sensitivity: "START_SENSITIVITY_LOW",
        },
    });
});

test("_buildSystemInstructionConfig ignores blank and non-string systemInstructions without throwing", () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    for (const bad of ["", "   ", "\t\n ", null, undefined, 123, true, {}, []]) {
        api.systemInstructions = bad;
        assert.equal(api._buildSystemInstructionConfig(), null);
    }

    api.systemInstructions = "  Keep indentation.  ";
    assert.deepEqual(plain(api._buildSystemInstructionConfig()), {
        parts: [{ text: "  Keep indentation.  " }],
    });
});

test("parseAll, canResume, and setResumption normalize whitespace and non-string resumption handles", () => {
    // Whitespace-only server handles emit no RESUMPTION event and do not enable resume.
    assert.deepEqual(
        plain(GeminiLiveResponseMessage.parseAll({ sessionResumptionUpdate: { newHandle: "   " } })),
        []
    );
    assert.deepEqual(
        plain(GeminiLiveResponseMessage.parseAll({ session_resumption_update: { new_handle: "\t\n " } })),
        []
    );

    // Padded server handles are trimmed consistently with _buildSessionResumptionConfig().
    const trimmedEvents = GeminiLiveResponseMessage.parseAll({
        sessionResumptionUpdate: { newHandle: "  h-trimmed\n" },
    });
    assert.equal(trimmedEvents.length, 1);
    assert.equal(trimmedEvents[0].type, "RESUMPTION");
    assert.equal(trimmedEvents[0].data, "h-trimmed");

    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.setResumption(true, "  pasted-handle \n");
    assert.equal(api.resumptionHandle, "pasted-handle");
    assert.deepEqual(plain(api._buildSessionResumptionConfig()), { handle: "pasted-handle" });

    api.setResumption(true, "   ");
    assert.equal(api.resumptionHandle, "");
    assert.deepEqual(plain(api._buildSessionResumptionConfig()), {});

    api.setResumption(true, 123);
    assert.equal(api.resumptionHandle, "");
    assert.deepEqual(plain(api._buildSessionResumptionConfig()), {});

    const received = [];
    api.onReceiveResponse = (message) => received.push(message.type);
    api.onReceiveMessage({
        data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "   " } }),
    });
    assert.deepEqual(received, []);
    assert.equal(api.latestResumptionHandle, "");
    assert.equal(api.canResume(), false);

    // Direct property mutation with blank or non-string handles must not mark canResume() true.
    for (const bad of ["", "   ", "\t\n", 123, null, undefined, {}]) {
        api.latestResumptionHandle = bad;
        assert.equal(api.canResume(), false);
    }

    api.onReceiveMessage({
        data: JSON.stringify({ sessionResumptionUpdate: { newHandle: " h-valid " } }),
    });
    assert.deepEqual(received, ["RESUMPTION"]);
    assert.equal(api.latestResumptionHandle, "h-valid");
    assert.equal(api.canResume(), true);
});

test("updateBandwidthUsage() runs safely without a global document", () => {
    const intervals = [];
    const { GeminiLiveAPI: DomlessApi } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        document: undefined,
        WebSocket: FakeWebSocket,
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: (fn, ms) => {
            intervals.push({ fn, ms, cleared: false });
            return intervals.length;
        },
        clearInterval: (id) => {
            if (intervals[id - 1]) intervals[id - 1].cleared = true;
        },
    });
    const api = new DomlessApi("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.bytesIn = 2048;
    api.bytesOut = 1024;
    api.updateBandwidthUsage();
    assert.equal(intervals.length, 1);
    assert.doesNotThrow(() => intervals[0].fn());
    assert.equal(api.history.length, 1);
    assert.equal(api.bytesIn, 0);
    assert.equal(api.bytesOut, 0);
    assert.doesNotThrow(() => api.stopUpdateBandwidthUsage());
    assert.equal(intervals[0].cleared, true);
    assert.equal(api.history.length, 0);
});

test("direct resume(handle) on a fresh or disconnected instance starts a fresh idle deadline", async () => {
    const clock = { now: 100000 };
    const recorded = [];
    const { GeminiLiveAPI: ClockedApi } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        WebSocket: FakeWebSocket,
        setTimeout: (fn, ms) => {
            const entry = { fn, ms, cleared: false };
            recorded.push(entry);
            return recorded.length;
        },
        clearTimeout: (id) => {
            if (recorded[id - 1]) recorded[id - 1].cleared = true;
        },
        setInterval: () => 1,
        clearInterval: () => {},
        performance: { now: () => clock.now },
    });

    // Fresh instance: lastActivityAt is null, so resume() seeds it instead of timing out at 0.
    const api = new ClockedApi("ws://x/ws", "/api/control", "/api/post_endpoint");
    const idleMessages = [];
    api.onIdleTimeout = (message) => idleMessages.push(message);
    api.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: 30 });
    api.setupWebSocketToService = () => {};
    await api.resume("saved-handle");
    assert.equal(api.lastActivityAt, 100000);
    assert.equal(recorded[api.idleTimer - 1].ms, 30000);
    clock.now += 1000;
    recorded[api.idleTimer - 1].fn();
    assert.deepEqual(idleMessages, []);
    assert.equal(recorded[api.idleTimer - 1].ms, 29000);

    // After disconnect(), a later direct resume() also gets a fresh idle deadline.
    api.disconnect();
    assert.equal(api.lastActivityAt, null);
    clock.now += 60000;
    await api.resume("saved-handle-2");
    assert.equal(api.lastActivityAt, 161000);
    assert.equal(recorded[api.idleTimer - 1].ms, 30000);
    clock.now += 30000;
    recorded[api.idleTimer - 1].fn();
    assert.deepEqual(idleMessages, ["Disconnected after 30 seconds without activity."]);
});

test("re-entrant connect() or disconnect() before throwing in setup/reconnect callbacks does not tear down replacement session", async () => {
    // 1. onConnectionStarted calls connect() then throws.
    const api1 = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors1 = [];
    api1.onErrorMessage = (message) => errors1.push(message);
    api1.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: 0 });
    let replaced = false;
    let nextConnect = null;
    api1.onConnectionStarted = () => {
        if (!replaced) {
            replaced = true;
            nextConnect = api1.connect();
            throw new Error("boom after connect");
        }
    };
    await api1.connect();
    const ws1 = api1.webSocket;
    api1.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    await nextConnect;
    assert.deepEqual(errors1, []);
    assert.ok(api1.webSocket && api1.webSocket !== ws1);
    api1.disconnect();

    // 2. onTransportFallback calls disconnect() then throws.
    const api2 = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors2 = [];
    api2.onErrorMessage = (message) => errors2.push(message);
    api2.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: 0 });
    api2.transportMode = "webrtc";
    api2.webRtcManager = { close() {} };
    api2.onTransportFallback = () => {
        api2.disconnect();
        throw new Error("boom after disconnect");
    };
    await api2.connect();
    api2.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    assert.deepEqual(errors2, []);

    // 3. onReconnectNeeded (1001 onclose) calls connect() then throws.
    const api3 = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors3 = [];
    api3.onErrorMessage = (message) => errors3.push(message);
    api3.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: 60 });
    api3.setResumption(true, "");
    let reconnectPromise = null;
    api3.onReconnectNeeded = () => {
        reconnectPromise = api3.connect();
        throw new Error("boom after reconnect");
    };
    await api3.connect();
    const ws3 = api3.webSocket;
    api3.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) });
    api3.onReceiveMessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h3" } }) });
    ws3.onclose({ code: 1001, reason: "" });
    await reconnectPromise;
    assert.deepEqual(errors3, []);
    assert.ok(api3.webSocket && api3.webSocket !== ws3);
    assert.ok(api3.idleTimer !== null);
    api3.disconnect();
});

test("formatErrorReason() handles throwing .message and .name getters without escaping catch blocks", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    const errors = [];
    api.onErrorMessage = (message) => errors.push(message);
    api.sendPostRequest = async () => ({ project_id: "p", idle_timeout_s: 0 });

    // Throwing .message falls back to readable .name.
    const throwingMsgWithName = { name: "CustomName" };
    Object.defineProperty(throwingMsgWithName, "message", {
        get() {
            throw new Error("getter exploded");
        },
    });
    api.onConnectionStarted = () => {
        throw throwingMsgWithName;
    };
    await api.connect();
    assert.doesNotThrow(() => api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) }));
    assert.deepEqual(errors.splice(0), ["Could not start the session: CustomName"]);

    // Both .message and .name throwing fall back to "unknown error" (or String(error)).
    const bothThrow = Object.create(null);
    Object.defineProperty(bothThrow, "message", {
        get() {
            throw new Error("msg exploded");
        },
    });
    Object.defineProperty(bothThrow, "name", {
        get() {
            throw new Error("name exploded");
        },
    });
    api.onConnectionStarted = () => {
        throw bothThrow;
    };
    await api.connect();
    assert.doesNotThrow(() => api.onReceiveMessage({ data: JSON.stringify({ setupComplete: {} }) }));
    assert.deepEqual(errors.splice(0), ["Could not start the session: unknown error"]);
});

test("sendInitialSetupMessages() and _buildAvatarConfig() handle non-array responseModalities without throwing", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.model = "gemini-3.8-live";
    api.environment = "autopush-common";
    api.transportMode = "webrtc";
    const offerArgs = [];
    api.webRtcManager = {
        async initiateSession(opts) {
            offerArgs.push(opts);
            return "v=0\r\n";
        },
        close() {},
    };
    const ws = new FakeWebSocket();
    ws.readyState = FakeWebSocket.OPEN;
    api.webSocket = ws;

    for (const bad of [null, undefined, "VIDEO", 123, {}]) {
        api.responseModalities = bad;
        assert.equal(api._buildAvatarConfig(), null);
        assert.deepEqual(plain(api._buildGenerationConfig().response_modalities), []);
        await api.sendInitialSetupMessages(ws);
        assert.deepEqual(plain(offerArgs.at(-1)), { wantsVideo: false });
        const sent = ws.sent.at(-1);
        assert.deepEqual(sent.setup.generation_config.response_modalities, []);
        assert.equal("avatar_config" in sent.setup, false);
    }
});

test("sendTextMessage() and sendVoiceActivityMessage() only note activity when sendMessage() succeeds", async () => {
    const api = await idleApi(60);
    api.isSetupComplete = true;
    const longAgo = performance.now() - 60000;

    // Socket missing or not OPEN: sends fail and must not postpone lastActivityAt.
    for (const socket of [
        null,
        Object.assign(new FakeWebSocket(), { readyState: FakeWebSocket.CONNECTING }),
        Object.assign(new FakeWebSocket(), { readyState: 2 }), // CLOSING
        Object.assign(new FakeWebSocket(), { readyState: FakeWebSocket.CLOSED }),
    ]) {
        api.webSocket = socket;
        api.lastActivityAt = longAgo;
        assert.equal(api.sendTextMessage("hi"), false);
        assert.equal(api.lastActivityAt, longAgo);
        assert.equal(api.sendVoiceActivityMessage(true), false);
        assert.equal(api.lastActivityAt, longAgo);
        assert.equal(api.sendVoiceActivityMessage(false), false);
        assert.equal(api.lastActivityAt, longAgo);
    }

    // Throwing webSocket.send() must not postpone lastActivityAt either.
    const throwingWs = new FakeWebSocket();
    throwingWs.send = () => {
        throw new Error("send failed");
    };
    api.webSocket = throwingWs;
    api.lastActivityAt = longAgo;
    assert.throws(() => api.sendTextMessage("hi"), { message: "send failed" });
    assert.equal(api.lastActivityAt, longAgo);
    assert.throws(() => api.sendVoiceActivityMessage(true), { message: "send failed" });
    assert.equal(api.lastActivityAt, longAgo);

    // The idle timer still expires on schedule.
    timers[api.idleTimer - 1].fn();
    assert.equal(api.idleMessages.length, 1);

    // An open socket sends both frames and updates lastActivityAt.
    const openApi = await idleApi(60);
    openApi.isSetupComplete = true;
    openApi.lastActivityAt = 0;
    assert.equal(openApi.sendTextMessage("hello"), true);
    assert.ok(performance.now() - openApi.lastActivityAt < 1000);
    openApi.lastActivityAt = 0;
    assert.equal(openApi.sendVoiceActivityMessage(true), true);
    assert.ok(performance.now() - openApi.lastActivityAt < 1000);
    assert.equal(openApi.webSocket.sent.length, 2);
});

test("sendPostRequest() ignores non-finite/non-numeric timeoutMs and caps values above MAX_TIMEOUT_MS", async () => {
    const limit = 2 ** 31 - 1;
    const { api: okApi, timers: okTimers } = apiWithFetch(() => ({
        type: "application/json",
        text: '{"ok": true}',
    }));
    for (const timeoutMs of [0, -100, NaN, -Infinity, Infinity, "1000", true, null, { valueOf: () => 500 }]) {
        const res = await okApi.sendPostRequest("/api/control", {}, { timeoutMs });
        assert.deepEqual(plain(res), { ok: true });
    }
    assert.equal(okTimers.length, 0);

    // Infinity arms no timer and still respects the caller's AbortSignal.
    const { api: hangApi, timers: hangTimers } = apiWithFetch(() => "hang");
    const controller = new AbortController();
    const infiniteReq = hangApi.sendPostRequest("/api/control", {}, { signal: controller.signal, timeoutMs: Infinity });
    assert.equal(hangTimers.length, 0);
    controller.abort("cancelled");
    await assert.rejects(infiniteReq, (reason) => reason === "cancelled");

    // Finite values above MAX_TIMEOUT_MS are capped at MAX_TIMEOUT_MS so setTimeout never overflows.
    for (const timeoutMs of [2 ** 31, 1e12]) {
        const req = hangApi.sendPostRequest("/api/control", {}, { timeoutMs });
        const firedMs = await fireNextTimer(hangTimers);
        assert.equal(firedMs, limit);
        await assert.rejects(req, {
            timeout: true,
            message: `the server didn't answer within ${limit / 1000} s`,
        });
    }

    // Normal finite timeouts keep their exact duration.
    const normalReq = hangApi.sendPostRequest("/api/control", {}, { timeoutMs: 5000 });
    assert.equal(await fireNextTimer(hangTimers), 5000);
    await assert.rejects(normalReq, {
        timeout: true,
        message: "the server didn't answer within 5 s",
    });
});

test("setApiHost() normalizes whitespace, case, and non-string environments without throwing", () => {
    const errors = [];
    const { GeminiLiveAPI: TrackedAPI } = loadScript("gemini-live-api.js", ["GeminiLiveAPI"], {
        console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(" ")) },
    });
    const api = new TrackedAPI("ws://x/ws", "/api/control", "/api/post_endpoint");

    const validCases = [
        ["  PROD  ", "prod", "aiplatform.googleapis.com"],
        ["\tStaging\n", "staging", "staging-aiplatform.sandbox.googleapis.com"],
        ["  AUTOPUSH ", "autopush", "autopush-aiplatform.sandbox.googleapis.com"],
        ["  prod-us-rep  ", "prod-us-rep", "aiplatform.us.rep.googleapis.com"],
        ["PROD-US-REP", "prod-us-rep", "aiplatform.us.rep.googleapis.com"],
        [
            "  AIPLATFORM.US.REP.GOOGLEAPIS.COM\t",
            "aiplatform.us.rep.googleapis.com",
            "aiplatform.us.rep.googleapis.com",
        ],
        ["  AUTOPUSH-US-REP  ", "autopush-us-rep", "autopush-aiplatform.us.rep.sandbox.googleapis.com"],
        [
            "  AUTOPUSH-AIPLATFORM.US.REP.SANDBOX.GOOGLEAPIS.COM ",
            "autopush-aiplatform.us.rep.sandbox.googleapis.com",
            "autopush-aiplatform.us.rep.sandbox.googleapis.com",
        ],
        ["  STAGING-US-REP  ", "staging-us-rep", "staging-aiplatform.us.rep.sandbox.googleapis.com"],
        [
            "\nSTAGING-AIPLATFORM.US.REP.SANDBOX.GOOGLEAPIS.COM\t",
            "staging-aiplatform.us.rep.sandbox.googleapis.com",
            "staging-aiplatform.us.rep.sandbox.googleapis.com",
        ],
        ["  autopush-common  ", "autopush-common", "autopush-common"],
        ["STAGING-COMMON", "staging-common", "staging-common"],
        ["  Autopush-Vertex-Bidi ", "autopush-vertex-bidi", "autopush-vertex-bidi"],
        ["AUTOPUSH-VERTEX-US-BIDI", "autopush-vertex-us-bidi", "autopush-vertex-us-bidi"],
    ];
    for (const [input, expectedEnv, expectedHost] of validCases) {
        api.setApiHost(input);
        assert.equal(api.environment, expectedEnv, `env for ${JSON.stringify(input)}`);
        assert.equal(api.endPoint, expectedHost, `host for ${JSON.stringify(input)}`);
    }
    assert.deepEqual(errors, []);

    const invalidCases = [
        [null, ""],
        [undefined, ""],
        [123, ""],
        [{}, ""],
        [Symbol("env"), ""],
        [{ toString: null }, ""],
        ["", ""],
        ["   \t\n ", ""],
        ["  UNKNOWN-ENV  ", "unknown-env"],
    ];
    for (const [input, expectedEnv] of invalidCases) {
        const before = errors.length;
        assert.doesNotThrow(() => api.setApiHost(input));
        assert.equal(api.environment, expectedEnv);
        assert.equal(api.endPoint, "aiplatform.googleapis.com");
        assert.equal(errors.length, before + 1);
        assert.match(errors.at(-1), /^Unknown environment: /);
    }
});

test("sendInitialSetupMessages() and initBackendService() resolve prod-us-rep aliases and normalized environments", async () => {
    const api = new GeminiLiveAPI("ws://x/ws", "/api/control", "/api/post_endpoint");
    api.webSocket = new FakeWebSocket();
    api.transportMode = "websocket";
    api.projectId = "p";
    api.location = "us-central1";
    api.responseModalities = ["AUDIO"];

    // Prod mREP host alias and normalized prod-us-rep map common-only models to gemini-3.8-live.
    for (const env of [
        "aiplatform.us.rep.googleapis.com",
        "  AIPLATFORM.US.REP.GOOGLEAPIS.COM  ",
        "  PROD-US-REP  ",
    ]) {
        api.setApiHost(env);
        for (const model of [
            "live_avatar_rev23_rc4",
            "live_avatar_v2_rev25_rc2",
            "gemini_api_beyond_live_rev23_rc3",
            "gemini_live_rev25",
        ]) {
            api.setModel(model);
            await api.sendInitialSetupMessages();
            assert.equal(api.resolvedModel, "gemini-3.8-live", `${env} / ${model}`);
            assert.equal(
                api.webSocket.sent.at(-1).setup.model,
                "projects/p/locations/us-central1/publishers/google/models/gemini-3.8-live",
                `${env} / ${model}`
            );
        }
    }

    // Other Vertex hosts still map common-only models to gemini-3.1-flash-live-preview-04-2026.
    for (const env of ["prod", "staging", "autopush-us-rep", "staging-aiplatform.us.rep.sandbox.googleapis.com"]) {
        api.setApiHost(env);
        api.setModel("live_avatar_v2_rev25_rc2");
        await api.sendInitialSetupMessages();
        assert.equal(api.resolvedModel, "gemini-3.1-flash-live-preview-04-2026", env);
        assert.equal(
            api.webSocket.sent.at(-1).setup.model,
            "projects/p/locations/us-central1/publishers/google/models/gemini-3.1-flash-live-preview-04-2026",
            env
        );
    }

    // Normalized common-bag environments emit models/... without remapping.
    for (const env of ["  autopush-common  ", "STAGING-COMMON"]) {
        api.setApiHost(env);
        api.setModel("live_avatar_v2_rev25_rc2");
        await api.sendInitialSetupMessages();
        assert.equal(api.resolvedModel, "live_avatar_v2_rev25_rc2", env);
        assert.equal(api.webSocket.sent.at(-1).setup.model, "models/live_avatar_v2_rev25_rc2", env);
    }

    // gemini-3.5-live-early-exp downgrades mREP host aliases and normalized common envs in initBackendService().
    const posted = [];
    api.postWithRetry = async (_url, body) => {
        posted.push(plain(body));
        return { project_id: "p", idle_timeout_s: 0 };
    };
    api.setModel("gemini-3.5-live-early-exp");
    for (const [input, expectedEndpoint] of [
        ["aiplatform.us.rep.googleapis.com", "aiplatform.googleapis.com"],
        ["  staging-aiplatform.us.rep.sandbox.googleapis.com ", "staging-aiplatform.sandbox.googleapis.com"],
        ["AUTOPUSH-AIPLATFORM.US.REP.SANDBOX.GOOGLEAPIS.COM", "autopush-aiplatform.sandbox.googleapis.com"],
        ["  AUTOPUSH-COMMON  ", "autopush-aiplatform.sandbox.googleapis.com"],
    ]) {
        api.setApiHost(input);
        await api.initBackendService("s");
        assert.equal(posted.at(-1).endpoint, expectedEndpoint, input);
    }
});
