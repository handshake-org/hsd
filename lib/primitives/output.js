/*!
 * output.js - output object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const Amount = require('../btc/amount');
const Network = require('../protocol/network');
const Address = require('../primitives/address');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const rules = require('../covenants/rules');
const Covenant = require('./covenant');

/**
 * Represents a transaction output.
 * @alias module:primitives.Output
 * @property {Amount} value
 * @property {Address} address
 */

class Output {
  /**
   * Create an output.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
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
      assert(Number.isSafeInteger(options.value) && options.value >= 0,
        'Value must be a uint64.');
      this.value = options.value;
    }

    if (options.address)
      this.address.fromOptions(options.address);

    if (options.covenant)
      this.covenant.fromOptions(options.covenant);

    return this;
  }

  /**
   * Instantiate output from options object.
   * @param {Object} options
   * @returns {Output}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Inject properties from address/value pair.
   * @private
   * @param {Address} address
   * @param {Amount} value
   * @returns {Output}
   */

  fromScript(address, value) {
    assert(Number.isSafeInteger(value) && value >= 0,
      'Value must be a uint64.');

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

  clone() {
    const output = new this.constructor();
    output.value = this.value;
    output.address.inject(this.address);
    output.covenant.inject(this.covenant);
    return output;
  }

  /**
   * Test equality against another output.
   * @param {Output} output
   * @returns {Boolean}
   */

  equals(output) {
    assert(Output.isOutput(output));
    return this.value === output.value
      && this.address.equals(output.address);
  }

  /**
   * Compare against another output (BIP69).
   * @param {Output} output
   * @returns {Number}
   */

  compare(output) {
    assert(Output.isOutput(output));

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
   * @param {String?} enc
   * @returns {Hash} hash
   */

  getHash(enc) {
    return this.address.getHash(enc);
  }

  /**
   * Convert the input to a more user-friendly object.
   * @returns {Object}
   */

  inspect() {
    return {
      value: Amount.coin(this.value),
      address: this.address,
      covenant: this.covenant
    };
  }

  /**
   * Convert the output to an object suitable
   * for JSON serialization.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON();
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
    if (!rules.isDustworthy(this.covenant.type))
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
   * Inject properties from a JSON object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'Output data is required.');
    assert(Number.isSafeInteger(json.value) && json.value >= 0,
      'Value must be a uint64.');

    this.value = json.value;
    this.address.fromString(json.address);

    if (json.covenant != null)
      this.covenant.fromJSON(json.covenant);

    return this;
  }

  /**
   * Instantiate an Output from a jsonified output object.
   * @param {Object} json - The jsonified output object.
   * @returns {Output}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Write the output to a buffer writer.
   * @param {BufferWriter} bw
   */

  toWriter(bw) {
    bw.writeU64(this.value);
    this.address.toWriter(bw);
    this.covenant.toWriter(bw);
    return bw;
  }

  /**
   * Serialize the output.
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Buffer|String}
   */

  toRaw() {
    const size = this.getSize();
    return this.toWriter(bio.write(size)).render();
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  fromReader(br) {
    this.value = br.readU64();
    this.address.fromReader(br);
    this.covenant.fromReader(br);
    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  /**
   * Instantiate an output from a buffer reader.
   * @param {BufferReader} br
   * @returns {Output}
   */

  static fromReader(br) {
    return new this().fromReader(br);
  }

  /**
   * Instantiate an output from a serialized Buffer.
   * @param {Buffer} data
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Output}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new this().fromRaw(data);
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
