/*!
 * blockchain/migrations.js - blockchain data migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const Network = require('../protocol/network');
const rules = require('../covenants/rules');
const layout = require('./layout');
const MigrationState = require('../migrations/state');
const {
  AbstractMigration,
  Migrations,
  oldLayout,
  types
} = require('../migrations/migrations');

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
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-chainstate');
    this.db = options.db;
  }

  /**
   * Check if the migration applies to the database
   * @returns {Promise}
   */

  async check() {
    if (this.options.spv)
      return types.FAKE_MIGRATE;

    if (this.options.prune)
      return types.SKIP;

    return types.MIGRATE;
  }

  /**
   * Log warnings when skipped.
   */

  warning() {
    if (!this.options.prune)
      throw new Error('No warnings to show!');

    this.logger.warning('Pruned nodes cannot migrate the chain state.');
    this.logger.warning('Your total chain value may be inaccurate!');
  }

  /**
   * Actual migration
   * @param {Batch} b
   * @returns {Promise<Boolean>}
   */

  async migrate(b) {
    this.logger.info('Migrating chain state.');
    this.logger.info('This may take a few minutes...');

    const state = await this.db.getState();
    const tipHeight = await this.db.getHeight(state.tip);
    const pending = state.clone();

    pending.coin = 0;
    pending.value = 0;
    pending.burned = 0;

    for (let height = 0; height <= tipHeight; height++) {
      const hash = await this.db.getHash(height);
      const block = await this.db.getBlock(hash);
      assert(block);

      const view = await this.db.getBlockView(block);

      for (let i = 0; i < block.txs.length; i++) {
        const tx = block.txs[i];

        if (i > 0) {
          for (const {prevout} of tx.inputs) {
            const output = view.getOutput(prevout);
            assert(output);

            if (output.covenant.type >= rules.types.REGISTER
                && output.covenant.type <= rules.types.REVOKE) {
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

          if (output.covenant.type >= rules.types.REGISTER
              && output.covenant.type <= rules.types.REVOKE) {
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

  static info() {
    return 'Chain state is corrupted. \n' +
      'Restart with `hsd --chain-migrate`.';
  }
}

/**
 * ChainMigrations
 * @alias module:blockchain.ChainMigrations
 */
class ChainMigrations extends Migrations {
  /**
   * Create ChainMigrations object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new ChainMigrationOptions(options));

    this.logger = this.options.logger.context('chain-migrations');
  }

  /**
   * Ensure state is migrated.
   * @returns {Promise}
   */

  async ensure() {
    // We are already on the latest update.
    if (await this.ldb.get(this.layout.M.encode()))
      return;

    const b = this.ldb.batch();
    const state = new MigrationState();

    const oldMigrations = await this.ldb.keys({
      gte: oldLayout.M.min(),
      lte: oldLayout.M.max(),
      parse: key => oldLayout.M.decode(key)[0]
    });

    let max = 0;
    for (const id of oldMigrations) {
      b.del(oldLayout.M.encode(id));
      max = Math.max(id, max);
    }

    if (max === 1) {
      if (this.options.prune)
        state.skipped.push(1);
      state.lastMigration = 1;
    }

    b.put(this.layout.M.encode(), state.encode());

    await b.write();
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

    this.migrations = exports.migrations;
    this.migrateFlag = false;

    this.dbVersion = 0;
    this.db = null;
    this.ldb = null;
    this.layout = layout;

    this.spv = false;
    this.prune = false;

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
      this.db = options.chainDB;
      this.ldb = this.db.db;
    }

    if (options.chainMigrate != null) {
      assert(typeof options.chainMigrate === 'boolean');
      this.migrateFlag = options.chainMigrate;
    }

    if (options.dbVersion != null) {
      assert(typeof options.dbVersion === 'number');
      this.dbVersion = options.dbVersion;
    }

    if (options.migrations != null) {
      assert(typeof options.migrations === 'object');
      this.migrations = options.migrations;
    }

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }
  }
}

exports = ChainMigrations;

// List of the migratoins with ids
exports.migrations = {
  1: MigrateChainState
};

// Expose migrations
exports.MigrateChainState = MigrateChainState;

module.exports = exports;
