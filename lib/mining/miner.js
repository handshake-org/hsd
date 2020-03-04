/*!
 * miner.js - block generator for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const Heap = require('bheep');
const {BufferMap} = require('buffer-map');
const rng = require('bcrypto/lib/random');
const Amount = require('../ui/amount');
const Address = require('../primitives/address');
const BlockTemplate = require('./template');
const Network = require('../protocol/network');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const rules = require('../covenants/rules');
const CPUMiner = require('./cpuminer');
const pkg = require('../pkg');
const {BlockEntry, BlockClaim, BlockAirdrop} = BlockTemplate;

/**
 * Miner
 * A handshake miner and block generator.
 * @alias module:mining.Miner
 * @extends EventEmitter
 */

class Miner extends EventEmitter {
  /**
   * Create a handshake miner.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.opened = false;
    this.options = new MinerOptions(options);
    this.network = this.options.network;
    this.logger = this.options.logger.context('miner');
    this.workers = this.options.workers;
    this.chain = this.options.chain;
    this.mempool = this.options.mempool;
    this.addresses = this.options.addresses;
    this.locker = this.chain.locker;
    this.cpu = new CPUMiner(this);

    this.init();
  }

  /**
   * Initialize the miner.
   */

  init() {
    this.cpu.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Open the miner, wait for the chain and mempool to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'Miner is already open.');
    this.opened = true;

    await this.cpu.open();

    this.logger.info('Miner loaded (flags=%s).',
      this.options.coinbaseFlags.toString('utf8'));

