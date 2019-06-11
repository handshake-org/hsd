/*!
 * input.js - input object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const Network = require('../protocol/network');
const Witness = require('../script/witness');
const Outpoint = require('./outpoint');

/**
 * Input
 * Represents a transaction input.
 * @alias module:primitives.Input
 * @property {Outpoint} prevout - Outpoint.
 * @property {Script} script - Input script / scriptSig.
 * @property {Number} sequence - nSequence.
 * @property {Witness} witness - Witness (empty if not present).
 */

class Input extends bio.Struct {
  /**
   * Create transaction input.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.prevout = new Outpoint();
    this.witness = new Witness();
    this.sequence = 0xffffffff;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Input data is required.');

    this.prevout.fromOptions(options.prevout);

    if (options.witness)
      this.witness.fromOptions(options.witness);

    if (options.sequence != null) {
      assert((options.sequence >>> 0) === options.sequence,
        'Sequence must be a uint32.');
      this.sequence = options.sequence;
    }

    return this;
  }

  /**
   * Clone the input.
   * @returns {Input}
   */

  inject(input) {
    this.prevout = input.prevout;
    this.witness.inject(input.witness);
    this.sequence = input.sequence;
    return this;
  }

  /**
   * Test equality against another input.
   * @param {Input} input
   * @returns {Boolean}
   */

  equals(input) {
    assert(Input.isInput(input));
    return this.prevout.equals(input.prevout);
  }

  /**
   * Compare against another input (BIP69).
   * @param {Input} input
   * @returns {Number}
   */

  compare(input) {
    assert(Input.isInput(input));
    return this.prevout.compare(input.prevout);
  }

  /**
   * Get the previous output script's address. Will "guess"
   * based on the input script and/or witness if coin
   * is not available.
   * @param {Coin?} coin
   * @returns {Address?} addr
   */

  getAddress(coin) {
    if (this.isCoinbase())
      return null;

    if (coin)
      return coin.getAddress();

    return this.witness.getInputAddress();
  }

  /**
   * Get the address hash.
   * @param {Coin?} coin
   * @returns {Hash} hash
   */

  getHash(coin) {
    const addr = this.getAddress(coin);

    if (!addr)
      return null;

    return addr.getHash();
  }

  /**
   * Test to see if nSequence is equal to uint32max.
   * @returns {Boolean}
   */

  isFinal() {
    return this.sequence === 0xffffffff;
  }

  /**
   * Test to see if outpoint is null.
   * @returns {Boolean}
   */

  isCoinbase() {
    return this.prevout.isNull();
  }

  /**
   * Convert the input to a more user-friendly object.
   * @param {Coin?} coin
   * @returns {Object}
   */

  format(coin) {
    return {
      address: this.getAddress(coin),
      prevout: this.prevout,
      witness: this.witness,
      sequence: this.sequence,
      coin: coin || null
    };
  }

  /**
   * Convert the input to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @param {Coin} coin
   * @param {Path} path
   * @returns {Object}
   */

  getJSON(network, coin, path) {
    network = Network.get(network);

    let addr;
    if (!coin) {
      addr = this.getAddress();
      if (addr)
        addr = addr.toString(network);
    }

    return {
      prevout: this.prevout.toJSON(),
      witness: this.witness.toJSON(),
      sequence: this.sequence,
      address: addr,
      coin: coin ? coin.getJSON(network, true) : undefined,
      path: path ? path.getJSON(network) : undefined
    };
  }

  /**
   * Inject properties from a JSON object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'Input data is required.');
    assert((json.sequence >>> 0) === json.sequence,
      'Sequence must be a uint32.');
    this.prevout.fromJSON(json.prevout);
    this.witness.fromJSON(json.witness);
    this.sequence = json.sequence;
    return this;
  }

  /**
   * Calculate size of serialized input.
   * @returns {Number}
   */

  getSize() {
    return 40;
  }

  /**
   * Write the input to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    this.prevout.write(bw);
    bw.writeU32(this.sequence);
    return bw;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.prevout.read(br);
    this.sequence = br.readU32();
    return this;
  }

  /**
   * Inject properties from outpoint.
   * @private
   * @param {Outpoint} outpoint
   */

  fromOutpoint(outpoint) {
    assert(Buffer.isBuffer(outpoint.hash));
    assert(typeof outpoint.index === 'number');
    this.prevout.hash = outpoint.hash;
    this.prevout.index = outpoint.index;
    return this;
  }

  /**
   * Instantiate input from outpoint.
   * @param {Outpoint}
   * @returns {Input}
   */

  static fromOutpoint(outpoint) {
    return new this().fromOutpoint(outpoint);
  }

  /**
   * Inject properties from coin.
   * @private
   * @param {Coin} coin
   */

  fromCoin(coin) {
    assert(Buffer.isBuffer(coin.hash));
    assert(typeof coin.index === 'number');
    this.prevout.hash = coin.hash;
    this.prevout.index = coin.index;
    return this;
  }

  /**
   * Instantiate input from coin.
   * @param {Coin}
   * @returns {Input}
   */

  static fromCoin(coin) {
    return new this().fromCoin(coin);
  }

  /**
   * Inject properties from transaction.
   * @private
   * @param {TX} tx
   * @param {Number} index
   */

  fromTX(tx, index) {
    assert(tx);
    assert(typeof index === 'number');
    assert(index >= 0 && index < tx.outputs.length);
    this.prevout.hash = tx.hash();
    this.prevout.index = index;
    return this;
  }

  /**
   * Instantiate input from tx.
   * @param {TX} tx
   * @param {Number} index
   * @returns {Input}
   */

  static fromTX(tx, index) {
    return new this().fromTX(tx, index);
  }

  /**
   * Test an object to see if it is an Input.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isInput(obj) {
    return obj instanceof Input;
  }
}

/*
 * Expose
 */

module.exports = Input;
