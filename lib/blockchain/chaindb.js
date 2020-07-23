/*!
 * chaindb.js - blockchain data management for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bdb = require('bdb');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const LRU = require('blru');
const {Tree} = require('urkel/radix');
const {BufferMap, BufferSet} = require('buffer-map');
const Amount = require('../ui/amount');
const Network = require('../protocol/network');
const CoinView = require('../coins/coinview');
const UndoCoins = require('../coins/undocoins');
const layout = require('./layout');
const consensus = require('../protocol/consensus');
const Block = require('../primitives/block');
const Outpoint = require('../primitives/outpoint');
const Address = require('../primitives/address');
const ChainEntry = require('./chainentry');
const TXMeta = require('../primitives/txmeta');
const CoinEntry = require('../coins/coinentry');
const rules = require('../covenants/rules');
const NameState = require('../covenants/namestate');
const NameUndo = require('../covenants/undo');
const {BitField} = require('../covenants/bitfield');
const {types} = rules;

/**
 * ChainDB
 * @alias module:blockchain.ChainDB
 */

class ChainDB {
  /**
   * Create a chaindb.
   * @constructor
   */

  constructor(options) {
    this.options = options;
    this.network = this.options.network;
    this.logger = this.options.logger.context('chaindb');

    this.db = bdb.create(this.options);
    this.tree = new Tree(blake2b, 256, this.options.treePrefix);
    this.txn = this.tree.txn();
    this.stateCache = new StateCache(this.network);
    this.state = new ChainState();
    this.field = new BitField();
    this.pending = null;
    this.current = null;

    this.cacheHash = new LRU(this.options.entryCache, null, BufferMap);
    this.cacheHeight = new LRU(this.options.entryCache);
  }

  /**
   * Open and wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    this.logger.info('Opening ChainDB...');

    await this.db.open();
    await this.db.verify(layout.V.encode(), 'chain', 1);
    await this.tree.open();

    const state = await this.getState();

    if (state) {
      // Verify options have not changed.
      await this.verifyFlags(state);

      // Verify deployment params have not changed.
      await this.verifyDeployments();

      // Load state caches.
      this.stateCache = await this.getStateCache();

      // Grab the chainstate if we have one.
      this.state = state;

      // Grab the current tree state.
      if (!this.options.spv) {
        const root = await this.db.get(layout.s.encode());
        assert(root && root.length === 32);

        await this.tree.inject(root);
      }

      // Read bitfield.
      this.field = await this.getField();

      // Run chain state migration.
      await this.migrateChainState();

      this.logger.info('ChainDB successfully loaded.');
    } else {
      // Database is fresh.
      // Write initial state.
      await this.saveFlags();
      await this.saveDeployments();
      await this.saveMigration(0);
      await this.saveGenesis();

      this.logger.info('ChainDB successfully initialized.');
    }

    this.txn = this.tree.txn();

    this.logger.info(
      'Chain State: hash=%x tx=%d coin=%d value=%s burned=%s.',
      this.state.tip,
      this.state.tx,
      this.state.coin,
      Amount.coin(this.state.value),
      Amount.coin(this.state.burned));

    this.logger.info('Tree Root: %x.', this.tree.rootHash());
  }

  /**
   * Migrate chain state and correct total supply.
   * @returns {Promise}
   */

