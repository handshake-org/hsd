/*!
 * compress.js - record compression for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');

/**
 * Compressor
 */

class Compressor {
  constructor() {
    this.words = [];
    this.map = new Map();
    this.strings = new Map();
    this.labels = new Map();
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

    this.strings.set(str, parts);

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

  writeString(bw, str) {
    const off = this._writeString(bw.data, str, bw.offset);
    bw.offset = off;
    return bw;
  }

  _writeString(data, str, off) {
    off += 1;

    const parts = this.split(str);
    const start = off;

    for (const [word, part] of parts) {
      if (!word) {
        off += data.write(part, off, 'ascii');
        continue;
      }

      const val = this.map.get(part);

      if (val == null) {
        off += data.write(part, off, 'ascii');
        continue;
      }

      assert(val < 0x80);

      data[off] = 0x80 | val;
      off += 1;
    }

    data[start - 1] = off - start;

    return off;
  }

  getSize() {
    let size = 1;
    for (const word of this.words)
      size += 1 + word.length;
    return size;
  }

  write(bw) {
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

  readString(br, max = 255) {
    const [off, str] = this._readString(br.data, br.offset, max);
    br.offset = off;
    return str;
  }

  _readString(data, off, max = 255) {
    const len = data[off];

    off += 1;

    let str = '';
    let last = 0;

    for (let i = 0; i < len; i++) {
      const ch = data[off + i];

      if (!isCompressedCh(ch))
        throw new Error('Non-printable character.');

      // Above 0x7f, we start mapping to symbols.
      if (ch & 0x80) {
        const index = ch & 0x7f;

        assert(index < this.words.length);

        str += data.toString('ascii', off + last, off + i);
        str += this.words[index];

        if (str.length > max)
          throw new Error('String too large.');

        last = i + 1;
      }
    }

    if (last !== len)
      str += data.toString('ascii', off + last, off + len);

    off += len;

    return [off, str];
  }

  readBytes(br, max = 255) {
    const [off, str] = this._readBytes(br.data, br.offset, max);
    br.offset = off;
    return str;
  }

  _readBytes(data, off, max = 255) {
    const len = data[off];

    off += 1;

    let str = null;
    let pos = 0;
    let size = 0;
    let last = 0;

    for (let i = 0; i < len; i++) {
      const ch = data[off + i];

      if (!isCompressedCh(ch))
        throw new Error('Non-printable character.');

      // Above 0x7f, we start mapping to symbols.
      if (ch & 0x80) {
        const index = ch & 0x7f;
        assert(index < this.words.length);
        size += i - last;
        size += this.words[index].length;
        last = i + 1;
      }
    }

    if (last !== len)
      size += len - last;

    if (size > max)
      throw new Error('String too large.');

    str = Buffer.allocUnsafe(size);
    last = 0;

    for (let i = 0; i < len; i++) {
      const ch = data[off + i];
      if (ch & 0x80) {
        const index = ch & 0x7f;
        pos += data.copy(str, pos, off + last, off + i);
        pos += str.write(this.words[index], pos, 'ascii');
        last = i + 1;
      }
    }

    if (last !== len)
      pos += data.copy(str, pos, off + last, off + len);

    off += len;

    return [off, str];
  }

  read(br) {
    const count = br.readU8();

    for (let i = 0; i < count; i++)
      this.words.push(readAscii(br, br.readU8()));

    return this;
  }

  static read(br) {
    return new this().read(br);
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
  assert(start + len <= 16);

  return [start, len];
}

function _ipWrite(data, ip, off) {
  const [start, len] = _ipSize(ip);
  data[off] = (start << 4) | len;
  off += 1;
  // Ignore the missing section.
  off += ip.copy(data, off, 0, start);
  off += ip.copy(data, off, start + len);
  return off;
}

function _ipRead(data, off) {
  const field = data[off];
  off += 1;

  const start = field >>> 4;
  const len = field & 0x0f;

  assert(start + len <= 16);

  const left = 16 - (start + len);

  const ip = Buffer.allocUnsafe(16);

  assert(off + start <= data.length);
  off += data.copy(ip, 0, off, off + start);

  // Fill in the missing section.
  ip.fill(0x00, start, start + len);

  assert(off + left <= data.length);
  off += data.copy(ip, start + len, off, off + left);

  return [off, ip];
}

function ipSize(ip) {
  const [, len] = _ipSize(ip);
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

function ipPack(ip) {
  const size = ipSize(ip);
  const data = Buffer.allocUnsafe(size);
  _ipWrite(data, ip, 0);
  return data;
}

function ipUnpack(data) {
  const [, ip] = _ipRead(data, 0);
  return ip;
}

/*
 * Helpers
 */

function isWordCh(ch) {
  // 0 - 9
  if (ch >= 0x30 && ch <= 0x39)
    return true;

  // A - Z
  if (ch >= 0x41 && ch <= 0x5a)
    return true;

  // a - z
  if (ch >= 0x61 && ch <= 0x7a)
    return true;

  // - and _
  if (ch === 0x2d || ch === 0x5f)
    return true;

  return false;
}

function isCompressedCh(ch) {
  // Tab, line feed, and carriage return all valid.
  if (ch === 0x09 || ch === 0x0a || ch === 0x0d)
    return true;

  // Any non-printable character can screw.
  if (ch < 0x20)
    return false;

  // No DEL.
  if (ch === 0x7f)
    return false;

  return true;
}

function isStringCh(ch) {
  // Tab, line feed, and carriage return all valid.
  if (ch === 0x09 || ch === 0x0a || ch === 0x0d)
    return true;

  // Any non-printable character can screw.
  if (ch < 0x20)
    return false;

  // Nothing higher than tilde.
  if (ch > 0x7e)
    return false;

  return true;
}

function splitString(str) {
  const parts = [];

  let word = true;
  let last = 0;
  let i = 0;

  for (; i < str.length; i++) {
    const ch = str.charCodeAt(i);

    if (word === !isWordCh(ch)) {
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

function readAscii(br, size) {
  const {data, offset} = br;

  for (let i = 0; i < size; i++) {
    if (offset + i >= data.length)
      throw new Error('Out of bounds read.');

    const ch = data[offset + i];

    // Any non-printable character can screw.
    if (!isStringCh(ch))
      throw new Error('Non-printable character.');
  }

  return br.readString(size);
}

/*
 * Expose
 */

exports.ipSize = ipSize;
exports.ipWrite = ipWrite;
exports.ipRead = ipRead;
exports.ipPack = ipPack;
exports.ipUnpack = ipUnpack;
exports.readAscii = readAscii;
exports.Compressor = Compressor;
exports.Decompressor = Decompressor;
