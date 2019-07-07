/*!
 * consensus.js - consensus constants and helpers for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module protocol/consensus
 */

const assert = require('bsert');
const BN = require('bcrypto/lib/bn.js');

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
 * Maximum creators amount in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_CREATORS = 102e6 * exports.COIN;

/**
 * Maximum sponsors amount in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_SPONSORS = 102e6 * exports.COIN;

/**
 * Maximum TLD holder amount in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_TLD = 51e6 * exports.COIN;

/**
 * Maximum domain holder amount in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_DOMAIN = 51e6 * exports.COIN;

/**
 * Maximum CA/naming amount in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_CA_NAMING = 102e6 * exports.COIN;

/**
 * Maximum airdrop amount in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_AIRDROP = 0.952e9 * exports.COIN;

/**
 * Maximum initial supply in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_INITIAL = 1.36e9 * exports.COIN;

assert(exports.MAX_CREATORS
     + exports.MAX_SPONSORS
     + exports.MAX_TLD
     + exports.MAX_DOMAIN
     + exports.MAX_CA_NAMING
     + exports.MAX_AIRDROP === exports.MAX_INITIAL);

/**
 * Maximum amount of subsidies in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_SUBSIDY = 0.68e9 * exports.COIN;

assert(exports.MAX_INITIAL / 2 === exports.MAX_SUBSIDY);

/**
 * Maximum amount of money in dollarydoos (consensus).
 * @const {Amount}
 * @default
 */

exports.MAX_MONEY = 2.04e9 * exports.COIN;

assert(exports.MAX_INITIAL + exports.MAX_SUBSIDY === exports.MAX_MONEY);

/**
 * Base block subsidy (consensus).
 * @const {Amount}
 * @default
 */

exports.BASE_REWARD = 2000 * exports.COIN;

assert(2 * exports.BASE_REWARD * 170000 === exports.MAX_SUBSIDY);

/**
 * Block subsidy specifically for the genesis block.
 *
 * Explanation:
 * The max miner subsidy is 680000000, but due
 * to the halving interval it actually ends up
 * as 679999995.79, so add 2.21 coins to the
 * genesis reward output to make MAX_MONEY a
 * thoroughly true value.
 *
 * This, combined with the 3 1/4 year halving
 * interval, causes the supply to run dry
 * after about 100 years (around the year 2119,
 * or height=5,270,000).
 *
 * @const {Amount}
 * @default
 */

exports.GENESIS_REWARD = exports.BASE_REWARD + ((2.21 * exports.COIN) | 0);

/**
 * Genesis key.
 * @const {Buffer}
 */

exports.GENESIS_KEY =
  Buffer.from('f0237ae2e8f860f7d79124fc513f012e5aaa8d23', 'hex');

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
 * Maximum block tree opens.
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_OPENS = 300;

/**
 * Maximum block tree updates.
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_UPDATES = 600;

/**
 * Maximum block tree renewals.
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_RENEWALS = 600;

/**
 * Size of set to pick median time from.
 * @const {Number}
 * @default
 */

exports.MEDIAN_TIMESPAN = 11;

/**
 * Amount to multiply base/non-witness sizes by.
 * @const {Number}
 * @default
 */

exports.WITNESS_SCALE_FACTOR = 4;

/**
 * Maximum TX base size (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_TX_SIZE = 1000000;

/**
 * Maximum TX weight (consensus).
 * @const {Number}
 * @default
 */

exports.MAX_TX_WEIGHT = 4000000;

/**
 * Locktime flag.
 * @const {Number}
 * @default
 */

exports.LOCKTIME_FLAG = (1 << 31) >>> 0;

/**
 * Locktime mask.
 * @const {Number}
 * @default
 */

exports.LOCKTIME_MASK = exports.LOCKTIME_FLAG - 1;

/**
 * Locktime granularity.
 * @const {Number}
 * @default
 */

exports.LOCKTIME_GRANULARITY = 9;

/**
 * Locktime multiplier.
 * @const {Number}
 * @default
 */

exports.LOCKTIME_MULT = 2 ** exports.LOCKTIME_GRANULARITY;

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
 * Block header size.
 * @const {Number}
 * @default
 */

exports.HEADER_SIZE = 236;

/**
 * Block header nonce size.
 * @const {Number}
 * @default
 */

exports.NONCE_SIZE = 24;

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
    mantissa >>>= 8;
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

  const num = new BN(hash, 'be');

  if (num.gt(target))
    return false;

  return true;
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