  async migrateChainState() {
    if (await this.db.has(layout.M.encode(0)))
      return;

    this.logger.info('Migrating chain state.');

    const tipHeight = await this.getHeight(this.state.tip);
    const pending = this.state.clone();
    const view = new CoinView();

    pending.coin = 0;
    pending.value = 0;
    pending.burned = 0;

    for (let height = 0; height <= tipHeight; height++) {
      const block = await this.getBlock(await this.getHash(height));
      assert(block);

      for (let i = 0; i < block.txs.length; i++) {
        const tx = block.txs[i];

        if (i > 0) {
          for (const {prevout} of tx.inputs) {
            const {hash} = prevout;
            const output = view.getOutput(prevout);
            assert(output);

            assert(view.removeEntry(prevout));

            if (view.get(hash).outputs.size === 0)
              assert(view.remove(hash));

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

          pending.add(output);
        }

        view.addTX(tx, height);
      }
    }

    const batch = this.db.batch();

    batch.put(layout.M.encode(0), null);
    batch.put(layout.R.encode(), pending.encode());

    await batch.write();

    this.state.inject(pending);
  }

  /**
   * Save migration key.
   * @param {Number} id
   * @returns {Promise}
   */

  async saveMigration(id) {
    return this.db.put(layout.M.encode(id), null);
  }

  /**
   * Close and wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    await this.tree.close();
    this.txn = this.tree.txn();
    return this.db.close();
  }

  /**
   * Start a batch.
   * @returns {Batch}
   */

  start() {
    assert(!this.current);
    assert(!this.pending);

    this.current = this.db.batch();
    this.pending = this.state.clone();

    this.cacheHash.start();
    this.cacheHeight.start();

    return this.current;
  }

  /**
   * Put key and value to current batch.
   * @param {String} key
   * @param {Buffer} value
   */

  put(key, value) {
    assert(this.current);
    this.current.put(key, value);
  }

  /**
   * Delete key from current batch.
   * @param {String} key
   */

  del(key) {
    assert(this.current);
    this.current.del(key);
  }

  /**
   * Get current batch.
   * @returns {Batch}
   */

  batch() {
    assert(this.current);
    return this.current;
  }

  /**
   * Drop current batch.
   * @returns {Batch}
   */

  drop() {
    const batch = this.current;

    assert(this.current);
    assert(this.pending);

    this.current = null;
    this.pending = null;

    this.cacheHash.drop();
    this.cacheHeight.drop();
    this.stateCache.drop();

    batch.clear();
  }

  /**
   * Commit current batch.
   * @returns {Promise}
   */

  async commit() {
    assert(this.current);
    assert(this.pending);

    try {
      await this.current.write();
    } catch (e) {
      this.current = null;
      this.pending = null;
      this.cacheHash.drop();
      this.cacheHeight.drop();
      throw e;
    }

    // Overwrite the entire state
    // with our new best state
    // only if it is committed.
    // Note that alternate chain
    // tips do not commit anything.
    if (this.pending.committed)
      this.state = this.pending;

    this.current = null;
    this.pending = null;

    this.cacheHash.commit();
    this.cacheHeight.commit();
    this.stateCache.commit();
  }

  /**
   * Test the cache for a present entry hash or height.
   * @param {Hash|Number} block - Hash or height.
   */

  hasCache(block) {
    if (typeof block === 'number')
      return this.cacheHeight.has(block);

    assert(Buffer.isBuffer(block));

    return this.cacheHash.has(block);
  }

  /**
   * Get an entry directly from the LRU cache.
   * @param {Hash|Number} block - Hash or height.
   */

  getCache(block) {
    if (typeof block === 'number')
      return this.cacheHeight.get(block);

    assert(Buffer.isBuffer(block));

    return this.cacheHash.get(block);
  }

  /**
   * Get the height of a block by hash.
   * @param {Hash} hash
   * @returns {Promise} - Returns Number.
   */

  async getHeight(hash) {
    if (typeof hash === 'number')
      return hash;

    assert(Buffer.isBuffer(hash));

    if (hash.equals(consensus.ZERO_HASH))
      return -1;

    const entry = this.cacheHash.get(hash);

    if (entry)
      return entry.height;

    const height = await this.db.get(layout.h.encode(hash));

    if (!height)
      return -1;

    return height.readUInt32LE(0, true);
  }

  /**
   * Get the hash of a block by height. Note that this
   * will only return hashes in the main chain.
   * @param {Number} height
   * @returns {Promise} - Returns {@link Hash}.
   */

  async getHash(height) {
    if (Buffer.isBuffer(height))
      return height;

    assert(typeof height === 'number');

    if (height < 0)
      return null;

    const entry = this.cacheHeight.get(height);

    if (entry)
      return entry.hash;

    return this.db.get(layout.H.encode(height));
  }

  /**
   * Retrieve a chain entry by height.
   * @param {Number} height
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  async getEntryByHeight(height) {
    assert(typeof height === 'number');

    if (height < 0)
      return null;

    const cache = this.cacheHeight.get(height);

    if (cache)
      return cache;

    const hash = await this.db.get(layout.H.encode(height));

    if (!hash)
      return null;

    const state = this.state;
    const entry = await this.getEntryByHash(hash);

    if (!entry)
      return null;

    // By the time getEntry has completed,
    // a reorg may have occurred. This entry
    // may not be on the main chain anymore.
    if (this.state === state)
      this.cacheHeight.set(entry.height, entry);

    return entry;
  }

  /**
   * Retrieve a chain entry by hash.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  async getEntryByHash(hash) {
    assert(Buffer.isBuffer(hash));

    if (hash.equals(consensus.ZERO_HASH))
      return null;

    const cache = this.cacheHash.get(hash);

    if (cache)
      return cache;

    const raw = await this.db.get(layout.e.encode(hash));

    if (!raw)
      return null;

    const entry = ChainEntry.decode(raw);

    // There's no efficient way to check whether
    // this is in the main chain or not, so
    // don't add it to the height cache.
    this.cacheHash.set(entry.hash, entry);

    return entry;
  }

  /**
   * Retrieve a chain entry.
   * @param {Number|Hash} block - Height or hash.
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getEntry(block) {
    if (typeof block === 'number')
      return this.getEntryByHeight(block);
    return this.getEntryByHash(block);
  }

  /**
   * Test whether the chain contains a block.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async hasEntry(hash) {
    const height = await this.getHeight(hash);
    return height !== -1;
  }

  /**
   * Get ancestor by `height`.
   * @param {ChainEntry} entry
   * @param {Number} height
   * @returns {Promise} - Returns ChainEntry.
   */

  async getAncestor(entry, height) {
    if (height < 0)
      return null;

    assert(height >= 0);
    assert(height <= entry.height);

    if (await this.isMainChain(entry))
      return this.getEntryByHeight(height);

    while (entry.height !== height) {
      const cache = this.getPrevCache(entry);

      if (cache)
        entry = cache;
      else
        entry = await this.getPrevious(entry);

      assert(entry);
    }

    return entry;
  }

  /**
   * Get previous entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  getPrevious(entry) {
    return this.getEntryByHash(entry.prevBlock);
  }

  /**
   * Get previous cached entry.
   * @param {ChainEntry} entry
   * @returns {ChainEntry|null}
   */

  getPrevCache(entry) {
    return this.cacheHash.get(entry.prevBlock) || null;
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  async getNext(entry) {
    const hash = await this.getNextHash(entry.hash);

    if (!hash)
      return null;

    return this.getEntryByHash(hash);
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns ChainEntry.
   */

  async getNextEntry(entry) {
    const next = await this.getEntryByHeight(entry.height + 1);

    if (!next)
      return null;

    // Not on main chain.
    if (!next.prevBlock.equals(entry.hash))
      return null;

    return next;
  }

  /**
   * Lookup a name tree value.
   * @param {Hash} root
   * @param {Hash} key
   * @returns {Buffer}
   */

  async lookup(root, key) {
    if (this.options.spv)
      throw new Error('Cannot lookup in SPV mode.');

    const tree = this.tree.snapshot(root);
    return tree.get(key);
  }

  /**
   * Create a name tree proof.
   * @param {Hash} root
   * @param {Hash} key
   * @returns {Buffer[]} nodes
   */

  async prove(root, key) {
    if (this.options.spv)
      throw new Error('Cannot prove in SPV mode.');

    const tree = this.tree.snapshot(root);
    return tree.prove(key);
  }

  /**
   * Get the current name tree root.
   * @returns {Hash}
   */

  treeRoot() {
    return this.tree.rootHash();
  }

  /**
   * Retrieve the tip entry from the tip record.
   * @returns {Promise} - Returns {@link ChainEntry}.
   */

  getTip() {
    return this.getEntryByHash(this.state.tip);
  }

  /**
   * Retrieve the tip entry from the tip record.
   * @returns {Promise} - Returns {@link ChainState}.
   */

  async getState() {
    const data = await this.db.get(layout.R.encode());

    if (!data)
      return null;

    return ChainState.decode(data);
  }

  /**
   * Write genesis block to database.
   * @returns {Promise}
   */

  async saveGenesis() {
    const network = this.network;
    const block = Block.decode(network.genesisBlock);
    const entry = ChainEntry.fromBlock(block);
    const view = new CoinView();

    this.logger.info('Writing genesis block to ChainDB.');

    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      if (i > 0)
        assert(await view.spendInputs(this, tx));

      view.addTX(tx, 0);
    }

    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];
      assert(tx.isSane());
      assert(tx.verifyInputs(view, network.coinbaseMaturity, network));
    }

    return this.save(entry, block, view);
  }

