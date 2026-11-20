'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { toMono48k, pcmToBuffer, TARGET_FRAMES, TARGET_RATE } = require('../utils/pcm');

const FRAME_BYTES = TARGET_FRAMES * 2;
const FRAME_MS = 10;

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'track';
}

class PcmFileWriter {
  constructor(file, startedAtMs) {
    this.file = file;
    this.startedAtMs = startedAtMs;
    this.nextFrameIndex = 0;
    this.stream = fs.createWriteStream(file, { flags: 'w' });
    this.error = null;
    this.stream.on('error', error => { this.error = error; });
  }

  writeFrame(samples, timestampMs) {
    if (this.error) throw this.error;
    let frame = samples;
    if (!(frame instanceof Int16Array)) frame = Int16Array.from(frame || []);
    if (frame.length !== TARGET_FRAMES) {
      const fixed = new Int16Array(TARGET_FRAMES);
      fixed.set(frame.subarray(0, TARGET_FRAMES));
      frame = fixed;
    }
    const targetIndex = Math.max(0, Math.floor((timestampMs - this.startedAtMs) / FRAME_MS));
    if (targetIndex > this.nextFrameIndex) {
      const gapFrames = targetIndex - this.nextFrameIndex;
      // Write bounded silence chunks so a late first track remains aligned with the recording clock.
      const silence = Buffer.alloc(Math.min(gapFrames, 1000) * FRAME_BYTES);
      let remaining = gapFrames;
      while (remaining > 0) {
        const count = Math.min(remaining, 1000);
        this.stream.write(count === 1000 ? silence : Buffer.alloc(count * FRAME_BYTES));
        remaining -= count;
      }
      this.nextFrameIndex = targetIndex;
    }
    if (targetIndex < this.nextFrameIndex) return;
    this.stream.write(pcmToBuffer(frame));
    this.nextFrameIndex += 1;
  }

