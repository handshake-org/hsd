/*!
 * path.js - path object for wallets
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const Address = require('../primitives/address');
const Network = require('../protocol/network');
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
   * @param {String|Network?} network - Network type.
   * @returns {String}
   */

  toPath(network) {
    if (this.keyType !== Path.types.HD)
      return null;

    let prefix = 'm';

    if (network) {
      const purpose = 44;
      network = Network.get(network);
      prefix += `/${purpose}'/${network.keyPrefix.coinType}'`;
    }

    return `${prefix}/${this.account}'/${this.branch}/${this.index}`;
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
   * @param {String|Network?} network - Network type.
   * @returns {Object}
   */

  getJSON(network) {
    return {
      name: this.name,
      account: this.account,
      change: this.branch === 1,
      derivation: this.toPath(network)
    };
  }

  /**
   * Inject properties from a json object.
   * @param {Object} json
   * @returns {Path}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Inject properties from a json object.
   * @param {Object} json
   * @returns {Path}
   */

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert(json.derivation && typeof json.derivation === 'string');

    // Note: this object is mutated below.
    const path = json.derivation.split('/');

    // Note: "m/X'/X'/X'/X/X" or "m/X'/X/X".
    assert (path.length === 4 || path.length === 6);

    const index = parseInt(path.pop(), 10);
    const branch = parseInt(path.pop(), 10);
    const account = parseInt(path.pop(), 10);

    assert(account === json.account);
    assert(branch === 0 || branch === 1);
    assert(Boolean(branch) === json.change);
    assert((index >>> 0) === index);

    this.name = json.name;
    this.account = account;
    this.branch = branch;
    this.index = index;

    return this;
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
