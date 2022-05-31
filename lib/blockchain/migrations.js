/*!
 * blockchain/migrations.js - blockchain data migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const {encoding} = require('bufio');
const Network = require('../protocol/network');
const rules = require('../covenants/rules');
const Block = require('../primitives/block');
const CoinView = require('../coins/coinview');
const UndoCoins = require('../coins/undocoins');
const layout = require('./layout');
const MigrationState = require('../migrations/state');
const AbstractMigration = require('../migrations/migration');
const {
  Migrator,
  oldLayout,
  types
} = require('../migrations/migrator');

/**
 * Switch to new migrations layout.
 */

class MigrateMigrations extends AbstractMigration {
  /**
   * Create migrations migration.
   * @param {ChainMigratorOptions} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-migrate');
    this.db = options.db;
    this.ldb = options.ldb;
  }

  async check() {
    return types.MIGRATE;
  }

  /**
   * Actual migration
   * @param {Batch} b
   * @returns {Promise}
   */

  async migrate(b) {
    this.logger.info('Migrating migrations..');
    const state = new MigrationState();
    state.nextMigration = 1;

    const oldMigrations = await this.ldb.keys({
      gte: oldLayout.M.min(),
      lte: oldLayout.M.max(),
      parse: key => oldLayout.M.decode(key)[0]
    });

    for (const id of oldMigrations) {
      b.del(oldLayout.M.encode(id));

      if (id === 1) {
        if (this.options.prune)
          state.skipped.push(1);

        state.nextMigration = 2;
      }
    }

    this.db.writeVersion(b, 2);
    b.put(layout.M.encode(), state.encode());
  }

  static info() {
    return {
      name: 'Migrate ChainDB migrations',
      description: 'ChainDB migration layout has changed.'
    };
  }
}

/**
 * Migrate chain state and correct total supply.
 * Applies to ChainDB v1
 */

class MigrateChainState extends AbstractMigration {
  /**
   * Create migration chain state
   * @constructor
   * @param {ChainMigrator} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-chainstate');
    this.db = options.db;
    this.ldb = options.ldb;
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
   * @returns {Promise}
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
      const block = await this.getBlock(hash);
      assert(block);

      const view = await this.getBlockView(block);

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
  }

  /**
   * Get Block (old layout)
   * @param {Hash} hash
   * @returns {Promise} - Block
   */

  async getBlock(hash) {
    assert(Buffer.isBuffer(hash));
    const raw = await this.ldb.get(layout.b.encode(hash));

    if (!raw)
      return null;

    return Block.decode(raw);
  }

  /**
   * Get block view (old layout)
   * @param {Hash} hash
   * @returns {Promise} - UndoCoins
   */

  async getBlockView(block) {
    const hash = block.hash();
    const view = new CoinView();
    const raw = await this.ldb.get(layout.u.encode(hash));

    if (!raw)
      return view;

    // getBlockView logic.
    const undo = UndoCoins.decode(raw);

    if (undo.isEmpty())
      return view;

    for (let i = block.txs.length - 1; i > 0; i--) {
      const tx = block.txs[i];

      for (let j = tx.inputs.length - 1; j >= 0; j--) {
        const input = tx.inputs[j];
        undo.apply(view, input.prevout);
      }
    }

    // Undo coins should be empty.
    assert(undo.isEmpty(), 'Undo coins data inconsistency.');

    return view;
  }

  static info() {
    return {
      name: 'Chain State migration',
      description: 'Chain state is corrupted.'
    };
  }
}

/**
 * Migrate block and undo data to BlockStore from chainDB.
 */

class MigrateBlockStore extends AbstractMigration {
  /**
   * Create MigrateBlockStore object.
   * @param {ChainMigratorOptions} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-blockstore');
    this.db = options.db;
    this.ldb = options.ldb;
    this.blocks = options.db.blocks;
  }

  /**
   * Check if the ChainDB has the blocks.
   * @returns {Promise}
   */

  async check() {
    if (this.options.spv)
      return types.FAKE_MIGRATE;

    return types.MIGRATE;
  }

  /**
   * Migrate blocks and undo blocks
   * @param {Batch} b
   * @returns {Promise}
   */

  async migrate() {
    assert(this.blocks, 'Could not find blockstore.');

    this.logger.info('Migrating blocks and undo blocks.');
    this.logger.info('This may take a few minutes...');

    await this.migrateBlocks();
    await this.migrateUndoBlocks();

    this.logger.info('Compacting database...');
    this.logger.info('This may take a few minutes...');
    await this.ldb.compactRange();
  }

  /**
   * Migrate the block data.
   */

