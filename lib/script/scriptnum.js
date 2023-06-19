/*!
 * scriptnum.js - script number object for hsd.
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const ScriptError = require('./scripterror');

/* eslint valid-typeof: "off" */

/**
 * @typedef {10|16|8|2} FastBase
 */

/*
 * Constants
 */

const EMPTY_ARRAY = Buffer.alloc(0);

const INT32N_MAX = 0x7fffffffn;
const INT32N_MIN = -0x80000000n;

const INT32_MAX = 0x7fffffff;
const INT32_MIN = -0x80000000;

/**
 * Script Number
 * @alias module:script.ScriptNum
 */

class ScriptNum {
  /** @type {bigint} */
  value;

  /**
   * Create a script number.
   * @constructor
   * @param {BigInt} [num=0n]
   */

  constructor(num = 0n) {
    assert(typeof num === 'bigint');
    this.value = num;
  }

  /**
   * is Negative
   * @returns {Boolean}
   */

  isNeg() {
    return this.value < 0n;
  }

  /**
   * Get double value.
   * @returns {Number}
   */

  toDouble() {
    return Number(this.value);
  }

  /**
   * Get Number.
   * Alias to toDouble.
   * @returns {Number}
   */

  toNumber() {
    return this.toDouble();
  }

  /**
   * Get value.
   * @returns {BigInt}
   */

  toBigInt() {
    return this.value;
  }

  /**
   * Cast to int32.
   * @returns {Number}
   */

  getInt() {
    if (this.value < INT32N_MIN)
      return INT32_MIN;

    if (this.value > INT32N_MAX)
      return INT32_MAX;

    return this.toInt();
  }

  /**
   * Cast to int32.
   * NOTE: limits are enforced by getInt.
   * @private
   * @returns {Number}
   */

  toInt() {
    return Number(this.value);
  }

  /**
   * Cast to bool.
   * @returns {Boolean}
   */

  toBool() {
    return this.value !== 0n;
  }

  /**
   * Create ScriptNum from BigInt.
   * @param {BigInt} num
   * @returns {ScriptNum}
   */

  fromBigInt(num) {
    assert(typeof num === 'bigint');
    this.value = num;
    return this;
  }

  /**
   * Create ScriptNum from number.
   * @param {Number} num
   * @returns {ScriptNum}
   */

  fromNumber(num) {
    assert(typeof num === 'number');
    this.value = BigInt(num);
    return this;
  }

  /**
   * Create ScriptNum from string.
   * @param {String} str
   * @param {Number} [base=10]
   * @returns {ScriptNum}
   */

  fromString(str, base = 10) {
    assert(typeof str === 'string');

    this.value = fromStringFast(str, base);

    return this;
  }

  /**
   * Stringify.
   * @param {Number} [base=10]
   * @returns {String}
   */

  toString(base = 10) {
    return this.value.toString(base);
  }

  /**
   * Serialize script number.
   * @returns {Buffer}
   */

  encode() {
    if (this.value === 0n)
      return EMPTY_ARRAY;

    // Need to append sign bit.
    let neg = false;
    let absval = this.value;

    if (absval < 0n) {
      absval = bigInt64(-this.value);
      neg = true;
    }

    // Calculate size.
    const size = byteLength(absval);

    let offset = 0;

    if (testBit(absval, (size * 8) - 1))
      offset = 1;

    // Write number.
    const data = Buffer.allocUnsafe(size + offset);

    switch (size) {
      case 8:
        data[7] = Number((absval >> 56n) & 0xffn);
      case 7:
        data[6] = Number((absval >> 48n) & 0xffn);
      case 6:
        data[5] = Number((absval >> 40n) & 0xffn);
      case 5:
        data[4] = Number((absval >> 32n) & 0xffn);
      case 4:
        data[3] = Number((absval >> 24n) & 0xffn);
      case 3:
        data[2] = Number((absval >> 16n) & 0xffn);
      case 2:
        data[1] = Number((absval >> 8n) & 0xffn);
      case 1:
        data[0] = Number(absval & 0xffn);
    }

    // Append sign bit.
    if (data[size - 1] & 0x80) {
      assert(offset === 1);
      assert(data.length === size + offset);
      data[size] = neg ? 0x80 : 0;
    } else if (neg) {
      assert(offset === 0);
      assert(data.length === size);
      data[size - 1] |= 0x80;
    } else {
      assert(offset === 0);
      assert(data.length === size);
    }

    return data;
  }

  /**
   * Instantiate script number from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {ScriptNum}
   */

