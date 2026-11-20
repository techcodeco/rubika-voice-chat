'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RubikaApi, RubikaApiError } = require('../src/rubika/rubika-api');

function createApi(response) {
  return new RubikaApi({
    config: { auth: 'auth', url: 'https://example.invalid/', version: '6', client: {} },
    encryption: { encrypt: () => 'cipher', decrypt: () => '', makeSignFromData: () => 'signature' },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(response) }),
  });
}

test('surfaces NOT_REGISTERED when returned as status_det', async () => {
  const api = createApi({ status: 'ERROR_GENERIC', status_det: 'NOT_REGISTERED' });
  await assert.rejects(() => api.request('getGroupInfo', { group_guid: 'g0' }), error => {
    assert.ok(error instanceof RubikaApiError);
    assert.equal(error.statusDet, 'NOT_REGISTERED');
    return true;
  });
});

test('surfaces TOO_REQUESTS without retrying as a transport failure', async () => {
  let calls = 0;
  const api = createApi({ status: 'ERROR_GENERIC', status_det: 'TOO_REQUESTS' });
  api.fetch = async () => { calls += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ERROR_GENERIC', status_det: 'TOO_REQUESTS' }) }; };
  await assert.rejects(() => api.request('getGroupInfo', { group_guid: 'g0' }), error => error.statusDet === 'TOO_REQUESTS');
  assert.equal(calls, 1);
});

test('accepts VoiceChatExist as a method-specific createGroupVoiceChat result', async () => {
  const api = createApi({ status: 'VoiceChatExist', data: { exist_group_voice_chat: { voice_chat_id: 'vc0' } } });
  const result = await api.request('createGroupVoiceChat', { chat_guid: 'g0' });
  assert.equal(result.data.exist_group_voice_chat.voice_chat_id, 'vc0');
});
