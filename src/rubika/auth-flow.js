'use strict';

const crypto = require('node:crypto');
function defaultRandomApiUrl(min = 1, max = 269, random = Math.random) {
  const first = Math.max(1, Math.trunc(min));
  const last = Math.min(269, Math.trunc(max));
  if (last < first) throw new RangeError('Rubika API DC range is invalid.');
  const dc = first + Math.floor(random() * (last - first + 1));
  return `https://messengerg2c${dc}.iranlms.ir/`;
}
const { createCliPrompts } = require('../utils/cli-prompts');

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

function unwrapResponse(response) {
  if (!response || typeof response !== 'object' || !response.data || typeof response.data !== 'object') {
    return response;
  }

  // Keep the outer transport status and flatten payload fields for backwards
  // compatibility, but retain the original `data` object. Rubika may return
  // business states such as SendPassKey/InvalidPassKey/CodeIsInvalid inside
  // data.status while the envelope status remains OK.
  return {
    ...response.data,
    ...response,
    data: response.data,
  };
}

function normalizePhoneNumber(value) {
  const phone = String(value || '').trim().replace(/[^\d]/g, '');
  if (phone.length < 7 || phone.length > 15) {
    throw new TypeError('Enter a valid international phone number containing 7 to 15 digits (country code included).');
  }
  return phone;
}

function makeTemporarySession(randomBytes = crypto.randomBytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(32);
  let output = '';
  for (const byte of bytes) output += alphabet[byte % alphabet.length];
  return output;
}

function normalizePrivateKeyB64(privateKey) {
  if (typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new TypeError('A private key is required.');
  }
  const value = privateKey.trim();
  if (value.includes('PRIVATE KEY-----')) {
    return Buffer.from(JSON.stringify({ version: '6', d: value }), 'utf8').toString('base64');
  }
  return value;
}

class RubikaAuthFlow {
  constructor({ apiConfig, fetchImpl = globalThis.fetch, logger, Encryption: EncryptionClass, random = Math.random, randomBytes = crypto.randomBytes } = {}) {
    if (!apiConfig) throw new TypeError('RubikaAuthFlow requires apiConfig.');
    if (typeof fetchImpl !== 'function') throw new Error('fetch() is required for Rubika authentication.');
    this.apiConfig = apiConfig;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.Encryption = EncryptionClass || require('./encryption').Encryption;
    this.random = random;
    this.randomBytes = randomBytes;
    this.temporarySession = makeTemporarySession(randomBytes);
    this.temporaryEncryption = new this.Encryption(this.temporarySession);
  }

  _url() {
    if (this.apiConfig.url) return this.apiConfig.url;
    return defaultRandomApiUrl(this.apiConfig.dcMin ?? 1, this.apiConfig.dcMax ?? 269, this.random);
  }

  async request(method, input = {}, { timeoutMs = this.apiConfig.timeoutMs || 20000, signal } = {}) {
    const plaintext = JSON.stringify({ method, input: input ?? {}, client: this.apiConfig.client });
    // The temp session and ciphertext remain identical across retries; only
    // the random API DC changes, just as in the authenticated request layer.
    const body = {
      api_version: '6',
      tmp_session: this.temporarySession,
      data_enc: this.temporaryEncryption.encrypt(plaintext),
    };
    const attempts = Math.max(1, Math.min(8, Number(this.apiConfig.maxAttempts) || 3));
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Rubika authentication request timed out.')), timeoutMs);
      timeout.unref?.();
      const abort = () => controller.abort(signal.reason);
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', abort, { once: true });
      }
      const url = this._url();

