/*!
 * output.js - output object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const Amount = require('../ui/amount');
const Network = require('../protocol/network');
const Address = require('../primitives/address');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const util = require('../utils/util');
const Covenant = require('./covenant');

/**
 * Represents a transaction output.
 * @alias module:primitives.Output
 * @property {Amount} value
 * @property {Address} address
 */

class Output extends bio.Struct {
  /**
   * Create an output.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.value = 0;
    this.address = new Address();
    this.covenant = new Covenant();

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Output data is required.');

    if (options.value != null) {
      assert(util.isU64(options.value), 'Value must be a uint64.');
      this.value = options.value;
    }

    if (options.address)
      this.address.fromOptions(options.address);

    if (options.covenant)
      this.covenant.fromOptions(options.covenant);

    return this;
  }

  /**
   * Inject properties from address/value pair.
   * @private
   * @param {Address} address
   * @param {Amount} value
   * @returns {Output}
   */

  fromScript(address, value) {
    assert(util.isU64(value), 'Value must be a uint64.');

    this.address = Address.fromOptions(address);
    this.value = value;

    return this;
  }

  /**
   * Instantiate output from address/value pair.
   * @param {Address} address
   * @param {Amount} value
   * @returns {Output}
   */

  static fromScript(address, value) {
    return new this().fromScript(address, value);
  }

  /**
   * Clone the output.
   * @returns {Output}
   */

  inject(output) {
    assert(output instanceof this.constructor);
    this.value = output.value;
    this.address.inject(output.address);
    this.covenant.inject(output.covenant);
    return this;
  }

  /**
   * Test equality against another output.
   * @param {Output} output
   * @returns {Boolean}
   */

  equals(output) {
    assert(output instanceof this.constructor);
    return this.value === output.value
      && this.address.equals(output.address);
  }

  /**
   * Compare against another output (BIP69).
   * @param {Output} output
   * @returns {Number}
   */

  compare(output) {
    assert(output instanceof this.constructor);

    const cmp = this.value - output.value;

    if (cmp !== 0)
      return cmp;

    return this.address.compare(output.address);
  }

  /**
   * Get the address.
   * @returns {Address} address
   */

  getAddress() {
    return this.address;
  }

  /**
   * Get the address hash.
   * @returns {Hash} hash
   */

  getHash() {
    return this.address.getHash();
  }

  /**
   * Convert the input to a more user-friendly object.
   * @returns {Object}
   */

  format() {
    return {
      value: Amount.coin(this.value),
      address: this.address,
      covenant: this.covenant
    };
  }

  /**
   * Convert the output to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @returns {Object}
   */

  getJSON(network) {
    network = Network.get(network);

    return {
      value: this.value,
      address: this.address.toString(network),
      covenant: this.covenant.toJSON()
    };
  }

  /**
   * Calculate the dust threshold for this
   * output, based on serialize size and rate.
   * @param {Rate?} rate
   * @returns {Amount}
   */

  getDustThreshold(rate) {
    if (!this.covenant.isDustworthy())
      return 0;

    if (this.address.isUnspendable())
      return 0;

    const scale = consensus.WITNESS_SCALE_FACTOR;

    let size = this.getSize();

    size += 32 + 4 + 1 + (107 / scale | 0) + 4;

    return 3 * policy.getMinFee(size, rate);
  }

  /**
   * Calculate size of serialized output.
   * @returns {Number}
   */

  getSize() {
    return 8 + this.address.getSize() + this.covenant.getVarSize();
  }

  /**
   * Test whether the output should be considered dust.
   * @param {Rate?} rate
   * @returns {Boolean}
   */

  isDust(rate) {
    return this.value < this.getDustThreshold(rate);
  }

  /**
   * Test whether the output is unspendable.
   * @returns {Boolean}
   */

  isUnspendable() {
    return this.address.isUnspendable() || this.covenant.isUnspendable();
  }

  /**
   * Inject properties from a JSON object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'Output data is required.');
    assert(util.isU64(json.value), 'Value must be a uint64.');

    this.value = json.value;
    this.address.fromString(json.address);

    if (json.covenant != null)
      this.covenant.fromJSON(json.covenant);

    return this;
  }

  /**
   * Write the output to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeU64(this.value);
    this.address.write(bw);
    this.covenant.write(bw);
    return bw;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.value = br.readU64();
    this.address.read(br);
    this.covenant.read(br);
    return this;
  }

  /**
   * Test an object to see if it is an Output.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isOutput(obj) {
    return obj instanceof Output;
  }
}

/*
 * Expose
 */

module.exports = Output;
