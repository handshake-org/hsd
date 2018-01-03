/*!
 * template.js - block template object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const merkle = require('bcrypto/lib/merkle');
const util = require('../utils/util');
const Address = require('../primitives/address');
const TX = require('../primitives/tx');
const Block = require('../primitives/block');
const Input = require('../primitives/input');
const Output = require('../primitives/output');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const CoinView = require('../coins/coinview');
const common = require('./common');

/*
 * Constants
 */

const DUMMY = Buffer.alloc(0);

/**
 * Block Template
 * @alias module:mining.BlockTemplate
 */

class BlockTemplate {
  /**
   * Create a block template.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.prevBlock = consensus.NULL_HASH;
    this.version = 1;
    this.height = 0;
    this.time = 0;
    this.bits = 0;
    this.target = consensus.ZERO_HASH;
    this.locktime = 0;
    this.mtp = 0;
    this.flags = 0;
    this.coinbaseFlags = DUMMY;
    this.address = new Address();
    this.sigops = 400;
    this.weight = 4000;
    this.interval = 210000;
    this.fees = 0;
    this.tree = new MerkleTree();
    this.merkleRoot = consensus.NULL_HASH;
    this.reservedRoot = consensus.NULL_HASH;
    this.left = DUMMY;
    this.right = DUMMY;
    this.items = [];

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {BlockTemplate}
   */

  fromOptions(options) {
    assert(options);

    if (options.prevBlock != null) {
      assert(typeof options.prevBlock === 'string');
      this.prevBlock = options.prevBlock;
    }

    if (options.version != null) {
      assert(typeof options.version === 'number');
      this.version = options.version;
    }

    if (options.height != null) {
      assert(typeof options.height === 'number');
      this.height = options.height;
    }

    if (options.time != null) {
      assert(typeof options.time === 'number');
      this.time = options.time;
    }

    if (options.bits != null)
      this.setBits(options.bits);

    if (options.target != null)
      this.setTarget(options.target);

    if (options.locktime != null) {
      assert(typeof options.locktime === 'number');
      this.locktime = options.locktime;
    }

    if (options.mtp != null) {
      assert(typeof options.mtp === 'number');
      this.mtp = options.mtp;
    }

    if (options.flags != null) {
      assert(typeof options.flags === 'number');
      this.flags = options.flags;
    }

    if (options.coinbaseFlags != null) {
      assert(Buffer.isBuffer(options.coinbaseFlags));
      this.coinbaseFlags = options.coinbaseFlags;
    }

    if (options.address != null)
      this.address.fromOptions(options.address);

    if (options.sigops != null) {
      assert(typeof options.sigops === 'number');
      this.sigops = options.sigops;
    }

    if (options.weight != null) {
      assert(typeof options.weight === 'number');
      this.weight = options.weight;
    }

    if (options.interval != null) {
      assert(typeof options.interval === 'number');
      this.interval = options.interval;
    }

    if (options.fees != null) {
      assert(typeof options.fees === 'number');
      this.fees = options.fees;
    }

    if (options.items != null) {
      assert(Array.isArray(options.items));
      this.items = options.items;
    }

    return this;
  }

  /**
   * Instantiate block template from options.
   * @param {Object} options
   * @returns {BlockTemplate}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Create witness commitment hash.
   * @returns {Buffer}
   */

  getMerkleRoot(cb) {
    const leaves = [];

    leaves.push(cb.hash());

    for (const {tx} of this.items)
      leaves.push(tx.hash());

    const [root, malleated] = merkle.createRoot(blake2b, leaves);

    assert(!malleated);

    return root.toString('hex');
  }

  /**
   * Set the target (bits).
   * @param {Number} bits
   */

  setBits(bits) {
    assert(typeof bits === 'number');
    this.bits = bits;
    this.target = common.getTarget(bits);
  }

  /**
   * Set the target (uint256le).
   * @param {Buffer} target
   */

  setTarget(target) {
    assert(Buffer.isBuffer(target));
    this.bits = common.getBits(target);
    this.target = target;
  }

  /**
   * Calculate the block reward.
   * @returns {Amount}
   */

  getReward() {
    const reward = consensus.getReward(this.height, this.interval);
    return reward + this.fees;
  }

