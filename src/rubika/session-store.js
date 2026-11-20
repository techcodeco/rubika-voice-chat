'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (error) {
    throw new Error(
      `SQLite sessions require Node.js 22.5 or newer with node:sqlite support. ` +
      `Current runtime: ${process.version}. Original error: ${error.message}`,
    );
  }
}

function ensurePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  }
}

class SessionStore {
  constructor({ databasePath, keyFilePath, encryptionKey, logger } = {}) {
    const { DatabaseSync } = loadSqlite();
    this.databasePath = databasePath === ':memory:' ? ':memory:' : path.resolve(databasePath || './sessions/rubika.sqlite');
    this.keyFilePath = keyFilePath ? path.resolve(keyFilePath) : (this.databasePath === ':memory:' ? null : `${this.databasePath}.key`);
    this.logger = logger;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.key = this._loadKey(encryptionKey);
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        name TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        payload BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    `);
    if (process.platform !== 'win32' && this.databasePath !== ':memory:') {
      try { fs.chmodSync(this.databasePath, 0o600); } catch { /* best effort */ }
    }
    this.closed = false;
  }

  _loadKey(encryptionKey) {
    if (encryptionKey !== undefined && encryptionKey !== null && String(encryptionKey).length) {
      return crypto.scryptSync(String(encryptionKey), `rubika-node-sdk:${this.databasePath}`, 32);
    }
    if (this.databasePath === ':memory:') return crypto.randomBytes(32);
    ensurePrivateFile(this.keyFilePath, crypto.randomBytes(32));
    const key = fs.readFileSync(this.keyFilePath);
    if (key.length !== 32) throw new Error(`Session key file must contain exactly 32 bytes: ${this.keyFilePath}`);
    return key;
  }

  _assertOpen() {
    if (this.closed) throw new Error('SessionStore is closed.');
  }

  _validateName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Session name must be a non-empty string.');
    if (name.length > 128) throw new RangeError('Session name cannot exceed 128 characters.');
    return name.trim();
  }

  _encrypt(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv, authTag: cipher.getAuthTag(), payload: encrypted };
  }

  _decrypt(row) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv));
      decipher.setAuthTag(Buffer.from(row.auth_tag));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.payload)),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plaintext);
    } catch (error) {
      throw new Error(`Could not decrypt saved session. Check the session key or encryption secret. (${error.message})`);
    }
  }

  save(name, credentials) {
    this._assertOpen();
    const sessionName = this._validateName(name);
    if (!credentials || typeof credentials.auth !== 'string' || !credentials.auth) {
      throw new TypeError('Session credentials must include a non-empty auth string.');
    }
    if (typeof credentials.privateKeyB64 !== 'string' || !credentials.privateKeyB64) {
      throw new TypeError('Session credentials must include privateKeyB64.');
    }
    const encrypted = this._encrypt({
      auth: credentials.auth,
      authMode: credentials.authMode || 'created-session',
      privateKeyB64: credentials.privateKeyB64,
      selfObjectGuid: credentials.selfObjectGuid || '',
      user: credentials.user || null,
      deviceHash: credentials.deviceHash || '',
      registeredAppVersion: credentials.registeredAppVersion || '',
    });
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sessions(name, version, iv, auth_tag, payload, created_at, updated_at)
      VALUES(?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(sessionName, encrypted.iv, encrypted.authTag, encrypted.payload, now, now);
    this.logger?.debug('Rubika session saved to encrypted SQLite storage', { sessionName });
    return { name: sessionName, createdAt: now, updatedAt: now };
  }

  get(name) {
    this._assertOpen();
    const sessionName = this._validateName(name);
    const row = this.db.prepare('SELECT * FROM sessions WHERE name = ?').get(sessionName);
    if (!row) return null;
    return {
      name: row.name,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...this._decrypt(row),
    };
  }

  has(name) { return this.get(name) !== null; }

  list() {
    this._assertOpen();
    return this.db.prepare('SELECT name, version, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all()
      .map(row => ({ name: row.name, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  delete(name) {
    this._assertOpen();
    const sessionName = this._validateName(name);
    return this.db.prepare('DELETE FROM sessions WHERE name = ?').run(sessionName).changes > 0;
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

module.exports = { SessionStore };
