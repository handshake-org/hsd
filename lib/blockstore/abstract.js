/*!
 * blockstore/abstract.js - abstract blockstore for hsd
 * Copyright (c) 2019, Braydon Fuller (MIT License).
 * Copyright (c) 2020, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const Logger = require('blgr');

/**
 * Abstract Block Store
 *
 * @alias module:blockstore.AbstractBlockStore
 * @abstract
 */

class AbstractBlockStore {
  /**
   * Create an abstract blockstore.
   * @constructor
   */

  constructor(options) {
    this.options = options || {};

    if (this.options.logger != null)
      this.logger = this.options.logger.context('blockstore');
    else
      this.logger = Logger.global.context('blockstore');
  }

  /**
   * This method ensures that resources are available
   * before opening.
   * @returns {Promise}
   */

  async ensure() {
    throw new Error('Abstract method.');
  }

  /**
   * This method opens any necessary resources and
   * initializes the store to be ready to be queried.
   * @returns {Promise}
   */

  async open() {
    throw new Error('Abstract method.');
  }

  /**
   * This method closes resources and prepares
   * the store to be closed.
   * @returns {Promise}
   */

  async close() {
    throw new Error('Abstract method.');
  }

  /**
   * This method stores merkle blocks including
   * all the relevant transactions.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Promise}
   */

  async writeMerkle(hash, data) {
    throw new Error('Abstract method.');
  }

  /**
   * This method stores block undo coin data.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Promise}
   */

  async writeUndo(hash, data) {
    throw new Error('Abstract method.');
  }

  /**
   * This method stores block data.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Promise}
   */

  async writeBlock(hash, data) {
    throw new Error('Abstract method.');
  }

  /**
   * This method reads merkle block data.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async readMerkle(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This method will retrieve block undo coin data.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async readUndo(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This method will retrieve block data. Smaller portions of
   * the block can be read by using the offset and size arguments.
   * @param {Buffer} hash
   * @param {Number} offset
   * @param {Number} size
   * @returns {Promise}
   */

  async readBlock(hash, offset, size) {
    throw new Error('Abstract method.');
  }

  /**
   * This will free resources for storing the merkle block data.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async pruneMerkle(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This will free resources for storing the block undo coin data.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async pruneUndo(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This will free resources for storing the block data.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async pruneBlock(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This will check if merkle block data has been stored
   * and is available.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async hasMerkle(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This will check if a block undo coin data has been stored
   * and is available.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async hasUndo(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * This will check if a block has been stored and is available.
   * @param {Buffer} hash
   * @returns {Promise}
   */

  async hasBlock(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * Create batch.
   * @returns {Batch}
   */

  batch() {
    throw new Error('Abstract method.');
  }
}

/**
 * This class is just interface for file and level batches.
 * @alias module:blockstore.AbstractBatch
 * @abstract
 */

// eslint-disable-next-line no-unused-vars
class AbstractBatch {
  /**
   * Create AbstractBatch.
   * @constructor
   */

  constructor() {
  }

  /**
   * Write merkle block data to the batch.
   * @property {Buffer} hash
   * @property {Buffer} data
   * @returns {Batch}
   */

  writeMerkle(hash, data) {
    throw new Error('Abstract method.');
  }

  /**
   * Write undo coin data to the batch.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Batch}
   */

  writeUndo(hash, data) {
    throw new Error('Abstract method.');
  }

  /**
   * Write block data to the batch.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Batch}
   */

  writeBlock(hash, data) {
    throw new Error('Abstract method.');
  }

  /**
   * Remove merkle block data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneMerkle(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * Remove undo data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneUndo(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * Prune block data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneBlock(hash) {
    throw new Error('Abstract method.');
  }

  /**
   * Clear the batch.
   * @returns {Batch}
   */

  clear() {
    throw new Error('Abstract method.');
  }

  /**
   * Write change to the store.
   * @returns {Promise}
   */

  write() {
    throw new Error('Abstract method.');
  }
}

/*
 * Expose
 */

module.exports = AbstractBlockStore;
