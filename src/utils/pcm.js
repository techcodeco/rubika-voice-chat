'use strict';

const TARGET_RATE = 48000;
const TARGET_FRAMES = 480; // 10 ms at 48 kHz

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function toMono48k(data) {
  if (!data || !data.samples) throw new TypeError('PCM data is missing samples');
  let source;
  if (data.samples instanceof Int16Array) {
    source = data.samples;
  } else if (Buffer.isBuffer(data.samples)) {
    const length = data.samples.length - (data.samples.length % 2);
    source = new Int16Array(length / 2);
    for (let i = 0; i < source.length; i += 1) source[i] = data.samples.readInt16LE(i * 2);
  } else if (ArrayBuffer.isView(data.samples)) {
    source = new Int16Array(data.samples.buffer, data.samples.byteOffset, Math.floor(data.samples.byteLength / 2));
  } else {
    source = new Int16Array(data.samples);
  }
  const channels = Math.max(1, Number(data.channelCount || 1));
  const sampleRate = Math.max(8000, Number(data.sampleRate || TARGET_RATE));
  const sourceFrames = Math.floor(source.length / channels);
  if (!sourceFrames) return new Int16Array(TARGET_FRAMES);

  const mono = new Float32Array(sourceFrames);
  for (let frame = 0; frame < sourceFrames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += source[frame * channels + channel] || 0;
    }
    mono[frame] = sum / channels;
  }

  const output = new Int16Array(TARGET_FRAMES);
  const ratio = sampleRate / TARGET_RATE;
  for (let i = 0; i < TARGET_FRAMES; i += 1) {
    const position = i * ratio;
    const left = Math.min(sourceFrames - 1, Math.floor(position));
    const right = Math.min(sourceFrames - 1, left + 1);
    const fraction = position - left;
    output[i] = clamp16(mono[left] * (1 - fraction) + mono[right] * fraction);
  }
  return output;
}

function scalePcm(samples, volume) {
  const gain = Math.max(0, Math.min(2, Number(volume)));
  const result = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) result[i] = clamp16(samples[i] * gain);
  return result;
}

function pcmToBuffer(samples) {
  const buffer = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) buffer.writeInt16LE(samples[i], i * 2);
  return buffer;
}

function bufferToSamples(buffer) {
  const alignedLength = buffer.length - (buffer.length % 2);
  const copy = buffer.subarray(0, alignedLength);
  const samples = new Int16Array(alignedLength / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = copy.readInt16LE(i * 2);
  return samples;
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

module.exports = {
  TARGET_RATE,
  TARGET_FRAMES,
  toMono48k,
  scalePcm,
  pcmToBuffer,
  bufferToSamples,
  rms,
};
