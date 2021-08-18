/**
 * migrations/migrator.js - abstract migrator for hsd.
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
 * Store migration results.
 * @alias module:migrations.MigrationResult
 */

class MigrationResult {
  constructor() {
    this.migrated = new Set();
    this.skipped = new Set();
  }

  skip(id) {
    this.skipped.add(id);
  }

  migrate(id) {
    this.migrated.add(id);
  }
}

/**
 * class for migrations.
 * @alias module:migrations.Migrator
 */

class Migrator {
  /**
   * Create Migrator object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.options = options;
    this.logger = Logger.global;

    this.migrations = {};
    this.migrateFlag = -1;

    this.layout = migrationLayout;
    this.db = null;
    this.ldb = null;
    this.dbVersion = 0;

    this.pending = new MigrationResult();

    this.flagError = '';

    this.fromOptions(options);

    this.lastMigration = this.getLastMigrationID();
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
      assert(typeof options.migrateFlag === 'number');
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
   * Do the actual migrations
   * @returns {Promise}
   */

  async migrate() {
    const version = await this.ldb.get(this.layout.V.encode());
    const lastID = this.getLastMigrationID();

    if (version === null) {
      if (this.migrateFlag !== -1) {
        if (this.migrateFlag !== lastID) {
          throw new Error(
            `Migrate flag ${this.migrateFlag} does not match last ID: ${lastID}`
          );
        }

        this.logger.warning('Fresh start, ignoring migration flag.');
      }

      const state = new MigrationState();
      state.nextMigration = this.getLastMigrationID() + 1;

      this.logger.info('Fresh start, saving last migration id: %d',
        state.lastMigration);

      await this.saveState(state);
      return this.pending;
    }

    await this.ensure();
    await this.verifyDB();
    await this.checkMigrations();

    let state = await this.getState();

    if (this.migrateFlag !== -1 && this.migrateFlag !== lastID) {
      throw new Error(
        `Migrate flag ${this.migrateFlag} does not match last ID: ${lastID}`
      );
    }

    this.logger.debug('Last migration %d, last available migration: %d',
      state.lastMigration, lastID);
    this.logger.info('There are %d migrations.', lastID - state.lastMigration);

    for (const id of state.skipped) {
      const skippedMigration = new this.migrations[id](this.options);
      skippedMigration.warning();
    }

    if (state.inProgress)
      this.logger.info('Continue progress on migration: ', state.nextMigration);

    while (state.nextMigration <= lastID) {
      const id = state.nextMigration;
      const currentMigration = new this.migrations[id](this.options);
      const type = await currentMigration.check();

      switch (type)  {
        case types.FAKE_MIGRATE: {
          this.logger.info('Migration %d does not apply, fake migrating.', id);

          state.nextMigration = id + 1;
          this.pending.migrate(id);
          await this.saveState(state);

          break;
        }
        case types.SKIP: {
          this.logger.info('Migration %d can not run, skipping.', id);

          currentMigration.warning();

          state.nextMigration = id + 1;
          state.skipped.push(id);
          this.pending.skip(id);
          await this.saveState(state);

          break;
        }
        case types.MIGRATE: {
          assert(this.migrateFlag > -1);

          state.inProgress = true;
          await this.saveState(state);

          this.logger.info('Migration %d in progress...', id);
          const batch = this.ldb.batch();

          // queue state updates first, so migration can modify the state.
          state.inProgress = false;
          state.nextMigration = id + 1;
          this.writeState(batch, state);

          await currentMigration.migrate(batch, this.pending);
          await batch.write();
          this.pending.migrate(id);
          this.logger.info('Migration %d is done.', id);

          break;
        }
        default:
          throw new Error('Unknown migration type.');
      }

      state = await this.getState();
    }

    return this.pending;
  }

  /**
   * Get migration list
   */

  async checkMigrations() {
    const lastID = this.getLastMigrationID();
    const ids = await this.getMigrationsToRun();

    if (ids.size === 0) {
      this.logger.debug('There are no migrations pending. last id: %d',
        lastID);
      return;
    }

    let error = 'Database needs migration(s):\n';

    for (const id of ids) {
      const MigrationClass = this.migrations[id];
      assert(MigrationClass);
      const info = MigrationClass.info();
      error += `  - ${info.name} - ${info.description}\n`;
    }

    if (this.migrateFlag !== lastID) {
      error += this.flagError;
      this.logger.error(error);
      throw new Error(error);
    }

    this.logger.info(error);
  }

  /**
   * Do any necessary database checks
   * @returns {Promise}
   */

  async verifyDB() {
  }

  /**
   * Get list of migrations to run
   * @returns {Promise<Set>}
   */

  async getMigrationsToRun() {
    const state = await this.getState();
    const lastID = this.getLastMigrationID();
    const ids = new Set();

    for (let i = state.nextMigration; i <= lastID; i++)
      ids.add(i);

    return ids;
  }

  /**
   * Ensure we have migration entry in DB.
   * @returns {Promise}
   */

  async ensure() {
    if (await this.ldb.get(this.layout.M.encode()))
      return;

    const state = new MigrationState();
    await this.ldb.put(this.layout.M.encode(), state.encode());
  }

  /**
   * Get max migration ID from the map
   * @returns {Number}
   */

  getLastMigrationID() {
    const ids = Object.keys(this.migrations);

    if (ids.length === 0)
      return -1;

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

exports.Migrator = Migrator;
exports.MigrationResult = MigrationResult;
exports.types = types;
exports.oldLayout = oldLayout;
