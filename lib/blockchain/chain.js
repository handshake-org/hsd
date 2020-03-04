/*!
 * chain.js - blockchain management for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const path = require('path');
const AsyncEmitter = require('bevent');
const Logger = require('blgr');
const {Lock} = require('bmutex');
const LRU = require('blru');
const {BufferMap, BufferSet} = require('buffer-map');
const Network = require('../protocol/network');
const ChainDB = require('./chaindb');
const common = require('./common');
const consensus = require('../protocol/consensus');
const rules = require('../covenants/rules');
const NameState = require('../covenants/namestate');
const util = require('../utils/util');
const ChainEntry = require('./chainentry');
const CoinView = require('../coins/coinview');
const Script = require('../script/script');
const {VerifyError} = require('../protocol/errors');
const {OwnershipProof} = require('../covenants/ownership');
const AirdropProof = require('../primitives/airdropproof');
const thresholdStates = common.thresholdStates;
const {states} = NameState;

/**
 * Blockchain
 * @alias module:blockchain.Chain
 * @property {ChainDB} db
 * @property {ChainEntry?} tip
 * @property {Number} height
 * @property {DeploymentState} state
 */

class Chain extends AsyncEmitter {
  /**
   * Create a blockchain.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.opened = false;
    this.options = new ChainOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context('chain');
    this.workers = this.options.workers;

    this.db = new ChainDB(this.options);

    this.locker = new Lock(true, BufferMap);
    this.invalid = new LRU(100, null, BufferMap);
    this.state = new DeploymentState(this.network.genesis.hash);

    this.tip = new ChainEntry();
    this.height = -1;
    this.synced = false;

    this.orphanMap = new BufferMap();
    this.orphanPrev = new BufferMap();
  }

  /**
   * Open the chain, wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'Chain is already open.');
    this.opened = true;

    this.logger.info('Chain is loading.');

    if (this.options.checkpoints)
      this.logger.info('Checkpoints are enabled.');

    await this.db.open();

    const tip = await this.db.getTip();

    assert(tip);

    this.tip = tip;
    this.height = tip.height;

    this.logger.info('Chain Height: %d', tip.height);

    this.logger.memory();

    const state = await this.getDeploymentState();

    this.setDeploymentState(state);

    if (!this.options.spv)
      await this.syncTree();

    this.logger.memory();

    this.emit('tip', tip);

    this.maybeSync();
  }

  /**
   * Close the chain, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'Chain is not open.');
    this.opened = false;
    return this.db.close();
  }

  /**
   * Sync tree state.
   */

  async syncTree() {
    const {treeInterval} = this.network.names;
    const last = this.height - (this.height % treeInterval);

    for (let height = last + 1; height <= this.height; height++) {
      const entry = await this.db.getEntryByHeight(height);
      assert(entry);

      const block = await this.db.getBlock(entry.hash);
      assert(block);

      const state = await this.readDeploymentState(entry);
      assert(state);

      const view = new CoinView();
      const hardened = state.hasHardening();

      for (const tx of block.txs)
        await this.verifyCovenants(tx, view, height, hardened);

      assert((height % this.network.names.treeInterval) !== 0);

      await this.db.saveNames(view, entry, false);
    }

    this.logger.info('Synchronized Tree Root: %x.', this.db.txn.rootHash());
  }

  /**
   * Perform all necessary contextual verification on a block.
   * @private
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise} - Returns {@link ContextResult}.
   */

  async verifyContext(block, prev, flags) {
    // Initial non-contextual verification.
    const state = await this.verify(block, prev, flags);

    // Skip everything if we're in SPV mode.
    if (this.options.spv) {
      const view = new CoinView();
      return [view, state];
    }

    // Skip everything if we're using checkpoints.
    if (this.isHistorical(prev)) {
      const view = await this.updateInputs(block, prev, state);
      return [view, state];
    }

    // Verify scripts, spend and add coins.
    const view = await this.verifyInputs(block, prev, state);

    return [view, state];
  }

  /**
   * Perform all necessary contextual verification
   * on a block, without POW check.
   * @param {Block} block
   * @returns {Promise}
   */

  async verifyBlock(block) {
    const unlock = await this.locker.lock();
    try {
      return await this._verifyBlock(block);
    } finally {
      unlock();
    }
  }

  /**
   * Perform all necessary contextual verification
   * on a block, without POW check (no lock).
   * @private
   * @param {Block} block
   * @returns {Promise}
   */

  async _verifyBlock(block) {
    const flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;
    return this.verifyContext(block, this.tip, flags);
  }

  /**
   * Test whether the hash is in the main chain.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  isMainHash(hash) {
    return this.db.isMainHash(hash);
  }

  /**
   * Test whether the entry is in the main chain.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns Boolean.
   */

  isMainChain(entry) {
    return this.db.isMainChain(entry);
  }

  /**
   * Get ancestor by `height`.
   * @param {ChainEntry} entry
   * @param {Number} height
   * @returns {Promise} - Returns ChainEntry.
   */

  getAncestor(entry, height) {
    return this.db.getAncestor(entry, height);
  }

  /**
   * Get previous entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getPrevious(entry) {
    return this.db.getPrevious(entry);
  }

  /**
   * Get previous cached entry.
   * @param {ChainEntry} entry
   * @returns {ChainEntry|null}
   */

