'use strict';

const EncryptionDefault = require('./encryption');
const { loadPrivateKeyFromBase64 } = EncryptionDefault;

class RubikaApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RubikaApiError';
    this.method = details.method;
    this.httpStatus = details.httpStatus;
    this.status = details.status;
    this.statusDet = details.statusDet;
    this.url = details.url;
    this.response = details.response;
    this.cause = details.cause;
  }
}

function parseJson(value, label) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error.message}`);
  }
}

function normalizeUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Rubika API URL must use HTTPS.');
  return url.toString();
}

function defaultRandomApiUrl(min = 1, max = 269, random = Math.random) {
  const first = Math.max(1, Math.trunc(min));
  const last = Math.min(269, Math.trunc(max));
  if (last < first) throw new RangeError('RUBIKA_API_DC_MAX must be greater than or equal to RUBIKA_API_DC_MIN.');
  const dc = first + Math.floor(random() * (last - first + 1));
  return `https://messengerg2c${dc}.iranlms.ir/`;
}

class RubikaApi {
  constructor({ config, encryption, EncryptionClass, fetchImpl = globalThis.fetch, logger, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!config?.auth) throw new Error('RUBIKA_AUTH is required.');
    if (!config?.url && config?.randomDc === false) {
      throw new Error('Set RUBIKA_API_URL or enable RUBIKA_API_RANDOM_DC.');
    }
    if (!encryption) {
      if (!config.privateKeyB64) throw new Error('RUBIKA_PRIVATE_KEY_B64 is required.');
      const EncryptionImpl = EncryptionClass || EncryptionDefault;
      if (config.encryptionAuth !== undefined && config.encryptionAuth !== null) {
        const privateKeyPem = loadPrivateKeyFromBase64(config.privateKeyB64);
        encryption = new EncryptionImpl(config.encryptionAuth, privateKeyPem);
      } else {
        // Direct credentials: envelope keeps raw auth; AES derives from changeAuthType(auth).
        encryption = EncryptionImpl.fromCredentials({ auth: config.auth, privateKeyB64: config.privateKeyB64 });
      }
    }
    if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch(). Use Node.js 22 or newer.');
    this.config = config;
    this.encryption = encryption;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.random = random;
    this.sleep = sleep;
  }

  getRequestUrl() {
    if (this.config.url) return normalizeUrl(this.config.url);
    return defaultRandomApiUrl(this.config.dcMin ?? 1, this.config.dcMax ?? 269, this.random);
  }

  buildRequestBody(method, input) {
    if (!method || typeof method !== 'string') throw new TypeError('API method must be a non-empty string.');
    const plaintext = JSON.stringify({
      method,
      input: input ?? {},
      client: this.config.client,
    });
    const data_enc = this.encryption.encrypt(plaintext);
    if (typeof data_enc !== 'string' || data_enc.length === 0) {
      throw new Error(`Encryption did not produce data_enc for ${method}.`);
    }
    // jsrubi signs the exact Base64 ciphertext string, not the JSON body.
    const sign = this.encryption.makeSignFromData(data_enc);
    if (typeof sign !== 'string' || sign.length === 0) {
      throw new Error(`RSA-SHA256 signing did not produce sign for ${method}. Check the PEM private key.`);
    }
    return {
      api_version: this.config.version || '6',
      // The jsrubi Base64-pk branch keeps `this.auth = auth` and sends it
      // unchanged. The transformed value is used by the Encryption instance.
      auth: this.config.auth,
      data_enc,
      sign,
    };
  }

  decodeResponseBody(rawText) {
    const envelope = parseJson(rawText, 'Rubika HTTP response');
    if (envelope && typeof envelope === 'object' && typeof envelope.data_enc === 'string') {
      const decrypted = this.encryption.decrypt(envelope.data_enc);
      if (typeof decrypted !== 'string' || decrypted.length === 0) {
        throw new Error('The encrypted response could not be decrypted. Check that Encryption uses changeAuthType(auth), matching the Base64-pk jsrubi path.');
      }
      return parseJson(decrypted, 'Decrypted Rubika response');
    }
    if (envelope && typeof envelope === 'object' && typeof envelope.data === 'string' && envelope.status === undefined) {
      return parseJson(envelope.data, 'Rubika response data');
    }
    return envelope;
  }

