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
const {BufferSet} = require('buffer-map');
const LRU = require('blru');
const HDPublicKey = require('../hd/public');
const binary = require('../utils/binary');
const {encoding} = bio;
const Network = require('../protocol/network');
const consensus = require('../protocol/consensus');
const Coin = require('../primitives/coin');
const Outpoint = require('../primitives/outpoint');
const Script = require('../script/script');
const TX = require('../primitives/tx');
const Account = require('./account');
const WalletKey = require('./walletkey');
const Path = require('./path');
const MapRecord = require('./records').MapRecord;
const AbstractMigration = require('../migrations/migration');
const {
  MigrationResult,
  Migrator,
  types,
  oldLayout
} = require('../migrations/migrator');
const layouts = require('./layout');
const wlayout = layouts.wdb;

/** @typedef {import('../migrations/migrator').types} MigrationType */
/** @typedef {ReturnType<bdb.DB['batch']>} Batch */
/** @typedef {ReturnType<bdb.DB['bucket']>} Bucket */
/** @typedef {import('./walletdb')} WalletDB */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('./txdb').BlockExtraInfo} BlockExtraInfo */

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

    /** @type {WalletMigratorOptions} */
    this.options = options;
    this.logger = options.logger.context('wallet-migrations-migrate');
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

  /**
   * @param {Number} nextMigration
   * @returns {Buffer}
   */

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

    /** @type {WalletMigratorOptions} */
    this.options = options;
    this.logger = options.logger.context('change-address-migration');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = MigrateChangeAddress.layout();
  }

  /**
   * Migration and check for the change address
   * are done in the same step.
   * @returns {Promise<MigrationType>}
   */

  async check() {
    return types.MIGRATE;
  }

  /**
   * Actual migration
   * @param {Batch} b
   * @param {WalletMigrationResult} [pending]
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

  /**
   * @param {Batch} b
   * @param {Number} wid
   * @returns {Promise<Number>}
   */

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

  /**
   * @param {Object} options
   * @returns {WalletKey}
   */

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

  /**
   * @param {bio.BufferReader} br
   * @returns {HDPublicKey}
   */

  readKey(br) {
    const key = new HDPublicKey();
    key.depth = br.readU8();
    key.parentFingerPrint = br.readU32BE();
    key.childIndex = br.readU32BE();
    key.chainCode = br.readBytes(32);
    key.publicKey = br.readBytes(33);
    return key;
  }

  /**
   * @param {Number} wid
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  async hasPath(wid, hash) {
    return this.ldb.has(this.layout.wdb.P.encode(wid, hash));
  }

  /**
   * @param {Batch} b
   * @param {Number} wid
   * @param {Path} path
   */

  async savePath(b, wid, path) {
    const wlayout = this.layout.wdb;

    const data = await this.ldb.get(wlayout.p.encode(path.hash));
    /** @type {MapRecord} */
    const map = data ? MapRecord.decode(data) : new MapRecord();

    map.add(wid);
    b.put(wlayout.p.encode(path.hash), map.encode());
    b.put(wlayout.P.encode(wid, path.hash), path.encode());
    b.put(wlayout.r.encode(wid, path.account, path.hash), null);
  }

  /**
   * Return info about the migration.
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
   * @param {WalletMigratorOptions} options
   */

  constructor (options) {
    super(options);

    /** @type {WalletMigratorOptions} */
    this.options = options;
    this.logger = options.logger.context('account-lookahead-migration');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = MigrateAccountLookahead.layout();
  }

  /**
   * We always migrate account.
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

  /**
   * @param {Batch} b
   * @param {Number} wid
   * @returns {Promise}
   */

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

  /**
   * @param {Buffer} raw
   * @returns {Buffer}
   */

  accountEncode(raw) {
    // flags, type, m, n, receiveDepth, changeDepth
    const preLen = 1 + 1 + 1 + 1 + 4 + 4;
    const pre = raw.slice(0, preLen);
    const lookahead = raw.slice(preLen, preLen + 1);
    const post = raw.slice(preLen + 1);
    const newLookahead = Buffer.alloc(4, 0x00);

    encoding.writeU32(newLookahead, lookahead[0], 0);

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

    /** @type {WalletMigratorOptions} */
    this.options = options;
    this.logger = options.logger.context('txdb-balance-migration');
    this.db = options.db;
    this.ldb = options.ldb;
  }

  /**
   * We always migrate.
   * @returns {Promise<MigrationType>}
   */

  async check() {
    return types.MIGRATE;
  }

  /**
   * Actual migration
   * @param {Batch} b
   * @param {WalletMigrationResult} [pending]
   * @returns {Promise}
   */

  async migrate(b, pending) {
    pending.recalculateTXDB = true;
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

    /** @type {WalletMigratorOptions} */
    this.options = options;
    this.logger = options.logger.context('bid-reveal-entries-migration');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = MigrateBidRevealEntries.layout();
  }

  /**
   * We always migrate.
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

      // allow migration to be interrupted in the middle.
      assert(value.length === totalOld || value.length === totalNew);

      // skip if already migrated.
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
      /** @type {TX} */
      const tx = TX.fromReader(reader);
      assert(tx.inputs[txIndex]);

      const bidPrevout = tx.inputs[txIndex].prevout;
      const bidKey = txlayout.i.encode(
        nameHash, bidPrevout.hash, bidPrevout.index);
      const bidRecord = await bucket.get(bidKey);
      // ensure bid exists.
      assert(bidRecord);

      const newReveal = Buffer.concat([value, bidPrevout.encode()]);
      assert(newReveal.length === totalNew);
      // update reveal with bid outpoint.
      b.put(key, newReveal);
      // index bid to reveal.
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

      // allow migration to be interrupted in the middle.
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
 * Applies to WalletDB v3.
 * Migrate TX Count Time Index.
 *   - Adds time to the block entries (layout.wdb.h)
 *   - ...
 */

