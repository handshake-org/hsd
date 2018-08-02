/*!
 * path.js - path object for wallets
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const Address = require('../primitives/address');
const {encoding} = bio;

/**
 * Path
 * @alias module:wallet.Path
 * @property {String} name - Account name.
 * @property {Number} account - Account index.
 * @property {Number} branch - Branch index.
 * @property {Number} index - Address index.
 */

class Path extends bio.Struct {
  /**
   * Create a path.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.keyType = Path.types.HD;

    this.name = null; // Passed in by caller.
    this.account = 0;

    this.version = 0;
    this.branch = -1;
    this.index = -1;

    this.encrypted = false;
    this.data = null;

    this.hash = null; // Passed in by caller.

    if (options)
      this.fromOptions(options);
  }

  /**
   * Instantiate path from options object.
   * @private
   * @param {Object} options
   * @returns {Path}
   */

  fromOptions(options) {
    this.keyType = options.keyType;

    this.name = options.name;
    this.account = options.account;
    this.branch = options.branch;
    this.index = options.index;

    this.encrypted = options.encrypted;
    this.data = options.data;

    this.version = options.version;
    this.hash = options.hash;

    return this;
  }

  /**
   * Clone the path object.
   * @returns {Path}
   */

  inject(path) {
    this.keyType = path.keyType;

    this.name = path.name;
    this.account = path.account;
    this.branch = path.branch;
    this.index = path.index;

    this.encrypted = path.encrypted;
    this.data = path.data;

    this.version = path.version;
    this.hash = path.hash;

    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  read(br) {
    this.account = br.readU32();
    this.keyType = br.readU8();
    this.version = br.readU8();

    switch (this.keyType) {
      case Path.types.HD:
        this.branch = br.readU32();
        this.index = br.readU32();
        break;
      case Path.types.KEY:
        this.encrypted = br.readU8() === 1;
        this.data = br.readVarBytes();
        break;
      case Path.types.ADDRESS:
        // Hash will be passed in by caller.
        break;
      default:
        assert(false);
        break;
    }

    return this;
  }

  /**
   * Calculate serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += 6;

    switch (this.keyType) {
      case Path.types.HD:
        size += 8;
        break;
      case Path.types.KEY:
        size += 1;
        size += encoding.sizeVarBytes(this.data);
        break;
    }

    return size;
  }

  /**
   * Serialize path.
   * @returns {Buffer}
   */

  write(bw) {
    bw.writeU32(this.account);
    bw.writeU8(this.keyType);
    bw.writeU8(this.version);

    switch (this.keyType) {
      case Path.types.HD:
        assert(!this.data);
        assert(this.index !== -1);
        bw.writeU32(this.branch);
        bw.writeU32(this.index);
        break;
      case Path.types.KEY:
        assert(this.data);
        assert(this.index === -1);
        bw.writeU8(this.encrypted ? 1 : 0);
        bw.writeVarBytes(this.data);
        break;
      case Path.types.ADDRESS:
        assert(!this.data);
        assert(this.index === -1);
        break;
      default:
        assert(false);
        break;
    }

    return bw;
  }

  /**
   * Inject properties from address.
   * @private
   * @param {Account} account
   * @param {Address} address
   */

  fromAddress(account, address) {
    this.keyType = Path.types.ADDRESS;
    this.name = account.name;
    this.account = account.accountIndex;
    this.version = address.version;
    this.hash = address.getHash();
    return this;
  }

  /**
   * Instantiate path from address.
   * @param {Account} account
   * @param {Address} address
   * @returns {Path}
   */

  static fromAddress(account, address) {
    return new this().fromAddress(account, address);
  }

  /**
   * Convert path object to string derivation path.
   * @returns {String}
   */

  toPath() {
    if (this.keyType !== Path.types.HD)
      return null;

    return `m/${this.account}'/${this.branch}/${this.index}`;
  }

  /**
   * Convert path object to an address (currently unused).
   * @returns {Address}
   */

  toAddress() {
    return Address.fromHash(this.hash, this.version);
  }

  /**
   * Convert path to a json-friendly object.
   * @returns {Object}
   */

  getJSON() {
    return {
      name: this.name,
      account: this.account,
      change: this.branch === 1,
      derivation: this.toPath()
    };
  }

  /**
   * Inspect the path.
   * @returns {String}
   */

  format() {
    return `<Path: ${this.name}:${this.toPath()}>`;
  }
}

/**
 * Path types.
 * @enum {Number}
 * @default
 */

Path.types = {
  HD: 0,
  KEY: 1,
  ADDRESS: 2
};

/**
 * Path types.
 * @enum {Number}
 * @default
 */

Path.typesByVal = [
  'HD',
  'KEY',
  'ADDRESS'
];

/**
 * Expose
 */

module.exports = Path;