    if (this.addresses.length === 0)
      this.logger.warning('No reward address is set for miner!');
  }

  /**
   * Close the miner.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'Miner is not open.');
    this.opened = false;
    return this.cpu.close();
  }

  /**
   * Create a block template.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns {@link BlockTemplate}.
   */

  async createBlock(tip, address) {
    const unlock = await this.locker.lock();
    try {
      return await this._createBlock(tip, address);
    } finally {
      unlock();
    }
  }

  /**
   * Create a block template (without a lock).
   * @method
   * @private
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} - Returns {@link BlockTemplate}.
   */

  async _createBlock(tip, address) {
    let version = this.options.version;

    if (!tip)
      tip = this.chain.tip;

    if (!address)
      address = this.getAddress();

    if (version === -1)
      version = await this.chain.computeBlockVersion(tip);

    const mtp = await this.chain.getMedianTime(tip);
    const time = Math.max(this.network.now(), mtp + 1);

    const state = await this.chain.getDeployments(time, tip);
    const target = await this.chain.getTarget(time, tip);
    const root = this.chain.db.treeRoot();

    const attempt = new BlockTemplate({
      prevBlock: tip.hash,
      treeRoot: root,
      reservedRoot: consensus.ZERO_HASH,
      height: tip.height + 1,
      version: version,
      time: time,
      bits: target,
      mtp: mtp,
      flags: state.flags,
      address: address,
      coinbaseFlags: this.options.coinbaseFlags,
      interval: this.network.halvingInterval,
      weight: this.options.reservedWeight,
      sigops: this.options.reservedSigops
    });

    this.assemble(attempt);

    this.logger.debug(
      'Created block tmpl'
      + ' (height=%d, weight=%d, fees=%d, txs=%s, diff=%d, bits=%d).',
      attempt.height,
      attempt.weight,
      Amount.coin(attempt.fees),
      attempt.items.length + 1,
      attempt.getDifficulty(),
      target);

    if (this.options.preverify) {
      const block = attempt.toBlock();

      try {
        await this.chain._verifyBlock(block);
      } catch (e) {
        if (e.type === 'VerifyError') {
          this.logger.warning('Miner created invalid block!');
          this.logger.error(e);
          throw new Error('BUG: Miner created invalid block.');
        }
        throw e;
      }

      this.logger.debug(
        'Preverified block %d successfully!',
        attempt.height);
    }

    return attempt;
  }

  /**
   * Update block timestamp.
   * @param {BlockTemplate} attempt
   */

  updateTime(attempt) {
    const pow = this.network.pow;

    attempt.time = Math.max(this.network.now(), attempt.mtp + 1);

    if (!pow.targetReset)
      return;

    const prev = this.chain.tip;

    if (!attempt.prevBlock.equals(prev.hash))
      return;

    if (attempt.time > prev.time + pow.targetSpacing * 2)
      attempt.setBits(pow.bits);
  }

  /**
   * Create a cpu miner job.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} Returns {@link CPUJob}.
   */

  createJob(tip, address) {
    return this.cpu.createJob(tip, address);
  }

  /**
   * Mine a single block.
   * @method
   * @param {ChainEntry?} tip
   * @param {Address?} address
   * @returns {Promise} Returns {@link Block}.
   */

  mineBlock(tip, address) {
    return this.cpu.mineBlock(tip, address);
  }

  /**
   * Add an address to the address list.
   * @param {Address} address
   */

  addAddress(address) {
    this.addresses.push(new Address(address));
  }

  /**
   * Get a random address from the address list.
   * @returns {Address}
   */

  getAddress() {
    if (this.addresses.length === 0)
      return new Address();
    return this.addresses[rng.randomRange(0, this.addresses.length)];
  }

  /**
   * Get mempool entries, sort by dependency order.
   * Prioritize by priority and fee rates.
   * @param {BlockTemplate} attempt
   * @returns {MempoolEntry[]}
   */

  assemble(attempt) {
    if (!this.mempool) {
      attempt.refresh();
      return;
    }

    assert(this.mempool.tip.equals(this.chain.tip.hash),
      'Mempool/chain tip mismatch! Unsafe to create block.');

    const pq = new Heap(cmpRateClaim);

    for (const entry of this.mempool.claims.values()) {
      const item = BlockClaim.fromEntry(entry);
      pq.insert(item);
    }

    while (pq.size() > 0) {
      if (attempt.claims.length >= 10)
        break;

      const item = pq.shift();
      const weight = item.getWeight();

      if (attempt.weight + weight > this.options.maxWeight)
        continue;

      if (attempt.updates + 1 > this.options.maxUpdates)
        continue;

      attempt.fees += item.fee;
      attempt.weight += weight;
      attempt.updates += 1;

      attempt.claims.push(item);
    }

    const pqa = new Heap(cmpRateAirdrop);

    for (const entry of this.mempool.airdrops.values()) {
      const item = BlockAirdrop.fromEntry(entry);
      pqa.insert(item);
    }

    while (pqa.size() > 0) {
      if (attempt.airdrops.length >= 10)
        break;

      const item = pqa.shift();
      const weight = item.getWeight();

      if (attempt.weight + weight > this.options.maxWeight)
        continue;

      if (attempt.updates + 1 > this.options.maxUpdates)
        continue;

      attempt.fees += item.fee;
      attempt.weight += weight;
      attempt.updates += 1;

      attempt.airdrops.push(item);
    }

    const depMap = new BufferMap();
    const queue = new Heap(cmpRate);

    let priority = this.options.priorityWeight > 0;

    if (priority)
      queue.set(cmpPriority);

    for (const entry of this.mempool.map.values()) {
      const item = BlockEntry.fromEntry(entry, attempt);
      const tx = item.tx;

      if (tx.isCoinbase())
        throw new Error('Cannot add coinbase to block.');

      for (const {prevout} of tx.inputs) {
        const hash = prevout.hash;

        if (!this.mempool.hasEntry(hash))
          continue;

        item.depCount += 1;

        if (!depMap.has(hash))
          depMap.set(hash, []);

        depMap.get(hash).push(item);
      }

      if (item.depCount > 0)
        continue;

      queue.insert(item);
    }

    while (queue.size() > 0) {
      const item = queue.shift();
      const tx = item.tx;
      const hash = item.hash;

      let weight = attempt.weight;
      let sigops = attempt.sigops;
      let opens = attempt.opens;
      let updates = attempt.updates;
      let renewals = attempt.renewals;

      if (!tx.isFinal(attempt.height, attempt.mtp))
        continue;

      weight += tx.getWeight();

      if (weight > this.options.maxWeight)
        continue;

      sigops += item.sigops;

      if (sigops > this.options.maxSigops)
        continue;

      opens += rules.countOpens(tx);

      if (opens > this.options.maxOpens)
        continue;

      updates += rules.countUpdates(tx);

      if (updates > this.options.maxUpdates)
        continue;

      renewals += rules.countRenewals(tx);

      if (renewals > this.options.maxRenewals)
        continue;

      if (priority) {
        if (weight > this.options.priorityWeight
            || item.priority < this.options.priorityThreshold) {
          priority = false;
          queue.set(cmpRate);
          queue.init();
          queue.insert(item);
          continue;
        }
      } else {
        if (item.free && weight >= this.options.minWeight)
          continue;
      }

      attempt.weight = weight;
      attempt.sigops = sigops;
      attempt.opens = opens;
      attempt.updates = updates;
      attempt.renewals = renewals;
      attempt.fees += item.fee;
      attempt.items.push(item);

      const deps = depMap.get(hash);

      if (!deps)
        continue;

      for (const item of deps) {
        if (--item.depCount === 0)
          queue.insert(item);
      }
    }

    attempt.refresh();

    assert(attempt.weight <= consensus.MAX_BLOCK_WEIGHT,
      'Block exceeds reserved weight!');

    if (this.options.preverify) {
      const block = attempt.toBlock();

      assert(block.getWeight() <= attempt.weight,
        'Block exceeds reserved weight!');

      assert(block.getBaseSize() <= consensus.MAX_BLOCK_SIZE,
        'Block exceeds max block size.');
    }
  }
}