class MigrateTXCountTimeIndex extends AbstractMigration {
  /**
   * Create TX Count Time Index migration object.
   * @param {WalletMigratorOptions} options
   * @constructor
   */

  constructor(options) {
    super(options);

    /** @type {WalletMigratorOptions} */
    this.options = options;
    this.logger = options.logger.context('tx-count-time-index-migration');
    this.db = options.db;
    this.ldb = options.ldb;
    this.layout = MigrateTXCountTimeIndex.layout();

    this.headersBatchSize = 1000;

    this.UNCONFIRMED_HEIGHT = 0xffffffff;

    this.blockTimeCache = new LRU(50);
  }

  /**
   * TX Count Time Index migration check.
   * It will always migrate.
   * @returns {Promise<MigrationType>}
   */

  async check() {
    return types.MIGRATE;
  }

  /**
   * Migrate TX Count Time Index.
   * Needs fullnode to be available via http.
   * @param {Batch} b
   * @returns {Promise}
   */

  async migrate(b) {
    await this.migrateHeaders();

    const wlayout = this.layout.wdb;
    const wids = await this.ldb.keys({
      gte: wlayout.W.min(),
      lte: wlayout.W.max(),
      parse: key => wlayout.W.decode(key)[0]
    });

    for (const wid of wids) {
      await this.migrateConfirmed(wid);
      await this.migrateUnconfirmed(wid);
      await this.verifyTimeEntries(wid);
    }

    this.db.writeVersion(b, 4);
  }

  /**
   * Migrate headers in the walletdb.
   * Add time entry.
   * @returns {Promise}
   */

  async migrateHeaders() {
    const iter = this.ldb.iterator({
      gte: this.layout.wdb.h.min(),
      lte: this.layout.wdb.h.max(),
      values: true
    });

    let parent = this.ldb.batch();
    let total = 0;

    for await (const {key, value} of iter) {
      const [height] = this.layout.wdb.h.decode(key);
      const hash = value.slice(0, 32);

      // Skip if already migrated.
      if (value.length === 40)
        continue;

      const entry = await this.db.client.getBlockHeader(hash.toString('hex'));

      if (!entry)
        throw new Error('Could not get entry from the chain.');

      assert(entry.height === height);

      const out = Buffer.allocUnsafe(32 + 8);
      bio.writeBytes(out, hash, 0);
      bio.writeU64(out, entry.time, 32);

      parent.put(key, out);

      if (++total % this.headersBatchSize === 0) {
        await parent.write();
        parent = this.ldb.batch();
      }
    }

    await parent.write();
  }

  /**
   * Migrate confirmed transactions.
   * @param {Number} wid
   * @returns {Promise}
   */

