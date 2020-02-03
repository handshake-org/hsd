/*!
 * chainentry.js - chainentry object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const BN = require('bcrypto/lib/bn.js');
const consensus = require('../protocol/consensus');
const Headers = require('../primitives/headers');
const InvItem = require('../primitives/invitem');
const util = require('../utils/util');

/*
 * Constants
 */

const ZERO = new BN(0);

/**
 * Chain Entry
 * Represents an entry in the chain.
 * @alias module:blockchain.ChainEntry
 * @property {Hash} hash
 * @property {Number} version
 * @property {Hash} prevBlock
 * @property {Hash} merkleRoot
 * @property {Hash} witnessRoot
 * @property {Hash} treeRoot
 * @property {Hash} reservedRoot
 * @property {Number} time
 * @property {Number} bits
 * @property {Buffer} nonce
 * @property {Number} height
 * @property {BN} chainwork
 */

class ChainEntry extends bio.Struct {
  /**
   * Create a chain entry.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.hash = consensus.ZERO_HASH;
    this.version = 0;
    this.prevBlock = consensus.ZERO_HASH;
    this.merkleRoot = consensus.ZERO_HASH;
    this.witnessRoot = consensus.ZERO_HASH;
    this.treeRoot = consensus.ZERO_HASH;
    this.reservedRoot = consensus.ZERO_HASH;
    this.time = 0;
    this.bits = 0;
    this.nonce = 0;
    this.extraNonce = consensus.ZERO_NONCE;
    this.mask = consensus.ZERO_HASH;
    this.height = 0;
    this.chainwork = ZERO;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Block data is required.');
    assert(Buffer.isBuffer(options.hash));
    assert((options.version >>> 0) === options.version);
    assert(Buffer.isBuffer(options.prevBlock));
    assert(Buffer.isBuffer(options.merkleRoot));
    assert(Buffer.isBuffer(options.witnessRoot));
    assert(Buffer.isBuffer(options.treeRoot));
    assert(Buffer.isBuffer(options.reservedRoot));
    assert(util.isU64(options.time));
    assert((options.bits >>> 0) === options.bits);
    assert((options.nonce >>> 0) === options.nonce);
    assert(Buffer.isBuffer(options.extraNonce));
    assert(Buffer.isBuffer(options.mask));
    assert((options.height >>> 0) === options.height);
    assert(!options.chainwork || BN.isBN(options.chainwork));

    this.hash = options.hash;
    this.version = options.version;
    this.prevBlock = options.prevBlock;
    this.merkleRoot = options.merkleRoot;
    this.witnessRoot = options.witnessRoot;
    this.treeRoot = options.treeRoot;
    this.reservedRoot = options.reservedRoot;
    this.time = options.time;
    this.bits = options.bits;
    this.nonce = options.nonce;
    this.extraNonce = options.extraNonce;
    this.mask = options.mask;

    this.height = options.height;
    this.chainwork = options.chainwork || ZERO;

    return this;
  }

  /**
   * Calculate the proof: (1 << 256) / (target + 1)
   * @returns {BN} proof
   */

  getProof() {
    const target = consensus.fromCompact(this.bits);

    if (target.isNeg() || target.isZero())
      return new BN(0);

    return ChainEntry.MAX_CHAINWORK.div(target.iaddn(1));
  }

  /**
   * Calculate the chainwork by
   * adding proof to previous chainwork.
   * @returns {BN} chainwork
   */

  getChainwork(prev) {
    const proof = this.getProof();

    if (!prev)
      return proof;

    return proof.iadd(prev.chainwork);
  }

  /**
   * Test against the genesis block.
   * @returns {Boolean}
   */

  isGenesis() {
    return this.height === 0;
  }

  /**
   * Test whether the entry contains an unknown version bit.
   * @param {Network} network
   * @returns {Boolean}
   */

  hasUnknown(network) {
    return (this.version & network.unknownBits) !== 0;
  }

  /**
   * Test whether the entry contains a version bit.
   * @param {Number} bit
   * @returns {Boolean}
   */

  hasBit(bit) {
    return consensus.hasBit(this.version, bit);
  }

  /**
   * Inject properties from block.
   * @private
   * @param {Block|MerkleBlock} block
   * @param {ChainEntry} prev - Previous entry.
   */

  fromBlock(block, prev) {
    this.hash = block.hash();
    this.version = block.version;
    this.prevBlock = block.prevBlock;
    this.merkleRoot = block.merkleRoot;
    this.witnessRoot = block.witnessRoot;
    this.treeRoot = block.treeRoot;
    this.reservedRoot = block.reservedRoot;
    this.time = block.time;
    this.bits = block.bits;
    this.nonce = block.nonce;
    this.extraNonce = block.extraNonce;
    this.mask = block.mask;
    this.height = prev ? prev.height + 1 : 0;
    this.chainwork = this.getChainwork(prev);
    return this;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 36 + consensus.HEADER_SIZE + 32;
  }

