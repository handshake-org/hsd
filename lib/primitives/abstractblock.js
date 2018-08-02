/*!
 * abstractblock.js - abstract block object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const blake2b = require('bcrypto/lib/blake2b');
const bio = require('bufio');
const {Solution} = require('bcuckoo');
const InvItem = require('./invitem');
const consensus = require('../protocol/consensus');
const util = require('../utils/util');

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

class AbstractBlock extends bio.Struct {
  /**
   * Create an abstract block.
   * @constructor
   */

  constructor() {
    super();

    this.version = 0;
    this.prevBlock = consensus.ZERO_HASH;
    this.merkleRoot = consensus.ZERO_HASH;
    this.treeRoot = consensus.ZERO_HASH;
    this.reservedRoot = consensus.ZERO_HASH;
    this.time = 0;
    this.bits = 0;
    this.nonce = consensus.ZERO_NONCE;
    this.solution = consensus.ZERO_SOL;

    this.mutable = false;

    this._hash = null;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  parseOptions(options) {
    assert(options, 'Block data is required.');
    assert((options.version >>> 0) === options.version);
    assert(Buffer.isBuffer(options.prevBlock));
    assert(Buffer.isBuffer(options.merkleRoot));
    assert(Buffer.isBuffer(options.treeRoot));
    assert(Buffer.isBuffer(options.reservedRoot));
    assert(util.isU64(options.time));
    assert((options.bits >>> 0) === options.bits);
    assert(Buffer.isBuffer(options.nonce)
      && options.nonce.length === consensus.NONCE_SIZE);

    this.version = options.version;
    this.prevBlock = options.prevBlock;
    this.merkleRoot = options.merkleRoot;
    this.treeRoot = options.treeRoot;
    this.reservedRoot = options.reservedRoot;
    this.time = options.time;
    this.bits = options.bits;
    this.nonce = options.nonce;

    if (options.solution != null)
      this.solution = Solution.fromOptions(options.solution);

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
    assert((json.time >>> 0) === json.time);
    assert((json.bits >>> 0) === json.bits);

    this.version = json.version;
    this.prevBlock = util.parseHex(json.prevBlock, 32);
    this.merkleRoot = util.parseHex(json.merkleRoot, 32);
    this.treeRoot = util.parseHex(json.treeRoot, 32);
    this.reservedRoot = util.parseHex(json.reservedRoot, 32);
    this.time = json.time;
    this.bits = json.bits;
    this.nonce = util.parseHex(json.nonce, 20);

    if (json.solution != null)
      this.solution = Solution.fromJSON(json.solution);

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
    return this;
  }

  /**
   * Clear any cached values.
   */

  refresh() {
    return this._refresh();
  }

  /**
   * Hash the block header.
   * @returns {Hash} hash
   */

  hash() {
    if (this.mutable)
      return blake2b.digest(this.toHead());

    if (!this._hash)
      this._hash = blake2b.digest(this.toHead());

    return this._hash;
  }

  /**
   * Hash the block header.
   * @returns {String}
   */

  hashHex() {
    return this.hash().toString('hex');
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
    bw.writeHash(this.treeRoot);
    bw.writeHash(this.reservedRoot);
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
    bw.writeHash(this.treeRoot);
    bw.writeHash(this.reservedRoot);
    bw.writeU64(this.time);
    bw.writeU32(this.bits);
    bw.writeBytes(this.nonce);
    this.solution.write(bw);
    return bw;
  }

  /**
   * Parse the block headers.
   * @param {BufferReader} br
   */

  readHead(br) {
    this.version = br.readU32();
    this.prevBlock = br.readHash();
    this.merkleRoot = br.readHash();
    this.treeRoot = br.readHash();
    this.reservedRoot = br.readHash();
    this.time = br.readU64();
    this.bits = br.readU32();
    this.nonce = br.readBytes(consensus.NONCE_SIZE);
    this.solution = Solution.read(br);
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
    return consensus.verifyPOW(this.solution.sha3(), this.bits);
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
   * Convert the block to an inv item.
   * @returns {InvItem}
   */

  toInv() {
    return new InvItem(InvItem.types.BLOCK, this.hash());
  }
}

/*
 * Expose
 */

module.exports = AbstractBlock;
