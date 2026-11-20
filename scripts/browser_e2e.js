// End-to-end checks of the app in headless Chrome against a running server and
// a real Live API endpoint. Needs credentials on the server and
// `npm install` (for playwright-core). Usage:
//
//   node scripts/browser_e2e.js [--server=http://localhost:8080]
//       [--environment=prod-us-rep] [--model=gemini-3.8-live]
//       [--chrome=/usr/bin/google-chrome] [--speech=sample.wav]
//
// --speech feeds a WAV file to the fake microphone to test voice turns.
// --environment=autopush-common reaches scripts/mock_live_api.py when the
// server runs with --common_bag_ws_port set to the mock's port.
const { chromium } = require("playwright-core");
const path = require("path");

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s).slice(0, 2))
);
const SERVER = (args.server || "http://localhost:8080").replace(/\/$/, "");
const ENVIRONMENT = args.environment || "prod-us-rep";
const MODEL = args.model || "gemini-3.8-live";
const CHROME = args.chrome || process.env.CHROME_PATH || "/usr/bin/google-chrome";
const FC_DEFINITION = require(path.join(__dirname, "..", "fc_definition.json"));

async function newPage(browser) {
    const page = await browser.newPage();
    page.errors = [];
    page.on("console", (m) => {
        // Retried requests log while a server restarts; everything else is a bug.
        if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text())) {
            page.errors.push(m.text().slice(0, 200));
        }
    });
    page.on("pageerror", (e) => page.errors.push(e.message));
    await page.goto(`${SERVER}/`);
    await page.waitForFunction(() => customElements.get("md-outlined-select"));
    await page.evaluate(() => localStorage.clear());
    return page;
}

// Selects a value, first adding an option for it if the page has none: the
// select ignores values it has no option for, which would silently run the
// scenario with the default. The frontend handles the common BAG environments
// (used with scripts/mock_live_api.py) but doesn't list them.
async function choose(page, id, value) {
    await page.evaluate(
        ([id, value]) => {
            const select = document.getElementById(id);
            const options = [...select.querySelectorAll("md-select-option")];
            if (!options.some((option) => option.value === value)) {
                const option = document.createElement("md-select-option");
                option.value = value;
                select.appendChild(option);
            }
        },
        [id, value]
    );
    // A new option registers with the select asynchronously.
    await page
        .waitForFunction(
            ([id, value]) => {
                const select = document.getElementById(id);
                select.value = value;
                return select.value === value;
            },
            [id, value],
            { timeout: 5000 }
        )
        .catch(() => {
            throw new Error(`couldn't select ${id}=${value}`);
        });
}

async function connect(page, { transport, modality = "VIDEO", model = MODEL, before }) {
    await choose(page, "envApiHost", ENVIRONMENT);
    await choose(page, "liveApiModel", model);
    await choose(page, "transportMode", transport);
    await page.evaluate((modality) => {
        for (const radio of document.querySelectorAll('md-radio[name="responseModality"]')) {
            radio.checked = radio.value === modality;
        }
    }, modality);
    if (before) await page.evaluate(before);
    await page.click("#connectBtn");
}

const waitConnected = (page) =>
    page.waitForFunction(() => !document.getElementById("connected").hidden, null, { timeout: 30000 });

async function say(page, text, waitMs = 9000) {
    await page.fill("#text-message input", text).catch(() =>
        page.evaluate((t) => (document.getElementById("text-message").value = t), text)
    );
    await page.press("#text-message", "Enter");
    await page.waitForTimeout(waitMs);
}

const chat = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll("#text-chat > *")].map((p) => ({ kind: p.className, text: p.textContent }))
    );
const modelLines = async (page) => (await chat(page)).filter((l) => l.kind.includes("chat-model"));
const dialog = (page) =>
    page.evaluate(() => (document.getElementById("dialog").open ? document.getElementById("dialogMessage").textContent : null));

function check(condition, message) {
    if (!condition) throw new Error(message);
}

