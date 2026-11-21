// Declarations for the frontend type check (tsconfig.json); never served.

// Timer handles start as null in the frontend. Browsers treat a null handle
// as 0, which matches no timer, so clearing it is a no-op.
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
