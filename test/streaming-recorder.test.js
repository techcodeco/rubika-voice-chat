'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { StreamingAudioRecorder } = require('../src/audio/streaming-audio-recorder');

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ffprobeAvailable = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const audioToolsAvailable = ffmpegAvailable && ffprobeAvailable;

function frame(value = 1500, frameNumber = 0) {
  const samples = new Int16Array(480);
  for (let index = 0; index < samples.length; index += 1) {
    const absoluteSample = frameNumber * 480 + index;
    samples[index] = Math.round(value * Math.sin((2 * Math.PI * 440 * absoluteSample) / 48000));
  }
  return { samples, sampleRate: 48000, channelCount: 1, bitsPerSample: 16, numberOfFrames: 480 };
}

function timestamp() { return Number(process.hrtime.bigint()) / 1e6; }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function assertPlayable(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `ffprobe must parse the final container: ${probe.stderr}`);
  assert.ok(Number.parseFloat(probe.stdout.trim()) > 0, 'the output must have a positive duration');
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(decode.status, 0, `FFmpeg must decode the full output: ${decode.stderr?.toString() || ''}`);
  const pcm = decode.stdout;
  let squareSum = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    squareSum += sample * sample;
    count += 1;
  }
  const decodedRms = count ? Math.sqrt(squareSum / count) : 0;
  assert.ok(decodedRms > 0.002, `decoded output should contain audible non-silent PCM, RMS=${decodedRms}`);
}

async function cleanup(dir) { await fs.rm(dir, { recursive: true, force: true }); }

test('mixed OGG output is created immediately and is playable after stop', { skip: !audioToolsAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-mixed-stream-'));
  const session = new EventEmitter();
  const recorder = new StreamingAudioRecorder({ session, recordingDir: dir, ffmpegPath: 'ffmpeg', finalizeOnProcessExit: false });
  const output = path.join(dir, 'everyone.ogg');
  const created = [];
  recorder.on('file-created', event => created.push(event));
  await recorder.start({ output, consentConfirmed: true });
  assert.equal(created.length, 1);
  assert.equal((await fs.stat(output)).size, 0, 'the destination is created immediately');
  for (let i = 0; i < 150; i += 1) {
    session.emit('remote-audio-frame', { trackId: 'track-a', participantObjectGuid: 'u0participantA', data: frame(1500, i), timestamp: timestamp() });
    await wait(10);
  }
  await wait(150);
  assert.equal(recorder.active, true, 'recording remains active while frames are mixed');
  await recorder.stop();
  assertPlayable(output);
  const metadata = JSON.parse(await fs.readFile(`${output}.json`, 'utf8'));
  assert.equal(metadata.status, 'finalized');
  assert.deepEqual(metadata.participants, ['u0participantA']);
  assert.equal(recorder.files.length, 1, 'all sources are mixed into exactly one output');
  await cleanup(dir);
});

test('all remote Voice Chat tracks are mixed into one playable OGG file without participant filters', { skip: !audioToolsAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-all-tracks-'));
  const session = new EventEmitter();
  const recorder = new StreamingAudioRecorder({ session, recordingDir: dir, finalizeOnProcessExit: false });
  const output = path.join(dir, 'all-voice-chat.ogg');
  await recorder.start({ output, consentConfirmed: true });

  for (let i = 0; i < 120; i += 1) {
    const at = timestamp();
    session.emit('remote-audio-frame', { trackId: 'one', participantObjectGuid: 'u0one', data: frame(1000, i), timestamp: at });
    session.emit('remote-audio-frame', { trackId: 'two', participantObjectGuid: 'u0two', data: frame(2000, i), timestamp: at });
    session.emit('remote-audio-frame', { trackId: 'three', participantObjectGuid: 'u0three', data: frame(3000, i), timestamp: at });
    await wait(10);
  }
  await recorder.stop();
  assertPlayable(output);
  const metadata = JSON.parse(await fs.readFile(`${output}.json`, 'utf8'));
  assert.deepEqual(metadata.participants.sort(), ['u0one', 'u0three', 'u0two']);
  assert.equal(recorder.files.length, 1);
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.ogg')).length, 1);
  await cleanup(dir);
});

test('all remote Voice Chat tracks are mixed into one playable MP3 file', { skip: !audioToolsAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-all-tracks-mp3-'));
  const session = new EventEmitter();
  const recorder = new StreamingAudioRecorder({ session, recordingDir: dir, finalizeOnProcessExit: false });
  const output = path.join(dir, 'all-voice-chat.mp3');
  await recorder.start({ output, format: 'mp3', consentConfirmed: true });

  for (let i = 0; i < 130; i += 1) {
    const at = timestamp();
    session.emit('remote-audio-frame', { trackId: 'allowed', participantObjectGuid: 'u0allowed', data: frame(2400, i), timestamp: at });
    session.emit('remote-audio-frame', { trackId: 'another', participantObjectGuid: 'u0another', data: frame(1500, i), timestamp: at });
    await wait(10);
  }
  await recorder.stop();
  assertPlayable(output);
  assert.equal(recorder.files.length, 1);
  await cleanup(dir);
});

