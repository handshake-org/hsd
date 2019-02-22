/*!
 * claimentry.js - claim entry object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bio = require('bufio');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const util = require('../utils/util');
const Address = require('../primitives/address');
const rules = require('../covenants/rules');

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/**
 * Claim Entry
 * Represents a claim entry.
 * @alias module:mempool.ClaimEntry
 */

class ClaimEntry extends bio.Struct {
  /**
   * Create a claim entry.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.blob = EMPTY;
    this.hash = consensus.ZERO_HASH;
    this.nameHash = consensus.ZERO_HASH;
    this.name = EMPTY;
    this.height = -1;
    this.size = 0;
    this.address = new Address();
    this.value = 0;
    this.fee = 0;
    this.rate = 0;
    this.time = 0;
    this.weak = false;
    this.commitHash = consensus.ZERO_HASH;
    this.commitHeight = 0;
    this.inception = 0;
    this.expiration = 0;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    this.blob = options.blob;
    this.hash = options.hash;
    this.nameHash = options.nameHash;
    this.name = options.name;
    this.height = options.height;
    this.size = options.size;
    this.address = options.address;
    this.value = options.value;
    this.fee = options.fee;
    this.rate = options.rate;
    this.time = options.time;
    this.weak = options.weak;
    this.commitHash = options.commitHash;
    this.commitHeight = options.commitHeight;
    this.inception = options.inception;
    this.expiration = options.expiration;
    return this;
  }

  /**
   * Inject properties from claim.
   * @private
   * @param {Claim} claim
   * @param {Object} data
   * @param {Number} height
   */

  fromClaim(claim, data, height) {
    const size = claim.getVirtualSize();
    const name = Buffer.from(data.name, 'binary');

    this.blob = claim.blob;
    this.hash = claim.hash();
    this.nameHash = rules.hashName(name);
    this.name = name;
    this.height = height;
    this.size = size;
    this.address = Address.fromHash(data.hash, data.version);
    this.value = data.value;
    this.fee = data.fee;
    this.rate = policy.getRate(size, this.fee);
    this.time = util.now();
    this.weak = data.weak;
    this.commitHash = data.commitHash;
    this.commitHeight = data.commitHeight;
    this.inception = data.inception;
    this.expiration = data.expiration;

    return this;
  }

  /**
   * Create a mempool entry from a claim.
   * @param {Claim} claim
   * @param {Object} data
   * @param {Number} height - Entry height.
   * @returns {ClaimEntry}
   */

  static fromClaim(claim, data, height) {
    return new this().fromClaim(claim, data, height);
  }

  /**
   * Get fee.
   * @returns {Amount}
   */

  getFee() {
    return this.fee;
  }

  /**
   * Calculate fee rate.
   * @returns {Rate}
   */

  getRate() {
    return this.rate;
  }

  /**
   * Calculate the memory usage of a claim.
   * @returns {Number} Usage in bytes.
   */

  memUsage() {
    let total = 0;

    total += 500;
    total += this.blob.length;

    return total;
  }

  /**
   * Get entry serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += bio.sizeVarBytes(this.blob);
    size += 64;
    size += 1 + this.name.length;
    size += 8;
    size += this.address.getSize();
    size += 32;
    size += 1 + 32 + 4;
    size += 4 + 4;
    return size;
  }

  /**
   * Serialize entry to a buffer.
   * @returns {Buffer}
   */

  write(bw) {
    bw.writeVarBytes(this.blob);
    bw.writeHash(this.hash);
    bw.writeHash(this.nameHash);
    bw.writeU8(this.name.length);
    bw.writeString(this.name);
    bw.writeU32(this.height);
    bw.writeU32(this.size);
    this.address.write(bw);
    bw.writeU64(this.value);
    bw.writeU64(this.fee);
    bw.writeU64(this.rate);
    bw.writeU64(this.time);
    bw.writeU8(this.weak ? 1 : 0);
    bw.writeHash(this.commitHash);
    bw.writeU32(this.commitHeight);
    bw.writeU32(this.inception);
    bw.writeU32(this.expiration);
    return bw;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {ClaimEntry}
   */

  read(br) {
    this.blob = br.readVarBytes();
    this.hash = br.readHash();
    this.nameHash = br.readHash();
    this.name = br.readString(br.readU8());
    this.height = br.readU32();
    this.size = br.readU32();
    this.address.read(br);
    this.value = br.readU64();
    this.fee = br.readU64();
    this.rate = br.readU64();
    this.time = br.readU64();
    this.weak = br.readU8() === 1;
    this.commitHash = br.readHash();
    this.commitHeight = br.readU32();
    this.inception = br.readU32();
    this.expiration = br.readU32();
    return this;
  }
}

/*
 * Expose
 */

module.exports = ClaimEntry;
