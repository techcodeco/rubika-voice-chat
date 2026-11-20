'use strict';

const { EventEmitter } = require('node:events');
const { loadWrtc } = require('./wrtc-loader');
const { waitForState } = require('../utils/async');
const { rms } = require('../utils/pcm');
const { findValue } = require('../rubika/voice-api');

function preferOpus(sdp) {
  const lines = String(sdp).split(/\r?\n/);
  const mIndex = lines.findIndex(line => line.startsWith('m=audio '));
  if (mIndex < 0) return sdp;
  const payloads = [];
  const other = [];
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+([^/]+)/i);
    if (match) {
      if (match[2].toLowerCase() === 'opus') payloads.push(match[1]);
      else other.push(match[1]);
    }
  }
  if (!payloads.length) return sdp;
  const parts = lines[mIndex].split(' ');
  const fixed = parts.slice(0, 3);
  const existing = parts.slice(3);
  const ordered = [...payloads, ...existing.filter(item => !payloads.includes(item))];
  lines[mIndex] = [...fixed, ...ordered].join(' ');
  return `${lines.filter((line, index) => index === lines.length - 1 || line !== '').join('\r\n')}`;
}


function participantGuidFromTrackEvent(event, track) {
  const direct = [event?.participantObjectGuid, event?.participant_object_guid, track?.participantObjectGuid, track?.participant_object_guid]
    .find(value => typeof value === 'string' && value.trim());
  if (direct) return direct;
  const streamIds = (event?.streams || []).map(stream => stream?.id).filter(Boolean);
  // Rubika user object GUIDs commonly use the u0 prefix. Only accept a full, GUID-like
  // stream/track id; arbitrary MediaStream ids are not treated as participant identities.
  const candidates = [...streamIds, track?.id].filter(Boolean);
  return candidates.find(value => /^(?:u0|b0|g0)[A-Za-z0-9_-]{5,}$/i.test(String(value))) || null;
}

class VoiceSession extends EventEmitter {
  constructor({ voiceApi, logger, iceTimeoutMs = 30000, autoUnmute = true, sendActivity = true, activityIntervalMs = 2000, wrtc }) {
    super();
    if (!voiceApi) throw new Error('VoiceApi is required.');
    this.voiceApi = voiceApi;
    this.logger = logger;
    this.iceTimeoutMs = iceTimeoutMs;
    this.autoUnmute = autoUnmute;
    this.sendActivityEnabled = sendActivity;
    this.activityIntervalMs = activityIntervalMs;
    this.wrtc = wrtc || loadWrtc();
    this.audioSource = null;
    this.audioTrack = null;
    this.ensureMediaSource();
    this.pc = null;
    this.sinks = new Map();
    this.connected = false;
    this.joined = false;
    this.muted = true;
    this.chatGuid = null;
    this.voiceChatId = null;
    this.selfObjectGuid = null;
    this._lastActivityAt = 0;
    this._sendActivityPromise = null;
  }

  ensureMediaSource() {
    if (!this.audioSource || !this.audioTrack || this.audioTrack.readyState === 'ended') {
      this.audioSource = new this.wrtc.RTCAudioSource();
      this.audioTrack = this.audioSource.createTrack();
    }
    return { audioSource: this.audioSource, audioTrack: this.audioTrack };
  }