  async close() {
    if (this.stream.writableEnded) return;
    await new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(resolve);
    });
    if (this.error) throw this.error;
  }
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.once('error', error => reject(new Error(`Could not start FFmpeg: ${error.message}`)));
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg recording encode failed (${code}): ${stderr.trim() || 'no diagnostic output'}`));
    });
  });
}

class AudioRecorder extends EventEmitter {
  constructor({ session, player, ffmpegPath = 'ffmpeg', recordingDir = './recordings', keepRaw = false, logger }) {
    super();
    this.session = session;
    this.player = player;
    this.ffmpegPath = ffmpegPath;
    this.recordingDir = recordingDir;
    this.keepRaw = keepRaw;
    this.logger = logger;
    this.active = false;
    this.writers = new Map();
    this.listeners = [];
    this.progressTimer = null;
    this.frameCount = 0;
    this.startedAt = null;
  }

  async start({
    output,
    format,
    includeOutgoing = true,
    consentConfirmed = false,
    keepRaw = this.keepRaw,
    source = 'all',
    trackId,
  } = {}) {
    if (this.active) throw new Error('A recording is already active.');
    if (consentConfirmed !== true) {
      throw new Error('Recording requires explicit consent confirmation. Pass consentConfirmed: true only after the participants have agreed to recording.');
    }
    await fsp.mkdir(this.recordingDir, { recursive: true });
    const outputExtension = path.extname(output || '').slice(1).toLowerCase();
    const selectedFormat = (format || outputExtension || 'ogg').toLowerCase();
    if (!['ogg', 'mp3'].includes(selectedFormat)) throw new Error('Recording format must be ogg or mp3.');
    if (format && outputExtension && ['ogg', 'mp3'].includes(outputExtension) && outputExtension !== selectedFormat) {
      throw new Error(`Recording format (${selectedFormat}) does not match output extension (.${outputExtension}).`);
    }
    const defaultName = `voice-chat-${new Date().toISOString().replace(/[:.]/g, '-')}.${selectedFormat}`;
    const outputPath = path.resolve(output || path.join(this.recordingDir, defaultName));
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    this.emit('starting', { output: outputPath, format: selectedFormat, source, consentConfirmed: true });
    this.startedAtMs = Number(process.hrtime.bigint()) / 1e6;
    this.startedAt = new Date();
    this.frameCount = 0;
    this.outputPath = outputPath;
    this.format = selectedFormat;
    this.keepRaw = keepRaw;
    if (!['all', 'remote', 'outgoing', 'track'].includes(source)) {
      throw new TypeError('Recording source must be all, remote, outgoing, or track.');
    }
    if (source === 'track' && !trackId) throw new TypeError('trackId is required when source is track.');
    this.includeOutgoing = includeOutgoing && ['all', 'outgoing'].includes(source);
    this.sourceFilter = source;
    this.trackFilter = trackId || null;
    this.workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rubika-voice-recording-'));
    this.trackIndex = 0;
    this.writers.clear();
    this.active = true;

    if (this.includeOutgoing && this.player) {
      this._ensureWriter('outgoing', `outgoing.s16le`);
    }
    if (this.session) {
      const remoteListener = event => {
        if (!this.active || this.sourceFilter === 'outgoing') return;
        if (this.sourceFilter === 'track' && event.trackId !== this.trackFilter) return;
        const writer = this._ensureWriter(`remote:${event.trackId}`, `remote-${safeName(event.trackId)}.s16le`);
        try {
          writer.writeFrame(toMono48k(event.data), event.timestamp);
          this.frameCount += 1;
        } catch (error) {
          this.emit('error', error);
        }
      };
      this.session.on('remote-audio-frame', remoteListener);
      this.listeners.push([this.session, 'remote-audio-frame', remoteListener]);
    }
    if (this.includeOutgoing && this.player) {
      const outgoingListener = event => {
        if (!this.active) return;
        const writer = this.writers.get('outgoing');
        try {
          if (writer) { writer.writeFrame(event.samples, event.timestamp); this.frameCount += 1; }
        } catch (error) { this.emit('error', error); }
      };
      this.player.on('audio-frame', outgoingListener);
      this.listeners.push([this.player, 'audio-frame', outgoingListener]);
    }

    this.progressTimer = setInterval(() => this.emit('progress', this._progressData()), 1000);
    this.progressTimer.unref?.();
    this.emit('started', { output: outputPath, format: selectedFormat, includeOutgoing: this.includeOutgoing, source, consentConfirmed: true, startedAt: this.startedAt.toISOString() });
    this.logger?.info('Voice chat recording started', { output: outputPath, format: selectedFormat, includeOutgoing: this.includeOutgoing, source });
    return { output: outputPath, format: selectedFormat, source };
  }

  _progressData() {
    const elapsedMs = Math.max(0, Number(process.hrtime.bigint()) / 1e6 - this.startedAtMs);
    return {
      output: this.outputPath,
      format: this.format,
      elapsedMs,
      durationSeconds: elapsedMs / 1000,
      framesCaptured: this.frameCount,
      sources: [...this.writers.keys()],
      estimatedPcmBytes: this.frameCount * FRAME_BYTES,
    };
  }

  _ensureWriter(key, filename) {
    if (!this.writers.has(key)) {
      const writer = new PcmFileWriter(path.join(this.workDir, filename), this.startedAtMs);
      this.writers.set(key, writer);
    }
    return this.writers.get(key);
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
    const stopping = this._progressData();
    this.emit('stopping', stopping);
    for (const [emitter, event, listener] of this.listeners) emitter.off(event, listener);
    this.listeners = [];

    const writerEntries = [...this.writers.entries()];
    await Promise.all(writerEntries.map(([, writer]) => writer.close()));
    const inputs = [];
    for (const [key, writer] of writerEntries) {
      const stat = await fsp.stat(writer.file).catch(() => null);
      if (stat?.size > 0) inputs.push({ key, file: writer.file });
    }
    if (!inputs.length) {
      await fsp.rm(this.workDir, { recursive: true, force: true });
      this.writers.clear();
      const error = new Error('No audio frames were captured; no recording file was created.');
      this.emit('failed', { ...stopping, error });
      this.emit('error', error);
      throw error;
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const input of inputs) {
      args.push('-f', 's16le', '-ar', String(TARGET_RATE), '-ac', '1', '-i', input.file);
    }
    if (inputs.length > 1) {
      const labels = inputs.map((_, index) => `[${index}:a]`).join('');
      args.push(
        '-filter_complex',
        `${labels}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
        '-map', '[aout]',
      );
    } else {
      args.push('-map', '0:a:0');
    }
    args.push('-ar', String(TARGET_RATE), '-ac', '1');
    if (this.format === 'ogg') {
      args.push('-c:a', 'libopus', '-b:a', '96k', '-application', 'audio', '-f', 'ogg');
    } else {
      args.push('-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3');
    }
    args.push(this.outputPath);

    try {
      await runFfmpeg(this.ffmpegPath, args);
      const stat = await fsp.stat(this.outputPath);
      const durationMs = stopping.elapsedMs;
      const metadata = {
        startedAt: this.startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        format: this.format,
        sampleRate: TARGET_RATE,
        channels: 1,
        sources: inputs.map(item => item.key),
        output: this.outputPath,
        sizeBytes: stat.size,
        durationMs,
        framesCaptured: this.frameCount,
        consentConfirmed: true,
      };
      await fsp.writeFile(`${this.outputPath}.json`, JSON.stringify(metadata, null, 2));
      if (this.keepRaw) {
        const rawDir = `${this.outputPath}.raw`;
        await fsp.mkdir(rawDir, { recursive: true });
        for (const input of inputs) {
          await fsp.copyFile(input.file, path.join(rawDir, path.basename(input.file)));
        }
      }
      await fsp.rm(this.workDir, { recursive: true, force: true });
      this.logger?.info('Voice chat recording finalized', { output: this.outputPath, sources: inputs.length });
      const result = {
        output: this.outputPath,
        format: this.format,
        sources: inputs.map(item => item.key),
        durationMs,
        durationSeconds: durationMs / 1000,
        sizeBytes: stat.size,
        finishedAt: new Date().toISOString(),
        framesCaptured: this.frameCount,
      };
      this.emit('stopped', result);
      this.writers.clear();
      return this.outputPath;
    } catch (error) {
      this.logger?.error('Could not finalize voice recording', { message: error.message, workDir: this.workDir });
      this.emit('failed', { output: this.outputPath, format: this.format, error, ...this._progressData() });
      this.emit('error', error);
      throw error;
    }
  }
}

module.exports = { AudioRecorder, PcmFileWriter, runFfmpeg };