  /**
   * Retrieve the database flags.
   * @returns {Promise} - Returns {@link ChainFlags}.
   */

  async getFlags() {
    const data = await this.db.get(layout.O.encode());

    if (!data)
      return null;

    return ChainFlags.decode(data);
  }

  /**
   * Verify current options against db options.
   * @param {ChainState} state
   * @returns {Promise}
   */

  async verifyFlags(state) {
    const options = this.options;
    const flags = await this.getFlags();

    let needsPrune = false;

    if (!flags)
      throw new Error('No flags found.');

    if (options.network !== flags.network)
      throw new Error('Network mismatch for chain.');

    if (options.spv && !flags.spv)
      throw new Error('Cannot retroactively enable SPV.');

    if (!options.spv && flags.spv)
      throw new Error('Cannot retroactively disable SPV.');

    if (options.prune && !flags.prune) {
      if (!options.forceFlags)
        throw new Error('Cannot retroactively prune.');
      needsPrune = true;
    }

    if (!options.prune && flags.prune)
      throw new Error('Cannot retroactively unprune.');

    if (options.indexTX && !flags.indexTX)
      throw new Error('Cannot retroactively enable TX indexing.');

    if (!options.indexTX && flags.indexTX)
      throw new Error('Cannot retroactively disable TX indexing.');

    if (options.indexAddress && !flags.indexAddress)
      throw new Error('Cannot retroactively enable address indexing.');

    if (!options.indexAddress && flags.indexAddress)
      throw new Error('Cannot retroactively disable address indexing.');

    if (needsPrune) {
      await this.logger.info('Retroactively pruning chain.');
      await this.prune(state.tip);
    }
  }

  /**
   * Get state caches.
   * @returns {Promise} - Returns {@link StateCache}.
   */

  async getStateCache() {
    const stateCache = new StateCache(this.network);

    const items = await this.db.range({
      gte: layout.v.min(),
      lte: layout.v.max(),
      values: true
    });

    for (const item of items) {
      const [bit, hash] = layout.v.decode(item.key);
      const state = item.value[0];
      stateCache.insert(bit, hash, state);
    }

    return stateCache;
  }

  /**
   * Save deployment table.
   * @returns {Promise}
   */

  saveDeployments() {
    const b = this.db.batch();
    this.writeDeployments(b);
    return b.write();
  }

  /**
   * Save deployment table.
   * @returns {Promise}
   */

  writeDeployments(b) {
    const bw = bio.write(1 + 17 * this.network.deploys.length);

    bw.writeU8(this.network.deploys.length);

    for (const deployment of this.network.deploys) {
      bw.writeU8(deployment.bit);
      bw.writeU32(deployment.startTime);
      bw.writeU32(deployment.timeout);
      bw.writeI32(deployment.threshold);
      bw.writeI32(deployment.window);
    }

    b.put(layout.D.encode(), bw.render());
  }

  /**
   * Check for outdated deployments.
   * @private
   * @returns {Promise}
   */

  async checkDeployments() {
    const raw = await this.db.get(layout.D.encode());

    assert(raw, 'No deployment table found.');

    const br = bio.read(raw);
    const count = br.readU8();
    const invalid = [];

    for (let i = 0; i < count; i++) {
      const bit = br.readU8();
      const start = br.readU32();
      const timeout = br.readU32();
      const threshold = br.readI32();
      const window = br.readI32();
      const deployment = this.network.byBit(bit);

      if (deployment
          && start === deployment.startTime
          && timeout === deployment.timeout
          && threshold === deployment.threshold
          && window === deployment.window) {
        continue;
      }

      invalid.push(bit);
    }

    return invalid;
  }

  /**
   * Potentially invalidate state cache.
   * @returns {Promise}
   */

  async verifyDeployments() {
    let invalid;

    try {
      invalid = await this.checkDeployments();
    } catch (e) {
      if (e.type !== 'EncodingError')
        throw e;
      invalid = [];
      for (let i = 0; i < 32; i++)
        invalid.push(i);
    }

    if (invalid.length === 0)
      return true;

    const b = this.db.batch();

    for (const bit of invalid) {
      this.logger.warning('Versionbit deployment params modified.');
      this.logger.warning('Invalidating cache for bit %d.', bit);
      await this.invalidateCache(bit, b);
    }

    this.writeDeployments(b);

    await b.write();

    return false;
  }

  /**
   * Invalidate state cache.
   * @private
   * @returns {Promise}
   */

  async invalidateCache(bit, b) {
    const keys = await this.db.keys({
      gte: layout.v.min(bit),
      lte: layout.v.max(bit)
    });

    for (const key of keys)
      b.del(key);
  }

  /**
   * Retroactively prune the database.
   * @returns {Promise}
   */

  async prune() {
    const options = this.options;
    const keepBlocks = this.network.block.keepBlocks;
    const pruneAfter = this.network.block.pruneAfterHeight;

    const flags = await this.getFlags();

    if (flags.prune)
      throw new Error('Chain is already pruned.');

    const height = await this.getHeight(this.state.tip);

    if (height <= pruneAfter + keepBlocks)
      return false;

    const start = pruneAfter + 1;
    const end = height - keepBlocks;
    const b = this.db.batch();

    for (let i = start; i <= end; i++) {
      const hash = await this.getHash(i);

      if (!hash)
        throw new Error(`Cannot find hash for ${i}.`);

      b.del(layout.b.encode(hash));
      b.del(layout.u.encode(hash));
    }

    try {
      options.prune = true;

      const flags = ChainFlags.fromOptions(options);
      assert(flags.prune);

      b.put(layout.O.encode(), flags.encode());

      await b.write();
    } catch (e) {
      options.prune = false;
      throw e;
    }

    await this.db.compactRange();

    return true;
  }

  /**
   * Get the _next_ block hash (does not work by height).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Hash}.
   */

