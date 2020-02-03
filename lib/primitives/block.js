/*!
 * block.js - block object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {BufferSet} = require('buffer-map');
const blake2b = require('bcrypto/lib/blake2b');
const merkle = require('bcrypto/lib/mrkl');
const consensus = require('../protocol/consensus');
const AbstractBlock = require('./abstractblock');
const TX = require('./tx');
const MerkleBlock = require('./merkleblock');
const Headers = require('./headers');
const Network = require('../protocol/network');
const util = require('../utils/util');
const {encoding} = bio;

/**
 * Block
 * Represents a full block.
 * @alias module:primitives.Block
 * @extends AbstractBlock
 */

class Block extends AbstractBlock {
  /**
   * Create a block.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.txs = [];

    this._raw = null;
    this._sizes = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    this.parseOptions(options);

    if (options.txs) {
      assert(Array.isArray(options.txs));
      for (const tx of options.txs) {
        assert(tx instanceof TX);
        this.txs.push(tx);
      }
    }

    return this;
  }

  /**
   * Clear any cached values.
   * @param {Boolean?} all - Clear transactions.
   */

  refresh(all) {
    this._refresh();

    this._raw = null;
    this._sizes = null;

    if (!all)
      return this;

    for (const tx of this.txs)
      tx.refresh();

    return this;
  }

  /**
   * Calculate virtual block size.
   * @returns {Number} Virtual size.
   */

  getVirtualSize() {
    const scale = consensus.WITNESS_SCALE_FACTOR;
    return (this.getWeight() + scale - 1) / scale | 0;
  }

  /**
   * Calculate block weight.
   * @returns {Number} weight
   */

  getWeight() {
    const {base, witness} = this.getSizes();
    const total = base + witness;
    return base * (consensus.WITNESS_SCALE_FACTOR - 1) + total;
  }

  /**
   * Get real block size.
   * @returns {Number} size
   */

  getSize() {
    const {base, witness} = this.getSizes();
    return base + witness;
  }

  /**
   * Get base block size (without witness).
   * @returns {Number} size
   */

  getBaseSize() {
    const {base} = this.getSizes();
    return base;
  }

  /**
   * Test whether the block contains a
   * transaction with a non-empty witness.
   * @returns {Boolean}
   */

  hasWitness() {
    for (const tx of this.txs) {
      if (tx.hasWitness())
        return true;
    }

    return false;
  }

  /**
   * Test the block's transaction vector against a hash.
   * @param {Hash} hash
   * @returns {Boolean}
   */

  hasTX(hash) {
    return this.indexOf(hash) !== -1;
  }

  /**
   * Find the index of a transaction in the block.
   * @param {Hash} hash
   * @returns {Number} index (-1 if not present).
   */

  indexOf(hash) {
    for (let i = 0; i < this.txs.length; i++) {
      const tx = this.txs[i];
      if (tx.hash().equals(hash))
        return i;
    }

    return -1;
  }

  /**
   * Calculate merkle root.
   * @returns {Hash}
   */

  createMerkleRoot() {
    const leaves = [];

    for (const tx of this.txs)
      leaves.push(tx.hash());

    return merkle.createRoot(blake2b, leaves);
  }

  /**
   * Calculate witness root.
   * @returns {Hash}
   */

  createWitnessRoot() {
    const leaves = [];

    for (const tx of this.txs)
      leaves.push(tx.witnessHash());

    return merkle.createRoot(blake2b, leaves);
  }

  /**
   * Retrieve the merkle root from the block header.
   * @returns {Hash}
   */

  getMerkleRoot() {
    return this.merkleRoot;
  }

  /**
   * Do non-contextual verification on the block. Including checking the block
   * size, the coinbase and the merkle root. This is consensus-critical.
   * @returns {Boolean}
   */

  verifyBody() {
    const [valid] = this.checkBody();
    return valid;
  }

  /**
   * Do non-contextual verification on the block. Including checking the block
   * size, the coinbase and the merkle root. This is consensus-critical.
   * @returns {Array} [valid, reason, score]
   */

  checkBody() {
    // Check base size.
    if (this.txs.length === 0
        || this.txs.length > consensus.MAX_BLOCK_SIZE
        || this.getBaseSize() > consensus.MAX_BLOCK_SIZE) {
      return [false, 'bad-blk-length', 100];
    }

    // Check block weight.
    if (this.getWeight() > consensus.MAX_BLOCK_WEIGHT)
      return [false, 'bad-blk-weight', 100];

    // Check merkle root.
    const merkleRoot = this.createMerkleRoot();

    if (merkleRoot.equals(consensus.ZERO_HASH))
      return [false, 'bad-txnmrklroot', 100];

    if (!merkleRoot.equals(this.merkleRoot))
      return [false, 'bad-txnmrklroot', 100];

    // Check witness root.
    const witnessRoot = this.createWitnessRoot();

    if (!witnessRoot.equals(this.witnessRoot))
      return [false, 'bad-txnmrklroot', 100];

    // First TX must be a coinbase.
    if (this.txs.length === 0 || !this.txs[0].isCoinbase())
      return [false, 'bad-cb-missing', 100];

    // Test all transactions.
    for (let i = 0; i < this.txs.length; i++) {
      const tx = this.txs[i];

      // The rest of the txs must not be coinbases.
      if (i > 0 && tx.isCoinbase())
        return [false, 'bad-cb-multiple', 100];

      // Sanity checks.
      const [valid, reason, score] = tx.checkSanity();

      if (!valid)
        return [valid, reason, score];
    }

    return [true, 'valid', 0];
  }

