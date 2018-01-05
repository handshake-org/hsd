/*!
 * consensus.js - consensus constants and helpers for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/**
 * @module protocol/consensus
 */

const assert = require('assert');
const BN = require('bn.js');
const {Cuckoo, Solution, codes} = require('thc/cuckoo');

/**
 * Coin exponent.
 * @const {Number}
 * @default
 */

exports.EXP = 6;

/**
 * One handshake in dollarydoos.
 * @const {Amount}
 * @default
 */

exports.COIN = Math.pow(10, exports.EXP);

/**
 * Maximum amount of subsidies in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_SUBSIDY = 1.4e9 * exports.COIN;

/**
 * Maximum amount of money in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_MONEY = exports.MAX_SUBSIDY;

/**
 * Base block subsidy (consensus).
 * @const {Amount}
 * @default
 */

exports.BASE_REWARD = 80 * exports.COIN;

/**
 * Maximum block base size (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_SIZE = 1000000;

/**
 * Maximum block serialization size (protocol).
 * @const {Number}
 * @default
 */

exports.MAX_RAW_BLOCK_SIZE = 4000000;

/**
 * Maximum block weight (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_WEIGHT = 4000000;

/**
 * Maximum block sigops cost (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_SIGOPS = 80000;

/**
 * Size of set to pick median time from.
 * @const {Number}
 * @default
 */

exports.MEDIAN_TIMESPAN = 11;

/**
 * Number of blocks before a coinbase
 * spend can occur (consensus).
 * @const {Number}
 * @default
 */

// exports.COINBASE_MATURITY = 400;
exports.COINBASE_MATURITY = 25;

/**
 * Amount to multiply base/non-witness sizes by.
 * @const {Number}
 * @default
 */

exports.WITNESS_SCALE_FACTOR = 4;

/**
 * nLockTime threshold for differentiating
 * between height and time (consensus).
 * Tue Nov 5 00:53:20 1985 UTC
 * @const {Number}
 * @default
 */

exports.LOCKTIME_THRESHOLD = 500000000;

/**
 * Highest nSequence bit -- disables
 * sequence locktimes (consensus).
 * @const {Number}
 */

exports.SEQUENCE_DISABLE_FLAG = (1 << 31) >>> 0;

/**
 * Sequence time: height or time (consensus).
 * @const {Number}
 * @default
 */

exports.SEQUENCE_TYPE_FLAG = 1 << 22;

/**
 * Sequence granularity for time (consensus).
 * @const {Number}
 * @default
 */

exports.SEQUENCE_GRANULARITY = 9;

/**
 * Sequence mask (consensus).
 * @const {Number}
 * @default
 */

exports.SEQUENCE_MASK = 0x0000ffff;

/**
 * Max serialized script size (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_SCRIPT_SIZE = 10000;

/**
 * Max stack size during execution (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_SCRIPT_STACK = 1000;

/**
 * Max script element size (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_SCRIPT_PUSH = 520;

/**
 * Max opcodes executed (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_SCRIPT_OPS = 201;

/**
 * Max `n` value for multisig (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_MULTISIG_PUBKEYS = 20;

/**
 * A hash of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_HASH = Buffer.alloc(32, 0x00);

/**
 * A hash of all zeroes.
 * @const {String}
 * @default
 */

exports.NULL_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Block header size.
 * @const {Number}
 * @default
 */

exports.HEADER_SIZE = 160;

/**
 * Block header nonce position.
 * @const {Number}
 * @default
 */

exports.NONCE_POS = 144;

/**
 * Block header nonce size.
 * @const {Number}
 * @default
 */

exports.NONCE_SIZE = 16;

/**
 * Block header of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_HEADER = Buffer.alloc(exports.HEADER_SIZE, 0x00);

/**
 * Block header nonce of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_NONCE = Buffer.alloc(exports.NONCE_SIZE, 0x00);

/**
 * Block header solution of all zeroes.
 * @const {Solution}
 * @default
 */

exports.ZERO_SOL = new Solution();

exports.MAX_NAME_SIZE = 255;
exports.MAX_RECORD_SIZE = 512;

/**
 * Convert a compact number to a big number.
 * Used for `block.bits` -> `target` conversion.
 * @param {Number} compact
 * @returns {BN}
 */

