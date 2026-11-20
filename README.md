# Rubika Voice

A focused Node.js client for joining Rubika Voice Chats, managing participants, playing audio, and recording the entire incoming voice chat into one OGG/MP3 file using WebRTC.

[**Full Documentation**](https://techcodeco.github.io/rubika-voice-chat/) · [**GitHub Repository**](https://github.com/techcodeco/rubika-voice-chat) · [**npm Package**](https://www.npmjs.com/package/rubika-voice-chat)

[![npm version](https://img.shields.io/npm/v/rubika-voice-chat?logo=npm)](https://www.npmjs.com/package/rubika-voice-chat)
[![npm downloads](https://img.shields.io/npm/dm/rubika-voice-chat?logo=npm)](https://www.npmjs.com/package/rubika-voice-chat)
[![GitHub stars](https://img.shields.io/github/stars/techcodeco/rubika-voice-chat?style=social)](https://github.com/techcodeco/rubika-voice-chat)
[![GitHub issues](https://img.shields.io/github/issues/techcodeco/rubika-voice-chat)](https://github.com/techcodeco/rubika-voice-chat/issues)

**Documentation:** [فارسی](README_FA.md) | English

**Created and maintained by:** [Mohammad Afrouzeh (TechCode)](https://github.com/techcodeco)

---

**Version: 1.5.3**

## 1.5.2 authentication fix

- Read method-specific login states such as `SendPassKey` and `InvalidPassKey` from `data.status` without confusing them with the outer `OK` status.
- Do not require `phone_code_hash` until the two-step verification flow has succeeded.
- Correctly handle `CodeIsInvalid` and `CodeIsUsed` when they are nested in `data.status`.

## Authentication and session lifecycle

On the first run of `new VoiceClient('my-session')`, the CLI requests a phone number and login code when the named session does not exist. If Rubika returns `SendPassKey`, the `data.hint_pass_key` value is shown in parentheses beside the password prompt; the entered password is sent unchanged as `pass_key` in the next `sendCode` request. `InvalidPassKey` prompts for the password again. Method-specific states such as `SendPassKey`, `InvalidPassKey`, `CodeIsInvalid`, and `CodeIsUsed` are read from `data.status`; `phone_code_hash` is required only after the two-step verification succeeds.

If `signIn` returns `CodeIsInvalid`, the CLI requests another login code. If it returns `CodeIsUsed`, the client requests a fresh code with `sendCode` before asking for the new code.

`registerDevice` runs only after a new session has been created. Reusing a saved session never registers the device again, including when `RUBIKA_APP_VERSION` changes. If a session is invalidated with `NOT_REGISTERED` and a new session is created, device registration runs for that new session.

When `selfObjectGuid` is not configured, the client calls `getUserInfo` with `{ user_guid: undefined }` and reads the current user's GUID from `data.user.user_guid`.

## Install

```bash
npm install rubika-voice-chat
```

Requires Node.js `>=22.5` and FFmpeg with `libopus` and `libmp3lame` encoders.

## Quick start

```js
const { VoiceClient } = require("rubika-voice-chat");

async function main() {
  const client = new VoiceClient("my-session", { logging: false });
  client.on("error", console.error);

  await client.start();
  await client.joinVoiceChat("GROUP_GUID");
  await client.play("./music.mp3");

  await client.startRecording({
    output: "./recordings/voice-chat.ogg",
    format: "ogg",
    includeSelf: false,
    consentConfirmed: true,
  });

  await client.stopRecording();
  await client.close();
}

main().catch(console.error);
```

## One active Voice Chat per client

```js
await client.joinVoiceChat("GROUP_GUID_1");
await client.play("./music-1.mp3");

await client.leaveVoiceChat();

await client.joinVoiceChat("GROUP_GUID_2");
await client.play("./music-2.mp3");
```

Trying to join a different group before leaving the current Voice Chat throws a clear error.

## Whole-chat recording

All incoming remote audio tracks are mixed into a single output file. No group or voice-chat ID is passed to recording methods.

Include the SDK Player audio in the same file:

```js
await client.startRecording({
  output: "./recordings/with-self.ogg",
  includeSelf: true,
  consentConfirmed: true,
});
```

Exclude it (the default):

```js
await client.startRecording({
  output: "./recordings/remote-only.ogg",
  includeSelf: false,
  consentConfirmed: true,
});
```

`self` means audio sent by this SDK's `AudioPlayer`; it does not capture the computer's physical microphone and does not create a separate `self` file.

Toggle while recording:

```js
client.setRecordingFilter({ includeSelf: true });
client.setRecordingFilter({ includeSelf: false });
await client.stopRecording();
```

`setRecordingFilter()` accepts only `{ includeSelf: boolean }` and only while recording is active. `startAllParticipantsRecording(options)` remains as an alias of `startRecording(options)` with the same defaults.

Removed recording options include `source`, `trackId`, `includeParticipants`, `excludeParticipants`, and `participantObjectGuids`. Removed public methods include `startParticipantRecording`, `getRemoteTracks`, `getTracksForParticipant`, and `mapAudioTrack`.

## Playback

Playback methods operate on the currently joined Voice Chat and do not take a group ID:

```js
await client.play("./music.mp3");
client.enqueue("./next.mp3");
client.pause();
client.resume();
await client.setSpeed(1.25);
client.setVolume(70);
```

## Graceful shutdown

Call `await client.close()` or handle SIGINT/SIGTERM so active recording can be finalized. SIGKILL, power loss, forced `process.exit()`, or a system crash cannot guarantee a finalized container. OGG/MP3 output may not be playable until graceful finalization completes.

If no audio frames were received, the empty placeholder is preserved with a `.json` diagnostic (`status: "no-audio"`) and the `recording:no-audio` event.

## Documentation

The full Persian HTML/CSS documentation is in `docs/`. It includes code highlighting, copy buttons, and a yellow active state for the sidebar item corresponding to the visible section. To publish with GitHub Pages, select `/docs` as the Pages folder.

## Privacy

Obtain clear consent from participants and follow applicable recording laws. `consentConfirmed: true` is a developer acknowledgement, not a substitute for actual consent.