  /**
   * Initialize the default coinbase.
   * @returns {TX}
   */

  createCoinbase() {
    const cb = new TX();

    // Commit to height.
    cb.locktime = this.height;

    // Coinbase input.
    const input = new Input();
    input.witness.pushData(Buffer.alloc(20, 0x00));
    input.witness.pushData(Buffer.alloc(8, 0x00));
    input.witness.compile();

    cb.inputs.push(input);

    // Reward output.
    const output = new Output();
    output.address.fromPubkeyhash(Buffer.alloc(20, 0x00));
    output.value = this.getReward();

    cb.outputs.push(output);

    // Setup coinbase flags (variable size).
    input.witness.setData(0, this.coinbaseFlags);
    input.witness.compile();

    // Setup output address (variable size).
    output.address = this.address;

    cb.refresh();

    assert(input.witness.getSize() <= 100,
      'Coinbase witness is too large!');

    return cb;
  }

  /**
   * Refresh the coinbase and merkle tree.
   */

  refresh() {
    const cb = this.createCoinbase();
    const raw = cb.toRaw();

    let size = 0;

    size += 4; // version
    size += 1; // varint inputs length
    size += cb.inputs[0].getSize(); // input size
    size -= 4 + 4 + 4; // -(nonce1 + nonce2 + sequence)

    // Cut off right after the nonce
    // push and before the sequence.
    const left = raw.slice(0, size);

    // Include the sequence.
    size += 4 + 4; // nonce1 + nonce2
    const right = raw.slice(size);

    this.left = left;
    this.right = right;
    this.merkleRoot = this.getMerkleRoot(cb);
    this.tree = MerkleTree.fromItems(this.items);
  }

  /**
   * Get raw coinbase with desired nonces.
   * @param {Number} nonce1
   * @param {Number} nonce2
   * @returns {Buffer}
   */

  getRawCoinbase(nonce1, nonce2) {
    let size = 0;

    size += this.left.length;
    size += 4 + 4;
    size += this.right.length;

    const bw = bio.write(size);
    bw.writeBytes(this.left);
    bw.writeU32BE(nonce1);
    bw.writeU32BE(nonce2);
    bw.writeBytes(this.right);

    return bw.render();
  }

  /**
   * Calculate the merkle root with given nonces.
   * @param {Number} nonce1
   * @param {Number} nonce2
   * @returns {Buffer}
   */

  getRoot(nonce1, nonce2) {
    const raw = this.getRawCoinbase(nonce1, nonce2);
    const hash = blake2b.digest(raw);
    return this.tree.withFirst(hash);
  }

  /**
   * Create raw block header with given parameters.
   * @param {Buffer} root
   * @param {Number} time
   * @param {Number} nonce
   * @returns {Buffer}
   */

  getPreheader(root, time, nonce) {
    const bw = bio.write(consensus.HEADER_SIZE);

    bw.writeU32(this.version);
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.merkleRoot);
    bw.writeHash(root);
    bw.writeHash(this.reservedRoot);
    bw.writeU64(time);
    bw.writeU32(this.bits);
    bw.writeBytes(nonce);

