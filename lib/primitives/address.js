/*!
 * address.js - address object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const {bech32} = require('bstring');
const sha256 = require('bcrypto/lib/sha256');
const hash160 = require('bcrypto/lib/hash160');
const Network = require('../protocol/network');
const consensus = require('../protocol/consensus');

/*
 * Constants
 */

const ZERO_HASH160 = Buffer.alloc(20, 0x00);

/**
 * Address
 * Represents an address.
 * @alias module:primitives.Address
 * @property {Number} version
 * @property {Buffer} hash
 */

class Address {
  /**
   * Create an address.
   * @constructor
   * @param {Object?} options
   */

  constructor(options, network) {
    this.version = 0;
    this.hash = ZERO_HASH160;

    if (options)
      this.fromOptions(options, network);
  }

  getSize() {
    return 1 + 1 + this.hash.length;
  }

  toWriter(bw) {
    bw.writeU8(this.version);
    bw.writeU8(this.hash.length);
    bw.writeBytes(this.hash);
    return bw;
  }

  toRaw() {
    const size = this.getSize();
    const bw = bio.write(size);
    return this.toWriter(bw).render();
  }

  fromReader(br) {
    const version = br.readU8();
    const hash = br.readBytes(br.readU8());
    return this.fromHash(hash, version);
  }

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  static fromReader(data) {
    return new this().fromReader(data);
  }

  static fromRaw(data) {
    return new this().fromRaw(data);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options, network) {
    if (typeof options === 'string')
      return this.fromString(options, network);

    assert(options);

    const {hash, version} = options;

    return this.fromHash(hash, version);
  }

  /**
   * Insantiate address from options.
   * @param {Object} options
   * @returns {Address}
   */

  static fromOptions(options, network) {
    return new this().fromOptions(options, network);
  }

  /**
   * Count the sigops in a script, taking into account witness programs.
   * @param {Witness} witness
   * @returns {Number} sigop count
   */

  getSigops(witness) {
    if (this.version === 0) {
      if (this.hash.length === 20)
        return 1;

      if (this.hash.length === 32 && witness.items.length > 0) {
        const redeem = witness.getRedeem();
        return redeem.getSigops();
      }
    }

    return 0;
  }

  isUnspendable() {
    return false;
  }

  /**
   * Get the address hash.
   * @param {String?} enc - Can be `"hex"` or `null`.
   * @returns {Hash|Buffer}
   */

  getHash(enc) {
    if (enc === 'hex')
      return this.hash.toString(enc);
    return this.hash;
  }

  /**
   * Test whether the address is null.
   * @returns {Boolean}
   */

  isNull() {
    if (this.hash.length === 20)
      return this.hash.equals(ZERO_HASH160);

    if (this.hash.length === 32)
      return this.hash.equals(consensus.ZERO_HASH);

    for (let i = 0; i < this.hash.length; i++) {
      if (this.hash[i] !== 0)
        return false;
    }

    return true;
  }

  /**
   * Test equality against another address.
   * @param {Address} addr
   * @returns {Boolean}
   */

  equals(addr) {
    assert(addr instanceof Address);

    return this.version === addr.version
      && this.hash.equals(addr.hash);
  }

  /**
   * Compare against another address.
   * @param {Address} addr
   * @returns {Boolean}
   */

  compare(addr) {
    assert(addr instanceof Address);

    const cmp = this.version - addr.version;

    if (cmp !== 0)
      return cmp;

    return this.hash.compare(addr.hash);
  }

  /**
   * Inject properties from another address.
   * @param {Address} addr
   * @returns {Boolean}
   */

  inject(addr) {
    this.version = addr.version;
    this.hash = addr.hash;
    return this;
  }

  /**
   * Clone address.
   * @returns {Address}
   */

  clone() {
    return new this.constructor().inject(this);
  }

  /**
   * Compile the address object to a bech32 address.
   * @param {{NetworkType|Network)?} network
   * @returns {String}
   * @throws Error on bad hash/prefix.
   */

  toString(network) {
    const version = this.version;
    const hash = this.hash;

    assert(version !== -1,
      'Cannot convert non-program address to bech32.');

    network = Network.get(network);

    const hrp = network.addressPrefix.bech32;

    return bech32.encode(hrp, version, hash);
  }

  /**
   * Inspect the Address.
   * @returns {Object}
   */

  inspect() {
    return '<Address:'
      + ` version=${this.version}`
      + ` str=${this.toString()}`
      + '>';
  }

  /**
   * Inject properties from bech32 address.
   * @private
   * @param {String} data
   * @param {Network?} network
   * @throws Parse error
   */

  fromString(data, network) {
    assert(typeof data === 'string');

    const addr = bech32.decode(data);

    Network.fromBech32(addr.hrp, network);

    return this.fromHash(addr.hash, addr.version);
  }

  /**
   * Create an address object from a bech32 address.
   * @param {String} data
   * @param {Network?} network
   * @returns {Address}
   * @throws Parse error.
   */

