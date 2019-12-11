'use strict';

const assert = require('bsert');
const sha3 = require('bcrypto/lib/sha3');
const data = require('./names.json');

/*
 * Constants
 */

const ZERO_HASH = sha3.zero.toString('hex');

/**
 * Reserved
 */

class Reserved {
  constructor(data) {
    const meta = data[ZERO_HASH];

    this.data = data;
    this.size = meta[0];
    this.nameValue = meta[1];
    this.rootValue = meta[2];
    this.topValue = meta[3];
  }

  has(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 32);

    const hex = hash.toString('hex');
    const item = this.data[hex];

    if (!item)
      return false;

    return Array.isArray(item);
  }

  get(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 32);

    const hex = hash.toString('hex');
    const item = this.data[hex];

    if (!item || !Array.isArray(item))
      return null;

    const target = item[0];
    const flags = item[1];
    const index = target.indexOf('.');

    assert(index !== -1);

    const root = (flags & 1) !== 0;
    const top100 = (flags & 2) !== 0;
    const custom = (flags & 4) !== 0;
    const zero = (flags & 8) !== 0;
    const name = target.substring(0, index);

    let value = this.nameValue;

    if (root)
      value += this.rootValue;

    if (top100)
      value += this.topValue;

    if (custom)
      value += item[2];

    if (zero)
      value = 0;

    return {
      name,
      hash,
      target,
      value,
      root
    };
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
    const keys = Object.keys(this.data);

    for (const key of keys) {
      const hash = Buffer.from(key, 'hex');

      yield [hash, this.get(hash)];
    }
  }

  *keys() {
    const keys = Object.keys(this.data);

    for (const key of keys)
      yield Buffer.from(key, 'hex');
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

function hashName(name) {
  const raw = Buffer.from(name.toLowerCase(), 'ascii');
  return sha3.digest(raw);
}

/*
 * Expose
 */

module.exports = new Reserved(data);
