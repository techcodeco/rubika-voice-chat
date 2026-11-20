'use strict';

// This module intentionally mirrors the Encryption class supplied by the user.
// Do not replace CryptoJS AES with a different serialization/derivation scheme.
const cryptoJS = require('crypto-js');
const crypto = require('crypto');
const NodeRSAExport = require('node-rsa');
const RSA = NodeRSAExport.default || NodeRSAExport;

function replaceCharAt(e, t, i) {
  return e.substring(0, t) + i + e.substring(t + i.length);
}

function secret(e) {
  const t = e.substring(0, 8);
  const i = e.substring(8, 16);
  let n = e.substring(16, 24) + t + e.substring(24, 32) + i;
  let s = 0;
  while (s < n.length) {
    const char = n[s];
    if (char >= '0' && char <= '9') {
      const t = String.fromCharCode(
        ((char.charCodeAt(0) - '0'.charCodeAt(0) + 5) % 10) + '0'.charCodeAt(0),
      );
      n = replaceCharAt(n, s, t);
    } else {
      const t = String.fromCharCode(
        ((char.charCodeAt(0) - 'a'.charCodeAt(0) + 9) % 26) + 'a'.charCodeAt(0),
      );
      n = replaceCharAt(n, s, t);
    }
    s += 1;
  }
  return n;
}

/**
 * Decode the user's Base64 `pk` value.
 * The supplied format is Base64(JSON.stringify({ version: '6', d: PEM })).
 * The Encryption constructor itself still receives the PEM, as in the
 * original class; this adapter only unwraps the transport representation.
 */
function loadPrivateKeyFromBase64(pk) {
  const decoded = Buffer.from(pk, 'base64').toString('utf8');
  let privateKey = decoded;

  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.d === 'string') {
      privateKey = parsed.d;
    }
  } catch {
    // Also allow a Base64-encoded PEM, although the supplied pk format is JSON.
  }

  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('pk must be Base64(JSON with a PEM string in property d).');
  }

  return privateKey;
}

class Encryption {
  constructor(auth, private_key = null) {
    this.auth = auth;
    this.key = Buffer.from(secret(auth), 'utf-8').toString();
    this.iv = '00000000000000000000000000000000';
    if (private_key) {
      this.keypair = private_key.replace(/\\n/g, '\n').replace(/\\\n/g, '\n');
    }
  }

  static changeAuthType(auth_enc) {
    let n = '';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = lowercase.toUpperCase();
    const digits = '0123456789';
    for (const s of auth_enc) {
      if (lowercase.includes(s)) {
        n += String.fromCharCode(((32 - (s.charCodeAt(0) - 97)) % 26) + 97);
      } else if (uppercase.includes(s)) {
        n += String.fromCharCode(((29 - (s.charCodeAt(0) - 65)) % 26) + 65);
      } else if (digits.includes(s)) {
        n += String.fromCharCode(((13 - (s.charCodeAt(0) - 48)) % 10) + 48);
      } else {
        n += s;
      }
    }
    return n;
  }

  encrypt(text) {
    const keyHex = cryptoJS.enc.Utf8.parse(this.key);
    const ivHex = cryptoJS.enc.Hex.parse(this.iv);
    const encrypted = cryptoJS.AES.encrypt(text, keyHex, {
      iv: ivHex,
    });
    return encrypted.toString();
  }

  decrypt(text) {
    const keyHex = cryptoJS.enc.Utf8.parse(this.key);
    const ivHex = cryptoJS.enc.Hex.parse(this.iv);

    try {
      const decrypted = cryptoJS.AES.decrypt(text, keyHex, {
        iv: ivHex,
      });
      const decryptedText = decrypted.toString(cryptoJS.enc.Utf8);
      return decryptedText;
    } catch (e) {
      console.log('Decryption failed:', e.message);
      return null;
    }
  }

  makeSignFromData(data) {
    try {
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(data);
      const signature = signer.sign(this.keypair, 'base64');
      return signature;
    } catch (e) {
      console.log(e.message);
    }
  }

  static decryptRsaOaep(privateKey, data_enc) {
    const keyPair = crypto.createPrivateKey(privateKey);
    const dec = crypto.privateDecrypt(
      {
        key: keyPair,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(data_enc, 'base64'),
    );
    return dec.toString('utf-8');
  }

  static decryptOAEPAuth(privateKey, encryptedAuth) {
    return Encryption.decryptRsaOaep(privateKey, encryptedAuth);
  }

  static rsaKeyGenerate() {
    const keyPair = new RSA({ b: 1024 });
    const publicKey = Encryption.changeAuthType(
      Buffer.from(keyPair.exportKey('pkcs1-public-pem'), 'binary').toString('base64'),
    );
    const privateKey = keyPair.exportKey('pkcs1-private-pem');
    return {
      publicKey,
      privateKey,
    };
  }

  /**
   * Build Encryption using the Base64-pk constructor path from the supplied
   * jsrubi class:
   *   this.auth = auth
   *   this.enc = new Encryption(changeAuthType(auth), decodedPem)
   *
   * RubikaApi therefore sends the supplied auth unchanged in the HTTP
   * envelope, while this instance derives its AES key from changeAuthType(auth).
   */
  static fromCredentials({ auth, privateKeyB64 }) {
    const privateKeyPem = loadPrivateKeyFromBase64(privateKeyB64);
    const transformedAuth = Encryption.changeAuthType(auth);
    return new Encryption(transformedAuth, privateKeyPem);
  }
}

// Keep both export styles: the original class used `module.exports = Encryption`,
// while the project imports the named property `{ Encryption }`.
module.exports = Encryption;
module.exports.Encryption = Encryption;
module.exports.secret = secret;
module.exports.replaceCharAt = replaceCharAt;
module.exports.loadPrivateKeyFromBase64 = loadPrivateKeyFromBase64;
