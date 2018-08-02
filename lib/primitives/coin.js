/*!
 * coin.js - coin object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Amount = require('../ui/amount');
const Output = require('./output');
const Network = require('../protocol/network');
const consensus = require('../protocol/consensus');
const Outpoint = require('./outpoint');
const util = require('../utils/util');

/**
 * Coin
 * Represents an unspent output.
 * @alias module:primitives.Coin
 * @extends Output
 * @property {Number} version
 * @property {Number} height
 * @property {Amount} value
 * @property {Script} script
 * @property {Boolean} coinbase
 * @property {Hash} hash
 * @property {Number} index
 */

class Coin extends Output {
  /**
   * Create a coin.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.version = 1;
    this.height = -1;
    this.coinbase = false;
    this.hash = consensus.ZERO_HASH;
    this.index = 0;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject options into coin.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Coin data is required.');

    if (options.version != null) {
      assert((options.version >>> 0) === options.version,
        'Version must be a uint32.');
      this.version = options.version;
    }

    if (options.height != null) {
      if (options.height !== -1) {
        assert((options.height >>> 0) === options.height,
          'Height must be a uint32.');
        this.height = options.height;
      } else {
        this.height = -1;
      }
    }

    if (options.value != null) {
      assert(Number.isSafeInteger(options.value) && options.value >= 0,
        'Value must be a uint64.');
      this.value = options.value;
    }

    if (options.address)
      this.address.fromOptions(options.address);

    if (options.covenant)
      this.covenant.fromOptions(options.covenant);

    if (options.coinbase != null) {
      assert(typeof options.coinbase === 'boolean',
        'Coinbase must be a boolean.');
      this.coinbase = options.coinbase;
    }

    if (options.hash != null) {
      assert(Buffer.isBuffer(options.hash));
      this.hash = options.hash;
    }

    if (options.index != null) {
      assert((options.index >>> 0) === options.index,
        'Index must be a uint32.');
      this.index = options.index;
    }

    return this;
  }

  /**
   * Clone the coin.
   * @private
   * @returns {Coin}
   */

  clone() {
    assert(false, 'Coins are not cloneable.');
  }

  /**
   * Calculate number of confirmations since coin was created.
   * @param {Number?} height - Current chain height. Network
   * height is used if not passed in.
   * @return {Number}
   */

  getDepth(height) {
    assert(typeof height === 'number', 'Must pass a height.');

    if (this.height === -1)
      return 0;

    if (height === -1)
      return 0;

    if (height < this.height)
      return 0;

    return height - this.height + 1;
  }

  /**
   * Serialize coin to a key
   * suitable for a hash table.
   * @returns {String}
   */

  toKey() {
    return Outpoint.toKey(this.hash, this.index);
  }

  /**
   * Inject properties from hash table key.
   * @private
   * @param {String} key
   * @returns {Coin}
   */

  fromKey(key) {
    const {hash, index} = Outpoint.fromKey(key);
    this.hash = hash;
    this.index = index;
    return this;
  }

  /**
   * Instantiate coin from hash table key.
   * @param {String} key
   * @returns {Coin}
   */

  static fromKey(key) {
    return new this().fromKey(key);
  }

  /**
   * Get little-endian hash.
   * @returns {Hash}
   */

  txid() {
    if (!this.hash)
      return null;
    return this.hash.toString('hex');
  }

  /**
   * Convert the coin to a more user-friendly object.
   * @returns {Object}
   */

  format() {
    return {
      version: this.version,
      height: this.height,
      value: Amount.coin(this.value),
      address: this.address,
      covenant: this.covenant.toJSON(),
      coinbase: this.coinbase,
      hash: this.txid(),
      index: this.index
    };
  }

  /**
   * Convert the coin to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @param {Boolean} minimal
   * @returns {Object}
   */

  getJSON(network, minimal) {
    network = Network.get(network);

    return {
      version: this.version,
      height: this.height,
      value: this.value,
      address: this.address.toString(network),
      covenant: this.covenant.toJSON(),
      coinbase: this.coinbase,
      hash: !minimal ? this.txid() : undefined,
      index: !minimal ? this.index : undefined
    };
  }

  /**
   * Inject JSON properties into coin.
   * @private
   * @param {Object} json
   */

  fromJSON(json, network) {
    assert(json, 'Coin data required.');
    assert((json.version >>> 0) === json.version, 'Version must be a uint32.');
    assert(json.height === -1 || (json.height >>> 0) === json.height,
      'Height must be a uint32.');
    assert(util.isU64(json.value), 'Value must be a uint64.');
    assert(typeof json.coinbase === 'boolean', 'Coinbase must be a boolean.');

    this.version = json.version;
    this.height = json.height;
    this.value = json.value;
    this.address.fromString(json.address, network);
    this.coinbase = json.coinbase;

    if (json.covenant != null)
      this.covenant.fromJSON(json.covenant);

    if (json.hash != null) {
      assert((json.index >>> 0) === json.index, 'Index must be a uint32.');
      this.hash = util.parseHex(json.hash, 32);
      this.index = json.index;
    }

    return this;
  }

  /**
   * Calculate size of coin.
   * @returns {Number}
   */

  getSize() {
    return 17 + this.address.getSize() + this.covenant.getVarSize();
  }

  /**
   * Write the coin to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    let height = this.height;

    if (height === -1)
      height = 0xffffffff;

    bw.writeU32(this.version);
    bw.writeU32(height);
    bw.writeU64(this.value);
    this.address.write(bw);
    this.covenant.write(bw);
    bw.writeU8(this.coinbase ? 1 : 0);

    return bw;
  }

  /**
   * Inject properties from serialized buffer writer.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.version = br.readU32();
    this.height = br.readU32();
    this.value = br.readU64();
    this.address.read(br);
    this.covenant.read(br);
    this.coinbase = br.readU8() === 1;

    if (this.height === 0xffffffff)
      this.height = -1;

    return this;
  }

  /**
   * Inject properties from TX.
   * @param {TX} tx
   * @param {Number} index
   */

  fromTX(tx, index, height) {
    assert(typeof index === 'number');
    assert(typeof height === 'number');
    assert(index >= 0 && index < tx.outputs.length);
    this.version = tx.version;
    this.height = height;
    this.value = tx.outputs[index].value;
    this.address = tx.outputs[index].address;
    this.covenant = tx.outputs[index].covenant;
    this.coinbase = tx.isCoinbase();
    this.hash = tx.hash();
    this.index = index;
    return this;
  }

  /**
   * Instantiate a coin from a TX
   * @param {TX} tx
   * @param {Number} index - Output index.
   * @returns {Coin}
   */

  static fromTX(tx, index, height) {
    return new this().fromTX(tx, index, height);
  }

  /**
   * Test an object to see if it is a Coin.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isCoin(obj) {
    return obj instanceof Coin;
  }
}

/*
 * Expose
 */

module.exports = Coin;