  /**
   * Serialize the entry to internal database format.
   * @returns {Buffer}
   */

  write(bw) {
    bw.writeHash(this.hash);
    bw.writeU32(this.height);

    // Preheader.
    bw.writeU32(this.nonce);
    bw.writeU64(this.time);
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.treeRoot);

    // Subheader.
    bw.writeBytes(this.extraNonce);
    bw.writeHash(this.reservedRoot);
    bw.writeHash(this.witnessRoot);
    bw.writeHash(this.merkleRoot);
    bw.writeU32(this.version);
    bw.writeU32(this.bits);

    // Mask.
    bw.writeBytes(this.mask);

    bw.writeBytes(this.chainwork.toArrayLike(Buffer, 'be', 32));

    return bw;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  read(br) {
    this.hash = br.readHash();
    this.height = br.readU32();

    // Preheader.
    this.nonce = br.readU32();
    this.time = br.readU64();
    this.prevBlock = br.readHash();
    this.treeRoot = br.readHash();

    // Subheader.
    this.extraNonce = br.readBytes(consensus.NONCE_SIZE);
    this.reservedRoot = br.readHash();
    this.witnessRoot = br.readHash();
    this.merkleRoot = br.readHash();
    this.version = br.readU32();
    this.bits = br.readU32();

    // Mask.
    this.mask = br.readBytes(32);

    this.chainwork = new BN(br.readBytes(32), 'be');

    return this;
  }

  /**
   * Serialize the entry to an object more
   * suitable for JSON serialization.
   * @returns {Object}
   */

  getJSON() {
    return {
      hash: this.hash.toString('hex'),
      height: this.height,
      version: this.version,
      prevBlock: this.prevBlock.toString('hex'),
      merkleRoot: this.merkleRoot.toString('hex'),
      witnessRoot: this.witnessRoot.toString('hex'),
      treeRoot: this.treeRoot.toString('hex'),
      reservedRoot: this.reservedRoot.toString('hex'),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce,
      extraNonce: this.extraNonce.toString('hex'),
      mask: this.mask.toString('hex'),
      chainwork: this.chainwork.toString('hex', 64)
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'Block data is required.');
    assert((json.height >>> 0) === json.height);
    assert((json.version >>> 0) === json.version);
    assert(util.isU64(json.time));
    assert((json.bits >>> 0) === json.bits);
    assert((json.nonce >>> 0) === json.nonce);

    const work = util.parseHex(json.chainwork, 32);

    this.hash = json.hash;
    this.height = json.height;
    this.version = json.version;
    this.prevBlock = util.parseHex(json.prevBlock, 32);
    this.merkleRoot = util.parseHex(json.merkleRoot, 32);
    this.witnessRoot = util.parseHex(json.witnessRoot, 32);
    this.treeRoot = util.parseHex(json.treeRoot, 32);
    this.reservedRoot = util.parseHex(json.reservedRoot, 32);
    this.time = json.time;
    this.bits = json.bits;
    this.nonce = json.nonce;
    this.extraNonce = util.parseHex(json.extraNonce, consensus.NONCE_SIZE);
    this.mask = util.parseHex(json.mask, 32);
    this.chainwork = new BN(work, 'be');

    return this;
  }

  /**
   * Convert the entry to a headers object.
   * @returns {Headers}
   */

  toHeaders() {
    return Headers.fromEntry(this);
  }

  /**
   * Convert the entry to an inv item.
   * @returns {InvItem}
   */

  toInv() {
    return new InvItem(InvItem.types.BLOCK, this.hash);
  }

  /**
   * Return a more user-friendly object.
   * @returns {Object}
   */

  format() {
    const json = this.toJSON();
    json.version = json.version.toString(16);
    return json;
  }

  /**
   * Instantiate chainentry from block.
   * @param {Block|MerkleBlock} block
   * @param {ChainEntry} prev - Previous entry.
   * @returns {ChainEntry}
   */

  static fromBlock(block, prev) {
    return new this().fromBlock(block, prev);
  }

  /**
   * Test whether an object is a {@link ChainEntry}.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isChainEntry(obj) {
    return obj instanceof ChainEntry;
  }
}

/**
 * The max chainwork (1 << 256).
 * @const {BN}
 */

ChainEntry.MAX_CHAINWORK = new BN(1).ushln(256);

/*
 * Expose
 */

module.exports = ChainEntry;