  async migrateConfirmed(wid) {
    const txlayout = this.layout.txdb;
    const bucket = this.ldb.bucket(txlayout.prefix.encode(wid));

    const lastHeight = await bucket.range({
      gte: txlayout.Ot.min(),
      lt: txlayout.Ot.min(this.UNCONFIRMED_HEIGHT),
      reverse: true,
      limit: 1
    });

    let startHeight = 0;

    if (lastHeight.length !== 0) {
      const [height] = txlayout.Ot.decode(lastHeight[0].key);
      startHeight = height;
    }

    const rawBlockRecords = bucket.iterator({
      gte: txlayout.b.encode(startHeight),
      lte: txlayout.b.max(),
      values: true
    });

    for await (const {key, value: rawBlockRecord} of rawBlockRecords) {
      const height = txlayout.b.decode(key)[0];
      const hash = rawBlockRecord.slice(0, 32);
      const blockTime = encoding.readU32(rawBlockRecord, 32 + 4);
      const txCount = encoding.readU32(rawBlockRecord, 32 + 4 + 4);
      const medianTime = await this.getMedianTime(height, hash);
      assert(medianTime, 'Could not get medianTime');

      const hashes = new BufferSet();
      let count = 0;

      for (let i = 0; i < txCount; i++) {
        const pos = 32 + 4 + 4 + 4 + i * 32;
        const txHash = encoding.readBytes(rawBlockRecord, pos, 32);
        const block = {
          height,
          time: blockTime
        };

        if (hashes.has(txHash))
          continue;

        hashes.add(txHash);

        /** @type {BlockExtraInfo} */
        const extra = {
          medianTime: medianTime,
          txIndex: count++
        };

        await this.migrateTX(bucket, wid, txHash, block, extra);
      }
    }
  }

  /**
   * Migrate unconfirmed transactions.
   * @param {Number} wid
   * @returns {Promise}
   */

  async migrateUnconfirmed(wid) {
    const txlayout = this.layout.txdb;
    const bucket = this.ldb.bucket(txlayout.prefix.encode(wid));

    // The only transactions remaining in layout.m should be unconfirmed.
    const txsByOldTime = bucket.iterator({
      gte: txlayout.m.min(),
      lte: txlayout.m.max()
    });

    // Here we don't need to skip as the old time index
    // is getting cleaned up in the same migration.
    for await (const {key} of txsByOldTime) {
      const [, txHash] = txlayout.m.decode(key);
      await this.migrateTX(bucket, wid, txHash);
    }
  }

  /**
   * Migrate specific transaction. Index by count and time.
   * @param {Bucket} bucket
   * @param {Number} wid
   * @param {Hash} txHash - txhash.
   * @param {Object} [block]
   * @param {Number} block.height
   * @param {Number} block.time
   * @param {BlockExtraInfo} [extra]
   * @returns {Promise}
   */

  async migrateTX(bucket, wid, txHash, block, extra) {
    const txlayout = this.layout.txdb;

    // Skip if already migrated.
    if (await bucket.get(txlayout.Oc.encode(txHash)))
      return;

    const batch = bucket.batch();
    /** @type {Set<Number>} */
    const accounts = new Set();
    const rawTXRecord = await bucket.get(txlayout.t.encode(txHash));

    // Skip if we have not recorded the transaction. This can happen
    // for bids, reveals, etc. that are not owned by the wallet.
    if (!rawTXRecord)
      return;

    const recordReader = bio.read(rawTXRecord);
    /** @type {TX} */
    const tx = TX.fromReader(recordReader);
    const mtime = recordReader.readU32();

    // Inputs, whether in a block or for unconfirmed transactions,
    // will be indexed as spent inputs. We can leverage
    // these entries to determine related accounts.
    if (!tx.isCoinbase()) {
      // inputs that were spent by the wallet.
      const spentCoins = bucket.iterator({
        gte: txlayout.d.min(txHash),
        lte: txlayout.d.max(txHash),
        values: true
      });

      for await (const {value} of spentCoins) {
        const coin = Coin.decode(value);
        const account = await this.getAccount(wid, coin);
        assert(account != null);
        accounts.add(account);
      }
    }

    // For outputs, we don't need to bother with coins at all.
    // We can gather paths directly from the outputs.
    for (const output of tx.outputs) {
      const account = await this.getAccount(wid, output);

      if (account != null)
        accounts.add(account);
    }

    // remove old indexes.
    batch.del(txlayout.m.encode(mtime, txHash));

    for (const acct of accounts)
      batch.del(txlayout.M.encode(acct, mtime, txHash));

    if (!block) {
      // Expanded the following code.
      // Add indexing for unconfirmed transactions.
      // await this.addCountAndTimeIndexUnconfirmed(b, state.accounts, hash);
      const rawLastUnconfirmedIndex = await bucket.get(txlayout.Ol.encode());
      let lastUnconfirmedIndex = 0;

      if (rawLastUnconfirmedIndex)
        lastUnconfirmedIndex = encoding.readU32(rawLastUnconfirmedIndex, 0);

      const height = this.UNCONFIRMED_HEIGHT;
      const index = lastUnconfirmedIndex;
      const count = { height, index };

      batch.put(txlayout.Ot.encode(height, index), txHash);
      batch.put(txlayout.Oc.encode(txHash), this.encodeTXCount(count));

      batch.put(txlayout.Oe.encode(txHash), fromU32(mtime));
      batch.put(txlayout.Om.encode(mtime, index, txHash));

      for (const acct of accounts) {
        batch.put(txlayout.OT.encode(acct, height, index), txHash);
        batch.put(txlayout.OM.encode(acct, mtime, index, txHash));
      }

      batch.put(txlayout.Ol.encode(), fromU32(lastUnconfirmedIndex + 1));

      await batch.write();
      return;
    }

    // we have the block!
    // await this.addCountAndTimeIndex(b, {
    //   accounts: state.accounts,
    //   hash,
    //   height: block.height,
    //   blockextra: extra
    // });
    const index = extra.txIndex;
    const height = block.height;
    const count = { height, index };

    batch.put(txlayout.Ot.encode(height, index), txHash);
    batch.put(txlayout.Oc.encode(txHash), this.encodeTXCount(count));

    const time = extra.medianTime;
    batch.put(txlayout.Oi.encode(time, height, index, txHash));

    for (const acct of accounts) {
      batch.put(txlayout.OT.encode(acct, height, index), txHash);
      batch.put(txlayout.OI.encode(acct, time, height, index, txHash));
    }

    // await this.addTimeAndCountIndexUnconfirmedUndo(b, hash);
    const rawLastUnconfirmedIndex = await bucket.get(txlayout.Ol.encode());
    let lastUnconfirmedIndex = 0;

    if (rawLastUnconfirmedIndex)
      lastUnconfirmedIndex = encoding.readU32(rawLastUnconfirmedIndex, 0);

    batch.put(txlayout.Oe.encode(txHash), fromU32(mtime));
    batch.put(txlayout.Ou.encode(txHash), this.encodeTXCount({
      height: this.UNCONFIRMED_HEIGHT,
      index: lastUnconfirmedIndex
    }));

    batch.put(txlayout.Ol.encode(), fromU32(lastUnconfirmedIndex + 1));
    await batch.write();
  }

