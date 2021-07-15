/*!
 * wallet/migrations.js - blockchain data migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const Network = require('../protocol/network');
const {
  AbstractMigration,
  MigrationResult,
  Migrations,
  types,
  oldLayout
} = require('../migrations/migrations');
const MigrationState = require('../migrations/state');
const layouts = require('./layout');
const layout = layouts.wdb;

/**
 * Switch to new migrations layout.
 */

class MigrateMigrations extends AbstractMigration {
  /**
   * Create migrations migration.
   * @param {ChainMigrations} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('wallet-migrations-migrate');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = options.layout;
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

    if (await this.ldb.get(oldLayout.M.encode(0))) {
      b.del(oldLayout.M.encode(0));
      state.nextMigration = 2;
    }

    this.db.writeVersion(b, 1);
    b.put(this.layout.M.encode(), state.encode());
  }

  static info() {
    return {
      name: 'Migrate wallet migrations',
      description: 'Wallet migration layout has changed.'
    };
  }
}

/**
 * Run change address migration.
 * Applies to WalletDB v0
 */

class MigrateChangeAddress extends AbstractMigration {
  /**
   * Create change address migration object.
   * @constructor
   * @param {WalletMigrations} options
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('change-address-migration');
    this.db = options.db;
    this.ldb = options.ldb;
  }

  /**
   * Migration and check for the change address
   * are done in the same step.
   */

  async check() {
    return types.MIGRATE;
  }

  /**
   * Actual migration
   * @param {Batch} b
   * @param {WalletMigrationResult} pending
   * @returns {Promise}
   */

  async migrate(b, pending) {
    const wids = await this.ldb.keys({
      gte: layout.W.min(),
      lte: layout.W.max(),
      parse: key => layout.W.decode(key)[0]
    });

    let total = 0;
    for (const wid of wids) {
      const wallet = await this.db.get(wid);

      this.logger.info('Checking wallet (id=%s, wid=%d).',
                       wallet.id, wid);

      total += await this.migrateWallet(b, wallet);
    }

    if (total > 0)
      pending.rescan = true;
  }

  async migrateWallet(b, wallet) {
    let total = 0;
    for (let i = 0; i < wallet.accountDepth; i++) {
      const account = await wallet.getAccount(0);

      for (let i = 0; i < account.changeDepth + account.lookahead; i++) {
        const key = account.deriveChange(i);
        const path = key.toPath();

        if (!await this.db.hasPath(account.wid, path.hash)) {
          await this.db.savePath(b, account.wid, path);
          total += 1;
        }
      }
    }

    return total;
  }

  /**
   * Return info about the migration.
   * @returns {String}
   */

  static info() {
    return {
      name: 'Change address migration',
      description: 'Wallet is corrupted.'
    };
  }
}

/**
 * Wallet migration results.
 * @alias module:blockchain.WalletMigrationResult
 */

class WalletMigrationResult extends MigrationResult {
  constructor() {
    super();

    this.rescan = false;
  }
}

/**
 * ChainMigrations
 * @alias module:blockchain.WalletMigrations
 */
class WalletMigrations extends Migrations {
  /**
   * Create ChainMigrations object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new WalletMigrationOptions(options));

    this.logger = this.options.logger.context('wallet-migrations');
    this.pending = new WalletMigrationResult();
    this.flagError = '`hsd --wallet-migrate` or `hsw --migrate`\n' +
        '(Full node may be required for rescan)';
  }

  /**
   * Get list of migrations to run
   * @returns {Promise<Set>}
   */

  async getMigrationsToRun() {
    const state = await this.getState();
    const lastID = this.getLastMigrationID();
    const ids = new Set(Object.keys(this.migrations));

    if (state.nextMigration > lastID)
      return new Set();

    if (await this.ldb.get(oldLayout.M.encode(0)))
      ids.delete('1');

    for (let i = 0; i < state.nextMigration; i++)
      ids.delete(i);

    return ids;
  }
}

/**
 * ChainMigrationOptions
 * @alias module:wallet.WalletMigrationOptions
 */

class WalletMigrationOptions {
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
    this.layout = layouts.wdb;

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

    if (options.walletDB != null) {
      assert(typeof options.walletDB === 'object');
      this.db = options.walletDB;
      this.ldb = this.db.db;
    }

    if (options.walletMigrate != null) {
      assert(typeof options.walletMigrate === 'boolean');
      this.migrateFlag = options.walletMigrate;
    }

    if (options.dbVersion != null) {
      assert(typeof options.dbVersion === 'number');
      this.dbVersion = options.dbVersion;
    }

    if (options.migrations != null) {
      assert(typeof options.migrations === 'object');
      this.migrations = options.migrations;
    }
  }
}

exports = WalletMigrations;

exports.WalletMigrationResult = WalletMigrationResult;

// List of the migratoins with ids
exports.migrations = {
  0: MigrateMigrations,
  1: MigrateChangeAddress
};

// Expose migrations
exports.MigrateChangeAddress = MigrateChangeAddress;
exports.MigrateMigrations = MigrateMigrations;

module.exports = exports;
