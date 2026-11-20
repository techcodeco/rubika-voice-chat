'use strict';

const LEVELS = ['debug', 'info', 'warn', 'error'];

class Logger {
  constructor({ level = process.env.LOG_LEVEL || 'info', prefix = 'voice-engine' } = {}) {
    this.level = LEVELS.includes(level) ? level : 'info';
    this.prefix = prefix;
  }

  _write(level, message, meta) {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.level)) return;
    const stamp = new Date().toISOString();
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const line = `${stamp} ${level.toUpperCase()} [${this.prefix}] ${message}${suffix}`;
    const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    target.write(`${line}\n`);
  }

  debug(message, meta) { this._write('debug', message, meta); }
  info(message, meta) { this._write('info', message, meta); }
  warn(message, meta) { this._write('warn', message, meta); }
  error(message, meta) { this._write('error', message, meta); }
}

module.exports = { Logger };
