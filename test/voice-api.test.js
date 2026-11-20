'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceApi } = require('../src/rubika/voice-api');

test('resolves a group voice chat from group GUID without caller-supplied voiceChatId', async () => {
  const calls = [];
  const api = {
    async request(method, input) {
      calls.push([method, input]);
      if (method === 'getGroupInfo') return { status: 'OK', data: { chat: { object_guid: 'g0', group_voice_chat_id: 'vc-1' } } };
      if (method === 'getGroupVoiceChat') return { status: 'OK', data: { is_exist: true, group_voice_chat: { voice_chat_id: 'vc-1', state: 'Active' } } };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const result = await new VoiceApi(api).resolveGroupVoiceChat('g0');
  assert.equal(result.chatGuid, 'g0');
  assert.equal(result.voiceChatId, 'vc-1');
  assert.equal(result.created, false);
  assert.deepEqual(calls, [
    ['getGroupInfo', { group_guid: 'g0' }],
    ['getGroupVoiceChat', { chat_guid: 'g0', voice_chat_id: 'vc-1' }],
  ]);
});

test('creates a voice chat when group info has no active voice_chat_id', async () => {
  const calls = [];
  const api = {
    async request(method, input) {
      calls.push([method, input]);
      if (method === 'getGroupInfo') return { status: 'OK', data: { chat: { object_guid: 'g1' } } };
      if (method === 'createGroupVoiceChat') return { status: 'Done', data: { group_voice_chat_update: { group_voice_chat: { voice_chat_id: 'vc-new' } } } };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const result = await new VoiceApi(api).resolveGroupVoiceChat('g1');
  assert.equal(result.voiceChatId, 'vc-new');
  assert.equal(result.created, true);
  assert.deepEqual(calls.map(call => call[0]), ['getGroupInfo', 'createGroupVoiceChat']);
});

test('does not create a voice chat when createIfMissing is false', async () => {
  const api = { request: async method => {
    assert.equal(method, 'getGroupInfo');
    return { status: 'OK', data: { chat: { object_guid: 'g2' } } };
  } };
  await assert.rejects(() => new VoiceApi(api).resolveGroupVoiceChat('g2', { createIfMissing: false }), { code: 'VOICE_CHAT_NOT_FOUND' });
});
