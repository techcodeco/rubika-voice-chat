'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { ByteQueue } = require('./byte-queue');
const { FFmpegDecoder } = require('./ffmpeg-decoder');
const { bufferToSamples, scalePcm, TARGET_FRAMES, TARGET_RATE } = require('../utils/pcm');

const FRAME_BYTES = TARGET_FRAMES * 2;

class AudioPlayer extends EventEmitter {
  constructor({ source, ffmpegPath = 'ffmpeg', logger, frameMs = 10, maxBufferedMs = 20000 } = {}) {
    super();
    if (!source || typeof source.onData !== 'function') throw new Error('RTCAudioSource is required for AudioPlayer.');
    this.source = source;
    this.ffmpegPath = ffmpegPath;
    this.logger = logger;
    this.frameMs = frameMs;
    this.maxBufferedBytes = Math.ceil((maxBufferedMs / 1000) * TARGET_RATE * 2);
    this.queue = new ByteQueue();
    this.decoder = null;
    this.status = 'idle';
    this.currentFile = null;
    this.currentTrackId = null;
    this._trackSequence = 0;
    this.basePosition = 0;
    this.outputFrames = 0;
    this.speed = 1;
    this.volume = 1;
    this.playlist = [];
    this.history = [];
    this._lastProgressAt = 0;
    this._manualDecoderStop = false;
    this._tickTimer = setInterval(() => this._tick(), frameMs);
    this._tickTimer.unref?.();
  }

  setSource(source) {
    if (!source || typeof source.onData !== 'function') throw new Error('A valid RTCAudioSource is required.');
    this.source = source;
  }

  get currentTime() {
    return this.basePosition + (this.outputFrames * this.frameMs / 1000 * this.speed);
  }

  get bufferedMs() {
    return this.queue.length / (TARGET_RATE * 2) * 1000;
  }

  getQueue() { return [...this.playlist]; }

  getState() {
    return {
      status: this.status,
      currentFile: this.currentFile,
      trackId: this.currentTrackId,
      position: this.currentTime,
      speed: this.speed,
      volume: Math.round(this.volume * 100),
      bufferedMs: this.bufferedMs,
      queue: this.getQueue(),
      history: [...this.history],
    };
  }

  _queueChanged(reason) {
    const state = { queue: this.getQueue(), queueLength: this.playlist.length, reason };
    this.emit('queue-updated', state);
    if (!this.playlist.length) this.emit('queue-empty', state);
  }

  async play(file) {
    if (!file) throw new Error('A file path is required.');
    const previousFile = this.currentFile;
    this.emit('track-changing', { from: previousFile || null, to: path.resolve(file), reason: 'play' });
    if (previousFile) this.emit('track-interrupted', {
      trackId: this.currentTrackId, file: previousFile, position: this.currentTime, reason: 'replace',
    });
    this.playlist = [];
    this.history = [];
    this._queueChanged('play-replaced-queue');
    this._stopDecoder();
    this.currentFile = path.resolve(file);
    this.currentTrackId = ++this._trackSequence;
    this.basePosition = 0;
    this.outputFrames = 0;
    await this._startDecoder({ changeReason: 'play', previousFile });
    return this;
  }

  enqueue(file) {
    if (!file) throw new Error('A file path is required.');
    const resolved = path.resolve(file);
    if (this.status === 'idle' && !this.currentFile) {
      this.play(resolved).catch(error => this.emit('error', error));
      return this.playlist.length;
    }
    this.playlist.push(resolved);
    const item = { file: resolved, queueLength: this.playlist.length, index: this.playlist.length - 1 };
    this.emit('queued', item);
    this._queueChanged('enqueue');
    return this.playlist.length;
  }

  enqueueMany(files) {
    if (!Array.isArray(files)) throw new TypeError('files must be an array');
    for (const file of files) this.enqueue(file);
    return this.playlist.length;
  }

  clearQueue() {
    const removed = this.playlist.splice(0);
    this._queueChanged('clear');
    this.emit('queue-cleared', { removed, count: removed.length });
    return removed.length;
  }

