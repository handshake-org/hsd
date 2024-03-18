/*!
 * wallet/migrations.js - wallet db migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const Network = require('../protocol/network');
const AbstractMigration = require('../migrations/migration');
const {
  MigrationResult,
  Migrator,
  types,
  oldLayout
} = require('../migrations/migrator');
const MigrationState = require('../migrations/state');
const layouts = require('./layout');
const layout = layouts.wdb;

/**
 * Switch to new migrations layout.
 */

class MigrateMigrations extends AbstractMigration {
  /**
   * Create migrations migration.
   * @param {WalletMigratorOptions} options
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
 * Applies to WalletDB v1
 */

class MigrateChangeAddress extends AbstractMigration {
  /**
   * Create change address migration object.
   * @constructor
   * @param {WalletMigratorOptions} options
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
    const wids = await this.db.getWallets();

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
      const account = await wallet.getAccount(i);

      for (let j = 0; j < account.changeDepth + account.lookahead; j++) {
        const key = account.deriveChange(j);
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
 * Migrate account for new lookahead entry.
 * Applies to WalletDB v1 -> v2
 */

class MigrateAccountLookahead extends AbstractMigration {
  /**
   * Create migration object.
   * @param {WalletMigratorOptions}
   */

  constructor (options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('account-lookahead-migration');
    this.db = options.db;
    this.ldb = options.ldb;
  }

  /**
   * We always migrate account.
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
    const wids = await this.ldb.keys({
      gte: layout.W.min(),
      lte: layout.W.max(),
      parse: key => layout.W.decode(key)[0]
    });

    for (const wid of wids)
      await this.migrateWallet(b, wid);

    this.db.writeVersion(b, 2);
  }

  async migrateWallet(b, wid) {
    const accounts = await this.ldb.keys({
      gte: layout.a.min(wid),
      lte: layout.a.max(wid),
      parse: key => layout.a.decode(key)[1]
    });

    for (const accID of accounts) {
      const key = layout.a.encode(wid, accID);
      const rawAccount = await this.ldb.get(key);
      const newRaw = this.accountEncode(rawAccount);
      b.put(key, newRaw);
    }
  }

  accountEncode(raw) {
    // flags, type, m, n, receiveDepth, changeDepth
    const preLen = 1 + 1 + 1 + 1 + 4 + 4;
    const pre = raw.slice(0, preLen);
    const lookahead = raw.slice(preLen, preLen + 1);
    const post = raw.slice(preLen + 1);
    const newLookahead = Buffer.alloc(4, 0x00);

    newLookahead.writeUInt32LE(lookahead[0], 0);

    return Buffer.concat([
      pre,
      newLookahead,
      post
    ]);
  }

  static info() {
    return {
      name: 'Account lookahead migration',
      description: 'Account lookahead now supports up to 2^32 - 1'
    };
  }
}

/**
 * Recalculate TXDB balances.
 * Applies to WalletDB v2
 */

class MigrateTXDBBalances extends AbstractMigration {
  /**
   * Create TXDB Balance migration object.
   * @param {WalletMigratorOptions} options
   * @constructor
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('txdb-balance-migration');
    this.db = options.db;
    this.ldb = options.ldb;
  }

  /**
   * We always migrate.
   * @returns {Promise}
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
    await this.db.recalculateBalances();
  }

  static info() {
    return {
      name: 'TXDB balance refresh',
      description: 'Refresh balances for TXDB after txdb updates'
    };
  }
}

/**
 * Migrate WDB to v3. Drop TXDB and migrate to new WDB layout.
 * Applies to WalletDB v2
 */

class MigrateWDBv3 extends AbstractMigration {
  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('wdb-migrate-v3');
    this.db = options.db;
    this.ldb = options.ldb;
  }

  /**
   * We always migrate.
   * @returns {Promise}
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
    const removeRange = (opt) => {
      return this.ldb.iterator(opt).each(key => b.del(key));
    };

    // Remove mappings and TXDB Entries.
    await this.db.deepClean();

    // Remove the sync progress.
    await removeRange({
      gte: layout.h.min(),
      lte: layout.h.max()
    });

    await this.db.saveGenesis();

    // Now rewrite genesis and version.
    await this.db.writeVersion(b, 3);
  }

  static info() {
    return {
      name: 'Migrate WDB to v3',
      description: 'Drop TXDB and migrate to new WDB layout'
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
 * Wallet Migrator
 * @alias module:blockchain.WalletMigrator
 */
class WalletMigrator extends Migrator {
  /**
   * Create WalletMigrator object.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new WalletMigratorOptions(options));

    this.logger = this.options.logger.context('wallet-migrations');
    this.pending = new WalletMigrationResult();
    this.flagError = 'Restart with '
      + `\`hsd --wallet-migrate=${this.lastMigration}\` or `
      + `\`hsw --migrate=${this.lastMigration}\`\n`
      + '(Full node may be required for rescan)';
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

    if (state.nextMigration === 0 && await this.ldb.get(oldLayout.M.encode(0)))
      ids.delete(1);

    return ids;
  }
}

/**
 * WalletMigratorOptions
 * @alias module:wallet.WalletMigratorOptions
 */

class WalletMigratorOptions {
  /**
   * Create Wallet Migrator Options.
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
    this.layout = layouts.wdb;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @param {Object} options
   * @returns {WalletMigratorOptions}
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
      assert(typeof options.walletMigrate === 'number');
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

exports = WalletMigrator;

exports.WalletMigrationResult = WalletMigrationResult;

// List of the migrations with ids
exports.migrations = {
  0: MigrateMigrations,
  1: MigrateChangeAddress,
  2: MigrateAccountLookahead,
  3: MigrateTXDBBalances,
  4: MigrateWDBv3
};

// Expose migrations
exports.MigrateChangeAddress = MigrateChangeAddress;
exports.MigrateMigrations = MigrateMigrations;
exports.MigrateAccountLookahead = MigrateAccountLookahead;
exports.MigrateTXDBBalances = MigrateTXDBBalances;
exports.MigrateWDBv3 = MigrateWDBv3;

module.exports = exports;