  /**
   * Get path for the coin.
   * @param {Number} wid
   * @param {Coin|Output} coin
   * @returns {Promise<Number>} - account index
   */

  async getAccount(wid, coin) {
    const hash = coin.getHash();

    if (!hash)
      return null;

    const rawPath = await this.ldb.get(this.layout.wdb.P.encode(wid, hash));

    if (!rawPath)
      return null;

    const account = encoding.readU32(rawPath, 0);
    return account;
  }

  /**
   * Encode TXCount.
   * @param {Object} txCount
   * @param {Number} txCount.height
   * @param {Number} txCount.index
   * @returns {Buffer}
   */

  encodeTXCount(txCount) {
    const bw = bio.write(8);
    bw.writeU32(txCount.height);
    bw.writeU32(txCount.index);
    return bw.render();
  }

  /**
   * Get median time for the block.
   * @param {Number} height
   * @param {Hash} lastHash
   * @returns {Promise<Number>}
   */

  async getMedianTime(height, lastHash) {
    const getBlockTime = async (bheight) => {
      const cache = this.blockTimeCache.get(bheight);

      if (cache != null)
        return cache;

      if (bheight < 0)
        return null;

      let time;
      const data = await this.ldb.get(this.layout.wdb.h.encode(bheight));

      if (!data) {
        // Special case when txlayout.b exists, but txlayout.wdb.h does not.
        // This can happen when walletDB is stopped during addBlock.
        if (height !== bheight)
          return null;

        const header = await this.db.client.getBlockHeader(bheight);

        if (!header)
          return null;

        // double check hash.
        if (header.hash !== lastHash.toString('hex'))
          throw new Error('Bad block time response.');

        time = header.time;
      } else {
        time = encoding.readU64(data, 32);
      }

      this.blockTimeCache.set(bheight, time);

      return time;
    };

    const timespan = consensus.MEDIAN_TIMESPAN;
    const median = [];

    let time = await getBlockTime(height);

    for (let i = 0; i < timespan && time; i++) {
      median.push(time);

      time = await getBlockTime(height - i - 1);
    }

    median.sort((a, b) => a - b);
    return median[median.length >>> 1];
  }

  /**
   * Verify time entries have been removed.
   * @param {Number} wid
   * @returns {Promise}
   */

