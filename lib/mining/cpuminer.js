/*!
 * cpuminer.js - inefficient cpu miner for hsd (because we can)
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const EventEmitter = require('events');
const {Lock} = require('bmutex');
const util = require('../utils/util');
const mine = require('./mine');
const consensus = require('../protocol/consensus');

/**
 * CPU miner.
 * @alias module:mining.CPUMiner
 */

class CPUMiner extends EventEmitter {
  /**
   * Create a CPU miner.
   * @constructor
   * @param {Miner} miner
   */

  constructor(miner) {
    super();

    this.opened = false;
    this.miner = miner;
    this.network = this.miner.network;
    this.logger = this.miner.logger.context('cpuminer');
    this.workers = this.miner.workers;
    this.chain = this.miner.chain;
    this.locker = new Lock();

    this.running = false;
    this.stopping = false;
    this.job = null;
    this.stopJob = null;

    this.init();
  }

  /**
   * Initialize the miner.
   * @private
   */

  init() {
    this.chain.on('tip', (tip) => {
      if (!this.job)
        return;

      if (this.job.attempt.prevBlock.equals(tip.prevBlock))
        this.job.destroy();
    });
  }

  /**
   * Open the miner.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'CPUMiner is already open.');
    this.opened = true;
  }

  /**
   * Close the miner.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'CPUMiner is not open.');
    this.opened = false;
    return this.stop();
  }

  /**
   * Start mining.
   * @method
   */

  start() {
    assert(!this.running, 'Miner is already running.');
    this._start().catch(() => {});
  }

  /**
   * Start mining.
   * @method
   * @private
   * @returns {Promise}
   */

  async _start() {
    assert(!this.running, 'Miner is already running.');

    this.running = true;
    this.stopping = false;

    for (;;) {
      this.job = null;

      try {
        this.job = await this.createJob();
      } catch (e) {
        if (this.stopping)
          break;
        this.emit('error', e);
        break;
      }

      if (this.stopping)
        break;

      let block;
      try {
        block = await this.mineAsync(this.job);
      } catch (e) {
        if (this.stopping)
          break;
        this.emit('error', e);
        break;
      }

      if (this.stopping)
        break;

      if (!block)
        continue;

      let entry;
      try {
        entry = await this.chain.add(block);
      } catch (e) {
        if (this.stopping)
          break;

        if (e.type === 'VerifyError') {
          this.logger.warning('Mined an invalid block!');
          this.logger.error(e);
          continue;
        }

        this.emit('error', e);
        break;
      }

      if (!entry) {
        this.logger.warning('Mined a bad-prevblk (race condition?)');
        continue;
      }

      if (this.stopping)
        break;

      this.logger.info('Found block: %d (%x).', entry.height, entry.hash);

      this.emit('block', block, entry);
    }

    const job = this.stopJob;

    if (job) {
      this.stopJob = null;
      job.resolve();
    }
  }

  /**
   * Stop mining.
   * @method
   * @returns {Promise}
   */

  async stop() {
    const unlock = await this.locker.lock();
    try {
      return await this._stop();
    } finally {
      unlock();
    }
  }

  /**
   * Stop mining (without a lock).
   * @method
   * @returns {Promise}
   */

  async _stop() {
    if (!this.running)
      return;

    assert(this.running, 'Miner is not running.');
    assert(!this.stopping, 'Miner is already stopping.');

    this.stopping = true;

    if (this.job) {
      this.job.destroy();
      this.job = null;
    }

    await this.wait();

    this.running = false;
    this.stopping = false;
    this.job = null;
  }

  /**
   * Wait for `done` event.
   * @private
   * @returns {Promise}
   */

  wait() {
    return new Promise((resolve, reject) => {
      assert(!this.stopJob);
      this.stopJob = { resolve, reject };
    });
  }

  /**
   * Create a mining job.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns {@link Job}.
   */

  async createJob(tip, address) {
    const attempt = await this.miner.createBlock(tip, address);
    return new CPUJob(this, attempt);
  }

  /**
   * Mine a single block.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns [{@link Block}].
   */

  async mineBlock(tip, address) {
    const job = await this.createJob(tip, address);
    return await this.mineAsync(job);
  }

  /**
   * Notify the miner that a new
   * tx has entered the mempool.
   */

  notifyEntry() {
    if (!this.running)
      return;

    if (!this.job)
      return;

    if (util.now() - this.job.start > 10) {
      this.job.destroy();
      this.job = null;
    }
  }

  /**
   * Hash until the nonce overflows.
   * @param {CPUJob} job
   * @returns {Number} nonce
   */

  findNonce(job) {
    const hdr = job.getHeader();
    const target = job.attempt.target;
    const interval = CPUMiner.INTERVAL;

    let nonce = 0;
    let solved = false;

    for (;;) {
      [nonce, solved] = mine(hdr, target, interval);

      if (solved)
        break;

      this.sendStatus(job, nonce);
    }

    return [nonce, solved];
  }

  /**
   * Hash until the nonce overflows.
   * @method
   * @param {CPUJob} job
   * @returns {Promise} Returns Number.
   */

  async findNonceAsync(job) {
    if (!this.workers)
      return this.findNonce(job);

    const hdr = job.getHeader();
    const target = job.attempt.target;
    const interval = CPUMiner.INTERVAL;

    let nonce = 0;
    let solved = false;

    for (;;) {
      [nonce, solved] = await this.workers.mine(hdr, target, interval);

      if (solved)
        break;

      if (job.destroyed)
        return [nonce, solved];

      this.sendStatus(job, nonce);
    }

    return [nonce, solved];
  }

  /**
   * Mine synchronously until the block is found.
   * @param {CPUJob} job
   * @returns {Block}
   */

