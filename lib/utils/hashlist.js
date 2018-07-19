/*!
 * hashlist.js - memory optimal hash list
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');

/*
 * Constants
 */

const DUMMY = Buffer.allocUnsafe(0);

/**
 * HashList
 */

class HashList {
  constructor(size) {
    assert((size >>> 0) === size);
    assert((size & 1) === 0);
    this.size = size;
    this.data = DUMMY;
    this.pos = 0;
  }

  get length() {
    return (this.pos / this.size) >>> 0;
  }

  set length(len) {
    this.pos = (len >>> 0) * this.size;

    if (this.pos > this.data.length)
      this.pos = this.data.length;
  }

  [Symbol.iterator]() {
    return this.values();
  }

  keys() {
    return this.values();
  }

  *values() {
    for (let i = 0; i < this.pos; i += this.size)
      yield this.data.slice(i, i + this.size);
  }

  clone() {
    const list = new this.constructor();
    list.data = copy(this.data);
    list.pos = this.pos;
    return list;
  }

  push(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === this.size);

    if (this.data.length === 0)
      this.data = Buffer.allocUnsafe(256 * this.size);

    if (this.pos === this.data.length)
      this.data = realloc(this.data, this.pos * 2);

    assert(this.pos + this.size <= this.data.length);

    this.pos += hash.copy(this.data, this.pos);

    return this;
  }

  pop() {
    if (this.pos === 0)
      return null;

    this.pos -= this.size;

    return this.data.slice(this.pos, this.pos + this.size);
  }

  clear() {
    this.pos = 0;
    return this;
  }

  encode() {
    return this.data.slice(0, this.pos);
  }

  decode(data) {
    assert(Buffer.isBuffer(data));
    assert((data.length % this.size) === 0);
    this.data = data;
    this.pos = data.length;
    return this;
  }

  static decode(data, size) {
    return new HashList(size).decode(data);
  }

  *valuesSafe() {
    for (let i = 0; i < this.pos; i += this.size)
      yield copy(this.data.slice(i, i + this.size));
  }

  popSafe() {
    const hash = this.pop();

    if (!hash)
      return null;

    return copy(hash);
  }

  encodeSafe() {
    return copy(this.encode());
  }

  decodeSafe(data) {
    return this.decode(copy(data));
  }

  static decodeSafe(data, size) {
    return new HashList(size).decodeSafe(data);
  }
}

/*
 * Helpers
 */

function realloc(data, size) {
  assert(Buffer.isBuffer(data));
  assert((size >>> 0) === size);
  assert(size >= data.length);
  const buf = Buffer.allocUnsafe(size);
  data.copy(buf, 0);
  return buf;
}

function copy(buf) {
  return realloc(buf, buf.length);
}

/*
 * Expose
 */

module.exports = HashList;
