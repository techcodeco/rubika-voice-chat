'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceClient } = require('../src/core/voice-client');

class FakeAudioSource {
  onData() {}
  createTrack() { return { readyState: 'live', stop() {} }; }
}

const fakeEncryption = {
  changeAuthType(auth) { return auth; },
  fromCredentials() {
    return {
      encrypt() { return 'encrypted'; },
      decrypt() { return '{}'; },
      makeSignFromData() { return 'signature'; },
    };
  },
};

const fakeWrtc = {
  RTCAudioSource: FakeAudioSource,
  RTCAudioSink: class {},
  RTCPeerConnection: class {},
};

test('VoiceClient publishes typed, generic, and compatibility lifecycle events', async () => {
  const client = new VoiceClient('test-auth', 'test-private-key', {
    Encryption: fakeEncryption,
    wrtc: fakeWrtc,
    selfObjectGuid: 'self-guid',
  });
  const received = [];
  const generic = [];
  for (const name of ['connection-reconnected', 'voice-chat-joined', 'track-changed', 'playback-speed-changed']) {
    client.on(name, data => received.push({ name, data }));
  }
  client.on('client-event', event => generic.push(event));

  try {
    client._session.emit('disconnected', 'failed');
    client._session.emit('connected');
    client._session.emit('joined', { chatGuid: 'group-guid', voiceChatId: 'voice-id' });
    client._player.emit('track-changed', { from: 'a.mp3', to: 'b.mp3', reason: 'next' });
    await client.setPlaybackSpeed(1.5);

    assert.deepEqual(received.map(item => item.name), [
      'connection-reconnected',
      'voice-chat-joined',
      'track-changed',
      'playback-speed-changed',
    ]);
    assert.ok(generic.some(event => event.event === 'connection:disconnected'));
    assert.ok(generic.some(event => event.event === 'connection:reconnected'));
    assert.ok(generic.some(event => event.event === 'voice-chat:joined'));
    assert.ok(generic.some(event => event.event === 'track:changed'));
    assert.ok(generic.some(event => event.event === 'playback:speed-changed'));
    assert.equal(client.getPlaybackStatus().speed, 1.5);
    assert.ok(received.every(item => typeof item.data.timestamp === 'string'));
  } finally {
    clearInterval(client._player._tickTimer);
    client._player.removeAllListeners();
  }
});