  getPrevCache(entry) {
    return this.db.getPrevCache(entry);
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getNext(entry) {
    return this.db.getNext(entry);
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getNextEntry(entry) {
    return this.db.getNextEntry(entry);
  }

  /**
   * Calculate median time past.
   * @param {ChainEntry} prev
   * @returns {Promise} - Returns Number.
   */

  async getMedianTime(prev) {
    const timespan = consensus.MEDIAN_TIMESPAN;
    const median = [];

    let entry = prev;

    for (let i = 0; i < timespan && entry; i++) {
      median.push(entry.time);

      const cache = this.getPrevCache(entry);

      if (cache)
        entry = cache;
      else
        entry = await this.getPrevious(entry);
    }

    median.sort(cmp);

    return median[median.length >>> 1];
  }

  /**
   * Test whether the entry is potentially
   * an ancestor of a checkpoint.
   * @param {ChainEntry} prev
   * @returns {Boolean}
   */

  isHistorical(prev) {
    if (this.options.checkpoints) {
      if (prev.height + 1 <= this.network.lastCheckpoint)
        return true;
    }
    return false;
  }

  /**
   * Contextual verification for a block, including
   * version deployments (IsSuperMajority), versionbits,
   * coinbase height, finality checks.
   * @private
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async verify(block, prev, flags) {
    assert(typeof flags === 'number');

    // Extra sanity check.
    if (!block.prevBlock.equals(prev.hash))
      throw new VerifyError(block, 'invalid', 'bad-prevblk', 0);

    // Verify a checkpoint if there is one.
    const hash = block.hash();
    if (!this.verifyCheckpoint(prev, hash)) {
      throw new VerifyError(block,
        'checkpoint',
        'checkpoint mismatch',
        100);
    }

    // Skip everything when using checkpoints.
    // We can do this safely because every
    // block in between each checkpoint was
    // validated outside in the header chain.
    if (this.isHistorical(prev)) {
      // Check merkle root.
      if (flags & common.flags.VERIFY_BODY) {
        assert(typeof block.createMerkleRoot === 'function');

        const root = block.createMerkleRoot();

        if (!block.merkleRoot.equals(root)) {
          throw new VerifyError(block,
            'invalid',
            'bad-txnmrklroot',
            100,
            true);
        }

        const witnessRoot = block.createWitnessRoot();

        if (!block.witnessRoot.equals(witnessRoot)) {
          throw new VerifyError(block,
            'invalid',
            'bad-txnmrklroot',
            100,
            true);
        }

        flags &= ~common.flags.VERIFY_BODY;
      }
    }

    // Non-contextual checks.
    if (flags & common.flags.VERIFY_BODY) {
      const [valid, reason, score] = block.checkBody();

      if (!valid)
        throw new VerifyError(block, 'invalid', reason, score, true);
    }

    // Check name DoS limits.
    const set = new BufferSet();

    let opens = 0;
    let updates = 0;
    let renewals = 0;

    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      opens += rules.countOpens(tx);

      if (opens > consensus.MAX_BLOCK_OPENS) {
        throw new VerifyError(block,
          'invalid',
          'bad-blk-updates',
          100);
      }

      updates += rules.countUpdates(tx);

      if (updates > consensus.MAX_BLOCK_UPDATES) {
        throw new VerifyError(block,
          'invalid',
          'bad-blk-updates',
          100);
      }

      renewals += rules.countRenewals(tx);

      if (renewals > consensus.MAX_BLOCK_RENEWALS) {
        throw new VerifyError(block,
          'invalid',
          'bad-blk-updates',
          100);
      }

      if (rules.hasNames(tx, set)) {
        throw new VerifyError(block,
          'invalid',
          'bad-blk-updates',
          100);
      }

      rules.addNames(tx, set);
    }

    // Ensure the POW is what we expect.
    const bits = await this.getTarget(block.time, prev);

    if (block.bits !== bits) {
      this.logger.debug(
        'Bad diffbits: 0x%s != 0x%s',
        util.hex32(block.bits),
        util.hex32(bits));

      throw new VerifyError(block,
        'invalid',
        'bad-diffbits',
        100);
    }

    // Skip all blocks in spv mode once
    // we've verified the network target.
    if (this.options.spv)
      return this.state;

    // Ensure the timestamp is correct.
    const mtp = await this.getMedianTime(prev);

    if (block.time <= mtp) {
      throw new VerifyError(block,
        'invalid',
        'time-too-old',
        0);
    }

    // Check timestamp against adj-time+2hours.
    // If this fails we may be able to accept
    // the block later.
    if (block.time > this.network.now() + 2 * 60 * 60) {
      throw new VerifyError(block,
        'invalid',
        'time-too-new',
        0,
        true);
    }

    // Calculate height of current block.
    const height = prev.height + 1;

    // Get the new deployment state.
    const state = await this.getDeployments(block.time, prev);

    // Transactions must be finalized with
    // regards to nSequence and nLockTime.
    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      if (!tx.isFinal(height, mtp)) {
        throw new VerifyError(block,
          'invalid',
          'bad-txns-nonfinal',
          10);
      }
    }

    // Make sure the height contained
    // in the coinbase is correct.
    if (block.getCoinbaseHeight() !== height) {
      throw new VerifyError(block,
        'invalid',
        'bad-cb-height',
        100);
    }

    const cb = block.txs[0];

    for (let i = 1; i < cb.inputs.length; i++) {
      const {witness} = cb.inputs[i];

      if (witness.items.length !== 1) {
        throw new VerifyError(block,
          'invalid',
          'bad-witness-size',
          100);
      }

      if (i >= cb.outputs.length) {
        throw new VerifyError(block,
          'invalid',
          'bad-output',
          100);
      }

      const output = cb.outputs[i];

      // Airdrop proof.
      if (!output.covenant.isClaim()) {
        let proof;
        try {
          proof = AirdropProof.decode(witness.items[0]);
        } catch (e) {
          throw new VerifyError(block,
            'invalid',
            'bad-airdrop-format',
            100);
        }

        if (!proof.isSane()) {
          throw new VerifyError(block,
            'invalid',
            'bad-airdrop-sanity',
            100);
        }

        if (prev.height + 1 >= this.network.goosigStop) {
          const key = proof.getKey();

          if (!key) {
            throw new VerifyError(block,
              'invalid',
              'bad-airdrop-proof',
              100);
          }

          if (key.isGoo()) {
            throw new VerifyError(block,
              'invalid',
              'bad-goosig-disabled',
              100);
          }
        }

        // Note: GooSig RSA 1024 is possible to
        // crack as well, but in order to make
        // it safe we would need to include a
        // commitment to the key size (bad).
        // We may have to just disallow <2048
        // bit for mainnet.
        if (state.hasHardening()) {
          if (proof.isWeak()) {
            throw new VerifyError(block,
              'invalid',
              'bad-airdrop-sanity',
              10);
          }
        }

        continue;
      }

      // DNSSEC ownership proof.
      let proof;
      try {
        proof = OwnershipProof.decode(witness.items[0]);
      } catch (e) {
        throw new VerifyError(block,
          'invalid',
          'bad-dnssec-format',
          100);
      }

      // Verify times.
      if (!proof.verifyTimes(prev.time)) {
        throw new VerifyError(block,
          'invalid',
          'bad-dnssec-times',
          10);
      }
    }

    return state;
  }

  /**
   * Check all deployments on a chain.
   * @param {Number} time
   * @param {ChainEntry} prev
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async getDeployments(time, prev) {
    const deployments = this.network.deployments;
    const state = new DeploymentState(prev.hash);

    // Disable RSA-1024.
    if (await this.isActive(prev, deployments.hardening))
      state.hardening = true;

    return state;
  }

  /**
   * Set a new deployment state.
   * @param {DeploymentState} state
   */

  setDeploymentState(state) {
    if (this.options.checkpoints && this.height < this.network.lastCheckpoint) {
      this.state = state;
      return;
    }

    if (!this.state.hasHardening() && state.hasHardening())
      this.logger.warning('RSA hardening has been activated.');

    this.state = state;
  }

  /**
   * Spend and update inputs (checkpoints only).
   * @private
   * @param {Block} block
   * @param {ChainEntry} prev
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async updateInputs(block, prev, state) {
    const hardened = state.hasHardening();
    const view = new CoinView();
    const height = prev.height + 1;
    const cb = block.txs[0];

    assert(view.bits.spend(this.db.field, cb));

    view.addTX(cb, height);

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];

      assert(await view.spendInputs(this.db, tx),
        'BUG: Spent inputs in historical data!');

      await this.verifyCovenants(tx, view, height, hardened);

      view.addTX(tx, height);
    }

    return view;
  }

  /**
   * Check block transactions for all things pertaining
   * to inputs. This function is important because it is
   * what actually fills the coins into the block. This
   * function will check the block reward, the sigops,
   * the tx values, and execute and verify the scripts (it
   * will attempt to do this on the worker pool). If
   * `checkpoints` is enabled, it will skip verification
   * for historical data.
   * @private
   * @see TX#verifyInputs
   * @see TX#verify
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {DeploymentState} state
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async verifyInputs(block, prev, state) {
    const network = this.network;
    const hardened = state.hasHardening();
    const view = new CoinView();
    const height = prev.height + 1;
    const interval = network.halvingInterval;

    let sigops = 0;
    let reward = 0;

    // Check the name tree root.
    if (!block.treeRoot.equals(this.db.treeRoot())) {
      throw new VerifyError(block,
        'invalid',
        'bad-tree-root',
        100);
    }

    // Check all transactions
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      // Ensure tx is not double spending an output.
      if (i === 0) {
        if (!view.bits.spend(this.db.field, tx)) {
          throw new VerifyError(block,
            'invalid',
            'bad-txns-bits-missingorspent',
            100);
        }
      } else {
        if (!await view.spendInputs(this.db, tx)) {
          throw new VerifyError(block,
            'invalid',
            'bad-txns-inputs-missingorspent',
            100);
        }

        // Verify sequence locks.
        const valid = await this.verifyLocks(prev, tx, view, state.lockFlags);

        if (!valid) {
          throw new VerifyError(block,
            'invalid',
            'bad-txns-nonfinal',
            100);
        }
      }

      // Count sigops.
      sigops += tx.getSigops(view);

      if (sigops > consensus.MAX_BLOCK_SIGOPS) {
        throw new VerifyError(block,
          'invalid',
          'bad-blk-sigops',
          100);
      }

      // Contextual sanity checks.
      const [fee, reason, score] = tx.checkInputs(view, height, network);

      if (fee === -1) {
        throw new VerifyError(block,
          'invalid',
          reason,
          score);
      }

      reward += fee;

      if (reward > consensus.MAX_MONEY) {
        throw new VerifyError(block,
          'invalid',
          'bad-cb-amount',
          100);
      }

      // Verify covenants.
      await this.verifyCovenants(tx, view, height, hardened);

      // Add new coins.
      view.addTX(tx, height);
    }

    // Make sure the miner isn't trying to conjure more coins.
    reward += consensus.getReward(height, interval);

    if (block.getClaimed() > reward) {
      throw new VerifyError(block,
        'invalid',
        'bad-cb-amount',
        100);
    }

    // Push onto verification queue.
    const jobs = [];
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];
      jobs.push(tx.verifyAsync(view, state.flags, this.workers));
    }

    // Verify all txs in parallel.
    const results = await Promise.all(jobs);

    for (const result of results) {
      if (!result) {
        throw new VerifyError(block,
          'invalid',
          'mandatory-script-verify-flag-failed',
          100);
      }
    }

    return view;
  }

  /**
   * Get main chain height for hash.
   * @param {Hash} hash
   * @returns {Number}
   */

  async getMainHeight(hash) {
    const entry = await this.db.getEntry(hash);

    if (!entry)
      return -1;

    // Must be the current chain.
    if (!await this.db.isMainChain(entry))
      return -1;

    return entry.height;
  }

  /**
   * Verify a renewal.
   * @param {Hash} hash
   * @param {Number} height
   * @returns {Boolean}
   */

  async verifyRenewal(hash, height) {
    assert(Buffer.isBuffer(hash));
    assert((height >>> 0) === height);

    // Cannot renew yet.
    if (height < this.network.names.renewalMaturity)
      return true;

    // We require renewals to commit to a block
    // within the past 6 months, to prove that
    // the user still owns the key. This prevents
    // people from presigning thousands of years
    // worth of renewals. The block must be at
    // least 400 blocks back to prevent the
    // possibility of a reorg invalidating the
    // covenant.

    const entry = await this.db.getEntry(hash);

    if (!entry)
      return false;

    // Must be the current chain.
    if (!await this.db.isMainChain(entry))
      return false;

    // Make sure it's a mature block (unlikely to be reorgd).
    if (entry.height > height - this.network.names.renewalMaturity)
      return false;

    // Block committed to must be
    // no older than a 6 months.
    if (entry.height < height - this.network.names.renewalPeriod)
      return false;

    return true;
  }

  /**
   * Verify covenants.
   * @param {TX} tx
   * @param {CoinView} view
   * @param {Number} height
   * @param {Boolean} hardened
   */

  async verifyCovenants(tx, view, height, hardened) {
    assert(tx);
    assert(view instanceof CoinView);
    assert((height >>> 0) === height);
    assert(typeof hardened === 'boolean');

    const {types} = rules;
    const network = this.network;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (!covenant.isName())
        continue;

      const nameHash = covenant.getHash(0);
      const start = covenant.getU32(1);
      const ns = await view.getNameState(this.db, nameHash);

      if (ns.isNull()) {
        if (!covenant.isClaim() && !covenant.isOpen())
          throw new Error('Database inconsistency.');

        const name = covenant.get(2);
        ns.set(name, height);
      }

      // Check for name expiration/revocation.
      // Note that claimed names never expire
      // before the reservation period ends.
      // However, they _can_ be revoked.
      ns.maybeExpire(height, network);

      // Calculate the current state.
      const state = ns.state(height, network);

      // none -> claim
      if (covenant.isClaim()) {
        const flags = covenant.getU8(3);
        const weak = (flags & 1) !== 0;

        // Claims can be re-redeemed any time
        // before registration. This is required
        // in order for our emergency soft-forks
        // to truly behave as _soft_ forks. Once
        // re-redeemed, the locktime resets and
        // they re-enter the LOCKED state. Note
        // that a newer claim invalidates the
        // old output by committing to a higher
        // height (will fail with nonlocal).
        const valid = state === states.OPENING
                   || state === states.LOCKED
                   || (state === states.CLOSED && !ns.registered);

        if (!valid) {
          throw new VerifyError(tx,
            'invalid',
            'bad-claim-state',
            100);
        }

        // Can only claim reserved names.
        // Once a reserved name is revoked,
        // it is no longer claimable.
        if (ns.expired || !rules.isReserved(nameHash, height, network)) {
          throw new VerifyError(tx,
            'invalid',
            'bad-claim-notreserved',
            100);
        }

        // Once the fork is active, we reject
        // any weak algorithms (i.e. RSA-1024).
        // Any future emergency soft-forks should
        // also be included below this check.
        if (hardened && weak) {
          throw new VerifyError(tx,
            'invalid',
            'bad-claim-algorithm',
            100);
        }

        // Check commitment hash.
        const block = covenant.getHash(4);
        const claimed = await this.getMainHeight(block);

        // Implicitly checks for `-1`.
        if (claimed !== covenant.getU32(5)) {
          throw new VerifyError(tx,
            'invalid',
            'bad-claim-commit-height',
            100);
        }

        // Implicitly disallows the genesis block.
        if (claimed <= ns.claimed) {
          throw new VerifyError(tx,
            'invalid',
            'bad-claim-commit-hash',
            100);
        }

        ns.setHeight(height);
        ns.setRenewal(height);
        ns.setClaimed(claimed);
        ns.setValue(0);
        ns.setOwner(tx.outpoint(i));
        ns.setHighest(0);
        ns.setWeak(weak);

        continue;
      }

      assert(!tx.isCoinbase());

      // none/redeem/open -> open
      if (covenant.isOpen()) {
        if (state !== states.OPENING) {
          throw new VerifyError(tx,
            'invalid',
            'bad-open-state',
            100);
        }

        // Only one open transaction can ever exist.
        if (ns.height !== height) {
          throw new VerifyError(tx,
            'invalid',
            'bad-open-multiple',
            100);
        }

        // Cannot bid on a reserved name.
        if (!ns.expired && rules.isReserved(nameHash, height, network)) {
          throw new VerifyError(tx,
            'invalid',
            'bad-open-reserved',
            100);
        }

        // On mainnet, names are released on a
        // weekly basis for the first year.
        if (!rules.hasRollout(nameHash, height, network)) {
          throw new VerifyError(tx,
            'invalid',
            'bad-open-rollout',
            100);
        }

        continue;
      }

      // none/redeem/open -> bid
      if (covenant.isBid()) {
        if (state !== states.BIDDING) {
          throw new VerifyError(tx,
            'invalid',
            'bad-bid-state',
            100);
        }

        if (start !== ns.height) {
          throw new VerifyError(tx,
            'invalid',
            'bad-bid-height',
            100);
        }

        continue;
      }

      assert(i < tx.inputs.length);

      const {prevout} = tx.inputs[i];

      switch (covenant.type) {
        // bid -> reveal
        case types.REVEAL: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-reveal-nonlocal',
              100);
          }

          // Early reveals? No.
          if (state !== states.REVEAL) {
            throw new VerifyError(tx,
              'invalid',
              'bad-reveal-state',
              100);
          }

          if (ns.owner.isNull() || output.value > ns.highest) {
            ns.setValue(ns.highest);
            ns.setOwner(tx.outpoint(i));
            ns.setHighest(output.value);
          } else if (output.value > ns.value) {
            ns.setValue(output.value);
          }

          break;
        }

        // reveal -> redeem
        case types.REDEEM: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-redeem-nonlocal',
              100);
          }

          // Allow participants to get their
          // money out, even in a revoked state.
          if (state < states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-redeem-state',
              100);
          }

          // Must be the loser in order
          // to redeem the money now.
          if (prevout.equals(ns.owner)) {
            throw new VerifyError(tx,
              'invalid',
              'bad-redeem-owner',
              100);
          }

          break;
        }

        // claim/reveal -> register
        case types.REGISTER: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-register-nonlocal',
              100);
          }

          if (state !== states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-register-state',
              100);
          }

          const data = covenant.get(2);
          const hash = covenant.getHash(3);

          // Verify block hash for renewal.
          if (!await this.verifyRenewal(hash, height)) {
            throw new VerifyError(tx,
              'invalid',
              'bad-register-renewal',
              100);
          }

          // Must be the winner in
          // order to redeem the name.
          if (!prevout.equals(ns.owner)) {
            throw new VerifyError(tx,
              'invalid',
              'bad-register-owner',
              100);
          }

          // Must match the second highest bid.
          if (output.value !== ns.value) {
            throw new VerifyError(tx,
              'invalid',
              'bad-register-value',
              100);
          }

          // For claimed names: if the keys used in
          // the proof were somehow compromised, the
          // name becomes locked until the reservation
          // period ends. Note that this is the same
          // code path that can be used for emergency
          // soft-forks in the case that a large name
          // registrar's keys are compromised.
          if (ns.isClaimable(height, network)) {
            // Soft-fork #1 (RSA hardening).
            if (hardened && ns.weak) {
              throw new VerifyError(tx,
                'invalid',
                'bad-register-state',
                100);
            }

            // Emergency soft-forks go here.
            // Use only to prevent sky from falling.
            //
            // A vision for an emergency soft-fork:
            //
            // 1. A list of compromised DNSKEYs are collected
            //    out of band.
            // 2. The chain is scanned on first boot in order
            //    to find proofs which are vulnerable. The
            //    relevant names are marked as such.
            //    - Pruned nodes and nodes without witness
            //      data will unfortunately need to re-sync.
            // 3. Any proof published before the flag day
            //    is also marked in this way if it contains
            //    a vulnerable key.
            // 4. At soft-fork activation, the "vulnerable"
            //    check will take place here. This function
            //    should return true for any name that was
            //    redeemed with a vulnerable key.
            //
            // To future generations:
            // PUT THE VULNERABLE KEY CHECK HERE!
          }

          ns.setRegistered(true);
          ns.setOwner(tx.outpoint(i));

          if (data.length > 0)
            ns.setData(data);

          ns.setRenewal(height);

          break;
        }

        // update/renew/register/finalize -> update
        case types.UPDATE: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-update-nonlocal',
              100);
          }

          if (state !== states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-update-state',
              100);
          }

          const data = covenant.get(2);

          ns.setOwner(tx.outpoint(i));

          if (data.length > 0)
            ns.setData(data);

          ns.setTransfer(0);

          break;
        }

        // update/renew/register/finalize -> renew
        case types.RENEW: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-renewal-nonlocal',
              100);
          }

          if (state !== states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-renewal-state',
              100);
          }

          const hash = covenant.getHash(2);

          if (height < ns.renewal + network.names.treeInterval) {
            throw new VerifyError(tx,
              'invalid',
              'bad-renewal-premature',
              100);
          }

          if (!await this.verifyRenewal(hash, height)) {
            throw new VerifyError(tx,
              'invalid',
              'bad-renewal',
              100);
          }

          ns.setOwner(tx.outpoint(i));
          ns.setTransfer(0);
          ns.setRenewal(height);
          ns.setRenewals(ns.renewals + 1);

          break;
        }

        // update/renew/register/finalize -> transfer
        case types.TRANSFER: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-transfer-nonlocal',
              100);
          }

          if (state !== states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-transfer-state',
              100);
          }

          ns.setOwner(tx.outpoint(i));

          assert(ns.transfer === 0);
          ns.setTransfer(height);

          break;
        }

        // transfer -> finalize
        case types.FINALIZE: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-finalize-nonlocal',
              100);
          }

          if (state !== states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-finalize-state',
              100);
          }

          assert(ns.transfer !== 0);
          assert(network.names.transferLockup >= network.names.treeInterval);

          if (height < ns.transfer + network.names.transferLockup) {
            throw new VerifyError(tx,
              'invalid',
              'bad-finalize-maturity',
              100);
          }

          const flags = covenant.getU8(3);
          const weak = (flags & 1) !== 0;
          const claimed = covenant.getU32(4);
          const renewals = covenant.getU32(5);
          const hash = covenant.getHash(6);

          if (weak !== ns.weak
              || claimed !== ns.claimed
              || renewals !== ns.renewals) {
            throw new VerifyError(tx,
              'invalid',
              'bad-finalize-statetransfer',
              100);
          }

          if (!await this.verifyRenewal(hash, height)) {
            throw new VerifyError(tx,
              'invalid',
              'bad-finalize-renewal',
              100);
          }

          ns.setOwner(tx.outpoint(i));
          ns.setTransfer(0);
          ns.setRenewal(height);
          ns.setRenewals(ns.renewals + 1);

          break;
        }

        // register/update/renew/transfer/finalize -> revoke
        case types.REVOKE: {
          if (start !== ns.height) {
            throw new VerifyError(tx,
              'invalid',
              'bad-revoke-nonlocal',
              100);
          }

          if (state !== states.CLOSED) {
            throw new VerifyError(tx,
              'invalid',
              'bad-revoke-state',
              100);
          }

          assert(ns.revoked === 0);
          ns.setRevoked(height);
          ns.setTransfer(0);
          ns.setData(null);

          break;
        }

        default: {
          assert.fail('Invalid covenant type.');
          break;
        }
      }
    }

    return;
  }

  /**
   * Find the block at which a fork ocurred.
   * @private
   * @param {ChainEntry} fork - The current chain.
   * @param {ChainEntry} longer - The competing chain.
   * @returns {Promise}
   */

  async findFork(fork, longer) {
    while (!fork.hash.equals(longer.hash)) {
      while (longer.height > fork.height) {
        longer = await this.getPrevious(longer);
        if (!longer)
          throw new Error('No previous entry for new tip.');
      }

      if (fork.hash.equals(longer.hash))
        return fork;

      fork = await this.getPrevious(fork);

      if (!fork)
        throw new Error('No previous entry for old tip.');
    }

    return fork;
  }

  /**
   * Reorganize the blockchain (connect and disconnect inputs).
   * Called when a competing chain with a higher chainwork
   * is received.
   * @private
   * @param {ChainEntry} competitor - The competing chain's tip.
   * @returns {Promise}
   */

  async reorganize(competitor) {
    const tip = this.tip;
    const fork = await this.findFork(tip, competitor);

    assert(fork, 'No free space or data corruption.');

    // Blocks to disconnect.
    const disconnect = [];
    let entry = tip;
    while (!entry.hash.equals(fork.hash)) {
      disconnect.push(entry);
      entry = await this.getPrevious(entry);
      assert(entry);
    }

    // Blocks to connect.
    const connect = [];
    entry = competitor;
    while (!entry.hash.equals(fork.hash)) {
      connect.push(entry);
      entry = await this.getPrevious(entry);
      assert(entry);
    }

    // Disconnect blocks/txs.
    for (let i = 0; i < disconnect.length; i++) {
      const entry = disconnect[i];
      await this.disconnect(entry);
    }

    // Connect blocks/txs.
    // We don't want to connect the new tip here.
    // That will be done outside in setBestChain.
    for (let i = connect.length - 1; i >= 1; i--) {
      const entry = connect[i];
      await this.reconnect(entry);
    }

    this.logger.warning(
      'Chain reorganization: old=%x(%d) new=%x(%d)',
      tip.hash,
      tip.height,
      competitor.hash,
      competitor.height
    );

    await this.emitAsync('reorganize', tip, competitor);
  }

  /**
   * Reorganize the blockchain for SPV. This
   * will reset the chain to the fork block.
   * @private
   * @param {ChainEntry} competitor - The competing chain's tip.
   * @returns {Promise}
   */

  async reorganizeSPV(competitor) {
    const tip = this.tip;
    const fork = await this.findFork(tip, competitor);

    assert(fork, 'No free space or data corruption.');

    // Buffer disconnected blocks.
    const disconnect = [];
    let entry = tip;
    while (!entry.hash.equals(fork.hash)) {
      disconnect.push(entry);
      entry = await this.getPrevious(entry);
      assert(entry);
    }

    // Reset the main chain back
    // to the fork block, causing
    // us to redownload the blocks
    // on the new main chain.
    await this._reset(fork.hash, true);

    // Emit disconnection events now that
    // the chain has successfully reset.
    for (const entry of disconnect) {
      const headers = entry.toHeaders();
      const view = new CoinView();
      await this.emitAsync('disconnect', entry, headers, view);
    }

    this.logger.warning(
      'SPV reorganization: old=%x(%d) new=%x(%d)',
      tip.hash,
      tip.height,
      competitor.hash,
      competitor.height
    );

    this.logger.warning(
      'Chain replay from height %d necessary.',
      fork.height);

    return this.emitAsync('reorganize', tip, competitor);
  }

  /**
   * Disconnect an entry from the chain (updates the tip).
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async disconnect(entry) {
    let block = await this.getBlock(entry.hash);

    if (!block) {
      if (!this.options.spv)
        throw new Error('Block not found.');
      block = entry.toHeaders();
    }

    const prev = await this.getPrevious(entry);
    const view = await this.db.disconnect(entry, block);

    assert(prev);

    this.tip = prev;
    this.height = prev.height;

    this.emit('tip', prev);

    return this.emitAsync('disconnect', entry, block, view);
  }

  /**
   * Reconnect an entry to the chain (updates the tip).
   * This will do contextual-verification on the block
   * (necessary because we cannot validate the inputs
   * in alternate chains when they come in).
   * @param {ChainEntry} entry
   * @param {Number} flags
   * @returns {Promise}
   */

  async reconnect(entry) {
    const flags = common.flags.VERIFY_NONE;

    let block = await this.getBlock(entry.hash);

    if (!block) {
      if (!this.options.spv)
        throw new Error('Block not found.');
      block = entry.toHeaders();
    }

    const prev = await this.getPrevious(entry);
    assert(prev);

    let view, state;
    try {
      [view, state] = await this.verifyContext(block, prev, flags);
    } catch (err) {
      if (err.type === 'VerifyError') {
        if (!err.malleated)
          this.setInvalid(entry.hash);
        this.logger.warning(
          'Tried to reconnect invalid block: %x (%d).',
          entry.hash, entry.height);
      }
      throw err;
    }

    await this.db.reconnect(entry, block, view);

    this.tip = entry;
    this.height = entry.height;
    this.setDeploymentState(state);

    this.emit('tip', entry);
    this.emit('reconnect', entry, block);

    return this.emitAsync('connect', entry, block, view);
  }

  /**
   * Set the best chain. This is called on every valid block
   * that comes in. It may add and connect the block (main chain),
   * save the block without connection (alternate chain), or
   * reorganize the chain (a higher fork).
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise}
   */

  async setBestChain(entry, block, prev, flags) {
    // A higher fork has arrived.
    // Time to reorganize the chain.
    if (!entry.prevBlock.equals(this.tip.hash)) {
      this.logger.warning('WARNING: Reorganizing chain.');

      // In spv-mode, we reset the
      // chain and redownload the blocks.
      if (this.options.spv)
        return this.reorganizeSPV(entry);

      await this.reorganize(entry);
    }

    // Warn of unknown versionbits.
    if (entry.hasUnknown(this.network)) {
      this.logger.warning(
        'Unknown version bits in block %d: %s.',
        entry.height, util.hex32(entry.version));
    }

    // Otherwise, everything is in order.
    // Do "contextual" verification on our block
    // now that we're certain its previous
    // block is in the chain.
    let view, state;
    try {
      [view, state] = await this.verifyContext(block, prev, flags);
    } catch (err) {
      if (err.type === 'VerifyError') {
        if (!err.malleated)
          this.setInvalid(entry.hash);
        this.logger.warning(
          'Tried to connect invalid block: %x (%d).',
          entry.hash, entry.height);
      }
      throw err;
    }

    // Save block and connect inputs.
    await this.db.save(entry, block, view);

    // Expose the new state.
    this.tip = entry;
    this.height = entry.height;
    this.setDeploymentState(state);

    this.emit('tip', entry);
    this.emit('block', block, entry);

    return this.emitAsync('connect', entry, block, view);
  }

  /**
   * Save block on an alternate chain.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {ChainEntry} prev
   * @param {Number} flags
   * @returns {Promise}
   */

  async saveAlternate(entry, block, prev, flags) {
    // Do not accept forked chain older than the
    // last checkpoint.
    if (this.options.checkpoints) {
      if (prev.height + 1 < this.network.lastCheckpoint)
        throw new VerifyError(block,
          'checkpoint',
          'bad-fork-prior-to-checkpoint',
          100);
    }

    try {
      // Do as much verification
      // as we can before saving.
      await this.verify(block, prev, flags);
    } catch (err) {
      if (err.type === 'VerifyError') {
        if (!err.malleated)
          this.setInvalid(entry.hash);
        this.logger.warning(
          'Invalid block on alternate chain: %x (%d).',
          entry.hash, entry.height);
      }
      throw err;
    }

    // Warn of unknown versionbits.
    if (entry.hasUnknown(this.network)) {
      this.logger.warning(
        'Unknown version bits in block %d: %s.',
        entry.height, util.hex32(entry.version));
    }

    await this.db.save(entry, block);

    this.logger.warning('Heads up: Competing chain at height %d:'
      + ' tip-height=%d competitor-height=%d'
      + ' tip-hash=%x competitor-hash=%x'
      + ' tip-chainwork=%s competitor-chainwork=%s'
      + ' chainwork-diff=%s',
      entry.height,
      this.tip.height,
      entry.height,
      this.tip.hash,
      entry.hash,
      this.tip.chainwork.toString(),
      entry.chainwork.toString(),
      this.tip.chainwork.sub(entry.chainwork).toString());

    // Emit as a "competitor" block.
    this.emit('competitor', block, entry);
  }

  /**
   * Reset the chain to the desired block. This
   * is useful for replaying the blockchain download
   * for SPV.
   * @param {Hash|Number} block
   * @returns {Promise}
   */

  async reset(block) {
    const unlock = await this.locker.lock();
    try {
      return await this._reset(block, false);
    } finally {
      unlock();
    }
  }

  /**
   * Reset the chain to the desired block without a lock.
   * @private
   * @param {Hash|Number} block
   * @returns {Promise}
   */

  async _reset(block, silent) {
    const tip = await this.db.reset(block);

    // Reset state.
    this.tip = tip;
    this.height = tip.height;
    this.synced = false;

    const state = await this.getDeploymentState();

    this.setDeploymentState(state);

    this.emit('tip', tip);

    if (!silent)
      await this.emitAsync('reset', tip);

    // Reset the orphan map completely. There may
    // have been some orphans on a forked chain we
    // no longer need.
    this.purgeOrphans();

    this.maybeSync();
  }

  /**
   * Reset the chain to a height or hash. Useful for replaying
   * the blockchain download for SPV.
   * @param {Hash|Number} block - hash/height
   * @returns {Promise}
   */

  async replay(block) {
    const unlock = await this.locker.lock();
    try {
      return await this._replay(block, true);
    } finally {
      unlock();
    }
  }

  /**
   * Reset the chain without a lock.
   * @private
   * @param {Hash|Number} block - hash/height
   * @param {Boolean?} silent
   * @returns {Promise}
   */

  async _replay(block, silent) {
    const entry = await this.getEntry(block);

    if (!entry)
      throw new Error('Block not found.');

    if (!await this.isMainChain(entry))
      throw new Error('Cannot reset on alternate chain.');

    if (entry.isGenesis()) {
      await this._reset(entry.hash, silent);
      return;
    }

    await this._reset(entry.prevBlock, silent);
  }

  /**
   * Invalidate block.
   * @param {Hash} hash
   * @returns {Promise}
   */

  async invalidate(hash) {
    const unlock = await this.locker.lock();
    try {
      return await this._invalidate(hash);
    } finally {
      unlock();
    }
  }

  /**
   * Invalidate block (no lock).
   * @param {Hash} hash
   * @returns {Promise}
   */

  async _invalidate(hash) {
    await this._replay(hash, false);
    this.setInvalid(hash);
  }

  /**
   * Retroactively prune the database.
   * @returns {Promise}
   */

  async prune() {
    const unlock = await this.locker.lock();
    try {
      return await this.db.prune();
    } finally {
      unlock();
    }
  }

  /**
   * Scan the blockchain for transactions containing specified address hashes.
   * @param {Hash} start - Block hash to start at.
   * @param {Bloom} filter - Bloom filter containing tx and address hashes.
   * @param {Function} iter - Iterator.
   * @returns {Promise}
   */

  async scan(start, filter, iter) {
    const unlock = await this.locker.lock();
    try {
      return await this.db.scan(start, filter, iter);
    } finally {
      unlock();
    }
  }

  /**
   * Add a block to the chain, perform all necessary verification.
   * @param {Block} block
   * @param {Number?} flags
   * @param {Number?} id
   * @returns {Promise}
   */

  async add(block, flags, id) {
    const hash = block.hash();
    const unlock = await this.locker.lock(hash);
    try {
      return await this._add(block, flags, id);
    } finally {
      unlock();
    }
  }

  /**
   * Add a block to the chain without a lock.
   * @private
   * @param {Block} block
   * @param {Number?} flags
   * @param {Number?} id
   * @returns {Promise}
   */

  async _add(block, flags, id) {
    const hash = block.hash();

    if (flags == null)
      flags = common.flags.DEFAULT_FLAGS;

    if (id == null)
      id = -1;

    // Special case for genesis block.
    if (hash.equals(this.network.genesis.hash)) {
      this.logger.debug('Saw genesis block: %x.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // Do we already have this block in the queue?
    if (this.hasPending(hash)) {
      this.logger.debug('Already have pending block: %x.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // If the block is already known to be
    // an orphan, ignore it.
    if (this.hasOrphan(hash)) {
      this.logger.debug('Already have orphan block: %x.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // Do not revalidate known invalid blocks.
    if (this.hasInvalid(block)) {
      this.logger.debug('Invalid ancestors for block: %x.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 100);
    }

    // Check the POW before doing anything.
    if (flags & common.flags.VERIFY_POW) {
      if (!block.verifyPOW())
        throw new VerifyError(block, 'invalid', 'high-hash', 50);
    }

    // Do we already have this block?
    if (await this.hasEntry(hash)) {
      this.logger.debug('Already have block: %x.', block.hash());
      throw new VerifyError(block, 'duplicate', 'duplicate', 0);
    }

    // Find the previous block entry.
    const prev = await this.getEntry(block.prevBlock);

    // If previous block wasn't ever seen,
    // add it current to orphans and return.
    if (!prev) {
      this.storeOrphan(block, flags, id);
      return null;
    }

    // Connect the block.
    const entry = await this.connect(prev, block, flags);

    // Handle any orphans.
    if (this.hasNextOrphan(hash))
      await this.handleOrphans(entry);

    return entry;
  }

  /**
   * Connect block to chain.
   * @private
   * @param {ChainEntry} prev
   * @param {Block} block
   * @param {Number} flags
   * @returns {Promise}
   */

  async connect(prev, block, flags) {
    const start = util.bench();

    // Sanity check.
    assert(block.prevBlock.equals(prev.hash));

    // Explanation: we try to keep as much data
    // off the javascript heap as possible. Blocks
    // in the future may be 8mb or 20mb, who knows.
    // In fullnode-mode we store the blocks in
    // "compact" form (the headers plus the raw
    // Buffer object) until they're ready to be
    // fully validated here. They are deserialized,
    // validated, and connected. Hopefully the
    // deserialized blocks get cleaned up by the
    // GC quickly.
    if (block.isMemory()) {
      try {
        block = block.toBlock();
      } catch (e) {
        this.logger.error(e);
        throw new VerifyError(block,
          'malformed',
          'error parsing message',
          10,
          true);
      }
    }

    // Transactions are not allowed in any block before
    // a certain amount of chainwork has been accumulated.
    // This is a non-malleated, permanently invalid block
    // and whoever sent it should be banned.
    if (prev.height + 1 < this.network.txStart) {
      let invalid = false;

      // No transactions allowed besides coinbase
      if (block.txs.length > 1)
        invalid = true;

      if (!this.options.spv) {
        // No claims or airdrops allowed in coinbase yet.
        const cb = block.txs[0];
        if (cb.outputs.length > 1)
          invalid = true;

        // Sanity check
        if (!cb.outputs[0].covenant.isNone())
          invalid = true;
      }

      if (invalid) {
        this.setInvalid(block.hash());
        throw new VerifyError(block,
          'invalid',
          'no-tx-allowed-yet',
          100,
          false);
      }
    }

    // Create a new chain entry.
    const entry = ChainEntry.fromBlock(block, prev);

    // The block is on a alternate chain if the
    // chainwork is less than or equal to
    // our tip's. Add the block but do _not_
    // connect the inputs.
    if (entry.chainwork.lte(this.tip.chainwork)) {
      // Save block to an alternate chain.
      await this.saveAlternate(entry, block, prev, flags);
    } else {
      // Attempt to add block to the chain index.
      await this.setBestChain(entry, block, prev, flags);
    }

    // Keep track of stats.
    this.logStatus(start, block, entry);

    // Check sync state.
    this.maybeSync();

    return entry;
  }

  /**
   * Handle orphans.
   * @private
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async handleOrphans(entry) {
    let orphan = this.resolveOrphan(entry.hash);

    while (orphan) {
      const {block, flags, id} = orphan;

      try {
        entry = await this.connect(entry, block, flags);
      } catch (err) {
        if (err.type === 'VerifyError') {
          this.logger.warning(
            'Could not resolve orphan block %x: %s.',
            block.hash(), err.message);

          this.emit('bad orphan', err, id);

          break;
        }
        throw err;
      }

      this.logger.debug(
        'Orphan block was resolved: %x (%d).',
        block.hash(), entry.height);

      this.emit('resolved', block, entry);

      orphan = this.resolveOrphan(entry.hash);
    }
  }

  /**
   * Test whether the chain has reached its slow height.
   * @private
   * @returns {Boolean}
   */

  isSlow() {
    if (this.options.spv)
      return false;

    if (this.synced)
      return true;

    if (this.height === 1 || this.height % 20 === 0)
      return true;

    if (this.height >= this.network.block.slowHeight)
      return true;

    return false;
  }

  /**
   * Calculate the time difference from
   * start time and log block.
   * @private
   * @param {Array} start
   * @param {Block} block
   * @param {ChainEntry} entry
   */

  logStatus(start, block, entry) {
    if (!this.isSlow())
      return;

    // Report memory for debugging.
    this.logger.memory();

    const elapsed = util.bench(start);

    this.logger.info(
      'Block %x (%d) added to chain (size=%d txs=%d time=%d).',
      entry.hash,
      entry.height,
      block.getSize(),
      block.txs.length,
      elapsed);
  }

  /**
   * Verify a block hash and height against the checkpoints.
   * @private
   * @param {ChainEntry} prev
   * @param {Hash} hash
   * @returns {Boolean}
   */

  verifyCheckpoint(prev, hash) {
    if (!this.options.checkpoints)
      return true;

    const height = prev.height + 1;
    const checkpoint = this.network.checkpointMap[height];

    if (!checkpoint)
      return true;

    if (hash.equals(checkpoint)) {
      this.logger.debug('Hit checkpoint block %x (%d).', hash, height);
      this.emit('checkpoint', hash, height);
      return true;
    }

    // Someone is either mining on top of
    // an old block for no reason, or the
    // consensus protocol is broken and
    // there was a 20k+ block reorg.
    this.logger.warning(
      'Checkpoint mismatch at height %d: expected=%x received=%x',
      height,
      checkpoint,
      hash
    );

    this.purgeOrphans();

    return false;
  }

  /**
   * Store an orphan.
   * @private
   * @param {Block} block
   * @param {Number?} flags
   * @param {Number?} id
   */

  storeOrphan(block, flags, id) {
    const height = block.getCoinbaseHeight();
    const orphan = this.orphanPrev.get(block.prevBlock);

    // The orphan chain forked.
    if (orphan) {
      assert(!orphan.block.hash().equals(block.hash()));
      assert(orphan.block.prevBlock.equals(block.prevBlock));

      this.logger.warning(
        'Removing forked orphan block: %x (%d).',
        orphan.block.hash(), height);

      this.removeOrphan(orphan);
    }

    this.limitOrphans();
    this.addOrphan(new Orphan(block, flags, id));

    this.logger.debug(
      'Storing orphan block: %x (%d).',
      block.hash(), height);

    this.emit('orphan', block);
  }

  /**
   * Add an orphan.
   * @private
   * @param {Orphan} orphan
   * @returns {Orphan}
   */

  addOrphan(orphan) {
    const block = orphan.block;
    const hash = block.hash();

    assert(!this.orphanMap.has(hash));
    assert(!this.orphanPrev.has(block.prevBlock));
    assert(this.orphanMap.size >= 0);

    this.orphanMap.set(hash, orphan);
    this.orphanPrev.set(block.prevBlock, orphan);

    return orphan;
  }

  /**
   * Remove an orphan.
   * @private
   * @param {Orphan} orphan
   * @returns {Orphan}
   */

  removeOrphan(orphan) {
    const block = orphan.block;
    const hash = block.hash();

    assert(this.orphanMap.has(hash));
    assert(this.orphanPrev.has(block.prevBlock));
    assert(this.orphanMap.size > 0);

    this.orphanMap.delete(hash);
    this.orphanPrev.delete(block.prevBlock);

    return orphan;
  }

  /**
   * Test whether a hash would resolve the next orphan.
   * @private
   * @param {Hash} hash - Previous block hash.
   * @returns {Boolean}
   */

  hasNextOrphan(hash) {
    return this.orphanPrev.has(hash);
  }

  /**
   * Resolve an orphan.
   * @private
   * @param {Hash} hash - Previous block hash.
   * @returns {Orphan}
   */

  resolveOrphan(hash) {
    const orphan = this.orphanPrev.get(hash);

    if (!orphan)
      return null;

    return this.removeOrphan(orphan);
  }

  /**
   * Purge any waiting orphans.
   */

  purgeOrphans() {
    const count = this.orphanMap.size;

    if (count === 0)
      return;

    this.orphanMap.clear();
    this.orphanPrev.clear();

    this.logger.debug('Purged %d orphans.', count);
  }

  /**
   * Prune orphans, only keep the orphan with the highest
   * coinbase height (likely to be the peer's tip).
   */

  limitOrphans() {
    const now = util.now();

    let oldest = null;
    for (const orphan of this.orphanMap.values()) {
      if (now < orphan.time + 60 * 60) {
        if (!oldest || orphan.time < oldest.time)
          oldest = orphan;
        continue;
      }

      this.removeOrphan(orphan);
    }

    if (this.orphanMap.size < this.options.maxOrphans)
      return;

    if (!oldest)
      return;

    this.removeOrphan(oldest);
  }

  /**
   * Test whether an invalid block hash has been seen.
   * @private
   * @param {Block} block
   * @returns {Boolean}
   */

  hasInvalid(block) {
    const hash = block.hash();

    if (this.invalid.has(hash))
      return true;

    if (this.invalid.has(block.prevBlock)) {
      this.setInvalid(hash);
      return true;
    }

    return false;
  }

  /**
   * Mark a block as invalid.
   * @private
   * @param {Hash} hash
   */

  setInvalid(hash) {
    this.invalid.set(hash, true);
  }

  /**
   * Forget an invalid block hash.
   * @private
   * @param {Hash} hash
   */

  removeInvalid(hash) {
    this.invalid.remove(hash);
  }

  /**
   * Test the chain to see if it contains
   * a block, or has recently seen a block.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async has(hash) {
    if (this.hasOrphan(hash))
      return true;

    if (this.locker.has(hash))
      return true;

    if (this.invalid.has(hash))
      return true;

    return this.hasEntry(hash);
  }

  /**
   * Find the corresponding block entry by hash or height.
   * @param {Hash|Number} hash/height
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntry(hash) {
    return this.db.getEntry(hash);
  }

  /**
   * Retrieve a chain entry by height.
   * @param {Number} height
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntryByHeight(height) {
    return this.db.getEntryByHeight(height);
  }

  /**
   * Retrieve a chain entry by hash.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntryByHash(hash) {
    return this.db.getEntryByHash(hash);
  }

  /**
   * Get the hash of a block by height. Note that this
   * will only return hashes in the main chain.
   * @param {Number} height
   * @returns {Promise} - Returns {@link Hash}.
   */

  getHash(height) {
    return this.db.getHash(height);
  }

  /**
   * Get the height of a block by hash.
   * @param {Hash} hash
   * @returns {Promise} - Returns Number.
   */

  getHeight(hash) {
    return this.db.getHeight(hash);
  }

  /**
   * Test the chain to see if it contains a block.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasEntry(hash) {
    return this.db.hasEntry(hash);
  }

  /**
   * Get the _next_ block hash (does not work by height).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Hash}.
   */

  getNextHash(hash) {
    return this.db.getNextHash(hash);
  }

  /**
   * Check whether coins are still unspent.
   * @param {TX} tx
   * @returns {Promise} - Returns Boolean.
   */

  hasCoins(tx) {
    return this.db.hasCoins(tx);
  }

  /**
   * Get all tip hashes.
   * @returns {Promise} - Returns {@link Hash}[].
   */

  getTips() {
    return this.db.getTips();
  }

  /**
   * Get range of hashes.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise}
   */

  getHashes(start = -1, end = -1) {
    return this.db.getHashes(start, end);
  }

  /**
   * Get a coin (unspents only).
   * @private
   * @param {Outpoint} prevout
   * @returns {Promise} - Returns {@link CoinEntry}.
   */

  readCoin(prevout) {
    return this.db.readCoin(prevout);
  }

  /**
   * Get a coin (unspents only).
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {@link Coin}.
   */

  getCoin(hash, index) {
    return this.db.getCoin(hash, index);
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  getBlock(hash) {
    return this.db.getBlock(hash);
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  getRawBlock(block) {
    return this.db.getRawBlock(block);
  }

  /**
   * Get a historical block coin viewpoint.
   * @param {Block} hash
   * @returns {Promise} - Returns {@link CoinView}.
   */

  getBlockView(block) {
    return this.db.getBlockView(block);
  }

  /**
   * Get a transaction with metadata.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TXMeta}.
   */

  getMeta(hash) {
    return this.db.getMeta(hash);
  }

  /**
   * Retrieve a transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TX}.
   */

  getTX(hash) {
    return this.db.getTX(hash);
  }

  /**
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasTX(hash) {
    return this.db.hasTX(hash);
  }

  /**
   * Get all coins pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link Coin}[].
   */

  getCoinsByAddress(addrs) {
    return this.db.getCoinsByAddress(addrs);
  }

  /**
   * Get all transaction hashes to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link Hash}[].
   */

  getHashesByAddress(addrs) {
    return this.db.getHashesByAddress(addrs);
  }

  /**
   * Get all transactions pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link TX}[].
   */

  getTXByAddress(addrs) {
    return this.db.getTXByAddress(addrs);
  }

  /**
   * Get all transactions pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link TXMeta}[].
   */

  getMetaByAddress(addrs) {
    return this.db.getMetaByAddress(addrs);
  }

  /**
   * Get an orphan block.
   * @param {Hash} hash
   * @returns {Block}
   */

  getOrphan(hash) {
    return this.orphanMap.get(hash) || null;
  }

  /**
   * Test the chain to see if it contains an orphan.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasOrphan(hash) {
    return this.orphanMap.has(hash);
  }

  /**
   * Test the chain to see if it contains a pending block in its queue.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  hasPending(hash) {
    return this.locker.pending(hash);
  }

  /**
   * Get coin viewpoint.
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  getCoinView(tx) {
    return this.db.getCoinView(tx);
  }

  /**
   * Get coin viewpoint (spent).
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getSpentView(tx) {
    const unlock = await this.locker.lock();
    try {
      return await this.db.getSpentView(tx);
    } finally {
      unlock();
    }
  }

  /**
   * Test the chain to see if it is synced.
   * @returns {Boolean}
   */

  isFull() {
    return this.synced;
  }

  /**
   * Potentially emit a `full` event.
   * @private
   */

  maybeSync() {
    if (this.synced)
      return;

    if (this.options.checkpoints) {
      if (this.height < this.network.lastCheckpoint)
        return;
    }

    if (!this.hasChainwork())
      return;

    if (this.tip.time < this.network.now() - this.network.block.maxTipAge)
      return;

    this.synced = true;
    this.emit('full');
  }

  /**
   * Test the chain to see if it has the
   * minimum required chainwork for the
   * network.
   * @returns {Boolean}
   */

  hasChainwork() {
    return this.tip.chainwork.gte(this.network.pow.chainwork);
  }

  /**
   * Get the fill percentage.
   * @returns {Number} percent - Ranges from 0.0 to 1.0.
   */

  getProgress() {
    const start = this.network.genesis.time;
    const current = this.tip.time - start;
    const end = this.network.now() - start - 40 * 60;
    return Math.min(1, current / end);
  }

  /**
   * Calculate chain locator (an array of hashes).
   * @param {Hash?} start - Height or hash to treat as the tip.
   * The current tip will be used if not present. Note that this can be a
   * non-existent hash, which is useful for headers-first locators.
   * @returns {Promise} - Returns {@link Hash}[].
   */

  async getLocator(start) {
    const unlock = await this.locker.lock();
    try {
      return await this._getLocator(start);
    } finally {
      unlock();
    }
  }

  /**
   * Calculate chain locator without a lock.
   * @private
   * @param {Hash?} start
   * @returns {Promise}
   */

  async _getLocator(start) {
    if (start == null)
      start = this.tip.hash;

    assert(Buffer.isBuffer(start));

    let entry = await this.getEntry(start);

    const hashes = [];

    if (!entry) {
      entry = this.tip;
      hashes.push(start);
    }

    let main = await this.isMainChain(entry);
    let hash = entry.hash;
    let height = entry.height;
    let step = 1;

    hashes.push(hash);

    while (height > 0) {
      height -= step;

      if (height < 0)
        height = 0;

      if (hashes.length > 10)
        step *= 2;

      if (main) {
        // If we're on the main chain, we can
        // do a fast lookup of the hash.
        hash = await this.getHash(height);
        assert(hash);
      } else {
        const ancestor = await this.getAncestor(entry, height);
        assert(ancestor);
        main = await this.isMainChain(ancestor);
        hash = ancestor.hash;
      }

      hashes.push(hash);
    }

    return hashes;
  }

  /**
   * Calculate the orphan root of the hash (if it is an orphan).
   * @param {Hash} hash
   * @returns {Hash}
   */

  getOrphanRoot(hash) {
    let root = null;

    assert(hash);

    for (;;) {
      const orphan = this.orphanMap.get(hash);

      if (!orphan)
        break;

      root = hash;
      hash = orphan.block.prevBlock;
    }

    return root;
  }

  /**
   * Calculate the time difference (in seconds)
   * between two blocks by examining chainworks.
   * @param {ChainEntry} to
   * @param {ChainEntry} from
   * @returns {Number}
   */

  getProofTime(to, from) {
    const pow = this.network.pow;
    let sign, work;

    if (to.chainwork.gt(from.chainwork)) {
      work = to.chainwork.sub(from.chainwork);
      sign = 1;
    } else {
      work = from.chainwork.sub(to.chainwork);
      sign = -1;
    }

    work = work.imuln(pow.targetSpacing);
    work = work.div(this.tip.getProof());

    if (work.bitLength() > 53)
      return sign * Number.MAX_SAFE_INTEGER;

    return sign * work.toNumber();
  }

  /**
   * Calculate the next target based on the chain tip.
   * @returns {Promise} - returns Number
   * (target is in compact/mantissa form).
   */

  async getCurrentTarget() {
    return this.getTarget(this.network.now(), this.tip);
  }

  /**
   * Get median block by timestamp.
   * @param {ChainEntry} prev
   * @returns {Promise}
   */

  async getSuitableBlock(prev) {
    assert(prev);

    let z = prev;
    let y = await this.getPrevious(z);
    let x = await this.getPrevious(y);

    assert(x);

    if (x.time > z.time)
      [x, z] = [z, x];

    if (x.time > y.time)
      [x, y] = [y, x];

    if (y.time > z.time)
      [y, z] = [z, y];

    return y;
  }

  /**
   * Calculate the next target.
   * @param {Number} time - Next block timestamp.
   * @param {ChainEntry} prev - Previous entry.
   * @returns {Promise} - returns Number
   * (target is in compact/mantissa form).
   */

  async getTarget(time, prev) {
    const pow = this.network.pow;

    // Genesis
    if (!prev) {
      assert(time === this.network.genesis.time);
      return pow.bits;
    }

    // Do not retarget
    if (pow.noRetargeting)
      return pow.bits;

    // Special behavior for testnet:
    if (pow.targetReset) {
      if (time > prev.time + pow.targetSpacing * 2)
        return pow.bits;
    }

    assert(pow.blocksPerDay === 144);
    assert(pow.targetWindow === 144);

    if (prev.height < pow.blocksPerDay + 2) {
      assert(prev.bits === pow.bits);
      return pow.bits;
    }

    const last = await this.getSuitableBlock(prev);

    const height = prev.height - pow.blocksPerDay;
    assert(height >= 0);

    const ancestor = await this.getAncestor(prev, height);
    const first = await this.getSuitableBlock(ancestor);

    return this.retarget(first, last);
  }

  /**
   * Calculate the next target.
   * @param {ChainEntry} first - Suitable block from 1 day prior.
   * @param {ChainEntry} last - Last suitable block.
   * @returns {Number} target - Target in compact/mantissa form.
   */

  retarget(first, last) {
    assert(last.height > first.height);

    const pow = this.network.pow;
    const maxChainwork = ChainEntry.MAX_CHAINWORK;
    const minActual = pow.blocksPerDay / 4;
    const maxActual = pow.blocksPerDay * 4;

    assert(minActual === 36); // 72 on BCH
    assert(maxActual === 576); // 288 on BCH

    assert(minActual * pow.targetSpacing === pow.minActual);
    assert(maxActual * pow.targetSpacing === pow.maxActual);

    const work = last.chainwork.sub(first.chainwork);

    work.imuln(pow.targetSpacing);

    let actualTimespan = last.time - first.time;

    if (actualTimespan < minActual * pow.targetSpacing)
      actualTimespan = minActual * pow.targetSpacing;

    if (actualTimespan > maxActual * pow.targetSpacing)
      actualTimespan = maxActual * pow.targetSpacing;

    work.idivn(actualTimespan);

    if (work.isZero())
      return pow.bits;

    const target = maxChainwork.div(work).isubn(1);

    if (target.gt(pow.limit))
      return pow.bits;

    const cmpct = consensus.toCompact(target);

    this.logger.debug('Retargetting to: %s (0x%s).',
      consensus.fromCompact(cmpct).toString('hex', 64),
      util.hex32(cmpct));

    return cmpct;
  }

  /**
   * Find a locator. Analagous to bitcoind's `FindForkInGlobalIndex()`.
   * @param {Hash[]} locator - Hashes.
   * @returns {Promise} - Returns {@link Hash} (the
   * hash of the latest known block).
   */

  async findLocator(locator) {
    for (const hash of locator) {
      if (await this.isMainHash(hash))
        return hash;
    }

    return this.network.genesis.hash;
  }

  /**
   * Check whether a versionbits deployment is active (BIP9: versionbits).
   * @example
   * await chain.isActive(tip, deployments.segwit);
   * @see https://github.com/bitcoin/bips/blob/master/bip-0009.mediawiki
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {Object} deployment - Deployment.
   * @returns {Promise} - Returns Number.
   */

  async isActive(prev, deployment) {
    const state = await this.getState(prev, deployment);
    return state === thresholdStates.ACTIVE;
  }

  /**
   * Get chain entry state for a deployment (BIP9: versionbits).
   * @example
   * await chain.getState(tip, deployments.segwit);
   * @see https://github.com/bitcoin/bips/blob/master/bip-0009.mediawiki
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {Object} deployment - Deployment.
   * @returns {Promise} - Returns Number.
   */

  async getState(prev, deployment) {
    const bit = deployment.bit;

    let window = this.network.minerWindow;
    let threshold = this.network.activationThreshold;

    if (deployment.threshold !== -1)
      threshold = deployment.threshold;

    if (deployment.window !== -1)
      window = deployment.window;

    if (((prev.height + 1) % window) !== 0) {
      const height = prev.height - ((prev.height + 1) % window);

      prev = await this.getAncestor(prev, height);

      if (!prev)
        return thresholdStates.DEFINED;

      assert(prev.height === height);
      assert(((prev.height + 1) % window) === 0);
    }

    let entry = prev;
    let state = thresholdStates.DEFINED;

    const compute = [];

    while (entry) {
      const cached = this.db.stateCache.get(bit, entry);

      if (cached !== -1) {
        state = cached;
        break;
      }

      const time = await this.getMedianTime(entry);

      if (time < deployment.startTime) {
        state = thresholdStates.DEFINED;
        this.db.stateCache.set(bit, entry, state);
        break;
      }

      compute.push(entry);

      const height = entry.height - window;

      entry = await this.getAncestor(entry, height);
    }

    while (compute.length) {
      const entry = compute.pop();

      switch (state) {
        case thresholdStates.DEFINED: {
          const time = await this.getMedianTime(entry);

          if (time >= deployment.timeout) {
            state = thresholdStates.FAILED;
            break;
          }

          if (time >= deployment.startTime) {
            state = thresholdStates.STARTED;
            break;
          }

          break;
        }
        case thresholdStates.STARTED: {
          const time = await this.getMedianTime(entry);

          if (time >= deployment.timeout) {
            state = thresholdStates.FAILED;
            break;
          }

          let block = entry;
          let count = 0;

          for (let i = 0; i < window; i++) {
            if (block.hasBit(bit))
              count += 1;

            if (count >= threshold) {
              state = thresholdStates.LOCKED_IN;
              break;
            }

            block = await this.getPrevious(block);
            assert(block);
          }

          break;
        }
        case thresholdStates.LOCKED_IN: {
          state = thresholdStates.ACTIVE;
          break;
        }
        case thresholdStates.FAILED:
        case thresholdStates.ACTIVE: {
          break;
        }
        default: {
          assert(false, 'Bad state.');
          break;
        }
      }

      this.db.stateCache.set(bit, entry, state);
    }

    return state;
  }

  /**
   * Get signalling statistics for BIP9/versionbits soft fork
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {Obejct} deployment - Deployment.
   * @returns {Promise} - Returns JSON object.
   */

  async getBIP9Stats(prev, deployment) {
    const state = await this.getState(prev, deployment);
    if (state !== thresholdStates.STARTED)
      throw new Error(`Deployment "${deployment.name}" not in STARTED state.`);

    const bit = deployment.bit;
    let window = this.network.minerWindow;
    let threshold = this.network.activationThreshold;

    // Deployments like `segsignal` (BIP91) have custom window & threshold
    if (deployment.window !== -1)
      window = deployment.window;

    if (deployment.threshold !== -1)
      threshold = deployment.threshold;

    let count = 0;
    let block = prev;

    while((block.height + 1) % window !== 0) {
      if (block.hasBit(bit))
        count++;

      block = await this.getPrevious(block);
      if(!block)
        break;
    }

    return {
      period: window,
      threshold: threshold,
      elapsed: (prev.height + 1) % window,
      count: count,
      possible: (window - threshold) >= ((prev.height + 1) % window) - count
    };
  }

  /**
   * Compute the version for a new block (BIP9: versionbits).
   * @see https://github.com/bitcoin/bips/blob/master/bip-0009.mediawiki
   * @param {ChainEntry} prev - Previous chain entry (usually the tip).
   * @returns {Promise} - Returns Number.
   */

  async computeBlockVersion(prev) {
    let version = 0;

    for (const deployment of this.network.deploys) {
      const state = await this.getState(prev, deployment);

      if (state === thresholdStates.LOCKED_IN
          || state === thresholdStates.STARTED) {
        version |= 1 << deployment.bit;
      }
    }

    version >>>= 0;

    return version;
  }

  /**
   * Get the current deployment state of the chain. Called on load.
   * @private
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async getDeploymentState() {
    return this.readDeploymentState(this.tip);
  }

  /**
   * Get deployment state.
   * @private
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async readDeploymentState(tip) {
    const prev = await this.getPrevious(tip);

    if (!prev) {
      assert(tip.isGenesis());
      return new DeploymentState(this.network.genesis.hash);
    }

    if (this.options.spv)
      return new DeploymentState(this.network.genesis.hash);

    return this.getDeployments(tip.time, prev);
  }

  /**
   * Get the next deployment state of the chain.
   * @private
   * @returns {Promise} - Returns {@link DeploymentState}.
   */

  async getNextState() {
    if (this.options.spv)
      return this.state;

    return this.getDeployments(this.network.now(), this.tip);
  }

  /**
   * Check transaction finality, taking into account MEDIAN_TIME_PAST
   * if it is present in the lock flags.
   * @param {ChainEntry} prev - Previous chain entry.
   * @param {TX} tx
   * @param {LockFlags} flags
   * @returns {Promise} - Returns Boolean.
   */

  async verifyFinal(prev, tx, flags) {
    const height = prev.height + 1;

    // We can skip MTP if the locktime is height.
    if (!(tx.locktime & consensus.LOCKTIME_FLAG))
      return tx.isFinal(height, -1);

    const time = await this.getMedianTime(prev);

    return tx.isFinal(height, time);
  }

  /**
   * Get the necessary minimum time and height sequence locks for a transaction.
   * @param {ChainEntry} prev
   * @param {TX} tx
   * @param {CoinView} view
   * @param {LockFlags} flags
   * @returns {Promise}
   */

  async getLocks(prev, tx, view, flags) {
    const GRANULARITY = consensus.SEQUENCE_GRANULARITY;
    const DISABLE_FLAG = consensus.SEQUENCE_DISABLE_FLAG;
    const TYPE_FLAG = consensus.SEQUENCE_TYPE_FLAG;
    const MASK = consensus.SEQUENCE_MASK;

    if (tx.isCoinbase())
      return [-1, -1];

    let minHeight = -1;
    let minTime = -1;

    for (const {prevout, sequence} of tx.inputs) {
      if (sequence & DISABLE_FLAG)
        continue;

      let height = view.getHeight(prevout);

      if (height === -1)
        height = this.height + 1;

      if (!(sequence & TYPE_FLAG)) {
        height += (sequence & MASK) - 1;
        minHeight = Math.max(minHeight, height);
        continue;
      }

      height = Math.max(height - 1, 0);

      const entry = await this.getAncestor(prev, height);
      assert(entry, 'Database is corrupt.');

      let time = await this.getMedianTime(entry);
      time += ((sequence & MASK) << GRANULARITY) - 1;
      minTime = Math.max(minTime, time);
    }

    return [minHeight, minTime];
  }

  /**
   * Verify sequence locks.
   * @param {ChainEntry} prev
   * @param {TX} tx
   * @param {CoinView} view
   * @param {LockFlags} flags
   * @returns {Promise} - Returns Boolean.
   */

  async verifyLocks(prev, tx, view, flags) {
    const [height, time] = await this.getLocks(prev, tx, view, flags);

    if (height !== -1) {
      if (height >= prev.height + 1)
        return false;
    }

    if (time !== -1) {
      const mtp = await this.getMedianTime(prev);

      if (time >= mtp)
        return false;
    }

    return true;
  }

  /**
   * Get safe tree root.
   * @returns {Hash}
   */

  async getSafeRoot() {
    // The tree is committed on an interval.
    // Mainnet is 72 blocks, meaning at height 72,
    // the name set of the past 72 blocks are
    // inserted into the tree. The commitment for
    // that insertion actually appears in a block
    // header one block later (height 73). We
    // want the the root _before_ the current one
    // so we can calculate that with:
    //   chain_height - (chain_height % interval)
    const interval = this.network.names.treeInterval;

    let mod = this.height % interval;

    // If there's enough proof-of-work
    // on top of the most recent root,
    // it should be safe to use it.
    if (mod >= 12)
      mod = 0;

    const height = this.height - mod;
    const entry = await this.getEntryByHeight(height);
    assert(entry);

    return entry.treeRoot;
  }
}

/**
 * ChainOptions
 * @alias module:blockchain.ChainOptions
 */

class ChainOptions {
  /**
   * Create chain options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;
    this.workers = null;

    this.prefix = null;
    this.location = null;
    this.treeLocation = null;
    this.memory = true;
    this.maxFiles = 64;
    this.cacheSize = 32 << 20;
    this.compression = true;

    this.spv = false;
    this.prune = false;
    this.indexTX = false;
    this.indexAddress = false;
    this.forceFlags = false;

    this.entryCache = 5000;
    this.maxOrphans = 20;
    this.checkpoints = true;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {ChainOptions}
   */

  fromOptions(options) {
    if (options.network != null)
      this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.workers != null) {
      assert(typeof options.workers === 'object');
      this.workers = options.workers;
    }

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.location = this.spv
        ? path.join(this.prefix, 'spvchain')
        : path.join(this.prefix, 'chain');
      this.treePrefix = path.join(this.prefix, 'tree');
    }

    if (options.location != null) {
      assert(typeof options.location === 'string');
      this.location = options.location;
    }

    if (options.treePrefix != null) {
      assert(typeof options.treePrefix === 'string');
      this.treePrefix = options.treePrefix;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean');
      this.memory = options.memory;
    }

    if (options.maxFiles != null) {
      assert((options.maxFiles >>> 0) === options.maxFiles);
      this.maxFiles = options.maxFiles;
    }

    if (options.cacheSize != null) {
      assert(Number.isSafeInteger(options.cacheSize));
      assert(options.cacheSize >= 0);
      this.cacheSize = options.cacheSize;
    }

    if (options.compression != null) {
      assert(typeof options.compression === 'boolean');
      this.compression = options.compression;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }

    if (options.indexTX != null) {
      assert(typeof options.indexTX === 'boolean');
      this.indexTX = options.indexTX;
    }

    if (options.indexAddress != null) {
      assert(typeof options.indexAddress === 'boolean');
      this.indexAddress = options.indexAddress;
    }

    if (options.forceFlags != null) {
      assert(typeof options.forceFlags === 'boolean');
      this.forceFlags = options.forceFlags;
    }

    if (options.entryCache != null) {
      assert((options.entryCache >>> 0) === options.entryCache);
      this.entryCache = options.entryCache;
    }

    if (options.maxOrphans != null) {
      assert((options.maxOrphans >>> 0) === options.maxOrphans);
      this.maxOrphans = options.maxOrphans;
    }

    if (options.checkpoints != null) {
      assert(typeof options.checkpoints === 'boolean');
      this.checkpoints = options.checkpoints;
    }

    if (this.spv || this.memory)
      this.treePrefix = null;

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {ChainOptions}
   */

  static fromOptions(options) {
    return new ChainOptions().fromOptions(options);
  }
}

/**
 * Deployment State
 * @alias module:blockchain.DeploymentState
 * @property {VerifyFlags} flags
 * @property {LockFlags} lockFlags
 */

class DeploymentState {
  /**
   * Create a deployment state.
   * @constructor
   */

  constructor(tip) {
    this.tip = tip;
    this.flags = Script.flags.MANDATORY_VERIFY_FLAGS;
    this.lockFlags = common.lockFlags.MANDATORY_LOCKTIME_FLAGS;
    this.hardening = false;
  }

  hasHardening() {
    return this.hardening;
  }
}

/**
 * Orphan
 * @ignore
 */

class Orphan {
  /**
   * Create an orphan.
   * @constructor
   */

  constructor(block, flags, id) {
    this.block = block;
    this.flags = flags;
    this.id = id;
    this.time = util.now();
  }
}

/*
 * Helpers
 */

function cmp(a, b) {
  return a - b;
}

/*
 * Expose
 */

module.exports = Chain;
