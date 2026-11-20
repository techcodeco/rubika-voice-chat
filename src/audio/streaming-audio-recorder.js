'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { toMono48k, pcmToBuffer, TARGET_RATE, TARGET_FRAMES } = require('../utils/pcm');

const FRAME_MS = 10;
const DEFAULT_JITTER_BUFFER_MS = 40;

function safePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

function createOutputPath(base) {
  return path.resolve(base);
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function normalizeFrame(samples) {
  const input = samples instanceof Int16Array ? samples : Int16Array.from(samples || []);
  if (input.length === TARGET_FRAMES) return input;
  const output = new Int16Array(TARGET_FRAMES);
  output.set(input.subarray(0, TARGET_FRAMES));
  return output;
}

/**
 * Live multi-track PCM mixer. Incoming WebRTC tracks and optional Player/self
 * frames are timestamp-bucketed, mixed to one mono PCM stream and encoded by
 * one FFmpeg process. This intentionally produces exactly one playable file.
 */
class StreamingAudioRecorder extends EventEmitter {
  constructor({
    session,
    player,
    ffmpegPath = 'ffmpeg',
    recordingDir = './recordings',
    logger,
    finalizeOnProcessExit = true,
    jitterBufferMs = DEFAULT_JITTER_BUFFER_MS,
  }) {
    super();
    this.session = session;
    this.player = player;
    this.ffmpegPath = ffmpegPath;
    this.recordingDir = recordingDir;
    this.logger = logger;
    this.finalizeOnProcessExit = finalizeOnProcessExit;
    this.jitterBufferMs = Math.max(FRAME_MS, Number(jitterBufferMs) || DEFAULT_JITTER_BUFFER_MS);
    this.active = false;
    this.listeners = [];
    this.startedAt = null;
    this.startedAtMs = 0;
    this.outputPath = null;
    this.format = null;
    this.source = 'all';
    this.includeSelf = false;
    this.frameCount = 0;
    this.mixedFrames = 0;
    this.files = [];
    this.pendingSlots = new Map();
    this.nextSlotToWrite = null;
    this.maxSlotSeen = null;
    this.sourcesSeen = new Set();
    this.participantsSeen = new Set();
    this.trackIdsSeen = new Set();
    this._signalHandlers = null;
    this._stopPromise = null;
    this.encoder = null;
    this.encoderError = null;
  }

  async start(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Recording options must be an object.');
    const unsupported = Object.keys(options).filter(key => !['output', 'format', 'includeSelf', 'consentConfirmed', 'finalizeOnProcessExit'].includes(key));
    if (unsupported.length) throw new TypeError(`Unsupported recording option: ${unsupported.join(', ')}. Only whole-chat recording is supported.`);
    const { output, format, includeSelf = false, consentConfirmed = false, finalizeOnProcessExit = this.finalizeOnProcessExit } = options;
    if (this.active) throw new Error('A recording is already active.');
    if (consentConfirmed !== true) throw new Error('Recording requires explicit consent confirmation.');
    if (typeof includeSelf !== 'boolean') throw new TypeError('includeSelf must be a boolean.');

    const extension = path.extname(output || '').slice(1).toLowerCase();
    const selectedFormat = String(format || extension || 'ogg').toLowerCase();
    if (!['ogg', 'mp3'].includes(selectedFormat)) throw new TypeError('format must be ogg or mp3.');
    if (extension && ['ogg', 'mp3'].includes(extension) && extension !== selectedFormat) throw new Error('output extension and format do not match.');

    await fs.mkdir(this.recordingDir, { recursive: true });
    const defaultName = `voice-chat-${new Date().toISOString().replace(/[:.]/g, '-')}.${selectedFormat}`;
    this.outputPath = createOutputPath(output || path.join(this.recordingDir, defaultName));
    await fs.mkdir(path.dirname(this.outputPath), { recursive: true });
    await fs.writeFile(this.outputPath, Buffer.alloc(0));

    this.format = selectedFormat;
    this.source = 'all';
    this.includeSelf = includeSelf;
    this.startedAt = new Date();
    this.startedAtMs = nowMs();
    this.frameCount = 0;
    this.mixedFrames = 0;
    this.pendingSlots.clear();
    this.nextSlotToWrite = null;
    this.maxSlotSeen = null;
    this.sourcesSeen.clear();
    this.participantsSeen.clear();
    this.trackIdsSeen.clear();
    this.encoder = null;
    this.encoderError = null;
    this._stopPromise = null;
    this.files = [{
      key: 'mixed',
      output: this.outputPath,
      source: 'mixed',
      sources: [],
      participantObjectGuids: [],
      trackIds: [],
      placeholder: true,
      mixed: true,
    }];
    this.active = true;
    this.finalizeOnProcessExit = Boolean(finalizeOnProcessExit);

    if (this.session) {
      const onFrame = event => this._captureRemote(event);
      this.session.on('remote-audio-frame', onFrame);
      this.listeners.push([this.session, 'remote-audio-frame', onFrame]);
    }
    // Keep the Player listener installed for the entire recording so includeSelf
    // can be toggled dynamically with setRecordingFilter().
    if (this.player) {
      const onFrame = event => this._captureOutgoing(event);
      this.player.on('audio-frame', onFrame);
      this.listeners.push([this.player, 'audio-frame', onFrame]);
    }

    this.progressTimer = setInterval(() => {
      this._flushReadySlots(false);
      this.emit('progress', this._progressData());
    }, FRAME_MS);
    this.progressTimer.unref?.();
    if (this.finalizeOnProcessExit) this._installSignalHandlers();

    const started = {
      output: this.outputPath,
      format: selectedFormat,
      source: 'all',
      includeSelf: this.includeSelf,
      mixed: true,
      consentConfirmed: true,
    };
    this.emit('starting', started);
    this.emit('file-created', { ...this.files[0], placeholder: true, streaming: true });
    this.emit('started', { ...started, streaming: true, startedAt: this.startedAt.toISOString() });
    return { output: this.outputPath, format: this.format, source: 'all', includeSelf: this.includeSelf, mixed: true, streaming: true };
  }

  setRecordingFilter(filter = {}) {
    if (!this.active) throw new Error('No active recording.');
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('filter must be an object.');
    const unsupported = Object.keys(filter).filter(key => key !== 'includeSelf');
    if (unsupported.length) throw new TypeError(`Unsupported recording filter: ${unsupported.join(', ')}. Only includeSelf is supported.`);
    const { includeSelf } = filter;
    if (typeof includeSelf !== 'boolean') throw new TypeError('setRecordingFilter expects { includeSelf: boolean }.');
    this.includeSelf = includeSelf;
    const result = { includeSelf: this.includeSelf };
    this.emit('filter-changed', result);
    return result;
  }

  _captureRemote(event = {}) {
    if (!this.active) return;
    const id = String(event.trackId || 'remote-unknown');
    try {
      this._queueFrame({
        source: 'remote',
        trackKey: `remote:${id}`,
        trackId: id,
        participantObjectGuid: event.participantObjectGuid || event.participant_object_guid || null,
        samples: toMono48k(event.data),
        timestamp: event.timestamp,
      });
    } catch (error) {
      this._reportError(error);
    }
  }

  _captureOutgoing(event = {}) {
    if (!this.active || !this.includeSelf || event.hasAudio === false) return;
    try {
      this._queueFrame({
        source: 'self',
        trackKey: 'self:player',
        trackId: null,
        participantObjectGuid: null,
        samples: normalizeFrame(event.samples),
        timestamp: event.timestamp,
      });
    } catch (error) {
      this._reportError(error);
    }
  }

  _queueFrame({ source, trackKey, trackId, participantObjectGuid, samples, timestamp }) {
    const frameTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : nowMs();
    const slot = Math.max(0, Math.floor((frameTimestamp - this.startedAtMs) / FRAME_MS));
    let bucket = this.pendingSlots.get(slot);
    if (!bucket) {
      bucket = { sum: new Int32Array(TARGET_FRAMES), tracks: new Set(), sources: new Set(), participants: new Set(), trackIds: new Set() };
      this.pendingSlots.set(slot, bucket);
    }
    // A track may contribute at most once to one 10ms bucket.
    if (bucket.tracks.has(trackKey)) return;
    bucket.tracks.add(trackKey);
    bucket.sources.add(source);
    if (participantObjectGuid) bucket.participants.add(String(participantObjectGuid));
    if (trackId) bucket.trackIds.add(String(trackId));

    const normalized = normalizeFrame(samples);
    for (let index = 0; index < TARGET_FRAMES; index += 1) bucket.sum[index] += normalized[index];
    this.maxSlotSeen = this.maxSlotSeen === null ? slot : Math.max(this.maxSlotSeen, slot);
    this.frameCount += 1;
    this.sourcesSeen.add(source);
    if (participantObjectGuid) this.participantsSeen.add(String(participantObjectGuid));
    if (trackId) this.trackIdsSeen.add(String(trackId));
    this._flushReadySlots(false);
  }

  _mixBucket(bucket) {
    const contributors = Math.max(1, bucket.tracks.size);
    const normalization = Math.sqrt(contributors);
    const mixed = new Int16Array(TARGET_FRAMES);
    for (let index = 0; index < TARGET_FRAMES; index += 1) {
      const value = Math.round(bucket.sum[index] / normalization);
      mixed[index] = Math.max(-32768, Math.min(32767, value));
    }
    return mixed;
  }

  _ensureEncoder() {
    if (this.encoder) return this.encoder;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 's16le', '-ar', String(TARGET_RATE), '-ac', '1', '-i', 'pipe:0',
      '-vn', '-flush_packets', '1', '-ar', String(TARGET_RATE), '-ac', '1',
    ];
    if (this.format === 'ogg') args.push('-c:a', 'libopus', '-b:a', '96k', '-application', 'audio', '-page_duration', '200000', '-avioflags', 'direct', '-f', 'ogg');
    else args.push('-c:a', 'libmp3lame', '-b:a', '160k', '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3');
    args.push(this.outputPath);

    const child = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    const encoder = { child, stderr, ended: false, error: null, closePromise: null, resolveClose: null, bytesIn: 0 };
    encoder.closePromise = new Promise(resolve => { encoder.resolveClose = resolve; });
    child.once('error', error => {
      encoder.error = new Error(`Could not start FFmpeg: ${error.message}`);
      this.encoderError = encoder.error;
      this._reportError(encoder.error);
    });
    child.once('close', (code, signal) => {
      encoder.ended = true;
      if (code !== 0 && !encoder.intentionalClose) {
        encoder.error = new Error(`FFmpeg mixed-stream encoder exited (${code ?? signal}): ${stderr.trim() || 'no diagnostic output'}`);
        this.encoderError = encoder.error;
        if (this.active) this._reportError(encoder.error);
      }
      encoder.resolveClose?.();
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') {
        encoder.error = error;
        this.encoderError = error;
        if (this.active) this._reportError(error);
      }
    });
    this.encoder = encoder;
    this.files[0] = {
      key: 'mixed', output: this.outputPath, source: 'mixed', mixed: true,
      placeholder: false,
    };
    this.emit('file-ready', { output: this.outputPath, key: 'mixed', source: 'mixed', mixed: true, streaming: true });
    return encoder;
  }

  _writeMixedFrame(samples) {
    const encoder = this._ensureEncoder();
    if (encoder.ended || encoder.error || encoder.child.stdin.destroyed || encoder.child.stdin.writableEnded) return;
    const pcm = pcmToBuffer(samples);
    encoder.child.stdin.write(pcm);
    encoder.bytesIn += pcm.length;
    this.mixedFrames += 1;
  }

  _flushReadySlots(force) {
    if ((!this.active && !force) || this.maxSlotSeen === null) return;
    const currentSlot = Math.max(0, Math.floor((nowMs() - this.startedAtMs) / FRAME_MS));
    const threshold = force ? this.maxSlotSeen : Math.min(this.maxSlotSeen, currentSlot - Math.ceil(this.jitterBufferMs / FRAME_MS));
    if (threshold < 0) return;
    if (this.nextSlotToWrite === null) {
      const pending = [...this.pendingSlots.keys()];
      if (!pending.length) return;
      this.nextSlotToWrite = Math.min(...pending);
    }
    while (this.nextSlotToWrite <= threshold) {
      const bucket = this.pendingSlots.get(this.nextSlotToWrite);
      if (bucket) {
        this._writeMixedFrame(this._mixBucket(bucket));
        this.pendingSlots.delete(this.nextSlotToWrite);
      } else if (this.encoder) {
        this._writeMixedFrame(new Int16Array(TARGET_FRAMES));
      }
      this.nextSlotToWrite += 1;
    }
  }

  _reportError(error) {
    // A recorder can be used standalone, where EventEmitter's special "error"
    // event would throw if unhandled. Keep the promise/caller path safe and log
    // the failure through a regular event when no error subscriber exists.
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else this.logger?.error('Voice recording error', { message: error.message });
    this.emit('recording-error', error);
  }

  _progressData() {
    const elapsedMs = Math.max(0, nowMs() - this.startedAtMs);
    return {
      output: this.outputPath,
      format: this.format,
      elapsedMs,
      durationSeconds: elapsedMs / 1000,
      framesCaptured: this.frameCount,
      mixedFrames: this.mixedFrames,
      files: this.files.map(file => ({ ...file, framesCaptured: this.mixedFrames })),
      sources: [...this.sourcesSeen],
      participants: [...this.participantsSeen],
      streaming: true,
      mixed: true,
      includeSelf: this.includeSelf,
    };
  }

  _installSignalHandlers() {
    if (this._signalHandlers) return;

    // Keep a stable reference to this registration. stop() also removes the
    // signal listeners, so reading this._signalHandlers after awaiting stop()
    // would dereference null when Ctrl+C initiates the shutdown.
    const signalHandlers = { SIGINT: null, SIGTERM: null };
    const makeHandler = signal => async () => {
      if (!this.active) {
        if (this._signalHandlers === signalHandlers) this._removeSignalHandlers();
        return;
      }
      try { await this.stop({ reason: signal }); }
      catch (error) { this.logger?.error('Could not finalize recording during process shutdown', { message: error.message }); }

      // Use the captured registration, not this._signalHandlers: stop() may
      // already have cleared that property while finalizing the recording.
      process.removeListener('SIGINT', signalHandlers.SIGINT);
      process.removeListener('SIGTERM', signalHandlers.SIGTERM);
      if (this._signalHandlers === signalHandlers) this._signalHandlers = null;
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    };

    signalHandlers.SIGINT = makeHandler('SIGINT');
    signalHandlers.SIGTERM = makeHandler('SIGTERM');
    this._signalHandlers = signalHandlers;
    process.once('SIGINT', signalHandlers.SIGINT);
    process.once('SIGTERM', signalHandlers.SIGTERM);
  }

  _removeSignalHandlers() {
    if (!this._signalHandlers) return;
    process.removeListener('SIGINT', this._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', this._signalHandlers.SIGTERM);
    this._signalHandlers = null;
  }

  async stop({ reason = 'manual' } = {}) {
    if (this._stopPromise) return this._stopPromise;
    if (!this.active) return this.files[0]?.output || null;
    this.active = false;
    this._stopPromise = (async () => {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
      this.emit('stopping', { ...this._progressData(), reason });
      for (const [emitter, event, listener] of this.listeners) emitter.off(event, listener);
      this.listeners = [];
      this._removeSignalHandlers();
      this._flushReadySlots(true);

      const encoder = this.encoder;
      if (encoder && !encoder.child.stdin.destroyed && !encoder.child.stdin.writableEnded) {
        encoder.intentionalClose = true;
        encoder.child.stdin.end();
      }
      if (encoder) await encoder.closePromise;

      if (encoder?.error || this.encoderError) {
        const error = encoder?.error || this.encoderError;
        const diagnostic = {
          status: 'encoder-error', output: this.outputPath, format: this.format, reason,
          message: error.message, framesCaptured: this.frameCount, mixedFrames: this.mixedFrames,
          finishedAt: new Date().toISOString(), placeholderPreserved: true,
        };
        await fs.writeFile(`${this.outputPath}.json`, JSON.stringify(diagnostic, null, 2));
        this.emit('failed', diagnostic);
        this.active = false;
        this._stopPromise = null;
        throw error;
      }

      const stat = await fs.stat(this.outputPath).catch(() => null);
      if (!encoder || !stat || stat.size <= 0 || this.mixedFrames <= 0) {
        const diagnostic = {
          status: 'no-audio', output: this.outputPath, format: this.format, reason,
          framesCaptured: this.frameCount, mixedFrames: this.mixedFrames,
          startedAt: this.startedAt?.toISOString() || null,
          finishedAt: new Date().toISOString(), streaming: true, mixed: true,
          includeSelf: this.includeSelf,
          sourcesSeen: [...this.sourcesSeen],
          message: 'No audio frames were received from the Voice Chat audio stream. The empty output placeholder was preserved.',
          placeholderPreserved: true,
        };
        await fs.writeFile(`${this.outputPath}.json`, JSON.stringify(diagnostic, null, 2));
        this.emit('no-audio', diagnostic);
        this.emit('failed', diagnostic);
        this._stopPromise = null;
        return this.outputPath;
      }

      const finishedAt = new Date().toISOString();
      const metadata = {
        status: 'finalized', output: this.outputPath, format: this.format,
        sizeBytes: stat.size, startedAt: this.startedAt.toISOString(), finishedAt,
        durationSeconds: this.mixedFrames * FRAME_MS / 1000,
        sampleRate: TARGET_RATE, channels: 1, framesCaptured: this.frameCount,
        mixedFrames: this.mixedFrames, mixed: true,
        sources: [...this.sourcesSeen],
        participants: [...this.participantsSeen],
        trackIds: [...this.trackIdsSeen],
        includeSelf: this.includeSelf,
        consentConfirmed: true, streaming: true, finalizedBy: reason,
      };
      await fs.writeFile(`${this.outputPath}.json`, JSON.stringify(metadata, null, 2));
      this.files[0] = {
        key: 'mixed', output: this.outputPath, source: 'mixed', mixed: true,
        sizeBytes: stat.size, framesCaptured: this.mixedFrames,
        participants: [...this.participantsSeen], sources: [...this.sourcesSeen],
        placeholder: false,
      };
      const result = {
        output: this.outputPath, files: [{ ...this.files[0] }], format: this.format,
        durationMs: this.mixedFrames * FRAME_MS,
        framesCaptured: this.frameCount, mixedFrames: this.mixedFrames,
        sources: [...this.sourcesSeen], participants: [...this.participantsSeen],
        includeSelf: this.includeSelf, mixed: true, finishedAt, reason, streaming: true,
      };
      this.emit('stopped', result);
      this.encoder = null;
      this.pendingSlots.clear();
      this._stopPromise = null;
      return this.outputPath;
    })();
    return this._stopPromise;
  }
}

module.exports = { StreamingAudioRecorder, safePart, createOutputPath, FRAME_MS, DEFAULT_JITTER_BUFFER_MS };