/**
 * Miner Options
 * @alias module:mining.MinerOptions
 */

class MinerOptions {
  /**
   * Create miner options.
   * @constructor
   * @param {Object}
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = null;
    this.workers = null;
    this.chain = null;
    this.mempool = null;

    this.version = 0;
    this.addresses = [];
    this.coinbaseFlags = Buffer.from(`mined by ${pkg.name}`, 'ascii');
    this.preverify = false;

    this.minWeight = policy.MIN_BLOCK_WEIGHT;
    this.maxWeight = policy.MAX_BLOCK_WEIGHT;
    this.priorityWeight = policy.BLOCK_PRIORITY_WEIGHT;
    this.priorityThreshold = policy.BLOCK_PRIORITY_THRESHOLD;
    this.maxSigops = consensus.MAX_BLOCK_SIGOPS;
    this.maxOpens = consensus.MAX_BLOCK_OPENS;
    this.maxUpdates = consensus.MAX_BLOCK_UPDATES;
    this.maxRenewals = consensus.MAX_BLOCK_RENEWALS;
    this.reservedWeight = 4000;
    this.reservedSigops = 400;

    this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {MinerOptions}
   */

  fromOptions(options) {
    assert(options, 'Miner requires options.');
    assert(options.chain && typeof options.chain === 'object',
      'Miner requires a blockchain.');

    this.chain = options.chain;
    this.network = options.chain.network;
    this.logger = options.chain.logger;
    this.workers = options.chain.workers;

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.workers != null) {
      assert(typeof options.workers === 'object');
      this.workers = options.workers;
    }

    if (options.mempool != null) {
      assert(typeof options.mempool === 'object');
      this.mempool = options.mempool;
    }

    if (options.version != null) {
      assert((options.version >>> 0) === options.version);
      this.version = options.version;
    }

    if (options.address) {
      if (Array.isArray(options.address)) {
        for (const item of options.address)
          this.addresses.push(new Address(item));
      } else {
        this.addresses.push(new Address(options.address));
      }
    }