      try {
        const response = await this.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            Accept: 'application/json, text/plain, */*',
            'User-Agent': this.apiConfig.userAgent,
            Referer: this.apiConfig.referer || 'https://web.rubika.ir/',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const rawText = await response.text();
        const envelope = parseJson(rawText, `Rubika ${method}`);
        let decoded = envelope;
        if (typeof envelope?.data_enc === 'string') {
          const plaintextResponse = this.temporaryEncryption.decrypt(envelope.data_enc);
          if (!plaintextResponse) throw new Error(`Could not decrypt the unauthenticated response for ${method}.`);
          decoded = parseJson(plaintextResponse, `Decrypted Rubika ${method}`);
        }
        decoded = unwrapResponse(decoded);
        if (!response.ok) {
          const error = new Error(`Rubika ${method} failed with HTTP ${response.status}.`);
          error.status = decoded?.status;
          error.statusDet = decoded?.status_det;
          error.response = decoded;
          error.httpStatus = response.status;
          if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && attempt < attempts) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, Math.min(250 * (2 ** (attempt - 1)), 2000)));
            continue;
          }
          throw error;
        }
        this.logger?.debug('Rubika unauthenticated request completed', { method, status: decoded?.status || 'unknown' });
        return decoded;
      } catch (error) {
        if (signal?.aborted) throw new Error(`Rubika ${method} authentication request was aborted.`, { cause: error });
        lastError = error;
        const retryable = !error.httpStatus || [408, 425, 429, 500, 502, 503, 504].includes(error.httpStatus);
        if (!retryable || attempt >= attempts) throw error;
        this.logger?.warn('Rubika unauthenticated request failed; retrying', { method, attempt, message: error.message });
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * (2 ** (attempt - 1)), 2000)));
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', abort);
      }
    }
    throw lastError || new Error(`Rubika ${method} request failed.`);
  }

  _resultStatus(result) {
    const nestedStatus = result?.data?.status;
    if (nestedStatus && !['OK', 'DONE'].includes(String(nestedStatus).toUpperCase())) {
      return String(nestedStatus);
    }
    return String(result?.status ?? nestedStatus ?? 'UNKNOWN_STATUS');
  }

  _assertOk(result, operation) {
    if (!result || this._resultStatus(result) !== 'OK') throw this._statusError(result, operation);
  }

  async _requestLoginCode(phoneNumber, twoStepPassword, signal) {
    const input = { phone_number: phoneNumber, send_type: 'SMS' };
    if (twoStepPassword) input.pass_key = String(twoStepPassword);
    return this.request('sendCode', input, { signal });
  }

  _statusError(result, operation) {
    const status = this._resultStatus(result);
    const statusDet = result?.data?.status_det ?? result?.status_det;
    const detail = statusDet ? ` / ${statusDet}` : '';
    const error = new Error(`Rubika ${operation} failed: ${status}${detail}.`);
    error.status = status;
    error.statusDet = statusDet;
    error.response = result;
    return error;
  }

  _readHintPassKey(result) {
    return result?.data?.hint_pass_key ?? result?.hint_pass_key ?? '';
  }

  _isPasswordStatus(result) {
    const statuses = new Set([
      'SendPassKey', 'InvalidPassKey', 'PASSWORD_HASH_INVALID', 'PasswordHashInvalid',
    ]);
    return statuses.has(this._resultStatus(result))
      || statuses.has(String(result?.status_det ?? ''))
      || statuses.has(String(result?.data?.status_det ?? ''));
  }

  async _obtainCode(phoneNumber, prompts, providedPassword, signal) {
    let result = await this._requestLoginCode(phoneNumber, undefined, signal);
    let attempts = 0;
    let nextPassword = providedPassword;
    while (this._isPasswordStatus(result)) {
      if (attempts >= 3) throw new Error('The two-step password was rejected too many times.');
      if (typeof prompts.twoStepPassword !== 'function' && nextPassword === undefined) {
        throw new Error('Rubika requires a two-step verification password, but no password prompt was configured.');
      }
      const hintPassKey = this._readHintPassKey(result);
      const password = nextPassword ?? await prompts.twoStepPassword(hintPassKey);
      nextPassword = undefined;
      if (password === undefined || password === null || String(password).length === 0) {
        throw new Error('Two-step verification password cannot be empty.');
      }
      result = await this._requestLoginCode(phoneNumber, String(password), signal);
      attempts += 1;
    }
    this._assertOk(result, 'sendCode');
    if (!result.phone_code_hash) throw new Error('sendCode returned OK but did not include phone_code_hash.');
    return result;
  }

  _normalizeLoginCode(value, digitsCount) {
    const loginCode = String(value ?? '').trim().replace(/\s/g, '');
    if (!/^\d+$/.test(loginCode)) throw new TypeError('The one-time login code must contain digits only.');
    if (digitsCount && loginCode.length !== Number(digitsCount)) {
      throw new TypeError(`The one-time login code must contain ${digitsCount} digits.`);
    }
    return loginCode;
  }

  async login({ phoneNumber, code, twoStepPassword, prompts, signal } = {}) {
    const promptSet = { ...createCliPrompts(), ...(prompts || {}) };
    const phone = normalizePhoneNumber(phoneNumber ?? await promptSet.phoneNumber());
    this.logger?.info('Starting Rubika login flow', { phoneNumber: `${phone.slice(0, 2)}******${phone.slice(-2)}` });

    let codeInfo = await this._obtainCode(phone, promptSet, twoStepPassword, signal);
    let loginCode = this._normalizeLoginCode(code ?? await promptSet.code(codeInfo.code_digits_count), codeInfo.code_digits_count);
    const keyPair = this.Encryption.rsaKeyGenerate();
    let signInResult;
    let signInAttempts = 0;

    while (!signInResult) {
      if (signInAttempts >= 5) throw new Error('Rubika signIn failed too many times while requesting a valid login code.');
      signInAttempts += 1;
      try {
        const candidate = await this.request('signIn', {
          phone_number: phone,
          phone_code_hash: codeInfo.phone_code_hash,
          phone_code: loginCode,
          public_key: keyPair.publicKey,
        }, { signal });
        this._assertOk(candidate, 'signIn');
        signInResult = candidate;
      } catch (error) {
        const status = String(error?.status || error?.response?.status || '').trim();
        if (status === 'CodeIsInvalid') {
          this.logger?.warn('Rubika rejected the login code as invalid.');
          loginCode = this._normalizeLoginCode(await promptSet.code(codeInfo.code_digits_count), codeInfo.code_digits_count);
          continue;
        }
        if (status === 'CodeIsUsed') {
          this.logger?.warn('Rubika reports that the login code has already been used; requesting a new code.');
          codeInfo = await this._obtainCode(phone, promptSet, undefined, signal);
          loginCode = this._normalizeLoginCode(await promptSet.code(codeInfo.code_digits_count), codeInfo.code_digits_count);
          continue;
        }
        throw error;
      }
    }

    if (typeof signInResult.auth !== 'string' || !signInResult.auth) {
      throw new Error('signIn returned OK but did not include the encrypted auth token.');
    }

    const decryptAuth = this.Encryption.decryptOAEPAuth || this.Encryption.decryptRsaOaep;
    if (typeof decryptAuth !== 'function') {
      throw new Error('Encryption must implement decryptOAEPAuth(privateKey, encryptedAuth).');
    }
    const auth = decryptAuth.call(this.Encryption, keyPair.privateKey, signInResult.auth);
    if (typeof auth !== 'string' || !auth) throw new Error('Could not decrypt the auth token from signIn.');
    const privateKeyB64 = Buffer.from(JSON.stringify({ version: '6', d: keyPair.privateKey }), 'utf8').toString('base64');
    const user = signInResult.user || signInResult.user_info || null;
    const selfObjectGuid = signInResult.self_object_guid || user?.user_guid || user?.object_guid || '';

    return {
      auth,
      authMode: 'created-session',
      privateKeyB64,
      selfObjectGuid,
      user,
      deviceHash: crypto.randomUUID(),
    };
  }

  static normalizePrivateKeyB64(value) { return normalizePrivateKeyB64(value); }
}

module.exports = { RubikaAuthFlow, normalizePhoneNumber, normalizePrivateKeyB64, makeTemporarySession };