const scenarios = {
    async "text turn over WebSocket with avatar video"(browser) {
        const page = await newPage(browser);
        await connect(page, { transport: "websocket" });
        await waitConnected(page);
        await say(page, "Say hello in one short sentence.");
        check((await modelLines(page)).length > 0, "no model reply");
        const video = await page.evaluate(() => {
            const v = document.getElementById("video_player");
            return { width: v.videoWidth, time: v.currentTime };
        });
        check(video.width > 0 && video.time > 0, `avatar video not playing: ${JSON.stringify(video)}`);
        await page.click("#disconnectBtn");
        await page.waitForTimeout(1000);
        check((await dialog(page)) === null, `disconnect showed: ${await dialog(page)}`);
        check(page.errors.length === 0, `console errors: ${page.errors}`);
    },

    async "text turn over WebRTC"(browser) {
        const page = await newPage(browser);
        await connect(page, { transport: "webrtc" });
        await waitConnected(page);
        await say(page, "Say hello in one short sentence.");
        check((await modelLines(page)).length > 0, "no model reply");
        const state = await page.evaluate(() => document.getElementById("webrtc-state").textContent);
        check(state === "connected", `WebRTC state ${state}`);
        await page.click("#disconnectBtn");
        check(page.errors.length === 0, `console errors: ${page.errors}`);
    },

    async "resumption keeps the conversation"(browser) {
        const page = await newPage(browser);
        await connect(page, { transport: "websocket", modality: "AUDIO" });
        await waitConnected(page);
        await say(page, "My favorite fruit is mango. Just say OK.", 6000);
        await page.waitForFunction(() => AppState.geminiLiveApi.latestResumptionHandle, null, { timeout: 15000 });
        await page.evaluate(() => handleSessionResumptionReconnect()); // As on GoAway.
        await waitConnected(page);
        await page.waitForTimeout(1000);
        await say(page, "What is my favorite fruit? One word.");
        const last = (await modelLines(page)).pop();
        check(last && /mango/i.test(last.text), `reply after resume: ${last && last.text}`);
        await page.click("#disconnectBtn");
    },

    async "function calling"(browser) {
        const page = await newPage(browser);
        await connect(page, {
            transport: "websocket",
            modality: "AUDIO",
            before: `AppState.functionCallDefinition = ${JSON.stringify(FC_DEFINITION)};
                     document.getElementById("enableGoogleSearch").checked = false;`,
        });
        await waitConnected(page);
        await say(
            page,
            "Call create_appointment now: client Jane Doe, client id JD-42, type haircut, " +
                "2026-12-01 at 15:30:00, location Main Street Salon, duration 30 minutes. " +
                "Do not ask questions.",
            15000
        );
        const lines = await chat(page);
        check(lines.some((l) => l.text.startsWith("Function call: create_appointment")), "no function call");
        check(!lines.some((l) => l.kind.includes("chat-error")), "function call failed");
        check((await modelLines(page)).length > 0, "no reply after the function response");
        await page.click("#disconnectBtn");
    },

    async "upstream errors are shown with their reason"(browser) {
        const page = await newPage(browser);
        await connect(page, { transport: "websocket", model: "no-such-model" });
        await page.waitForFunction(() => document.getElementById("dialog").open, null, { timeout: 20000 });
        const message = await dialog(page);
        check(/code 1008/.test(message) && /no-such-model/.test(message), `dialog: ${message}`);
    },

    async "voice turn from the microphone"(browser) {
        if (!args.speech) return "skipped (pass --speech=file.wav)";
        const voiceBrowser = await chromium.launch({
            executablePath: CHROME,
            args: [
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                `--use-file-for-fake-audio-capture=${path.resolve(args.speech)}%noloop`,
                "--autoplay-policy=no-user-gesture-required",
            ],
        });
        try {
            const page = await newPage(voiceBrowser);
            await connect(page, { transport: "webrtc", modality: "AUDIO" });
            await waitConnected(page);
            await page.click("#micOffBtn md-filled-icon-button");
            await page.waitForTimeout(25000);
            const lines = await chat(page);
            check(lines.some((l) => l.kind.includes("chat-user")), "no input transcript");
            check(lines.some((l) => l.kind.includes("chat-model")), "no model reply");
        } finally {
            await voiceBrowser.close();
        }
    },
};

(async () => {
    const browser = await chromium.launch({
        executablePath: CHROME,
        args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ],
    });
    let failures = 0;
    for (const [name, run] of Object.entries(scenarios)) {
        const started = Date.now();
        try {
            const note = await run(browser);
            console.log(`${note ? "SKIP" : "PASS"}  ${name} (${Date.now() - started} ms)${note ? `: ${note}` : ""}`);
        } catch (error) {
            failures++;
            console.log(`FAIL  ${name}: ${error.message}`);
        }
    }
    await browser.close();
    process.exit(failures ? 1 : 0);
})();
