/*!
 * blockstore/level.js - leveldb blockstore for hsd
 * Copyright (c) 2019, Braydon Fuller (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bdb = require('bdb');
const fs = require('bfile');
const AbstractBlockStore = require('./abstract');
const layout = require('./layout');
const {types} = require('./common');

/**
 * LevelDB Block Store
 *
 * @alias module:blockstore:LevelBlockStore
 * @abstract
 */

class LevelBlockStore extends AbstractBlockStore {
  /**
   * Create a blockstore that stores blocks in LevelDB.
   * @constructor
   */

  constructor(options) {
    super(options);

    this.location = options.location;

    this.db = bdb.create({
      location: this.location,
      cacheSize: options.cacheSize,
      compression: false,
      memory: options.memory
    });
  }

  /**
   * This method ensures that the storage directory exists
   * before opening.
   * @returns {Promise}
   */

  async ensure() {
    return fs.mkdirp(this.location);
  }

  /**
   * Opens the block storage.
   * @returns {Promise}
   */

  async open() {
    this.logger.info('Opening LevelBlockStore...');

    await this.db.open();
    await this.db.verify(layout.V.encode(), 'levelblockstore', 0);
  }

  /**
   * Closes the block storage.
   */

  async close() {
    this.logger.info('Closing LevelBlockStore...');

    await this.db.close();
  }

  /**
   * This method stores merkle block data in LevelDB.
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async writeMerkle(hash, data) {
    return this.db.put(layout.b.encode(types.MERKLE, hash), data);
  }

  /**
   * This method stores block undo coin data in LevelDB.
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async writeUndo(hash, data) {
    return this.db.put(layout.b.encode(types.UNDO, hash), data);
  }

  /**
   * This method stores block data in LevelDB.
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async writeBlock(hash, data) {
    return this.db.put(layout.b.encode(types.BLOCK, hash), data);
  }

  /**
   * This method will retrieve merkle block data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async readMerkle(hash) {
    return this.db.get(layout.b.encode(types.MERKLE, hash));
  }

  /**
   * This method will retrieve block undo coin data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async readUndo(hash) {
    return this.db.get(layout.b.encode(types.UNDO, hash));
  }

  /**
   * This method will retrieve block data. Smaller portions of the
   * block (e.g. transactions) can be returned using the offset and
   * length arguments. However, the entire block will be read as the
   * data is stored in a key/value database.
   * @param {Buffer} hash - The block hash
   * @param {Number} offset - The offset within the block
   * @param {Number} length - The number of bytes of the data
   * @returns {Promise}
   */

  async readBlock(hash, offset, length) {
    let raw = await this.db.get(layout.b.encode(types.BLOCK, hash));

    if (offset) {
      if (offset + length > raw.length)
        throw new Error('Out-of-bounds read.');

      raw = raw.slice(offset, offset + length);
    }

    return raw;
  }

  /**
   * This will free resources for storing merkle block data.
   * The block data may not be immediately removed from disk, and will
   * be reclaimed during LevelDB compaction.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async pruneMerkle(hash) {
    if (!await this.hasMerkle(hash))
      return false;

    await this.db.del(layout.b.encode(types.MERKLE, hash));

    return true;
  }

  /**
   * This will free resources for storing the block undo coin data.
   * The block data may not be immediately removed from disk, and will
   * be reclaimed during LevelDB compaction.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async pruneUndo(hash) {
    if (!await this.hasUndo(hash))
      return false;

    await this.db.del(layout.b.encode(types.UNDO, hash));

    return true;
  }

  /**
   * This will free resources for storing the block data. The block
   * data may not be immediately removed from disk, and will be reclaimed
   * during LevelDB compaction.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async pruneBlock(hash) {
    if (!await this.hasBlock(hash))
      return false;

    await this.db.del(layout.b.encode(types.BLOCK, hash));

    return true;
  }

  /**
   * This will check if a merkle block data has been stored
   * and is available.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async hasMerkle(hash) {
    return this.db.has(layout.b.encode(types.MERKLE, hash));
  }

  /**
   * This will check if a block undo coin data has been stored
   * and is available.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async hasUndo(hash) {
    return this.db.has(layout.b.encode(types.UNDO, hash));
  }

  /**
   * This will check if a block has been stored and is available.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async hasBlock(hash) {
    return this.db.has(layout.b.encode(types.BLOCK, hash));
  }

  /**
   * Create batch.
   * @returns {LevelBatch}
   */

  batch() {
    return new LevelBatch(this.db);
  }
}

/**
 * Batch wrapper for the level blockstore.
 * @alias module:blockstore.LevelBatch
 */

class LevelBatch {
  /**
   * Create LevelBatch
   * @param {DB} db
   */

  constructor(db) {
    this.writesBatch = db.batch();
    this.prunesBatch = db.batch();
    this.committedWrites = false;
    this.committedPrunes = false;
  }

  get written() {
    return this.committedPrunes && this.committedWrites;
  }

  /**
   * Write merkle block data to the batch.
   * @property {Buffer} hash
   * @property {Buffer} data
   * @returns {Batch}
   */

  writeMerkle(hash, data) {
    this.writesBatch.put(layout.b.encode(types.MERKLE, hash), data);
    return this;
  }

  /**
   * Write undo coin data to the batch.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Batch}
   */

  writeUndo(hash, data) {
    this.writesBatch.put(layout.b.encode(types.UNDO, hash), data);
    return this;
  }

  /**
   * Write block data to the batch.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Batch}
   */

  writeBlock(hash, data) {
    this.writesBatch.put(layout.b.encode(types.BLOCK, hash), data);
    return this;
  }

  /**
   * Remove merkle block data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneMerkle(hash) {
    this.prunesBatch.del(layout.b.encode(types.MERKLE, hash));
    return this;
  }

  /**
   * Remove undo data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneUndo(hash) {
    this.prunesBatch.del(layout.b.encode(types.UNDO, hash));
    return this;
  }

  /**
   * Prune block data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneBlock(hash) {
    this.prunesBatch.del(layout.b.encode(types.BLOCK, hash));
    return this;
  }

  /**
   * Clear the batch.
   * @returns {Batch}
   */

  clear() {
    assert(!this.written, 'Already written all.');
    this.writesBatch.clear();
    this.prunesBatch.clear();
    return this;
  }

  async commitWrites() {
    assert(!this.committedWrites, 'Already written writes.');

    await this.writesBatch.write();

    this.committedWrites = true;
  }

  async commitPrunes() {
    assert(!this.committedPrunes, 'Already written prunes.');

    await this.prunesBatch.write();

    this.committedPrunes = true;
  }

  /**
   * Write change to the store.
   * @returns {Promise}
   */

  async commit() {
    assert(!this.written, 'Already written all.');

    await this.commitWrites();
    await this.commitPrunes();
  }
}

/*
 * Expose
 */

module.exports = LevelBlockStore;
