/*!
 * covenant.js - covenant object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const util = require('../utils/util');
const rules = require('../covenants/rules');
const consensus = require('../protocol/consensus');
const {encoding} = bio;
const {types, typesByVal} = rules;

/**
 * Covenant
 * @alias module:primitives.Covenant
 * @property {Number} type
 * @property {Buffer[]} items
 * @property {Number} length
 */

class Covenant extends bio.Struct {
  /**
   * Create a covenant.
   * @constructor
   */

  constructor(type, items) {
    super();

    this.type = types.NONE;
    this.items = [];

    if (type != null)
      this.fromOptions(type, items);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(type, items) {
    if (type && typeof type === 'object') {
      items = type.items;
      type = type.type;
    }

    if (Array.isArray(type))
      return this.fromArray(type);

    if (type != null) {
      assert((type & 0xff) === type);
      this.type = type;
      if (items)
        return this.fromArray(items);
      return this;
    }

    return this;
  }

  /**
   * Get an item.
   * @param {Number} index
   * @returns {Buffer}
   */

  get(index) {
    if (index < 0)
      index += this.items.length;

    assert((index >>> 0) === index);
    assert(index < this.items.length);

    return this.items[index];
  }

  /**
   * Set an item.
   * @param {Number} index
   * @param {Buffer} item
   * @returns {Buffer}
   */

  set(index, item) {
    if (index < 0)
      index += this.items.length;

    assert((index >>> 0) === index);
    assert(index <= this.items.length);
    assert(Buffer.isBuffer(item));

    this.items[index] = item;
    return this;
  }

  /**
   * Push an item.
   * @param {Buffer} item
   */

  push(item) {
    assert(Buffer.isBuffer(item));
    this.items.push(item);
    return this;
  }

  /**
   * Get a uint8.
   * @param {Number} index
   * @returns {Number}
   */

  getU8(index) {
    const item = this.get(index);
    assert(item.length === 1);
    return item[0];
  }

  /**
   * Push a uint8.
   * @param {Number} num
   */

  pushU8(num) {
    assert((num & 0xff) === num);
    const item = Buffer.allocUnsafe(1);
    item[0] = num;
    this.push(item);
    return this;
  }

  /**
   * Get a uint32.
   * @param {Number} index
   * @returns {Number}
   */

  getU32(index) {
    const item = this.get(index);
    assert(item.length === 4);
    return bio.readU32(item, 0);
  }

  /**
   * Push a uint32.
   * @param {Number} num
   */

  pushU32(num) {
    assert((num >>> 0) === num);
    const item = Buffer.allocUnsafe(4);
    bio.writeU32(item, num, 0);
    this.push(item);
    return this;
  }

  /**
   * Get a hash.
   * @param {Number} index
   * @returns {Buffer}
   */

  getHash(index) {
    const item = this.get(index);
    assert(item.length === 32);
    return item;
  }

  /**
   * Push a hash.
   * @param {Buffer} hash
   */

  pushHash(hash) {
    assert(Buffer.isBuffer(hash));
    assert(hash.length === 32);
    this.push(hash);
    return this;
  }

  /**
   * Get a string.
   * @param {Number} index
   * @returns {String}
   */

  getString(index) {
    const item = this.get(index);
    assert(item.length >= 1 && item.length <= 63);
    return item.toString('binary');
  }

  /**
   * Push a string.
   * @param {String} str
   */

  pushString(str) {
    assert(typeof str === 'string');
    assert(str.length >= 1 && str.length <= 63);
    this.push(Buffer.from(str, 'binary'));
    return this;
  }

  /**
   * Test whether the covenant is known.
   * @returns {Boolean}
   */

  isKnown() {
    return this.type <= types.REVOKE;
  }

  /**
   * Test whether the covenant is unknown.
   * @returns {Boolean}
   */

  isUnknown() {
    return this.type > types.REVOKE;
  }

  /**
   * Test whether the covenant is a payment.
   * @returns {Boolean}
   */

  isNone() {
    return this.type === types.NONE;
  }

  /**
   * Test whether the covenant is a claim.
   * @returns {Boolean}
   */

  isClaim() {
    return this.type === types.CLAIM;
  }

  /**
   * Test whether the covenant is an open.
   * @returns {Boolean}
   */

  isOpen() {
    return this.type === types.OPEN;
  }

  /**
   * Test whether the covenant is a bid.
   * @returns {Boolean}
   */

  isBid() {
    return this.type === types.BID;
  }

  /**
   * Test whether the covenant is a reveal.
   * @returns {Boolean}
   */

  isReveal() {
    return this.type === types.REVEAL;
  }

  /**
   * Test whether the covenant is a redeem.
   * @returns {Boolean}
   */

  isRedeem() {
    return this.type === types.REDEEM;
  }

  /**
   * Test whether the covenant is a register.
   * @returns {Boolean}
   */

  isRegister() {
    return this.type === types.REGISTER;
  }

  /**
   * Test whether the covenant is an update.
   * @returns {Boolean}
   */

  isUpdate() {
    return this.type === types.UPDATE;
  }

  /**
   * Test whether the covenant is a renewal.
   * @returns {Boolean}
   */

  isRenew() {
    return this.type === types.RENEW;
  }

  /**
   * Test whether the covenant is a transfer.
   * @returns {Boolean}
   */

  isTransfer() {
    return this.type === types.TRANSFER;
  }

  /**
   * Test whether the covenant is a finalize.
   * @returns {Boolean}
   */

  isFinalize() {
    return this.type === types.FINALIZE;
  }

  /**
   * Test whether the covenant is a revocation.
   * @returns {Boolean}
   */

  isRevoke() {
    return this.type === types.REVOKE;
  }

  /**
   * Test whether the covenant is name-related.
   * @returns {Boolean}
   */

  isName() {
    if (this.type < types.CLAIM)
      return false;

    if (this.type > types.REVOKE)
      return false;

    return true;
  }

  /**
   * Test whether a covenant type should be
   * considered subject to the dust policy rule.
   * @returns {Boolean}
   */

  isDustworthy() {
    switch (this.type) {
      case types.NONE:
      case types.BID:
        return true;
      default:
        return this.type > types.REVOKE;
    }
  }

  /**
   * Test whether a coin should be considered
   * unspendable in the coin selector.
   * @returns {Boolean}
   */

  isNonspendable() {
    switch (this.type) {
      case types.NONE:
      case types.OPEN:
      case types.REDEEM:
        return false;
      default:
        return true;
    }
  }

  /**
   * Test whether a covenant should be considered "linked".
   * @returns {Boolean}
   */

  isLinked() {
    return this.type >= types.REVEAL && this.type <= types.REVOKE;
  }

  /**
   * Convert covenant to an array of buffers.
   * @returns {Buffer[]}
   */

  toArray() {
    return this.items.slice();
  }

  /**
   * Inject properties from an array of buffers.
   * @private
   * @param {Buffer[]} items
   */

  fromArray(items) {
    assert(Array.isArray(items));
    this.items = items;
    return this;
  }

  /**
   * Test whether the covenant is unspendable.
   * @returns {Boolean}
   */

  isUnspendable() {
    return this.type === types.REVOKE;
  }

  /**
   * Convert the covenant to a string.
   * @returns {String}
   */

  toString() {
    return this.encode().toString('hex', 1);
  }

  /**
   * Inject properties from covenant.
   * Used for cloning.
   * @private
   * @param {Covenant} covenant
   * @returns {Covenant}
   */

  inject(covenant) {
    assert(covenant instanceof this.constructor);
    this.type = covenant.type;
    this.items = covenant.items.slice();
    return this;
  }

  /**
   * Test the covenant against a bloom filter.
   * @param {Bloom} filter
   * @returns {Boolean}
   */

  test(filter) {
    for (const item of this.items) {
      if (item.length === 0)
        continue;

      if (filter.test(item))
        return true;
    }

    return false;
  }

  /**
   * Find a data element in a covenant.
   * @param {Buffer} data - Data element to match against.
   * @returns {Number} Index (`-1` if not present).
   */

  indexOf(data) {
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.equals(data))
        return i;
    }
    return -1;
  }

  /**
   * Calculate size of the covenant
   * excluding the varint size bytes.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    for (const item of this.items)
      size += encoding.sizeVarBytes(item);

    return size;
  }

  /**
   * Calculate size of the covenant
   * including the varint size bytes.
   * @returns {Number}
   */

  getVarSize() {
    return 1 + encoding.sizeVarint(this.items.length) + this.getSize();
  }

  /**
   * Write covenant to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeU8(this.type);
    bw.writeVarint(this.items.length);

    for (const item of this.items)
      bw.writeVarBytes(item);

    return bw;
  }

  /**
   * Encode covenant.
   * @returns {Buffer}
   */

  encode() {
    const bw = bio.write(this.getVarSize());
    this.write(bw);
    return bw.render();
  }

  /**
   * Convert covenant to a hex string.
   * @returns {String}
   */

  getJSON() {
    const items = [];

    for (const item of this.items)
      items.push(item.toString('hex'));

    return {
      type: this.type,
      action: typesByVal[this.type],
      items
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {String} json
   */

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Covenant must be an object.');
    assert((json.type & 0xff) === json.type);
    assert(Array.isArray(json.items));

    this.type = json.type;

    for (const str of json.items) {
      const item = util.parseHex(str, -1);
      this.items.push(item);
    }

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.type = br.readU8();

    const count = br.readVarint();

    if (count > consensus.MAX_SCRIPT_STACK)
      throw new Error('Too many covenant items.');

    for (let i = 0; i < count; i++)
      this.items.push(br.readVarBytes());

    return this;
  }

  /**
   * Inject items from string.
   * @private
   * @param {String|String[]} items
   */

  fromString(items) {
    if (!Array.isArray(items)) {
      assert(typeof items === 'string');

      items = items.trim();

      if (items.length === 0)
        return this;

      items = items.split(/\s+/);
    }

    for (const item of items)
      this.items.push(util.parseHex(item, -1));

    return this;
  }

  /**
   * Inspect a covenant object.
   * @returns {String}
   */

  format() {
    return `<Covenant: ${this.type}:${this.toString()}>`;
  }

  /**
   * Insantiate covenant from an array of buffers.
   * @param {Buffer[]} items
   * @returns {Covenant}
   */

  static fromArray(items) {
    return new this().fromArray(items);
  }

  /**
   * Test an object to see if it is a covenant.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isCovenant(obj) {
    return obj instanceof Covenant;
  }
}

Covenant.types = types;

/*
 * Expose
 */

module.exports = Covenant;
