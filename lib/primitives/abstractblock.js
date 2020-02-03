/*!
 * abstractblock.js - abstract block object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const BLAKE2b = require('bcrypto/lib/blake2b');
const SHA3 = require('bcrypto/lib/sha3');
const bio = require('bufio');
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
    this.witnessRoot = consensus.ZERO_HASH;
    this.treeRoot = consensus.ZERO_HASH;
    this.reservedRoot = consensus.ZERO_HASH;
    this.time = 0;
    this.bits = 0;
    this.nonce = 0;
    this.extraNonce = consensus.ZERO_NONCE;
    this.mask = consensus.ZERO_HASH;

    this.mutable = false;

    this._hash = null;
    this._maskHash = null;
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
    assert(Buffer.isBuffer(options.witnessRoot));
    assert(Buffer.isBuffer(options.treeRoot));
    assert(Buffer.isBuffer(options.reservedRoot));
    assert(util.isU64(options.time));
    assert((options.bits >>> 0) === options.bits);
    assert((options.nonce >>> 0) === options.nonce);
    assert(Buffer.isBuffer(options.extraNonce)
      && options.extraNonce.length === consensus.NONCE_SIZE);
    assert(Buffer.isBuffer(options.mask));

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
    assert((json.nonce >>> 0) === json.nonce);

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
    this._maskHash = null;
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
      return this.powHash();

    if (!this._hash)
      this._hash = this.powHash();

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

  sizeHead() {
    return consensus.HEADER_SIZE;
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
   * Retrieve deterministically random padding.
   * @param {Number} size
   * @returns {Buffer}
   */

  padding(size) {
    assert((size >>> 0) === size);

    const pad = Buffer.alloc(size);

    for (let i = 0; i < size; i++)
      pad[i] = this.prevBlock[i % 32] ^ this.treeRoot[i % 32];

    return pad;
  }

  /**
   * Serialize subheader for proof.
   * @returns {Buffer}
   */

  toSubhead() {
    const bw = bio.write(128);

    // The subheader contains miner-mutable
    // and less essential data (that is,
    // less essential for SPV resolvers).
    bw.writeBytes(this.extraNonce);
    bw.writeHash(this.reservedRoot);
    bw.writeHash(this.witnessRoot);
    bw.writeHash(this.merkleRoot);
    bw.writeU32(this.version);
    bw.writeU32(this.bits);

    // Exactly one blake2b block (128 bytes).
    assert(bw.offset === BLAKE2b.blockSize);

    return bw.render();
  }

  /**
   * Compute subheader hash.
   * @returns {Buffer}
   */

  subHash() {
    return BLAKE2b.digest(this.toSubhead());
  }

  /**
   * Compute xor bytes hash.
   * @returns {Buffer}
   */

  maskHash() {
    if (this._maskHash != null)
      return this._maskHash;

    // Hash with previous block in case a pool wants
    // to re-use the same mask for the next block!
    return BLAKE2b.multi(this.prevBlock, this.mask);
  }

  /**
   * Compute commitment hash.
   * @returns {Buffer}
   */

  commitHash() {
    // Note for mining pools: do not send
    // the mask itself to individual miners.
    return BLAKE2b.multi(this.subHash(), this.maskHash());
  }

  /**
   * Serialize preheader.
   * @returns {Buffer}
   */

  toPrehead() {
    const bw = bio.write(128);

    // The preheader contains only the truly
    // essential data. This optimizes for
    // SPV resolvers, who may only need
    // access to the tree root as well as
    // the ability to validate the PoW.
    //
    // Note that we don't consider the
    // target commitment "essential" as
    // the pow can still be validated
    // contextually without it.
    //
    // Furthermore, the preheader does not
    // contain any miner malleable data
    // aside from the timestamp and nonce.
    //
    // Any malleable data is contained
    // within the commitment hash. Miners
    // are penalized for updating this
    // data, as it will cost them two
    // rounds of hashing.
    //
    // We could drop the padding here and
    // just use a 20 byte blake2 hash for
    // the xor bytes (which seems much
    // cleaner), but this is insecure due
    // to the following attack:
    // todo - explain attack.
    //
    // The position of the nonce and
    // timestamp intentionally provide
    // incentives to keep the timestamp
    // up-to-date.
    //
    // The first 8 bytes of this block
    // of data can be treated as a uint64
    // and incremented as such. If more
    // than a second has passed since
    // the last timestamp update, a miner
    // can simply let the nonce overflow
    // into the timestamp.
    bw.writeU32(this.nonce);
    bw.writeU64(this.time);
    bw.writeBytes(this.padding(20));
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.treeRoot);
    bw.writeHash(this.commitHash());

    // Exactly one blake2b block (128 bytes).
    assert(bw.offset === BLAKE2b.blockSize);

    return bw.render();
  }

  /**
   * Calculate share hash.
   * @returns {Buffer}
   */

  shareHash() {
    const data = this.toPrehead();

    // 128 bytes (output as BLAKE2b-512).
    const left = BLAKE2b.digest(data, 64);

    // 128 + 8 = 136 bytes.
    const right = SHA3.multi(data, this.padding(8));

    // 64 + 32 + 32 = 128 bytes.
    return BLAKE2b.multi(left, this.padding(32), right);
  }

  /**
   * Calculate PoW hash.
   * @returns {Buffer}
   */

  powHash() {
    const hash = this.shareHash();

    // XOR the PoW hash with arbitrary bytes.
    // This can optionally be used by mining
    // pools to mitigate block withholding
    // attacks. Idea from Kevin Pan:
    //
    // https://lists.linuxfoundation.org/pipermail/bitcoin-dev/2017-October/015163.html
    //
    // The goal here is to allow a pool to
    // deny individual miners the ability
    // to recognize whether they have found
    // a block, but still allow them to
    // recognize a share.
    //
    // Example:
    //
    //   Network target:
    //   00000000 00000000 10000000 ...
    //
    //   Share target:
    //   00000000 10000000 00000000 ...
    //
    //   Mask:
    //   00000000 01010101 10000000 ...
    //
    // The mask bytes are hidden from the
    // individual miner, but known to the
    // pool, and precommitted to in the
    // block header (i.e. hashed).
    //
    // Following our example further:
    //
    //   Miner share:
    //   00000000 01010101 00000000 ...
    //
    //   PoW hash (after XOR):
    //   00000000 00000000 10000000 ...
    //
    // At this point, the miner has found
    // a block, but this is unknown to
    // him or her as they do not have
    // access to the mask bytes directly.
    for (let i = 0; i < 32; i++)
      hash[i] ^= this.mask[i];

    return hash;
  }

  /**
   * Serialize the block headers.
   * @param {BufferWriter} bw
   */

  writeHead(bw) {
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

    return bw;
  }

  /**
   * Parse the block headers.
   * @param {BufferReader} br
   */

  readHead(br) {
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

    return this;
  }

  /**
   * Encode to miner serialization.
   * @returns {Buffer}
   */

  toMiner() {
    const bw = bio.write(128 + 128);

    // Preheader.
    bw.writeU32(this.nonce);
    bw.writeU64(this.time);
    bw.writeBytes(this.padding(20));
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.treeRoot);

    // Replace commitment hash with mask hash.
    bw.writeHash(this.maskHash());

    // Subheader.
    bw.writeBytes(this.extraNonce);
    bw.writeHash(this.reservedRoot);
    bw.writeHash(this.witnessRoot);
    bw.writeHash(this.merkleRoot);
    bw.writeU32(this.version);
    bw.writeU32(this.bits);

    return bw.render();
  }

  /**
   * Decode from miner serialization.
   * @param {Buffer} data
   */

  fromMiner(data) {
    const br = bio.read(data);

    // Preheader.
    this.nonce = br.readU32();
    this.time = br.readU64();

    const padding = br.readBytes(20);

    this.prevBlock = br.readHash();
    this.treeRoot = br.readHash();

    assert(padding.equals(this.padding(20)));

    // Note: mask _hash_.
    this._maskHash = br.readHash();

    // Subheader.
    this.extraNonce = br.readBytes(consensus.NONCE_SIZE);
    this.reservedRoot = br.readHash();
    this.witnessRoot = br.readHash();
    this.merkleRoot = br.readHash();
    this.version = br.readU32();
    this.bits = br.readU32();

    // Mask (unknown).
    this.mask = Buffer.alloc(32, 0x00);

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
    return consensus.verifyPOW(this.hash(), this.bits);
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

  /**
   * Decode from miner serialization.
   * @param {Buffer} data
   */

  static fromMiner(data) {
    return new this().fromMiner(data);
  }
}

/*
 * Expose
 */

module.exports = AbstractBlock;
