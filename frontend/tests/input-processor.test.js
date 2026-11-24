const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

let registered = null;
loadScript("input-processor.js", [], {
    AudioWorkletProcessor: class {
        constructor() {
            this.posted = [];
            this.port = { postMessage: (message) => this.posted.push(message) };
        }
    },
    registerProcessor: (name, cls) => {
        registered = { name, cls };
    },
});

test("converts each quantum to 16-bit PCM, clamping out-of-range samples", () => {
    assert.equal(registered.name, "input-processor");
    const processor = new registered.cls();
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    assert.equal(processor.process([[samples]], [], {}), true);
    assert.equal(processor.posted.length, 1);
    const pcm = processor.posted[0];
    // instanceof Int16Array would compare against the VM context's own class.
    assert.equal(Object.prototype.toString.call(pcm), "[object Int16Array]");
    assert.deepEqual(Array.from(pcm), [0, 16383, -16384, 32767, -32768, 32767, -32768]);
});

test("posts nothing and stays alive while the input has no channels", () => {
    const processor = new registered.cls();
    // An unconnected input arrives as an empty channel list; guard empty or missing inputs too.
    assert.equal(processor.process([[]], [], {}), true);
    assert.equal(processor.process([], [], {}), true);
    assert.equal(processor.process(null, [], {}), true);
    assert.equal(processor.process([[new Float32Array(0)]], [], {}), true);
    assert.deepEqual(processor.posted, []);
});
