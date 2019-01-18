/*!
 * airdropentry.js - airdrop entry object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
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
 * Airdrop Entry
 * Represents a airdrop entry.
 * @alias module:mempool.AirdropEntry
 */

class AirdropEntry extends bio.Struct {
  /**
   * Create an airdrop entry.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.blob = EMPTY;
    this.hash = consensus.ZERO_HASH;
    this.position = 0;
    this.height = -1;
    this.size = 0;
    this.address = new Address();
    this.value = 0;
    this.fee = 0;
    this.rate = 0;
    this.time = 0;
    this.weak = false;

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
    this.position = options.position;
    this.height = options.height;
    this.size = options.size;
    this.address = options.address;
    this.value = options.value;
    this.fee = options.fee;
    this.rate = options.rate;
    this.time = options.time;
    this.weak = options.weak;
    return this;
  }

  /**
   * Inject properties from airdrop.
   * @private
   * @param {AirdropProof} proof
   * @param {Number} height
   */

  fromAirdrop(proof, height) {
    const size = proof.getVirtualSize();

    this.blob = proof.encode();
    this.hash = proof.hash();
    this.position = proof.position();
    this.height = height;
    this.size = size;
    this.address = Address.fromHash(proof.address, proof.version);
    this.value = proof.getValue();
    this.fee = proof.fee;
    this.rate = policy.getRate(size, this.fee);
    this.time = util.now();
    this.weak = proof.isWeak();

    return this;
  }

  /**
   * Create a mempool entry from an airdrop proof.
   * @param {AirdropProof} proof
   * @param {Object} data
   * @param {Number} height - Entry height.
   * @returns {AirdropEntry}
   */

  static fromAirdrop(proof, height) {
    return new this().fromAirdrop(proof, height);
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
   * Calculate the memory usage of an airdrop proof.
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
    size += 32;
    size += 4;
    size += 4;
    size += 4;
    size += this.address.getSize();
    size += 32;
    size += 1;
    return size;
  }

  /**
   * Serialize entry to a buffer.
   * @returns {Buffer}
   */

  write(bw) {
    bw.writeVarBytes(this.blob);
    bw.writeHash(this.hash);
    bw.writeU32(this.position);
    bw.writeU32(this.height);
    bw.writeU32(this.size);
    this.address.write(bw);
    bw.writeU64(this.value);
    bw.writeU64(this.fee);
    bw.writeU64(this.rate);
    bw.writeU64(this.time);
    bw.writeU8(this.weak ? 1 : 0);
    return bw;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {AirdropEntry}
   */

  read(br) {
    this.blob = br.readVarBytes();
    this.hash = br.readHash();
    this.position = br.readU32();
    this.height = br.readU32();
    this.size = br.readU32();
    this.address.read(br);
    this.value = br.readU64();
    this.fee = br.readU64();
    this.rate = br.readU64();
    this.time = br.readU64();
    this.weak = br.readU8() === 1;
    return this;
  }
}

/*
 * Expose
 */

module.exports = AirdropEntry;