    return bw.render();
  }

  /**
   * Create raw block header with given parameters.
   * @param {Buffer} root
   * @param {Number} time
   * @param {Number} nonce
   * @param {Solution} sol
   * @returns {Buffer}
   */

  getHeader(root, time, nonce, sol) {
    const bw = bio.write(consensus.HEADER_SIZE + sol.getSize());

    bw.writeU32(this.version);
    bw.writeHash(this.prevBlock);
    bw.writeHash(this.merkleRoot);
    bw.writeHash(root);
    bw.writeHash(this.reservedRoot);
    bw.writeU64(time);
    bw.writeU32(this.bits);
    bw.writeBytes(nonce);
    sol.toWriter(bw);

    return bw.render();
  }

  /**
   * Calculate proof with given parameters.
   * @param {Number} nonce1
   * @param {Number} nonce2
   * @param {Number} time
   * @param {Buffer} nonce
   * @param {Solution} sol
   * @returns {BlockProof}
   */

  getProof(nonce1, nonce2, time, nonce, sol) {
    const root = this.getRoot(nonce1, nonce2);
    const hdr = this.getPreheader(root, time, nonce);

    const proof = new BlockProof();

    proof.hdr = hdr;
    proof.solution = sol;
    proof.root = root;
    proof.nonce1 = nonce1;
    proof.nonce2 = nonce2;
    proof.time = time;
    proof.nonce = nonce;

    return proof;
  }

  /**
   * Create coinbase from given parameters.
   * @param {Number} nonce1
   * @param {Number} nonce2
   * @returns {TX}
   */

  getCoinbase(nonce1, nonce2) {
    const raw = this.getRawCoinbase(nonce1, nonce2);
    return TX.fromRaw(raw);
  }

  /**
   * Create block from calculated proof.
   * @param {BlockProof} proof
   * @returns {Block}
   */

  commit(proof) {
    const root = proof.root;
    const n1 = proof.nonce1;
    const n2 = proof.nonce2;
    const time = proof.time;
    const nonce = proof.nonce;
    const sol = proof.solution;
    const block = new Block();

    block.version = this.version;
    block.prevBlock = this.prevBlock;
    block.merkleRoot = this.merkleRoot;
    block.witnessRoot = root.toString('hex');
    block.reservedRoot = this.reservedRoot;
    block.time = time;
    block.bits = this.bits;
    block.nonce = nonce;
    block.solution = sol;

    const tx = this.getCoinbase(n1, n2);

    block.txs.push(tx);

    for (const item of this.items)
      block.txs.push(item.tx);

    return block;
  }

  /**
   * Quick and dirty way to
   * get a coinbase tx object.
   * @returns {TX}
   */

  toCoinbase() {
    return this.getCoinbase(0, 0);
  }

  /**
   * Quick and dirty way to get a block
   * object (most likely to be an invalid one).
   * @returns {Block}
   */

  toBlock() {
    const nonce = consensus.ZERO_NONCE;
    const sol = consensus.ZERO_SOL;
    const proof = this.getProof(0, 0, this.time, nonce, sol);
    return this.commit(proof);
  }

  /**
   * Calculate the target difficulty.
   * @returns {Number}
   */

  getDifficulty() {
    return common.getDifficulty(this.target);
  }

  /**
   * Set the reward output
   * address and refresh.
   * @param {Address} address
   */

  setAddress(address) {
    this.address = new Address(address);
    this.refresh();
  }

  /**
   * Add a transaction to the template.
   * @param {TX} tx
   * @param {CoinView} view
   */

  addTX(tx, view) {
    assert(!tx.mutable, 'Cannot add mutable TX to block.');

    const item = BlockEntry.fromTX(tx, view, this);
    const weight = item.tx.getWeight();
    const sigops = item.sigops;

    if (!tx.isFinal(this.height, this.locktime))
      return false;

    if (this.weight + weight > consensus.MAX_BLOCK_WEIGHT)
      return false;

    if (this.sigops + sigops > consensus.MAX_BLOCK_SIGOPS)
      return false;

    this.weight += weight;
    this.sigops += sigops;
    this.fees += item.fee;

    // Add the tx to our block
    this.items.push(item);

    return true;
  }

  /**
   * Add a transaction to the template
   * (less verification than addTX).
   * @param {TX} tx
   * @param {CoinView?} view
   */

  pushTX(tx, view) {
    assert(!tx.mutable, 'Cannot add mutable TX to block.');

    if (!view)
      view = new CoinView();

    const item = BlockEntry.fromTX(tx, view, this);
    const weight = item.tx.getWeight();
    const sigops = item.sigops;

    this.weight += weight;
    this.sigops += sigops;
    this.fees += item.fee;

    // Add the tx to our block
    this.items.push(item);

    return true;
  }
}

/**
 * Block Entry
 * @alias module:mining.BlockEntry
 * @property {TX} tx
 * @property {Hash} hash
 * @property {Amount} fee
 * @property {Rate} rate
 * @property {Number} priority
 * @property {Boolean} free
 * @property {Sigops} sigops
 * @property {Number} depCount
 */

class BlockEntry {
  /**
   * Create a block entry.
   * @constructor
   * @param {TX} tx
   */