  static fromString(data, network) {
    return new this().fromString(data, network);
  }

  /**
   * Inject properties from witness.
   * @private
   * @param {Witness} witness
   */

  fromWitness(witness) {
    const [, pk] = witness.getPubkeyhashInput();

    // We're pretty much screwed here
    // since we can't get the version.
    if (pk) {
      this.hash = hash160.digest(pk);
      this.version = 0;
      return this;
    }

    const redeem = witness.getScripthashInput();

    if (redeem) {
      this.hash = sha256.digest(redeem);
      this.version = 0;
      return this;
    }

    return null;
  }

  /**
   * Create an Address from a witness.
   * Attempt to extract address
   * properties from a witness.
   * @param {Witness}
   * @returns {Address|null}
   */

  static fromWitness(witness) {
    return new this().fromWitness(witness);
  }

  /**
   * Inject properties from a hash.
   * @private
   * @param {Buffer|Hash} hash
   * @param {Number} [version=-1]
   * @throws on bad hash size
   */

  fromHash(hash, version) {
    if (typeof hash === 'string')
      hash = Buffer.from(hash, 'hex');

    if (version == null)
      version = 0;

    assert(Buffer.isBuffer(hash));
    assert((version & 0xff) === version);

    assert(version >= 0 && version <= 16, 'Bad program version.');
    assert(hash.length >= 2 && hash.length <= 40, 'Hash is the wrong size.');

    if (version === 0) {
      assert(hash.length === 20 || hash.length === 32,
        'Witness program hash is the wrong size.');
    }

    this.hash = hash;
    this.version = version;

    return this;
  }

  /**
   * Create a naked address from hash/version.
   * @param {Hash} hash
   * @param {Number} [version=-1]
   * @returns {Address}
   * @throws on bad hash size
   */

  static fromHash(hash, version) {
    return new this().fromHash(hash, version);
  }

  /**
   * Inject properties from witness pubkeyhash.
   * @private
   * @param {Buffer} hash
   * @returns {Address}
   */

  fromPubkeyhash(hash) {
    assert(hash && hash.length === 20, 'P2WPKH must be 20 bytes.');
    return this.fromHash(hash, 0);
  }

  /**
   * Instantiate address from witness pubkeyhash.
   * @param {Buffer} hash
   * @returns {Address}
   */

  static fromPubkeyhash(hash) {
    return new this().fromPubkeyhash(hash);
  }

  /**
   * Inject properties from witness scripthash.
   * @private
   * @param {Buffer} hash
   * @returns {Address}
   */

  fromScripthash(hash) {
    assert(hash && hash.length === 32, 'P2WPKH must be 32 bytes.');
    return this.fromHash(hash, 0);
  }

  /**
   * Instantiate address from witness scripthash.
   * @param {Buffer} hash
   * @returns {Address}
   */

  static fromScripthash(hash) {
    return new this().fromScripthash(hash);
  }

  /**
   * Inject properties from witness program.
   * @private
   * @param {Number} version
   * @param {Buffer} hash
   * @returns {Address}
   */

  fromProgram(version, hash) {
    assert(version >= 0, 'Bad version for witness program.');

    if (typeof hash === 'string')
      hash = Buffer.from(hash, 'hex');

    return this.fromHash(hash, version);
  }

  /**
   * Instantiate address from witness program.
   * @param {Number} version
   * @param {Buffer} hash
   * @returns {Address}
   */

  static fromProgram(version, hash) {
    return new this().fromProgram(version, hash);
  }

  /**
   * Test whether the address is witness pubkeyhash.
   * @returns {Boolean}
   */

  isPubkeyhash() {
    return this.version === 0 && this.hash.length === 20;
  }

  /**
   * Test whether the address is witness scripthash.
   * @returns {Boolean}
   */

  isScripthash() {
    return this.version === 0 && this.hash.length === 32;
  }

  /**
   * Test whether the address is an unknown witness program.
   * @returns {Boolean}
   */

  isUnknown() {
    if (this.version > 0)
      return true;

    return this.hash.length !== 20 && this.hash.length !== 32;
  }

  /**
   * Get the hash of a base58 address or address-related object.
   * @param {String|Address|Hash} data
   * @param {String?} enc
   * @param {Network?} network
   * @returns {Hash}
   */

  static getHash(data, enc, network) {
    if (!data)
      throw new Error('Object is not an address.');

    let hash;

    if (typeof data === 'string') {
      if (data.length === 40 || data.length === 64)
        return enc === 'hex' ? data : Buffer.from(data, 'hex');

      hash = Address.fromString(data, network).hash;
    } else if (Buffer.isBuffer(data)) {
      if (data.length !== 20 && data.length !== 32)
        throw new Error('Object is not an address.');
      hash = data;
    } else if (data instanceof Address) {
      hash = data.hash;
    } else {
      throw new Error('Object is not an address.');
    }

    return enc === 'hex'
      ? hash.toString('hex')
      : hash;
  }
}

/*
 * Expose
 */

module.exports = Address;
