/**
 * migrations/abstract.js - abstract migration for hsd.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const bdb = require('bdb');
const MigrationState = require('../migrations/state');

/**
 * This entry needs to be part of all dbs that support migrations.
 * V -> DB Version
 * M -> migration state
 */

const migrationLayout = {
  V: bdb.key('V'),
  M: bdb.key('M')
};

/**
 * Previous layout used M[id]-s to list of executed migrations
 */

const oldLayout = {
  M: bdb.key('M', ['uint32'])
};

const types = {
  MIGRATE: 0,
  SKIP: 1,
  FAKE_MIGRATE: 2
};

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
}

/**
 * class for migrations.
 * @alias module:migrations.Migrations
 */

class Migrations {
  /**
   * Create AbstractMigrations object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.options = options;
    this.logger = Logger.global;

    this.migrations = {};
    this.migrateFlag = false;

    this.layout = migrationLayout;
    this.db = null;
    this.ldb = null;
    this.dbVersion = 0;

    this.fromOptions(options);
  }

  /**
   * Recheck options
   * @private
   */

  fromOptions(options) {
    assert(options, 'Migration options are required.');
    assert(options.db != null, 'options.db is required.');
    assert(options.ldb != null, 'options.ldb is required.');

    assert(typeof options.db === 'object', 'options.db needs to be an object.');
    assert(typeof options.ldb === 'object',
      'options.ldb needs to be an object.');

    this.db = options.db;
    this.ldb = options.ldb;

    if (options.migrations != null) {
      assert(typeof options.migrations === 'object');
      this.migrations = options.migrations;
    }

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.migrateFlag != null) {
      assert(typeof options.migrateFlag === 'boolean');
      this.migrateFlag = options.migrateFlag;
    }

    if (options.layout != null) {
      assert(typeof options.layout === 'object');
      this.layout = options.layout;
    }

    if (options.dbVersion != null) {
      assert(typeof options.dbVersion === 'number');
      this.dbVersion = options.dbVersion;
    }
  }

  /**
   * Do all the migrations
   * @returns {Promise}
   */

  async migrate() {
    assert(this.ldb);

    this.logger.info('Opening DB...');
    await this.ldb.open();

    try {
      return await this._migrate();
    } finally {
      this.logger.info('Closing DB...');
      await this.ldb.close();
    }
  }

  /**
   * Do the actual migrations
   * @returns {Promise}
   */

  async _migrate() {
    await this.ensure();

    const version = await this.ldb.get(this.layout.V.encode());

    if (version === null && this.options.migrateFlag)
      throw new Error('Database does not exist.');

    if (version === null) {
      const state = new MigrationState();
      state.lastMigration = this.getLastMigrationID();

      this.logger.info('Fresh start, saving last migration id: %d',
        state.lastMigration);

      await this.saveState(state);
      return;
    }

    const lastID = this.getLastMigrationID();
    const state = await this.getState();

    this.logger.debug('Last migration %d, last available migration: %d',
      state.lastMigration, lastID);

    for (const id of state.skipped) {
      const skippedMigration = new this.migrations[id](this.options);
      this.logger.warning(skippedMigration.warning());
    }

    if (state.inProgress) {
      this.logger.info('Continue progress on migration: ',
        state.lastMigration + 1);
    }

    let hasMigrated = false;
    for (let i = state.lastMigration + 1; i <= lastID; i++) {
      const currentMigration = new this.migrations[i](this.options);
      const type = await currentMigration.check();

      switch (type)  {
        case types.FAKE_MIGRATE: {
          this.logger.info('Does not apply, fake migrating %d.', i);
          state.lastMigration = i;
          await this.saveState(state);
          break;
        }
        case types.SKIP: {
          this.logger.info('Can not migrate, skipping %d.', i);
          this.logger.warning(currentMigration.warning());
          state.lastMigration = i;
          state.skipped.push(i);
          await this.saveState(state);
          break;
        }
        case types.MIGRATE: {
          if (!this.options.migrateFlag)
            throw new Error('Database needs migration.');

          state.inProgress = true;
          await this.saveState(state);

          this.logger.info('Migration %d in progress..', i);
          const batch = this.ldb.batch();
          await currentMigration.migrate(batch);

          state.inProgress = false;
          state.lastMigration = i;
          this.writeState(batch, state);

          await batch.write();
          this.logger.info('Migration %d is done.', i);
          hasMigrated = true;
          break;
        }
        default:
          throw new Error('Unknown migration type.');
      }
    }

    if (!hasMigrated && this.options.migrateFlag)
      throw new Error('There are no available migrations.');
  }

  /**
   * Ensure we have migration entry in DB.
   * Do migration of the old migration states.
   */

  async ensure() {
    const migrations = await this.ldb.get(this.layout.M.encode());

    // This could mean two things:
    //  1. database is new.
    //  2. we are migrating from old version.
    if (!migrations) {
      const b = this.ldb.batch();
      const state = new MigrationState();

      // move migration entries if we are migrating
      // from old version with Migrations.
      // p.s. if there are no migrations:
      //  1. database is new
      //  2. we are migrating from even older version.
      const oldMigrations = await this.ldb.keys({
        gte: oldLayout.M.min(),
        lte: oldLayout.M.max(),
        parse: key => oldLayout.M.decode(key)[0]
      });

      let max = -1;
      for (const id of oldMigrations) {
        b.del(oldLayout.M.encode(id));
        max = Math.max(id, max);
      }

      if (max > -1)
        state.lastMigration = max;

      b.put(this.layout.M.encode(), state.encode());
      await b.write();
      return;
    }
  }

  /**
   * Get max migration ID from the map
   * @returns {Number}
   */

  getLastMigrationID() {
    const ids = Object.keys(this.migrations);

    if (ids.length === 0)
      return 0;

    return Math.max(...ids);
  }

  /**
   * Save state
   * @param {MigrationState} state
   */

  async saveState(state) {
    const batch = this.ldb.batch();
    this.writeState(batch, state);
    await batch.write();
  }

  /**
   * Write state
   * @param {Batch} b
   * @param {MigrationState} state
   */

  writeState(b, state) {
    b.put(this.layout.M.encode(), state.encode());
  }

  /**
   * Get state
   * @returns {Promise<MigrationState>}
   */

  async getState() {
    const data = await this.ldb.get(this.layout.M.encode());
    assert(data, 'State was corrupted.');
    return MigrationState.decode(data);
  }
}

exports.Migrations = Migrations;
exports.AbstractMigration = AbstractMigration;
exports.types = types;
