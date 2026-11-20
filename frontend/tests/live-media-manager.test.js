const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./load-script");

const { G3RtcWebRtcManager } = loadScript("live-media-manager.js", ["G3RtcWebRtcManager"]);

test("fixAnswerSdp gives candidates with an empty foundation one", () => {
    const sdp = [
        "a=ice-lite",
        "a=candidate: 1 udp 2113932031 74.125.247.233 19305 typ host generation 0",
        "a=candidate:7 1 udp 2113932031 74.125.247.233 19306 typ host generation 0",
        "",
    ].join("\r\n");
    assert.equal(
        G3RtcWebRtcManager.fixAnswerSdp(sdp),
        [
            "a=ice-lite",
            "a=candidate:0 1 udp 2113932031 74.125.247.233 19305 typ host generation 0",
            "a=candidate:7 1 udp 2113932031 74.125.247.233 19306 typ host generation 0",
            "",
        ].join("\r\n")
    );
});

test("applyG3rtcAttributesToSdp tags each grouped m-section", () => {
    const sdp = ["m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1"].join("\r\n");
    const out = G3RtcWebRtcManager.applyG3rtcAttributesToSdp(sdp, new Map([["0", "g1"]]));
    assert.equal(
        out,
        ["m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "a=g3rtc-attrs group-id:g1", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1"].join("\r\n")
    );
});
