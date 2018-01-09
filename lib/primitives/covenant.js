/*!
 * covenant.js - covenant object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const rules = require('../covenants/rules');
const {encoding} = bio;
const {types} = rules;

/**
 * Covenant
 * @alias module:primitives.Covenant
 * @extends Stack
 * @property {Number} type
 * @property {Buffer[]} items
 * @property {Number} length
 */

class Covenant {
  /**
   * Create a covenant.
   * @alias module:script.Covenant
   * @constructor
   */

  constructor(type, items) {
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
   * Instantiate witness from options.
   * @param {Object} options
   * @returns {Witness}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  isUnknown() {
    return this.type > rules.MAX_COVENANT_TYPE;
  }

  getString(index, enc) {
    assert(index < this.items.length);
    return this.items[index].toString(enc || 'ascii');
  }

  getU32(index) {
    assert(index < this.items.length);
    assert(this.items[index].length === 4);
    return this.items[index].readUInt32LE(0, true);
  }

  getU64(index) {
    assert(index < this.items.length);
    assert(this.items[index].length === 8);
    try {
      return encoding.readU64(this.items[index], 0);
    } catch (e) {
      return -1;
    }
  }

  /**
   * Convert witness to an array of buffers.
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
   * Insantiate witness from an array of buffers.
   * @param {Buffer[]} items
   * @returns {Witness}
   */

  static fromArray(items) {
    return new this().fromArray(items);
  }

  toString() {
    return this.toRaw().toString('hex', 1);
  }

  /**
   * Inspect a Witness object.
   * @returns {String} Human-readable script.
   */

  inspect() {
    return `<Covenant: ${this.type}:${this.toString()}>`;
  }

  /**
   * Clone the witness object.
   * @returns {Witness} A clone of the current witness object.
   */

  clone() {
    return new this.constructor().inject(this);
  }

  /**
   * Inject properties from witness.
   * Used for cloning.
   * @private
   * @param {Covenant} covenant
   * @returns {Covenant}
   */

  inject(covenant) {
    this.type = covenant.type;
    this.items = covenant.items.slice();
    return this;
  }

  /**
   * Test the witness against a bloom filter.
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

  string(i, enc) {
    assert(i < this.items.length);
    return this.items[i].toString(enc || 'ascii');
  }

  hash(i, enc) {
    assert(i < this.items.length);
    const item = blake2b.digest(this.items[i]);
    return enc === 'hex' ? item.toString('hex') : item;
  }

  /**
   * Find a data element in a witness.
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
   * Calculate size of the witness
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
   * Calculate size of the witness
   * including the varint size bytes.
   * @returns {Number}
   */

  getVarSize() {
    return 1 + encoding.sizeVarint(this.items.length) + this.getSize();
  }

  /**
   * Write witness to a buffer writer.
   * @param {BufferWriter} bw
   */

  toWriter(bw) {
    bw.writeU8(this.type);
    bw.writeVarint(this.items.length);

    for (const item of this.items)
      bw.writeVarBytes(item);

    return bw;
  }

  /**
   * Encode the witness to a Buffer.
   * @param {String} enc - Encoding, either `'hex'` or `null`.
   * @returns {Buffer|String} Serialized script.
   */

  toRaw() {
    const size = this.getVarSize();
    return this.toWriter(bio.write(size)).render();
  }

  /**
   * Convert witness to a hex string.
   * @returns {String}
   */

  toJSON() {
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
      assert(typeof str === 'string');
      const item = Buffer.from(str, 'hex');
      assert(item.length === (str.length >>> 1));
      this.items.push(item);
    }

    return this;
  }

  /**
   * Insantiate witness from a hex string.
   * @param {String} json
   * @returns {Witness}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  fromReader(br) {
    this.type = br.readU8();

    const count = br.readVarint();

    for (let i = 0; i < count; i++)
      this.items.push(br.readVarBytes());

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
   * Create a witness from a buffer reader.
   * @param {BufferReader} br
   */

  static fromReader(br) {
    return new this().fromReader(br);
  }

  /**
   * Create a witness from a serialized buffer.
   * @param {Buffer|String} data - Serialized witness.
   * @param {String?} enc - Either `"hex"` or `null`.
   * @returns {Witness}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new this().fromRaw(data);
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
      this.items.push(Buffer.from(item, 'hex'));

    return this;
  }

  /**
   * Parse a test script/array
   * string into a witness object. _Must_
   * contain only stack items (no non-push
   * opcodes).
   * @param {String|String[]} items - Script string.
   * @returns {Witness}
   * @throws Parse error.
   */

  static fromString(items) {
    return new this().fromString(items);
  }

  /**
   * Test an object to see if it is a Witness.
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
