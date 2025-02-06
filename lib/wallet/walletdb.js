/*!
 * walletdb.js - storage for wallets
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const path = require('path');
const EventEmitter = require('events');
const bio = require('bufio');
const {BloomFilter} = require('@handshake-org/bfilter');
const {Lock, MapLock} = require('bmutex');
const bdb = require('bdb');
const Logger = require('blgr');
const LRU = require('blru');
const {safeEqual} = require('bcrypto/lib/safe');
const aes = require('bcrypto/lib/aes');
const Network = require('../protocol/network');
const consensus = require('../protocol/consensus');
const Path = require('./path');
const common = require('./common');
const Wallet = require('./wallet');
const Account = require('./account');
const Block = require('../primitives/block');
const Outpoint = require('../primitives/outpoint');
const layouts = require('./layout');
const records = require('./records');
const NullClient = require('./nullclient');
const WalletMigrator = require('./migrations');
const layout = layouts.wdb;
const tlayout = layouts.txdb;
const {states} = require('../covenants/namestate');
const util = require('../utils/util');
const {scanActions} = require('../blockchain/common');

/** @typedef {ReturnType<bdb.DB['batch']>} Batch */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('../primitives/claim')} Claim */
/** @typedef {import('../blockchain/common').ScanAction} ScanAction */
/** @typedef {import('../blockchain/chainentry')} ChainEntry */
/** @typedef {import('./records').BlockMeta} BlockMeta */
/** @typedef {import('./txdb').BlockExtraInfo} BlockExtraInfo */
/** @typedef {import('./walletkey')} WalletKey */
/** @typedef {import('./nodeclient')} NodeClient */
/** @typedef {import('./client')} NodeHTTPClient */

const {
  ChainState,
  BlockMeta,
  TXRecord,
  MapRecord
} = records;

/**
 * @typedef {Object} AddBlockResult
 * @property {Number} txs - Number of transactions added on this add.
 * @property {Boolean} filterUpdated - Whether the bloom filter was updated.
 */

/**
 * @typedef {Object} AddTXResult
 * @property {Set<Number>} wids - Wallet IDs affected.
 * @property {Boolean} filterUpdated - Whether the bloom filter was updated.

/**
 * WalletDB
 * @alias module:wallet.WalletDB
 * @extends EventEmitter
 */

class WalletDB extends EventEmitter {
  /**
   * Create a wallet db.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.options = new WalletOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context('wallet');
    this.workers = this.options.workers;
    /** @type {NullClient|NodeClient|NodeHTTPClient} */
    this.client = this.options.client || new NullClient(this);
    this.feeRate = this.options.feeRate;
    /** @type {bdb.DB} */
    this.db = bdb.create(this.options);
    this.name = 'wallet';
    this.version = 4;

    // chain state.
    this.hasStateCache = false;
    this.state = new ChainState();
    this.height = 0;

    // block time cache by height.
    this.timeCache = new LRU(30);

    // wallets
    this.primary = null;
    this.wallets = new Map();
    this.depth = 0;

    // guards
    this.confirming = false;
    this.rescanning = false;
    this.filterSent = false;

    // Wallet read lock.
    this.readLock = new MapLock();

    // Wallet write lock (creation and rename).
    this.writeLock = new Lock();

    // Lock for handling anything tx related.
    this.txLock = new Lock();

    // Address and outpoint filter.
    this.filter = new BloomFilter();

