'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

class FFmpegDecoder extends EventEmitter {
  constructor({ ffmpegPath = 'ffmpeg', logger, maxBufferedBytes = 2 * 1024 * 1024 } = {}) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.logger = logger;
    this.maxBufferedBytes = maxBufferedBytes;
    this.child = null;
    this.ended = false;
    this.killed = false;
    this.stderr = '';
  }

  start(file, { seekSeconds = 0, speed = 1 } = {}, onChunk) {
    if (!fs.existsSync(file)) throw new Error(`Audio file does not exist: ${file}`);
    const resolved = path.resolve(file);
    const filters = [];
    if (Math.abs(speed - 1) > 0.0001) filters.push(`atempo=${speed}`);
    filters.push('aresample=48000', 'aformat=sample_fmts=s16:channel_layouts=mono');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
      '-i', resolved,
      '-map', '0:a:0', '-vn',
      '-af', filters.join(','),
      '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1',
      '-f', 's16le', 'pipe:1',
    ];

    this.stderr = '';
    this.ended = false;
    this.killed = false;
    this.child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', chunk => {
      onChunk?.(chunk);
      this.emit('data', chunk);
      if (this.child?.stdout && this.bufferedBytes?.() > this.maxBufferedBytes) this.child.stdout.pause();
    });
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000);
    });
    this.child.once('error', error => {
      if (!this.killed) this.emit('error', new Error(`Failed to start FFmpeg: ${error.message}`));
    });
    this.child.once('close', (code, signal) => {
      this.ended = true;
      this.emit('close', { code, signal, killed: this.killed, stderr: this.stderr });
      if (!this.killed && code !== 0) {
        this.emit('error', new Error(`FFmpeg exited with code ${code}: ${this.stderr.trim() || 'no diagnostic output'}`));
      }
      this.emit('end', { code, signal, killed: this.killed });
    });
    this.emit('start', { file: resolved, seekSeconds, speed });
    return this;
  }

  setBufferedBytesReader(reader) {
    this.bufferedBytes = reader;
  }

  resume() {
    this.child?.stdout?.resume();
  }

  pause() {
    this.child?.stdout?.pause();
  }

  kill() {
    if (!this.child || this.ended || this.killed) return;
    this.killed = true;
    this.child.kill('SIGTERM');
  }
}

module.exports = { FFmpegDecoder };
