'use strict';

const assert = require('bsert');
const Path = require('path');
const fs = require('bfile');

/*
 * Constants
 */

const FILE = Path.resolve(__dirname, 'tld.db');
const DATA = fs.readFileSync(FILE);

/**
 * ICANN Root Zone
 */

class ICANN {
  constructor(data) {
    this.data = data;
    this.size = readU32(data, 0);
    this.nameSize = data[4];
  }

  _compare(b, off) {
    const a = this.data;
    const alen = a[off - 1];
    const blen = b.length;
    const len = alen < blen ? alen : blen;

    for (let i = 0; i < len; i++) {
      const x = a[off + i];
      const y = b[i];

      if (x < y)
        return -1;

      if (x > y)
        return 1;
    }

    if (alen < blen)
      return -1;

    if (alen > blen)
      return 1;

    return 0;
  }

  _find(key) {
    let start = 0;
    let end = this.size - 1;

    while (start <= end) {
      const index = (start + end) >>> 1;
      const pos = 5 + index * (1 + this.nameSize + 4);
      const cmp = this._compare(key, pos + 1);

      if (cmp === 0)
        return readU32(this.data, pos + 1 + this.nameSize);

      if (cmp < 0)
        start = index + 1;
      else
        end = index - 1;
    }

    return -1;
  }

  _data(pos) {
    const len = readU16(this.data, pos);
    return this.data.slice(pos + 2, pos + 2 + len);
  }

  _has(key) {
    return this._find(key) !== -1;
  }

  _get(key) {
    const pos = this._find(key);

    if (pos === -1)
      return null;

    return this._data(pos);
  }

  has(name) {
    assert(typeof name === 'string');

    name = trimFQDN(name);

    if (name.length === 0 || name.length > 63)
      return false;

    return this._has(toKey(name));
  }

  get(name) {
    assert(typeof name === 'string');

    name = trimFQDN(name);

    if (name.length === 0 || name.length > 63)
      return null;

    return this._get(toKey(name));
  }
}

/*
 * Helpers
 */

function readU16(data, off) {
  return data.readUInt16LE(off);
}

function readU32(data, off) {
  return data.readUInt32LE(off);
}

function trimFQDN(name) {
  if (name.length > 0 && name[name.length - 1] === '.')
    name = name.slice(0, -1);
  return name;
}

function toKey(name) {
  return Buffer.from(name.toLowerCase(), 'ascii');
}

/*
 * Expose
 */

module.exports = new ICANN(DATA);
