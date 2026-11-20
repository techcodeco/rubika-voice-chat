'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AudioRecorder } = require('../src/audio/audio-recorder');

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('AudioRecorder writes consent-confirmed remote/outgoing PCM into OGG', { skip: !ffmpegAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-engine-test-'));
  const session = new EventEmitter();
  const player = new EventEmitter();
  const recorder = new AudioRecorder({ session, player, recordingDir: dir, ffmpegPath: 'ffmpeg' });
  const output = path.join(dir, 'mix.ogg');
  const lifecycle = [];
  for (const event of ['starting', 'started', 'stopping', 'stopped']) recorder.on(event, data => lifecycle.push({ event, data }));
  await recorder.start({ output, format: 'ogg', includeOutgoing: true, consentConfirmed: true });
  const start = Number(process.hrtime.bigint()) / 1e6 + 2;
  for (let i = 0; i < 30; i += 1) {
    const samples = new Int16Array(480);
    for (let j = 0; j < samples.length; j += 1) samples[j] = Math.round(Math.sin((i * 480 + j) * 2 * Math.PI * 440 / 48000) * 5000);
    const timestamp = start + i * 10;
    player.emit('audio-frame', { samples, timestamp });
    session.emit('remote-audio-frame', {
      trackId: 'remote-one',
      timestamp,
      data: { samples, sampleRate: 48000, channelCount: 1, bitsPerSample: 16, numberOfFrames: 480 },
    });
  }
  const result = await recorder.stop();
  const stat = await fs.stat(result);
  assert.ok(stat.size > 100);
  const metadata = JSON.parse(await fs.readFile(`${output}.json`, 'utf8'));
  assert.equal(metadata.consentConfirmed, true);
  assert.deepEqual(lifecycle.map(item => item.event), ['starting', 'started', 'stopping', 'stopped']);
  assert.ok(lifecycle.at(-1).data.sizeBytes > 0);
  assert.ok(lifecycle.at(-1).data.durationMs >= 0);
  assert.ok(metadata.sources.includes('outgoing'));
  assert.ok(metadata.sources.includes('remote:remote-one'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('AudioRecorder refuses to start without explicit consent confirmation', async () => {
  const session = new EventEmitter();
  const player = new EventEmitter();
  const recorder = new AudioRecorder({ session, player });
  await assert.rejects(
    recorder.start({ output: './unused.ogg' }),
    /explicit consent confirmation/,
  );
});

test('AudioRecorder can also finalize an MP3 output', { skip: !ffmpegAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-engine-mp3-test-'));
  const session = new EventEmitter();
  const player = new EventEmitter();
  const recorder = new AudioRecorder({ session, player, recordingDir: dir, ffmpegPath: 'ffmpeg' });
  const output = path.join(dir, 'mix.mp3');
  await recorder.start({ output, format: 'mp3', includeOutgoing: true, consentConfirmed: true });
  const start = Number(process.hrtime.bigint()) / 1e6 + 2;
  for (let i = 0; i < 30; i += 1) {
    const samples = new Int16Array(480).fill(1200);
    const timestamp = start + i * 10;
    player.emit('audio-frame', { samples, timestamp });
  }
  const result = await recorder.stop();
  const stat = await fs.stat(result);
  assert.ok(stat.size > 100);
  assert.equal(path.extname(result), '.mp3');
  await fs.rm(dir, { recursive: true, force: true });
});