test('includeSelf true mixes Player audio into the same file; false omits it without creating a self file', { skip: !audioToolsAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-include-self-'));
  const session = new EventEmitter();
  const player = new EventEmitter();
  const recorder = new StreamingAudioRecorder({ session, player, recordingDir: dir, finalizeOnProcessExit: false });
  const output = path.join(dir, 'with-self.ogg');
  await recorder.start({ output, consentConfirmed: true });
  assert.equal(recorder.includeSelf, false, 'self is excluded by default');

  for (let i = 0; i < 40; i += 1) {
    const at = timestamp();
    session.emit('remote-audio-frame', { trackId: 'remote', participantObjectGuid: 'u0remote', data: frame(1200, i), timestamp: at });
    player.emit('audio-frame', { samples: frame(1800, i).samples, hasAudio: true, timestamp: at });
    await wait(10);
  }
  assert.deepEqual(recorder.setRecordingFilter({ includeSelf: true }), { includeSelf: true });
  for (let i = 40; i < 120; i += 1) {
    const at = timestamp();
    session.emit('remote-audio-frame', { trackId: 'remote', participantObjectGuid: 'u0remote', data: frame(1200, i), timestamp: at });
    player.emit('audio-frame', { samples: frame(1800, i).samples, hasAudio: true, timestamp: at });
    await wait(10);
  }
  await recorder.stop();
  assertPlayable(output);
  const metadata = JSON.parse(await fs.readFile(`${output}.json`, 'utf8'));
  assert.deepEqual(metadata.sources.sort(), ['remote', 'self']);
  assert.equal(metadata.includeSelf, true);
  assert.equal(recorder.files.length, 1);
  assert.equal(path.basename(recorder.files[0].output), 'with-self.ogg');

  const noSelfOutput = path.join(dir, 'without-self.ogg');
  await recorder.start({ output: noSelfOutput, includeSelf: false, consentConfirmed: true });
  for (let i = 0; i < 80; i += 1) {
    const at = timestamp();
    session.emit('remote-audio-frame', { trackId: 'remote', participantObjectGuid: 'u0remote', data: frame(1200, i), timestamp: at });
    player.emit('audio-frame', { samples: frame(1800, i).samples, hasAudio: true, timestamp: at });
    await wait(10);
  }
  await recorder.stop();
  const noSelfMetadata = JSON.parse(await fs.readFile(`${noSelfOutput}.json`, 'utf8'));
  assert.deepEqual(noSelfMetadata.sources, ['remote']);
  assert.equal(noSelfMetadata.includeSelf, false);
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('self')).length, 0);
  assertPlayable(noSelfOutput);
  await cleanup(dir);
});

test('no incoming Voice Chat audio preserves an empty diagnostic output without throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-no-audio-'));
  const session = new EventEmitter();
  const recorder = new StreamingAudioRecorder({ session, recordingDir: dir, finalizeOnProcessExit: false });
  const output = path.join(dir, 'empty.ogg');
  const noAudio = [];
  recorder.on('no-audio', event => noAudio.push(event));
  await recorder.start({ output, consentConfirmed: true });
  assert.equal(await recorder.stop(), output);
  assert.equal((await fs.stat(output)).size, 0);
  assert.equal(noAudio.length, 1);
  const metadata = JSON.parse(await fs.readFile(`${output}.json`, 'utf8'));
  assert.equal(metadata.status, 'no-audio');
  await cleanup(dir);
});

test('removed participant filters are rejected and setRecordingFilter only accepts includeSelf', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-filter-api-'));
  const session = new EventEmitter();
  const recorder = new StreamingAudioRecorder({ session, recordingDir: dir, finalizeOnProcessExit: false });
  await assert.rejects(
    recorder.start({ output: path.join(dir, 'old-api.ogg'), excludeParticipants: ['u0blocked'], consentConfirmed: true }),
    /Unsupported recording option.*excludeParticipants/
  );
  await recorder.start({ output: path.join(dir, 'new-api.ogg'), consentConfirmed: true });
  assert.throws(() => recorder.setRecordingFilter({ excludeParticipants: [] }), /Only includeSelf is supported/);
  assert.deepEqual(recorder.setRecordingFilter({ includeSelf: true }), { includeSelf: true });
  assert.deepEqual(recorder.setRecordingFilter({ includeSelf: false }), { includeSelf: false });
  await recorder.stop();
  await cleanup(dir);
});

test('SIGINT shutdown finalizes an active recording without dereferencing cleared signal handlers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rubika-sigint-shutdown-'));
  const recorder = new StreamingAudioRecorder({
    session: new EventEmitter(),
    recordingDir: dir,
    finalizeOnProcessExit: true,
  });
  const output = path.join(dir, 'interrupted.ogg');
  const previousExitCode = process.exitCode;
  const previousSigintListeners = process.listeners('SIGINT').length;
  const previousSigtermListeners = process.listeners('SIGTERM').length;

  try {
    await recorder.start({ output, consentConfirmed: true });
    assert.equal(recorder.active, true);
    const sigintHandler = recorder._signalHandlers.SIGINT;

    // Invoke the same callback that process.once('SIGINT') receives. The real
    // stop() path clears _signalHandlers before the callback resumes.
    await assert.doesNotReject(() => sigintHandler());

    assert.equal(recorder.active, false);
    assert.equal(recorder._signalHandlers, null);
    assert.equal(process.listeners('SIGINT').length, previousSigintListeners);
    assert.equal(process.listeners('SIGTERM').length, previousSigtermListeners);
    assert.equal(process.exitCode, 130);
    const metadata = JSON.parse(await fs.readFile(`${output}.json`, 'utf8'));
    assert.equal(metadata.status, 'no-audio');
    assert.equal(metadata.reason, 'SIGINT');
  } finally {
    recorder._removeSignalHandlers();
    process.exitCode = previousExitCode;
    await cleanup(dir);
  }
});

