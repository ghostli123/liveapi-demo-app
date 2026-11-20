---
name: gemini-live-webrtc
description: Adds WebRTC audio and video transport to a Gemini Live API client on Vertex AI (the BidiGenerateContent WebSocket), or builds a new browser voice or avatar app on it. Use when the user wants to use WebRTC with the Gemini Live API, migrate a Live API app from WebSocket media (base64 PCM in realtime_input) to WebRTC, add avatar video, camera, or screen sharing over WebRTC, or debug a Live API WebRTC session (rtc_setup, rtcSetupComplete, SDP offer and answer, ICE or connection failures). Preview feature for allowlisted projects, gemini-3.8-live in the us and eu locations.
---

# Gemini Live API over WebRTC (Preview)

In a WebRTC session the client keeps the usual Live API WebSocket for setup and
control, and moves audio and video to a WebRTC peer connection. The SDP offer
goes in the `setup` message and the answer comes back in `setupComplete`, so no
separate signaling server is needed.

This is a Pre-GA feature, available only to allowlisted projects under the
[Pre-GA Offerings Terms](https://cloud.google.com/terms/service-terms#1). Don't
use it with confidential data or for production traffic.

## Facts to use as given

Don't guess or "correct" these values:

- **Endpoint:** `wss://aiplatform.LOCATION.rep.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`, where `LOCATION` is `us` or `eu`. Other locations and the global endpoint don't support WebRTC.
- **Model:** `projects/PROJECT_ID/locations/LOCATION/publishers/google/models/gemini-3.8-live`, with the same `LOCATION` as the endpoint.
- **Authentication:** an OAuth access token with the Vertex AI User role. Browsers can't set WebSocket headers, so either proxy the WebSocket through a backend that adds `Authorization: Bearer TOKEN` (recommended; see `examples/ws_proxy.py`) or append a short-lived `?access_token=TOKEN`. Never put a service account key or long-lived credential in browser code.
- **SDKs:** the Gen AI SDKs don't support WebRTC. Use a raw `WebSocket` and `RTCPeerConnection`; don't look for an SDK option.
- **Network:** media uses outbound UDP 19305, with TCP 19305 as a fallback. A public STUN server is enough; no TURN server is needed.
- **Codecs:** Opus audio at 48 kHz in both directions. Client video in VP8 (VP9 and AV1 also accepted, not H.264). Avatar video comes back as VP8, 704 × 1280 portrait, about 24 fps.

## Integration steps

Serve the page from `https://` or `http://localhost` (for example,
`python3 -m http.server`), because browsers block the microphone on other
origins. Start the session from a user gesture (a click handler), or the browser
blocks playback.

1. **Create the peer connection and the offer.** Add every transceiver before
   creating the offer, then wait for ICE gathering so the offer carries all
   candidates:

   ```javascript
   const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
   const pc = new RTCPeerConnection({
     iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
   });
   pc.addTransceiver(mic.getAudioTracks()[0], { direction: "sendonly" });
   const modelAudio = pc.addTransceiver("audio", { direction: "recvonly" });
   await pc.setLocalDescription();
   if (pc.iceGatheringState !== "complete") {
     await new Promise((resolve) => {
       pc.onicegatheringstatechange = () =>
         pc.iceGatheringState === "complete" && resolve();
       setTimeout(resolve, 2000);
     });
   }
   ```

2. **Send the offer in `setup` and apply the answer.** Add `rtc_setup` to the
   normal `setup` message. Server frames are binary, so read them as text first:

   ```javascript
   ws.onopen = () => ws.send(JSON.stringify({
     setup: {
       model: `projects/${PROJECT_ID}/locations/${LOCATION}/` +
         "publishers/google/models/gemini-3.8-live",
       generation_config: { response_modalities: ["AUDIO"] },
       rtc_setup: { offer_sdp: pc.localDescription.sdp },
     },
   }));
   ws.onmessage = async (event) => {
     const text = typeof event.data === "string"
       ? event.data : await event.data.text();
     const msg = JSON.parse(text);
     if (msg.setupComplete) {
       const answer = msg.setupComplete.rtcSetupComplete.answerSdp;
       await pc.setRemoteDescription({ type: "answer", sdp: answer });
       player.srcObject = new MediaStream([modelAudio.receiver.track]);
       await player.play();
     }
     // Transcripts, tool calls, and turn events arrive here as usual.
   };
   ```

3. **Close both connections together.** They form one session:

   ```javascript
   ws.onclose = () => pc.close();
   pc.onconnectionstatechange = () =>
     pc.connectionState === "failed" && ws.close();
   ```

For avatar video, camera or screen input, tools, text input, and session
resumption, read `references/protocol.md`. Complete, working pages are in
`examples/`.

## Rules

- Send no media on the WebSocket: no `realtime_input` audio or video chunks.
  The server sends no `inlineData` audio or video either, so don't wait for it.
- Everything else stays on the WebSocket, unchanged: `client_content`,
  `tool_response`, transcripts, `toolCall`, `turnComplete`, `interrupted`,
  `goAway`, `sessionResumptionUpdate`, `usageMetadata`.
- All other `setup` fields work as usual. For transcripts, add
  `input_audio_transcription: {}` and `output_audio_transcription: {}`. They
  arrive in small chunks in `serverContent.inputTranscription.text` and
  `serverContent.outputTranscription.text`; append each chunk to the current
  speaker's line.
- When migrating, delete the PCM capture, resampling, base64 encoding, and
  playback queue code. On `interrupted` there's nothing to clear; the server
  stops sending audio. Request the microphone before sending `setup`, because
  its track must be in the offer, so the permission prompt now appears when the
  user clicks Start.
- If a backend proxy chooses the endpoint, its location must match the location
  in the model name that the page sends.
- Don't add transceivers, create a new offer, or renegotiate after `setup`. To
  switch from camera to screen, call `replaceTrack()` on the existing sender.
- Send `pc.localDescription.sdp` exactly as the browser produced it. Don't edit
  the SDP or change its `\r\n` line endings.
- A peer connection can't be reused. To resume or reconnect, close both
  connections and repeat steps 1 to 3 with a new peer connection and offer.
- Write client message fields in snake_case as shown; server messages use
  camelCase (`setupComplete`, `rtcSetupComplete`, `answerSdp`).

## Troubleshooting

| Symptom | Cause and fix |
| :---- | :---- |
| Close code 1007, `Unknown name "rtc_setup"` | The project isn't allowlisted for WebRTC. Stop and tell the user to ask their Google account team; don't rename or remove `rtc_setup`. |
| Close code 1007, `rtc_setup.offer_sdp is required.` | `setup` was sent before `setLocalDescription()` finished, or with an empty SDP. |
| Close code 1008, `Publisher model ... was not found` | Use `gemini-3.8-live` with the `us` or `eu` endpoint, and the same location in the model name. |
| Close code 1011 right after `setup` | The offer couldn't be parsed. Send `pc.localDescription.sdp` unchanged. |
| `connectionState` becomes `failed` | Outbound UDP and TCP port 19305 are blocked. Allow them, or fall back to WebSocket media. |
| Connected but silent | Playback wasn't started from a user gesture, or the remote track isn't attached to a playing media element. |
| Close code 1008, `Request had invalid authentication credentials` or `Request is missing required authentication credential` | The access token is missing, invalid, or expired (tokens last about an hour). Mint a fresh one for an account with the Vertex AI User role. |

When asking for support, include the `sessionId` from `setupComplete`.

## Verify the integration

A working session shows all of the following:

1. `setupComplete` arrives with a `sessionId` and `rtcSetupComplete.answerSdp`.
2. `pc.connectionState` reaches `connected` within a few seconds.
3. Inbound audio bytes grow while the model speaks:

   ```javascript
   const stats = await pc.getStats();
   stats.forEach((s) => s.type === "inbound-rtp" && s.kind === "audio" &&
     console.log("inbound audio bytes", s.bytesReceived));
   ```

4. Speaking into the microphone produces a model reply, and `turnComplete`
   (plus transcripts, if enabled) arrives on the WebSocket.

## Examples

- `examples/voice-quickstart.html`: minimal voice client with transcripts.
- `examples/avatar-camera-tools.html`: avatar video, camera, a tool call, text
  input, and session resumption.
- `examples/ws_proxy.py`: backend proxy that adds the `Authorization` header
  using Application Default Credentials.