  /**
   * Retrieve the coinbase height from the coinbase input script.
   * @returns {Number} height (-1 if not present).
   */

  getCoinbaseHeight() {
    if (this.txs.length === 0)
      return -1;

    const cb = this.txs[0];
    return cb.locktime;
  }

  /**
   * Get the "claimed" reward by the coinbase.
   * @returns {Amount} claimed
   */

  getClaimed() {
    assert(this.txs.length > 0);
    assert(this.txs[0].isCoinbase());
    return this.txs[0].getOutputValue();
  }

  /**
   * Get all unique outpoint hashes in the
   * block. Coinbases are ignored.
   * @returns {Hash[]} Outpoint hashes.
   */

  getPrevout() {
    const prevout = new BufferSet();

    for (let i = 1; i < this.txs.length; i++) {
      const tx = this.txs[i];

      for (const input of tx.inputs)
        prevout.add(input.prevout.hash);
    }

    return prevout.toArray();
  }

  /**
   * Inspect the block and return a more
   * user-friendly representation of the data.
   * @param {CoinView} view
   * @param {Number} height
   * @returns {Object}
   */

  format(view, height) {
    return {
      hash: this.hash().toString('hex'),
      height: height != null ? height : -1,
      size: this.getSize(),
      virtualSize: this.getVirtualSize(),
      date: util.date(this.time),
      version: this.version.toString(16),
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
      txs: this.txs.map((tx, i) => {
        return tx.format(view, null, i);
      })
    };
  }

  /**
   * Convert the block to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @param {CoinView} view
   * @param {Number} height
   * @param {Number} depth
   * @returns {Object}
   */

  getJSON(network, view, height, depth) {
    network = Network.get(network);
    return {
      hash: this.hash().toString('hex'),
      height: height,
      depth: depth,
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
      txs: this.txs.map((tx, i) => {
        return tx.getJSON(network, view, null, i);
      })
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'Block data is required.');
    assert(Array.isArray(json.txs));

    this.parseJSON(json);

    for (const tx of json.txs)
      this.txs.push(TX.fromJSON(tx));

    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  read(br) {
    br.start();

    this.readHead(br);

    const count = br.readVarint();

    let witness = 0;

    for (let i = 0; i < count; i++) {
      const tx = TX.read(br);
      witness += tx._sizes.witness;
      this.txs.push(tx);
    }

    if (!this.mutable) {
      const raw = br.endData();
      const base = raw.length - witness;
      this._raw = raw;
      this._sizes = new Sizes(base, witness);
    }

    return this;
  }

  /**
   * Convert the Block to a MerkleBlock.
   * @param {Bloom} filter - Bloom filter for transactions
   * to match. The merkle block will contain only the
   * matched transactions.
   * @returns {MerkleBlock}
   */

  toMerkle(filter) {
    return MerkleBlock.fromBlock(this, filter);
  }

  write(bw) {
    if (this._raw) {
      bw.writeBytes(this._raw);
      return bw;
    }

    this.writeHead(bw);

    bw.writeVarint(this.txs.length);

    for (const tx of this.txs)
      tx.write(bw);

    return bw;
  }

  encode() {
    if (this.mutable)
      return super.encode();

    if (!this._raw)
      this._raw = super.encode();

    return this._raw;
  }

  /**
   * Convert the block to a headers object.
   * @returns {Headers}
   */

  toHeaders() {
    return Headers.fromBlock(this);
  }

  /**
   * Get real block size with witness.
   * @returns {RawBlock}
   */

  getSizes() {
    if (this._sizes)
      return this._sizes;

    let base = 0;
    let witness = 0;

    base += this.sizeHead();
    base += encoding.sizeVarint(this.txs.length);

    for (const tx of this.txs) {
      const sizes = tx.getSizes();
      base += sizes.base;
      witness += sizes.witness;
    }

    const sizes = new Sizes(base, witness);

    if (!this.mutable)
      this._sizes = sizes;

    return sizes;
  }

  /**
   * Test whether an object is a Block.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isBlock(obj) {
    return obj instanceof Block;
  }
}

/*
 * Helpers
 */

class Sizes {
  constructor(base, witness) {
    this.base = base;
    this.witness = witness;
  }
}

/*
 * Expose
 */

module.exports = Block;
