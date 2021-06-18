/*!
 * composedFees.js - fee estimation for hsd
 * Copyright (c) 2019, Rafael Solari (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const FeeEstimator = require('./fees');
const rules = require('../covenants/rules');

/**
 * Composed Estimator
 *
 * There are four limits for how many transactions can go in a block,
 * each of which could fill up separately:
 *  - Main fee market for block space. Limited by consensus.MAX_BLOCK_WEIGHT.
 *  - A submarket for FINALIZE, REGISTER, and RENEW covenants, limited by
 *    consensus.MAX_BLOCK_RENEWALS.
 *  - A submarket for OPEN, UPDATE, TRANSFER and REVOKE covenants, limited
 *    by consensus.MAX_BLOCK_UPDATES.
 *  - A submarket for  OPEN covenants, limited by consensus.MAX_BLOCK_OPENS.
 *    Subset of the previous limit.
 *
 * Composed Estimator estimates the each market's rates and priorities by
 * running an estimator for each one.
 *
 * @alias module:mempool.ComposedEstimator
 */

class ComposedEstimator extends bio.Struct {
  /**
   * Create an estimator.
   * @constructor
   * @param {Logger?} logger
   */

  constructor(logger) {
    super();

    this.blockspaceFees = new FeeEstimator(logger);
    this.openFees = new FeeEstimator(logger);
    this.updateFees = new FeeEstimator(logger);
    this.renewalFees = new FeeEstimator(logger);
  }

  /**
   * Initialize the estimator.
   * @private
   */

  init() {
    this.blockspaceFees.init();
    this.openFees.init();
    this.updateFees.init();
    this.renewalFees.init();
  }

  /**
   * Reset the estimator.
   */

  reset() {
    this.blockspaceFees.reset();
    this.openFees.reset();
    this.updateFees.reset();
    this.renewalFees.reset();
  }

  /**
   * Stop tracking a tx. Remove from map.
   * @param {Hash} hash
   */

  removeTX(hash) {
    this.blockspaceFees.removeTX(hash);
    this.openFees.removeTX(hash);
    this.updateFees.removeTX(hash);
    this.renewalFees.removeTX(hash);
  }

  /**
   * Test whether a fee should be used for calculation.
   * @param {Amount} fee
   * @param {Number} priority
   * @returns {Boolean}
   */

  isFeePoint(fee, priority) {
    return this.blockspaceFees.isFeePoint(fee, priority);
  }

  /**
   * Test whether a priority should be used for calculation.
   * @param {Amount} fee
   * @param {Number} priority
   * @returns {Boolean}
   */

  isPriPoint(fee, priority) {
    return this.blockspaceFees.isPriPoint(fee, priority);
  }

  /**
   * Process a mempool entry.
   * @param {MempoolEntry} entry
   * @param {Boolean} current - Whether the chain is synced.
   */

  processTX(entry, current) {
    this.blockspaceFees.processTX(entry, current);
    if (rules.countOpens(entry.tx) > 0)
      this.openFees.processTX(entry, current);
    if (rules.countUpdates(entry.tx) > 0)
      this.updateFees.processTX(entry, current);
    if (rules.countRenewals(entry.tx) > 0)
      this.renewalFees.processTX(entry, current);
  }

  /**
   * Process an entry being removed from the mempool.
   * @param {Number} height - Block height.
   * @param {MempoolEntry} entry
   */

  processBlockTX(height, entry) {
    this.blockspaceFees.processBlockTX(height, entry);
    if (rules.countOpens(entry.tx) > 0)
      this.openFees.processBlockTX(height, entry);
    if (rules.countUpdates(entry.tx) > 0)
      this.updateFees.processBlockTX(height, entry);
    if (rules.countRenewals(entry.tx) > 0)
      this.renewalFees.processBlockTX(height, entry);
  }

  /**
   * Process a block of transaction entries being removed from the mempool.
   * @param {Number} height - Block height.
   * @param {MempoolEntry[]} entries
   * @param {Boolean} current - Whether the chain is synced.
   */

  processBlock(height, entries, current) {
    const openEntries = [];
    const updateEntries = [];
    const renewalEntries = [];
    for (const entry of entries) {
      if (rules.countOpens(entry.tx) > 0)
        openEntries.push(entry);
      if (rules.countUpdates(entry.tx) > 0)
        updateEntries.push(entry);
      if (rules.countRenewals(entry.tx) > 0)
        renewalEntries.push(entry);
    }

    this.blockspaceFees.processBlock(height, entries, current);
    this.openFees.processBlock(height, openEntries, current);
    this.updateFees.processBlock(height, updateEntries, current);
    this.renewalFees.processBlock(height, renewalEntries, current);
  }

  /**
   * Estimate a fee rate.
   * @param {Number} [target=1] - Confirmation target.
   * @param {Boolean} [smart=true] - Smart estimation.
   * @param {Number?} - Covenant Type.
   * @returns {Rate}
   */

  estimateFee(target, smart, type) {
    if (!target)
      target = 1;

    if (smart == null)
      smart = true;

    const estimates = [];
    estimates.push(this.blockspaceFees.estimateFee(target, smart));

    if (rules.isOpenLimited(type))
      estimates.push(this.openFees.estimateFee(target, smart));
    if (rules.isUpdateLimited(type))
      estimates.push(this.updateFees.estimateFee(target, smart));
    if (rules.isRenewalLimited(type))
      estimates.push(this.renewalFees.estimateFee(target, smart));

    return Math.max(...estimates);
  }

  /**
   * Estimate a priority.
   * @param {Number} [target=1] - Confirmation target.
   * @param {Boolean} [smart=true] - Smart estimation.
   * @param {String?} - Covenant Type.
   * @returns {Number}
   */

  estimatePriority(target, smart, covenantType) {
    if (!target)
      target = 1;

    if (smart == null)
      smart = true;

    assert((target >>> 0) === target, 'Target must be a number.');
    assert(target <= this.priStats.maxConfirms,
      'Too many confirmations for estimate.');

    const estimates = [];
    estimates.push(this.blockspaceFees.estimatePriority(target, smart));

    if (rules.isOpenLimited(covenantType))
      estimates.push(this.openFees.estimatePriority(target, smart));
    if (rules.isUpdateLimited(covenantType))
      estimates.push(this.updateFees.estimatePriority(target, smart));
    if (rules.isRenewalLimited(covenantType))
      estimates.push(this.renewalFees.estimatePriority(target, smart));

    return Math.max(...estimates);
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += 1; // U8 of ComposedEstimator.VERSION
    size += this.blockspaceFees.getSize();
    return size;
  }

  /**
   * Serialize the estimator.
   * @returns {Buffer}
   */

  write(bw) {
    bw.writeU8(ComposedEstimator.VERSION);
    this.blockspaceFees.write(bw);
    return bw;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   * @returns {ComposedEstimator}
   */

  read(br) {
    if (br.readU8() !== ComposedEstimator.VERSION)
      throw new Error('Bad serialization version for estimator.');

    this.blockspaceFees.read(br);

    return this;
  }

  /**
   * Inject properties from estimator.
   * @param {ComposedEstimator} estimator
   * @returns {ComposedEstimator}
   */

  inject(metaEstimator) {
    this.blockspaceFees = this.blockspaceFees.inject(
      metaEstimator.blockspaceFees
    );

    return this;
  }
}

/**
 * Serialization version.
 * @const {Number}
 * @default
 */

ComposedEstimator.VERSION = 1;

/*
 * Expose
 */

module.exports = ComposedEstimator;