  mine(job) {
    job.start = util.now();

    let nonce, solved;

    for (;;) {
      [nonce, solved] = this.findNonce(job);

      if (solved)
        break;

      job.updateNonce();

      this.sendStatus(job, 0);
    }

    return job.commit(nonce, solved);
  }

  /**
   * Mine asynchronously until the block is found.
   * @method
   * @param {CPUJob} job
   * @returns {Promise} - Returns {@link Block}.
   */

  async mineAsync(job) {
    let nonce, solved;

    job.start = util.now();

    for (;;) {
      [nonce, solved] = await this.findNonceAsync(job);

      if (solved)
        break;

      if (job.destroyed)
        return null;

      job.updateNonce();

      this.sendStatus(job, 0);
    }

    return job.commit(nonce, solved);
  }

  /**
   * Send a progress report (emits `status`).
   * @param {CPUJob} job
   * @param {Number} nonce
   */

  sendStatus(job, nonce) {
    const attempt = job.attempt;
    const tip = attempt.prevBlock;
    const hashes = job.getHashes(nonce);
    const hashrate = job.getRate(nonce);

    this.logger.info(
      'Status: hashrate=%dkhs hashes=%d target=%d height=%d tip=%x',
      Math.floor(hashrate / 1000),
      hashes,
      attempt.bits,
      attempt.height,
      tip);

    this.emit('status', job, hashes, hashrate);
  }
}

/**
 * Nonce range interval.
 * @const {Number}
 * @default
 */

CPUMiner.INTERVAL = 0xffffffff / 1500 | 0;

/**
 * Mining Job
 * @ignore
 */

class CPUJob {
  /**
   * Create a mining job.
   * @constructor
   * @param {CPUMiner} miner
   * @param {BlockTemplate} attempt
   */

  constructor(miner, attempt) {
    this.miner = miner;
    this.attempt = attempt;
    this.destroyed = false;
    this.committed = false;
    this.start = util.now();
    this.extraNonce = Buffer.alloc(consensus.NONCE_SIZE, 0x00);
    this.mask = consensus.ZERO_HASH;
    this.refresh();
  }

  /**
   * Get the raw block header.
   * @returns {Buffer}
   */

  getHeader() {
    const attempt = this.attempt;
    const time = attempt.time;
    const extraNonce = this.extraNonce;
    const mask = this.mask;
    const hdr = attempt.getHeader(0, time, extraNonce, mask);
    return hdr;
  }

  /**
   * Commit job and return a block.
   * @param {Number} nonce
   * @returns {Block}
   */

  commit(nonce) {
    const attempt = this.attempt;
    const time = attempt.time;
    const extraNonce = this.extraNonce;
    const mask = this.mask;

    assert(!this.committed, 'Job already committed.');
    this.committed = true;

    const proof = attempt.getProof(nonce, time, extraNonce, mask);

    return attempt.commit(proof);
  }

  /**
   * Mine block synchronously.
   * @returns {Block}
   */

  mine() {
    return this.miner.mine(this);
  }

  /**
   * Mine block asynchronously.
   * @returns {Promise}
   */

  mineAsync() {
    return this.miner.mineAsync(this);
  }

  /**
   * Refresh the block template.
   */

  refresh() {
    return this.attempt.refresh();
  }

  /**
   * Increment the extraNonce.
   */

  updateNonce() {
    for (let i = 0; i < consensus.NONCE_SIZE; i++) {
      this.extraNonce[i] += 1;

      if (this.extraNonce[i] !== 0)
        break;
    }
  }

  /**
   * Destroy the job.
   */

  destroy() {
    assert(!this.destroyed, 'Job already destroyed.');
    this.destroyed = true;
  }

  /**
   * Calculate number of hashes computed.
   * @param {Number} nonce
   * @returns {Number}
   */

  getHashes(nonce) {
    const nonce1 = bio.readU32(this.extraNonce, 0);
    const nonce2 = bio.readU32(this.extraNonce, 4);
    const extra = nonce2 * 0x100000000 + nonce1;
    return extra * 0xffffffff + nonce;
  }

  /**
   * Calculate hashrate.
   * @param {Number} nonce
   * @returns {Number}
   */

  getRate(nonce) {
    const hashes = this.getHashes(nonce);
    const seconds = util.now() - this.start;
    return Math.floor(hashes / Math.max(1, seconds));
  }

  /**
   * Add a transaction to the block.
   * @param {TX} tx
   * @param {CoinView} view
   */

  addTX(tx, view) {
    return this.attempt.addTX(tx, view);
  }

  /**
   * Add a transaction to the block
   * (less verification than addTX).
   * @param {TX} tx
   * @param {CoinView?} view
   */

  pushTX(tx, view) {
    return this.attempt.pushTX(tx, view);
  }

  /**
   * Add a claim to the block.
   * @param {Claim} claim
   * @param {Object} data
   */

  addClaim(claim, data) {
    return this.attempt.addClaim(claim, data);
  }

  /**
   * Add a claim to the block.
   * @param {Claim} claim
   * @param {Network} network
   */

  pushClaim(claim, network) {
    const data = claim.getData(network);
    assert(data);
    return this.addClaim(claim, data);
  }

  /**
   * Add a airdrop proof to the block.
   * @param {AirdropProof} proof
   */

  addAirdrop(proof) {
    return this.attempt.addAirdrop(proof);
  }

  /**
   * Add a airdrop proof to the block.
   * @param {AirdropProof} proof
   */

  pushAirdrop(proof) {
    return this.addAirdrop(proof);
  }
}

/*
 * Expose
 */

module.exports = CPUMiner;
