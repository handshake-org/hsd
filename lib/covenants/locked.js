'use strict';

const assert = require('bsert');
const Path = require('path');
const fs = require('bfile');
const sha3 = require('bcrypto/lib/sha3');

const FILE = Path.resolve(__dirname, 'lockup.db');
const DATA = fs.readFileSync(FILE);

/**
 * Locked up
 */

class LockedUp {
  constructor(data) {
    this.data = data;
    this.size = readU32(data, 0);
  }

  get prefixSize() {
    return 4;
  }

  _compare(b, off) {
    const a = this.data;

    for (let i = 0; i < 32; i++) {
      const x = a[off + i];
      const y = b[i];

      if (x < y)
        return -1;

      if (x > y)
        return 1;
    }

    return 0;
  }

  _find(key) {
    let start = 0;
    let end = this.size - 1;

    while (start <= end) {
      const index = (start + end) >>> 1;
      const pos = this.prefixSize + index * 36;
      const cmp = this._compare(key, pos);

      if (cmp === 0)
        return readU32(this.data, pos + 32);

      if (cmp < 0)
        start = index + 1;
      else
        end = index - 1;
    }

    return -1;
  }

  _target(pos) {
    const len = this.data[pos];
    return this.data.toString('ascii', pos + 1, pos + 1 + len);
  }

  _flags(pos) {
    const len = this.data[pos];
    return this.data[pos + 1 + len];
  }

  _index(pos) {
    const len = this.data[pos];
    return this.data[pos + 1 + len + 1];
  }

  _get(hash, pos) {
    const target = this._target(pos);
    const flags = this._flags(pos);
    const index = this._index(pos);
    const root = (flags & 1) !== 0;
    const custom = (flags & 2) !== 0;
    const name = target.substring(0, index);

    return {
      name,
      hash,
      target,
      root,
      custom
    };
  }

  has(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 32);

    return this._find(hash) !== -1;
  }

  get(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 32);

    const pos = this._find(hash);

    if (pos === -1)
      return null;

    return this._get(hash, pos);
  }

  hasByName(name) {
    assert(typeof name === 'string');

    if (name.length === 0 || name.length > 63)
      return false;

    return this.has(hashName(name));
  }

  getByName(name) {
    assert(typeof name === 'string');

    if (name.length === 0 || name.length > 63)
      return null;

    return this.get(hashName(name));
  }

  *entries() {
    for (let i = 0; i < this.size; i++) {
      const pos = this.prefixSize + i * 36;
      const hash = this.data.slice(pos, pos + 32);
      const ptr = readU32(this.data, pos + 32);
      const item = this._get(hash, ptr);

      yield [hash, item];
    }
  }

  *keys() {
    for (let i = 0; i < this.size; i++) {
      const pos = this.prefixSize + i * 36;

      yield this.data.slice(pos, pos + 32);
    }
  }

  *values() {
    for (const [, item] of this.entries())
      yield item;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

/*
 * Helpers
 */

function readU32(data, off) {
  return data.readUInt32LE(off);
}

function hashName(name) {
  const raw = Buffer.from(name.toLowerCase(), 'ascii');
  return sha3.digest(raw);
}

exports.LockedUp = LockedUp;
exports.locked = new LockedUp(DATA);
