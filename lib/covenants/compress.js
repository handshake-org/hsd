'use strict';

const assert = require('assert');

/**
 * Compressor
 */

class Compressor {
  constructor() {
    this.words = [];
    this.map = new Map();
    this.strings = new Map();
  }

  split(str) {
    const cache = this.strings.get(str);

    if (cache)
      return cache;

    const parts = splitString(str);

    for (let i = 0; i < parts.length; i++) {
      const items = parts[i];
      const [word, part] = items;

      // Some exceptions.
      if (word && part.length < 3) {
        items[0] = false;
        continue;
      }

      if (part === '://') {
        assert(!word);
        items[0] = true;
      }
    }

    return parts;
  }

  add(str) {
    const parts = this.split(str);

    for (const [word, part] of parts) {
      if (!word)
        continue;

      if (this.words.length === 0x7f)
        continue;

      assert(this.words.length < 0x80);

      if (!this.map.has(part)) {
        const i = this.words.push(part);
        this.map.set(part, i - 1);
      }
    }
  }

  size(str) {
    const parts = this.split(str);

    let size = 1;

    for (const [word, part] of parts) {
      if (!word) {
        size += part.length;
        continue;
      }

      const val = this.map.get(part);

      if (val == null) {
        size += part.length;
        continue;
      }

      size += 1;
    }

    return size;
  }

  write(bw, str) {
    const off = this._write(bw.data, str, bw.offset);
    bw.offset = off;
    return bw;
  }

  _write(buf, str, off) {
    off += 1;

    const parts = this.split(str);
    const start = off;

    for (const [word, part] of parts) {
      if (!word) {
        off += buf.write(part, off, 'ascii');
        continue;
      }

      const val = this.map.get(part);

      if (val == null) {
        off += buf.write(part, off, 'ascii');
        continue;
      }

      assert(val < 0x80);

      buf[off] = 0x80 | val;
      off += 1;
    }

    buf[start - 1] = off - start;

    return off;
  }

  getSize() {
    let size = 1;
    for (const word of this.words)
      size += 1 + word.length;
    return size;
  }

  toWriter(bw) {
    bw.writeU8(this.words.length);
    for (const word of this.words) {
      bw.writeU8(word.length);
      bw.writeString(word, 'ascii');
    }
    return bw;
  }
}

/**
 * Decompressor
 */

class Decompressor {
  constructor() {
    this.words = [];
  }

  read(br) {
    const [off, str] = this._read(br.data, br.offset);
    br.offset = off;
    return str;
  }

  _read(buf, off) {
    const len = buf[off];

    off += 1;

    let str = '';
    let last = 0;

    for (let i = 0; i < len; i++) {
      const ch = buf[off + i];

      assert(ch >= 0x20);

      if (ch & 0x80) {
        const index = ch & 0x7f;
        assert(index < this.words.length);
        str += buf.toString('ascii', off + last, off + i);
        str += this.words[index];
        last = i + 1;
      }
    }

    if (last !== len)
      str += buf.toString('ascii', off + last, off + len);

    off += len;

    return [off, str];
  }

  fromReader(br) {
    const count = br.readU8();

    for (let i = 0; i < count; i++)
      this.words.push(br.readString('ascii', br.readU8()));

    return this;
  }

  static fromReader(br) {
    return new this().fromReader(br);
  }
}

/*
 * IP compression
 */

function _ipSize(ip) {
  let out = true;
  let last = 0;
  let i = 0;

  let start = 0;
  let len = 0;

  for (; i < ip.length; i++) {
    const ch = ip[i];
    if (out === (ch === 0)) {
      if (!out && i - last > len) {
        start = last;
        len = i - last;
      }
      out = !out;
      last = i;
    }
  }

  if (!out && i - last > len) {
    start = last;
    len = i - last;
  }

  // The worst case:
  // We need at least 2 zeroes in a row to
  // get any benefit from the compression.
  if (len === 16) {
    assert(start === 0);
    len = 0;
  }

  assert(start < 16);
  assert(len < 16);

  return [start, len];
}

function _ipWrite(buf, ip, off) {
  const [start, len] = _ipSize(ip);
  buf[off] = (start << 4) | len;
  off += 1;
  // Ignore the missing section.
  off += ip.copy(buf, off, 0, start);
  off += ip.copy(buf, off, start + len);
  return off;
}

function _ipRead(buf, off) {
  const field = buf[off];
  off += 1;

  const start = field >>> 4;
  const len = field & 0x0f;
  const size = 16 - (start + len);

  const ip = Buffer.alloc(16);

  off += buf.copy(ip, 0, off, off + start);

  // Fill in the missing section.
  ip.fill(0x00, start, start + len);

  off += buf.copy(ip, start + len, off, off + size);

  return [off, ip];
}

function ipSize(ip) {
  const [start, len] = _ipSize(ip);
  return 1 + (16 - len);
}

function ipWrite(bw, ip) {
  bw.offset = _ipWrite(bw.data, ip, bw.offset);
  return bw;
}

function ipRead(br) {
  const [off, ip] = _ipRead(br.data, br.offset);
  br.offset = off;
  return ip;
}

/*
 * Helpers
 */

function isCh(ch) {
  if (ch >= 'A' && ch <= 'Z')
    return true;

  if (ch >= 'a' && ch <= 'z')
    return true;

  if (ch >= '0' && ch <= '9')
    return true;

  if (ch === '-' || ch === '_')
    return true;

  return false;
}

function splitString(str) {
  const parts = [];

  let word = true;
  let last = 0;
  let i = 0;

  for (; i < str.length; i++) {
    const ch = str[i];

    if (word === !isCh(ch)) {
      if (i !== last)
        parts.push([word, str.substring(last, i)]);
      word = !word;
      last = i;
    }
  }

  if (i !== last)
    parts.push([word, str.substring(last, i)]);

  return parts;
}

/*
 * Expose
 */

exports.ipSize = ipSize;
exports.ipWrite = ipWrite;
exports.ipRead = ipRead;
exports.Compressor = Compressor;
exports.Decompressor = Decompressor;
