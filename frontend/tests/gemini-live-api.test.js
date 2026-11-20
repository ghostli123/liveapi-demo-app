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

const { GeminiLiveAPI, GeminiLiveResponseMessage } = loadScript(
    "gemini-live-api.js",
    ["GeminiLiveAPI", "GeminiLiveResponseMessage"],
    { WebSocket: FakeWebSocket }
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
        setup_complete: { rtc_setup_complete: { answer_sdp: "v=0" } },
    });
    assert.deepEqual(types(events), ["SETUP COMPLETE"]);
    assert.equal(events[0].answerSdp, "v=0");
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
