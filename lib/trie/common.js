/*!
 * common.js - patricia merkle trie utilities
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 *
 * Patricia Merkle Tries:
 *   https://github.com/ethereum/wiki/wiki/Patricia-Tree
 *
 * Parts of this software are based on go-ethereum:
 *   Copyright (C) 2014 The go-ethereum Authors.
 *   https://github.com/ethereum/go-ethereum/tree/master/trie
 */

'use strict';

const assert = require('assert');

exports.EMPTY = Buffer.alloc(0);

// Empty Root == BLAKE2b("\0")
exports.EMPTY_ROOT = Buffer.from(
  '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314',
  'hex');

exports.ZERO_HASH = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex');

exports.toNibbles = function toNibbles(str) {
  assert(Buffer.isBuffer(str));

  const len = str.length * 2 + 1;
  const nib = Buffer.allocUnsafe(len);

  let j = 0;
  for (let i = 0; i < str.length; i++) {
    const b = str[i];
    nib[j++] = b >> 4;
    nib[j++] = b & 0x0f;
  }

  nib[j] = 16;

  return nib;
};

exports.fromNibbles = function fromNibbles(nib) {
  assert(Buffer.isBuffer(nib));

  let nl = nib.length;

  if (nl === 0)
    return exports.EMPTY;

  if (nib[nl - 1] === 16)
    nl -= 1;

  const len = (nl + 1) >>> 1;
  const str = Buffer.allocUnsafe(len);

  for (let i = 0; i < str.length; i++) {
    let b = nib[i * 2] << 4;
    if (nl > i * 2)
      b |= nib[i * 2 + 1];
    str[i] = b;
  }

  return str;
};

exports.prefixLen = function prefixLen(a, b, p = 0) {
  assert(Buffer.isBuffer(a));
  assert(Buffer.isBuffer(b));
  assert((p >>> 0) === p);
  assert(p <= a.length);

  let len = a.length - p;
  let i = 0;

  if (b.length < len)
    len = b.length;

  for (; i < len; i++) {
    if (a[p] !== b[i])
      break;
    p += 1;
  }

  return i;
};

exports.startsWith = function startsWith(a, b, p = 0) {
  assert(Buffer.isBuffer(a));
  assert(Buffer.isBuffer(b));
  assert((p >>> 0) === p);
  assert(p <= a.length);

  if (b.length > a.length - p)
    return false;

  for (let i = 0; i < b.length; i++) {
    if (a[p] !== b[i])
      return false;
    p += 1;
  }

  return true;
};

exports.concat = function concat(a, b, bstart = 0, bend = b.length) {
  assert(Buffer.isBuffer(a));
  assert(Buffer.isBuffer(b));
  assert((bstart >>> 0) === bstart);
  assert((bend >>> 0) === bend);
  assert(bend >= bstart);

  const blen = bend - bstart;

  if (a.length === 0) {
    if (blen === b.length)
      return b;
    return b.slice(bstart, bend);
  }

  const size = a.length + blen;
  const buf = Buffer.allocUnsafe(size);

  let t = 0;
  t += a.copy(buf, 0);
  t += b.copy(buf, t, bstart, bend);

  assert(t === size);

  return buf;
};

exports.prepend = function prepend(a, b) {
  assert((a & 0xff) === a);
  assert(Buffer.isBuffer(b));
  const buf = Buffer.allocUnsafe(1 + b.length);
  buf[0] = a;
  b.copy(buf, 1);
  return buf;
};

exports.byte = function byte(ch) {
  assert((ch & 0xff) === ch);
  const data = Buffer.allocUnsafe(1);
  data[0] = ch;
  return data;
};

exports.compressSize = function compressSize(nib) {
  assert(Buffer.isBuffer(nib));

  if (nib.length === 0)
    return 1;

  let term = 0;

  if (nib[nib.length - 1] === 16)
    term = 1;

  return ((nib.length - term) >>> 1) + 1;
};

exports.compress = function compress(nib) {
  assert(Buffer.isBuffer(nib));

  let nl = nib.length;

  if (nl === 0)
    return exports.byte(0);

  let term = 0;

  if (nib[nl - 1] === 16) {
    term = 1;
    nl -= 1;
  }

  const odd = nl & 1;
  const len = (nl >>> 1) + 1;

  let bi = 0;
  let hi = 0;
  let hs = 0;

  if (odd === 0) {
    bi = 1;
    hs = 4;
  }

  const data = Buffer.allocUnsafe(len);
  data.fill(0);

  data[0] = (term << 5) | (odd << 4);

  while (bi < data.length && hi < nl) {
    data[bi] |= nib[hi] << hs;
    if (hs === 0)
      bi += 1;
    hi += 1;
    hs ^= 1 << 2;
  }

  assert(bi === data.length);

  return data;
};

exports.decompress = function decompress(data) {
  assert(Buffer.isBuffer(data));

  if (data.length === 0)
    return data;

  const nib = exports.toNibbles(data);

  let pos = 2;
  let len = nib.length - 1;

  // Odd?
  if (nib[0] & 1)
    pos = 1;

  // Term?
  if (nib[0] & 2)
    len += 1;

  return nib.slice(pos, len);
};

exports.hasTerm = function hasTerm(key) {
  assert(Buffer.isBuffer(key));

  if (key.length === 0)
    return false;

  return key[key.length - 1] === 16;
};

exports.decodeCompact = function decodeCompact(key) {
  assert(Buffer.isBuffer(key));

  const len = key.length >>> 1;
  const res = key.slice(0, len);

  for (let i = 0; i < len; i++) {
    const v1 = key[2 * i];
    const v0 = key[2 * i + 1];
    res[i] = (v1 << 4) | v0;
  }

  return res;
};