  async getNextHash(hash) {
    return this.db.get(layout.n.encode(hash));
  }

  /**
   * Check to see if a block is on the main chain.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async isMainHash(hash) {
    assert(Buffer.isBuffer(hash));

    if (hash.equals(consensus.ZERO_HASH))
      return false;

    if (hash.equals(this.network.genesis.hash))
      return true;

    if (hash.equals(this.state.tip))
      return true;

    const cacheHash = this.cacheHash.get(hash);

    if (cacheHash) {
      const cacheHeight = this.cacheHeight.get(cacheHash.height);
      if (cacheHeight)
        return cacheHeight.hash.equals(hash);
    }

    if (await this.getNextHash(hash))
      return true;

    return false;
  }

  /**
   * Test whether the entry is in the main chain.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns Boolean.
   */

  async isMainChain(entry) {
    if (entry.isGenesis())
      return true;

    if (entry.hash.equals(this.state.tip))
      return true;

    const cache = this.getCache(entry.height);

    if (cache)
      return entry.hash.equals(cache.hash);

    if (await this.getNextHash(entry.hash))
      return true;

    return false;
  }

  /**
   * Get hash range.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise}
   */

  async getHashes(start = -1, end = -1) {
    if (start === -1)
      start = 0;

    if (end === -1)
      end >>>= 0;

    assert((start >>> 0) === start);
    assert((end >>> 0) === end);

    return this.db.values({
      gte: layout.H.min(start),
      lte: layout.H.max(end)
    });
  }

  /**
   * Get all entries.
   * @returns {Promise} - Returns {@link ChainEntry}[].
   */

  async getEntries() {
    return this.db.values({
      gte: layout.e.min(),
      lte: layout.e.max(),
      parse: data => ChainEntry.decode(data)
    });
  }

  /**
   * Get all tip hashes.
   * @returns {Promise} - Returns {@link Hash}[].
   */

  async getTips() {
    return this.db.keys({
      gte: layout.p.min(),
      lte: layout.p.max(),
      parse: key => layout.p.decode(key)[0]
    });
  }

  /**
   * Get bitfield.
   * @returns {Buffer}
   */

  async getField() {
    const raw = await this.db.get(layout.f.encode());

    if (!raw)
      return new BitField();

    return BitField.decode(raw);
  }

  /**
   * Get a coin (unspents only).
   * @private
   * @param {Outpoint} prevout
   * @returns {Promise} - Returns {@link CoinEntry}.
   */

  async readCoin(prevout) {
    if (this.options.spv)
      return null;

    const {hash, index} = prevout;

    const raw = await this.db.get(layout.c.encode(hash, index));

    if (!raw)
      return null;

    return CoinEntry.decode(raw);
  }

  /**
   * Get a coin (unspents only).
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {@link Coin}.
   */

  async getCoin(hash, index) {
    const prevout = new Outpoint(hash, index);
    const coin = await this.readCoin(prevout);

    if (!coin)
      return null;

    return coin.toCoin(prevout);
  }

  /**
   * Check whether coins are still unspent. Necessary for bip30.
   * @see https://bitcointalk.org/index.php?topic=67738.0
   * @param {TX} tx
   * @returns {Promise} - Returns Boolean.
   */

  async hasCoins(tx) {
    for (let i = 0; i < tx.outputs.length; i++) {
      const key = layout.c.encode(tx.hash(), i);
      if (await this.db.has(key))
        return true;
    }
    return false;
  }

  /**
   * Get coin viewpoint.
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getCoinView(tx) {
    const view = new CoinView();

    for (const {prevout} of tx.inputs) {
      const coin = await this.readCoin(prevout);

      if (coin)
        view.addEntry(prevout, coin);
    }

    return view;
  }

  /**
   * Get coin viewpoint (historical).
   * @param {TX} tx
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getSpentView(tx) {
    const view = await this.getCoinView(tx);

    for (const {prevout} of tx.inputs) {
      if (view.hasEntry(prevout))
        continue;

      const {hash, index} = prevout;
      const meta = await this.getMeta(hash);

      if (!meta)
        continue;

      const {tx, height} = meta;

      if (index < tx.outputs.length)
        view.addIndex(tx, index, height);
    }

    return view;
  }

  /**
   * Get coins necessary to be resurrected during a reorg.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Coin}[].
   */

  async getUndoCoins(hash) {
    const data = await this.db.get(layout.u.encode(hash));

    if (!data)
      return new UndoCoins();

    return UndoCoins.decode(data);
  }

  /**
   * Get name state.
   * @param {Buffer} nameHash
   * @returns {NameState}
   */

  async getNameState(nameHash) {
    const raw = await this.txn.get(nameHash);

    if (!raw)
      return null;

    const ns = NameState.decode(raw);
    ns.nameHash = nameHash;
    return ns;
  }

  /**
   * Get name state by name.
   * @param {Buffer} name
   * @returns {NameState}
   */

  async getNameStateByName(name) {
    return this.getNameState(rules.hashName(name));
  }

  /**
   * Get name status.
   * @param {Buffer} nameHash
   * @returns {NameState}
   */

