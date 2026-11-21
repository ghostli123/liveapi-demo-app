// Declarations for the frontend type check (tsconfig.json); never served.

// Timer handles start as null in the frontend. Browsers treat a null handle
// as 0, which matches no timer, so clearing it is a no-op.
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
declare function cancelAnimationFrame(handle: number | null): void;

// Prefixed and newer constructors the frontend falls back to.
interface Window {
    // Safari before 14.1.
    webkitAudioContext?: typeof AudioContext;
    // Safari 17.1+; the only Media Source Extensions on iPhone.
    ManagedMediaSource?: typeof MediaSource;
}
