// @ts-check
/**
 * @class PCMProcessor
 * @extends AudioWorkletProcessor
 * @description Plays Float32 PCM chunks posted from the main thread, in order.
 * Posting the string "clear" drops everything not yet played, which is how
 * playback stops when the user interrupts the model.
 */
class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        /** @type {Float32Array[]} */
        this.queue = [];
        this.offset = 0; // Read position in this.queue[0].

        this.port.onmessage = (e) => {
            if (e.data === "clear") {
                this.queue = [];
                this.offset = 0;
                return;
            }
            this.queue.push(e.data);
        };
    }

    /**
     * @param {Float32Array[][]} inputs
     * @param {Float32Array[][]} outputs
     */
    process(inputs, outputs) {
        const channelData = outputs[0][0];
        let written = 0;
        while (written < channelData.length && this.queue.length > 0) {
            const chunk = this.queue[0];
            const count = Math.min(channelData.length - written, chunk.length - this.offset);
            channelData.set(chunk.subarray(this.offset, this.offset + count), written);
            written += count;
            this.offset += count;
            if (this.offset >= chunk.length) {
                this.queue.shift();
                this.offset = 0;
            }
        }
        // Samples past `written` stay zero, i.e. silence on underrun.
        return true;
    }
}

registerProcessor("pcm-processor", PCMProcessor);
