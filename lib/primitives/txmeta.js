/*!
 * txmeta.js - extended transaction object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const util = require('../utils/util');
const TX = require('./tx');

/**
 * TXMeta
 * An extended transaction object.
 * @alias module:primitives.TXMeta
 */

class TXMeta extends bio.Struct {
  /**
   * Create an extended transaction.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.tx = new TX();
    this.mtime = util.now();
    this.height = -1;
    this.block = null;
    this.time = 0;
    this.index = -1;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    if (options.tx) {
      assert(options.tx instanceof TX);
      this.tx = options.tx;
    }

    if (options.mtime != null) {
      assert(util.isU64(options.mtime));
      this.mtime = options.mtime;
    }

    if (options.height != null) {
      assert(options.height === -1
        || (options.height >>> 0) === options.height);
      this.height = options.height;
    }

    if (options.block !== undefined) {
      assert(options.block === null || Buffer.isBuffer(options.block));
      this.block = options.block;
    }

    if (options.time != null) {
      assert(util.isU64(options.time));
      this.time = options.time;
    }

    if (options.index != null) {
      assert(options.index === -1 || (options.index >>> 0) === options.index);
      this.index = options.index;
    }

    return this;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromTX(tx, entry, index) {
    this.tx = tx;
    if (entry) {
      this.height = entry.height;
      this.block = entry.hash;
      this.time = entry.time;
      this.index = index;
    }
    return this;
  }

  /**
   * Instantiate TXMeta from options.
   * @param {Object} options
   * @returns {TXMeta}
   */

  static fromTX(tx, entry, index) {
    return new this().fromTX(tx, entry, index);
  }

  /**
   * Inspect the transaction.
   * @returns {Object}
   */

  format(view) {
    const data = this.tx.format(view, null, this.index);
    data.mtime = this.mtime;
    data.height = this.height;
    data.block = this.block ? this.block.toString('hex') : null;
    data.time = this.time;
    return data;
  }

  /**
   * Convert the transaction to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @param {CoinView} view
   * @returns {Object}
   */

  getJSON(network, view, chainHeight) {
    const json = this.tx.getJSON(network, view, null, this.index);
    json.mtime = this.mtime;
    json.height = this.height;
    json.block = this.block ? this.block.toString('hex') : null;
    json.time = this.time;
    json.confirmations = 0;

    if (chainHeight != null && this.height !== -1)
      json.confirmations = chainHeight - this.height + 1;

    return json;
  }

  /**
   * Inject properties from a json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    this.tx.fromJSON(json);

    assert(util.isU64(json.mtime));
    assert(json.height === -1 || (json.height >>> 0) === json.height);
    assert(!json.block || typeof json.block === 'string');
    assert(util.isU64(json.time));
    assert(json.index === -1 || (json.index >>> 0) === json.index);

    this.mtime = json.mtime;
    this.height = json.height;
    this.block = json.block ? util.parseHex(json.block, 32) : null;
    this.index = json.index;

    return this;
  }

  /**
   * Calculate serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += this.tx.getSize();
    size += 4;

    if (this.block) {
      size += 1;
      size += 32;
      size += 4 * 3;
    } else {
      size += 1;
    }

    return size;
  }

  /**
   * Serialize a transaction to "extended format".
   * This is the serialization format we use internally
   * to store transactions in the database. The extended
   * serialization includes the height, block hash, index,
   * timestamp, and pending-since time.
   * @returns {Buffer}
   */

  write(bw) {
    this.tx.write(bw);

    bw.writeU32(this.mtime);

    if (this.block) {
      bw.writeU8(1);
      bw.writeHash(this.block);
      bw.writeU32(this.height);
      bw.writeU32(this.time);
      bw.writeU32(this.index);
    } else {
      bw.writeU8(0);
    }

    return bw;
  }

  /**
   * Inject properties from "extended" serialization format.
   * @private
   * @param {Buffer} data
   */

  read(br) {
    this.tx.read(br);

    this.mtime = br.readU32();

    if (br.readU8() === 1) {
      this.block = br.readHash();
      this.height = br.readU32();
      this.time = br.readU32();
      this.index = br.readU32();
      if (this.index === 0xffffffff)
        this.index = -1;
    }

    return this;
  }

  /**
   * Test whether an object is an TXMeta.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isTXMeta(obj) {
    return obj instanceof TXMeta;
  }
}

/*
 * Expose
 */

module.exports = TXMeta;