  getHeaders() {
    return {
      'Content-Type': this.config.contentType || 'text/plain',
      Accept: this.config.accept || 'application/json, text/plain, */*',
      'User-Agent': this.config.userAgent || 'Mozilla/5.0 (Linux; U; Android 12; en; M2004J19C Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36',
      Referer: this.config.referer || 'https://web.rubika.ir/',
    };
  }

  async request(method, input = {}, { signal, timeoutMs } = {}) {
    // Create ciphertext and signature once. Retries must send the exact same
    // body/signature; only the API DC URL changes when random DC mode is used.
    const body = this.buildRequestBody(method, input);
    const serializedBody = JSON.stringify(body);
    const attempts = Math.max(1, Math.min(8, Number(this.config.maxAttempts) || 3));
    const requestTimeoutMs = timeoutMs || this.config.timeoutMs || 20000;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const url = this.getRequestUrl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Rubika request timeout')), requestTimeoutMs);
      timeout.unref?.();
      const abortFromCaller = () => controller.abort(signal.reason);
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', abortFromCaller, { once: true });
      }

      try {
        this.logger?.debug('Sending Rubika API request', { method, url, attempt, attempts });
        const response = await this.fetch(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: serializedBody,
          signal: controller.signal,
        });
        const rawText = await response.text();
        let decoded;
        try {
          decoded = this.decodeResponseBody(rawText);
        } catch (error) {
          throw new RubikaApiError(`Could not decode response for ${method}: ${error.message}`, {
            method,
            httpStatus: response.status,
            url,
            cause: error,
          });
        }

        if (!response.ok) {
          const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
          const httpError = new RubikaApiError(`Rubika HTTP request failed (${response.status}) for ${method}.`, {
            method,
            httpStatus: response.status,
            url,
            response: decoded,
          });
          if (retryable && attempt < attempts) {
            lastError = httpError;
            await this.sleep(Math.min(250 * (2 ** (attempt - 1)), 2000));
            continue;
          }
          throw httpError;
        }

        const status = decoded?.status ?? decoded?.data?.status;
        const statusDet = decoded?.status_det ?? decoded?.data?.status_det;
        const normalizedStatus = String(status || '').toUpperCase();
        const normalizedDetail = String(statusDet || '').toUpperCase();
        const isKnownErrorDetail = ['NOT_REGISTERED', 'TOO_REQUESTS', 'INVALID_INPUT', 'INVALID_AUTH'].includes(normalizedDetail);
        const methodSpecificSuccess = (method === 'createGroupVoiceChat' && normalizedStatus === 'VOICECHATEXIST')
          || (method === 'getGroupVoiceChatUpdates' && normalizedStatus === 'OLDSTATE');
        if (((status && !['OK', 'DONE'].includes(normalizedStatus)) && !methodSpecificSuccess) || isKnownErrorDetail) {
          const detail = statusDet && statusDet !== status ? ` (${statusDet})` : '';
          throw new RubikaApiError(`Rubika API returned ${status}${detail} for ${method}.`, {
            method,
            httpStatus: response.status,
            status,
            statusDet,
            url,
            response: decoded,
          });
        }
        this.logger?.debug('Rubika API request completed', { method, url, httpStatus: response.status, status: status || 'unknown' });
        return decoded;
      } catch (error) {
        if (error instanceof RubikaApiError && (error.status || error.statusDet)) throw error;
        if (error instanceof RubikaApiError && error.httpStatus && ![408, 425, 429, 500, 502, 503, 504].includes(error.httpStatus)) throw error;
        if (signal?.aborted) {
          throw new RubikaApiError(`Rubika request aborted for ${method}.`, { method, url, cause: error });
        }
        lastError = error instanceof RubikaApiError ? error : new RubikaApiError(`Rubika request failed for ${method}: ${error.message}`, {
          method,
          url,
          cause: error,
        });
        if (attempt >= attempts) throw lastError;
        this.logger?.warn('Rubika API attempt failed; retrying', { method, url, attempt, message: lastError.message });
        await this.sleep(Math.min(250 * (2 ** (attempt - 1)), 2000));
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', abortFromCaller);
      }
    }
    throw lastError || new RubikaApiError(`Rubika request failed for ${method}.`, { method });
  }
}

module.exports = { RubikaApi, RubikaApiError, defaultRandomApiUrl };
