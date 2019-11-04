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
 * @property {Number} value
 */

class Amount {
  /**
   * Create an amount.
   * @constructor
   * @param {(String|Number)?} value
   * @param {AmountUnitType} [unit=doo]
   */

  constructor(value, unit) {
    this.value = 0;

    if (value != null)
      this.fromOptions(value, unit);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {String|Number} value
   * @param {AmountUnitType} [unit=doo]
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
   * @param {Boolean} [num=false] - Return a number.
   * @returns {String|Amount}
   */

  toBase(num) {
    if (num)
      return this.value;

    return this.value.toString(10);
  }

  /**
   * Get mhns string or value.
   * @param {Boolean} [num=false] - Return a number.
   * @returns {String|Amount}
   */

  toMilli(num) {
    return Amount.encode(this.value, 3, num);
  }

  /**
   * Get currency string or value.
   * @param {Boolean} [num=false] - Return a number.
   * @returns {String|Amount}
   */

  toCoins(num) {
    return Amount.encode(this.value, EXP, num);
  }

  /**
   * Get unit string or value.
   * @param {AmountUnitType} unit
   * @param {Boolean} [num=false] - Return a number.
   * @returns {String|Amount}
   * @throws on incorrect unit type.
   */

  to(unit, num) {
    switch (unit) {
      case pkg.base:
      case `u${pkg.unit}`:
        return this.toBase(num);
      case `m${pkg.unit}`:
        return this.toMilli(num);
      case pkg.unit:
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
   * @param {AmountUnitType} unit
   * @param {Number|String} value
   * @returns {Amount}
   * @throws on incorrect unit type.
   */

  from(unit, value) {
    switch (unit) {
      case pkg.base:
      case `u${pkg.unit}`:
        return this.fromBase(value);
      case `m${pkg.unit}`:
        return this.fromMilli(value);
      case pkg.unit:
      case pkg.currency:
        return this.fromCoins(value);
    }
    throw new Error(`Unknown unit "${unit}".`);
  }

  /**
   * Instantiate amount from options.
   * @param {String|Number} value
   * @param {AmountUnitType} [unit=doo]
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
   * @param {AmountUnitType} unit
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
   * @param {Boolean} [num=false] - Return a number.
   * @returns {String|Number} Currency string.
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
   * @param {Boolean} [num=false] - Return a number.
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
