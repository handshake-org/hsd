/*!
 * blockchain/migrations.js - blockchain data migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const bio = require('bufio');
const {encoding} = bio;
const bdb = require('bdb');
const Network = require('../protocol/network');
const rules = require('../covenants/rules');
const Block = require('../primitives/block');
const CoinView = require('../coins/coinview');
const UndoCoins = require('../coins/undocoins');
const layout = require('./layout');
const AbstractMigration = require('../migrations/migration');
const {
  Migrator,
  oldLayout,
  types
} = require('../migrations/migrator');

/** @typedef {import('../types').Hash} Hash */
/** @typedef {ReturnType<bdb.DB['batch']>} Batch */
/** @typedef {import('../migrations/migrator').types} MigrationType */

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
    this.layout = MigrateMigrations.layout();
  }

  /**
   * @returns {Promise<MigrationType>}
   */

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

    const oldLayout = this.layout.oldLayout;
    const newLayout = this.layout.newLayout;
    let nextMigration = 1;
    const skipped = [];

    const oldMigrations = await this.ldb.keys({
      gte: oldLayout.M.min(),
      lte: oldLayout.M.max(),
      parse: key => oldLayout.M.decode(key)[0]
    });

    for (const id of oldMigrations) {
      b.del(oldLayout.M.encode(id));

      if (id === 1) {
        if (this.options.prune) {
          skipped.push(1);
        }

        nextMigration = 2;
      }
    }

    this.db.writeVersion(b, 2);

    const rawState = this.encodeMigrationState(nextMigration, skipped);
    b.put(newLayout.M.encode(), rawState);
  }

  /**
   * @param {Number} nextMigration
   * @param {Number[]} skipped
   * @returns {Buffer}
   */

  encodeMigrationState(nextMigration, skipped) {
    let size = 4;
    size += encoding.sizeVarint(nextMigration);
    size += encoding.sizeVarint(skipped.length);

    for (const id of skipped)
      size += encoding.sizeVarint(id);

    const bw = bio.write(size);
    bw.writeU32(0);
    bw.writeVarint(nextMigration);
    bw.writeVarint(skipped.length);

    for (const id of skipped)
      bw.writeVarint(id);

    return bw.render();
  }

  static info() {
    return {
      name: 'Migrate ChainDB migrations',
      description: 'ChainDB migration layout has changed.'
    };
  }

  static layout() {
    return {
      oldLayout: {
        M: bdb.key('M', ['uint32'])
      },
      newLayout: {
        M: bdb.key('M')
      }
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
   * @param {ChainMigratorOptions} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-chainstate');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = MigrateChainState.layout();
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

    const rawState = await this.ldb.get(this.layout.R.encode());
    const tipHash = rawState.slice(0, 32);
    const rawTipHeight = await this.ldb.get(this.layout.h.encode(tipHash));
    const tipHeight = rawTipHeight.readUInt32LE(0);
    const pending = {
      coin: 0,
      value: 0,
      burned: 0
    };

    for (let height = 0; height <= tipHeight; height++) {
      const hash = await this.ldb.get(this.layout.H.encode(height));
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

            pending.coin -= 1;
            pending.value -= output.value;
          }
        }

        for (let i = 0; i < tx.outputs.length; i++) {
          const output = tx.outputs[i];

          if (output.isUnspendable())
            continue;

          if (output.covenant.isRegister()) {
            pending.coin += 1;
            pending.burned += output.value;
          }

          if (output.covenant.type >= rules.types.REGISTER
              && output.covenant.type <= rules.types.REVOKE) {
            continue;
          }

          if (output.covenant.isClaim()) {
            if (output.covenant.getU32(5) !== 1)
              continue;
          }

          pending.coin += 1;
          pending.value += output.value;
        }
      }
    }

    // prefix hash + tx (8)
    // we write coin (8) + value (8) + burned (8)
    encoding.writeU64(rawState, pending.coin, 40);
    encoding.writeU64(rawState, pending.value, 40 + 8);
    encoding.writeU64(rawState, pending.burned, 40 + 16);
    b.put(this.layout.R.encode(), rawState);
  }

  /**
   * Get Block (old layout)
   * @param {Hash} hash
   * @returns {Promise<Block>}
   */

  async getBlock(hash) {
    assert(Buffer.isBuffer(hash));
    const raw = await this.ldb.get(this.layout.b.encode(hash));

    if (!raw)
      return null;

    return Block.decode(raw);
  }

  /**
   * Get block view (old layout)
   * @param {Block} block
   * @returns {Promise} - UndoCoins
   */

  async getBlockView(block) {
    const hash = block.hash();
    const view = new CoinView();
    const raw = await this.ldb.get(this.layout.u.encode(hash));

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

  static layout() {
    return {
      // R -> tip hash
      R: bdb.key('R'),
      // h[hash] -> height
      h: bdb.key('h', ['hash256']),
      // H[height] -> hash
      H: bdb.key('H', ['uint32']),
      // b[hash] -> block
      b: bdb.key('b', ['hash256']),
      // u[hash] -> undo coins
      u: bdb.key('u', ['hash256'])
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
    this.layout = MigrateBlockStore.layout();

    this.batchWriteSize = 10000;
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
      gte: this.layout.b.min(),
      lte: this.layout.b.max(),
      keys: true,
      values: true
    });

    let total = 0;

    await iter.each(async (key, value) => {
      const hash = key.slice(1);
      await this.blocks.writeBlock(hash, value);
      parent.del(key);

      if (++total % this.batchWriteSize === 0) {
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
      gte: this.layout.u.min(),
      lte: this.layout.u.max(),
      keys: true,
      values: true
    });

    let total = 0;

    await iter.each(async (key, value) => {
      const hash = key.slice(1);
      await this.blocks.writeUndo(hash, value);
      parent.del(key);

      if (++total % this.batchWriteSize === 0) {
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

  static layout() {
    return {
      // b[hash] -> block
      b: bdb.key('b', ['hash256']),
      // u[hash] -> undo coins
      u: bdb.key('u', ['hash256'])
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
   * @param {ChainMigratorOptions} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('chain-migration-tree-state');
    this.db = options.db;
    this.ldb = options.ldb;
    this.network = options.network;
    this.layout = MigrateTreeState.layout();
  }

  async check() {
    return types.MIGRATE;
  }

  /**
   * @param {Batch} b
   * @returns {Promise}
   */

  async migrate(b) {
    if (this.options.spv) {
      this.db.writeVersion(b, 3);
      return;
    }

    const {treeInterval} = this.network.names;
    const rawState = await this.ldb.get(this.layout.R.encode());
    const tipHash = rawState.slice(0, 32);
    const rawTipHeight = await this.ldb.get(this.layout.h.encode(tipHash));
    const tipHeight = rawTipHeight.readUInt32LE(0);
    const lastCommitHeight = tipHeight - (tipHeight % treeInterval);
    const hash = await this.ldb.get(this.layout.s.encode());
    assert(hash && hash.length === 32);

    // new tree root
    // see chaindb.js TreeState
    const buff = Buffer.alloc(72);
    encoding.writeBytes(buff, hash, 0);
    encoding.writeU32(buff, lastCommitHeight, 32);

    this.db.writeVersion(b, 3);
    b.put(this.layout.s.encode(), buff);
  }

  static info() {
    return {
      name: 'Migrate Tree State',
      description: 'Add compaction information to the tree state.'
    };
  }

  static layout() {
    return {
      // R -> tip hash
      R: bdb.key('R'),
      // h[hash] -> height
      h: bdb.key('h', ['hash256']),
      // s -> tree state
      s: bdb.key('s')
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

    this.migrations = ChainMigrator.migrations;
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

    return this;
  }
}

// List of the migrations with ids
ChainMigrator.migrations = {
  0: MigrateMigrations,
  1: MigrateChainState,
  2: MigrateBlockStore,
  3: MigrateTreeState
};

// Expose migrations
ChainMigrator.MigrateChainState = MigrateChainState;
ChainMigrator.MigrateMigrations = MigrateMigrations;
ChainMigrator.MigrateBlockStore = MigrateBlockStore;
ChainMigrator.MigrateTreeState = MigrateTreeState;

module.exports = ChainMigrator;
