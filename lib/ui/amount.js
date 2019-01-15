/*!
 * amount.js - amount object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const fixed = require('../utils/fixed');
const {EXP} = require('../protocol/consensus');
const pkg = require('../pkg');

/**
 * Amount
 * Represents a currency amount (base unit internally).
 * @alias module:currency.Amount
 * @property {Amount} value
 */

class Amount {
  /**
   * Create an amount.
   * @constructor
   * @param {(String|Number)?} value
   * @param {String?} unit
   */

  constructor(value, unit) {
    this.value = 0;

    if (value != null)
      this.fromOptions(value, unit);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {(String|Number)?} value
   * @param {String?} unit
   * @returns {Amount}
   */

  fromOptions(value, unit) {
    if (typeof unit === 'string')
      return this.from(unit, value);

    if (typeof value === 'number')
      return this.fromValue(value);

    return this.fromCoins(value);
  }

  /**
   * Get base unit value.
   * @returns {Amount}
   */

  toValue() {
    return this.value;
  }

  /**
   * Get base unit string or value.
   * @param {Boolean?} num
   * @returns {String|Amount}
   */

  toBase(num) {
    if (num)
      return this.value;

    return this.value.toString(10);
  }

  /**
   * Get bits string or value.
   * @param {Boolean?} num
   * @returns {String|Amount}
   */

  toBits(num) {
    return Amount.encode(this.value, 2, num);
  }

  /**
   * Get mhns string or value.
   * @param {Boolean?} num
   * @returns {String|Amount}
   */

  toMilli(num) {
    return Amount.encode(this.value, 3, num);
  }

  /**
   * Get currency string or value.
   * @param {Boolean?} num
   * @returns {String|Amount}
   */

  toCoins(num) {
    return Amount.encode(this.value, EXP, num);
  }

  /**
   * Get unit string or value.
   * @param {String} unit
   * @param {Boolean?} num
   * @returns {String|Amount}
   */

  to(unit, num) {
    switch (unit) {
      case pkg.base:
        return this.toBase(num);
      case `u${pkg.unit}`:
      case 'bits':
        return this.toBits(num);
      case `m${pkg.unit}`:
        return this.toMilli(num);
      case pkg.currency:
        return this.toCoins(num);
    }
    throw new Error(`Unknown unit "${unit}".`);
  }

  /**
   * Convert amount to currency string.
   * @returns {String}
   */

  toString() {
    return this.toCoins();
  }

  /**
   * Inject properties from value.
   * @private
   * @param {Amount} value
   * @returns {Amount}
   */

  fromValue(value) {
    assert(Number.isSafeInteger(value) && value >= 0,
      'Value must be an int64.');
    this.value = value;
    return this;
  }

  /**
   * Inject properties from base unit.
   * @private
   * @param {Number|String} value
   * @returns {Amount}
   */

  fromBase(value) {
    this.value = Amount.decode(value, 0);
    return this;
  }

  /**
   * Inject properties from bits.
   * @private
   * @param {Number|String} value
   * @returns {Amount}
   */

  fromBits(value) {
    this.value = Amount.decode(value, 2);
    return this;
  }

  /**
   * Inject properties from mhns.
   * @private
   * @param {Number|String} value
   * @returns {Amount}
   */

  fromMilli(value) {
    this.value = Amount.decode(value, 3);
    return this;
  }

  /**
   * Inject properties from value.
   * @private
   * @param {Number|String} value
   * @returns {Amount}
   */

  fromCoins(value) {
    this.value = Amount.decode(value, EXP);
    return this;
  }

  /**
   * Inject properties from unit.
   * @private
   * @param {String} unit
   * @param {Number|String} value
   * @returns {Amount}
   */

  from(unit, value) {
    switch (unit) {
      case pkg.base:
        return this.fromBase(value);
      case `u${pkg.unit}`:
      case 'bits':
        return this.fromBits(value);
      case `m${pkg.unit}`:
        return this.fromMilli(value);
      case pkg.unit:
        return this.fromCoins(value);
    }
    throw new Error(`Unknown unit "${unit}".`);
  }

  /**
   * Instantiate amount from options.
   * @param {(String|Number)?} value
   * @param {String?} unit
   * @returns {Amount}
   */

  static fromOptions(value, unit) {
    return new this().fromOptions(value, unit);
  }

  /**
   * Instantiate amount from value.
   * @private
   * @param {Amount} value
   * @returns {Amount}
   */

  static fromValue(value) {
    return new this().fromValue(value);
  }

  /**
   * Instantiate amount from base unit.
   * @param {Number|String} value
   * @returns {Amount}
   */

  static fromBase(value) {
    return new this().fromBase(value);
  }

  /**
   * Instantiate amount from bits.
   * @param {Number|String} value
   * @returns {Amount}
   */

  static fromBits(value) {
    return new this().fromBits(value);
  }

  /**
   * Instantiate amount from milliunit.
   * @param {Number|String} value
   * @returns {Amount}
   */

  static fromMilli(value) {
    return new this().fromMilli(value);
  }

  /**
   * Instantiate amount from unit.
   * @param {Number|String} value
   * @returns {Amount}
   */

  static fromCoins(value) {
    return new this().fromCoins(value);
  }

  /**
   * Instantiate amount from unit.
   * @param {String} unit
   * @param {Number|String} value
   * @returns {Amount}
   */

  static from(unit, value) {
    return new this().from(unit, value);
  }

  /**
   * Inspect amount.
   * @returns {String}
   */

  inspect() {
    return `<Amount: ${this.toString()}>`;
  }

  /**
   * Safely convert base unit to a currency string.
   * This function explicitly avoids any
   * floating point arithmetic.
   * @param {Amount} value - Base unit.
   * @returns {String} Currency string.
   */

  static coin(value, num) {
    if (typeof value === 'string')
      return value;

    return Amount.encode(value, EXP, num);
  }

  /**
   * Safely convert a currency string to base unit.
   * @param {String} str
   * @returns {Amount} Base unit.
   * @throws on parse error
   */

  static value(str) {
    if (typeof str === 'number')
      return str;

    return Amount.decode(str, EXP);
  }

  /**
   * Safely convert base unit to a currency string.
   * @param {Amount} value
   * @param {Number} exp - Exponent.
   * @param {Boolean} num - Return a number.
   * @returns {String|Number}
   */

  static encode(value, exp, num) {
    if (num)
      return fixed.toFloat(value, exp);
    return fixed.encode(value, exp);
  }

  /**
   * Safely convert a currency string to base unit.
   * @param {String|Number} value
   * @param {Number} exp - Exponent.
   * @returns {Amount} Base unit.
   * @throws on parse error
   */

  static decode(value, exp) {
    if (typeof value === 'number')
      return fixed.fromFloat(value, exp);
    return fixed.decode(value, exp);
  }
}

/*
 * Expose
 */

module.exports = Amount;
