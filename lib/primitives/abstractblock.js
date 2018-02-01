/*!
 * abstractblock.js - abstract block object for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const blake2b = require('bcrypto/lib/blake2b');
const bio = require('bufio');
const util = require('../utils/util');
const InvItem = require('./invitem');
const consensus = require('../protocol/consensus');
const {Solution} = require('../protocol/cuckoo');

/**
 * Abstract Block
 * The class which all block-like objects inherit from.
 * @alias module:primitives.AbstractBlock
 * @abstract
 * @property {Number} version
 * @property {Hash} prevBlock
 * @property {Hash} merkleRoot
 * @property {Number} time
 * @property {Number} bits
 * @property {Number} nonce
 */

class AbstractBlock {
  /**
   * Create an abstract block.
   * @constructor
   */

  constructor() {
    this.version = 0;
    this.prevBlock = consensus.NULL_HASH;
    this.merkleRoot = consensus.NULL_HASH;
    this.witnessRoot = consensus.NULL_HASH;
    this.trieRoot = consensus.NULL_HASH;
    this.time = 0;
    this.bits = 0;
    this.nonce = consensus.ZERO_NONCE;
    this.solution = consensus.ZERO_SOL;

    this.mutable = false;

    this._hash = null;
    this._hhash = null;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  parseOptions(options) {
    assert(options, 'Block data is required.');
    assert((options.version >>> 0) === options.version);
    assert(typeof options.prevBlock === 'string');
    assert(typeof options.merkleRoot === 'string');
    assert(typeof options.witnessRoot === 'string');
    assert(typeof options.trieRoot === 'string');
    assert(Number.isSafeInteger(options.time) && options.time >= 0);
    assert((options.bits >>> 0) === options.bits);
    assert(Buffer.isBuffer(options.nonce) && options.nonce.length === 16);

    this.version = options.version;
    this.prevBlock = options.prevBlock;
    this.merkleRoot = options.merkleRoot;
    this.witnessRoot = options.witnessRoot;
    this.trieRoot = options.trieRoot;
    this.time = options.time;
    this.bits = options.bits;
    this.nonce = options.nonce;

    if (options.solution != null) {
      assert(typeof options.solution === 'object');
      this.solution = Solution.fromOptions(options.solution);
    }

    if (options.mutable != null) {
      assert(typeof options.mutable === 'boolean');
      this.mutable = options.mutable;
    }

    return this;
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  parseJSON(json) {
    assert(json, 'Block data is required.');
    assert((json.version >>> 0) === json.version);
    assert(typeof json.prevBlock === 'string');
    assert(typeof json.merkleRoot === 'string');
    assert(typeof json.witnessRoot === 'string');
    assert(typeof json.trieRoot === 'string');
    assert((json.time >>> 0) === json.time);
    assert((json.bits >>> 0) === json.bits);
    assert(typeof json.nonce === 'string' && json.nonce.length === 32);
    assert(!json.solution || typeof json.solution === 'object');

    this.version = json.version;
    this.prevBlock = util.revHex(json.prevBlock);
    this.merkleRoot = util.revHex(json.merkleRoot);
    this.time = json.time;
    this.bits = json.bits;
    this.nonce = Buffer.from(json.nonce, 'hex');

    assert(this.nonce.length === 16);

    if (json.solution != null) {
      assert(typeof json.solution === 'object');
      this.solution = Solution.fromJSON(json.solution);
    }

    return this;
  }

  /**
   * Test whether the block is a memblock.
   * @returns {Boolean}
   */

  isMemory() {
    return false;
  }

  /**
   * Clear any cached values (abstract).
   */

  _refresh() {
    this._hash = null;
    this._hhash = null;
  }

  /**
   * Clear any cached values.
   */

  refresh() {
    return this._refresh();
  }

  /**
   * Hash the block headers.
   * @param {String?} enc - Can be `'hex'` or `null`.
   * @returns {Hash|Buffer} hash
   */

  hash(enc) {
    let h = this._hash;

    if (!h) {
      h = blake2b.digest(this.toHead());
      if (!this.mutable)
        this._hash = h;
    }

    if (enc === 'hex') {
      let hex = this._hhash;
      if (!hex) {
        hex = h.toString('hex');
        if (!this.mutable)
          this._hhash = hex;
      }
      h = hex;
    }

    return h;
  }

  /**
   * Get header size.
   * @returns {Number}
   */

  sizePrehead() {
    return consensus.HEADER_SIZE;
  }

  /**
   * Get header size.
   * @returns {Number}
   */

  sizeHead() {
    return consensus.HEADER_SIZE + this.solution.getSize();
  }

  /**
   * Serialize the block headers.
   * @returns {Buffer}
   */

  toHead() {
    const size = this.sizeHead();
    return this.writeHead(bio.write(size)).render();
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromHead(data) {
    return this.readHead(bio.read(data));
  }

  /**
   * Serialize the header for proof.
   * @returns {Buffer}
   */

  toPrehead() {
    const bw = bio.write(this.sizePrehead());
    bw.writeU32(this.version);
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.merkleRoot);
    bw.writeHash(this.witnessRoot);
    bw.writeHash(this.trieRoot);
    bw.writeU64(this.time);
    bw.writeU32(this.bits);
    bw.writeBytes(this.nonce);
    return bw.render();
  }

  /**
   * Serialize the block headers.
   * @param {BufferWriter} bw
   */

  writeHead(bw) {
    bw.writeU32(this.version);
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.merkleRoot);
    bw.writeHash(this.witnessRoot);
    bw.writeHash(this.trieRoot);
    bw.writeU64(this.time);
    bw.writeU32(this.bits);
    bw.writeBytes(this.nonce);
    this.solution.toWriter(bw);
    return bw;
  }

  /**
   * Parse the block headers.
   * @param {BufferReader} br
   */

  readHead(br) {
    this.version = br.readU32();
    this.prevBlock = br.readHash('hex');
    this.merkleRoot = br.readHash('hex');
    this.witnessRoot = br.readHash('hex');
    this.trieRoot = br.readHash('hex');
    this.time = br.readU64();
    this.bits = br.readU32();
    this.nonce = br.readBytes(16);
    this.solution = Solution.fromReader(br);
    return this;
  }

  /**
   * Verify the block.
   * @returns {Boolean}
   */

  verify() {
    if (!this.verifyPOW())
      return false;

    if (!this.verifyBody())
      return false;

    return true;
  }

  /**
   * Verify proof-of-work.
   * @returns {Boolean}
   */

  verifyPOW() {
    return consensus.verifyPOW(this.solution.hash(), this.bits);
  }

  /**
   * Verify cuckoo cycle solution.
   * @returns {Boolean}
   */

  verifySolution(network) {
    const hdr = this.toPrehead();
    const sol = this.solution;
    const params = network.cuckoo;
    return consensus.verifySolution(hdr, sol, params);
  }

  /**
   * Verify the block.
   * @returns {Boolean}
   */

  verifyBody() {
    throw new Error('Abstract method.');
  }

  /**
   * Get little-endian block hash.
   * @returns {Hash}
   */

  rhash() {
    return util.revHex(this.hash('hex'));
  }

  /**
   * Convert the block to an inv item.
   * @returns {InvItem}
   */

  toInv() {
    return new InvItem(InvItem.types.BLOCK, this.hash('hex'));
  }
}

/*
 * Expose
 */

module.exports = AbstractBlock;
