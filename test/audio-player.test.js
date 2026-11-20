'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AudioPlayer } = require('../src/audio/audio-player');

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('AudioPlayer decodes an audio file into paced 48kHz PCM frames', { skip: !ffmpegAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-player-test-'));
  const wav = path.join(dir, 'tone.wav');
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.35:sample_rate=48000',
    '-ac', '1', '-ar', '48000', wav,
  ]);
  assert.equal(generated.status, 0);

  let pushedFrames = 0;
  const source = { onData(data) { assert.equal(data.sampleRate, 48000); assert.equal(data.numberOfFrames, 480); pushedFrames += 1; } };
  const player = new AudioPlayer({ source, ffmpegPath: 'ffmpeg', frameMs: 10 });
  let decodedAudioFrames = 0;
  player.on('audio-frame', frame => { if (frame.hasAudio) decodedAudioFrames += 1; });
  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Player did not finish the test track')), 5000);
    player.once('ended', () => { clearTimeout(timeout); resolve(); });
    player.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  await player.play(wav);
  await ended;
  assert.ok(decodedAudioFrames >= 20, `expected decoded frames, got ${decodedAudioFrames}`);
  assert.ok(pushedFrames >= decodedAudioFrames);
  await player.close();
  await fs.rm(dir, { recursive: true, force: true });
});


test('AudioPlayer exposes track lifecycle, queue state, and persistent playback speed controls', { skip: !ffmpegAvailable }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-player-events-'));
  const first = path.join(dir, 'first.wav');
  const second = path.join(dir, 'second.wav');
  for (const [file, duration, frequency] of [[first, '0.65', '440'], [second, '0.25', '660']]) {
    const generated = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}:sample_rate=48000`,
      '-ac', '1', '-ar', '48000', file,
    ]);
    assert.equal(generated.status, 0);
  }

  const player = new AudioPlayer({
    source: { onData() {} },
    ffmpegPath: 'ffmpeg',
    frameMs: 10,
  });
  const events = [];
  for (const name of ['speed-changed', 'track-starting', 'track-started', 'track-changing', 'track-changed', 'ended', 'track-finished', 'queue-updated']) {
    player.on(name, data => events.push({ name, data }));
  }

  try {
    await player.setSpeed(1.25); // Must work before a track is loaded.
    await player.play(first);
    assert.equal(player.getState().speed, 1.25);
    await player.setSpeed(0.75);
    assert.equal(player.getState().speed, 0.75);
    player.enqueue(second);
    assert.equal(player.getQueue().length, 1);
    assert.equal(player.removeFromQueue(0), path.resolve(second));
    player.enqueue(second);

    const finished = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Queued tracks did not finish')), 6000);
      player.on('track-finished', event => {
        if (event.file === path.resolve(second)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      player.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    await finished;

    assert.ok(events.some(event => event.name === 'speed-changed' && event.data.speed === 1.25));
    assert.ok(events.some(event => event.name === 'speed-changed' && event.data.speed === 0.75));
    assert.ok(events.some(event => event.name === 'track-starting'));
    assert.ok(events.some(event => event.name === 'track-started'));
    assert.ok(events.some(event => event.name === 'track-changed' && event.data.reason === 'automatic'));
    assert.ok(events.some(event => event.name === 'ended'));
    assert.equal(player.getState().status, 'idle');
  } finally {
    await player.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
