'use strict';

class ByteQueue {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  get length() { return this.buffer.length; }

  push(chunk) {
    if (!chunk || !chunk.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
  }

  read(size) {
    if (this.buffer.length < size) return null;
    const output = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return output;
  }

  readPartial(size) {
    if (!this.buffer.length) return null;
    const length = Math.min(size, this.buffer.length);
    const output = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return output;
  }

  clear() { this.buffer = Buffer.alloc(0); }
}

module.exports = { ByteQueue };
