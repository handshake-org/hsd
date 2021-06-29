/**
 * migrations/abstract.js - abstract migration for hsd.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License)
 */

'use strict';

/**
 * Abstract class for migrations
 * @alias module:blockchain.AbstractMigration
 */

class AbstractMigration {
  /**
   * Create migration object.
   * @constructor
   * @param {Object} options
   */

  constructor() {
  }

  /**
   * Run the actual migration
   * @param {Batch} batch
   * @returns {Promise}
   */

  async migrate(batch) {
    throw new Error('Abstract method.');
  }
}

module.exports = AbstractMigration;
