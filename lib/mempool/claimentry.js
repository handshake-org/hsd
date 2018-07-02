/*!
 * claimentry.js - claim entry object for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const bio = require('bufio');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const util = require('../utils/util');
const Address = require('../primitives/address');

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/**
 * Claim Entry
 * Represents a claim entry.
 * @alias module:mempool.ClaimEntry
 * @property {TX} tx
 * @property {Number} height
 * @property {Number} priority
 * @property {Number} time
 * @property {Amount} value
 */

class ClaimEntry {
  /**
   * Create a claim entry.
   * @constructor
   * @param {Object} options
   * @param {TX} options.tx - Transaction in mempool.
   * @param {Number} options.height - Entry height.
   * @param {Number} options.priority - Entry priority.
   * @param {Number} options.time - Entry time.
   * @param {Amount} options.value - Value of on-chain coins.
   */

  constructor(options) {
    this.blob = EMPTY;
    this.hash = consensus.NULL_HASH;
    this.nameHash = consensus.NULL_HASH;
    this.name = '';
    this.height = -1;
    this.size = 0;
    this.address = new Address();
    this.value = 0;
    this.fee = 0;
    this.rate = 0;
    this.time = 0;

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
    return this;
  }

  /**
   * Instantiate mempool entry from options.
   * @param {Object} options
   * @returns {MempoolEntry}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
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

    this.blob = claim.blob;
    this.hash = claim.hash('hex');
    this.nameHash = data.nameHash.toString('hex');
    this.name = data.name;
    this.height = height;
    this.size = size;
    this.address = Address.fromHash(data.hash, data.version);
    this.value = data.value;
    this.fee = data.fee;
    this.rate = policy.getRate(size, this.fee);
    this.time = util.now();

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

    total += 300;
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
    bw.writeString(this.name, 'ascii');
    bw.writeU32(this.height);
    bw.writeU32(this.size);
    this.address.write(bw);
    bw.writeU64(this.value);
    bw.writeU64(this.fee);
    bw.writeU64(this.rate);
    bw.writeU64(this.time);
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
    this.hash = br.readHash('hex');
    this.nameHash = br.readHash('hex');
    this.name = br.readString('ascii', br.readU8());
    this.height = br.readU32();
    this.size = br.readU32();
    this.address.read(br);
    this.value = br.readU64();
    this.fee = br.readU64();
    this.rate = br.readU64();
    this.time = br.readU64();
    return this;
  }

  /**
   * Instantiate entry from serialized data.
   * @param {Buffer} data
   * @returns {ClaimEntry}
   */

  static fromRaw(data) {
    return new this().fromRaw(data);
  }
}

/*
 * Expose
 */

module.exports = ClaimEntry;
