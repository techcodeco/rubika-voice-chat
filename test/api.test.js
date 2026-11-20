'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Encryption } = require('../src/rubika/encryption');
const { RubikaApi } = require('../src/rubika/rubika-api');

function makeApi(fetchImpl) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const auth = 'aaaaaaaa11111111bbbbbbbb22222222';
  const encryption = new Encryption(Encryption.changeAuthType(auth), privateKey);
  const config = {
    url: 'https://example.invalid/', version: '6', auth, timeoutMs: 1000,
    client: { app_name: 'Main', app_version: '4.4.34', platform: 'Web', package: 'web.rubika.ir', lang_code: 'fa' },
  };
  return new RubikaApi({ config, encryption, fetchImpl });
}

test('buildRequestBody encrypts method/input/client and signs data_enc', () => {
  const api = makeApi(async () => { throw new Error('not called'); });
  const body = api.buildRequestBody('joinGroupVoiceChat', { chat_guid: 'g' });
  assert.deepEqual(Object.keys(body), ['api_version', 'auth', 'data_enc', 'sign']);
  assert.equal(body.auth, api.config.auth);
  const plaintext = api.encryption.decrypt(body.data_enc);
  const parsed = JSON.parse(plaintext);
  assert.equal(parsed.method, 'joinGroupVoiceChat');
  assert.equal(parsed.input.chat_guid, 'g');
  assert.equal(parsed.client.platform, 'Web');
  assert.ok(body.sign.length > 40);
});

test('request parses already-decrypted response JSON', async () => {
  const api = makeApi(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.api_version, '6');
    assert.equal(options.headers['Content-Type'], 'text/plain');
    assert.equal(options.headers.Accept, 'application/json, text/plain, */*');
    assert.match(options.headers['User-Agent'], /^Mozilla\/5.0/);
    assert.equal(options.headers.Referer, 'https://web.rubika.ir/');
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'OK', data: { value: 7 } }) };
  });
  const response = await api.request('getGroupVoiceChat', { voice_chat_id: 'v' });
  assert.equal(response.data.value, 7);
});


test('random API DC selection matches jsrubi range c1..c269', () => {
  const api = makeApi(async () => { throw new Error('not called'); });
  api.config.url = null;
  api.config.randomDc = true;
  api.config.dcMin = 1;
  api.config.dcMax = 269;
  api.random = () => 0;
  assert.equal(api.getRequestUrl(), 'https://messengerg2c1.iranlms.ir/');
  api.random = () => 0.999999;
  assert.equal(api.getRequestUrl(), 'https://messengerg2c269.iranlms.ir/');
});

test('network retry chooses a fresh random API DC and reuses the signed body', async () => {
  const urls = [];
  const serializedBodies = [];
  let randomCall = 0;
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const auth = 'aaaaaaaa11111111bbbbbbbb22222222';
  const encryption = new Encryption(Encryption.changeAuthType(auth), privateKey);
  const api = new RubikaApi({
    config: {
      url: null, randomDc: true, dcMin: 1, dcMax: 269, maxAttempts: 2,
      version: '6', auth, timeoutMs: 1000,
      client: { app_name: 'Main', app_version: '4.4.34', platform: 'Web', package: 'web.rubika.ir', lang_code: 'fa' },
    },
    encryption,
    random: () => (randomCall++ === 0 ? 0 : 0.999999),
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      urls.push(url);
      serializedBodies.push(options.body);
      if (urls.length === 1) throw new Error('temporary network error');
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'OK', data: { value: 9 } }) };
    },
  });

  const result = await api.request('getGroupVoiceChat', { chat_guid: 'g', voice_chat_id: 'v' });
  assert.equal(result.data.value, 9);
  assert.deepEqual(urls, [
    'https://messengerg2c1.iranlms.ir/',
    'https://messengerg2c269.iranlms.ir/',
  ]);
  assert.equal(serializedBodies[0], serializedBodies[1]);
});


test('matches jsrubi Base64-pk constructor path and keeps envelope Auth unchanged', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const auth = 'aaaaaaaa11111111bbbbbbbb22222222';
  const privateKeyB64 = Buffer.from(JSON.stringify({ version: '6', d: privateKey })).toString('base64');
  const api = new RubikaApi({
    config: {
      url: 'https://example.invalid/', version: '6', auth, privateKeyB64,
      client: { app_name: 'Main', app_version: '4.4.34', platform: 'Web', package: 'web.rubika.ir', lang_code: 'fa' },
    },
    fetchImpl: async () => { throw new Error('not called'); },
  });
  const body = api.buildRequestBody('getGroupVoiceChat', { chat_guid: 'g' });
  assert.equal(body.auth, auth);
  const base64PkPathEncryption = new Encryption(Encryption.changeAuthType(auth), privateKey);
  const decoded = JSON.parse(base64PkPathEncryption.decrypt(body.data_enc));
  assert.equal(decoded.method, 'getGroupVoiceChat');
});

test('decodes the encrypted data_enc response with the configured Base64-pk Encryption key', () => {
  const api = makeApi(async () => { throw new Error('not called'); });
  const encryptedResponse = api.encryption.encrypt(JSON.stringify({
    status: 'OK',
    status_det: 'OK',
    data: { sdp_answer_data: 'v=0\r\ns=AudioBridge 33420033\r\n' },
  }));
  const decoded = api.decodeResponseBody(JSON.stringify({ data_enc: encryptedResponse }));
  assert.equal(decoded.data.sdp_answer_data, 'v=0\r\ns=AudioBridge 33420033\r\n');
});
