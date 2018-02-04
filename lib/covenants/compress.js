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

    return splitString(str);
  }

  add(str) {
    const parts = this.split(str);

    for (const [word, part] of parts) {
      if (!word || this.words.length === 0x7f)
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

exports.Compressor = Compressor;
exports.Decompressor = Decompressor;