  async connect({ chatGuid, voiceChatId, selfObjectGuid }) {
    this.ensureMediaSource();
    if (this.joined) throw new Error('Voice session is already connected.');
    if (!chatGuid || !voiceChatId || !selfObjectGuid) {
      throw new Error('chatGuid, voiceChatId and selfObjectGuid are all required.');
    }
    this.chatGuid = chatGuid;
    this.voiceChatId = voiceChatId;
    this.selfObjectGuid = selfObjectGuid;

    const pc = this.pc = new this.wrtc.RTCPeerConnection(null);
    pc.addTrack(this.audioTrack);

    pc.onicecandidate = event => {
      if (event.candidate) {
        this.logger?.debug('Local ICE candidate gathered (not sent separately; Rubika frontend uses the SDP exchange path).', {
          candidateType: event.candidate.type || 'unknown',
          protocol: event.candidate.protocol || 'unknown',
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.logger?.info('ICE state changed', { state });
      this.emit('ice-state', state);
      if (state === 'connected' || state === 'completed') {
        this.connected = true;
        this.emit('connected');
      }
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.connected = false;
        this.emit('disconnected', state);
      }
    };
    pc.onconnectionstatechange = () => {
      this.logger?.debug('Peer connection state changed', { state: pc.connectionState });
      this.emit('connection-state', pc.connectionState);
    };
    pc.ontrack = event => this._handleRemoteTrack(event);

    let joinResponseReceived = false;
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
        iceRestart: true,
      });
      await pc.setLocalDescription({ type: 'offer', sdp: offer.sdp });

      // The supplied Rubika frontend sends the SDP returned by createOffer after
      // setting the local description; it does not send trickled candidates in a
      // separate API call. We mirror that observed sequence here.
      const sdpOffer = preferOpus(offer.sdp);
      this.logger?.info('Sending WebRTC offer to Rubika Voice API', {
        chatGuid,
        voiceChatId,
        sdpBytes: Buffer.byteLength(sdpOffer),
      });

      const joinedResponse = await this.voiceApi.joinGroupVoiceChat({
        chatGuid,
        voiceChatId,
        sdpOffer,
        selfObjectGuid,
      });
      joinResponseReceived = true;
      await pc.setRemoteDescription({ type: 'answer', sdp: joinedResponse.sdp_answer_data });
      await waitForState(
        () => pc.iceConnectionState,
        ['connected', 'completed'],
        { timeoutMs: this.iceTimeoutMs, intervalMs: 100, label: 'WebRTC ICE connection' },
      );

      this.joined = true;
      this.emit('joined', { chatGuid, voiceChatId, response: joinedResponse });

      const participant = findValue(joinedResponse.raw, 'group_voice_chat_participant');
      if (this.autoUnmute) {
        if (participant && participant.can_self_unmute === false) {
          await this.voiceApi.requestSpeak({ chatGuid, voiceChatId, participantObjectGuid: selfObjectGuid });
          this.logger?.warn('The account cannot self-unmute; a speak request was sent. Wait for moderator approval.');
          this.muted = true;
          this.emit('speak-requested');
        } else {
          await this.unmute();
        }
      }
      return joinedResponse;
    } catch (error) {
      this.logger?.error('Voice session connection failed', { message: error.message });
      if (joinResponseReceived) {
        try { await this.voiceApi.leave({ chatGuid, voiceChatId }); }
        catch (leaveError) { this.logger?.warn('Could not clean up the failed voice-chat join', { message: leaveError.message }); }
      }
      this.joined = false;
      await this._closePeerConnection();
      throw error;
    }
  }

  _handleRemoteTrack(event) {
    const track = event.track;
    if (!track || track.kind !== 'audio') return;
    const id = track.id || `remote-${this.sinks.size + 1}`;
    if (this.sinks.has(id)) return;
    const sink = new this.wrtc.RTCAudioSink(track);
    const streamIds = (event.streams || []).map(stream => stream?.id).filter(Boolean);
    const participantObjectGuid = participantGuidFromTrackEvent(event, track);
    sink.ondata = data => {
      this.emit('remote-audio-frame', {
        trackId: id,
        participantObjectGuid: this.sinks.get(id)?.participantObjectGuid || participantObjectGuid || null,
        data,
        timestamp: Number(process.hrtime.bigint()) / 1e6,
      });
    };
    this.sinks.set(id, { sink, track, streamIds, participantObjectGuid });
    this.logger?.info('Remote audio track attached', { trackId: id, streamCount: event.streams?.length || 0 });
    this.emit('remote-track', { trackId: id, track, sink, streamIds, participantObjectGuid });
    track.onended = () => {
      const current = this.sinks.get(id);
      if (current) current.sink.stop();
      this.sinks.delete(id);
      this.emit('remote-track-ended', { trackId: id });
    };
  }

  async unmute() {
    if (!this.joined && !this.pc?.remoteDescription) throw new Error('Join the voice chat before unmuting.');
    await this.voiceApi.setState({
      chatGuid: this.chatGuid,
      voiceChatId: this.voiceChatId,
      action: 'Unmute',
      participantObjectGuid: this.selfObjectGuid,
    });
    this.muted = false;
    this.emit('muted', false);
    return true;
  }

  async mute() {
    if (!this.chatGuid) return false;
    await this.voiceApi.setState({
      chatGuid: this.chatGuid,
      voiceChatId: this.voiceChatId,
      action: 'Mute',
      participantObjectGuid: this.selfObjectGuid,
    });
    this.muted = true;
    this.emit('muted', true);
    return true;
  }

  async noteOutgoingFrame(samples) {
    if (!this.sendActivityEnabled || this.muted || !this.joined || rms(samples) < 0.015) return;
    const now = Date.now();
    if (this._sendActivityPromise || now - this._lastActivityAt < this.activityIntervalMs) return;
    this._lastActivityAt = now;
    this._sendActivityPromise = this.voiceApi.sendActivity({
      chatGuid: this.chatGuid,
      voiceChatId: this.voiceChatId,
      activity: 'Speaking',
    }).catch(error => {
      this.logger?.debug('Speaking activity update failed', { message: error.message });
    }).finally(() => {
      this._sendActivityPromise = null;
    });
    return this._sendActivityPromise;
  }

  async leave() {
    if (!this.chatGuid || !this.voiceChatId) return;
    try {
      await this.voiceApi.leave({ chatGuid: this.chatGuid, voiceChatId: this.voiceChatId });
    } finally {
      this.joined = false;
      await this._closePeerConnection();
      this.emit('left');
    }
  }

  async _closePeerConnection() {
    for (const { sink } of this.sinks.values()) {
      try { sink.stop(); } catch { /* already stopped */ }
    }
    this.sinks.clear();
    if (this.audioTrack) {
      try { this.audioTrack.stop(); } catch { /* already stopped */ }
    }
    this.audioTrack = null;
    this.audioSource = null;
    if (this.pc) {
      try { this.pc.close(); } catch { /* already closed */ }
      this.pc = null;
    }
    this.connected = false;
  }

  async close() {
    this.joined = false;
    await this._closePeerConnection();
  }
}

module.exports = { VoiceSession, preferOpus, participantGuidFromTrackEvent };
