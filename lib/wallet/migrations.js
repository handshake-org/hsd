/*!
 * wallet/migrations.js - wallet db migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const bio = require('bufio');
const bdb = require('bdb');
const Network = require('../protocol/network');
const TX = require('../primitives/tx');
const Outpoint = require('../primitives/outpoint');
const AbstractMigration = require('../migrations/migration');
const {
  MigrationResult,
  Migrator,
  types,
  oldLayout
} = require('../migrations/migrator');
const MigrationState = require('../migrations/state');
const layouts = require('./layout');
const wlayout = layouts.wdb;

/**
 * Migration requirements:
 */

/** @typedef {import('bdb').DB} DB */
/** @typedef {import('./walletdb')} WalletDB */

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
   * @param {DB.Batch} b
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
 * Applies to WalletDB v1
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
      gte: wlayout.W.min(),
      lte: wlayout.W.max(),
      parse: key => wlayout.W.decode(key)[0]
    });

    for (const wid of wids)
      await this.migrateWallet(b, wid);

    this.db.writeVersion(b, 2);
  }

  async migrateWallet(b, wid) {
    const accounts = await this.ldb.keys({
      gte: wlayout.a.min(wid),
      lte: wlayout.a.max(wid),
      parse: key => wlayout.a.decode(key)[1]
    });

    for (const accID of accounts) {
      const key = wlayout.a.encode(wid, accID);
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
 * Applies to WalletDB v2
 * Migrate bid reveal entries.
 *  - Adds height to the blind bid entries.
 *    - NOTE: This can not be recovered if the bid is not owned by the wallet.
 *      Wallet does not store transactions for not-owned bids.
 *  - Add Bid Outpoint information to the reveal (BidReveal) entries.
 *    - NOTE: This information can not be recovered for not-owned reveals.
 *      Wallet does not store transactions for not-owned reveals.
 *  - Add new BID -> REVEAL index. (layout.E)
 *    - NOTE: This information can not be recovered for not-owned reveals.
 *      Wallet does not store transactions for not-owned reveals.
 *
 */

class MigrateBidRevealEntries extends AbstractMigration {
  /**
   * Create Bid Reveal Entries migration object.
   * @param {WalletMigratorOptions} options
   * @constructor
   */

  constructor(options) {
    super(options);

    this.options = options;
    this.logger = options.logger.context('bid-reveal-entries-migration');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = MigrateBidRevealEntries.layout();
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
   * @param {DB.Batch} b
   * @param {WalletMigrationResult} pending
   * @returns {Promise}
   */

  async migrate(b, pending) {
    /** @type {Number[]} */
    const wids = await this.ldb.keys({
      gte: wlayout.W.min(),
      lte: wlayout.W.max(),
      parse: key => wlayout.W.decode(key)[0]
    });

    for (const wid of wids) {
      await this.migrateReveals(wid);
      await this.migrateBids(wid);
    }

    this.db.writeVersion(b, 3);
  }

  /**
   * Migrate reveals and index Bid2Reveal
   * @param {Number} wid
   * @returns {Promise}
   */

  async migrateReveals(wid) {
    const txlayout = this.layout.txdb;
    const prefix = txlayout.prefix.encode(wid);
    const bucket = this.ldb.bucket(prefix);
    const emptyOutpoint = new Outpoint();

    const reveals = bucket.iterator({
      gte: txlayout.B.min(),
      lte: txlayout.B.max(),
      values: true
    });

    for await (const {key, value} of reveals) {
      const b = bucket.batch();
      const [nameHash, txHash, txIndex] = txlayout.B.decode(key);
      const nameLen = value[0];
      const totalOld = nameLen + 1 + 13;
      const totalNew = nameLen + 1 + 13 + 36;

      assert(value.length === totalOld || value.length === totalNew);

      if (value.length === totalNew)
        continue;

      const owned = value[nameLen + 1 + 12];
      const rawTXRecord = await bucket.get(txlayout.t.encode(txHash));
      assert(owned && rawTXRecord || !owned);

      // We can not index the bid link and bid2reveal index if
      // the transaction is not owned by the wallet.
      // But we need to put null outpoint to the reveal for serialization.
      if (!owned) {
        const newReveal = Buffer.concat([value, emptyOutpoint.encode()]);
        assert(newReveal.length === totalNew);
        b.put(key, newReveal);
        await b.write();
        continue;
      }

      const reader = bio.read(rawTXRecord);
      const tx = TX.fromReader(reader);
      assert(tx.inputs[txIndex]);

      const bidPrevout = tx.inputs[txIndex].prevout;
      const bidKey = txlayout.i.encode(
        nameHash, bidPrevout.hash, bidPrevout.index);
      const bidRecord = await bucket.get(bidKey);
      assert(bidRecord);

      const newReveal = Buffer.concat([value, bidPrevout.encode()]);
      assert(newReveal.length === totalNew);
      b.put(key, newReveal);
      b.put(txlayout.E.encode(nameHash, bidPrevout.hash, bidPrevout.index),
        (new Outpoint(txHash, txIndex)).encode());
      await b.write();
    }
  }

  /**
   * Migrate bids, add height to the entries.
   * @param {Number} wid
   * @returns {Promise}
   */

  async migrateBids(wid) {
    const txlayout = this.layout.txdb;
    const prefix = txlayout.prefix.encode(wid);
    const bucket = this.ldb.bucket(prefix);

    const bids = bucket.iterator({
      gte: txlayout.i.min(),
      lte: txlayout.i.max(),
      values: true
    });

    /**
     * @param {Buffer} blindBid
     * @param {Number} height
     * @returns {Buffer}
     */

    const reencodeBlindBid = (blindBid, height) => {
      const nameLen = blindBid[0];
      const totalOld = nameLen + 1 + 41;
      const totalNew = nameLen + 1 + 41 + 4;
      assert(blindBid.length === totalOld);

      const newBlindBid = Buffer.alloc(totalNew);
      // copy everything before expected height place.
      blindBid.copy(newBlindBid, 0, 0, totalOld - 1);
      // copy height.
      bio.encoding.writeU32(newBlindBid, height, totalOld - 1);
      // copy last byte (owned flag).
      blindBid.copy(newBlindBid, totalNew - 1, totalOld - 1);

      return newBlindBid;
    };

    for await (const {key, value} of bids) {
      const b = bucket.batch();
      const [,txHash] = txlayout.i.decode(key);
      const nameLen = value[0];
      const totalNew = nameLen + 1 + 41 + 4;

      if (totalNew === value.length)
        continue;

      const owned = value[nameLen + 1 + 40];
      if (!owned) {
        const height = 0xffffffff; // -1
        const newValue = reencodeBlindBid(value, height);
        b.put(key, newValue);
        await b.write();
        continue;
      }

      const rawTXRecord = await bucket.get(txlayout.t.encode(txHash));
      assert(rawTXRecord);

      const br = bio.read(rawTXRecord);
      TX.fromReader(br);
      // skip mtime.
      br.seek(4);

      const hasBlock = br.readU8() === 1;
      // We only index the bid in blocks, not in mempool.
      assert(hasBlock);

      // skip hash.
      br.seek(32);
      const height = br.readU32();
      const newValue = reencodeBlindBid(value, height);
      b.put(key, newValue);

      await b.write();
    }
  }

  static info() {
    return {
      name: 'Bid reveal entries migration',
      description: 'Migrate bids and reveals to link each other.'
    };
  }

  static layout() {
    return {
      wdb: {
        V: bdb.key('V'),
        // W[wid] -> wallet id
        W: bdb.key('W', ['uint32'])
      },
      txdb: {
        prefix: bdb.key('t', ['uint32']),
        // t[tx-hash] -> extended tx (Read only)
        t: bdb.key('t', ['hash256']),
        // i[name-hash][tx-hash][index] -> txdb.BlindBid
        i: bdb.key('i', ['hash256', 'hash256', 'uint32']),
        // B[name-hash][tx-hash][index] -> txdb.BidReveal
        B: bdb.key('B', ['hash256', 'hash256', 'uint32']),
        // E[name-hash][tx-hash][index] -> bid to reveal out.
        E: bdb.key('E', ['hash256', 'hash256', 'uint32'])
      }
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
    /** @type {WalletDB} */
    this.db = null;
    /** @type {DB} */
    this.ldb = null;
    this.layout = layouts.wdb;

    assert(options);
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
  4: MigrateBidRevealEntries
};

// Expose migrations
exports.MigrateChangeAddress = MigrateChangeAddress;
exports.MigrateMigrations = MigrateMigrations;
exports.MigrateAccountLookahead = MigrateAccountLookahead;
exports.MigrateTXDBBalances = MigrateTXDBBalances;
exports.MigrateBidRevealEntries = MigrateBidRevealEntries;

module.exports = exports;