  constructor(tx) {
    this.tx = tx;
    this.hash = tx.hash('hex');
    this.fee = 0;
    this.rate = 0;
    this.priority = 0;
    this.free = false;
    this.sigops = 0;
    this.descRate = 0;
    this.depCount = 0;
  }

  /**
   * Instantiate block entry from transaction.
   * @param {TX} tx
   * @param {CoinView} view
   * @param {BlockTemplate} attempt
   * @returns {BlockEntry}
   */

  static fromTX(tx, view, attempt) {
    const item = new this(tx);
    item.fee = tx.getFee(view);
    item.rate = tx.getRate(view);
    item.priority = tx.getPriority(view, attempt.height);
    item.free = false;
    item.sigops = tx.getSigops(view);
    item.descRate = item.rate;
    return item;
  }

  /**
   * Instantiate block entry from mempool entry.
   * @param {MempoolEntry} entry
   * @param {BlockTemplate} attempt
   * @returns {BlockEntry}
   */

  static fromEntry(entry, attempt) {
    const item = new this(entry.tx);
    item.fee = entry.getFee();
    item.rate = entry.getDeltaRate();
    item.priority = entry.getPriority(attempt.height);
    item.free = entry.getDeltaFee() < policy.getMinFee(entry.size);
    item.sigops = entry.sigops;
    item.descRate = entry.getDescRate();
    return item;
  }
}

/**
 * Block Proof
 */

class BlockProof {
  /**
   * Create a block proof.
   * @constructor
   */

  constructor() {
    this.hdr = consensus.ZERO_HEADER;
    this.solution = consensus.ZERO_SOL;
    this.root = consensus.ZERO_HASH;
    this.nonce1 = 0;
    this.nonce2 = 0;
    this.time = 0;
    this.nonce = consensus.ZERO_NONCE;
  }

  hash() {
    return this.solution.hash();
  }

  rhash() {
    return util.revHex(this.hash().toString('hex'));
  }

  verify(target, network) {
    if (common.rcmp(this.hash(), target) > 0)
      return false;

    assert(this.hdr.length === consensus.HEADER_SIZE);

    const hdr = this.hdr;
    const sol = this.solution;
    const params = network.cuckoo;

    if (!consensus.verifySolution(hdr, sol, params))
      return false;

    return true;
  }

  getDifficulty() {
    return common.getDifficulty(this.hash());
  }
}

/**
 * Merkle Tree
 * @property {Hash[]} steps
 */

class MerkleTree {
  /**
   * Create a merkle tree.
   * @constructor
   */

  constructor() {
    this.steps = [];
  }

  withFirst(hash) {
    for (const step of this.steps)
      hash = blake2b.root(hash, step);
    return hash;
  }

  toJSON() {
    const steps = [];

    for (const step of this.steps)
      steps.push(step.toString('hex'));

    return steps;
  }

  fromItems(items) {
    const leaves = [];

    leaves.push(consensus.ZERO_HASH);

    for (const item of items)
      leaves.push(item.tx.witnessHash());

    return this.fromLeaves(leaves);
  }

  static fromItems(items) {
    return new this().fromItems(items);
  }

  fromBlock(txs) {
    const leaves = [];

    leaves.push(consensus.ZERO_HASH);

    for (let i = 1; i < txs.length; i++) {
      const tx = txs[i];
      leaves.push(tx.witnessHash());
    }

    return this.fromLeaves(leaves);
  }

  static fromBlock(txs) {
    return new this().fromBlock(txs);
  }

  fromLeaves(leaves) {
    let len = leaves.length;

    while (len > 1) {
      const hashes = [consensus.ZERO_HASH];

      this.steps.push(leaves[1]);

      if (len % 2)
        leaves.push(leaves[len - 1]);

      for (let i = 2; i < len; i += 2) {
        const hash = blake2b.root(leaves[i], leaves[i + 1]);
        hashes.push(hash);
      }

      leaves = hashes;
      len = leaves.length;
    }

    return this;
  }

  static fromLeaves(leaves) {
    return new this().fromLeaves(leaves);
  }
}

/*
 * Expose
 */

exports = BlockTemplate;
exports.BlockTemplate = BlockTemplate;
exports.BlockEntry = BlockEntry;

module.exports = exports;
