# Gemini Live API over WebRTC: protocol reference

## Session flow

1. The client creates an `RTCPeerConnection`, adds all of its transceivers,
   creates an offer, and waits for ICE gathering.
2. The client opens the `BidiGenerateContent` WebSocket and sends `setup` with
   `rtc_setup.offer_sdp`.
3. The server replies with `setupComplete`, which carries `sessionId` and
   `rtcSetupComplete.answerSdp`. The client applies the answer with
   `setRemoteDescription()`.
4. Audio and video flow over the peer connection. Everything else flows over
   the WebSocket.
5. The two connections form one session. When either one closes or fails,
   close the other.

## `setup` fields

Only `rtc_setup` is new. All other `setup` fields work as in a WebSocket-media
session.

```json
{
  "setup": {
    "model": "projects/PROJECT_ID/locations/us/publishers/google/models/gemini-3.8-live",
    "generation_config": { "response_modalities": ["AUDIO"] },
    "system_instruction": { "parts": [{ "text": "..." }] },
    "tools": [{ "function_declarations": [] }],
    "input_audio_transcription": {},
    "output_audio_transcription": {},
    "session_resumption": {},
    "rtc_setup": { "offer_sdp": "v=0\r\no=- ..." }
  }
}
```

The response:

```json
{
  "setupComplete": {
    "sessionId": "...",
    "rtcSetupComplete": { "answerSdp": "v=0\r\n..." }
  }
}
```

## Media

| | Client to model | Model to client |
| :---- | :---- | :---- |
| Audio | Opus, 48 kHz, one `sendonly` audio transceiver | Opus, 48 kHz, one `recvonly` audio transceiver |
| Video | VP8 (VP9, AV1 accepted; not H.264), one `sendonly` video transceiver | VP8 avatar video, 704 × 1280, about 24 fps, one `recvonly` video transceiver |

Only add the transceivers you need. A voice-only client needs the two audio
transceivers.

The model's audio and video tracks don't share a media stream ID, so build one
`MediaStream` from both receiver tracks and play it in a single `<video>`
element.

## Avatar video

Set the response modality to video and choose an avatar in `setup`:

```javascript
generation_config: { response_modalities: ["VIDEO"] },
avatar_config: { avatar_name: "Piper" },
```

Add a `recvonly` video transceiver in step 1, before `setLocalDescription()`:

```javascript
const modelVideo = pc.addTransceiver("video", { direction: "recvonly" });
```

When the answer arrives, play voice and video together:

```javascript
// <video id="avatar" autoplay playsinline></video>
avatar.srcObject = new MediaStream(
  [modelAudio.receiver.track, modelVideo.receiver.track]);
await avatar.play();
```

## Camera and screen input

Add a `sendonly` video transceiver in step 1 and keep its sender:

```javascript
const camera = await navigator.mediaDevices.getUserMedia({ video: true });
const cameraSender = pc.addTransceiver(camera.getVideoTracks()[0],
  { direction: "sendonly" }).sender;
```

Switch to screen sharing at any time without renegotiation:

```javascript
const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
await cameraSender.replaceTrack(screen.getVideoTracks()[0]);
```

To start with screen sharing and no camera, pass the screen track to
`addTransceiver()` instead.

## Text input and tools

These are unchanged and use the WebSocket:

```javascript
ws.send(JSON.stringify({
  client_content: {
    turns: [{ role: "user", parts: [{ text: "Hello" }] }],
    turn_complete: true,
  },
}));

// On msg.toolCall:
ws.send(JSON.stringify({
  tool_response: {
    function_responses: msg.toolCall.functionCalls.map((call) => ({
      id: call.id, name: call.name, response: { result: "..." },
    })),
  },
}));
```

## Session resumption

1. Send `session_resumption: {}` in the first `setup` to receive handles.
2. Keep the latest `sessionResumptionUpdate.newHandle` when `resumable` is true.
3. On `goAway` or a disconnect, close the WebSocket and the peer connection.
4. Create a new peer connection and offer (step 1), open a new WebSocket, and
   send `setup` with `session_resumption: { handle }` and the new `rtc_setup`.

The conversation context carries over. The new session gets a new `sessionId`.
Local microphone and camera tracks can be reused on the new peer connection.

## Migrating from WebSocket media

| Area | Before (WebSocket media) | After (WebRTC) |
| :---- | :---- | :---- |
| Microphone, camera, screen | Base64 chunks in `realtime_input` | Tracks on the peer connection |
| Model voice, avatar video | `inlineData` parts in `serverContent` | Remote tracks played by a media element |
| Interruptions | Clear the playback queue on `interrupted` | Nothing to clear; the server stops sending audio |
| Setup, text, tools, transcripts, turn events | WebSocket | WebSocket (unchanged) |

Remove: microphone capture through `AudioWorklet` or `ScriptProcessor`,
resampling to 16 kHz, base64 encoding, `realtime_input` media messages,
decoding of `inlineData` audio, and the playback queue. Keep: `setup`,
`client_content`, tool handling, transcript display, and turn handling.

## Non-browser clients

Any standards-compliant WebRTC stack works, such as libwebrtc on mobile. The
same rules apply: add all transceivers before the offer, wait for ICE
gathering, send the SDP unchanged, and close both connections together. The
browser is the validated client.
