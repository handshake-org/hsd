/*!
 * block.js - block object for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const util = require('../utils/util');
const blake2b = require('bcrypto/lib/blake2b');
const merkle = require('bcrypto/lib/merkle');
const consensus = require('../protocol/consensus');
const AbstractBlock = require('./abstractblock');
const TX = require('./tx');
const MerkleBlock = require('./merkleblock');
const Headers = require('./headers');
const Network = require('../protocol/network');
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
  }

  /**
   * Instantiate block from options.
   * @param {Object} options
   * @returns {Block}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
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
      return;

    for (const tx of this.txs)
      tx.refresh();
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
      if (tx.hash('hex') === hash)
        return i;
    }

    return -1;
  }

  /**
   * Calculate merkle root. Returns null
   * if merkle tree has been malleated.
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Hash|null}
   */

  createMerkleRoot(enc) {
    const leaves = [];

    for (const tx of this.txs)
      leaves.push(tx.hash());

    const [root, malleated] = merkle.createRoot(blake2b, leaves);

    if (malleated)
      return null;

    return enc === 'hex' ? root.toString('hex') : root;
  }

  /**
   * Calculate commitment hash (the root of the
   * witness merkle tree hashed with the witnessNonce).
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Hash}
   */

  createWitnessRoot(enc) {
    const leaves = [];

    for (const tx of this.txs)
      leaves.push(tx.witnessHash());

    const [root] = merkle.createRoot(blake2b, leaves);

    // Note: malleation check ignored here.
    // assert(!malleated);

    return enc === 'hex' ? root.toString('hex') : root;
  }

  /**
   * Retrieve the merkle root from the block header.
   * @param {String?} enc
   * @returns {Hash}
   */

  getMerkleRoot(enc) {
    if (enc === 'hex')
      return this.merkleRoot;
    return Buffer.from(this.merkleRoot, 'hex');
  }

  /**
   * Retrieve the commitment hash
   * from the coinbase's outputs.
   * @param {String?} enc
   * @returns {Hash|null}
   */

  getWitnessRoot(enc) {
    if (enc === 'hex')
      return this.witnessRoot;
    return Buffer.from(this.witnessRoot, 'hex');
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
    // Check merkle root.
    const merkleRoot = this.createMerkleRoot('hex');

    // If the merkle is mutated,
    // we have duplicate txs.
    if (!merkleRoot)
      return [false, 'bad-txns-duplicate', 100];

    if (merkleRoot !== this.merkleRoot)
      return [false, 'bad-txnmrklroot', 100];

    // Check witness root.
    const witnessRoot = this.createWitnessRoot('hex');

    if (witnessRoot !== this.witnessRoot)
      return [false, 'bad-witness-merkle-match', 100];

    // Check base size.
    if (this.txs.length === 0
        || this.txs.length > consensus.MAX_BLOCK_SIZE
        || this.getBaseSize() > consensus.MAX_BLOCK_SIZE) {
      return [false, 'bad-blk-length', 100];
    }

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
    const prevout = Object.create(null);

    for (let i = 1; i < this.txs.length; i++) {
      const tx = this.txs[i];

      for (const input of tx.inputs)
        prevout[input.prevout.hash] = true;
    }

    return Object.keys(prevout);
  }

  /**
   * Inspect the block and return a more
   * user-friendly representation of the data.
   * @returns {Object}
   */

  inspect() {
    return this.format();
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
      hash: this.rhash(),
      height: height != null ? height : -1,
      size: this.getSize(),
      virtualSize: this.getVirtualSize(),
      date: util.date(this.time),
      version: this.version.toString(16),
      prevBlock: util.revHex(this.prevBlock),
      merkleRoot: util.revHex(this.merkleRoot),
      witnessRoot: util.revHex(this.witnessRoot),
      trieRoot: util.revHex(this.trieRoot),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce.toString('hex'),
      solution: this.solution,
      txs: this.txs.map((tx, i) => {
        return tx.format(view, null, i);
      })
    };
  }

  /**
   * Convert the block to an object suitable
   * for JSON serialization.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON();
  }

  /**
   * Convert the block to an object suitable
   * for JSON serialization. Note that the hashes
   * will be reversed to abide by bitcoind's legacy
   * of little-endian uint256s.
   * @param {Network} network
   * @param {CoinView} view
   * @param {Number} height
   * @param {Number} depth
   * @returns {Object}
   */

  getJSON(network, view, height, depth) {
    network = Network.get(network);
    return {
      hash: this.rhash(),
      height: height,
      depth: depth,
      version: this.version,
      prevBlock: util.revHex(this.prevBlock),
      merkleRoot: util.revHex(this.merkleRoot),
      witnessRoot: util.revHex(this.witnessRoot),
      trieRoot: util.revHex(this.trieRoot),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce.toString('hex'),
      solution: this.solution,
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
   * Instantiate a block from a jsonified block object.
   * @param {Object} json - The jsonified block object.
   * @returns {Block}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromReader(br) {
    br.start();

    this.readHead(br);

    const count = br.readVarint();

    let witness = 0;

    for (let i = 0; i < count; i++) {
      const tx = TX.fromReader(br);
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
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  /**
   * Instantiate a block from a serialized Buffer.
   * @param {Buffer} data
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Block}
   */

  static fromReader(data) {
    return new this().fromReader(data);
  }

  /**
   * Instantiate a block from a serialized Buffer.
   * @param {Buffer} data
   * @param {String?} enc - Encoding, can be `'hex'` or null.
   * @returns {Block}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new this().fromRaw(data);
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

  /**
   * Serialize block with or without witness data.
   * @private
   * @param {Boolean} witness
   * @param {BufferWriter?} writer
   * @returns {Buffer}
   */

  toWriter(bw) {
    if (this._raw) {
      bw.writeBytes(this._raw);
      return bw;
    }

    this.writeHead(bw);

    bw.writeVarint(this.txs.length);

    for (const tx of this.txs)
      tx.toWriter(bw);

    return bw;
  }

  toRaw() {
    if (this._raw)
      return this._raw;

    const size = this.getSize();
    const bw = bio.write(size);

    this.toWriter(bw);

    const raw = bw.render();

    if (!this.mutable)
      this._raw = raw;

    return raw;
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