  async getNameStatus(nameHash, height, hardened) {
    if (hardened == null)
      hardened = false;

    assert(Buffer.isBuffer(nameHash));
    assert((height >>> 0) === height);
    assert(typeof hardened === 'boolean');

    const network = this.network;
    const ns = await this.getNameState(nameHash);

    if (!ns) {
      const state = new NameState();
      state.reset(height);
      return state;
    }

    ns.maybeExpire(height, network);

    return ns;
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  async getBlock(hash) {
    const data = await this.getRawBlock(hash);

    if (!data)
      return null;

    return Block.decode(data);
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  async getRawBlock(block) {
    if (this.options.spv)
      return null;

    const hash = await this.getHash(block);

    if (!hash)
      return null;

    return this.db.get(layout.b.encode(hash));
  }

  /**
   * Get a historical block coin viewpoint.
   * @param {Block} hash
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getBlockView(block) {
    const view = new CoinView();
    const undo = await this.getUndoCoins(block.hash());

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

  /**
   * Get a transaction with metadata.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TXMeta}.
   */

  async getMeta(hash) {
    if (!this.options.indexTX)
      return null;

    const data = await this.db.get(layout.t.encode(hash));

    if (!data)
      return null;

    return TXMeta.decode(data);
  }

  /**
   * Retrieve a transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TX}.
   */

  async getTX(hash) {
    const meta = await this.getMeta(hash);

    if (!meta)
      return null;

    return meta.tx;
  }

  /**
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async hasTX(hash) {
    if (!this.options.indexTX)
      return false;

    return this.db.has(layout.t.encode(hash));
  }

  /**
   * Get all coins pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link Coin}[].
   */

  async getCoinsByAddress(addrs) {
    if (!this.options.indexAddress)
      return [];

    if (!Array.isArray(addrs))
      addrs = [addrs];

    const coins = [];

    for (let addr of addrs) {
      if (typeof addr === 'string')
        addr = Address.fromString(addr);

      const hash = Address.getHash(addr);

      const keys = await this.db.keys({
        gte: layout.C.min(hash),
        lte: layout.C.max(hash),
        parse: (key) => {
          const [, txid, index] = layout.C.decode(key);
          return [txid, index];
        }
      });

      for (const [hash, index] of keys) {
        const coin = await this.getCoin(hash, index);
        assert(coin);
        coins.push(coin);
      }
    }

    return coins;
  }

  /**
   * Get all transaction hashes to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link Hash}[].
   */

  async getHashesByAddress(addrs) {
    if (!this.options.indexTX || !this.options.indexAddress)
      return [];

    const hashes = new BufferSet();

    for (const addr of addrs) {
      const hash = Address.getHash(addr);

      await this.db.keys({
        gte: layout.T.min(hash),
        lte: layout.T.max(hash),
        parse: (key) => {
          const [, txid] = layout.T.decode(key);
          hashes.add(txid);
        }
      });
    }

    return hashes.toArray();
  }

  /**
   * Get all transactions pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getTXByAddress(addrs) {
    const mtxs = await this.getMetaByAddress(addrs);
    const out = [];

    for (const mtx of mtxs)
      out.push(mtx.tx);

    return out;
  }

  /**
   * Get all transactions pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link TXMeta}[].
   */

  async getMetaByAddress(addrs) {
    if (!this.options.indexTX || !this.options.indexAddress)
      return [];

    if (!Array.isArray(addrs))
      addrs = [addrs];

    const hashes = await this.getHashesByAddress(addrs);
    const mtxs = [];

    for (const hash of hashes) {
      const mtx = await this.getMeta(hash);
      assert(mtx);
      mtxs.push(mtx);
    }

    return mtxs;
  }

  /**
   * Scan the blockchain for transactions containing specified address hashes.
   * @param {Hash} start - Block hash to start at.
   * @param {Bloom} filter - Bloom filter containing tx and address hashes.
   * @param {Function} iter - Iterator.
   * @returns {Promise}
   */

  async scan(start, filter, iter) {
    if (start == null)
      start = this.network.genesis.hash;

    if (typeof start === 'number')
      this.logger.info('Scanning from height %d.', start);
    else
      this.logger.info('Scanning from block %x.', start);

    let entry = await this.getEntry(start);

    if (!entry)
      return;

    if (!await this.isMainChain(entry))
      throw new Error('Cannot rescan an alternate chain.');

    let total = 0;

    while (entry) {
      const block = await this.getBlock(entry.hash);

      total += 1;

      const txs = [];

      if (!block) {
        if (!this.options.spv && !this.options.prune)
          throw new Error('Block not found.');
        await iter(entry, txs);
        entry = await this.getNext(entry);
        continue;
      }

      this.logger.info(
        'Scanning block %x (%d).',
        entry.hash, entry.height);

      for (const tx of block.txs) {
        if (tx.test(filter))
          txs.push(tx);
      }

      await iter(entry, txs);

      entry = await this.getNext(entry);
    }

    this.logger.info('Finished scanning %d blocks.', total);
  }

  /**
   * Save an entry to the database and optionally
   * connect it as the tip. Note that this method
   * does _not_ perform any verification which is
   * instead performed in {@link Chain#add}.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView?} view - Will not connect if null.
   * @returns {Promise}
   */

  async save(entry, block, view) {
    this.start();
    try {
      await this._save(entry, block, view);
    } catch (e) {
      this.drop();
      throw e;
    }
    await this.commit();
  }

  /**
   * Save an entry.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView?} view
   * @returns {Promise}
   */

  async _save(entry, block, view) {
    const hash = block.hash();

    // Hash->height index.
    this.put(layout.h.encode(hash), fromU32(entry.height));

    // Entry data.
    this.put(layout.e.encode(hash), entry.encode());
    this.cacheHash.push(entry.hash, entry);

    // Tip index.
    this.del(layout.p.encode(entry.prevBlock));
    this.put(layout.p.encode(hash), null);

    // Update state caches.
    this.saveUpdates();

    if (!view) {
      // Save block data.
      await this.saveBlock(entry, block);
      return;
    }

    // Hash->next-block index.
    if (!entry.isGenesis())
      this.put(layout.n.encode(entry.prevBlock), hash);

    // Height->hash index.
    this.put(layout.H.encode(entry.height), hash);
    this.cacheHeight.push(entry.height, entry);

    // Connect block and save data.
    await this.saveBlock(entry, block, view);

    // Commit new chain state.
    this.put(layout.R.encode(), this.pending.commit(hash));
  }

  /**
   * Reconnect the block to the chain.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise}
   */

  async reconnect(entry, block, view) {
    this.start();
    try {
      await this._reconnect(entry, block, view);
    } catch (e) {
      this.drop();
      throw e;
    }
    await this.commit();
  }

  /**
   * Reconnect block.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise}
   */

  async _reconnect(entry, block, view) {
    const hash = block.hash();

    assert(!entry.isGenesis());

    // We can now add a hash->next-block index.
    this.put(layout.n.encode(entry.prevBlock), hash);

    // We can now add a height->hash index.
    this.put(layout.H.encode(entry.height), hash);
    this.cacheHeight.push(entry.height, entry);

    // Re-insert into cache.
    this.cacheHash.push(entry.hash, entry);

    // Update state caches.
    this.saveUpdates();

    // Connect inputs.
    await this.connectBlock(entry, block, view);

    // Update chain state.
    this.put(layout.R.encode(), this.pending.commit(hash));
  }

  /**
   * Disconnect block from the chain.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @returns {Promise}
   */

  async disconnect(entry, block) {
    this.start();

    let view;
    try {
      view = await this._disconnect(entry, block);
    } catch (e) {
      this.drop();
      throw e;
    }

    await this.commit();

    return view;
  }

  /**
   * Disconnect block.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async _disconnect(entry, block) {
    // Remove hash->next-block index.
    this.del(layout.n.encode(entry.prevBlock));

    // Remove height->hash index.
    this.del(layout.H.encode(entry.height));
    this.cacheHeight.unpush(entry.height);

    // Update state caches.
    this.saveUpdates();

    // Disconnect inputs.
    const view = await this.disconnectBlock(entry, block);

    // Revert chain state to previous tip.
    this.put(layout.R.encode(), this.pending.commit(entry.prevBlock));

    return view;
  }

  /**
   * Save state cache updates.
   * @private
   */

  saveUpdates() {
    const updates = this.stateCache.updates;

    if (updates.length === 0)
      return;

    this.logger.info('Saving %d state cache updates.', updates.length);

    for (const update of updates) {
      const {bit, hash} = update;
      this.put(layout.v.encode(bit, hash), update.encode());
    }
  }

  /**
   * Reset the chain to a height or hash. Useful for replaying
   * the blockchain download for SPV.
   * @param {Hash|Number} block - hash/height
   * @returns {Promise}
   */

  async reset(block) {
    const entry = await this.getEntry(block);

    if (!entry)
      throw new Error('Block not found.');

    if (!await this.isMainChain(entry))
      throw new Error('Cannot reset on alternate chain.');

    if (this.options.prune)
      throw new Error('Cannot reset when pruned.');

    // We need to remove all alternate
    // chains first. This is ugly, but
    // it's the only safe way to reset
    // the chain.
    await this.removeChains();

    let tip = await this.getTip();
    assert(tip);

    this.logger.debug('Resetting main chain to: %x', entry.hash);

    for (;;) {
      this.start();

      // Stop once we hit our target tip.
      if (tip.hash.equals(entry.hash)) {
        this.put(layout.R.encode(), this.pending.commit(tip.hash));
        await this.commit();
        break;
      }

      assert(!tip.isGenesis());

      // Revert the tip index.
      this.del(layout.p.encode(tip.hash));
      this.put(layout.p.encode(tip.prevBlock), null);

      // Remove all records (including
      // main-chain-only records).
      this.del(layout.H.encode(tip.height));
      this.del(layout.h.encode(tip.hash));
      this.del(layout.e.encode(tip.hash));
      this.del(layout.n.encode(tip.prevBlock));

      // Disconnect and remove block data.
      try {
        await this.removeBlock(tip);
      } catch (e) {
        this.drop();
        throw e;
      }

      // Revert chain state to previous tip.
      this.put(layout.R.encode(), this.pending.commit(tip.prevBlock));

      await this.commit();

      // Update caches _after_ successful commit.
      this.cacheHeight.remove(tip.height);
      this.cacheHash.remove(tip.hash);

      tip = await this.getPrevious(tip);
      assert(tip);
    }

    return tip;
  }

  /**
   * Remove all alternate chains.
   * @returns {Promise}
   */

  async removeChains() {
    const tips = await this.getTips();

    // Note that this has to be
    // one giant atomic write!
    this.start();

    try {
      for (const tip of tips)
        await this._removeChain(tip);
    } catch (e) {
      this.drop();
      throw e;
    }

    await this.commit();
  }

  /**
   * Remove an alternate chain.
   * @private
   * @param {Hash} hash - Alternate chain tip.
   * @returns {Promise}
   */

  async _removeChain(hash) {
    let tip = await this.getEntryByHash(hash);

    if (!tip)
      throw new Error('Alternate chain tip not found.');

    this.logger.debug('Removing alternate chain: %x.', tip.hash);

    for (;;) {
      if (await this.isMainChain(tip))
        break;

      assert(!tip.isGenesis());

      // Remove all non-main-chain records.
      this.del(layout.p.encode(tip.hash));
      this.del(layout.h.encode(tip.hash));
      this.del(layout.e.encode(tip.hash));
      this.del(layout.b.encode(tip.hash));

      // Queue up hash to be removed
      // on successful write.
      this.cacheHash.unpush(tip.hash);

      tip = await this.getPrevious(tip);
      assert(tip);
    }
  }

  /**
   * Save a block (not an entry) to the
   * database and potentially connect the inputs.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView?} view
   * @returns {Promise} - Returns {@link Block}.
   */

  async saveBlock(entry, block, view) {
    const hash = block.hash();

    if (this.options.spv)
      return undefined;

    // Write actual block data (this may be
    // better suited to flat files in the future).
    this.put(layout.b.encode(hash), block.encode());

    if (!view)
      return undefined;

    return this.connectBlock(entry, block, view);
  }

  /**
   * Remove a block (not an entry) to the database.
   * Disconnect inputs.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns {@link Block}.
   */

  async removeBlock(entry) {
    if (this.options.spv)
      return new CoinView();

    const block = await this.getBlock(entry.hash);

    if (!block)
      throw new Error('Block not found.');

    this.del(layout.b.encode(block.hash()));

    return this.disconnectBlock(entry, block);
  }

  /**
   * Commit coin view to database.
   * @private
   * @param {CoinView} view
   */

  saveView(view) {
    for (const [hash, coins] of view.map) {
      for (const [index, coin] of coins.outputs) {
        if (coin.spent) {
          this.del(layout.c.encode(hash, index));
          continue;
        }

        const raw = coin.encode();

        this.put(layout.c.encode(hash, index), raw);
      }
    }

    // Not optimal. Should be made a file in the future.
    if (view.bits.commit(this.field))
      this.put(layout.f.encode(), this.field.encode());
  }

  /**
   * Commit names to tree.
   * @private
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Boolean} revert
   */

  async saveNames(view, entry, revert) {
    for (const ns of view.names.values()) {
      const {nameHash} = ns;

      if (ns.isNull()) {
        await this.txn.remove(nameHash);
        continue;
      }

      await this.txn.insert(nameHash, ns.encode());
    }

    if ((entry.height % this.network.names.treeInterval) === 0) {
      // Explanation:
      //
      // During a reorg, we must revert the snapshot
      // back to the beginning of the interval. We
      // can still incrementally revert the database
      // transaction with state deltas, but unless
      // we get the tree hash back to what it was
      // at the start, we will end up rejecting blocks
      // during reconnection.
      //
      // This is an invalid state that cannot be
      // recovered from. Luckily, the block we're
      // disconnecting commits to the _previous_ tree
      // root, not the current one.
      if (revert)
        await this.tree.inject(entry.treeRoot);
      else
        await this.txn.commit();

      this.put(layout.s.encode(), this.tree.rootHash());
    }
  }

  /**
   * Connect names to tree.
   * @private
   * @param {CoinView} view
   * @param {ChainEntry} entry
   */

  async connectNames(view, entry) {
    const undo = view.toNameUndo();

    if (undo.names.length === 0)
      this.del(layout.w.encode(entry.height));
    else
      this.put(layout.w.encode(entry.height), undo.encode());

    return this.saveNames(view, entry, false);
  }

  /**
   * Disconnect names from tree.
   * @private
   * @param {CoinView} view
   * @param {ChainEntry} entry
   */

  async disconnectNames(view, entry) {
    const raw = await this.db.get(layout.w.encode(entry.height));

    if (raw) {
      const undo = NameUndo.decode(raw);

      for (const [nameHash, delta] of undo.names) {
        const ns = await view.getNameState(this, nameHash);

        ns.applyState(delta);
      }

      this.del(layout.w.encode(entry.height));
    }

    return this.saveNames(view, entry, true);
  }

  /**
   * Connect block inputs.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise} - Returns {@link Block}.
   */

  async connectBlock(entry, block, view) {
    if (this.options.spv)
      return undefined;

    const hash = block.hash();

    this.pending.connect(block);

    // Update chain state value.
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      if (i > 0) {
        for (const {prevout} of tx.inputs) {
          const output = view.getOutput(prevout);
          assert(output);

          // REGISTER->REVOKE covenants have no effect.
          if (output.covenant.type >= types.REGISTER
              && output.covenant.type <= types.REVOKE) {
            continue;
          }

          this.pending.spend(output);
        }
      }

      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i];

        if (output.isUnspendable())
          continue;

        // Registers are burned.
        if (output.covenant.isRegister())
          this.pending.burn(output);

        // REGISTER->REVOKE covenants have no effect.
        if (output.covenant.type >= types.REGISTER
            && output.covenant.type <= types.REVOKE) {
          continue;
        }

        this.pending.add(output);
      }

      // Index the transaction if enabled.
      this.indexTX(tx, view, entry, i);
    }

