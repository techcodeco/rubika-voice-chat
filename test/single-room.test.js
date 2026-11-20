'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceClient } = require('../src/core/voice-client');

class FakeAudioTrack {
  constructor() { this.kind = 'audio'; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
}
class FakeAudioSource {
  createTrack() { return new FakeAudioTrack(); }
  onData() {}
}
const fakeWrtc = {
  RTCAudioSource: FakeAudioSource,
  RTCAudioSink: class { stop() {} },
  RTCPeerConnection: class {},
};
const fakeEncryption = {
  changeAuthType(value) { return value; },
  fromCredentials() { return { encrypt() { return ''; }, decrypt() { return '{}'; }, makeSignFromData() { return ''; } }; },
};

test('VoiceClient manages one active Voice Chat and leaves it without caller-supplied IDs', async () => {
  const client = new VoiceClient('auth', 'private-key', {
    Encryption: fakeEncryption,
    wrtc: fakeWrtc,
    selfObjectGuid: 'self-guid',
    logging: false,
  });
  const room = client._defaultContext;
  room.groupGuid = 'group-1';
  room.voiceChatId = 'voice-1';
  room.key = client._roomKey(room.groupGuid, room.voiceChatId);
  room.session.joined = true;
  room.session.chatGuid = room.groupGuid;
  room.session.voiceChatId = room.voiceChatId;
  client._defaultContext = null;
  client._rooms.set(room.key, room);
  client._activateRoom(room);

  const leaveCalls = [];
  client._voiceApi.leave = async input => {
    leaveCalls.push(input);
    return { status: 'OK' };
  };

  // The same connection is idempotent; a different group is rejected.
  assert.deepEqual(await client.joinVoiceChat('group-1'), {
    groupGuid: 'group-1', voiceChatId: 'voice-1', alreadyJoined: true,
  });
  await assert.rejects(client.joinVoiceChat('group-2'), /one active Voice Chat at a time/);

  // Recording requires no group or voiceChat ID; includeSelf defaults to false.
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const output = path.join(os.tmpdir(), `single-room-${process.pid}.ogg`);
  await client.startRecording({ output, consentConfirmed: true });
  assert.equal(room.recorder.includeSelf, false);
  assert.throws(() => client.setRecordingFilter({ excludeParticipants: ['u0blocked'] }), /Only includeSelf is supported/);
  assert.deepEqual(client.setRecordingFilter({ includeSelf: true }), { includeSelf: true });
  assert.deepEqual(client.setRecordingFilter({ includeSelf: false }), { includeSelf: false });
  await client.stopRecording();
  assert.equal(client.getRecordingFiles().length, 1);

  assert.equal(typeof client.startParticipantRecording, 'undefined');
  assert.equal(typeof client.getRemoteTracks, 'undefined');
  assert.equal(typeof client.mapAudioTrack, 'undefined');
  assert.equal(typeof client.getRooms, 'undefined');
  await assert.rejects(
    client.startRecording({ output: path.join(os.tmpdir(), 'old-filter.ogg'), excludeParticipants: ['u0blocked'], consentConfirmed: true }),
    /Unsupported recording option.*excludeParticipants/
  );

  // The SDK resolves and sends its internally stored ID pair to Rubika.
  await client.leaveVoiceChat();
  assert.deepEqual(leaveCalls[0], { chatGuid: 'group-1', voiceChatId: 'voice-1' });
  assert.equal(client.getStatus().connected, false);
  await fs.rm(output, { force: true });
  await fs.rm(`${output}.json`, { force: true });
  await client.close();
});
