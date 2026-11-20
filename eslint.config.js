// ESLint flat config. Only correctness rules (eslint:recommended); formatting
// is left to Prettier (.prettierrc).
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    { ignores: [".venv/", "backend/", "feature/"] },
    js.configs.recommended,
    {
        // The frontend files are classic browser scripts that share one global
        // scope (see index.html), not ES modules.
        files: ["frontend/*.js"],
        languageOptions: {
            sourceType: "script",
            globals: { ...globals.browser },
        },
    },
    {
        files: ["frontend/input-processor.js", "frontend/pcm-processor.js"],
        languageOptions: {
            globals: { ...globals.audioWorklet },
        },
    },
    {
        files: ["frontend/tests/*.js", "scripts/*.js", "eslint.config.js"],
        languageOptions: {
            sourceType: "commonjs",
            globals: { ...globals.node },
        },
    },
];
