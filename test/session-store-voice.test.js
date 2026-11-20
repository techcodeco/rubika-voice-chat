'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../src/rubika/session-store');

test('stores encrypted session credentials and restores them', () => {
  const store = new SessionStore({ databasePath: ':memory:' });
  const credentials = {
    auth: 'raw-auth-value',
    authMode: 'created-session',
    privateKeyB64: Buffer.from('private-key-placeholder').toString('base64'),
    selfObjectGuid: 'u0',
    registeredAppVersion: 'WB_4.4.34',
  };
  store.save('voice-test', credentials);
  assert.deepEqual(store.get('voice-test').auth, credentials.auth);
  assert.equal(store.get('voice-test').selfObjectGuid, 'u0');
  assert.equal(store.delete('voice-test'), true);
  assert.equal(store.get('voice-test'), null);
  store.close();
});
