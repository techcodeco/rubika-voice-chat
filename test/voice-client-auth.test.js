'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceClient } = require('../src/core/voice-client');

function eventClient() {
  const client = Object.create(VoiceClient.prototype);
  Object.assign(client, new EventEmitter());
  return client;
}

test('_resolveSelfObjectGuid uses getUserInfo with user_guid undefined and persists data.user.user_guid', async () => {
  const client = eventClient();
  client.credentials = { auth: 'auth', selfObjectGuid: '' };
  client.config = { selfObjectGuid: '' };
  client.sessionName = 'test-session';
  const calls = [];
  const saved = [];
  client._request = async (method, input) => {
    calls.push({ method, input });
    return { status: 'OK', data: { user: { user_guid: 'u-self' } } };
  };
  client.sessionStore = { save: (...args) => saved.push(args) };

  const guid = await client._resolveSelfObjectGuid();
  assert.equal(guid, 'u-self');
  assert.deepEqual(calls, [{ method: 'getUserInfo', input: { user_guid: undefined } }]);
  assert.equal(client.credentials.selfObjectGuid, 'u-self');
  assert.equal(client.config.selfObjectGuid, 'u-self');
  assert.equal(saved.length, 1);
});

test('loading a previously created session never calls registerDevice again, even after app version changes', async () => {
  const client = eventClient();
  client.closed = false;
  client.apiClient = null;
  client.sessionMode = true;
  client.sessionName = 'persisted-session';
  client.readyPromise = null;
  client.credentials = { auth: 'auth', authMode: 'created-session', registeredAppVersion: 'WB_OLD_VERSION' };
  client._initializeApi = () => { client.apiClient = { ready: true }; return client.apiClient; };
  client._expectedAppVersion = () => 'WB_NEW_VERSION';
  let registerCalls = 0;
  client._registerDevice = async credentials => { registerCalls += 1; return credentials; };

  const api = await client._ensureReady();
  assert.deepEqual(api, { ready: true });
  assert.equal(registerCalls, 0);
});