    // Commit new coin state.
    this.saveView(view);

    // Write undo coins (if there are any).
    if (!view.undo.isEmpty())
      this.put(layout.u.encode(hash), view.undo.commit());

    // Prune height-288 if pruning is enabled.
    await this.pruneBlock(entry);

    // Connect name state.
    return this.connectNames(view, entry);
  }

  /**
   * Disconnect block inputs.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async disconnectBlock(entry, block) {
    const view = new CoinView();

    if (this.options.spv)
      return view;

    const hash = block.hash();
    const undo = await this.getUndoCoins(hash);

    this.pending.disconnect(block);

    // Disconnect all transactions.
    for (let i = block.txs.length - 1; i >= 0; i--) {
      const tx = block.txs[i];

      if (i === 0) {
        view.bits.undo(tx);
      } else {
        for (let j = tx.inputs.length - 1; j >= 0; j--) {
          const {prevout} = tx.inputs[j];

          undo.apply(view, prevout);

          const output = view.getOutput(prevout);
          assert(output);

          // REGISTER->REVOKE covenants have no effect.
          if (output.covenant.type >= types.REGISTER
              && output.covenant.type <= types.REVOKE) {
            continue;
          }

          this.pending.add(output);
        }
      }

      // Remove any created coins.
      view.removeTX(tx, entry.height);

      for (let j = tx.outputs.length - 1; j >= 0; j--) {
        const output = tx.outputs[j];

        if (output.isUnspendable())
          continue;

        // Registers are burned.
        if (output.covenant.isRegister())
          this.pending.unburn(output);

        // REGISTER->REVOKE covenants have no effect.
        if (output.covenant.type >= types.REGISTER
            && output.covenant.type <= types.REVOKE) {
          continue;
        }

        this.pending.spend(output);
      }

      // Remove from transaction index.
      this.unindexTX(tx, view);
    }

    // Undo coins should be empty.
    assert(undo.isEmpty(), 'Undo coins data inconsistency.');

    // Commit new coin state.
    this.saveView(view);

    // Remove undo coins.
    this.del(layout.u.encode(hash));

    // Connect name state.
    await this.disconnectNames(view, entry);

    return view;
  }

  /**
   * Prune a block from the chain and
   * add current block to the prune queue.
   * @private
   * @param {ChainEntry} entry
   * @returns {Promise}
   */

  async pruneBlock(entry) {
    if (this.options.spv)
      return;

    if (!this.options.prune)
      return;

    const height = entry.height - this.network.block.keepBlocks;

    if (height <= this.network.block.pruneAfterHeight)
      return;

    const hash = await this.getHash(height);

    if (!hash)
      return;

    this.del(layout.b.encode(hash));
    this.del(layout.u.encode(hash));
  }

  /**
   * Save database options.
   * @returns {Promise}
   */

  saveFlags() {
    const flags = ChainFlags.fromOptions(this.options);
    const b = this.db.batch();
    b.put(layout.O.encode(), flags.encode());
    return b.write();
  }

  /**
   * Index a transaction by txid and address.
   * @private
   * @param {TX} tx
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Number} index
   */

  indexTX(tx, view, entry, index) {
    const hash = tx.hash();

    if (this.options.indexTX) {
      const meta = TXMeta.fromTX(tx, entry, index);

      this.put(layout.t.encode(hash), meta.encode());

      if (this.options.indexAddress) {
        for (const addr of tx.getHashes(view))
          this.put(layout.T.encode(addr, hash), null);
      }
    }

    if (!this.options.indexAddress)
      return;

    if (!tx.isCoinbase()) {
      for (const {prevout} of tx.inputs) {
        const {hash, index} = prevout;
        const coin = view.getOutput(prevout);
        assert(coin);

        const addr = coin.getHash();

        if (!addr)
          continue;

        this.del(layout.C.encode(addr, hash, index));
      }
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const addr = output.getHash();

      if (!addr)
        continue;

      this.put(layout.C.encode(addr, hash, i), null);
    }
  }

  /**
   * Remove transaction from index.
   * @private
   * @param {TX} tx
   * @param {CoinView} view
   */

  unindexTX(tx, view) {
    const hash = tx.hash();

    if (this.options.indexTX) {
      this.del(layout.t.encode(hash));
      if (this.options.indexAddress) {
        for (const addr of tx.getHashes(view))
          this.del(layout.T.encode(addr, hash));
      }
    }

    if (!this.options.indexAddress)
      return;

    if (!tx.isCoinbase()) {
      for (const {prevout} of tx.inputs) {
        const {hash, index} = prevout;
        const coin = view.getOutput(prevout);
        assert(coin);

        const addr = coin.getHash();

        if (!addr)
          continue;

        this.put(layout.C.encode(addr, hash, index), null);
      }
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const addr = output.getHash();

      if (!addr)
        continue;

      this.del(layout.C.encode(addr, hash, i));
    }
  }
}

