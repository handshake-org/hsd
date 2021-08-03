/**
 * migrations/migration.js - abstract migration for hsd.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License)
 */

'use strict';

/**
 * Abstract class for single migration.
 * @alias module:migrations.AbstractMigration
 */

class AbstractMigration {
  /**
   * Create migration object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.logger = options.logger.context('migration');
  }

  /**
   * Check if the migration applies to the database
   * @returns {Promise}
   */

  async check() {
    throw new Error('Abstract method.');
  }

  /**
   * Run the actual migration
   * @param {Batch} batch
   * @returns {Promise}
   */

  async migrate() {
    throw new Error('Abstract method.');
  }

  /**
   * Log warnings for skipped migrations.
   */

  warning() {
    this.logger.warning('no warnings available.');
  }

  /**
   * Return information about the migraiton
   * @returns {Object}
   */

  static info() {
    return {
      name: 'abstract migration',
      description: 'abstract description'
    };
  }
}

module.exports = AbstractMigration;
