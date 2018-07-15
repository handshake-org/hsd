/*!
 * covenant.js - covenant object for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const util = require('../utils/util');
const rules = require('../covenants/rules');
const {encoding} = bio;
const {types} = rules;

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
   * Test whether the covenant is unknown.
   * @returns {Boolean}
   */

  isUnknown() {
    return this.type > rules.MAX_COVENANT_TYPE;
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
   * Convert covenant to a hex string.
   * @returns {String}
   */

  getJSON() {
    const items = [];

    for (const item of this.items)
      items.push(item.toString('hex'));

    return {
      type: this.type,
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
