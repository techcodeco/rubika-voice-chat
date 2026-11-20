'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toMono48k, scalePcm, pcmToBuffer, bufferToSamples, rms, TARGET_FRAMES } = require('../src/utils/pcm');

test('converts a 10ms mono 48k PCM frame without changing its length', () => {
  const source = new Int16Array(TARGET_FRAMES).fill(1000);
  const result = toMono48k({ samples: source, sampleRate: 48000, channelCount: 1 });
  assert.equal(result.length, TARGET_FRAMES);
  assert.equal(result[100], 1000);
});

test('downmixes stereo PCM to mono', () => {
  const stereo = new Int16Array(960);
  for (let i = 0; i < 480; i += 1) {
    stereo[i * 2] = 1000;
    stereo[i * 2 + 1] = 3000;
  }
  const mono = toMono48k({ samples: stereo, sampleRate: 48000, channelCount: 2 });
  assert.equal(mono.length, 480);
  assert.equal(mono[20], 2000);
});

test('PCM buffer conversion is little-endian and reversible', () => {
  const source = new Int16Array([-32768, -1, 0, 1, 32767]);
  assert.deepEqual([...bufferToSamples(pcmToBuffer(source))], [...source]);
});

test('volume scaling and RMS behave as expected', () => {
  const source = new Int16Array(480).fill(10000);
  assert.equal(scalePcm(source, 0.5)[0], 5000);
  assert.ok(rms(source) > 0.25);
});
