'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cryptoJS = require('crypto-js');
const Encryption = require('../src/rubika/encryption');
const { secret, loadPrivateKeyFromBase64 } = require('../src/rubika/encryption');

function makeRsaPair(modulusLength = 1024) {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
}

test('changeAuthType follows the supplied character mapping exactly', () => {
  const input = 'abcdefghijklmnopqrstuvwx12345678';
  let expected = '';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = lowercase.toUpperCase();
  const digits = '0123456789';
  for (const char of input) {
    if (lowercase.includes(char)) expected += String.fromCharCode(((32 - (char.charCodeAt(0) - 97)) % 26) + 97);
    else if (uppercase.includes(char)) expected += String.fromCharCode(((29 - (char.charCodeAt(0) - 65)) % 26) + 65);
    else if (digits.includes(char)) expected += String.fromCharCode(((13 - (char.charCodeAt(0) - 48)) % 10) + 48);
    else expected += char;
  }
  assert.equal(Encryption.changeAuthType(input), expected);
  assert.equal(Encryption.changeAuthType(input).length, input.length);
});

test('secret follows the supplied 8/8/8/8 rearrangement and character shifts', () => {
  const auth = 'aaaaaaaa11111111bbbbbbbb22222222';
  assert.equal(secret(auth).length, 32);
  const t = auth.substring(0, 8);
  const i = auth.substring(8, 16);
  const rearranged = auth.substring(16, 24) + t + auth.substring(24, 32) + i;
  let expected = '';
  for (const char of rearranged) {
    if (char >= '0' && char <= '9') expected += String.fromCharCode(((char.charCodeAt(0) - 48 + 5) % 10) + 48);
    else expected += String.fromCharCode(((char.charCodeAt(0) - 97 + 9) % 26) + 97);
  }
  assert.equal(secret(transformed), expected);
});

test('AES output is exactly CryptoJS.AES.encrypt with Utf8 key, zero Hex IV and default padding', () => {
  const auth = Encryption.changeAuthType('aaaaaaaa11111111bbbbbbbb22222222');
  const encryption = new Encryption(auth, null);
  const message = JSON.stringify({ method: 'joinGroupVoiceChat', input: { chat_guid: 'g' } });
  const keyHex = cryptoJS.enc.Utf8.parse(secret(auth));
  const ivHex = cryptoJS.enc.Hex.parse('00000000000000000000000000000000');
  const expected = cryptoJS.AES.encrypt(message, keyHex, { iv: ivHex }).toString();
  assert.equal(encryption.encrypt(message), expected);
  assert.equal(encryption.decrypt(expected), message);
});

test('RSA-SHA256 signs the exact Base64 data_enc string', () => {
  const { privateKey, publicKey } = makeRsaPair();
  const auth = 'aaaaaaaa11111111bbbbbbbb22222222';
  const encryption = new Encryption(auth, privateKey);
  const dataEnc = 'bixaa9RBVemnLBs5qb5TArPPQSo9BnGN/GUrkKEfIrCCBaB0FP+O3b9Le6afly83x8Gh+PK9a4lw32mwq/OA7aXlrGGa73TQckxwP8tJ5d0j17JBkyTwiOYQZZ43ue/hbgWOYIbFkvqHwKZb3FhGdYaYSOr/X9OL9xqeutw3MnnpOIUA63j1bqUaR7EOHUvWSAH2XWyUHCcY0eO8UHoCmIm9fIjT3NRPfrtN9+jrQLfAZIAcw6thHCv7Kk2jABj1ypRUhbmK3fLlWxFayalAkuVMUZex6aWh0dR0gvbUTmk=';
  const signature = encryption.makeSignFromData(dataEnc);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(dataEnc);
  assert.equal(verifier.verify(publicKey, signature, 'base64'), true);
});

test('PEM literal \n sequences are normalized for RSA signing', () => {
  const { privateKey } = makeRsaPair();
  const escapedPem = privateKey.replace(/\n/g, '\\n');
  const encryption = new Encryption('aaaaaaaa11111111bbbbbbbb22222222', escapedPem);
  assert.equal(encryption.keypair, privateKey);
});

test('Base64 pk JSON is unwrapped and changeAuthType(auth) is used for AES derivation', () => {
  const { privateKey, publicKey } = makeRsaPair();
  const pk = Buffer.from(JSON.stringify({ version: '6', d: privateKey })).toString('base64');
  assert.equal(loadPrivateKeyFromBase64(pk), privateKey);

  const auth = 'aaaaaaaa11111111bbbbbbbb22222222';
  const encryption = Encryption.fromCredentials({ auth, privateKeyB64: pk });
  const expected = new Encryption(Encryption.changeAuthType(auth), privateKey);
  const incorrectRawAuth = new Encryption(auth, privateKey);
  assert.equal(encryption.key, expected.key);
  assert.notEqual(encryption.key, incorrectRawAuth.key);
  const signature = encryption.makeSignFromData('sample-data_enc');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update('sample-data_enc');
  assert.equal(verifier.verify(publicKey, signature, 'base64'), true);
});

test('decryptRsaOaep uses Node RSA-OAEP default hash/padding from supplied class', () => {
  const { privateKey, publicKey } = makeRsaPair(2048);
  const message = 'session-key-material';
  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(message, 'utf8'),
  ).toString('base64');
  assert.equal(Encryption.decryptRsaOaep(privateKey, encrypted), message);
});

test('rsaKeyGenerate returns transformed Base64 PKCS#1 public PEM and private PEM', () => {
  const generated = Encryption.rsaKeyGenerate();
  const restoredPublicB64 = invertChangeAuthType(generated.publicKey);
  const publicPem = Buffer.from(restoredPublicB64, 'base64').toString('binary');
  assert.match(publicPem, /BEGIN RSA PUBLIC KEY/);
  assert.match(generated.privateKey, /BEGIN RSA PRIVATE KEY/);
});

function invertChangeAuthType(value) {
  // Inverse mapping for the three character classes used by changeAuthType.
  let output = '';
  for (const char of value) {
    if (char >= 'a' && char <= 'z') output += String.fromCharCode(((6 - (char.charCodeAt(0) - 97) + 26) % 26) + 97);
    else if (char >= 'A' && char <= 'Z') output += String.fromCharCode(((3 - (char.charCodeAt(0) - 65) + 26) % 26) + 65);
    else if (char >= '0' && char <= '9') output += String.fromCharCode(((3 - (char.charCodeAt(0) - 48) + 10) % 10) + 48);
    else output += char;
  }
  return output;
}
