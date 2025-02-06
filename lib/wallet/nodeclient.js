/*!
 * nodeclient.js - node client for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const blacklist = require('bsock/lib/blacklist');
const AsyncEmitter = require('bevent');

/** @typedef {import('@handshake-org/bfilter').BloomFilter} BloomFilter */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('../primitives/claim')} Claim */
/** @typedef {import('../covenants/namestate')} NameState */
/** @typedef {import('../blockchain/chainentry')} ChainEntry */
/** @typedef {import('../node/fullnode')} FullNode */
/** @typedef {import('../node/spvnode')} SPVNode */
/** @typedef {FullNode|SPVNode} Node */

/**
 * Node Client
 * @alias module:node.NodeClient
 */

class NodeClient extends AsyncEmitter {
  /**
   * Create a node client.
   * @constructor
   * @param {Node} node
   */

  constructor(node) {
    super();

    /** @type {Node} */
    this.node = node;
    this.network = node.network;
    this.filter = null;
    this.opened = false;
    this.hooks = new Map();

    this.init();
  }

  /**
   * Initialize the client.
   */

  init() {
    this.node.chain.on('connect', async (entry, block) => {
      if (!this.opened)
        return;

      await this.emitAsync('block connect', entry, block.txs);
    });

    this.node.chain.on('disconnect', async (entry, block) => {
      if (!this.opened)
        return;

      await this.emitAsync('block disconnect', entry);
    });

    this.node.on('tx', (tx) => {
      if (!this.opened)
        return;

      this.emit('tx', tx);
    });

    this.node.on('reset', (tip) => {
      if (!this.opened)
        return;

      this.emit('chain reset', tip);
    });
  }

  /**
   * Open the client.
   * @returns {Promise<void>}
   */

  async open() {
    assert(!this.opened, 'NodeClient is already open.');
    this.opened = true;
    setImmediate(() => this.emit('connect'));
  }

  /**
   * Close the client.
   * @returns {Promise<void>}
   */

  async close() {
    assert(this.opened, 'NodeClient is not open.');
    this.opened = false;
    setImmediate(() => this.emit('disconnect'));
  }

  /**
   * Add a listener.
   * @param {String} type
   * @param {Function} handler
   */

  bind(type, handler) {
    return this.on(type, handler);
  }

  /**
   * Add a hook.
   * @param {String} event
   * @param {Function} handler
   */

  hook(event, handler) {
    assert(typeof event === 'string', 'Event must be a string.');
    assert(typeof handler === 'function', 'Handler must be a function.');
    assert(!this.hooks.has(event), 'Hook already bound.');
    assert(!Object.prototype.hasOwnProperty.call(blacklist, event),
      'Blacklisted event.');
    this.hooks.set(event, handler);
  }

  /**
   * Remove a hook.
   * @param {String} event
   */

  unhook(event) {
    assert(typeof event === 'string', 'Event must be a string.');
    assert(!Object.prototype.hasOwnProperty.call(blacklist, event),
      'Blacklisted event.');
    this.hooks.delete(event);
  }

  /**
   * Call a hook.
   * @param {String} event
   * @param {...Object} args
   * @returns {Promise}
   */

  handleCall(event, ...args) {
    const hook = this.hooks.get(event);

    if (!hook)
      throw new Error('No hook available.');

    return hook(...args);
  }

  /**
   * Get chain tip.
   * @returns {Promise<ChainEntry>}
   */

  async getTip() {
    return this.node.chain.tip;
  }

  /**
   * Get chain entry.
   * @param {Hash} hash
   * @returns {Promise<ChainEntry?>}
   */

  async getEntry(hash) {
    const entry = await this.node.chain.getEntry(hash);

    if (!entry)
      return null;

    if (!await this.node.chain.isMainChain(entry))
      return null;

    return entry;
  }

  /**
   * Send a transaction. Do not wait for promise.
   * @param {TX} tx
   * @returns {Promise<void>}
   */

  async send(tx) {
    this.node.relay(tx);
  }

  /**
   * Send a claim. Do not wait for promise.
   * @param {Claim} claim
   * @returns {Promise<void>}
   */

  async sendClaim(claim) {
    this.node.relayClaim(claim);
  }

  /**
   * Set bloom filter.
   * @param {BloomFilter} filter
   * @returns {Promise<void>}
   */

  async setFilter(filter) {
    this.filter = filter;
    this.node.pool.setFilter(filter);
  }

  /**
   * Add data to filter.
   * @param {Buffer} data
   * @returns {Promise<void>}
   */

  async addFilter(data) {
    // `data` is ignored because pool.spvFilter === walletDB.filter
    // and therefore is already updated.
    // Argument is kept here to be consistent with API in
    // wallet/client.js (client/node.js) and wallet/nullclient.js
    this.node.pool.queueFilterLoad();
  }

  /**
   * Reset filter.
   * @returns {Promise<void>}
   */

  async resetFilter() {
    this.node.pool.queueFilterLoad();
  }

  /**
   * Esimate smart fee.
   * @param {Number?} blocks
   * @returns {Promise<Number>}
   */

  async estimateFee(blocks) {
    if (!this.node.fees)
      return this.network.feeRate;

    return this.node.fees.estimateFee(blocks);
  }

  /**
   * Get hash range.
   * @param {Number} start
   * @param {Number} end
   * @returns {Promise<Hash[]>}
   */

  async getHashes(start = -1, end = -1) {
    return this.node.chain.getHashes(start, end);
  }

  /**
   * Get entries range.
   * @param {Number} start
   * @param {Number} end
   * @returns {Promise<ChainEntry[]>}
   */

  async getEntries(start = -1, end = -1) {
    return this.node.chain.getEntries(start, end);
  }

  /**
   * Rescan for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @returns {Promise<void>}
   */

  async rescan(start) {
    if (this.node.spv)
      return this.node.chain.reset(start);

    return this.node.chain.scan(start, this.filter, (entry, txs) => {
      return this.handleCall('block rescan', entry, txs);
    });
  }

  /**
   * Rescan interactive for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @param {Boolean} [fullLock=false]
   * @returns {Promise<void>}
   */

  async rescanInteractive(start, fullLock = true) {
    if (this.node.spv)
      return this.node.chain.reset(start);

    const iter = async (entry, txs) => {
      return await this.handleCall('block rescan interactive', entry, txs);
    };

    try {
      return await this.node.scanInteractive(
        start,
        this.filter,
        iter,
        fullLock
      );
    } catch (e) {
      await this.handleCall('block rescan interactive abort', e.message);
      throw e;
    }
  }

  /**
   * Get name state.
   * @param {Buffer} nameHash
   * @returns {Promise<NameState>}
   */

  async getNameStatus(nameHash) {
    return this.node.getNameStatus(nameHash);
  }

  /**
   * Get UTXO.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Object}
   */

  async getCoin(hash, index) {
    return this.node.getCoin(hash, index);
  }

  /**
   * Get block header.
   * @param {Hash|Number} block
   * @returns {Promise<ChainEntry>}
   */

  async getBlockHeader(block) {
    if (typeof block === 'string')
      block = Buffer.from(block, 'hex');

    const entry = await this.node.chain.getEntry(block);

    if (!entry)
      return null;

    return entry.toJSON();
  }
}

/*
 * Expose
 */

module.exports = NodeClient;