  removeFromQueue(index) {
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= this.playlist.length) return null;
    const [file] = this.playlist.splice(position, 1);
    this.emit('queue-item-removed', { file, index: position });
    this._queueChanged('remove');
    return file;
  }

  async next() {
    const nextFile = this.playlist.shift();
    if (!nextFile) {
      await this.stop({ clearQueue: false, reason: 'queue-finished' });
      this.emit('queue-empty', { queue: [], queueLength: 0, reason: 'manual-next' });
      return false;
    }
    const previousFile = this.currentFile;
    this.emit('track-changing', { from: previousFile || null, to: nextFile, reason: 'next' });
    if (previousFile) {
      this.history.push(previousFile);
      this.emit('track-skipped', { trackId: this.currentTrackId, file: previousFile, to: nextFile, reason: 'next' });
    }
    this._stopDecoder();
    this.currentFile = nextFile;
    this.currentTrackId = ++this._trackSequence;
    this.basePosition = 0;
    this.outputFrames = 0;
    this._queueChanged('next');
    await this._startDecoder({ changeReason: 'next', previousFile });
    return true;
  }

  async previous() {
    const previousFile = this.history.pop();
    if (!previousFile) return false;
    const currentFile = this.currentFile;
    this.emit('track-changing', { from: currentFile || null, to: previousFile, reason: 'previous' });
    if (currentFile) this.playlist.unshift(currentFile);
    this._stopDecoder();
    this.currentFile = previousFile;
    this.currentTrackId = ++this._trackSequence;
    this.basePosition = 0;
    this.outputFrames = 0;
    this._queueChanged('previous');
    await this._startDecoder({ changeReason: 'previous', previousFile: currentFile });
    return true;
  }

  pause() {
    if (this.status !== 'playing') return false;
    this.status = 'paused';
    this.decoder?.pause();
    const data = { trackId: this.currentTrackId, file: this.currentFile, position: this.currentTime };
    this.emit('paused', data);
    this.emit('state-changed', { ...this.getState(), reason: 'pause' });
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.status = 'playing';
    this.decoder?.resume();
    const data = { trackId: this.currentTrackId, file: this.currentFile, position: this.currentTime };
    this.emit('resumed', data);
    this.emit('state-changed', { ...this.getState(), reason: 'resume' });
    return true;
  }

  async seek(seconds) {
    const target = Math.max(0, Number(seconds));
    if (!Number.isFinite(target) || !this.currentFile) throw new Error('Cannot seek without a current audio file.');
    const wasPaused = this.status === 'paused';
    this.basePosition = target;
    this.outputFrames = 0;
    this._stopDecoder();
    await this._startDecoder({ paused: wasPaused, restart: true });
    const data = { trackId: this.currentTrackId, file: this.currentFile, position: target };
    this.emit('seeked', data);
    this.emit('state-changed', { ...this.getState(), reason: 'seek' });
    return target;
  }

  async setSpeed(speed) {
    const value = Number(speed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
      throw new RangeError('Playback speed must be between 0.5 and 2.0.');
    }
    const previousSpeed = this.speed;
    if (previousSpeed === value) return value;
    const position = this.currentTime;
    const wasPaused = this.status === 'paused';
    this.speed = value;
    if (this.currentFile) {
      this.basePosition = position;
      this.outputFrames = 0;
      this._stopDecoder();
      await this._startDecoder({ paused: wasPaused, restart: true });
    }
    const data = {
      trackId: this.currentTrackId,
      file: this.currentFile,
      speed: value,
      previousSpeed,
      position,
    };
    this.emit('speed-changed', data);
    this.emit('state-changed', { ...this.getState(), reason: 'speed' });
    return value;
  }

  setVolume(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0 || value > 200) {
      throw new RangeError('Volume must be between 0 and 200.');
    }
    const previousVolume = Math.round(this.volume * 100);
    this.volume = value / 100;
    const data = { volume: value, previousVolume, trackId: this.currentTrackId, file: this.currentFile };
    this.emit('volume-changed', data);
    this.emit('state-changed', { ...this.getState(), reason: 'volume' });
    return value;
  }

  async stop({ clearQueue = true, reason = 'manual' } = {}) {
    const stopped = this.currentFile ? {
      trackId: this.currentTrackId, file: this.currentFile, position: this.currentTime, reason,
    } : null;
    this._stopDecoder();
    this.status = 'idle';
    this.currentFile = null;
    this.currentTrackId = null;
    this.basePosition = 0;
    this.outputFrames = 0;
    if (clearQueue) {
      this.playlist = [];
      this._queueChanged('stop');
    }
    if (stopped) this.emit('track-stopped', stopped);
    this.emit('stopped', { ...this.getState(), stopped, reason });
    return stopped;
  }

  async _startDecoder({ paused = false, restart = false, changeReason = null, previousFile = null } = {}) {
    if (!this.currentFile) throw new Error('No current audio file selected.');
    if (!fs.existsSync(this.currentFile)) throw new Error(`Audio file not found: ${this.currentFile}`);
    this.queue.clear();
    if (!this.currentTrackId) this.currentTrackId = ++this._trackSequence;
    const track = {
      trackId: this.currentTrackId,
      file: this.currentFile,
      position: this.basePosition,
      speed: this.speed,
      restart,
    };
    if (!restart) this.emit('track-starting', track);
    const decoder = this.decoder = new FFmpegDecoder({
      ffmpegPath: this.ffmpegPath,
      logger: this.logger,
      maxBufferedBytes: this.maxBufferedBytes,
    });
    decoder.setBufferedBytesReader(() => this.queue.length);
    decoder.on('data', chunk => {
      this.queue.push(chunk);
      if (this.queue.length > this.maxBufferedBytes) decoder.pause();
    });
    decoder.on('error', error => {
      this.logger?.error('Audio decoder failed', { message: error.message, file: this.currentFile });
      this.emit('track-error', { ...track, error });
      this.emit('error', error);
    });
    decoder.on('close', result => {
      if (decoder !== this.decoder || this._manualDecoderStop) return;
      this._decoderEnded = true;
      this.emit('decoder-ended', { ...track, result });
    });
    decoder.on('start', details => this.emit('decoder-started', { ...details, trackId: this.currentTrackId, restart }));
    this._decoderEnded = false;
    this._manualDecoderStop = false;
    this.status = paused ? 'paused' : 'playing';
    decoder.start(this.currentFile, { seekSeconds: this.basePosition, speed: this.speed });
    if (paused) decoder.pause();
    if (restart) {
      this.emit('decoder-restarted', track);
    } else {
      this.emit('playing', track);
      this.emit('track-started', track);
      this.emit('playback-started', track);
      if (changeReason) this.emit('track-changed', {
        trackId: this.currentTrackId,
        from: previousFile || null,
        to: this.currentFile,
        file: this.currentFile,
        reason: changeReason,
        speed: this.speed,
      });
    }
    return track;
  }

  _stopDecoder() {
    this._manualDecoderStop = true;
    if (this.decoder) {
      this.decoder.removeAllListeners('close');
      this.decoder.kill();
      this.decoder = null;
    }
    this._decoderEnded = false;
    this.queue.clear();
  }

  _tick() {
    let samples = new Int16Array(TARGET_FRAMES);
    let hasAudio = false;

    if (this.status === 'playing') {
      let frame = this.queue.read(FRAME_BYTES);
      if (!frame && this._decoderEnded && this.queue.length) {
        const partial = this.queue.readPartial(FRAME_BYTES);
        frame = Buffer.alloc(FRAME_BYTES);
        partial.copy(frame);
      }
      if (frame) {
        samples = bufferToSamples(frame);
        hasAudio = true;
        this.outputFrames += 1;
        if (this.decoder && this.queue.length < this.maxBufferedBytes / 4) this.decoder.resume();
        const now = Date.now();
        if (now - this._lastProgressAt >= 1000) {
          this._lastProgressAt = now;
          this.emit('progress', {
            trackId: this.currentTrackId,
            file: this.currentFile,
            position: this.currentTime,
            duration: null,
            speed: this.speed,
            bufferedMs: this.bufferedMs,
          });
        }
      } else if (this._decoderEnded && this.queue.length === 0) {
        this._finishCurrentTrack();
      }
    }

    if (this.volume !== 1) samples = scalePcm(samples, this.volume);
    try {
      this.source?.onData({
        samples,
        sampleRate: TARGET_RATE,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: TARGET_FRAMES,
      });
    } catch (error) {
      this.logger?.error('Could not push PCM audio frame to WebRTC source', { message: error.message });
      this.emit('error', error);
    }
    this.emit('audio-frame', {
      samples,
      timestamp: Number(process.hrtime.bigint()) / 1e6,
      hasAudio,
      status: this.status,
    });
  }

  _finishCurrentTrack() {
    if (this.status !== 'playing') return;
    const finished = this.currentFile;
    const finishedTrack = {
      trackId: this.currentTrackId,
      file: finished,
      position: this.currentTime,
      speed: this.speed,
      finishedAt: new Date().toISOString(),
    };
    this.currentFile = null;
    this.currentTrackId = null;
    this.status = 'idle';
    if (finished) this.history.push(finished);
    this._stopDecoder();
    this.emit('ended', finishedTrack);
    this.emit('track-finished', finishedTrack);
    this.emit('state-changed', { ...this.getState(), reason: 'track-ended' });
    if (this.playlist.length) {
      const nextFile = this.playlist.shift();
      this.emit('track-changing', { from: finished, to: nextFile, reason: 'automatic' });
      this.currentFile = nextFile;
      this.currentTrackId = ++this._trackSequence;
      this.basePosition = 0;
      this.outputFrames = 0;
      this._queueChanged('automatic-next');
      this._startDecoder({ changeReason: 'automatic', previousFile: finished }).catch(error => this.emit('error', error));
    } else {
      this.emit('queue-empty', { queue: [], queueLength: 0, reason: 'track-ended' });
      this.emit('playback-finished', finishedTrack);
    }
  }

  async close() {
    clearInterval(this._tickTimer);
    await this.stop({ reason: 'close' });
  }
}

module.exports = { AudioPlayer };
