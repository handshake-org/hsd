/*!
 * chaindb.js - blockchain data migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bdb = require('bdb');
const Logger = require('blgr');
const Network = require('../protocol/network');
const rules = require('../covenants/rules');
const AbstractMigration = require('../migrations/abstract');
const MigrationState = require('../migrations/state');
const layout = require('./layout');
const {types} = rules;

const oldLayout = {
  M: bdb.key('M', ['uint32'])
};

/**
 * Migrate chain state and correct total supply.
 * Applies to ChainDB v1
 */

class MigrateChainState extends AbstractMigration {
  /**
   * Create migration chain state
   * @constructor
   * @param {ChainMigrations} options
   */

  constructor(options) {
    super();

    this.options = options;
    this.logger = options.logger.context('chain-migration-chainstate');
    this.db = options.db;
  }

  /**
   * Actual migration
   * @param {Batch} b
   * @returns {Promise<Boolean>}
   */

  async migrate(b) {
    if (this.options.spv)
      return true;

    if (this.options.prune) {
      this.logger.warning('Pruned nodes cannot migrate the chain state.');
      this.logger.warning('Your total chain value may be inaccurate!');
      return true;
    }

    this.logger.info('Migrating chain state.');
    this.logger.info('This may take a few minutes...');

    const state = await this.chainDB.getstate();
    const tipHeight = await this.chainDB.getHeight(state.tip);
    const pending = state.clone();

    pending.coin = 0;
    pending.value = 0;
    pending.burned = 0;

    for (let height = 0; height <= tipHeight; height++) {
      const hash = await this.chainDB.getHash(height);
      const block = await this.chainDB.getBlock(hash);
      assert(block);

      const view = await this.chainDB.getBlockView(block);

      for (let i = 0; i < block.txs.length; i++) {
        const tx = block.txs[i];

        if (i > 0) {
          for (const {prevout} of tx.inputs) {
            const output = view.getOutput(prevout);
            assert(output);

            if (output.covenant.type >= types.REGISTER
                && output.covenant.type <= types.REVOKE) {
              continue;
            }

            pending.spend(output);
          }
        }

        for (let i = 0; i < tx.outputs.length; i++) {
          const output = tx.outputs[i];

          if (output.isUnspendable())
            continue;

          if (output.covenant.isRegister())
            pending.burn(output);

          if (output.covenant.type >= types.REGISTER
              && output.covenant.type <= types.REVOKE) {
            continue;
          }

          if (output.covenant.isClaim()) {
            if (output.covenant.getU32(5) !== 1)
              continue;
          }

          pending.add(output);
        }
      }
    }

    b.put(layout.R.encode(), pending.encode());
    return true;
  }
}

const migrations = {
  1: MigrateChainState
};

/**
 * ChainMigrations
 * There are two assumptions in the Migrations:
 *  1. layout.V - will be used for Versioning
 *  2. layout.M - will be used for Migrations
 * @alias module:blockchain.ChainMigrations
 */
class ChainMigrations {
  /**
   * Create ChainMigrations object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.options = new ChainMigrationOptions(options);
    this.db = this.options.db;
    this.logger = this.options.logger.context('chain-migrations');
  }

  /**
   * Do all the migrations
   * @returns {Promise}
   */

  async migrate() {
    this.logger.info('Opening ChainDB...');
    await this.db.open();

    try {
      return await this._migrate();
    } finally {
      this.logger.info('Closing ChainDB...');
      await this.db.close();
    }
  }

  /**
   * Do the actual migrations
   * @returns {Promise}
   */

  async _migrate() {
    await this.ensure();

    const version = await this.db.get(layout.V.encode());

    if (version === null && this.options.chainMigrate)
      throw new Error('Database does not exist.');

    if (version === null) {
      const state = new MigrationState();
      state.lastMigration = this.getLastMigrationID();

      this.logger.info('Fresh start, saving last migration id: %d',
        state.lastMigration);

      // Save STATE
      // await this.saveState(state);
      return;
    }

    const lastID = this.getLastMigrationID();
    const state = await this.getState();

    if (state.inProgress) {
      this.logger.info('Continue progress on migration: ',
        state.lastMigration + 1);
    }

    let hasMigrated = false;
    for (let i = state.lastMigration + 1; i <= lastID; i++) {
      if (!this.options.chainMigrate)
        throw new Error('Database needs migration');

      state.inProgress = true;
      await this.saveState(state);

      this.logger.info('Migration %d in progress..', i);
      const batch = this.db.batch();
      const currentMigration = new migrations[i](this.options);
      await currentMigration.migrate(batch);

      this.logger.info('Migration %d is done.');

      hasMigrated = true;
    }

    if (!hasMigrated && this.options.chainMigrate)
      throw new Error('There are no available migrations.');
  }

  /**
   * Get max migration ID from the map
   * @returns {Number}
   */

  getLastMigrationID() {
    const ids = Object.keys(migrations);

    return Math.max(...ids);
  }

  /**
   * Ensure we have migration entry in DB.
   * Do migration of the old migration states.
   */

  async ensure() {
    const migrations = await this.db.get(layout.M.encode());

    // This could mean two things:
    //  1. database is new.
    //  2. we are migrating from old version.
    if (!migrations) {
      const b = this.db.batch();
      const state = new MigrationState();

      // move migration logs if we are migrating
      // from old version with Migrations.
      // p.s. if there are no migrations:
      //  1. database is new
      //  2. we are migrating from even older version.
      const oldMigrations = await this.db.keys({
        gte: oldLayout.M.min(),
        lte: oldLayout.M.max(),
        parse: key => oldLayout.M.decode(key)[0]
      });

      let max = -1;
      for (const migrationID of oldMigrations) {
        b.del(oldLayout.M.encode(migrationID));
        max = Math.max(migrationID, max);
      }

      if (max > -1)
        state.lastMigration = max;

      b.write(layout.M.encode(), state.encode());

      console.log('-- Here should be the batch.write');

      return;
    }
  }

  /**
   * Save state
   * @param {MigrationState} state
   */

  async saveState(state) {
    await this.db.put(layout.M.encode(), state.encode());
  }

  /**
   * Get state
   * @returns {Promise<MigrationState>}
   */

  async getState() {
    const data = await this.db.get(layout.M.encode());
    assert(data);
    return MigrationState.decode(data);
  }
}

/**
 * ChainMigrationOptions
 * @alias module:blockchain.ChainMigrationOptions
 */

class ChainMigrationOptions {
  /**
   * Create Chain Migration Options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;

    this.dbVersion = 0;
    this.chainDB = null;
    this.db = null;
    this.spv = false;
    this.prune = false;

    this.chainMigrate = false;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @param {Object} options
   * @returns {ChainMigrationOptions}
   */

  fromOptions(options) {
    if (options.network != null)
      this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.chainDB != null) {
      assert(typeof options.chainDB === 'object');
      this.chainDB = options.chainDB;
      this.db = this.chainDB.db;
    }

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }

    if (options.chainMigrate != null) {
      assert(typeof options.chainMigrate === 'boolean');
      this.chainMigrate = options.chainMigrate;
    }

    if (options.dbVersion != null) {
      assert(typeof options.dbVersion === 'number');
      this.dbVersion = options.dbVersion;
    }
  }
}

module.exports = ChainMigrations;