    if (options.addresses) {
      assert(Array.isArray(options.addresses));
      for (const item of options.addresses)
        this.addresses.push(new Address(item));
    }

    if (options.coinbaseFlags) {
      let flags = options.coinbaseFlags;
      if (typeof flags === 'string')
        flags = Buffer.from(flags, 'utf8');
      assert(Buffer.isBuffer(flags));
      assert(flags.length <= 20, 'Coinbase flags > 20 bytes.');
      this.coinbaseFlags = flags;
    }

    if (options.preverify != null) {
      assert(typeof options.preverify === 'boolean');
      this.preverify = options.preverify;
    }

    if (options.minWeight != null) {
      assert((options.minWeight >>> 0) === options.minWeight);
      this.minWeight = options.minWeight;
    }

    if (options.maxWeight != null) {
      assert((options.maxWeight >>> 0) === options.maxWeight);
      assert(options.maxWeight <= consensus.MAX_BLOCK_WEIGHT,
        'Max weight must be below MAX_BLOCK_WEIGHT');
      this.maxWeight = options.maxWeight;
    }

    if (options.maxSigops != null) {
      assert((options.maxSigops >>> 0) === options.maxSigops);
      assert(options.maxSigops <= consensus.MAX_BLOCK_SIGOPS,
        'Max sigops must be below MAX_BLOCK_SIGOPS');
      this.maxSigops = options.maxSigops;
    }

    if (options.priorityWeight != null) {
      assert((options.priorityWeight >>> 0) === options.priorityWeight);
      this.priorityWeight = options.priorityWeight;
    }

    if (options.priorityThreshold != null) {
      assert((options.priorityThreshold >>> 0) === options.priorityThreshold);
      this.priorityThreshold = options.priorityThreshold;
    }

    if (options.reservedWeight != null) {
      assert((options.reservedWeight >>> 0) === options.reservedWeight);
      this.reservedWeight = options.reservedWeight;
    }

    if (options.reservedSigops != null) {
      assert((options.reservedSigops >>> 0) === options.reservedSigops);
      this.reservedSigops = options.reservedSigops;
    }

    if (options.maxOpens != null) {
      assert((options.maxOpens >>> 0) === options.maxOpens);
      assert(options.maxOpens <= consensus.MAX_BLOCK_OPENS,
        'Max sigops must be below MAX_BLOCK_OPENS');
      this.maxOpens = options.maxOpens;
    }

    if (options.maxUpdates != null) {
      assert((options.maxUpdates >>> 0) === options.maxUpdates);
      assert(options.maxUpdates <= consensus.MAX_BLOCK_UPDATES,
        'Max sigops must be below MAX_BLOCK_UPDATES');
      this.maxUpdates = options.maxUpdates;
    }

    if (options.maxRenewals != null) {
      assert((options.maxRenewals >>> 0) === options.maxRenewals);
      assert(options.maxRenewals <= consensus.MAX_BLOCK_RENEWALS,
        'Max sigops must be below MAX_BLOCK_RENEWALS');
      this.maxRenewals = options.maxRenewals;
    }

    return this;
  }

  /**
   * Instantiate miner options from object.
   * @param {Object} options
   * @returns {MinerOptions}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }
}

/*
 * Helpers
 */

function cmpPriority(a, b) {
  if (a.priority === b.priority)
    return cmpRate(a, b);
  return b.priority - a.priority;
}

function cmpRate(a, b) {
  let x = a.rate;
  let y = b.rate;

  if (a.descRate > a.rate)
    x = a.descRate;

  if (b.descRate > b.rate)
    y = b.descRate;

  if (x === y) {
    x = a.priority;
    y = b.priority;
  }

  return y - x;
}

function cmpRateClaim(a, b) {
  const x = a.rate;
  const y = b.rate;

  return y - x;
}

function cmpRateAirdrop(a, b) {
  const x = a.rate;
  const y = b.rate;

  return y - x;
}

/*
 * Expose
 */

module.exports = Miner;
