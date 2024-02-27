/*!
 * client.js - http client for wallets
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

// NOTE: This is part of generated `hs-client`.
// Don't introduce any unnecessary dependencies to this.

const assert = require('bsert');
const {Client} = require('bcurl');
const WSClient = require('./wsclient');

/**
 * Node Client
 * @alias module:client.NodeClient
 * @extends {bcurl.Client}
 */

class NodeClient extends Client {
  /**
   * Creat a node client.
   * @param {Object?} options
   */

  constructor(options) {
    super(options);

    this.ws = new NodeWSClient(this);
  }

  /**
   * Auth with server.
   * @returns {Promise}
   */

  async auth() {
    await this.ws.call('auth', this.password);
    await this.ws.watchChain();
    await this.ws.watchMempool();
  }

  /**
   * Make an RPC call.
   * @returns {Promise}
   */

  execute(name, params) {
    return super.execute('/', name, params);
  }

  /**
   * Get a mempool snapshot.
   * @returns {Promise}
   */

  getMempool() {
    return this.get('/mempool');
  }

  /**
   * Get some info about the server (network and version).
   * @returns {Promise}
   */

  getInfo() {
    return this.get('/');
  }

  /**
   * Get coins that pertain to an address from the mempool or chain database.
   * Takes into account spent coins in the mempool.
   * @param {String} address
   * @returns {Promise}
   */

  getCoinsByAddress(address) {
    assert(typeof address === 'string');
    return this.get(`/coin/address/${address}`);
  }

  /**
   * Get coins that pertain to addresses from the mempool or chain database.
   * Takes into account spent coins in the mempool.
   * @param {String[]} addresses
   * @returns {Promise}
   */

  getCoinsByAddresses(addresses) {
    assert(Array.isArray(addresses));
    return this.post('/coin/address', { addresses });
  }

  /**
   * Retrieve a coin from the mempool or chain database.
   * Takes into account spent coins in the mempool.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise}
   */

  getCoin(hash, index) {
    assert(typeof hash === 'string');
    assert((index >>> 0) === index);
    return this.get(`/coin/${hash}/${index}`);
  }

  /**
   * Retrieve transactions pertaining to an
   * address from the mempool or chain database.
   * @param {String} address
   * @returns {Promise}
   */

  getTXByAddress(address) {
    assert(typeof address === 'string');
    return this.get(`/tx/address/${address}`);
  }

  /**
   * Retrieve transactions pertaining to
   * addresses from the mempool or chain database.
   * @param {String[]} addresses
   * @returns {Promise}
   */

  getTXByAddresses(addresses) {
    assert(Array.isArray(addresses));
    return this.post('/tx/address', { addresses });
  }

  /**
   * Retrieve a transaction from the mempool or chain database.
   * @param {Hash} hash
   * @returns {Promise}
   */

  getTX(hash) {
    assert(typeof hash === 'string');
    return this.get(`/tx/${hash}`);
  }

  /**
   * Retrieve a block from the chain database.
   * @param {Hash|Number} block
   * @returns {Promise}
   */

  getBlock(block) {
    assert(typeof block === 'string' || typeof block === 'number');
    return this.get(`/block/${block}`);
  }

  /**
   * Retrieve a block header.
   * @param {Hash|Number} block
   * @returns {Promise}
   */

  getBlockHeader(block) {
    assert(typeof block === 'string' || typeof block === 'number');
    return this.get(`/header/${block}`);
  }

  /**
   * Add a transaction to the mempool and broadcast it.
   * @param {TX} tx
   * @returns {Promise}
   */

  broadcast(tx) {
    assert(typeof tx === 'string');
    return this.post('/broadcast', { tx });
  }

  /**
   * Add a claim to the mempool and broadcast it.
   * @param {Claim} claim
   * @returns {Promise}
   */

  broadcastClaim(claim) {
    assert(typeof claim === 'string');
    return this.post('/claim', { claim });
  }

  /**
   * Reset the chain.
   * @param {Number} height
   * @returns {Promise}
   */

  reset(height) {
    return this.post('/reset', { height });
  }
}

/**
 * Node WS Client
 * @alias module:client.NodeWSClient
 * @extends {WSClient}
 */

class NodeWSClient extends WSClient {
  /**
   * Watch the blockchain.
   * @private
   * @returns {Promise}
   */

  watchChain() {
    return this.call('watch chain');
  }

  /**
   * Watch the blockchain.
   * @private
   * @returns {Promise}
   */

  watchMempool() {
    return this.call('watch mempool');
  }

  /**
   * Get chain tip.
   * @returns {Promise}
   */

  getTip() {
    return this.call('get tip');
  }

  /**
   * Get chain entry.
   * @param {Hash} hash
   * @returns {Promise}
   */

  getEntry(block) {
    return this.call('get entry', block);
  }

  /**
   * Get hashes.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise}
   */

  getHashes(start, end) {
    return this.call('get hashes', start, end);
  }

  /**
   * Send a transaction. Do not wait for promise.
   * @param {TX} tx
   * @returns {Promise}
   */

  send(tx) {
    assert(Buffer.isBuffer(tx));
    return this.call('send', tx);
  }

  /**
   * Send a claim. Do not wait for promise.
   * @param {Claim} claim
   * @returns {Promise}
   */

  sendClaim(claim) {
    assert(Buffer.isBuffer(claim));
    return this.call('send claim', claim);
  }

  /**
   * Get name state.
   * @param {Buffer} nameHash
   * @returns {Promise}
   */

  getNameStatus(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    return this.call('get name', nameHash);
  }

  /**
   * Set bloom filter.
   * @param {Bloom} filter
   * @returns {Promise}
   */

  setFilter(filter) {
    assert(Buffer.isBuffer(filter));
    return this.call('set filter', filter);
  }

  /**
   * Add data to filter.
   * @param {Buffer} data
   * @returns {Promise}
   */

  addFilter(chunks) {
    if (!Array.isArray(chunks))
      chunks = [chunks];

    return this.call('add filter', chunks);
  }

  /**
   * Reset filter.
   * @returns {Promise}
   */

  resetFilter() {
    return this.call('reset filter');
  }

  /**
   * Esimate smart fee.
   * @param {Number?} blocks
   * @returns {Promise}
   */

  estimateFee(blocks) {
    assert(blocks == null || typeof blocks === 'number');
    return this.call('estimate fee', blocks);
  }

  /**
   * Rescan for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @returns {Promise}
   */

  rescan(start) {
    if (start == null)
      start = 0;

    assert(typeof start === 'number' || Buffer.isBuffer(start));

    return this.call('rescan', start);
  }

  /**
   * Rescan for any missed transactions. (Interactive)
   * @param {Number|Hash} start - Start block.
   * @param {BloomFilter} [filter]
   * @returns {Promise}
   */

  rescanInteractive(start, filter = null) {
    if (start == null)
      start = 0;

    assert(typeof start === 'number' || Buffer.isBuffer(start));

    return this.call('rescan interactive', start, filter);
  }
}

/*
 * Expose
 */

module.exports = NodeClient;
