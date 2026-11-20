'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceSession, preferOpus } = require('../src/webrtc/voice-session');

class FakeAudioTrack {
  constructor() { this.kind = 'audio'; this.readyState = 'live'; this.id = 'local-audio'; }
  stop() { this.readyState = 'ended'; }
}
class FakeAudioSource {
  createTrack() { return new FakeAudioTrack(); }
  onData() {}
}
class FakePeerConnection {
  constructor() {
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
  }
  addTrack() {}
  async createOffer() {
    return {
      type: 'offer',
      sdp: [
        'v=0',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111 0 8',
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:111 opus/48000/2',
        'a=rtpmap:8 PCMA/8000',
        '',
      ].join('\r\n'),
    };
  }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.iceConnectionState = 'connected';
    this.connectionState = 'connected';
    this.oniceconnectionstatechange?.();
  }
  close() { this.iceConnectionState = 'closed'; this.connectionState = 'closed'; }
}
class FakeAudioSink {
  constructor(track) { this.track = track; this.ondata = null; }
  stop() {}
}

const fakeWrtc = {
  RTCPeerConnection: FakePeerConnection,
  RTCAudioSource: FakeAudioSource,
  RTCAudioSink: FakeAudioSink,
};

function makeVoiceApi(canSelfUnmute = true) {
  const calls = [];
  return {
    calls,
    async joinGroupVoiceChat(args) {
      calls.push(['joinGroupVoiceChat', args]);
      return {
        sdp_answer_data: 'v=0\r\ns=AudioBridge 33420033\r\nt=0 0\r\n',
        raw: {
          data: {
            group_voice_chat_participate_update: {
              group_voice_chat_participant: { can_self_unmute: canSelfUnmute },
            },
          },
        },
      };
    },
    async setState(args) { calls.push(['setState', args]); return { status: 'OK' }; },
    async requestSpeak(args) { calls.push(['requestSpeak', args]); return { status: 'OK' }; },
    async sendActivity(args) { calls.push(['sendActivity', args]); return { status: 'OK' }; },
    async leave(args) { calls.push(['leave', args]); return { status: 'OK' }; },
  };
}

test('preferOpus puts Opus first in audio payload list', () => {
  const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0 111 8\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:8 PCMA/8000\r\n';
  const preferred = preferOpus(offer);
  assert.match(preferred, /m=audio 9 UDP\/TLS\/RTP\/SAVPF 111 0 8/);
});

test('VoiceSession mirrors Rubika join -> SDP answer -> unmute flow', async () => {
  const api = makeVoiceApi(true);
  const session = new VoiceSession({ voiceApi: api, wrtc: fakeWrtc, iceTimeoutMs: 1000, autoUnmute: true });
  await session.connect({ chatGuid: 'group', voiceChatId: 'voice', selfObjectGuid: 'self' });
  assert.equal(session.joined, true);
  assert.equal(session.muted, false);
  assert.equal(api.calls[0][0], 'joinGroupVoiceChat');
  assert.equal(api.calls[0][1].chatGuid, 'group');
  assert.equal(api.calls[0][1].voiceChatId, 'voice');
  assert.match(api.calls[0][1].sdpOffer, /m=audio/);
  assert.equal(api.calls[1][0], 'setState');
  assert.equal(api.calls[1][1].action, 'Unmute');
  await session.leave();
  assert.equal(api.calls.at(-1)[0], 'leave');
});

test('VoiceSession requests to speak when the server disallows self-unmute', async () => {
  const api = makeVoiceApi(false);
  const session = new VoiceSession({ voiceApi: api, wrtc: fakeWrtc, iceTimeoutMs: 1000, autoUnmute: true });
  await session.connect({ chatGuid: 'group', voiceChatId: 'voice', selfObjectGuid: 'self' });
  assert.equal(session.muted, true);
  assert.equal(api.calls.at(-1)[0], 'requestSpeak');
  await session.leave();
});