  async verifyTimeEntries(wid) {
    const txlayout = this.layout.txdb;
    const bucket = this.ldb.bucket(txlayout.prefix.encode(wid));
    const timeEntries = await bucket.range({
      gte: txlayout.m.min(),
      lte: txlayout.m.max()
    });

    assert(timeEntries.length === 0);

    const timeEntriesByAcct = await bucket.range({
      gte: txlayout.M.min(),
      lte: txlayout.M.max()
    });

    assert(timeEntriesByAcct.length === 0);
  }

  static info() {
    return {
      name: 'TX Count Time Index migration',
      description: 'Migrate TX data and index them for pagination'
    };
  }

  static layout() {
    return {
      wdb: {
        V: bdb.key('V'),

        // h[height] -> block hash + time
        h: bdb.key('h', ['uint32']),

        // W[wid] -> wallet id
        W: bdb.key('W', ['uint32']),

        // P[wid][addr-hash] -> path data
        P: bdb.key('P', ['uint32', 'hash'])
      },
      txdb: {
        prefix: bdb.key('t', ['uint32']),

        // We need this for spent inputs in blocks.
        // d[tx-hash][index] -> undo coin
        d: bdb.key('d', ['hash256', 'uint32']),

        // these two are no longer used.
        // m[time][tx-hash] -> dummy (tx by time)
        m: bdb.key('m', ['uint32', 'hash256']),
        // M[account][time][tx-hash] -> dummy (tx by time + account)
        M: bdb.key('M', ['uint32', 'uint32', 'hash256']),

        // This is not affected by the migration, but here for reference
        // and time check.
        // t[tx-hash] -> extended tx
        t: bdb.key('t', ['hash256']),

        // Confirmed.
        // b[height] -> block record
        b: bdb.key('b', ['uint32']),

        // Count and Time Index.
        // Latest unconfirmed Index.
        Ol: bdb.key('Ol'),

        // Transaction.
        // z[height][index] -> tx hash (tx by count)
        Ot: bdb.key('Ot', ['uint32', 'uint32']),
        // Z[account][height][index] -> tx hash (tx by count + account)
        OT: bdb.key('OT', ['uint32', 'uint32', 'uint32']),
        // Oc[hash] -> count (count for tx)
        Oc: bdb.key('Oc', ['hash256']),
        // Ou[hash] -> undo count (unconfirmed count for tx)
        Ou: bdb.key('Ou', ['hash256']),

        // Unconfirmed.
        // Om[time][count][hash] -> dummy (tx by time)
        Om: bdb.key('Om', ['uint32', 'uint32', 'hash256']),
        // OM[account][time][count][hash] -> dummy (tx by time + account)
        OM: bdb.key('OM', ['uint32', 'uint32', 'uint32', 'hash256']),
        // Oe[hash] -> undo time (unconfirmed time for tx)
        Oe: bdb.key('Oe', ['hash256']),

        // Confirmed.
        // Oi[time][height][index][hash] -> dummy (tx by time)
        Oi: bdb.key('Oi', ['uint32', 'uint32', 'uint32', 'hash256']),

        // OI[account][time][height][index][hash] -> dummy(tx by time + account)
        OI: bdb.key('OI', ['uint32', 'uint32', 'uint32', 'uint32', 'hash256'])
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
    this.recalculateTXDB = false;
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

    this.migrations = WalletMigrator.migrations;
    this.migrateFlag = -1;

    this.dbVersion = 0;
    /** @type {WalletDB} */
    this.db = null;
    /** @type {bdb.DB} */
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

    return this;
  }
}

/*
 * Helpers
 */

/**
 * @param {Number} num
 * @returns {Buffer}
 */

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0);
  return data;
}

/*
 * Expose
 */

WalletMigrator.WalletMigrationResult = WalletMigrationResult;

// List of the migrations with ids
WalletMigrator.migrations = {
  0: MigrateMigrations,
  1: MigrateChangeAddress,
  2: MigrateAccountLookahead,
  3: MigrateTXDBBalances,
  4: MigrateBidRevealEntries,
  5: MigrateTXCountTimeIndex
};

// Expose migrations
WalletMigrator.MigrateChangeAddress = MigrateChangeAddress;
WalletMigrator.MigrateMigrations = MigrateMigrations;
WalletMigrator.MigrateAccountLookahead = MigrateAccountLookahead;
WalletMigrator.MigrateTXDBBalances = MigrateTXDBBalances;
WalletMigrator.MigrateBidRevealEntries = MigrateBidRevealEntries;
WalletMigrator.MigrateTXCountTimeIndex = MigrateTXCountTimeIndex;

module.exports = WalletMigrator;