/**
 * ChainFlags
 */

class ChainFlags extends bio.Struct {
  /**
   * Create chain flags.
   * @alias module:blockchain.ChainFlags
   * @constructor
   */

  constructor(options) {
    super();

    this.network = Network.primary;
    this.spv = false;
    this.prune = false;
    this.indexTX = false;
    this.indexAddress = false;

    if (options)
      this.fromOptions(options);
  }

  fromOptions(options) {
    this.network = Network.get(options.network);

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }

    if (options.indexTX != null) {
      assert(typeof options.indexTX === 'boolean');
      this.indexTX = options.indexTX;
    }

    if (options.indexAddress != null) {
      assert(typeof options.indexAddress === 'boolean');
      this.indexAddress = options.indexAddress;
    }

    return this;
  }

  getSize() {
    return 12;
  }

  write(bw) {
    let flags = 0;

    if (this.spv)
      flags |= 1 << 0;

    if (this.prune)
      flags |= 1 << 1;

    if (this.indexTX)
      flags |= 1 << 2;

    if (this.indexAddress)
      flags |= 1 << 3;

    bw.writeU32(this.network.magic);
    bw.writeU32(flags);
    bw.writeU32(0);

    return bw;
  }

  read(br) {
    this.network = Network.fromMagic(br.readU32());

    const flags = br.readU32();

    this.spv = (flags & 1) !== 0;
    this.prune = (flags & 2) !== 0;
    this.indexTX = (flags & 4) !== 0;
    this.indexAddress = (flags & 8) !== 0;

    return this;
  }
}

