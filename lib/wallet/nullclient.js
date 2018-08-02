/*!
 * nullclient.js - node client for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const NameState = require('../covenants/namestate');

/**
 * Null Client
 * Sort of a fake local client for separation of concerns.
 * @alias module:node.NullClient
 */

class NullClient extends EventEmitter {
  /**
   * Create a client.
   * @constructor
   */

  constructor(wdb) {
    super();

    this.wdb = wdb;
    this.network = wdb.network;
    this.opened = false;
  }

  /**
   * Open the client.
   * @returns {Promise}
   */

  async open(options) {
    assert(!this.opened, 'NullClient is already open.');
    this.opened = true;
    setImmediate(() => this.emit('connect'));
  }

  /**
   * Close the client.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'NullClient is not open.');
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
   * Add a listener.
   * @param {String} type
   * @param {Function} handler
   */

  hook(type, handler) {
    return this.on(type, handler);
  }

  /**
   * Get chain tip.
   * @returns {Promise}
   */

  async getTip() {
    const {hash, height, time} = this.network.genesis;
    return { hash, height, time };
  }

  /**
   * Get chain entry.
   * @param {Hash} hash
   * @returns {Promise}
   */

  async getEntry(hash) {
    return { hash, height: 0, time: 0 };
  }

  /**
   * Send a transaction. Do not wait for promise.
   * @param {TX} tx
   * @returns {Promise}
   */

  async send(tx) {
    this.wdb.emit('send', tx);
  }

  /**
   * Send a claim. Do not wait for promise.
   * @param {Claim} claim
   * @returns {Promise}
   */

  async sendClaim(claim) {
    this.wdb.emit('send claim', claim);
  }

  /**
   * Set bloom filter.
   * @param {Bloom} filter
   * @returns {Promise}
   */

  async setFilter(filter) {
    this.wdb.emit('set filter', filter);
  }

  /**
   * Add data to filter.
   * @param {Buffer} data
   * @returns {Promise}
   */

  async addFilter(data) {
    this.wdb.emit('add filter', data);
  }

  /**
   * Reset filter.
   * @returns {Promise}
   */

  async resetFilter() {
    this.wdb.emit('reset filter');
  }

  /**
   * Esimate smart fee.
   * @param {Number?} blocks
   * @returns {Promise}
   */

  async estimateFee(blocks) {
    return this.network.feeRate;
  }

  /**
   * Get hash range.
   * @param {Number} start
   * @param {Number} end
   * @returns {Promise}
   */

  async getHashes(start = -1, end = -1) {
    return [this.network.genesis.hash];
  }

  /**
   * Rescan for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @param {Bloom} filter
   * @param {Function} iter - Iterator.
   * @returns {Promise}
   */

  async rescan(start) {
    ;
  }

  /**
   * Get opening bid height.
   * @param {Buffer} nameHash
   * @returns {Object}
   */

  async getNameStatus(nameHash) {
    return new NameState();
  }
}

/*
 * Expose
 */

module.exports = NullClient;