  async migrateBlocks() {
    this.logger.info('Migrating blocks...');
    let parent = this.ldb.batch();

    const iter = this.ldb.iterator({
      gte: layout.b.min(),
      lte: layout.b.max(),
      keys: true,
      values: true
    });

    let total = 0;

    await iter.each(async (key, value) => {
      const hash = key.slice(1);
      await this.blocks.writeBlock(hash, value);
      parent.del(key);

      if (++total % 10000 === 0) {
        await parent.write();
        this.logger.debug('Migrated up %d blocks.', total);
        parent = this.ldb.batch();
      }
    });

    await parent.write();
    this.logger.info('Migrated all %d blocks.', total);
  }

  /**
   * Migrate the undo data.
   */

  async migrateUndoBlocks() {
    this.logger.info('Migrating undo blocks...');

    let parent = this.ldb.batch();

    const iter = this.ldb.iterator({
      gte: layout.u.min(),
      lte: layout.u.max(),
      keys: true,
      values: true
    });

    let total = 0;

    await iter.each(async (key, value) => {
      const hash = key.slice(1);
      await this.blocks.writeUndo(hash, value);
      parent.del(key);

      if (++total % 10000 === 0) {
        await parent.write();
        this.logger.debug('Migrated up %d undo blocks.', total);
        parent = this.ldb.batch();
      }
    });

    await parent.write();
    this.logger.info('Migrated all %d undo blocks.', total);
  }

  static info() {
    return {
      name: 'BlockStore migration',
      description: 'Move block and undo data to the'
        + ' blockstore from the chainDB.'
    };
  }
};

/**
 * Migrate Tree State
 */

class MigrateTreeState extends AbstractMigration {
  /**
   * Create tree state migrator
   * @constructor
   * @param {ChainMigrator} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-tree-state');
    this.db = options.db;
    this.ldb = options.ldb;
    this.network = options.network;
  }

  async check() {
    return types.MIGRATE;
  }

  async migrate(b) {
    if (this.options.spv) {
      this.db.writeVersion(b, 3);
      return;
    }

    const {treeInterval} = this.network.names;
    const state = await this.db.getState();
    const tipHeight = await this.db.getHeight(state.tip);
    const lastCommitHeight = tipHeight - (tipHeight % treeInterval);
    const hash = await this.ldb.get(layout.s.encode());
    assert(hash && hash.length === 32);

    // new tree root
    // see chaindb.js TreeState
    const buff = Buffer.alloc(72);
    encoding.writeBytes(buff, hash, 0);
    encoding.writeU32(buff, lastCommitHeight, 32);

    this.db.writeVersion(b, 3);
    b.put(layout.s.encode(), buff);
  }

  static info() {
    return {
      name: 'Migrate Tree State',
      description: 'Add compaction information to the tree state.'
    };
  }
}

/**
 * Chain Migrator
 * @alias module:blockchain.ChainMigrator
 */
class ChainMigrator extends Migrator {
  /**
   * Create ChainMigrator object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new ChainMigratorOptions(options));

    this.logger = this.options.logger.context('chain-migrations');
    this.flagError = 'Restart with `hsd --chain-migrate='
      + this.lastMigration + '`';

    this._migrationsToRun = null;
  }

  /**
   * Check chaindb flags
   * @returns {Promise}
   */

  async verifyDB() {
    await this.db.verifyFlags();
  }

  /**
   * Get list of migrations to run
   * @returns {Promise<Set>}
   */

  async getMigrationsToRun() {
    const state = await this.getState();
    const lastID = this.getLastMigrationID();

    if (state.nextMigration > lastID)
      return new Set();

    const ids = new Set();

    for (let i = state.nextMigration; i <= lastID; i++)
      ids.add(i);

    if (state.nextMigration === 0 && await this.ldb.get(oldLayout.M.encode(1)))
      ids.delete(1);

    return ids;
  }
}

/**
 * ChainMigratorOptions
 * @alias module:blockchain.ChainMigratorOptions
 */

class ChainMigratorOptions {
  /**
   * Create Chain Migrator Options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;

    this.migrations = exports.migrations;
    this.migrateFlag = -1;

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
   * @returns {ChainMigratorOptions}
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
      assert(typeof options.chainMigrate === 'number');
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

exports = ChainMigrator;

// List of the migrations with ids
exports.migrations = {
  0: MigrateMigrations,
  1: MigrateChainState,
  2: MigrateBlockStore,
  3: MigrateTreeState
};

// Expose migrations
exports.MigrateChainState = MigrateChainState;
exports.MigrateMigrations = MigrateMigrations;
exports.MigrateBlockStore = MigrateBlockStore;
exports.MigrateTreeState = MigrateTreeState;

module.exports = exports;