/**
 * Chain State
 */

class ChainState extends bio.Struct {
  /**
   * Create chain state.
   * @alias module:blockchain.ChainState
   * @constructor
   */

  constructor() {
    super();
    this.tip = consensus.ZERO_HASH;
    this.tx = 0;
    this.coin = 0;
    this.value = 0;
    this.burned = 0;
    this.committed = false;
  }

  inject(state) {
    this.tip = state.tip;
    this.tx = state.tx;
    this.coin = state.coin;
    this.value = state.value;
    this.burned = state.burned;
    return this;
  }

  connect(block) {
    this.tx += block.txs.length;
  }

  disconnect(block) {
    this.tx -= block.txs.length;
  }

  add(coin) {
    this.coin += 1;
    this.value += coin.value;
  }

  spend(coin) {
    this.coin -= 1;
    this.value -= coin.value;
  }

  burn(coin) {
    this.coin += 1;
    this.burned += coin.value;
  }

  unburn(coin) {
    this.coin -= 1;
    this.burned -= coin.value;
  }

  commit(hash) {
    assert(Buffer.isBuffer(hash));
    this.tip = hash;
    this.committed = true;
    return this.encode();
  }

  getSize() {
    return 64;
  }

  write(bw) {
    bw.writeHash(this.tip);
    bw.writeU64(this.tx);
    bw.writeU64(this.coin);
    bw.writeU64(this.value);
    bw.writeU64(this.burned);
    return bw;
  }

  read(br) {
    this.tip = br.readHash();
    this.tx = br.readU64();
    this.coin = br.readU64();
    this.value = br.readU64();
    this.burned = br.readU64();
    return this;
  }
}

/**
 * State Cache
 */

class StateCache {
  /**
   * Create state cache.
   * @alias module:blockchain.StateCache
   * @constructor
   */

  constructor(network) {
    this.network = network;
    this.bits = [];
    this.updates = [];
    this.init();
  }

  init() {
    for (let i = 0; i < 32; i++)
      this.bits.push(null);

    for (const {bit} of this.network.deploys) {
      assert(!this.bits[bit]);
      this.bits[bit] = new BufferMap();
    }
  }

  set(bit, entry, state) {
    const cache = this.bits[bit];

    assert(cache);

    if (cache.get(entry.hash) !== state) {
      cache.set(entry.hash, state);
      this.updates.push(new CacheUpdate(bit, entry.hash, state));
    }
  }

  get(bit, entry) {
    const cache = this.bits[bit];

    assert(cache);

    const state = cache.get(entry.hash);

    if (state == null)
      return -1;

    return state;
  }

  commit() {
    this.updates.length = 0;
  }

  drop() {
    for (const {bit, hash} of this.updates) {
      const cache = this.bits[bit];
      assert(cache);
      cache.delete(hash);
    }

    this.updates.length = 0;
  }

  insert(bit, hash, state) {
    const cache = this.bits[bit];
    assert(cache);
    cache.set(hash, state);
  }
}

/**
 * Cache Update
 */

class CacheUpdate {
  /**
   * Create cache update.
   * @constructor
   * @ignore
   */

  constructor(bit, hash, state) {
    this.bit = bit;
    this.hash = hash;
    this.state = state;
  }

  encode() {
    const data = Buffer.allocUnsafe(1);
    data[0] = this.state;
    return data;
  }
}

/*
 * Helpers
 */

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}

/*
 * Expose
 */

module.exports = ChainDB;
