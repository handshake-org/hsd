/*!
 * template.js - block template object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const BLAKE2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');
const merkle = require('bcrypto/lib/mrkl');
const Address = require('../primitives/address');
const TX = require('../primitives/tx');
const Block = require('../primitives/block');
const Headers = require('../primitives/headers');
const Input = require('../primitives/input');
const Output = require('../primitives/output');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const CoinView = require('../coins/coinview');
const rules = require('../covenants/rules');
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
    this.prevBlock = consensus.ZERO_HASH;
    this.version = 0;
    this.height = 0;
    this.time = 0;
    this.bits = 0;
    this.target = consensus.ZERO_HASH;
    this.mtp = 0;
    this.flags = 0;
    this.coinbaseFlags = DUMMY;
    this.address = new Address();
    this.sigops = 400;
    this.weight = 4000;
    this.opens = 0;
    this.updates = 0;
    this.renewals = 0;
    this.interval = 170000;
    this.fees = 0;
    this.merkleRoot = consensus.ZERO_HASH;
    this.witnessRoot = consensus.ZERO_HASH;
    this.treeRoot = consensus.ZERO_HASH;
    this.reservedRoot = consensus.ZERO_HASH;
    this.coinbase = DUMMY;
    this.items = [];
    this.claims = [];
    this.airdrops = [];

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
      assert(Buffer.isBuffer(options.prevBlock));
      this.prevBlock = options.prevBlock;
    }

    if (options.merkleRoot != null) {
      assert(Buffer.isBuffer(options.merkleRoot));
      this.merkleRoot = options.merkleRoot;
    }

    if (options.witnessRoot != null) {
      assert(Buffer.isBuffer(options.witnessRoot));
      this.witnessRoot = options.witnessRoot;
    }

    if (options.treeRoot != null) {
      assert(Buffer.isBuffer(options.treeRoot));
      this.treeRoot = options.treeRoot;
    }

    if (options.reservedRoot != null) {
      assert(Buffer.isBuffer(options.reservedRoot));
      this.reservedRoot = options.reservedRoot;
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

    if (options.opens != null) {
      assert(typeof options.opens === 'number');
      this.opens = options.opens;
    }

    if (options.updates != null) {
      assert(typeof options.updates === 'number');
      this.updates = options.updates;
    }

    if (options.renewals != null) {
      assert(typeof options.renewals === 'number');
      this.renewals = options.renewals;
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

    if (options.claims != null) {
      assert(Array.isArray(options.claims));
      this.claims = options.claims;
    }

    if (options.airdrops != null) {
      assert(Array.isArray(options.airdrops));
      this.airdrops = options.airdrops;
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
    input.sequence = random.randomInt();
    input.witness.pushData(Buffer.alloc(20, 0x00));
    input.witness.pushData(Buffer.alloc(8, 0x00));
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
    input.witness.setData(1, random.randomBytes(8));
    input.witness.compile();

    // Setup output address (variable size).
    output.address = this.address;

    // Add any claims.
    for (const claim of this.claims) {
      const input = new Input();

      input.witness.items.push(claim.blob);

      cb.inputs.push(input);

      let flags = 0;

      if (claim.weak)
        flags |= 1;

      const output = new Output();

      output.value = claim.value - claim.fee;
      output.address = claim.address;
      output.covenant.type = rules.types.CLAIM;
      output.covenant.pushHash(claim.nameHash);
      output.covenant.pushU32(this.height);
      output.covenant.push(claim.name);
      output.covenant.pushU8(flags);
      output.covenant.pushHash(claim.commitHash);
      output.covenant.pushU32(claim.commitHeight);

      cb.outputs.push(output);
    }

    // Add any airdrop proofs.
    for (const proof of this.airdrops) {
      const input = new Input();

      input.witness.items.push(proof.blob);

      cb.inputs.push(input);

      const output = new Output();

      output.value = proof.value - proof.fee;
      output.address = proof.address;

      cb.outputs.push(output);
    }

    cb.refresh();

    assert(input.witness.getSize() <= 1000,
      'Coinbase witness is too large!');

    return cb;
  }

  /**
   * Refresh the coinbase and merkle tree.
   */

  refresh() {
    const cb = this.createCoinbase();

    {
      const leaves = [];

      leaves.push(cb.hash());

      for (const {tx} of this.items)
        leaves.push(tx.hash());

      this.merkleRoot = merkle.createRoot(BLAKE2b, leaves);
    }

    {
      const leaves = [];

      leaves.push(cb.witnessHash());

      for (const {tx} of this.items)
        leaves.push(tx.witnessHash());

      this.witnessRoot = merkle.createRoot(BLAKE2b, leaves);
    }

    this.coinbase = cb;
  }

  /**
   * Generate a random mask (2 bytes less than target).
   * @returns {Buffer[]}
   */

  randomMask() {
    const mask = random.randomBytes(32);

    for (let i = 0; i < this.target.length; i++) {
      mask[i] = 0;

      if (this.target[i] !== 0) {
        if (i + 1 < mask.length)
          mask[i + 1] = 0;
        break;
      }
    }

    const hash = BLAKE2b.multi(this.prevBlock, mask);

    return [mask, hash];
  }

  /**
   * Create raw block header with given parameters.
   * @param {Buffer} extraNonce
   * @param {Number} time
   * @param {Number} nonce
   * @returns {Buffer}
   */

  getHeader(nonce, time, extraNonce, mask) {
    const hdr = new Headers();

    hdr.version = this.version;
    hdr.prevBlock = this.prevBlock;
    hdr.merkleRoot = this.merkleRoot;
    hdr.witnessRoot = this.witnessRoot;
    hdr.treeRoot = this.treeRoot;
    hdr.reservedRoot = this.reservedRoot;
    hdr.time = time;
    hdr.bits = this.bits;
    hdr.nonce = nonce;
    hdr.extraNonce = extraNonce;
    hdr.mask = mask;

    return hdr.toMiner();
  }

  /**
   * Calculate proof with given parameters.
   * @param {Number} nonce1
   * @param {Number} nonce2
   * @param {Number} time
   * @param {Buffer} nonce
   * @returns {BlockProof}
   */

  getProof(nonce, time, extraNonce, mask) {
    const hdr = this.getHeader(nonce, time, extraNonce, mask);
    const proof = new BlockProof();

    proof.hdr = hdr;
    proof.time = time;
    proof.nonce = nonce;
    proof.extraNonce = extraNonce;
    proof.mask = mask;

    return proof;
  }

  /**
   * Create block from calculated proof.
   * @param {BlockProof} proof
   * @returns {Block}
   */

  commit(proof) {
    const block = new Block();

    block.version = this.version;
    block.prevBlock = this.prevBlock;
    block.merkleRoot = this.merkleRoot;
    block.witnessRoot = this.witnessRoot;
    block.treeRoot = this.treeRoot;
    block.reservedRoot = this.reservedRoot;
    block.time = proof.time;
    block.bits = this.bits;
    block.nonce = proof.nonce;
    block.extraNonce = proof.extraNonce;
    block.mask = proof.mask;

    block.txs.push(this.coinbase);

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
    return this.coinbase;
  }

  /**
   * Quick and dirty way to get a block
   * object (most likely to be an invalid one).
   * @returns {Block}
   */

  toBlock() {
    const extraNonce = consensus.ZERO_NONCE;
    const mask = consensus.ZERO_HASH;
    const proof = this.getProof(0, this.time, extraNonce, mask);
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
    const opens = rules.countOpens(tx);
    const updates = rules.countUpdates(tx);
    const renewals = rules.countRenewals(tx);

    if (!tx.isFinal(this.height, this.mtp))
      return false;

    if (this.weight + weight > consensus.MAX_BLOCK_WEIGHT)
      return false;

    if (this.sigops + sigops > consensus.MAX_BLOCK_SIGOPS)
      return false;

    if (this.opens + opens > consensus.MAX_BLOCK_OPENS)
      return false;

    if (this.updates + updates > consensus.MAX_BLOCK_UPDATES)
      return false;

    if (this.renewals + renewals > consensus.MAX_BLOCK_RENEWALS)
      return false;

    this.weight += weight;
    this.sigops += sigops;
    this.opens += opens;
    this.updates += updates;
    this.renewals += renewals;
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
    const opens = rules.countOpens(tx);
    const updates = rules.countUpdates(tx);
    const renewals = rules.countRenewals(tx);

    this.weight += weight;
    this.sigops += sigops;
    this.opens += opens;
    this.updates += updates;
    this.renewals += renewals;
    this.fees += item.fee;

    // Add the tx to our block
    this.items.push(item);

    return true;
  }

  /**
   * Add a claim to the template.
   * @param {Claim} claim
   * @param {Object} data
   */

  addClaim(claim, data) {
    const entry = BlockClaim.fromClaim(claim, data);
    this.fees += entry.fee;
    this.claims.push(entry);
    return true;
  }

  /**
   * Add a claim to the template.
   * @param {AirdropProof} proof
   */

  addAirdrop(proof) {
    const entry = BlockAirdrop.fromAirdrop(proof);
    this.fees += entry.fee;
    this.airdrops.push(entry);
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
    this.hash = tx.hash();
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
 * Block Claim
 * @alias module:mining.BlockClaim
 */

class BlockClaim {
  /**
   * Create a block entry.
   * @constructor
   */

  constructor() {
    this.blob = DUMMY;
    this.nameHash = consensus.ZERO_HASH;
    this.name = DUMMY;
    this.address = new Address();
    this.value = 0;
    this.fee = 0;
    this.rate = 0;
    this.weak = false;
    this.commitHash = consensus.ZERO_HASH;
    this.commitHeight = 0;
  }

  /**
   * Calculate weight.
   * @returns {Number}
   */

  getWeight() {
    // Add one to be safe.
    return 1 + bio.sizeVarBytes(this.blob);
  }

  /**
   * Instantiate block entry from transaction.
   * @param {Claim} claim
   * @param {Object} data
   * @returns {BlockClaim}
   */

  static fromClaim(claim, data) {
    const size = claim.getVirtualSize();
    const name = Buffer.from(data.name, 'binary');
    const item = new this();

    item.blob = claim.blob;
    item.nameHash = rules.hashName(name);
    item.name = name;
    item.address = Address.fromHash(data.hash, data.version);
    item.value = data.value;
    item.fee = data.fee;
    item.rate = policy.getRate(size, item.fee);
    item.weak = data.weak;
    item.commitHash = data.commitHash;
    item.commitHeight = data.commitHeight;

    return item;
  }

  /**
   * Instantiate block entry from mempool entry.
   * @param {ClaimEntry} entry
   * @returns {BlockClaim}
   */

  static fromEntry(entry) {
    const item = new this();
    item.blob = entry.blob;
    item.nameHash = entry.nameHash;
    item.name = entry.name;
    item.address = entry.address;
    item.value = entry.value;
    item.fee = entry.fee;
    item.rate = entry.rate;
    item.weak = entry.weak;
    item.commitHash = entry.commitHash;
    item.commitHeight = entry.commitHeight;
    return item;
  }
}

/**
 * Block Airdrop
 * @alias module:mining.BlockAirdrop
 */

class BlockAirdrop {
  /**
   * Create a block entry.
   * @constructor
   */

  constructor() {
    this.blob = DUMMY;
    this.position = 0;
    this.address = new Address();
    this.value = 0;
    this.fee = 0;
    this.rate = 0;
    this.weak = false;
  }

  /**
   * Calculate weight.
   * @returns {Number}
   */

  getWeight() {
    // Add one to be safe.
    return 1 + bio.sizeVarBytes(this.blob);
  }

  /**
   * Instantiate block entry from transaction.
   * @param {AirdropProof} proof
   * @returns {BlockAirdrop}
   */

  static fromAirdrop(proof) {
    const size = proof.getVirtualSize();
    const item = new this();

    item.blob = proof.encode();
    item.position = proof.position();
    item.address = Address.fromHash(proof.address, proof.version);
    item.value = proof.getValue();
    item.fee = proof.fee;
    item.rate = policy.getRate(size, proof.fee);
    item.weak = proof.isWeak();

    return item;
  }

  /**
   * Instantiate block entry from mempool entry.
   * @param {ClaimEntry} entry
   * @returns {BlockClaim}
   */

  static fromEntry(entry) {
    const item = new this();
    item.blob = entry.blob;
    item.position = entry.position;
    item.address = entry.address;
    item.value = entry.value;
    item.fee = entry.fee;
    item.rate = entry.rate;
    item.weak = entry.weak;
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
    this.time = 0;
    this.nonce = 0;
    this.extraNonce = consensus.ZERO_NONCE;
    this.mask = consensus.ZERO_HASH;
  }

  hash() {
    return this.powHash();
  }

  shareHash() {
    const hdr = Headers.fromMiner(this.hdr);
    return hdr.shareHash();
  }

  powHash() {
    const hash = this.shareHash();

    for (let i = 0; i < 32; i++)
      hash[i] ^= this.mask[i];

    return hash;
  }

  verify(target, network) {
    return this.powHash().compare(target) <= 0;
  }

  getDifficulty() {
    return common.getDifficulty(this.powHash());
  }
}

/*
 * Expose
 */

exports = BlockTemplate;
exports.BlockTemplate = BlockTemplate;
exports.BlockEntry = BlockEntry;
exports.BlockClaim = BlockClaim;
exports.BlockAirdrop = BlockAirdrop;

module.exports = exports;