exports.fromCompact = function fromCompact(compact) {
  if (compact === 0)
    return new BN(0);

  const exponent = compact >>> 24;
  const negative = (compact >>> 23) & 1;

  let mantissa = compact & 0x7fffff;
  let num;

  if (exponent <= 3) {
    mantissa >>>= 8 * (3 - exponent);
    num = new BN(mantissa);
  } else {
    num = new BN(mantissa);
    num.iushln(8 * (exponent - 3));
  }

  if (negative)
    num.ineg();

  return num;
};

/**
 * Convert a big number to a compact number.
 * Used for `target` -> `block.bits` conversion.
 * @param {BN} num
 * @returns {Number}
 */

exports.toCompact = function toCompact(num) {
  if (num.isZero())
    return 0;

  let exponent = num.byteLength();
  let mantissa;

  if (exponent <= 3) {
    mantissa = num.toNumber();
    mantissa <<= 8 * (3 - exponent);
  } else {
    mantissa = num.ushrn(8 * (exponent - 3)).toNumber();
  }

  if (mantissa & 0x800000) {
    mantissa >>= 8;
    exponent += 1;
  }

  let compact = (exponent << 24) | mantissa;

  if (num.isNeg())
    compact |= 0x800000;

  compact >>>= 0;

  return compact;
};

/**
 * Verify proof-of-work.
 * @param {Hash} hash
 * @param {Number} bits
 * @returns {Boolean}
 */

exports.verifyPOW = function verifyPOW(hash, bits) {
  const target = exports.fromCompact(bits);

  if (target.isNeg() || target.isZero())
    return false;

  if (target.bitLength() > 256)
    return false;

  const num = new BN(hash, 'le');

  if (num.gt(target))
    return false;

  return true;
};

/**
 * Verify cuckoo cycle solution.
 * @param {Buffer} hdr
 * @param {Solution} sol
 * @param {Object} params
 * @returns {Boolean}
 */

exports.verifySolution = function verifySolution(hdr, sol, params) {
  const {bits, size, ease} = params;
  const cuckoo = new Cuckoo(bits, size, ease);
  const code = cuckoo.verifyHeader(hdr, sol);
  return code === codes.POW_OK;
};

/**
 * Calculate block subsidy.
 * @param {Number} height - Reward era by height.
 * @returns {Amount}
 */

exports.getReward = function getReward(height, interval) {
  assert((height >>> 0) === height, 'Bad height for reward.');
  assert((interval >>> 0) === interval);

  const halvings = Math.floor(height / interval);

  if (halvings >= 52)
    return 0;

  return Math.floor(exports.BASE_REWARD / Math.pow(2, halvings));
};

/**
 * Test version bit.
 * @param {Number} version
 * @param {Number} bit
 * @returns {Boolean}
 */

exports.hasBit = function hasBit(version, bit) {
  return (version & (1 << bit)) !== 0;
};

exports.validChars = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
  0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0
]);

exports.verifyName = function verifyName(name) {
  if (Buffer.isBuffer(str))
    return exports.verifyBinary(str);
  return exports.verifyString(str);
};

exports.verifyString = function verifyString(str) {
  assert(typeof str === 'string');

  if (str.length === 0)
    return false;

  if (str.length > exports.MAX_NAME_SIZE)
    return false;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);

    // No unicode characters.
    if (ch & 0xff80)
      return false;

    const type = exports.validChars[ch];

    switch (type) {
      case 0: // non-printable
        return false;
      case 1: // 0-9
      case 2: // a-z
        break;
      case 3: // - and _
        // Do not allow at end or beginning.
        if (i === 0 || i === str.length - 1)
          return false;
        break;
    }
  }

  return true;
};

exports.verifyBinary = function verifyBinary(buf) {
  assert(Buffer.isBuffer(buf));

  if (buf.length === 0)
    return false;

  if (buf.length > exports.MAX_NAME_SIZE)
    return false;

  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];

    // No unicode characters.
    if (ch & 0x80)
      return false;

    const type = exports.validChars[ch];

    switch (type) {
      case 0: // non-printable
        return false;
      case 1: // 0-9
      case 2: // a-z
        break;
      case 3: // - and _
        // Do not allow at end or beginning.
        if (i === 0 || i === buf.length - 1)
          return false;
        break;
    }
  }

  return true;
};
