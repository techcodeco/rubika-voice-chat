'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RubikaAuthFlow } = require('../src/rubika/auth-flow');
const { createCliPrompts } = require('../src/utils/cli-prompts');

class FakeEncryption {
  constructor(auth) { this.auth = auth; }
  encrypt(value) { return `enc:${value}`; }
  static rsaKeyGenerate() { return { publicKey: 'public-key', privateKey: 'private-key-pem' }; }
  static decryptOAEPAuth(_privateKey, value) { return value === 'encrypted-auth' ? 'decrypted-auth' : ''; }
}

function makeFlow() {
  return new RubikaAuthFlow({
    apiConfig: { client: {}, timeoutMs: 1000 },
    fetchImpl: async () => { throw new Error('Network must not be used by this test.'); },
    Encryption: FakeEncryption,
    randomBytes: size => Buffer.alloc(size, 1),
  });
}

test('real sendCode envelope preserves data.status=SendPassKey even when outer status is OK', async () => {
  const flow = makeFlow();
  const responses = [
    { status: 'OK', status_det: 'OK', data: { status: 'SendPassKey', hint_pass_key: 'registered number ends with 42' } },
    { status: 'OK', status_det: 'OK', data: { phone_code_hash: 'realistic-code-hash', code_digits_count: 5 } },
  ];
  flow.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data_enc: 'encrypted-response' }),
  });
  flow.temporaryEncryption.decrypt = () => JSON.stringify(responses.shift());

  const submitted = [];
  const result = await flow._obtainCode('989120000000', {
    twoStepPassword: async hint => {
      submitted.push(hint);
      return 'second-factor-secret';
    },
  }, undefined, undefined);

  assert.deepEqual(submitted, ['registered number ends with 42']);
  assert.equal(result.phone_code_hash, 'realistic-code-hash');
  assert.equal(result.data.phone_code_hash, 'realistic-code-hash');
});

test('nested data.status=InvalidPassKey requests the password again', async () => {
  const flow = makeFlow();
  const responses = [
    { status: 'OK', data: { status: 'SendPassKey', hint_pass_key: 'initial hint' } },
    { status: 'OK', data: { status: 'InvalidPassKey', hint_pass_key: 'try the other password' } },
    { status: 'OK', data: { phone_code_hash: 'accepted-hash', code_digits_count: 5 } },
  ];
  flow.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data_enc: 'encrypted-response' }),
  });
  flow.temporaryEncryption.decrypt = () => JSON.stringify(responses.shift());

  const hints = [];
  const passKeys = [];
  const result = await flow._obtainCode('989120000000', {
    twoStepPassword: async hint => {
      hints.push(hint);
      const password = hints.length === 1 ? 'wrong-password' : 'correct-password';
      passKeys.push(password);
      return password;
    },
  }, undefined, undefined);

  assert.deepEqual(hints, ['initial hint', 'try the other password']);
  assert.deepEqual(passKeys, ['wrong-password', 'correct-password']);
  assert.equal(result.phone_code_hash, 'accepted-hash');
});

test('two-step login passes the server hint to CLI and sends entered password as pass_key', async () => {
  const flow = makeFlow();
  const calls = [];
  flow.request = async (method, input) => {
    calls.push({ method, input });
    if (calls.length === 1) return { status: 'SendPassKey', data: { hint_pass_key: 'phone ending 42' } };
    return { status: 'OK', phone_code_hash: 'code-hash', code_digits_count: 5 };
  };
  const hints = [];
  const result = await flow._obtainCode('989120000000', {
    twoStepPassword: async hint => { hints.push(hint); return 'my-secret-password'; },
  }, undefined, undefined);

  assert.equal(result.phone_code_hash, 'code-hash');
  assert.deepEqual(hints, ['phone ending 42']);
  assert.equal(calls[0].method, 'sendCode');
  assert.equal(calls[0].input.pass_key, undefined);
  assert.equal(calls[1].method, 'sendCode');
  assert.equal(calls[1].input.pass_key, 'my-secret-password');
});

test('invalid second-factor password is retried with the latest hint', async () => {
  const flow = makeFlow();
  const calls = [];
  const responses = [
    { status: 'SendPassKey', data: { hint_pass_key: 'initial hint' } },
    { status: 'InvalidPassKey', data: { hint_pass_key: 'updated hint' } },
    { status: 'OK', phone_code_hash: 'hash-2', code_digits_count: 5 },
  ];
  flow.request = async (method, input) => {
    calls.push({ method, input });
    return responses.shift();
  };
  const hints = [];
  const result = await flow._obtainCode('989120000000', {
    twoStepPassword: async hint => {
      hints.push(hint);
      return hints.length === 1 ? 'wrong-password' : 'correct-password';
    },
  }, undefined, undefined);

  assert.equal(result.phone_code_hash, 'hash-2');
  assert.deepEqual(hints, ['initial hint', 'updated hint']);
  assert.equal(calls[1].input.pass_key, 'wrong-password');
  assert.equal(calls[2].input.pass_key, 'correct-password');
});

test('signIn retries CodeIsInvalid and requests a fresh code after CodeIsUsed', async () => {
  const flow = makeFlow();
  const calls = [];
  const responses = [
    { status: 'OK', phone_code_hash: 'hash-1', code_digits_count: 5 },
    { status: 'OK', data: { status: 'CodeIsInvalid' } },
    { status: 'OK', data: { status: 'CodeIsUsed' } },
    { status: 'OK', phone_code_hash: 'hash-2', code_digits_count: 5 },
    { status: 'OK', auth: 'encrypted-auth', user: { user_guid: 'u-self' } },
  ];
  flow.request = async (method, input) => {
    calls.push({ method, input });
    return responses.shift();
  };
  const submittedCodes = ['11111', '22222'];
  const credentials = await flow.login({
    phoneNumber: '989120000000',
    code: '00000',
    prompts: { code: async () => submittedCodes.shift() },
  });

  const signIns = calls.filter(call => call.method === 'signIn');
  const sendCodes = calls.filter(call => call.method === 'sendCode');
  assert.deepEqual(signIns.map(call => [call.input.phone_code_hash, call.input.phone_code]), [
    ['hash-1', '00000'],
    ['hash-1', '11111'],
    ['hash-2', '22222'],
  ]);
  assert.equal(sendCodes.length, 2);
  assert.equal(credentials.auth, 'decrypted-auth');
  assert.equal(credentials.selfObjectGuid, 'u-self');
});

test('CLI second-factor prompt displays hint in parentheses and masks entered password', async () => {
  class FakeInput extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.isRaw = false; }
    setRawMode(value) { this.isRaw = value; }
    resume() {}
  }
  const input = new FakeInput();
  const writes = [];
  const prompts = createCliPrompts({ input, output: { write: value => writes.push(value) } });
  const pending = prompts.twoStepPassword('account ending 42');
  input.emit('keypress', 's', { name: 's' });
  input.emit('keypress', 'e', { name: 'e' });
  input.emit('keypress', 'enter', { name: 'enter' });
  assert.equal(await pending, 'se');
  assert.ok(writes.join('').includes('(account ending 42)'));
  assert.ok(writes.join('').includes('**'));
  assert.ok(!writes.join('').includes('se'));
});
