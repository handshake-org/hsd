/*!
 * wallet/migrations.js - wallet db migrations for hsd
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const bdb = require('bdb');
const bio = require('bufio');
const {HDPublicKey} = require('../hd/hd');
const binary = require('../utils/binary');
const {encoding} = bio;
const Network = require('../protocol/network');
const Account = require('./account');
const WalletKey = require('./walletkey');
const Path = require('./path');
const Script = require('../script/script');
const MapRecord = require('./records').MapRecord;
const AbstractMigration = require('../migrations/migration');
const {
  MigrationResult,
  Migrator,
  types,
  oldLayout
} = require('../migrations/migrator');
const layouts = require('./layout');

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
    this.layout = MigrateMigrations.layout();
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
    let nextMigration = 1;

    if (await this.ldb.get(this.layout.oldLayout.wdb.M.encode(0))) {
      b.del(this.layout.oldLayout.wdb.M.encode(0));
      nextMigration = 2;
    }

    this.db.writeVersion(b, 1);
    b.put(
      this.layout.newLayout.wdb.M.encode(),
      this.encodeMigrationState(nextMigration)
    );
  }

  encodeMigrationState(nextMigration) {
    const size = 4 + 1 + 1;
    const encoded = Buffer.alloc(size);

    encoding.writeVarint(encoded, nextMigration, 4);

    return encoded;
  }

  static info() {
    return {
      name: 'Migrate wallet migrations',
      description: 'Wallet migration layout has changed.'
    };
  }

  static layout() {
    return {
      oldLayout: {
        wdb: {
          M: bdb.key('M', ['uint32'])
        }
      },
      newLayout: {
        wdb: {
          M: bdb.key('M')
        }
      }
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
    this.layout = MigrateChangeAddress.layout();
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
    const wlayout = this.layout.wdb;
    const wids = await this.ldb.keys({
      gte: wlayout.W.min(),
      lte: wlayout.W.max(),
      parse: key => wlayout.W.decode(key)[0]
    });

    let total = 0;
    for (const wid of wids) {
      this.logger.info('Checking wallet (wid=%d).', wid);
      total += await this.migrateWallet(b, wid);
    }

    if (total > 0)
      pending.rescan = true;
  }

  async migrateWallet(b, wid) {
    const accounts = this.ldb.iterator({
      gte: this.layout.wdb.a.min(wid),
      lte: this.layout.wdb.a.max(wid),
      values: true
    });

    let total = 0;
    for await (const {key, value} of accounts) {
      const [awid, aindex] = this.layout.wdb.a.decode(key);
      const name = await this.ldb.get(this.layout.wdb.n.encode(wid, aindex));
      assert(awid === wid);
      const br = bio.read(value);
      const initialized = br.readU8();

      if (!initialized)
        continue;

      const type = br.readU8();
      const m = br.readU8();
      const n = br.readU8();
      br.seek(4); // skip receive
      const changeDepth = br.readU32();
      const lookahead = br.readU8();
      const accountKey = this.readKey(br);
      const count = br.readU8();
      assert(br.left() === count * 74);

      const keys = [];

      for (let i = 0; i < count; i++) {
        const key = this.readKey(br);
        const cmp = (a, b) => a.compare(b);
        binary.insert(keys, key, cmp, true);
      }

      for (let i = 0; i < changeDepth + lookahead; i++) {
        const key = this.deriveKey({
          accountName: name,
          accountIndex: aindex,
          accountKey: accountKey,
          type: type,
          m: m,
          n: n,
          branch: 1,
          index: i,
          keys: keys
        });

        const path = key.toPath();

        if (!await this.hasPath(wid, path.hash)) {
          await this.savePath(b, wid, path);
          total += 1;
        }
      }
    }

    return total;
  }

  deriveKey(options) {
    const key = options.accountKey.derive(options.branch).derive(options.index);
    const wkey = new WalletKey();
    wkey.keyType = Path.types.HD;
    wkey.name = options.accountName;
    wkey.account = options.accountIndex;
    wkey.branch = options.branch;
    wkey.index = options.index;
    wkey.publicKey = key.publicKey;

    const keys = [];
    switch (options.type) {
      case Account.types.PUBKEYHASH:
        break;

      case Account.types.MULTISIG:
        keys.push(wkey.publicKey);

        for (const shared of options.keys) {
          const key = shared.derive(options.branch).derive(options.index);
          keys.push(key.publicKey);
        }

        wkey.script = Script.fromMultisig(options.m, options.n, keys);

        break;
    }

    return wkey;
  }

  readKey(br) {
    const key = new HDPublicKey();
    key.depth = br.readU8();
    key.parentFingerPrint = br.readU32BE();
    key.childIndex = br.readU32BE();
    key.chainCode = br.readBytes(32);
    key.publicKey = br.readBytes(33);
    return key;
  }

  async hasPath(wid, hash) {
    return this.ldb.has(this.layout.wdb.P.encode(wid, hash));
  }

  async savePath(b, wid, path) {
    const wlayout = this.layout.wdb;

    const data = await this.ldb.get(wlayout.p.encode(path.hash));
    const map = data ? MapRecord.decode(data) : new MapRecord();

    map.add(wid);
    b.put(wlayout.p.encode(path.hash), map.encode());
    b.put(wlayout.P.encode(wid, path.hash), path.encode());
    b.put(wlayout.r.encode(wid, path.account, path.hash), null);
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

  /**
   * Get layout that migration is going to affect.
   * @returns {Object}
   */

  static layout() {
    return {
      wdb: {
        // W[wid] -> wallet id
        W: bdb.key('W', ['uint32']),

        // n[wid][index] -> account name
        n: bdb.key('n', ['uint32', 'uint32']),

        // a[wid][index] -> account
        a: bdb.key('a', ['uint32', 'uint32']),

        // p[addr-hash] -> address->wid map
        p: bdb.key('p', ['hash']),

        // P[wid][addr-hash] -> path data
        P: bdb.key('P', ['uint32', 'hash']),

        // r[wid][index][addr-hash] -> dummy (addr by account)
        r: bdb.key('r', ['uint32', 'uint32', 'hash'])
      }
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
    this.layout = MigrateAccountLookahead.layout();
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
    const wlayout = this.layout.wdb;
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
    const wlayout = this.layout.wdb;
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

  static layout() {
    return {
      wdb: {
        // W[wid] -> wallet id
        W: bdb.key('W', ['uint32']),

        // a[wid][index] -> account
        a: bdb.key('a', ['uint32', 'uint32'])
      }
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
  3: MigrateTXDBBalances
};

// Expose migrations
exports.MigrateChangeAddress = MigrateChangeAddress;
exports.MigrateMigrations = MigrateMigrations;
exports.MigrateAccountLookahead = MigrateAccountLookahead;
exports.MigrateTXDBBalances = MigrateTXDBBalances;

module.exports = exports;
