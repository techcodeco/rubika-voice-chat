'use strict';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForState(readState, accepted, { timeoutMs = 30000, intervalMs = 100, label = 'operation' } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const state = readState();
      if (accepted.includes(state)) {
        clearInterval(timer);
        resolve(state);
      } else if (['failed', 'closed'].includes(state)) {
        clearInterval(timer);
        reject(new Error(`${label} entered state: ${state}`));
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`${label} timed out after ${timeoutMs}ms (last state: ${state})`));
      }
    }, intervalMs);
  });
}

module.exports = { delay, waitForState };
