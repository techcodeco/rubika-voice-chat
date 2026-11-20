'use strict';

function loadWrtc() {
  try {
    const wrtc = require('@roamhq/wrtc');
    const audio = wrtc.nonstandard || {};
    if (!wrtc.RTCPeerConnection || !audio.RTCAudioSource || !audio.RTCAudioSink) {
      throw new Error('The installed WebRTC package does not expose RTCPeerConnection, RTCAudioSource and RTCAudioSink.');
    }
    return { ...wrtc, RTCAudioSource: audio.RTCAudioSource, RTCAudioSink: audio.RTCAudioSink };
  } catch (error) {
    throw new Error(
      `Could not load @roamhq/wrtc: ${error.message}. ` +
      'Use a supported Node.js/platform combination and reinstall dependencies. Node 22 x64 is the most conservative tested target for this package.',
    );
  }
}

module.exports = { loadWrtc };