    this.init();
  }

  /**
   * Initialize walletdb.
   * @private
   */

  init() {
    let items = 3000000;
    let flag = -1;

    // Highest number of items with an
    // FPR of 0.001. We have to do this
    // by hand because BloomFilter.fromRate's
    // policy limit enforcing is fairly
    // naive.
    if (this.options.spv) {
      items = 20000;
      flag = BloomFilter.flags.ALL;
    }

    this.filter = BloomFilter.fromRate(items, 0.001, flag);
    this._bind();
  }

  /**
   * Bind to node events.
   * @private
   */

  _bind() {
    this.client.on('error', (err) => {
      this.emit('error', err);
    });

    this.client.on('connect', async () => {
      this.emit('connect');
      try {
        await this.syncNode();
        this.emit('sync done', this.state);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.on('disconnect', async () => {
      this.emit('disconnect');
      this.filterSent = false;
    });

    this.client.bind('block connect', async (entry, txs) => {
      // If we are rescanning or doing initial sync we ignore
      // block connect events. This avoids deadlocks when using
      // nodeclient, but also skips unnecessary addBlock calls
      // that would just repeat after the txLock is unlocked.
      if (this.rescanning)
        return;

      try {
        await this.addBlock(entry, txs);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.bind('block disconnect', async (entry) => {
      if (this.rescanning)
        return;

      try {
        await this.removeBlock(entry);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.hook('block rescan', async (entry, txs) => {
      try {
        await this.rescanBlock(entry, txs);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.hook('block rescan interactive', async (entry, txs) => {
      try {
        this.timeCache.start();
        const result = await this.rescanBlockInteractive(entry, txs);
        this.timeCache.commit();
        return result;
      } catch (e) {
        this.emit('error', e);
        this.timeCache.drop();
        return {
          type: scanActions.ABORT
        };
      }
    });

    this.client.hook('block rescan interactive abort', async (message) => {
      this.emit('error', new Error(message));
    });

    this.client.bind('tx', async (tx) => {
      try {
        await this.addTX(tx);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.bind('chain reset', async (tip) => {
      try {
        await this.resetChain(tip);
      } catch (e) {
        this.emit('error', e);
      }
    });
  }

  /**
   * Open the walletdb, wait for the database to load.
   * @returns {Promise<void>}
   */

  async open() {
    this.logger.info('Opening WalletDB...');
    await this.db.open();

    const migrator = new WalletMigrator({
      ...this.options,
      walletDB: this,
      dbVersion: this.version
    });

    const migrationResult = await migrator.migrate();

    await this.db.verify(layout.V.encode(), this.name, this.version);
    await this.verifyNetwork();

    this.depth = await this.getDepth();

    if (this.options.wipeNoReally)
      await this.wipe();

    await this.loadState();

    this.logger.info(
      'WalletDB is loading (depth=%d, height=%d, start=%d).',
      this.depth,
      this.state.height,
      this.state.startHeight);

    const wallet = await this.ensure({
      id: 'primary'
    });

    const addr = await wallet.receiveAddress();

    this.logger.info(
      'Loaded primary wallet (id=%s, wid=%d, address=%s)',
      wallet.id, wallet.wid, addr.toString(this.network));

    this.primary = wallet;

    if (migrationResult.rescan) {
      if (!this.options.migrateNoRescan) {
        this.logger.info('Migration rollback...');
        await this.rollback(0);
      } else {
        this.logger.warning(
          'Migration rescan skipped, state may be incorrect.');
      }
    }

    if (migrationResult.recalculateTXDB)
      await this.recalculateBalances();

    await this.preloadAll();
    await this.watch();

    this.logger.info('WalletDB opened.');
    this.emit('open');
  }

  /**
   * Write chaindb version.
   * @param {Batch} b
   * @param {Number} version
   */

  writeVersion(b, version) {
    const value = Buffer.alloc(this.name.length + 4);

    value.write(this.name, 0, 'ascii');
    value.writeUInt32LE(version, this.name.length);

    b.put(layout.V.encode(), value);
  }

  /**
   * Preload all wallets.
   * @returns {Promise<void>}
   */

  async preloadAll() {
    if (!this.options.preloadAll)
      return;

    this.logger.info('Preloading all wallets...');
    const wallets = await this.getWallets();

    for (const wname of wallets)
      await this.get(wname);
  }

  /**
   * Verify network.
   * @returns {Promise<void>}
   */

  async verifyNetwork() {
    const raw = await this.db.get(layout.O.encode());

    if (!raw) {
      const b = this.db.batch();
      b.put(layout.O.encode(), fromU32(this.network.magic));
      return b.write();
    }

    const magic = raw.readUInt32LE(0);

    if (magic !== this.network.magic)
      throw new Error('Network mismatch for WalletDB.');

    return undefined;
  }

  /**
   * Add genesis block.
   * @returns {Promise<void>}
   */

  async saveGenesis() {
    // Write genesis block.
    const network = this.network;
    const block = Block.decode(network.genesisBlock);
    const entry = {
      hash: block.hash(),
      height: 0,
      time: block.time,
      prevBlock: consensus.ZERO_HASH
    };

    // hack around equality check in state height.
    this.state.height = -1;
    await this.addBlock(entry, []);
  }

  /**
   * Close the walletdb, wait for the database to close.
   * @returns {Promise<void>}
   */

  async close() {
    if (this.client.opened)
      await this.disconnect();

    for (const wallet of this.wallets.values()) {
      await wallet.destroy();
      this.unregister(wallet);
    }

    this.timeCache.reset();
    await this.db.close();
    this.logger.info('WalletDB Closed.');
    this.emit('close');
  }

  /**
   * Watch addresses and outpoints.
   * @private
   * @returns {Promise<void>}
   */

  async watch() {
    const piter = this.db.iterator({
      gte: layout.p.min(),
      lte: layout.p.max()
    });

    let hashes = 0;

    await piter.each((key) => {
      const [data] = layout.p.decode(key);

      this.filter.add(data);

      hashes += 1;
    });

    this.logger.info('Added %d hashes to WalletDB filter.', hashes);

    const oiter = this.db.iterator({
      gte: layout.o.min(),
      lte: layout.o.max()
    });

    let outpoints = 0;

    await oiter.each((key) => {
      const [hash, index] = layout.o.decode(key);
      const outpoint = new Outpoint(hash, index);
      const data = outpoint.encode();

      this.filter.add(data);

      outpoints += 1;
    });

    this.logger.info('Added %d outpoints to WalletDB filter.', outpoints);

    const niter = this.db.iterator({
      gte: layout.N.min(),
      lte: layout.N.max()
    });

    let names = 0;

    await niter.each((key) => {
      const [data] = layout.N.decode(key);

      this.filter.add(data);

      names += 1;
    });

    this.logger.info('Added %d names to WalletDB filter.', names);
  }

  /**
   * Connect to the node server (client required).
   * @returns {Promise<void>}
   */

  async connect() {
    return this.client.open();
  }

  /**
   * Disconnect from node server (client required).
   * @returns {Promise<void>}
   */

  async disconnect() {
    return this.client.close();
  }

  /**
   * Sync state with server on every connect.
   * @returns {Promise<void>}
   */

  async syncNode() {
    const unlock = await this.txLock.lock();
    this.rescanning = true;
    try {
      this.logger.info('Resyncing from server...');
      await this.syncInitState();
      await this.syncFilter();
      await this.syncChain();
      this.rescanning = false;
      await this.resend();
    } finally {
      this.rescanning = false;
      unlock();
    }
  }

  /**
   * Recover state from the cache.
   * @returns {Promise<void>}
   */

  async loadState() {
    const cache = await this.getState();

    if (!cache) {
      await this.saveGenesis();
      return;
    }

    this.logger.info('Initialized chain state from the database.');
    this.hasStateCache = true;
    this.state = cache;
    this.height = cache.height;
  }

  /**
   * Initialize and write initial sync state.
   * @returns {Promise<void>}
   */

  async syncInitState() {
    // We have recovered from the cache.
    if (this.hasStateCache)
      return;

    this.logger.info('Initializing database state from server.');

    const b = this.db.batch();
    const entries = await this.client.getEntries();
    assert(entries, 'Could not get chain entries.');

    let tip = null;

    for (let height = 0; height < entries.length; height++) {
      const entry = entries[height];
      assert(entry.height === height);
      const meta = new BlockMeta(entry.hash, entry.height, entry.time);
      b.put(layout.h.encode(height), meta.toHashAndTime());
      tip = meta;
    }

    assert(tip);

    const state = this.state.clone();
    state.startHeight = tip.height;
    state.startHash = tip.hash;
    state.height = tip.height;
    state.marked = false;

    b.put(layout.R.encode(), state.encode());

    await b.write();

    this.state = state;
    this.height = state.height;

    return;
  }

  /**
   * Connect and sync with the chain server.
   * Part of syncNode.
   * @private
   * @returns {Promise<void>}
   */

  async syncChain() {
    let height = this.state.height;

    this.logger.info('Syncing state from height %d.', height);

    for (;;) {
      const tip = await this.getBlock(height);
      assert(tip);

      if (await this.client.getEntry(tip.hash))
        break;

      assert(height !== 0);
      height -= 1;
    }

    // syncNode sets the rescanning to true.
    return this.scanInteractive(height);
  }

  /**
   * Rescan blockchain from a given height.
   * Needs this.rescanning = true to be set from the caller.
   * @param {Number} [height=this.state.startHeight]
   * @returns {Promise<void>}
   */

  async scan(height) {
    assert(this.rescanning, 'WDB: Rescanning guard not set.');

    if (height == null)
      height = this.state.startHeight;

    assert((height >>> 0) === height, 'WDB: Must pass in a height.');

    this.logger.info(
      'Rolling back %d blocks.',
      this.height - height + 1);

    await this.rollback(height);

    this.logger.info(
      'WalletDB is scanning %d blocks.',
      this.state.height - height + 1);

    const tip = await this.getTip();

    return this.client.rescan(tip.hash);
  }

  /**
   * Interactive scan blockchain from a given height.
   * Expect this.rescanning to be set to true.
   * @private
   * @param {Number} [height=this.state.startHeight]
   * @param {Boolean} [fullLock=true]
   * @returns {Promise<void>}
   */

  async scanInteractive(height, fullLock = true) {
    assert(this.rescanning, 'WDB: Rescanning guard not set.');

    if (height == null)
      height = this.state.startHeight;

    assert((height >>> 0) === height, 'WDB: Must pass in a height.');

    this.logger.info(
      'Rolling back %d blocks.',
      this.height - height + 1);

    await this.rollback(height);

    this.logger.info(
      'WalletDB is scanning %d blocks.',
      this.state.height - height + 1);

    const tip = await this.getTip();

    return this.client.rescanInteractive(tip.hash, fullLock);
  }

  /**
   * Deep Clean:
   * Keep all keys, account data, wallet maps (name and path).
   * Dump all TX history and balance state.
   * A rescan will be required but is not initiated automatically.
   * @returns {Promise<void>}
   */

  async deepClean() {
    const unlock1 = await this.txLock.lock();
    const unlock2 = await this.writeLock.lock();
    const unlock3 = await this.readLock.lock();
    try {
      return await this._deepClean();
    } finally {
      unlock3();
      unlock2();
      unlock1();
    }
  }

  /**
   * Deep Clean (without locks):
   * Keep all keys, account data, wallet maps (name and path).
   * Dump all TX history and balance state.
   * A rescan will be required but is not initiated automatically.
   * @returns {Promise<void>}
   */

  async _deepClean() {
    this.logger.warning('Initiating Deep Clean...');

    const b = this.db.batch();
    const removeRange = (opt) => {
      return this.db.iterator(opt).each(key => b.del(key));
    };

    this.logger.warning('Clearing block map, tx map and outpoint map...');
    // b[height] -> block->wid map
    await removeRange({
      gte: layout.b.min(),
      lte: layout.b.max()
    });

    // o[hash][index] -> outpoint->wid map
    await removeRange({
      gte: layout.o.min(),
      lte: layout.o.max()
    });

    // T[hash] -> tx->wid map
    await removeRange({
      gte: layout.T.min(),
      lte: layout.T.max()
    });

    const wnames = await this.getWallets();

    for (const wname of wnames) {
      const wallet = await this.get(wname);
      this.logger.warning(
        'Clearing all tx history for wallet: %s (%d)',
        wallet.id, wallet.wid
      );

      // remove all txdb data *except* blinds ('v')
      const key = 'v'.charCodeAt(0);
      const prefix = layout.t.encode(wallet.wid);
      await removeRange({
        gte: Buffer.concat([prefix, Buffer.alloc(1)]),
        lt:  Buffer.concat([prefix, Buffer.from([key])])
      });
      await removeRange({
        gt: Buffer.concat([prefix, Buffer.from([key + 1])]),
        lte: Buffer.concat([prefix, Buffer.from([0xff])])
      });
    }

    await b.write();

    this.logger.warning('Deep Clean complete. A rescan is now required.');
  }

  /**
   * Force a rescan.
   * @param {Number} height
   * @returns {Promise<void>}
   */

  async rescan(height) {
    const unlock = await this.txLock.lock();

    try {
      return await this._rescan(height);
    } finally {
      unlock();
    }
  }

  /**
   * Force a rescan (without a lock).
   * @private
   * @param {Number} height
   * @returns {Promise<void>}
   */

  async _rescan(height) {
    this.rescanning = true;

    try {
      return await this.scanInteractive(height);
    } finally {
      this.rescanning = false;
    }
  }

  /**
   * Recalculate balances from the coins.
   * @returns {Promise<void>}
   */

  async recalculateBalances() {
    const unlock = await this.txLock.lock();

    try {
      return await this._recalculateBalances();
    } finally {
      unlock();
    }
  }

  /**
   * Recalculate balances from the coins (without a lock).
   * @returns {Promise<void>}
   */

  async _recalculateBalances() {
    const wnames = await this.getWallets();

    for (const wname of wnames) {
      const wallet = await this.get(wname);
      await wallet.recalculateBalances();
    }
  }

  /**
   * Broadcast a transaction via chain server.
   * @param {TX} tx
   * @returns {Promise<void>}
   */

  async send(tx) {
    return this.client.send(tx);
  }

  /**
   * Broadcast a claim via chain server.
   * @param {Claim} claim
   * @returns {Promise<void>}
   */

  async sendClaim(claim) {
    return this.client.sendClaim(claim);
  }

  /**
   * Estimate smart fee from chain server.
   * @param {Number} blocks
   * @returns {Promise<Number>}
   */

  async estimateFee(blocks) {
    if (this.feeRate > 0)
      return this.feeRate;

    const rate = await this.client.estimateFee(blocks);

    if (rate < this.network.feeRate)
      return this.network.feeRate;

    if (rate > this.network.maxFeeRate)
      return this.network.maxFeeRate;

    return rate;
  }

  /**
   * Get name state.
   * @param {Buffer} nameHash
   * @returns {Promise<Object>}
   */

  async getNameStatus(nameHash) {
    return this.client.getNameStatus(nameHash);
  }

  /**
   * Get UTXO from node.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Object>}
   */

  async getCoin(hash, index) {
    return this.client.getCoin(hash, index);
  }

  /**
   * Test whether name is available for CLAIM.
   * @param {Buffer} nameHash
   * @returns {Promise<Boolean>}
   */

  async isAvailable(nameHash) {
    const ns = await this.getNameStatus(nameHash);
    const state = ns.state(this.height + 1, this.network);
    return state === states.OPENING
        || state === states.LOCKED
        || (state === states.CLOSED && !ns.registered);
  }

  /**
   * Send filter to the remote node.
   * @private
   * @returns {Promise<Object>}
   */

  syncFilter() {
    this.logger.info('Sending filter to server (%dmb).',
      this.filter.size / 8 / (1 << 20));

    this.filterSent = true;
    return this.client.setFilter(this.filter);
  }

  /**
   * Add data to remote filter.
   * @private
   * @param {Buffer} data
   * @returns {Promise}
   */

  addFilter(data) {
    if (!this.filterSent)
      return undefined;
    return this.client.addFilter(data);
  }

  /**
   * Reset remote filter.
   * @private
   * @returns {Promise}
   */

  resetFilter() {
    if (!this.filterSent)
      return undefined;
    return this.client.resetFilter();
  }

  /**
   * Backup the wallet db.
   * @param {String} path
   * @returns {Promise}
   */

  backup(path) {
    return this.db.backup(path);
  }

  /**
   * Wipe the txdb - NEVER USE.
   * @returns {Promise}
   */

  async wipe() {
    this.logger.warning('Wiping WalletDB TXDB...');
    this.logger.warning('I hope you know what you\'re doing.');

    const iter = this.db.iterator();
    const b = this.db.batch();

    let total = 0;

    await iter.each((key) => {
      switch (key[0]) {
        case 0x62: // b
        case 0x63: // c
        case 0x65: // e
        case 0x74: // t
        case 0x6f: // o
        case 0x68: // h
        case 0x52: // R
          b.del(key);
          total += 1;
          break;
      }
    });

    this.logger.warning('Wiped %d txdb records.', total);

    return b.write();
  }

  /**
   * Get current wallet wid depth.
   * @private
   * @returns {Promise}
   */

  async getDepth() {
    const raw = await this.db.get(layout.D.encode());

    if (!raw)
      return 0;

    return raw.readUInt32LE(0);
  }

  /**
   * Test the bloom filter against a tx or address hash.
   * @private
   * @param {Hash} data
   * @returns {Boolean}
   */

  testFilter(data) {
    return this.filter.test(data);
  }

  /**
   * Add hash to local and remote filters.
   * @private
   * @param {Hash} hash
   */

  addHash(hash) {
    this.filter.add(hash);
    return this.addFilter(hash);
  }

  /**
   * Add hash to local and remote filters.
   * @private
   * @param {Hash} nameHash
   */

  addName(nameHash) {
    this.filter.add(nameHash);
    return this.addFilter(nameHash);
  }

  /**
   * Add outpoint to local filter.
   * @private
   * @param {Hash} hash
   * @param {Number} index
   */

  addOutpoint(hash, index) {
    const outpoint = new Outpoint(hash, index);
    this.filter.add(outpoint.encode());
  }

  /**
   * Dump database (for debugging).
   * @returns {Promise} - Returns Object.
   */

  dump() {
    return this.db.dump();
  }

  /**
   * Register an object with the walletdb.
   * @param {Wallet} wallet
   */

  register(wallet) {
    assert(!this.wallets.has(wallet.wid));
    this.wallets.set(wallet.wid, wallet);
  }

  /**
   * Unregister a object with the walletdb.
   * @param {Wallet} wallet
   */

  unregister(wallet) {
    assert(this.wallets.has(wallet.wid));
    this.wallets.delete(wallet.wid);
  }

  /**
   * Map wallet id to wid.
   * @param {String|Number} id
   * @returns {Promise<Number>}
   */

  async ensureWID(id) {
    if (typeof id === 'number') {
      if (!await this.db.has(layout.W.encode(id)))
        return -1;
      return id;
    }

    return this.getWID(id);
  }

  /**
   * Map wallet id to wid.
   * @param {String} id
   * @returns {Promise<Number>}
   */

  async getWID(id) {
    const data = await this.db.get(layout.l.encode(id));

    if (!data)
      return -1;

    assert(data.length === 4);

    return data.readUInt32LE(0);
  }

  /**
   * Map wallet wid to id.
   * @param {Number} wid
   * @returns {Promise<String?>}
   */

  async getID(wid) {
    const data = await this.db.get(layout.W.encode(wid));

    if (!data)
      return null;

    return toString(data);
  }

  /**
   * Get a wallet from the database, setup watcher.
   * @param {Number|String} id
   * @returns {Promise<Wallet?>}
   */

  async get(id) {
    const wid = await this.ensureWID(id);

    if (wid === -1)
      return null;

    const unlock = await this.readLock.lock(wid);

    try {
      return await this._get(wid);
    } finally {
      unlock();
    }
  }

  /**
   * Get a wallet from the database without a lock.
   * @private
   * @param {Number} wid
   * @returns {Promise<Wallet?>}
   */

  async _get(wid) {
    const cache = this.wallets.get(wid);

    if (cache)
      return cache;

    const id = await this.getID(wid);

    if (!id)
      return null;

    const data = await this.db.get(layout.w.encode(wid));
    assert(data);

    const wallet = Wallet.decode(this, data);

    wallet.wid = wid;
    wallet.id = id;

    await wallet.open();

    this.register(wallet);

    return wallet;
  }

  /**
   * Save a wallet to the database.
   * @param {Batch} b
   * @param {Wallet} wallet
   */

  save(b, wallet) {
    const wid = wallet.wid;
    const id = wallet.id;

    b.put(layout.w.encode(wid), wallet.encode());
    b.put(layout.W.encode(wid), fromString(id));
    b.put(layout.l.encode(id), fromU32(wid));
  }

  /**
   * Increment the wid depth.
   * @param {Batch} b
   * @param {Number} wid
   */

  increment(b, wid) {
    b.put(layout.D.encode(), fromU32(wid + 1));
  }

  /**
   * Rename a wallet.
   * @param {Wallet} wallet
   * @param {String} id
   * @returns {Promise}
   */

  async rename(wallet, id) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._rename(wallet, id);
    } finally {
      unlock();
    }
  }

  /**
   * Rename a wallet without a lock.
   * @private
   * @param {Wallet} wallet
   * @param {String} id
   * @returns {Promise}
   */

  async _rename(wallet, id) {
    if (!common.isName(id))
      throw new Error('WDB: Bad wallet ID.');

    if (await this.has(id))
      throw new Error('WDB: ID not available.');

    const b = this.db.batch();

    // Update wid->id index.
    b.put(layout.W.encode(wallet.wid), fromString(id));

    // Delete old id->wid index.
    b.del(layout.l.encode(wallet.id));

    // Add new id->wid index.
    b.put(layout.l.encode(id), fromU32(wallet.wid));

    await b.write();

    wallet.id = id;
  }

  /**
   * Rename an account.
   * @param {Batch} b
   * @param {Account} account
   * @param {String} name
   */

  renameAccount(b, account, name) {
    const wid = account.wid;
    const index = account.accountIndex;

    // Remove old wid/name->account index.
    b.del(layout.i.encode(wid, account.name));

    // Name->Index lookups
    b.put(layout.i.encode(wid, name), fromU32(index));

    // Index->Name lookups
    b.put(layout.n.encode(wid, index), fromString(name));

    account.name = name;
  }

  /**
   * Remove a wallet.
   * @param {Number|String} id
   * @returns {Promise<Boolean>}
   */

  async remove(id) {
    const wid = await this.ensureWID(id);

    if (wid === -1)
      return false;

    // Grab all locks.
    const unlock1 = await this.readLock.lock(wid);
    const unlock2 = await this.writeLock.lock();
    const unlock3 = await this.txLock.lock();

    try {
      return await this._remove(wid);
    } finally {
      unlock3();
      unlock2();
      unlock1();
    }
  }

  /**
   * Remove a wallet (without a lock).
   * @private
   * @param {Number} wid
   * @returns {Promise<Boolean>}
   */

  async _remove(wid) {
    const id = await this.getID(wid);

    if (!id)
      return false;

    if (id === 'primary')
      throw new Error('Cannot remove primary wallet.');

    const b = this.db.batch();

    b.del(layout.w.encode(wid));
    b.del(layout.W.encode(wid));
    b.del(layout.l.encode(id));

    const piter = this.db.iterator({
      gte: layout.P.min(wid),
      lte: layout.P.max(wid)
    });

    await piter.each((key, value) => {
      const [, hash] = layout.P.decode(key);
      b.del(key);
      return this.removePathMap(b, hash, wid);
    });

    const niter = this.db.iterator({
      gte: layout.N.min(),
      lte: layout.N.max()
    });

    await niter.each((key) => {
      const [hash] = layout.N.decode(key);
      return this.removeNameMap(b, hash, wid);
    });

    const removeRange = (opt) => {
      return this.db.iterator(opt).each(key => b.del(key));
    };

    await removeRange({
      gte: layout.r.min(wid),
      lte: layout.r.max(wid)
    });

    await removeRange({
      gte: layout.a.min(wid),
      lte: layout.a.max(wid)
    });

    await removeRange({
      gte: layout.i.min(wid),
      lte: layout.i.max(wid)
    });

    await removeRange({
      gte: layout.n.min(wid),
      lte: layout.n.max(wid)
    });

    await removeRange({
      gt: layout.t.encode(wid),
      lt: layout.t.encode(wid + 1)
    });

    const bucket = this.db.bucket(layout.t.encode(wid));

    const biter = bucket.iterator({
      gte: tlayout.b.min(),
      lte: tlayout.b.max()
    });

    await biter.each((key, value) => {
      const [height] = tlayout.b.decode(key);
      return this.removeBlockMap(b, height, wid);
    });

    const siter = bucket.iterator({
      gte: tlayout.s.min(),
      lte: tlayout.s.max(),
      keys: true
    });

    await siter.each((key, value) => {
      const [hash, index] = tlayout.s.decode(key);
      return this.removeOutpointMap(b, hash, index, wid);
    });

    const uiter = bucket.iterator({
      gte: tlayout.p.min(),
      lte: tlayout.p.max(),
      keys: true
    });

    await uiter.each((key, value) => {
      const [hash] = tlayout.p.decode(key);
      return this.removeTXMap(b, hash, wid);
    });

    const wallet = this.wallets.get(wid);

    if (wallet) {
      await wallet.destroy();
      this.unregister(wallet);
    }

    await b.write();

    return true;
  }

  /**
   * Get a wallet with token auth first.
   * @param {Number|String} id
   * @param {Buffer} token
   * @returns {Promise<Wallet|null>}
   */

  async auth(id, token) {
    const wallet = await this.get(id);

    if (!wallet)
      return null;

    // Compare in constant time:
    if (!safeEqual(token, wallet.token))
      throw new Error('WDB: Authentication error.');

    return wallet;
  }

  /**
   * Create a new wallet, save to database, setup watcher.
   * @param {Object} options - See {@link Wallet}.
   * @returns {Promise<Wallet>}
   */

  async create(options) {
    const unlock = await this.writeLock.lock();

    if (!options)
      options = {};

    try {
      return await this._create(options);
    } finally {
      unlock();
    }
  }

  /**
   * Create a new wallet, save to database without a lock.
   * @private
   * @param {Object} options - See {@link Wallet}.
   * @returns {Promise<Wallet>}
   */

  async _create(options) {
    if (options.id) {
      if (await this.has(options.id))
        throw new Error('WDB: Wallet already exists.');
    }

    const wallet = Wallet.fromOptions(this, options);

    wallet.wid = this.depth;

    await wallet.init(options, options.passphrase);

    this.depth += 1;

    this.register(wallet);

    this.logger.info('Created wallet %s in WalletDB.', wallet.id);

    return wallet;
  }

  /**
   * Test for the existence of a wallet.
   * @param {Number|String} id
   * @returns {Promise<Boolean>}
   */

  async has(id) {
    const wid = await this.ensureWID(id);
    return wid !== -1;
  }

  /**
   * Attempt to create wallet, return wallet if already exists.
   * @param {Object} options - See {@link Wallet}.
   * @returns {Promise<Wallet>}
   */

  async ensure(options) {
    if (options.id) {
      const wallet = await this.get(options.id);

      if (wallet)
        return wallet;
    }

    return this.create(options);
  }

  /**
   * Get an account from the database by wid.
   * @param {Number} wid
   * @param {Number} index - Account index.
   * @returns {Promise<Account>}
   */

  async getAccount(wid, index) {
    const name = await this.getAccountName(wid, index);

    if (!name)
      return null;

    const data = await this.db.get(layout.a.encode(wid, index));
    assert(data);

    const account = Account.decode(this, data);

    account.accountIndex = index;
    account.name = name;

    return account;
  }

  /**
   * List account names and indexes from the db.
   * @param {Number} wid
   * @returns {Promise<String[]>} - Returns Array.
   */

  async getAccounts(wid) {
    return this.db.values({
      gte: layout.n.min(wid),
      lte: layout.n.max(wid),
      parse: toString
    });
  }

  /**
   * Lookup the corresponding account name's index.
   * @param {Number} wid
   * @param {String} name - Account name/index.
   * @returns {Promise<Number>}
   */

  async getAccountIndex(wid, name) {
    const index = await this.db.get(layout.i.encode(wid, name));

    if (!index)
      return -1;

    return index.readUInt32LE(0);
  }

  /**
   * Lookup the corresponding account index's name.
   * @param {Number} wid
   * @param {Number} index
   * @returns {Promise<String|null>}
   */

  async getAccountName(wid, index) {
    const name = await this.db.get(layout.n.encode(wid, index));

    if (!name)
      return null;

    return toString(name);
  }

  /**
   * Save an account to the database.
   * @param {Batch} b
   * @param {Account} account
   */

  saveAccount(b, account) {
    const wid = account.wid;
    const index = account.accountIndex;
    const name = account.name;

    // Account data
    b.put(layout.a.encode(wid, index), account.encode());

    // Name->Index lookups
    b.put(layout.i.encode(wid, name), fromU32(index));

    // Index->Name lookups
    b.put(layout.n.encode(wid, index), fromString(name));
  }

  /**
   * Test for the existence of an account.
   * @param {Number} wid
   * @param {Number} index
   * @returns {Promise<Boolean>}
   */

  async hasAccount(wid, index) {
    return this.db.has(layout.a.encode(wid, index));
  }

  /**
   * Save an address to the path map.
   * @param {Batch} b
   * @param {Number} wid
   * @param {WalletKey} ring
   * @returns {Promise}
   */

  async saveKey(b, wid, ring) {
    return this.savePath(b, wid, ring.toPath());
  }

  /**
   * Save a path to the path map.
   *
   * The path map exists in the form of:
   *   - `p[address-hash] -> wid map`
   *   - `P[wid][address-hash] -> path data`
   *   - `r[wid][account-index][address-hash] -> dummy`
   *
   * @param {Batch} b
   * @param {Number} wid
   * @param {Path} path
   * @returns {Promise}
   */

  async savePath(b, wid, path) {
    // Address Hash -> Wallet Map
    await this.addPathMap(b, path.hash, wid);

    // Wallet ID + Address Hash -> Path Data
    b.put(layout.P.encode(wid, path.hash), path.encode());

    // Wallet ID + Account Index + Address Hash -> Dummy
    b.put(layout.r.encode(wid, path.account, path.hash), null);
  }

  /**
   * Retrieve path by hash.
   * @param {Number} wid
   * @param {Hash} hash
   * @returns {Promise<Path|null>}
   */

  async getPath(wid, hash) {
    const path = await this.readPath(wid, hash);

    if (!path)
      return null;

    path.name = await this.getAccountName(wid, path.account);
    assert(path.name);

    return path;
  }

  /**
   * Retrieve path by hash.
   * @param {Number} wid
   * @param {Hash} hash
   * @returns {Promise<Path|null>}
   */

  async readPath(wid, hash) {
    const data = await this.db.get(layout.P.encode(wid, hash));

    if (!data)
      return null;

    const path = Path.decode(data);
    path.hash = hash;

    return path;
  }

  /**
   * Test whether a wallet contains a path.
   * @param {Number} wid
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  async hasPath(wid, hash) {
    return this.db.has(layout.P.encode(wid, hash));
  }

  /**
   * Get all address hashes.
   * @returns {Promise<Hash[]>}
   */

  async getHashes() {
    return this.db.keys({
      gte: layout.p.min(),
      lte: layout.p.max(),
      parse: key => layout.p.decode(key)[0]
    });
  }

  /**
   * Get all outpoints.
   * @returns {Promise<Outpoint[]>}
   */

  async getOutpoints() {
    return this.db.keys({
      gte: layout.o.min(),
      lte: layout.o.max(),
      parse: (key) => {
        const [hash, index] = layout.o.decode(key);
        return new Outpoint(hash, index);
      }
    });
  }

  /**
   * Get all address hashes.
   * @param {Number} wid
   * @returns {Promise<Hash[]>}
   */

  async getWalletHashes(wid) {
    return this.db.keys({
      gte: layout.P.min(wid),
      lte: layout.P.max(wid),
      parse: key => layout.P.decode(key)[1]
    });
  }

  /**
   * Get all account address hashes.
   * @param {Number} wid
   * @param {Number} account
   * @returns {Promise<Hash[]>}
   */

  async getAccountHashes(wid, account) {
    return this.db.keys({
      gte: layout.r.min(wid, account),
      lte: layout.r.max(wid, account),
      parse: key => layout.r.decode(key)[2]
    });
  }

  /**
   * Get all paths for a wallet.
   * @param {Number} wid
   * @returns {Promise<Path[]>}
   */

  async getWalletPaths(wid) {
    const items = await this.db.range({
      gte: layout.P.min(wid),
      lte: layout.P.max(wid)
    });

    const paths = [];

    for (const {key, value} of items) {
      const [, hash] = layout.P.decode(key);
      const path = Path.decode(value);

      path.hash = hash;
      path.name = await this.getAccountName(wid, path.account);
      assert(path.name);

      paths.push(path);
    }

    return paths;
  }

  /**
   * Get all wallet names.
   * @returns {Promise<String[]>}
   */

  async getWallets() {
    return this.db.values({
      gte: layout.W.min(),
      lte: layout.W.max(),
      parse: toString
    });
  }

  /**
   * Encrypt all imported keys for a wallet.
   * @param {Batch} b
   * @param {Number} wid
   * @param {Buffer} key
   * @returns {Promise}
   */

  async encryptKeys(b, wid, key) {
    const iter = this.db.iterator({
      gte: layout.P.min(wid),
      lte: layout.P.max(wid),
      values: true
    });

    await iter.each((k, value) => {
      const [, hash] = layout.P.decode(k);
      const path = Path.decode(value);

      if (!path.data)
        return;

      assert(!path.encrypted);

      const iv = hash.slice(0, 16);

      path.data = aes.encipher(path.data, key, iv);
      path.encrypted = true;

      b.put(k, path.encode());
    });
  }

  /**
   * Decrypt all imported keys for a wallet.
   * @param {Batch} b
   * @param {Number} wid
   * @param {Buffer} key
   * @returns {Promise}
   */

  async decryptKeys(b, wid, key) {
    const iter = this.db.iterator({
      gte: layout.P.min(wid),
      lte: layout.P.max(wid),
      values: true
    });

    await iter.each((k, value) => {
      const [, hash] = layout.P.decode(k);
      const path = Path.decode(value);

      if (!path.data)
        return;

      assert(path.encrypted);

      const iv = hash.slice(0, 16);

      path.data = aes.decipher(path.data, key, iv);
      path.encrypted = false;

      b.put(k, path.encode());
    });
  }

  /**
   * Resend all pending transactions.
   * @returns {Promise}
   */

  async resend() {
    const wids = await this.db.keys({
      gte: layout.w.min(),
      lte: layout.w.max(),
      parse: key => layout.w.decode(key)[0]
    });

    this.logger.info('Resending from %d wallets.', wids.length);

    for (const wid of wids)
      await this.resendPending(wid);
  }

  /**
   * Resend all pending transactions for a specific wallet.
   * @private
   * @param {Number} wid
   * @returns {Promise}
   */

  async resendPending(wid) {
    const prefix = layout.t.encode(wid);
    const b = this.db.bucket(prefix);

    const hashes = await b.keys({
      gte: tlayout.p.min(),
      lte: tlayout.p.max(),
      parse: key => tlayout.p.decode(key)[0]
    });

    if (hashes.length === 0)
      return;

    this.logger.info(
      'Rebroadcasting %d transactions for %d.',
      hashes.length,
      wid);

    const txs = [];

    for (const hash of hashes) {
      const data = await b.get(tlayout.t.encode(hash));

      if (!data)
        continue;

      const wtx = TXRecord.decode(data);

      if (wtx.tx.isCoinbase())
        continue;

      txs.push(wtx.tx);
    }

    for (const tx of common.sortDeps(txs))
      await this.send(tx);
  }

  /**
   * Get all wallet ids by output addresses and outpoints.
   * @param {TX} tx
   * @returns {Promise<Set<Number>>}
   */

  async getWalletsByTX(tx) {
    /** @type {Set<Number>} */
    const wids = new Set();

    if (!tx.isCoinbase()) {
      for (const {prevout} of tx.inputs) {
        const {hash, index} = prevout;

        if (!this.testFilter(prevout.encode()))
          continue;

        const map = await this.getOutpointMap(hash, index);

        if (!map)
          continue;

        for (const wid of map.wids)
          wids.add(wid);
      }
    }

    const hashes = tx.getOutputHashes();

    for (const hash of hashes) {
      if (!this.testFilter(hash))
        continue;

      const map = await this.getPathMap(hash);

      if (!map)
        continue;

      for (const wid of map.wids)
        wids.add(wid);
    }

    for (const {covenant} of tx.outputs) {
      if (!covenant.isName())
        continue;

      const nameHash = covenant.getHash(0);

      if (!this.testFilter(nameHash))
        continue;

      const map = await this.getNameMap(nameHash);

      if (!map)
        continue;

      for (const wid of map.wids)
        wids.add(wid);
    }

    if (wids.size === 0)
      return null;

    return wids;
  }

  /**
   * Get the best block hash.
   * @returns {Promise<records.ChainState|null>}
   */

  async getState() {
    const data = await this.db.get(layout.R.encode());

    if (!data)
      return null;

    return ChainState.decode(data);
  }

  /**
   * Sync the current chain state to tip.
   * @param {BlockMeta} tip
   * @param {Boolean} checkMark - should we check startHeight/mark. This should
   * only happen if we are progressing forward in history and have txs.
   * @returns {Promise}
   */

  async setTip(tip, checkMark = false) {
    const b = this.db.batch();
    const state = this.state.clone();

    // mark state if state has not been marked, we are moving forward
    // and we have txs. If state is marked, it means we already found
    // first tx for the whole wdb, so no longer move it forward.
    if (checkMark && !state.marked) {
      state.startHeight = tip.height;
      state.startHash = tip.hash;
      state.marked = true;
    }

    if (tip.height < state.height) {
      // Hashes ahead of our new tip
      // that we need to delete.
      while (state.height !== tip.height) {
        b.del(layout.h.encode(state.height));
        state.height -= 1;
      }
    } else if (tip.height > state.height) {
      assert(tip.height === state.height + 1, 'Bad chain sync.');
      state.height += 1;
    }

    if (tip.height < state.startHeight) {
      state.startHeight = tip.height;
      state.startHash = tip.hash;
      state.marked = false;
    }

    // Save tip and state.
    b.put(layout.h.encode(tip.height), tip.toHashAndTime());
    b.put(layout.R.encode(), state.encode());

    await b.write();

    this.state = state;
    this.height = state.height;
  }

  /**
   * Will return the current height and will increment
   * to the current height of a block currently being
   * added to the wallet.
   * @returns {Number}
   */

  liveHeight() {
    let height = this.height;

    if (this.confirming)
      height += 1;

    return height;
  }

  /**
   * Get a wallet map.
   * @param {Buffer} key
   * @returns {Promise<records.MapRecord|null>}
   */

  async getMap(key) {
    const data = await this.db.get(key);

    if (!data)
      return null;

    return MapRecord.decode(data);
  }

  /**
   * Does wdb have wallet map.
   * @param {Buffer} key
   * @param {Number} wid
   * @returns {Promise<Boolean>}
   */

  async hasMap(key, wid) {
    const map = await this.getMap(key);

    if (!map)
      return false;

    return map.has(wid);
  }

  /**
   * Add wid to a wallet map.
   * @param {Batch} b
   * @param {Buffer} key
   * @param {Number} wid
   * @returns {Promise}
   */

  async addMap(b, key, wid) {
    const data = await this.db.get(key);

    if (!data) {
      const map = new MapRecord();
      map.add(wid);
      b.put(key, map.encode());
      return;
    }

    const len = bio.readU32(data, 0);
    const bw = bio.write(data.length + 4);

    bw.writeU32(len + 1);
    bw.copy(data, 4, data.length);
    bw.writeU32(wid);

    b.put(key, bw.render());
  }

  /**
   * Remove wid from a wallet map.
   * @param {Batch} b
   * @param {Buffer} key
   * @param {Number} wid
   * @returns {Promise}
   */

  async removeMap(b, key, wid) {
    const map = await this.getMap(key);

    if (!map)
      return;

    if (!map.remove(wid))
      return;

    if (map.wids.size === 0) {
      b.del(key);
      return;
    }

    b.put(key, map.encode());
  }

  /**
   * Get a wallet map.
   * @param {Hash} hash
   * @returns {Promise<records.MapRecord|null>}
   */

  async getPathMap(hash) {
    return this.getMap(layout.p.encode(hash));
  }

  /**
   * Add wid to a wallet map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} wid
   * @returns {Promise}
   */

  async addPathMap(b, hash, wid) {
    await this.addHash(hash);
    return this.addMap(b, layout.p.encode(hash), wid);
  }

  /**
   * Remove wid from a wallet map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} wid
   * @returns {Promise}
   */

  async removePathMap(b, hash, wid) {
    return this.removeMap(b, layout.p.encode(hash), wid);
  }

  /**
   * Get a wallet map.
   * @param {Number} height
   * @returns {Promise<records.MapRecord|null>}
   */

  async getBlockMap(height) {
    return this.getMap(layout.b.encode(height));
  }

  /**
   * Add wid to a wallet map.
   * @param {Batch} b
   * @param {Number} height
   * @param {Number} wid
   * @returns {Promise}
   */

  async addBlockMap(b, height, wid) {
    return this.addMap(b, layout.b.encode(height), wid);
  }

  /**
   * Remove wid from a wallet map.
   * @param {Batch} b
   * @param {Number} height
   * @param {Number} wid
   * @returns {Promise}
   */

  async removeBlockMap(b, height, wid) {
    return this.removeMap(b, layout.b.encode(height), wid);
  }

  /**
   * Get a wallet map.
   * @param {Hash} hash
   * @returns {Promise<records.MapRecord|null>}
   */

  async getTXMap(hash) {
    return this.getMap(layout.T.encode(hash));
  }

  /**
   * Add wid to a wallet map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} wid
   * @returns {Promise}
   */

  async addTXMap(b, hash, wid) {
    return this.addMap(b, layout.T.encode(hash), wid);
  }

  /**
   * Remove wid from a wallet map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} wid
   * @returns {Promise}
   */

  async removeTXMap(b, hash, wid) {
    return this.removeMap(b, layout.T.encode(hash), wid);
  }

  /**
   * Get a wallet map.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<records.MapRecord|null>}
   */

  async getOutpointMap(hash, index) {
    return this.getMap(layout.o.encode(hash, index));
  }

  /**
   * Add wid to a wallet map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} index
   * @param {Number} wid
   * @returns {Promise}
   */

  async addOutpointMap(b, hash, index, wid) {
    this.addOutpoint(hash, index);
    return this.addMap(b, layout.o.encode(hash, index), wid);
  }

  /**
   * Remove wid from a wallet map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} index
   * @param {Number} wid
   * @returns {Promise}
   */

  async removeOutpointMap(b, hash, index, wid) {
    return this.removeMap(b, layout.o.encode(hash, index), wid);
  }

  /**
   * Get a wallet map.
   * @param {Hash} nameHash
   * @returns {Promise<records.MapRecord|null>}
   */

  async getNameMap(nameHash) {
    return this.getMap(layout.N.encode(nameHash));
  }

  /**
   * Has wid in the wallet map.
   * @param {Buffer} nameHash
   * @param {Number} wid
   * @returns {Promise<Boolean>}
   */

  async hasNameMap(nameHash, wid) {
    return this.hasMap(layout.N.encode(nameHash), wid);
  }

  /**
   * Add wid to a wallet map.
   * @param {Batch} b
   * @param {Hash} nameHash
   * @param {Number} wid
   * @returns {Promise}
   */

  async addNameMap(b, nameHash, wid) {
    await this.addName(nameHash);
    return this.addMap(b, layout.N.encode(nameHash), wid);
  }

  /**
   * Remove wid from a wallet map.
   * @param {Batch} b
   * @param {Hash} nameHash
   * @param {Number} wid
   * @returns {Promise}
   */

  async removeNameMap(b, nameHash, wid) {
    return this.removeMap(b, layout.N.encode(nameHash), wid);
  }

  /**
   * Get a wallet block meta.
   * @param {Number} height
   * @returns {Promise<BlockMeta?>}
   */

  async getBlock(height) {
    const data = await this.db.get(layout.h.encode(height));

    if (!data)
      return null;

    return BlockMeta.fromHashAndTime(data, height);
  }

  /**
   * Get wallet tip.
   * @returns {Promise<BlockMeta>}
   */

  async getTip() {
    const tip = await this.getBlock(this.state.height);

    if (!tip)
      throw new Error('WDB: Tip not found!');

    return tip;
  }

  /**
   * Get renewal block hash.
   * @returns {Promise<Buffer>}
   */

  async getRenewalBlock() {
    let height = this.height - this.network.names.renewalMaturity * 2;

    if (height < 0)
      height = 0;

    const block = await this.getBlock(height);
    assert(block);

    return block.hash;
  }

  /**
   * Get block time.
   * @param {Number} height
   * @returns {Promise<Number?>}
   */

  async getBlockTime(height) {
    assert(typeof height === 'number');

    if (height < 0)
      return null;

    const cache = this.timeCache.get(height);

    if (cache != null)
      return cache;

    const block = await this.getBlock(height);

    if (!block)
      return null;

    this.timeCache.set(height, block.time);

    return block.time;
  }

  /**
   * Calculate median time past.
   * @param {Number} height
   * @param {Number} [time]
   * @returns {Promise<Number>}
   */

  async getMedianTime(height, time) {
    assert(typeof height === 'number');
    let timespan = consensus.MEDIAN_TIMESPAN;
    const median = [];

    if (time) {
      median.push(time);
      timespan--;
    }

    time = await this.getBlockTime(height);

    for (let i = 0; i < timespan && time; i++) {
      median.push(time);

      time = await this.getBlockTime(height - i - 1);
    }

    median.sort(cmp);

    return median[median.length >>> 1];
  }

  /**
   * Sync with chain height.
   * @param {Number} height
   * @returns {Promise}
   */

  async rollback(height) {
    if (height > this.state.height)
      throw new Error('WDB: Cannot rollback to the future.');

    if (height === this.state.height) {
      this.logger.info('Rolled back to same height (%d).', height);
      return;
    }

    this.logger.info(
      'Rolling back %d WalletDB blocks to height %d.',
      this.state.height - height, height);

    const tip = await this.getBlock(height);
    assert(tip);

    await this.revert(tip.height);
    await this.setTip(tip, false);
  }

  /**
   * Revert TXDB to an older state.
   * @param {Number} target
   * @returns {Promise<Number>}
   */

  async revert(target) {
    const iter = this.db.iterator({
      gte: layout.b.encode(target + 1),
      lte: layout.b.max(),
      reverse: true,
      values: true
    });

    let total = 0;

    await iter.each(async (key, value) => {
      this.timeCache.start();
      const [height] = layout.b.decode(key);
      const block = MapRecord.decode(value);
      this.logger.info('Reverting block: %d', height);

      for (const wid of block.wids) {
        const wallet = await this.get(wid);
        assert(wallet);
        total += await wallet.revert(height);
      }
      this.timeCache.unpush(height);
      this.timeCache.commit();
    });

    this.logger.info('Rolled back %d WalletDB transactions.', total);
    return total;
  }

  /**
   * Add a block's transactions and write the new best hash.
   * @param {ChainEntry} entry
   * @param {TX[]} txs
   * @returns {Promise<AddBlockResult?>}
   */

  async addBlock(entry, txs) {
    const unlock = await this.txLock.lock();

    this.timeCache.start();

    try {
      const result = await this._addBlock(entry, txs);
      this.timeCache.commit();
      return result;
    } catch (e) {
      this.timeCache.drop();
      throw e;
    } finally {
      unlock();
    }
  }

  /**
   * Add a block's transactions without a lock.
   * @private
   * @param {ChainEntry} entry
   * @param {TX[]} txs
   * @returns {Promise<AddBlockResult?>}
   */

  async _addBlock(entry, txs) {
    const tip = BlockMeta.fromEntry(entry);

    if (tip.height < this.state.height) {
      this.logger.warning(
        'WalletDB is connecting low blocks (%d).',
        tip.height);

      const block = await this.getBlock(tip.height);
      assert(block);

      if (!entry.hash.equals(block.hash)) {
        // Maybe we run syncChain here.
        this.logger.warning(
          'Unusual reorg at low height (%d).',
          tip.height);
      }

      return null;
    }

    if (tip.height >= this.network.block.slowHeight)
      this.logger.debug('Adding block: %d.', tip.height);

    if (tip.height === this.state.height) {
      // We let blocks of the same height
      // through specifically for rescans:
      // we always want to rescan the last
      // block since the state may have
      // updated before the block was fully
      // processed (in the case of a crash).
      this.logger.warning('Already saw WalletDB block (%d).', tip.height);

      const block = await this.getBlock(tip.height);
      assert(block);

      if (!entry.hash.equals(block.hash)) {
        this.logger.warning(
          'Unusual reorg at the same height (%d).',
          tip.height);

        // Maybe we can run syncChain here.
        return null;
      }
    } else if (tip.height !== this.state.height + 1) {
      await this._rescan(this.state.height);
      return null;
    }

    let block;

    if (tip.height > 2) {
      block = await this.getBlock(tip.height - 1);
      assert(block);
    }

    if (block && !block.hash.equals(entry.prevBlock)) {
      // We can trigger syncChain here as well.
      this.logger.warning(
        'Unusual reorg at height (%d).',
        tip.height);

      return null;
    }

    this.timeCache.push(tip.height, tip.time);

    const walletTXs = [];
    let filterUpdated = false;

    try {
      // We set the state as confirming so that
      // anything that uses the current height can
      // increment by one until the block is fully
      // added and the height is updated.
      this.confirming = true;

      const mtp = await this.getMedianTime(tip.height - 1, tip.time);

      for (const tx of txs) {
        /** @type {BlockExtraInfo} */
        const extra = {
          medianTime: mtp,
          // txIndex will be recalculated in txdb. It will be local index
          // to the wallet instead of the whole walletdb index.
          // @see TXDB#add.
          txIndex: 0
        };

        const txadded = await this._addTX(tx, tip, extra);

        if (txadded) {
          walletTXs.push(tx);

          if (txadded.filterUpdated)
            filterUpdated = true;
        }
      }

      // Sync the state to the new tip.
      // If we encountered wallet txs, we also trigger mark check.
      await this.setTip(tip, walletTXs.length > 0);
    } finally {
      this.confirming = false;
    }

    if (walletTXs.length > 0) {
      this.logger.info('Connected WalletDB block %x (tx=%d).',
        tip.hash, walletTXs.length);
    }

    this.emit('block connect', entry, walletTXs);

    return {
      txs: walletTXs.length,
      filterUpdated: filterUpdated
    };
  }

  /**
   * Unconfirm a block's transactions
   * and write the new best hash (SPV version).
   * @param {ChainEntry} entry
   * @returns {Promise<Number>} - number of txs removed.
   */

  async removeBlock(entry) {
    const unlock = await this.txLock.lock();
    try {
      this.timeCache.start();
      const result = await this._removeBlock(entry);
      this.timeCache.commit();
      return result;
    } catch (e) {
      this.timeCache.drop();
      throw e;
    } finally {
      unlock();
    }
  }

  /**
   * Unconfirm a block's transactions.
   * @private
   * @param {ChainEntry} entry
   * @returns {Promise<Number>} - number of txs removed.
   */

  async _removeBlock(entry) {
    const tip = BlockMeta.fromEntry(entry);

    if (tip.height === 0)
      throw new Error('WDB: Bad disconnection (genesis block).');

    if (tip.height > this.state.height) {
      this.logger.warning(
        'WalletDB is disconnecting high blocks (%d).',
        tip.height);
      return 0;
    }

    if (tip.height !== this.state.height)
      throw new Error('WDB: Bad disconnection (height mismatch).');

    const prev = await this.getBlock(tip.height - 1);
    assert(prev);

    this.timeCache.unpush(tip.height);

    // Get the map of block->wids.
    const map = await this.getBlockMap(tip.height);

    if (!map) {
      await this.setTip(prev, false);
      this.emit('block disconnect', entry);
      return 0;
    }

    let total = 0;

    for (const wid of map.wids) {
      const wallet = await this.get(wid);
      assert(wallet);
      total += await wallet.revert(tip.height);
    }

    // Sync the state to the previous tip.
    await this.setTip(prev, false);

    this.logger.warning('Disconnected wallet block %x (tx=%d).',
      tip.hash, total);

    this.emit('block disconnect', entry);

    return total;
  }

  /**
   * Rescan a block.
   * @private
   * @param {ChainEntry} entry
   * @param {TX[]} txs
   * @returns {Promise}
   */

  async rescanBlock(entry, txs) {
    if (!this.rescanning) {
      this.logger.warning('Unsolicited rescan block: %d.', entry.height);
      return;
    }

    if (entry.height > this.state.height + 1) {
      this.logger.warning('Rescan block too high: %d.', entry.height);
      return;
    }

    this.timeCache.start();

    try {
      await this._addBlock(entry, txs);
      this.timeCache.commit();
    } catch (e) {
      this.timeCache.drop();
      this.emit('error', e);
      throw e;
    }
  }

  /**
   * Rescan a block interactively.
   * @param {ChainEntry} entry
   * @param {TX[]} txs
   * @returns {Promise<ScanAction>} - interactive action
   */

  async rescanBlockInteractive(entry, txs) {
    if (!this.rescanning)
      throw new Error(`WDB: Unsolicited rescan block: ${entry.height}.`);

    if (entry.height > this.state.height + 1)
      throw new Error(`WDB: Rescan block too high: ${entry.height}.`);

    const blockAdded = await this._addBlock(entry, txs);

    if (!blockAdded)
      throw new Error('WDB: Block not added.');

    if (blockAdded.filterUpdated) {
      // We remove block, because adding the same block twice, will ignore
      // already indexed transactions. This handles the case where single
      // transaction has undiscovered outputs.
      await this._removeBlock(entry);

      return {
        type: scanActions.REPEAT
      };
    }

    return {
      type: scanActions.NEXT
    };
  }

  /**
   * Add a transaction to the database, map addresses
   * to wallet IDs, potentially store orphans, resolve
   * orphans, or confirm a transaction.
   * @param {TX} tx
   * @returns {Promise<AddTXResult?>}
   */

  async addTX(tx) {
    const unlock = await this.txLock.lock();
    try {
      return await this._addTX(tx);
    } finally {
      unlock();
    }
  }

  /**
   * Add a transaction to the database without a lock.
   * @private
   * @param {TX} tx
   * @param {BlockMeta} [block]
   * @param {BlockExtraInfo} [extra]
   * @returns {Promise<AddTXResult?>}
   */

  async _addTX(tx, block, extra) {
    const wids = await this.getWalletsByTX(tx);

    assert(!tx.mutable, 'WDB: Cannot add mutable TX.');

    if (!wids)
      return null;

    this.logger.info(
      'Incoming transaction for %d wallets in WalletDB (%s).',
      wids.size, tx.txid());

    let result = false;
    let filterUpdated = false;

    // Insert the transaction
    // into every matching wallet.
    for (const wid of wids) {
      const wallet = await this.get(wid);

      assert(wallet);

      const wadded = await wallet.add(tx, block, extra);

      if (wadded) {
        result = true;

        if (wadded.derived.length > 0)
          filterUpdated = true;

        this.logger.info(
          'Added transaction to wallet in WalletDB: %s (%d).',
          wallet.id, wid);
      }
    }

    if (!result)
      return null;

    return {
      wids,
      filterUpdated
    };
  }

  /**
   * Handle a chain reset.
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async resetChain(entry) {
    const unlock = await this.txLock.lock();
    try {
      return await this._resetChain(entry);
    } finally {
      unlock();
    }
  }

  /**
   * Handle a chain reset without a lock.
   * @private
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async _resetChain(entry) {
    if (entry.height > this.state.height)
      throw new Error('WDB: Bad reset height.');

    return this.rollback(entry.height);
  }
}

/**
 * Wallet Options
 * @alias module:wallet.WalletOptions
 */

class WalletOptions {
  /**
   * Create wallet options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;
    this.workers = null;
    this.client = null;
    this.feeRate = 0;

    this.prefix = null;
    this.location = null;
    this.memory = true;
    this.maxFiles = 64;
    this.cacheSize = 16 << 20;
    this.compression = true;

    this.spv = false;
    this.wipeNoReally = false;
    this.walletMigrate = -1;
    this.icannlockup = true;
    this.migrateNoRescan = false;
    this.preloadAll = false;
    this.maxHistoryTXs = 100;

    this.nowFn = util.now;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {WalletOptions}
   */

  fromOptions(options) {
    if (options.network != null)
      this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.workers != null) {
      assert(typeof options.workers === 'object');
      this.workers = options.workers;
    }

    if (options.client != null) {
      assert(typeof options.client === 'object');
      this.client = options.client;
    }

    if (options.feeRate != null) {
      assert((options.feeRate >>> 0) === options.feeRate);
      this.feeRate = options.feeRate;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.location = path.join(this.prefix, 'wallet');
    }

    if (options.location != null) {
      assert(typeof options.location === 'string');
      this.location = options.location;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean');
      this.memory = options.memory;
    }

    if (options.maxFiles != null) {
      assert((options.maxFiles >>> 0) === options.maxFiles);
      this.maxFiles = options.maxFiles;
    }

    if (options.cacheSize != null) {
      assert(Number.isSafeInteger(options.cacheSize) && options.cacheSize >= 0);
      this.cacheSize = options.cacheSize;
    }

    if (options.compression != null) {
      assert(typeof options.compression === 'boolean');
      this.compression = options.compression;
    }

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.wipeNoReally != null) {
      assert(typeof options.wipeNoReally === 'boolean');
      this.wipeNoReally = options.wipeNoReally;
    }

    if (options.walletMigrate != null) {
      assert(typeof options.walletMigrate === 'number');
      this.walletMigrate = options.walletMigrate;
    }

    if (options.icannlockup != null) {
      assert(typeof options.icannlockup === 'boolean');
      this.icannlockup = options.icannlockup;
    }

    if (options.migrateNoRescan != null) {
      assert(typeof options.migrateNoRescan === 'boolean');
      this.migrateNoRescan = options.migrateNoRescan;
    }

    if (options.preloadAll != null) {
      assert(typeof options.preloadAll === 'boolean');
      this.preloadAll = options.preloadAll;
    }

    if (options.nowFn != null) {
      assert(typeof options.nowFn === 'function');
      this.nowFn = options.nowFn;
    }

    if (options.maxHistoryTXs != null) {
      assert((options.maxHistoryTXs >>> 0) === options.maxHistoryTXs);
      assert(options.maxHistoryTXs > 0);
      this.maxHistoryTXs = options.maxHistoryTXs;
    }

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {WalletOptions}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
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

/**
 * @param {String} str
 * @returns {Buffer}
 */

function fromString(str) {
  const buf = Buffer.alloc(1 + str.length);
  buf[0] = str.length;
  buf.write(str, 1, str.length, 'ascii');
  return buf;
}

/**
 * @param {Buffer} buf
 * @returns {String}
 */

function toString(buf) {
  assert(buf.length > 0);
  assert(buf[0] === buf.length - 1);
  return buf.toString('ascii', 1, buf.length);
}

function cmp(a, b) {
  return a - b;
}

/*
 * Expose
 */

module.exports = WalletDB;
