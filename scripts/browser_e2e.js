// End-to-end checks of the app in headless Chrome or Firefox against a running
// server and a real Live API endpoint. Needs credentials on the server and
// `npm install` (for playwright-core). Usage:
//
//   node scripts/browser_e2e.js [--server=http://localhost:8080]
//       [--environment=prod-us-rep] [--model=gemini-3.8-live]
//       [--browser=chromium|firefox] [--chrome=/usr/bin/google-chrome]
//       [--speech=sample.wav] [--mock]
//
// --browser=firefox runs Playwright's Firefox build (`npx playwright-core
// install firefox`) instead of the Chrome at --chrome.
// --speech feeds a WAV file to Chrome's fake microphone to test voice turns.
// --mock runs against scripts/mock_live_api.py instead, which needs no
// credentials: start the server with --common_bag_ws_port set to the mock's
// port. The environment defaults to autopush-common, which the server routes
// to that port. The mock sends no avatar video or WebRTC answer, so those
// checks become checks of the audio-only and WebSocket-fallback paths; the
// function-response simulator (a Gemini call) is answered in the browser; and
// the GoAway scenarios run, since only the mock can be told to send one. A
// scenario that passes with some of its checks left out prints "PASS*" and
// says which.

/* global window, document, customElements, AppState, handleSessionResumptionReconnect, axe -- used in
   page.evaluate() callbacks, which run in the app page */
const { chromium, firefox } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const FLAGS = ["server", "environment", "model", "browser", "chrome", "speech", "mock"];
const args = {};
for (const arg of process.argv.slice(2)) {
    const [name, value] = arg.replace(/^--/, "").split(/=(.*)/s);
    // A mistyped flag would otherwise run against the defaults (e.g. :8080).
    if (!arg.startsWith("--") || !FLAGS.includes(name)) {
        console.error(`unknown argument ${arg}; flags: ${FLAGS.map((f) => `--${f}`).join(" ")}`);
        process.exit(2);
    }
    args[name] = value;
}
const SERVER = (args.server || "http://localhost:8080").replace(/\/$/, "");
const MOCK = "mock" in args;
const ENVIRONMENT = args.environment || (MOCK ? "autopush-common" : "prod-us-rep");
const MODEL = args.model || "gemini-3.8-live";
const CHROME = args.chrome || process.env.CHROME_PATH || "/usr/bin/google-chrome";
const BROWSER = args.browser || "chromium";
if (!["chromium", "firefox"].includes(BROWSER)) {
    console.error(`unknown --browser=${BROWSER}; use chromium or firefox`);
    process.exit(2);
}
const FC_DEFINITION = require(path.join(__dirname, "..", "fc_definition.json"));

async function newPage(browser, pages) {
    const page = await browser.newPage();
    pages.push(page); // Closed by the runner, which ends a session a failed check left running.
    page.errors = [];
    page.on("console", (m) => {
        // Retried requests log while a server restarts; everything else is a bug.
        if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text())) {
            page.errors.push(m.text().slice(0, 200));
        }
    });
    page.on("pageerror", (e) => page.errors.push(e.message));
    // Not every browser logs a Content-Security-Policy violation as an error.
    await page.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (e) =>
            console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI}`)
        )
    );
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

// Says text and returns the model lines that came after it, joined. The chat
// keeps earlier replies across a resume, so the last line alone could be from
// before it.
async function reply(page, text, waitMs) {
    const before = (await modelLines(page)).length;
    await say(page, text, waitMs);
    return (await modelLines(page))
        .slice(before)
        .map((l) => l.text)
        .join(" ");
}
const dialog = (page) =>
    page.evaluate(() => (document.getElementById("dialog").open ? document.getElementById("dialogMessage").textContent : null));

function check(condition, message) {
    if (!condition) throw new Error(message);
}

const checkNoErrors = (page) => check(page.errors.length === 0, `console errors: ${page.errors}`);

// Disconnects and checks that it went quietly.
async function endSession(page) {
    await page.click("#disconnectBtn");
    await page.waitForTimeout(1000);
    check((await dialog(page)) === null, `disconnect showed: ${await dialog(page)}`);
    checkNoErrors(page);
}

// Runs axe-core in the page and returns its WCAG 2.1 A/AA and best-practice
// violations, one line each.
async function accessibilityViolations(page) {
    if (!(await page.evaluate(() => "axe" in window))) {
        await page.evaluate(fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"));
    }
    const violations = await page.evaluate(async () => {
        const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
        // No preload: fetching the font stylesheets breaks the page's connect-src.
        const result = await axe.run(document, { preload: false, runOnly: { type: "tag", values: tags } });
        return result.violations.map((v) => `${v.id} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
    });
    return violations;
}

