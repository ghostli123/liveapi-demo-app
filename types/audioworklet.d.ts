// AudioWorkletGlobalScope, for the worklet type check (tsconfig.worklet.json);
// never served. TypeScript ships no lib for it, and the worklets must not see
// the DOM, so this declares only what that scope provides.
// https://webaudio.github.io/web-audio-api/#AudioWorkletGlobalScope

interface AudioWorkletMessageEvent {
    readonly data: any;
}

// The processor's end of the MessageChannel to its AudioWorkletNode.
interface AudioWorkletMessagePort {
    onmessage: ((event: AudioWorkletMessageEvent) => void) | null;
    postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

declare abstract class AudioWorkletProcessor {
    readonly port: AudioWorkletMessagePort;
    // inputs[input][channel] and outputs[output][channel] hold one render
    // quantum (128 frames). Return true to keep the processor alive.
    abstract process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean;
}

declare function registerProcessor(
    name: string,
    processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;

// The Console namespace is exposed in every global scope, worklets included.
declare const console: {
    log(...data: unknown[]): void;
    warn(...data: unknown[]): void;
    error(...data: unknown[]): void;
};

declare const currentFrame: number;
declare const currentTime: number;
declare const sampleRate: number;
