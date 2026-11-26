const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

let registered = null;
loadScript("pcm-processor.js", [], {
    // The processor checks `instanceof Float32Array`; use this realm's
    // class so the arrays the tests post pass it, as cloned ones do.
    Float32Array,
    AudioWorkletProcessor: class {
        constructor() {
            this.port = {};
        }
    },
    registerProcessor: (name, cls) => {
        registered = { name, cls };
    },
});

function render(processor, frames = 4) {
    const out = new Float32Array(frames);
    processor.process([], [[out]], {});
    return Array.from(out);
}

test("plays queued chunks in order across render quanta", () => {
    assert.equal(registered.name, "pcm-processor");
    const processor = new registered.cls();
    processor.port.onmessage({ data: new Float32Array([1, 2, 3]) });
    processor.port.onmessage({ data: new Float32Array([4, 5, 6]) });
    assert.deepEqual(render(processor), [1, 2, 3, 4]);
    // Plays what's left, then silence.
    assert.deepEqual(render(processor), [5, 6, 0, 0]);
});

test("clear drops audio that hasn't played", () => {
    const processor = new registered.cls();
    processor.port.onmessage({ data: new Float32Array([1, 2, 3, 4, 5, 6]) });
    assert.deepEqual(render(processor), [1, 2, 3, 4]);
    processor.port.onmessage({ data: "clear" });
    assert.deepEqual(render(processor), [0, 0, 0, 0]);
    processor.port.onmessage({ data: new Float32Array([7]) });
    assert.deepEqual(render(processor), [7, 0, 0, 0]);
});

test("ignores messages that aren't non-empty Float32Arrays", () => {
    const processor = new registered.cls();
    processor.port.onmessage({ data: new Float32Array([1, 2]) });
    for (const data of [{ length: 3 }, "noise", null, undefined, 42, new Int16Array([5, 6]), new Float32Array(0)]) {
        processor.port.onmessage({ data });
    }
    processor.port.onmessage({ data: new Float32Array([3, 4, 5]) });
    // Neither wedged (silence forever) nor threw: the PCM around them plays.
    assert.deepEqual(render(processor), [1, 2, 3, 4]);
    assert.deepEqual(render(processor), [5, 0, 0, 0]);
    assert.equal(processor.queue.length, 0);
});

test("process() ignores missing or empty output channels without dropping queued audio", () => {
    const processor = new registered.cls();
    processor.port.onmessage({ data: new Float32Array([1, 2, 3]) });
    for (const outputs of [undefined, null, [], [[]], [[undefined]], [[new Float32Array(0)]]]) {
        assert.equal(processor.process([], outputs, {}), true);
    }
    assert.deepEqual(render(processor), [1, 2, 3, 0]);
});
