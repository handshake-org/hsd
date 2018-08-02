/*!
 * util.js - utils for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');

/**
 * @exports utils/util
 */

const util = exports;

/**
 * Return hrtime (shim for browser).
 * @param {Array} time
 * @returns {Array} [seconds, nanoseconds]
 */

util.bench = function bench(time) {
  if (!process.hrtime) {
    const now = Date.now();

    if (time) {
      const [hi, lo] = time;
      const start = hi * 1000 + lo / 1e6;
      return now - start;
    }

    const ms = now % 1000;

    // Seconds
    const hi = (now - ms) / 1000;

    // Nanoseconds
    const lo = ms * 1e6;

    return [hi, lo];
  }

  if (time) {
    const [hi, lo] = process.hrtime(time);
    return hi * 1000 + lo / 1e6;
  }

  return process.hrtime();
};

/**
 * Get current time in unix time (seconds).
 * @returns {Number}
 */

util.now = function now() {
  return Math.floor(Date.now() / 1000);
};

/**
 * Get current time in unix time (milliseconds).
 * @returns {Number}
 */

util.ms = function ms() {
  return Date.now();
};

/**
 * Create a Date ISO string from time in unix time (seconds).
 * @param {Number?} time - Seconds in unix time.
 * @returns {String}
 */

util.date = function date(time) {
  if (time == null)
    time = util.now();

  return new Date(time * 1000).toISOString().slice(0, -5) + 'Z';
};

/**
 * Get unix seconds from a Date string.
 * @param {String?} date - Date ISO String.
 * @returns {Number}
 */

util.time = function time(date) {
  if (date == null)
    return util.now();

  return new Date(date) / 1000 | 0;
};

/**
 * Convert u32 to padded hex.
 * @param {Number} num
 * @returns {String}
 */

util.hex32 = function hex32(num) {
  assert((num >>> 0) === num);
  num = num.toString(16);
  switch (num.length) {
    case 1:
      return `0000000${num}`;
    case 2:
      return `000000${num}`;
    case 3:
      return `00000${num}`;
    case 4:
      return `0000${num}`;
    case 5:
      return `000${num}`;
    case 6:
      return `00${num}`;
    case 7:
      return `0${num}`;
    case 8:
      return `${num}`;
    default:
      throw new Error();
  }
};

/**
 * Parse hex.
 * @param {String} str
 * @param {Number} size
 * @returns {Buffer}
 */

util.parseHex = function parseHex(str, size) {
  if (size == null)
    size = -1;

  assert(typeof str === 'string');
  assert(size === -1 || (size >>> 0) === size);

  if (str.length & 1)
    throw new Error('Invalid hex string.');

  if (size !== -1) {
    if ((str.length >>> 1) !== size)
      throw new Error('Invalid hex string.');
  }

  const data = Buffer.from(str, 'hex');

  if (data.length !== (str.length >>> 1))
    throw new Error('Invalid hex string.');

  return data;
};

/**
 * Test whether a number is a safe uint64.
 * @param {Number} num
 * @returns {Boolean}
 */

util.isU64 = function isU64(num) {
  return Number.isSafeInteger(num) && num >= 0;
};

/**
 * Encode a uint32.
 * @param {Number} num
 * @returns {Buffer}
 */

util.encodeU32 = function encodeU32(num) {
  assert(Number.isSafeInteger(num));
  const buf = Buffer.allocUnsafe(4);
  buf[0] = num;
  num >>>= 8;
  buf[1] = num;
  num >>>= 8;
  buf[2] = num;
  num >>>= 8;
  buf[3] = num;
  return buf;
};