  _decode(data) {
    assert(Buffer.isBuffer(data));

    // Empty arrays are always zero.
    if (data.length === 0)
      return this;

    let result = 0n;

    // Read number (9 bytes max).
    switch (data.length) {
      case 8:
        result |= BigInt(data[7]) << 56n;
      case 7:
        result |= BigInt(data[6]) << 48n;
      case 6:
        result |= BigInt(data[5]) << 40n;
      case 5:
        result |= BigInt(data[4]) << 32n;
      case 4:
        result |= BigInt(data[3]) << 24n;
      case 3:
        result |= BigInt(data[2]) << 16n;
      case 2:
        result |= BigInt(data[1]) << 8n;
      case 1:
        result |= BigInt(data[0]);
        break;
      default:
        for (let i = 0; i < data.length; i++)
          result |= BigInt(data[i]) << BigInt(8 * i);
        break;
    }

    // Remove high bit and flip sign.
    if (data[data.length - 1] & 0x80) {
      result = setBit(result, (data.length * 8) - 1, 0);
      result = -result;
    }

    this.value = result;

    return this;
  }

  /**
   * Decode and verify script number.
   * @private
   * @param {Buffer} data
   * @param {Boolean?} minimal - Require minimal encoding.
   * @param {Number?} limit - Size limit.
   * @returns {ScriptNum}
   */

  decode(data, minimal, limit) {
    assert(Buffer.isBuffer(data));

    if (limit != null && data.length > limit)
      throw new ScriptError('UNKNOWN_ERROR', 'Script number overflow.');

    if (minimal && !ScriptNum.isMinimal(data))
      throw new ScriptError('UNKNOWN_ERROR', 'Non-minimal script number.');

    return this._decode(data);
  }

  /**
   * Inspect script number.
   * @returns {String}
   */

  inspect() {
    return `<ScriptNum: ${this.toString(10)}>`;
  }

  /**
   * Test wether a serialized script
   * number is in its most minimal form.
   * @param {Buffer} data
   * @returns {Boolean}
   */

  static isMinimal(data) {
    assert(Buffer.isBuffer(data));

    if (data.length === 0)
      return true;

    if ((data[data.length - 1] & 0x7f) === 0) {
      if (data.length === 1)
        return false;

      if ((data[data.length - 2] & 0x80) === 0)
        return false;
    }

    return true;
  }

  /**
   * Create ScriptNum from string.
   * @param {String} str
   * @param {Number} [base=10]
   * @returns {ScriptNum}
   */

  static fromString(str, base = 10) {
    return new this().fromString(str, base);
  }

  /**
   * Create ScriptNum from number.
   * @param {Number} num
   */

  static fromNumber(num) {
    return new this().fromNumber(num);
  }

  /**
   * Create ScriptNum from bigint.
   * @param {BigInt} num
   * @returns {ScriptNum}
   */

  static fromBigInt(num) {
    return new this().fromBigInt(num);
  }

  /**
   * Decode and verify script number.
   * @param {Buffer} data
   * @param {Boolean?} minimal - Require minimal encoding.
   * @param {Number?} limit - Size limit.
   * @returns {ScriptNum}
   */

  static decode(data, minimal, limit) {
    return new this().decode(data, minimal, limit);
  }

  /**
   * Test whether object is a script number.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isScriptNum(obj) {
    return obj instanceof ScriptNum;
  }
}

/*
 * Helpers
 */

/**
 * Calculate byte length for a bigint.
 * @param {BigInt} num
 * @returns {Number}
 */

function byteLength(num) {
  if (num === 0n)
    return 0;

  if (num < 0n)
    num = -num;

  return Math.ceil(num.toString(2).length / 8);
}

/**
 * Test whether a bigint has a bit set.
 * @param {BigInt} num
 * @param {Number} bit must be between 0 and 63.
 * @returns {Boolean}
 */

function testBit(num, bit) {
  bit &= 63;

  return (num >> BigInt(bit)) & 1n;
}

/**
 * Set specific bit on a bigint.
 * @param {BigInt} num
 * @param {Number} bit must be between 0 and 63.
 * @param {Number} value
 * @returns {BigInt}
 */

function setBit(num, bit, value) {
  bit &= 63;

  if (value === 0)
    return num & ~(1n << BigInt(bit));

  return num | (1n << BigInt(bit));
}

/**
 * Get bigint from string
 * @param {String} str
 * @param {FastBase} base
 * @returns {BigInt}
 */

function fromStringFast(str, base = 10) {
  let neg = false;
  let num;

  if (str.length > 0 && str[0] === '-') {
    neg = true;
    str = str.substring(1);
  }

  switch (base) {
    case 2:
      str = '0b' + str;
      break;
    case 8:
      str = '0o' + str;
      break;
    case 16:
      str = '0x' + str;
      break;
    case 10:
      break;
    default:
      throw new Error('Invalid base.');
  }

  try {
    num = BigInt(str);
  } catch (e) {
    throw new Error('Invalid string.');
  }

  if (neg)
    num = -num;

  return num;
}

/**
 * Make sure number is int64.
 * @param {BigInt} value
 * @returns {BigInt}
 */

function bigInt64(value) {
  return BigInt.asIntN(64, value);
}

/*
 * Expose
 */

module.exports = ScriptNum;
