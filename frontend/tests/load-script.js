// Loads a frontend script (written for the browser, not as a module) into a
// fresh VM context and returns the named top-level bindings.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const quietConsole = { log() {}, warn() {}, error() {}, debug() {} };

function loadScript(file, exportNames, globals = {}) {
    const context = vm.createContext({
        console: quietConsole,
        crypto: globalThis.crypto,
        performance: globalThis.performance,
        URL,
        Blob,
        ...globals,
    });
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    // Top-level classes aren't properties of the global object, so copy them.
    const exportsLine = exportNames.map((name) => `globalThis.${name} = ${name};`).join("");
    vm.runInContext(`${source}\n;${exportsLine}`, context, { filename: file });
    return context;
}

module.exports = { loadScript };