// Launches the browser with a fake camera and microphone that need no
// permission prompt, and autoplay allowed. chromeArgs are added for Chrome.
function launch(chromeArgs = []) {
    if (BROWSER === "firefox") {
        return firefox.launch({
            firefoxUserPrefs: {
                "media.navigator.streams.fake": true,
                "media.navigator.permission.disabled": true,
                "media.autoplay.default": 0, // Allowed.
            },
        });
    }
    return chromium.launch({
        executablePath: CHROME,
        args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
            ...chromeArgs,
        ],
    });
}

class Skip extends Error {}
const skip = (reason) => {
    throw new Skip(reason);
};

// Each scenario gets one of these: pages it opens are closed after it ends,
// and notes say which of its checks it left out.
class Run {
    pages = [];
    notes = [];
    newPage(browser) {
        return newPage(browser, this.pages);
    }
    notChecked(what) {
        this.notes.push(what);
    }
    async close() {
        await Promise.all(this.pages.map((page) => page.close().catch(() => {})));
    }
}

const scenarios = {
    async "no accessibility violations (axe-core)"(browser, run) {
        const page = await run.newPage(browser);
        const desktop = page.viewportSize();
        const auditAt = async (state) => {
            const violations = await accessibilityViolations(page);
            check(violations.length === 0, `${state}: ${violations.join("; ")}`);
        };
        // axe skips what it can't scroll into view, and the desktop sidebar
        // scrolls on its own, so its lower settings go unchecked there. At
        // phone width the page scrolls as a whole, so axe sees all of them.
        const audit = async (state) => {
            await auditAt(state);
            await page.setViewportSize({ width: 412, height: 915 });
            await page.waitForTimeout(300);
            await auditAt(`${state} at phone width`);
            await page.setViewportSize(desktop);
            await page.waitForTimeout(300);
        };
        await page.waitForTimeout(1000); // Let the Material components render.
        await audit("idle");
        // One status label shows at a time, and "connecting" and "model
        // speaking" don't stay up for an audit (the mock never speaks), so show
        // them all, with any animation at its first frame.
        const shown = await page.evaluate(() =>
            [...document.querySelectorAll(".state")].map((el) => {
                const wasHidden = el.hidden;
                el.hidden = false;
                el.getAnimations({ subtree: true }).forEach((a) => {
                    a.pause();
                    a.currentTime = 0;
                });
                return wasHidden;
            })
        );
        await audit("every status label");
        await page.evaluate((wasHidden) => {
            document.querySelectorAll(".state").forEach((el, i) => {
                el.hidden = wasHidden[i];
                el.getAnimations({ subtree: true }).forEach((a) => a.play());
            });
        }, shown);
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
        await audit("settings open");
        await page.click("#createVoiceBtn");
        await audit("branded-voice dialog");
        await page.keyboard.press("Escape");
        check(
            await page.evaluate(() => document.activeElement?.id === "createVoiceBtn"),
            "Escape didn't close the dialog and return focus"
        );
        await connect(page, { transport: "websocket" });
        await waitConnected(page);
        await say(page, "Say hello in one short sentence.", 4000);
        await audit("connected");
        await endSession(page);
    },

    async "text turn over WebSocket with avatar video"(browser, run) {
        const page = await run.newPage(browser);
        await connect(page, { transport: "websocket" });
        await waitConnected(page);
        await say(page, "Say hello in one short sentence.");
        check((await modelLines(page)).length > 0, "no model reply");
        if (MOCK) {
            run.notChecked("avatar video (the mock sends none)");
        } else {
            const video = await page.evaluate(() => {
                const v = document.getElementById("video_player");
                return { width: v.videoWidth, time: v.currentTime };
            });
            check(video.width > 0 && video.time > 0, `avatar video not playing: ${JSON.stringify(video)}`);
        }
        await endSession(page);
    },

    async "text turn over WebRTC"(browser, run) {
        const page = await run.newPage(browser);
        await connect(page, { transport: "webrtc" });
        await waitConnected(page);
        await say(page, "Say hello in one short sentence.");
        check((await modelLines(page)).length > 0, "no model reply");
        const state = await page.evaluate(() => ({
            transport: document.getElementById("active-transport").textContent,
            webrtc: document.getElementById("webrtc-state").textContent,
        }));
        if (MOCK) {
            // The mock sends no SDP answer, so media falls back to the WebSocket.
            check(
                state.transport === "WebSocket" && state.webrtc === "n/a",
                `after fallback: ${JSON.stringify(state)}`
            );
            const lines = await chat(page);
            check(lines.some((l) => /didn't accept WebRTC/.test(l.text)), "no fallback message");
            run.notChecked("WebRTC media (the mock sends no answer; checked the fallback to WebSocket)");
        } else {
            check(state.webrtc === "connected", `WebRTC state ${state.webrtc}`);
        }
        await endSession(page);
    },

    async "resumption keeps the conversation"(browser, run) {
        const page = await run.newPage(browser);
        await connect(page, { transport: "websocket", modality: "AUDIO" });
        await waitConnected(page);
        await say(page, "My favorite fruit is mango. Just say OK.", 6000);
        await page.waitForFunction(() => AppState.geminiLiveApi.latestResumptionHandle, null, { timeout: 15000 });
        await page.evaluate(() => handleSessionResumptionReconnect()); // As on GoAway.
        await waitConnected(page);
        await page.waitForTimeout(1000);
        const answer = await reply(page, "What is my favorite fruit? One word.");
        check(/mango/i.test(answer), `reply after resume: ${answer || "none"}`);
        await endSession(page);
    },

    async "function calling"(browser, run) {
        const page = await run.newPage(browser);
        if (MOCK) {
            // The simulator is a Gemini call, which needs credentials.
            run.notChecked("the function-response simulator (answered in the browser)");
            await page.route("**/api/post_endpoint", (route) =>
                route.request().postDataJSON().objective === "fr_generate"
                    ? route.fulfill({ json: { response: '{"appointment_id": "APT-1234"}' } })
                    : route.continue()
            );
        }
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
        const replies = await modelLines(page);
        check(replies.length > 0, "no reply after the function response");
        // The mock's reply quotes the function response it got.
        check(!MOCK || /APT-1234/.test(replies.pop().text), "the reply doesn't use the function response");
        await endSession(page);
    },

    async "upstream errors are shown with their reason"(browser, run) {
        const page = await run.newPage(browser);
        await connect(page, { transport: "websocket", model: "no-such-model" });
        await page.waitForFunction(() => document.getElementById("dialog").open, null, { timeout: 20000 });
        const message = await dialog(page);
        check(/code 1008/.test(message) && /no-such-model/.test(message), `dialog: ${message}`);
        checkNoErrors(page);
    },

    async "GoAway resumes the session"(browser, run) {
        if (!MOCK) skip("needs --mock");
        const page = await run.newPage(browser);
        await connect(page, { transport: "websocket", modality: "AUDIO" });
        await waitConnected(page);
        await say(page, "My favorite fruit is mango.", 1000);
        await page.waitForFunction(() => AppState.geminiLiveApi.latestResumptionHandle, null, { timeout: 15000 });
        const sessionId = await page.evaluate(() => AppState.geminiLiveApi.sessionId);
        // The mock sends goAway, then closes the connection 1 s later.
        await say(page, "/goaway 1", 0);
        await page
            .waitForFunction(
                (old) => AppState.geminiLiveApi.sessionId !== old && AppState.geminiLiveApi.isSetupComplete,
                sessionId,
                { timeout: 15000 }
            )
            .catch(() => {
                throw new Error("no new connection after GoAway");
            });
        await page.waitForTimeout(2000); // Past the old connection's close.
        const answer = await reply(page, "What is my favorite fruit?", 2000);
        check(/mango/i.test(answer), `reply after resume: ${answer || "none"}`);
        check((await dialog(page)) === null, `GoAway showed: ${await dialog(page)}`);
        await endSession(page);
    },

    async "input during a GoAway resume waits for the new session"(browser, run) {
        if (!MOCK) skip("needs --mock");
        const page = await run.newPage(browser);
        await connect(page, {
            transport: "websocket",
            modality: "AUDIO",
            // Shows "Start speaking", which sends activity_start/activity_end.
            before: () => (document.getElementById("disableDetection").checked = true),
        });
        await waitConnected(page);
        await say(page, "Hello.", 1000);
        await page.waitForFunction(() => AppState.geminiLiveApi.latestResumptionHandle, null, { timeout: 15000 });
        // Press "Start speaking" and send text right after resume() drops the
        // old connection, before the new one is set up.
        await page.evaluate(() => {
            const api = AppState.geminiLiveApi;
            const resume = api.resume.bind(api);
            api.resume = (handle) => {
                const resumed = resume(handle);
                const dialogText = () => document.getElementById("dialogMessage").textContent;
                document.getElementById("turnBtn").click();
                window.duringResume = { turn: dialogText() };
                document.getElementById("text-message").value = "Sent too early.";
                document.getElementById("sendMessageBtn").click();
                window.duringResume.text = dialogText();
                return resumed;
            };
        });
        await say(page, "/goaway 1", 0);
        await page
            .waitForFunction(() => window.duringResume && AppState.geminiLiveApi.isSetupComplete, null, {
                timeout: 15000,
            })
            .catch(() => {
                throw new Error("no new connection after GoAway");
            });
        const during = await page.evaluate(() => window.duringResume);
        check(/still connecting.*speaking/.test(during.turn), `Start speaking while resuming showed: ${during.turn}`);
        check(/still connecting.*sending/.test(during.text), `text while resuming showed: ${during.text}`);
        const turnText = () => page.evaluate(() => document.getElementById("turnBtn").textContent);
        check((await turnText()) === "Start speaking", `turn button while resuming: ${await turnText()}`);
        check(
            (await page.evaluate(() => document.getElementById("text-message").value)) === "Sent too early.",
            "the text sent while resuming left the box"
        );
        check(
            !(await chat(page)).some((l) => l.text.includes("Sent too early.")),
            "the text sent while resuming is in the chat"
        );

        // Both work once the new session is set up.
        await page.evaluate(() => document.getElementById("dialog").close());
        await page.click("#turnBtn");
        await page.waitForFunction(() => document.getElementById("turnBtn").textContent === "Done speaking", null, {
            timeout: 5000,
        });
        await page.click("#turnBtn");
        const answer = await reply(page, "Hello again.", 2000);
        check(answer.length > 0, "no reply after resume");
        await endSession(page);
    },

    async "repeated GoAways stop resuming after the limit"(browser, run) {
        if (!MOCK) skip("needs --mock");
        const page = await run.newPage(browser);
        await connect(page, { transport: "websocket", modality: "AUDIO" });
        await waitConnected(page);
        await say(page, "Hello.", 1000);
        await page.waitForFunction(() => AppState.geminiLiveApi.latestResumptionHandle, null, { timeout: 15000 });
        const sessionIds = [];
        for (let i = 0; i < 4; i++) {
            sessionIds.push(await page.evaluate(() => AppState.geminiLiveApi.sessionId));
            // The last connection isn't resumed, so let the mock close it soon.
            await say(page, i < 3 ? "/goaway 30" : "/goaway 1", 0);
            if (i === 3) break;
            await page.waitForFunction(
                (old) => AppState.geminiLiveApi.sessionId !== old && AppState.geminiLiveApi.isSetupComplete,
                sessionIds[i],
                { timeout: 15000 }
            );
        }
        await page.waitForFunction(() => document.getElementById("dialog").open, null, { timeout: 15000 });
        check(
            (await page.evaluate(() => AppState.geminiLiveApi.sessionId)) === sessionIds[3],
            "the fourth GoAway in a minute resumed"
        );
        const lines = await chat(page);
        check(
            lines.some((l) => l.kind.includes("chat-error") && /won't be resumed/.test(l.text)),
            "no error for the GoAway that wasn't resumed"
        );
        check(/code 1001/.test(await dialog(page)), `dialog: ${await dialog(page)}`);
        check(!(await page.evaluate(() => document.getElementById("connectBtn").disabled)), "Connect is disabled");
        checkNoErrors(page);
    },

    async "an idle session ends with a reason"(browser, run) {
        const page = await run.newPage(browser);
        // Shortens the server's --idle_timeout_s (default 15 minutes) to 5 s.
        await page.route("**/api/control", async (route) => {
            const response = await route.fetch();
            const json = await response.json();
            if ("idle_timeout_s" in json) json.idle_timeout_s = 5;
            await route.fulfill({ response, json });
        });
        await connect(page, { transport: "websocket", modality: "AUDIO" });
        await waitConnected(page);
        await say(page, "Say hi.", 0);
        const saidAt = Date.now();
        await page.waitForFunction(() => document.getElementById("dialog").open, null, { timeout: 30000 });
        const elapsed = Date.now() - saidAt;
        check(elapsed >= 4500, `ended ${elapsed} ms after the last message`);
        check((await modelLines(page)).length > 0, "no model reply before the timeout");
        check(
            (await dialog(page)) === "Disconnected after 5 seconds without activity.",
            `dialog: ${await dialog(page)}`
        );
        check(!(await page.evaluate(() => document.getElementById("connectBtn").disabled)), "Connect is disabled");
        checkNoErrors(page);
    },

    async "voice turn from the microphone"(browser, run) {
        if (MOCK) skip("the mock ignores audio");
        if (!args.speech) skip("pass --speech=file.wav");
        // Firefox's fake microphone plays a tone; only Chrome's takes a file.
        if (BROWSER !== "chromium") skip("--speech needs Chrome");
        const voiceBrowser = await launch([`--use-file-for-fake-audio-capture=${path.resolve(args.speech)}%noloop`]);
        try {
            const page = await run.newPage(voiceBrowser);
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

    // With automatic activity detection the server waits for quiet audio to end
    // the turn; Mic off mid-sentence must tell it the audio stopped
    // (audio_stream_end), or the words before it get no answer.
    async "Mic off mid-sentence over WebSocket still gets an answer"(browser, run) {
        if (MOCK) skip("the mock ignores audio");
        if (!args.speech) skip("pass --speech=file.wav");
        if (BROWSER !== "chromium") skip("--speech needs Chrome");
        const voiceBrowser = await launch([`--use-file-for-fake-audio-capture=${path.resolve(args.speech)}%noloop`]);
        try {
            const page = await run.newPage(voiceBrowser);
            await connect(page, { transport: "websocket", modality: "AUDIO" });
            await waitConnected(page);
            await page.click("#micOffBtn md-filled-icon-button");
            await page.waitForTimeout(4000);
            await page.click("#micBtn md-filled-icon-button");
            await page.waitForTimeout(15000);
            const lines = await chat(page);
            check(lines.some((l) => l.kind.includes("chat-user")), "no input transcript");
            check(lines.some((l) => l.kind.includes("chat-model")), "no model reply");
        } finally {
            await voiceBrowser.close();
        }
    },
};

(async () => {
    const browser = await launch();
    console.log(`${BROWSER} ${browser.version()}`);
    const counts = { PASS: 0, "PASS*": 0, SKIP: 0, FAIL: 0 };
    for (const [name, scenario] of Object.entries(scenarios)) {
        const started = Date.now();
        const run = new Run();
        let line;
        try {
            await scenario(browser, run);
            const ms = ` (${Date.now() - started} ms)`;
            line = run.notes.length ? ["PASS*", `${ms}; not checked: ${run.notes.join("; ")}`] : ["PASS", ms];
        } catch (error) {
            line = [error instanceof Skip ? "SKIP" : "FAIL", `: ${error.message}`];
        } finally {
            await run.close();
        }
        counts[line[0]]++;
        console.log(`${line[0].padEnd(5)} ${name}${line[1]}`);
    }
    await browser.close();
    console.log(
        `${counts.PASS + counts["PASS*"]} passed (${counts["PASS*"]} partly), ` +
            `${counts.SKIP} skipped, ${counts.FAIL} failed`
    );
    process.exit(counts.FAIL ? 1 : 0);
})();
