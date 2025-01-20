/*!
 * txdb.js - persistent transaction pool
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {BufferSet} = require('buffer-map');
const util = require('../utils/util');
const Amount = require('../ui/amount');
const CoinView = require('../coins/coinview');
const Coin = require('../primitives/coin');
const Outpoint = require('../primitives/outpoint');
const layouts = require('./layout');
const layout = layouts.txdb;
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const rules = require('../covenants/rules');
const NameState = require('../covenants/namestate');
const NameUndo = require('../covenants/undo');
const {TXRecord} = require('./records');
const {types} = rules;

/** @typedef {import('bdb').DB} DB */
/** @typedef {ReturnType<DB['batch']>} Batch */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../types').BufioWriter} BufioWriter */
/** @typedef {import('../types').NetworkType} NetworkType */
/** @typedef {import('../types').Amount} AmountValue */
/** @typedef {import('../types').Rate} Rate */
/** @typedef {import('../protocol/network')} Network */
/** @typedef {import('../primitives/output')} Output */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('./records').BlockMeta} BlockMeta */
/** @typedef {import('./walletdb')} WalletDB */
/** @typedef {import('./wallet')} Wallet */
/** @typedef {import('./path')} Path */

/**
 * @typedef {Object} BlockExtraInfo
 * @property {Number} medianTime
 * @property {Number} txIndex
 */

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);
const UNCONFIRMED_HEIGHT = 0xffffffff;

/**
 * TXDB
 * @alias module:wallet.TXDB
 */

class TXDB {
  /**
   * Create a TXDB.
   * @constructor
   * @param {WalletDB} wdb
   * @param {Number} [wid=0]
   */

  constructor(wdb, wid) {
    /** @type {WalletDB} */
    this.wdb = wdb;
    this.db = wdb.db;
    this.logger = wdb.logger;
    this.nowFn = wdb.options.nowFn || util.now;
    this.maxTXs = wdb.options.maxHistoryTXs || 100;

    this.wid = wid || 0;
    this.bucket = null;
    this.wallet = null;
    this.locked = new BufferSet();
  }

  /**
   * Open TXDB.
   * @param {Wallet} wallet
   * @returns {Promise}
   */

  async open(wallet) {
    const prefix = layout.prefix.encode(wallet.wid);

    this.wid = wallet.wid;
    this.bucket = this.db.bucket(prefix);
    this.wallet = wallet;
  }

  /**
   * Emit transaction event.
   * @private
   * @param {String} event
   * @param {Object} data
   * @param {Details} [details]
   */

  emit(event, data, details) {
    this.wdb.emit(event, this.wallet, data, details);
    this.wallet.emit(event, data, details);
  }

  /**
   * Get wallet path for output.
   * @param {Output} output
   * @returns {Promise<Path?>}
   */

  getPath(output) {
    const hash = output.getHash();

    if (!hash)
      return null;

    return this.wdb.getPath(this.wid, hash);
  }

  /**
   * Test whether path exists for output.
   * @param {Output} output
   * @returns {Promise<Boolean>}
   */

  async hasPath(output) {
    const hash = output.getHash();

    if (!hash)
      return false;

    return this.wdb.hasPath(this.wid, hash);
  }

  /**
   * Save credit.
   * @param {Batch} b
   * @param {Credit} credit
   * @param {Path} path
   */

  async saveCredit(b, credit, path) {
    const {coin} = credit;

    b.put(layout.c.encode(coin.hash, coin.index), credit.encode());
    b.put(layout.C.encode(path.account, coin.hash, coin.index), null);

    return this.addOutpointMap(b, coin.hash, coin.index);
  }

  /**
   * Remove credit.
   * @param {Batch} b
   * @param {Credit} credit
   * @param {Path} path
   */

  async removeCredit(b, credit, path) {
    const {coin} = credit;

    b.del(layout.c.encode(coin.hash, coin.index));
    b.del(layout.C.encode(path.account, coin.hash, coin.index));

    return this.removeOutpointMap(b, coin.hash, coin.index);
  }

  /**
   * Spend credit.
   * @param {Batch} b
   * @param {Credit} credit
   * @param {TX} tx
   * @param {Number} index
   */

  spendCredit(b, credit, tx, index) {
    const prevout = tx.inputs[index].prevout;
    const spender = Outpoint.fromTX(tx, index);
    b.put(layout.s.encode(prevout.hash, prevout.index), spender.encode());
    b.put(layout.d.encode(spender.hash, spender.index), credit.coin.encode());
  }

  /**
   * Unspend credit.
   * @param {Batch} b
   * @param {TX} tx
   * @param {Number} index
   */

  unspendCredit(b, tx, index) {
    const prevout = tx.inputs[index].prevout;
    const spender = Outpoint.fromTX(tx, index);
    b.del(layout.s.encode(prevout.hash, prevout.index));
    b.del(layout.d.encode(spender.hash, spender.index));
  }

  /**
   * Spend credit by spender/input record.
   * Add undo coin to the input record.
   * @param {Batch} b
   * @param {Credit} credit
   * @param {Outpoint} spender
   */

  addUndoToInput(b, credit, spender) {
    b.put(layout.d.encode(spender.hash, spender.index), credit.coin.encode());
  }

  /**
   * Write input record.
   * @param {Batch} b
   * @param {TX} tx
   * @param {Number} index
   */

  async writeInput(b, tx, index) {
    const prevout = tx.inputs[index].prevout;
    const spender = Outpoint.fromTX(tx, index);
    b.put(layout.s.encode(prevout.hash, prevout.index), spender.encode());
    return this.addOutpointMap(b, prevout.hash, prevout.index);
  }

  /**
   * Remove input record.
   * @param {Batch} b
   * @param {TX} tx
   * @param {Number} index
   */

  async removeInput(b, tx, index) {
    const prevout = tx.inputs[index].prevout;
    b.del(layout.s.encode(prevout.hash, prevout.index));
    return this.removeOutpointMap(b, prevout.hash, prevout.index);
  }

  /**
   * Update wallet balance.
   * @param {Batch} b
   * @param {BalanceDelta} state
   */

  async updateBalance(b, state) {
    const balance = await this.getWalletBalance();
    state.applyTo(balance);
    b.put(layout.R.encode(), balance.encode());
    return balance;
  }

  /**
   * Update account balance.
   * @param {Batch} b
   * @param {Number} acct
   * @param {Balance} delta - account balance
   * @returns {Promise<Balance>}
   */

  async updateAccountBalance(b, acct, delta) {
    const balance = await this.getAccountBalance(acct);
    delta.applyTo(balance);
    b.put(layout.r.encode(acct), balance.encode());
    return balance;
  }

  /**
   * Test a whether a coin has been spent.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Outpoint?>}
   */

  async getSpent(hash, index) {
    const data = await this.bucket.get(layout.s.encode(hash, index));

    if (!data)
      return null;

    return Outpoint.decode(data);
  }

  /**
   * Test a whether a coin has been spent.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Boolean>}
   */

  isSpent(hash, index) {
    return this.bucket.has(layout.s.encode(hash, index));
  }

  /**
   * Append to global map.
   * @param {Batch} b
   * @param {Number} height
   * @returns {Promise}
   */

  addBlockMap(b, height) {
    return this.wdb.addBlockMap(b.root(), height, this.wid);
  }

  /**
   * Remove from global map.
   * @param {Batch} b
   * @param {Number} height
   * @returns {Promise}
   */

  removeBlockMap(b, height) {
    return this.wdb.removeBlockMap(b.root(), height, this.wid);
  }

  /**
   * Append to global map.
   * @param {Batch} b
   * @param {Hash} hash
   * @returns {Promise}
   */

  addTXMap(b, hash) {
    return this.wdb.addTXMap(b.root(), hash, this.wid);
  }

  /**
   * Remove from global map.
   * @param {Batch} b
   * @param {Hash} hash
   * @returns {Promise}
   */

  removeTXMap(b, hash) {
    return this.wdb.removeTXMap(b.root(), hash, this.wid);
  }

  /**
   * Append to global map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise}
   */

  addOutpointMap(b, hash, index) {
    return this.wdb.addOutpointMap(b.root(), hash, index, this.wid);
  }

  /**
   * Remove from global map.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise}
   */

  removeOutpointMap(b, hash, index) {
    return this.wdb.removeOutpointMap(b.root(), hash, index, this.wid);
  }

  /**
   * Append to global map.
   * @param {Batch} b
   * @param {Hash} nameHash
   * @returns {Promise}
   */

  addNameMap(b, nameHash) {
    return this.wdb.addNameMap(b.root(), nameHash, this.wid);
  }

  /**
   * Remove from global map.
   * @param {Batch} b
   * @param {Hash} nameHash
   * @returns {Promise}
   */

  removeNameMap(b, nameHash) {
    return this.wdb.removeNameMap(b.root(), nameHash, this.wid);
  }

  /**
   * List block records.
   * @returns {Promise<BlockRecord[]>}
   */

  getBlocks() {
    return this.bucket.keys({
      gte: layout.b.min(),
      lte: layout.b.max(),
      parse: key => layout.b.decode(key)[0]
    });
  }

  /**
   * Get block record.
   * @param {Number} height
   * @returns {Promise<BlockRecord?>}
   */

  async getBlock(height) {
    const data = await this.bucket.get(layout.b.encode(height));

    if (!data)
      return null;

    return BlockRecord.decode(data);
  }

  /**
   * Get block hashes size.
   * @param {Number} height
   * @returns {Promise<Number>}
   */

  async getBlockTXsSize(height) {
    const data = await this.bucket.get(layout.b.encode(height));

    if (!data)
      return 0;

    return data.readUInt32LE(40, true);
  }

  /**
   * Append to the global block record.
   * @param {Batch} b
   * @param {Hash} hash - transaction hash.
   * @param {BlockMeta} block
   * @returns {Promise}
   */

  async addBlock(b, hash, block) {
    const key = layout.b.encode(block.height);
    const data = await this.bucket.get(key);

    if (!data) {
      const blk = BlockRecord.fromMeta(block);
      blk.add(hash);
      b.put(key, blk.encode());
      return;
    }

    const raw = Buffer.allocUnsafe(data.length + 32);
    data.copy(raw, 0);

    const size = raw.readUInt32LE(40);
    raw.writeUInt32LE(size + 1, 40);
    hash.copy(raw, data.length);

    b.put(key, raw);
  }

  /**
   * Remove from the global block record.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} height
   * @returns {Promise}
   */

  async removeBlock(b, hash, height) {
    const key = layout.b.encode(height);
    const data = await this.bucket.get(key);

    if (!data)
      return;

    const size = data.readUInt32LE(40, true);

    assert(size > 0);
    assert(data.slice(-32).equals(hash));

    if (size === 1) {
      b.del(key);
      return;
    }

    const raw = data.slice(0, -32);
    raw.writeUInt32LE(size - 1, 40, true);

    b.put(key, raw);
  }

  /**
   * Remove from the global block record.
   * @param {Batch} b
   * @param {Hash} hash
   * @param {Number} height
   * @returns {Promise}
   */

  async spliceBlock(b, hash, height) {
    const block = await this.getBlock(height);

    if (!block)
      return;

    if (!block.remove(hash))
      return;

    if (block.hashes.size === 0) {
      b.del(layout.b.encode(height));
      return;
    }

    b.put(layout.b.encode(height), block.encode());
  }

  /**
   * Test whether we have a name.
   * @param {Buffer} nameHash
   * @returns {Promise<Boolean>}
   */

  async hasNameState(nameHash) {
    return this.bucket.has(layout.A.encode(nameHash));
  }

  /**
   * Get a name state if present.
   * @param {Buffer} nameHash
   * @returns {Promise<NameState?>}
   */

  async getNameState(nameHash) {
    const raw = await this.bucket.get(layout.A.encode(nameHash));

    if (!raw)
      return null;

    const ns = NameState.decode(raw);
    ns.nameHash = nameHash;

    return ns;
  }

  /**
   * Get all names.
   * @returns {Promise<NameState[]>}
   */

  async getNames() {
    const iter = this.bucket.iterator({
      gte: layout.A.min(),
      lte: layout.A.max(),
      values: true
    });

    const names = [];

    await iter.each((key, raw) => {
      const [nameHash] = layout.A.decode(key);
      const ns = NameState.decode(raw);
      ns.nameHash = nameHash;
      names.push(ns);
    });

    return names;
  }

  /**
   * Test whether we have a bid.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @returns {Promise<Boolean>}
   */

  async hasBid(nameHash, outpoint) {
    const {hash, index} = outpoint;
    return this.bucket.has(layout.i.encode(nameHash, hash, index));
  }

  /**
   * Get a bid if present.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @returns {Promise<BlindBid?>}
   */

  async getBid(nameHash, outpoint) {
    const {hash, index} = outpoint;
    const raw = await this.bucket.get(layout.i.encode(nameHash, hash, index));

    if (!raw)
      return null;

    const bb = BlindBid.decode(raw);
    bb.nameHash = nameHash;
    bb.prevout = outpoint;

    return bb;
  }

  /**
   * Write a bid.
   * @param {Object} b
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @param {Object} options
   */

  putBid(b, nameHash, outpoint, options) {
    const {hash, index} = outpoint;
    const bb = new BlindBid();
    bb.nameHash = nameHash;
    bb.name = options.name;
    bb.lockup = options.lockup;
    bb.blind = options.blind;
    bb.own = options.own;
    bb.height = options.height;
    b.put(layout.i.encode(nameHash, hash, index), bb.encode());
  }

  /**
   * Delete a bid.
   * @param {Object} b
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   */

  removeBid(b, nameHash, outpoint) {
    const {hash, index} = outpoint;
    b.del(layout.i.encode(nameHash, hash, index));
  }

  /**
   * Get all bids for name.
   * @param {Buffer} [nameHash]
   * @returns {Promise<BlindBid[]>}
   */

  async getBids(nameHash) {
    const iter = this.bucket.iterator({
      gte: nameHash ? layout.i.min(nameHash) : layout.i.min(),
      lte: nameHash ? layout.i.max(nameHash) : layout.i.max(),
      values: true
    });

    const bids = [];

    await iter.each(async (key, raw) => {
      const [nameHash, hash, index] = layout.i.decode(key);
      const bb = BlindBid.decode(raw);

      bb.nameHash = nameHash;
      bb.prevout = new Outpoint(hash, index);

      const bv = await this.getBlind(bb.blind);

      if (bv)
        bb.value = bv.value;

      bids.push(bb);
    });

    return bids;
  }

  /**
   * Remove all bids for name.
   * @param {Batch} b
   * @param {Buffer} nameHash
   * @returns {Promise}
   */

  async removeBids(b, nameHash) {
    const iter = this.bucket.iterator({
      gte: layout.i.min(nameHash),
      lte: layout.i.max(nameHash)
    });

    await iter.each(k => b.del(k));
  }

  /**
   * Test whether we have a reveal.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @returns {Promise<Boolean>}
   */

  async hasReveal(nameHash, outpoint) {
    const {hash, index} = outpoint;
    return this.bucket.has(layout.B.encode(nameHash, hash, index));
  }

  /**
   * Get a reveal if present.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @returns {Promise<BidReveal?>}
   */

  async getReveal(nameHash, outpoint) {
    const {hash, index} = outpoint;
    const raw = await this.bucket.get(layout.B.encode(nameHash, hash, index));

    if (!raw)
      return null;

    const brv = BidReveal.decode(raw);
    brv.nameHash = nameHash;
    brv.prevout = outpoint;

    return brv;
  }

  /**
   * Get reveal by bid outpoint.
   * @param {Buffer} nameHash
   * @param {Outpoint} bidOut
   * @returns {Promise<BidReveal?>}
   */

  async getRevealByBid(nameHash, bidOut) {
    const rawOutpoint = await this.bucket.get(
      layout.E.encode(nameHash, bidOut.hash, bidOut.index));

    if (!rawOutpoint)
      return null;

    const outpoint = Outpoint.decode(rawOutpoint);
    return this.getReveal(nameHash, outpoint);
  }

  /**
   * Get bid by reveal outpoint.
   * @param {Buffer} nameHash
   * @param {Outpoint} revealOut
   * @returns {Promise<BlindBid?>}
   */

  async getBidByReveal(nameHash, revealOut) {
    const reveal = await this.getReveal(nameHash, revealOut);

    if (!reveal)
      return null;

    return this.getBid(nameHash, reveal.bidPrevout);
  }

  /**
   * Write a reveal.
   * @param {Object} b
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @param {Object} options
   * @param {Buffer} options.name
   * @param {AmountValue} options.value
   * @param {Number} options.height
   * @param {Boolean} options.own
   * @param {Outpoint} options.bidPrevout
   * @returns {void}
   */

  putReveal(b, nameHash, outpoint, options) {
    const {hash, index} = outpoint;
    const {bidPrevout} = options;
    const brv = new BidReveal();
    brv.nameHash = nameHash;
    brv.name = options.name;
    brv.value = options.value;
    brv.height = options.height;
    brv.own = options.own;
    brv.bidPrevout = bidPrevout;
    b.put(layout.B.encode(nameHash, hash, index), brv.encode());
    b.put(layout.E.encode(nameHash, bidPrevout.hash, bidPrevout.index),
      outpoint.encode());
  }

  /**
   * Delete a reveal.
   * @param {Object} b
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @param {Outpoint} bidPrevout
   */

  removeReveal(b, nameHash, outpoint, bidPrevout) {
    const {hash, index} = outpoint;
    b.del(layout.B.encode(nameHash, hash, index));
    b.del(layout.E.encode(nameHash, bidPrevout.hash, bidPrevout.index));
  }

  /**
   * Get all reveals by name.
   * @param {Buffer} [nameHash]
   * @returns {Promise<BidReveal[]>}
   */

  async getReveals(nameHash) {
    const iter = this.bucket.iterator({
      gte: nameHash ? layout.B.min(nameHash) : layout.B.min(),
      lte: nameHash ? layout.B.max(nameHash) : layout.B.max(),
      values: true
    });

    const reveals = [];

    await iter.each(async (key, raw) => {
      const [nameHash, hash, index] = layout.B.decode(key);
      const brv = BidReveal.decode(raw);
      brv.nameHash = nameHash;
      brv.prevout = new Outpoint(hash, index);
      reveals.push(brv);
    });

    return reveals;
  }

  /**
   * Remove all reveals by name.
   * @param {Object} b
   * @param {Buffer} nameHash
   * @returns {Promise}
   */

  async removeReveals(b, nameHash) {
    const iter = this.bucket.iterator({
      gte: layout.B.min(nameHash),
      lte: layout.B.max(nameHash)
    });

    await iter.each(k => b.del(k));
  }

  /**
   * Test whether a blind value is present.
   * @param {Buffer} blind - Blind hash.
   * @returns {Promise<Boolean>}
   */

  async hasBlind(blind) {
    return this.bucket.has(layout.v.encode(blind));
  }

  /**
   * Get a blind value if present.
   * @param {Buffer} blind - Blind hash.
   * @returns {Promise<BlindValue?>}
   */

  async getBlind(blind) {
    const raw = await this.bucket.get(layout.v.encode(blind));

    if (!raw)
      return null;

    return BlindValue.decode(raw);
  }

  /**
   * Write a blind value.
   * @param {Object} b
   * @param {Buffer} blind
   * @param {Object} options
   */

  putBlind(b, blind, options) {
    const {value, nonce} = options;
    const bv = new BlindValue();
    bv.value = value;
    bv.nonce = nonce;
    b.put(layout.v.encode(blind), bv.encode());
  }

  /**
   * Save blind value.
   * @param {Buffer} blind
   * @param {Object} options
   * @returns {Promise}
   */

  async saveBlind(blind, options) {
    const b = this.bucket.batch();
    this.putBlind(b, blind, options);
    await b.write();
  }

  /**
   * Delete a blind value.
   * @param {Object} b
   * @param {Buffer} blind
   */

  removeBlind(b, blind) {
    b.del(layout.v.encode(blind));
  }

  /**
   * Add transaction without a batch.
   * @param {TX} tx
   * @param {BlockMeta} [block]
   * @param {BlockExtraInfo} [extra]
   * @returns {Promise<Details?>}
   */

  async add(tx, block, extra) {
    const hash = tx.hash();
    const existing = await this.getTX(hash);

    assert(!tx.mutable, 'Cannot add mutable TX to wallet.');

    if (existing) {
      // Existing tx is already confirmed. Ignore.
      if (existing.height !== -1)
        return null;

      // The incoming tx won't confirm the
      // existing one anyway. Ignore.
      if (!block)
        return null;

      // Get txIndex of the wallet.
      extra.txIndex = await this.getBlockTXsSize(block.height);

      // Confirm transaction.
      return this.confirm(existing, block, extra);
    }

    const now = this.nowFn();
    const wtx = TXRecord.fromTX(tx, block, now);

    if (!block) {
      // Potentially remove double-spenders.
      // Only remove if they're not confirmed.
      if (!await this.removeConflicts(tx, true))
        return null;
      if (await this.isDoubleOpen(tx))
        return null;
    } else {
      // Potentially remove double-spenders.
      await this.removeConflicts(tx, false);
      await this.removeDoubleOpen(tx);
    }

    if (block)
      extra.txIndex = await this.getBlockTXsSize(block.height);

    // Finally we can do a regular insertion.
    return this.insert(wtx, block, extra);
  }

  /**
   * Test whether the transaction
   * has a duplicate open.
   * @param {TX} tx
   * @returns {Promise<Boolean>}
   */

  async isDoubleOpen(tx) {
    for (const {covenant} of tx.outputs) {
      if (!covenant.isOpen())
        continue;

      const nameHash = covenant.getHash(0);
      const key = layout.o.encode(nameHash);
      const hash = await this.bucket.get(key);

      // Allow a double open if previous auction period has expired
      // this is not a complete check for name availability or status!
      if (hash) {
        const names = this.wdb.network.names;
        const period = names.biddingPeriod + names.revealPeriod;
        const oldTX = await this.getTX(hash);
        if (oldTX.height !== -1 && oldTX.height + period < this.wdb.height)
          return false;

        return true;
      }
    }

    return false;
  }

  /**
   * Remove duplicate opens.
   * @private
   * @param {TX} tx
   * @returns {Promise}
   */

  async removeDoubleOpen(tx) {
    for (const {covenant} of tx.outputs) {
      if (!covenant.isOpen())
        continue;

      const nameHash = covenant.getHash(0);
      const key = layout.o.encode(nameHash);
      const hash = await this.bucket.get(key);

      if (!hash)
        continue;

      const wtx = await this.getTX(hash);

      if (wtx.height !== -1)
        return;

      await this.remove(hash);
    }
  }

  /**
   * Index open covenants.
   * @private
   * @param {Batch} b
   * @param {TX} tx
   */

  indexOpens(b, tx) {
    for (const {covenant} of tx.outputs) {
      if (!covenant.isOpen())
        continue;

      const nameHash = covenant.getHash(0);
      const key = layout.o.encode(nameHash);

      b.put(key, tx.hash());
    }
  }

  /**
   * Unindex open covenants.
   * @private
   * @param {Batch} b
   * @param {TX} tx
   */

  unindexOpens(b, tx) {
    for (const {covenant} of tx.outputs) {
      if (!covenant.isOpen())
        continue;

      const nameHash = covenant.getHash(0);
      const key = layout.o.encode(nameHash);

      b.del(key);
    }
  }

  /**
   * Insert transaction.
   * @private
   * @param {TXRecord} wtx
   * @param {BlockMeta} [block]
   * @param {BlockExtraInfo} [extra]
   * @returns {Promise<Details>}
   */

  async insert(wtx, block, extra) {
    const b = this.bucket.batch();
    const {tx, hash} = wtx;
    const height = block ? block.height : -1;
    const details = new Details(wtx, block);
    const state = new BalanceDelta();
    const view = new CoinView();

    let own = false;

    if (!tx.isCoinbase()) {
      // We need to potentially spend some coins here.
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        const {hash, index} = input.prevout;
        const credit = await this.getCredit(hash, index);

        if (!credit) {
          // Watch all inputs for incoming txs.
          // This allows us to check for double spends.
          if (!block)
            await this.writeInput(b, tx, i);
          continue;
        }

        const coin = credit.coin;
        const path = await this.getPath(coin);
        assert(path);

        // Build the tx details object
        // as we go, for speed.
        details.setInput(i, path, coin);

        // Write an undo coin for the credit
        // and add it to the stxo set.
        this.spendCredit(b, credit, tx, i);

        // Unconfirmed balance should always
        // be updated as it reflects the on-chain
        // balance _and_ mempool balance assuming
        // everything in the mempool were to confirm.
        state.tx(path, 1);
        state.coin(path, -1);
        state.unconfirmed(path, -coin.value);
        this.unlockBalances(state, credit, path, -1);

        if (!block) {
          // If the tx is not mined, we do not
          // disconnect the coin, we simply mark
          // a `spent` flag on the credit. This
          // effectively prevents the mempool
          // from altering our utxo state
          // permanently. It also makes it
          // possible to compare the on-chain
          // state vs. the mempool state.
          credit.spent = true;
          await this.saveCredit(b, credit, path);
        } else {
          // If the tx is mined, we can safely
          // remove the coin being spent. This
          // coin will be indexed as an undo
          // coin so it can be reconnected
          // later during a reorg.
          state.confirmed(path, -coin.value);
          this.unlockBalances(state, credit, path, height);

          await this.removeCredit(b, credit, path);

          view.addCoin(coin);
        }

        own = true;
      }
    }

    // Potentially add coins to the utxo set.
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const path = await this.getPath(output);

      if (!path)
        continue;

      details.setOutput(i, path);

      const credit = Credit.fromTX(tx, i, height);
      credit.own = own;

      state.tx(path, 1);
      state.coin(path, 1);
      state.unconfirmed(path, output.value);
      this.lockBalances(state, credit, path, -1);

      if (block) {
        state.confirmed(path, output.value);
        this.lockBalances(state, credit, path, height);
      }

      const spender = await this.getSpent(hash, i);

      if (spender) {
        credit.spent = true;
        this.addUndoToInput(b, credit, spender);

        // TODO: emit 'missed credit'
        state.coin(path, -1);
        state.unconfirmed(path, -output.value);
        this.unlockBalances(state, credit, path, -1);
      }

      await this.saveCredit(b, credit, path);
      await this.watchOpensEarly(b, output);
    }

    // Handle names.
    if (block && !await this.bucket.has(layout.U.encode(hash))) {
      const updated = await this.connectNames(b, tx, view, height);

      if (updated && !state.updated()) {
        // Always save namestate transitions,
        // even if they don't affect wallet balance
        await this.addBlockMap(b, height);
        await this.addBlock(b, tx.hash(), block);
        await b.write();
      }
    }

    // If this didn't update any coins,
    // it's not our transaction.
    if (!state.updated())
      return null;

    // Index open covenants.
    if (!block)
      this.indexOpens(b, tx);

    // Save and index the transaction record.
    b.put(layout.t.encode(hash), wtx.encode());

    if (!block)
      b.put(layout.p.encode(hash), null);
    else
      b.put(layout.h.encode(height, hash), null);

    // Do some secondary indexing for account-based
    // queries. This saves us a lot of time for
    // queries later.
    for (const [acct, delta] of state.accounts) {
      await this.updateAccountBalance(b, acct, delta);

      b.put(layout.T.encode(acct, hash), null);

      if (!block)
        b.put(layout.P.encode(acct, hash), null);
      else
        b.put(layout.H.encode(acct, height, hash), null);
    }

    // Update block records.
    if (block) {
      // If confirmed in a block (e.g. coinbase tx) and not
      // being updated or previously seen, we need to add
      // the monotonic time and count index for the transaction
      await this.addCountAndTimeIndex(b, {
        accounts: state.accounts,
        hash,
        height: block.height,
        blockextra: extra
      });

      // In the event that this transaction becomes unconfirmed
      // during a reorganization, this transaction will need an
      // unconfirmed time and unconfirmed index, however since this
      // transaction was not previously seen previous to the block,
      // we need to add that information.
      // TODO: This can be skipped if TX is coinbase, but even now
      // it will be properly cleaned up on erase.
      await this.addCountAndTimeIndexUnconfirmedUndo(b, hash, wtx.mtime);

      await this.addBlockMap(b, height);
      await this.addBlock(b, tx.hash(), block);
    } else {
      // Add indexing for unconfirmed transactions.
      await this.addCountAndTimeIndexUnconfirmed(b, state.accounts, hash,
        wtx.mtime);

      await this.addTXMap(b, hash);
    }

    // Commit the new state.
    const balance = await this.updateBalance(b, state);

    await b.write();

    // This transaction may unlock some
    // coins now that we've seen it.
    this.unlockTX(tx);

    // Emit events for potential local and
    // websocket listeners. Note that these
    // will only be emitted if the batch is
    // successfully written to disk.
    this.emit('tx', tx, details);
    this.emit('balance', balance);

    return details;
  }

  /**
   * Attempt to confirm a transaction.
   * @private
   * @param {TXRecord} wtx
   * @param {BlockMeta} block
   * @param {BlockExtraInfo} extra
   * @returns {Promise<Details>}
   */

  async confirm(wtx, block, extra) {
    const b = this.bucket.batch();
    const {tx, hash} = wtx;
    const height = block.height;
    const details = new Details(wtx, block);
    const state = new BalanceDelta();
    const view = new CoinView();
    let own = false;

    assert(block && extra);
    wtx.setBlock(block);

    if (!tx.isCoinbase()) {
      const credits = await this.getSpentCredits(tx);

      // Potentially spend coins. Now that the tx
      // is mined, we can actually _remove_ coins
      // from the utxo state.
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        const {hash, index} = input.prevout;

        let resolved = false;

        // There may be new credits available
        // that we haven't seen yet.
        if (!credits[i]) {
          await this.removeInput(b, tx, i);

          // NOTE: This check has been moved to the outputs
          // processing in insert(pending), insert(block) and confirm.
          // But will still be here just in case.
          const credit = await this.getCredit(hash, index);

          if (!credit)
            continue;

          // Add a spend record and undo coin
          // for the coin we now know is ours.
          // We don't need to remove the coin
          // since it was never added in the
          // first place.
          this.spendCredit(b, credit, tx, i);

          credits[i] = credit;
          resolved = true;
        }

        const credit = credits[i];
        const coin = credit.coin;

        assert(coin.height !== -1);

        const path = await this.getPath(coin);
        assert(path);
        own = true;

        details.setInput(i, path, coin);

        if (resolved) {
          state.coin(path, -1);
          state.unconfirmed(path, -coin.value);
          this.unlockBalances(state, credit, path, -1);
        }

        state.confirmed(path, -coin.value);
        this.unlockBalances(state, credit, path, height);

        // We can now safely remove the credit
        // entirely, now that we know it's also
        // been removed on-chain.
        await this.removeCredit(b, credit, path);

        view.addCoin(coin);
      }
    }

    // Update credit heights, including undo coins.
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const path = await this.getPath(output);

      if (!path)
        continue;

      details.setOutput(i, path);

      let credit = await this.getCredit(hash, i);

      if (!credit) {
        // TODO: Emit 'missed credit' event.

        // This credit didn't belong to us the first time we
        // saw the transaction (before confirmation or rescan).
        // Create new credit for database.
        credit = Credit.fromTX(tx, i, height);

        // If this tx spent any of our own coins, we "own" this output,
        // meaning if it becomes unconfirmed, we can still confidently spend it.
        credit.own = own;

        const spender = await this.getSpent(hash, i);

        if (spender) {
          credit.spent = true;
          this.addUndoToInput(b, credit, spender);
        } else {
          // Add coin to "unconfirmed" balance (which includes confirmed coins)
          state.coin(path, 1);
          state.unconfirmed(path, credit.coin.value);
          this.lockBalances(state, credit, path, -1);
        }
      }

      // Credits spent in the mempool add an
      // undo coin for ease. If this credit is
      // spent in the mempool, we need to
      // update the undo coin's height.
      if (credit.spent)
        await this.updateSpentCoin(b, tx, i, height);

      // Update coin height and confirmed
      // balance. Save once again.
      state.confirmed(path, output.value);
      this.lockBalances(state, credit, path, height);

      credit.coin.height = height;

      await this.saveCredit(b, credit, path);
    }

    // Handle names.
    await this.connectNames(b, tx, view, height);

    // Disconnect unconfirmed time index for the transaction.
    // This must go before adding the the indexes, as the
    // unconfirmed count needs to be copied first.
    await this.disconnectCountAndTimeIndexUnconfirmed(b, state.accounts, hash);

    // Add monotonic and count time index for transactions
    // that already exist in the database and are now
    // being confirmed.
    await this.addCountAndTimeIndex(b, {
      accounts: state.accounts,
      hash,
      height: block.height,
      blockextra: extra
    });

    // Save the new serialized transaction as
    // the block-related properties have been
    // updated. Also reindex for height.
    b.put(layout.t.encode(hash), wtx.encode());
    b.del(layout.p.encode(hash));
    b.put(layout.h.encode(height, hash), null);

    // Secondary indexing also needs to change.
    for (const [acct, delta] of state.accounts) {
      await this.updateAccountBalance(b, acct, delta);
      b.del(layout.P.encode(acct, hash));
      b.put(layout.H.encode(acct, height, hash), null);
    }

    await this.removeTXMap(b, hash);
    await this.addBlockMap(b, height);
    await this.addBlock(b, tx.hash(), block);

    // Commit the new state. The balance has updated.
    const balance = await this.updateBalance(b, state);

    this.unindexOpens(b, tx);

    await b.write();

    this.unlockTX(tx);

    this.emit('confirmed', tx, details);
    this.emit('balance', balance);

    return details;
  }

  /**
   * Recursively remove a transaction
   * from the database.
   * @param {Hash} hash
   * @returns {Promise<Details?>}
   */

  async remove(hash) {
    const wtx = await this.getTX(hash);

    if (!wtx)
      return null;

    return this.removeRecursive(wtx);
  }

  /**
   * Remove a transaction from the
   * database. Disconnect inputs.
   * @private
   * @param {TXRecord} wtx
   * @param {BlockMeta} [block]
   * @param {Number} [medianTime]
   * @returns {Promise<Details>}
   */

  async erase(wtx, block, medianTime) {
    const b = this.bucket.batch();
    const {tx, hash} = wtx;
    const height = block ? block.height : -1;
    const details = new Details(wtx, block);
    const state = new BalanceDelta();

    if (!tx.isCoinbase()) {
      // We need to undo every part of the
      // state this transaction ever touched.
      // Start by getting the undo coins.
      const credits = await this.getSpentCredits(tx);

      for (let i = 0; i < tx.inputs.length; i++) {
        const credit = credits[i];

        if (!credit) {
          if (!block)
            await this.removeInput(b, tx, i);
          continue;
        }

        const coin = credit.coin;
        const path = await this.getPath(coin);
        assert(path);

        details.setInput(i, path, coin);

        // Recalculate the balance, remove
        // from stxo set, remove the undo
        // coin, and resave the credit.
        state.tx(path, -1);
        state.coin(path, 1);
        state.unconfirmed(path, coin.value);
        this.lockBalances(state, credit, path, -1);

        if (block) {
          state.confirmed(path, coin.value);
          this.lockBalances(state, credit, path, height);
        }

        this.unspendCredit(b, tx, i);

        credit.spent = false;
        await this.saveCredit(b, credit, path);
      }
    }

    // We need to remove all credits
    // this transaction created.
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const path = await this.getPath(output);

      if (!path)
        continue;

      const credit = await this.getCredit(hash, i);

      // If we don't have credit for the output, then we don't need
      // to do anything, because they were getting erased anyway.
      if (!credit)
        continue;

      details.setOutput(i, path);

      state.tx(path, -1);
      state.coin(path, -1);
      state.unconfirmed(path, -output.value);
      this.unlockBalances(state, credit, path, -1);

      if (block) {
        state.confirmed(path, -output.value);
        this.unlockBalances(state, credit, path, height);
      }

      await this.removeCredit(b, credit, path);
    }

    // Undo name state.
    await this.undoNameState(b, tx);

    if (!block)
      this.unindexOpens(b, tx);

    // Remove the transaction data
    // itself as well as unindex.
    b.del(layout.t.encode(hash));

    if (!block)
      b.del(layout.p.encode(hash));
    else
      b.del(layout.h.encode(height, hash));

    // Remove all secondary indexing.
    for (const [acct, delta] of state.accounts) {
      await this.updateAccountBalance(b, acct, delta);

      b.del(layout.T.encode(acct, hash));

      if (!block)
        b.del(layout.P.encode(acct, hash));
      else
        b.del(layout.H.encode(acct, height, hash));
    }

    // Update block records.
    if (block) {
      // Remove tx count and time indexing.
      await this.removeCountAndTimeIndex(b, {
        hash,
        medianTime,
        accounts: state.accounts
      });

      // We also need to clean up unconfirmed undos.
      b.del(layout.Oe.encode(hash));

      await this.removeBlockMap(b, height);
      await this.spliceBlock(b, hash, height);
    } else {
      await this.removeTXMap(b, hash);
      // Remove count and time indexes.
      await this.removeCountAndTimeIndexUnconfirmed(b, state.accounts, hash);
    }

    // Update the transaction counter
    // and commit new state due to
    // balance change.
    const balance = await this.updateBalance(b, state);

    await b.write();

    this.emit('remove tx', tx, details);
    this.emit('balance', balance);

    return details;
  }

  /**
   * Remove a transaction and recursively
   * remove all of its spenders.
   * @private
   * @param {TXRecord} wtx
   * @returns {Promise<Details?>}
   */

  async removeRecursive(wtx) {
    const {tx, hash} = wtx;

    if (!await this.hasTX(hash))
      return null;

    for (let i = 0; i < tx.outputs.length; i++) {
      const spent = await this.getSpent(hash, i);

      if (!spent)
        continue;

      // Remove all of the spender's spenders first.
      const stx = await this.getTX(spent.hash);

      assert(stx);

      await this.removeRecursive(stx);
    }

    const block = wtx.getBlock();
    let medianTime;

    if (block)
      medianTime = await this.wdb.getMedianTime(block.height);

    // Remove the spender.
    return this.erase(wtx, block, medianTime);
  }

  /**
   * Revert a block.
   * @param {Number} height
   * @returns {Promise<Number>} - number of txs removed.
   */

  async revert(height) {
    const block = await this.getBlock(height);

    if (!block)
      return 0;

    const hashes = block.toArray();
    const mtp = await this.wdb.getMedianTime(height);
    assert(mtp);

    for (let i = hashes.length - 1; i >= 0; i--) {
      const hash = hashes[i];
      /** @type {BlockExtraInfo} */
      const extra = {
        medianTime: mtp,
        // txIndex is not used in revert.
        txIndex: i
      };

      await this.unconfirm(hash, height, extra);
    }

    return hashes.length;
  }

  /**
   * Unconfirm a transaction without a batch.
   * @private
   * @param {Hash} hash
   * @param {Number} height
   * @param {BlockExtraInfo} extra
   * @returns {Promise<Details?>}
   */

  async unconfirm(hash, height, extra) {
    const wtx = await this.getTX(hash);

    if (!wtx) {
      this.logger.spam(
        'Reverting namestate without transaction: %x',
        hash
      );

      const b = this.bucket.batch();

      if (await this.applyNameUndo(b, hash)) {
        await this.removeBlockMap(b, height);
        await this.removeBlock(b, hash, height);

        return b.write();
      }

      return null;
    }

    if (wtx.height === -1)
      return null;

    const tx = wtx.tx;

    if (tx.isCoinbase())
      return this.removeRecursive(wtx);

    // On unconfirm, if we already have OPEN txs in the pending list we
    // remove transaction and it's descendants instead of storing them in
    // the pending list. This follows the mempool behaviour where the first
    // entries in the mempool will be the ones left, instead of txs coming
    // from the block. This ensures consistency with the double open rules.
    if (await this.isDoubleOpen(tx))
      return this.removeRecursive(wtx);

    return this.disconnect(wtx, wtx.getBlock(), extra);
  }

  /**
   * Unconfirm a transaction. Necessary after a reorg.
   * @param {TXRecord} wtx
   * @param {BlockMeta} block
   * @param {BlockExtraInfo} extra
   * @returns {Promise<Details>}
   */

  async disconnect(wtx, block, extra) {
    const b = this.bucket.batch();
    const {tx, hash, height} = wtx;
    const details = new Details(wtx, block);
    const state = new BalanceDelta();
    let own = false;

    assert(block && extra);

    wtx.unsetBlock();

    if (!tx.isCoinbase()) {
      // We need to reconnect the coins. Start
      // by getting all of the undo coins we know
      // about.
      const credits = await this.getSpentCredits(tx);

      for (let i = 0; i < tx.inputs.length; i++) {
        const credit = credits[i];

        if (!credit) {
          await this.writeInput(b, tx, i);
          continue;
        }

        const coin = credit.coin;

        assert(coin.height !== -1);

        const path = await this.getPath(coin);
        assert(path);

        details.setInput(i, path, coin);

        state.confirmed(path, coin.value);
        this.lockBalances(state, credit, path, height);

        // Resave the credit and mark it
        // as spent in the mempool instead.
        credit.spent = true;
        own = true;
        await this.saveCredit(b, credit, path);
      }
    }

    // We need to remove heights on
    // the credits and undo coins.
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const path = await this.getPath(output);

      if (!path)
        continue;

      let credit = await this.getCredit(hash, i);
      let resolved = false;

      // Potentially update undo coin height.
      if (!credit) {
        // TODO: Emit 'missed credit' event.

        // This credit didn't belong to us the first time we
        // saw the transaction (after confirmation).
        // Create new credit for database.
        credit = Credit.fromTX(tx, i, height);

        // If this tx spent any of our own coins, we "own" this output,
        // meaning if it becomes unconfirmed, we can still confidently spend it.
        credit.own = own;
        resolved = true;

        const spender = await this.getSpent(hash, i);

        if (spender) {
          credit.spent = true;
          this.addUndoToInput(b, credit, spender);
        } else {
          // If the newly discovered Coin is not spent,
          // we need to add these to the balance.
          state.coin(path, 1);
          state.unconfirmed(path, credit.coin.value);
          this.lockBalances(state, credit, path, -1);
        }
      } else if (credit.spent) {
        // The coin height of this output becomes -1
        // as it is being unconfirmed.
        await this.updateSpentCoin(b, tx, i, -1);
      }

      details.setOutput(i, path);

      // Update coin height and confirmed
      // balance. Save once again.
      credit.coin.height = -1;

      // If the coin was not discovered now, it means
      // we need to subtract the values as they were part of
      // the balance.
      // If the credit is new, confirmed balances did not account for it.
      if (!resolved) {
        state.confirmed(path, -output.value);
        this.unlockBalances(state, credit, path, height);
      }

      await this.saveCredit(b, credit, path);
    }

    // Unconfirm will also index OPENs as the transaction is now part of the
    // wallet pending transactions.
    this.indexOpens(b, tx);

    // Undo name state.
    await this.undoNameState(b, tx);

    await this.addTXMap(b, hash);
    await this.removeBlockMap(b, height);
    await this.removeBlock(b, tx.hash(), height);

    // We need to update the now-removed
    // block properties and reindex due
    // to the height change.
    b.put(layout.t.encode(hash), wtx.encode());
    b.put(layout.p.encode(hash), null);
    b.del(layout.h.encode(height, hash));

    // Secondary indexing also needs to change.
    for (const [acct, delta] of state.accounts) {
      await this.updateAccountBalance(b, acct, delta);
      b.put(layout.P.encode(acct, hash), null);
      b.del(layout.H.encode(acct, height, hash));
    }

    // Remove tx count and time indexing. This must
    // go before restoring the unconfirmed count.
    await this.removeCountAndTimeIndex(b, {
      hash,
      medianTime: extra.medianTime,
      accounts: state.accounts
    });

    // Restore count indexing for unconfirmed txs.
    await this.restoreCountAndTimeIndexUnconfirmed(b, state.accounts, hash);

    // Commit state due to unconfirmed
    // vs. confirmed balance change.
    const balance = await this.updateBalance(b, state);

    await b.write();

    this.emit('unconfirmed', tx, details);
    this.emit('balance', balance);

    return details;
  }

  /*
   * Count and time index.
   */

  /**
   * Get the latest unconfirmed TX count from the database. This number
   * does not represent the count of current unconfirmed transactions,
   * but the count of all unconfirmed transactions. As transactions are
   * confirmed the value is deleted, however proceeding values are not
   * decremented as to not have a large number of database updates at once.
   * @returns {Promise<TXCount>}
   */

  async getLatestUnconfirmedTXCount() {
    const raw = await this.bucket.get(layout.Ol.encode());
    let index = 0;

    if (raw)
      index = raw.readUInt32LE(0, true);

    return new TXCount(UNCONFIRMED_HEIGHT, index);
  }

  /**
   * Increment latest unconfirmed index.
   * @private
   * @param {Batch} b
   * @param {Number} count
   */

  incrementLatestUnconfirmedTXCount(b, count) {
    assert(count + 1 <= 0xffffffff, 'Number exceeds 32-bits.');
    b.put(layout.Ol.encode(), fromU32(count + 1));
  }

  /**
   * Get the count of a transaction.
   * @param {Hash} hash - Transaction hash.
   * @returns {Promise<TXCount?>}
   */

  async getCountForTX(hash) {
    assert(Buffer.isBuffer(hash));

    const raw = await this.bucket.get(layout.Oc.encode(hash));

    if (!raw)
      return null;

    return TXCount.decode(raw);
  }

  /**
   * Get the undo count of a transaction.
   * @param {Hash} hash - Transaction hash.
   * @returns {Promise<TXCount?>}
   */

  async getUndoCountForTX(hash) {
    assert(Buffer.isBuffer(hash));

    const raw = await this.bucket.get(layout.Ou.encode(hash));

    if (!raw)
      return null;

    return TXCount.decode(raw);
  }

  /**
   * Add undo unconfirmed time and unconfirmed index to restore unconfirmed
   * time during reorganizations.
   * @private
   * @param {Batch} b
   * @param {Hash} hash - Transaction hash.
   * @param {Number} time - Transaction time.
   * @returns {Promise}
   */

  async addCountAndTimeIndexUnconfirmedUndo(b, hash, time) {
    const count = await this.getLatestUnconfirmedTXCount();

    b.put(layout.Oe.encode(hash), fromU32(time));
    b.put(layout.Ou.encode(hash), count.encode());

    this.incrementLatestUnconfirmedTXCount(b, count.index);
  }

  /**
   * Add unconfirmed time indexing to support querying
   * unconfirmed transaction history in subsets by time.
   * @private
   * @param {Hash} hash - Transaction hash.
   * @returns {Promise<Number>}
   */

  async getUnconfirmedTimeForTX(hash) {
    const raw = await this.bucket.get(layout.Oe.encode(hash));

    if (!raw)
      throw new Error('Unconfirmed time not found.');

    return raw.readUInt32LE(0, true);
  }

  /**
   * Add count and time based indexing to support querying
   * unconfirmed transaction history in subsets by time
   * and by count.
   * This is called when we see a new transaction that is
   * unconfirmed. insert() w/o block.
   * @private
   * @param {Batch} b
   * @param {Map<Number, Balance>} accounts
   * @param {Hash} hash - Transaction hash.
   * @param {Number} time - Transaction time.
   * @returns {Promise}
   */

  async addCountAndTimeIndexUnconfirmed(b, accounts, hash, time) {
    const count = await this.getLatestUnconfirmedTXCount();

    b.put(layout.Ot.encode(count.height, count.index), hash);
    b.put(layout.Oc.encode(hash), count.encode());

    b.put(layout.Oe.encode(hash), fromU32(time));
    b.put(layout.Om.encode(time, count.index, hash), null);

    for (const [acct] of accounts) {
      b.put(layout.OT.encode(acct, count.height, count.index), hash);
      b.put(layout.OM.encode(acct, time, count.index, hash), null);
    }

    this.incrementLatestUnconfirmedTXCount(b, count.index);
  }

  /**
   * Remove unconfirmed count and time based indexing. This will
   * however leave some of the information around so that it's
   * possible to restore the index should it be necessary during a
   * reorg. This will remove indexing into the subsets of confirmed
   * results, it will keep the count in the database that can be
   * queried by hash, should there be a reorg and the transaction
   * becomes pending again.
   * @private
   * @param {Batch} b
   * @param {Map<Number, Balance>} accounts
   * @param {Hash} hash - Transaction hash.
   */

  async disconnectCountAndTimeIndexUnconfirmed(b, accounts, hash) {
    const count = await this.getCountForTX(hash);

    if (!count)
      throw new Error('Transaction count not found.');

    if (count.height !== UNCONFIRMED_HEIGHT)
      throw new Error('Transaction is confirmed.');

    // Add undo information to later restore the
    // unconfirmed count, and remove the count.
    b.put(layout.Ou.encode(hash), count.encode());

    const {height, index} = count;
    b.del(layout.Ot.encode(height, index));
    b.del(layout.Oc.encode(hash));

    const time = await this.getUnconfirmedTimeForTX(hash);
    b.del(layout.Om.encode(time, index, hash));

    for (const [acct] of accounts) {
      b.del(layout.OT.encode(acct, height, index));
      b.del(layout.OM.encode(acct, time, index, hash));
    }
  }

  /**
   * This will restore the count and time indexing for
   * unconfirmed transactions during reorganizations. This is
   * possible because we leave the pre-existing count in
   * the database.
   * @private
   * @param {Batch} b
   * @param {Map<Number, Balance>} accounts
   * @param {Hash} hash - Transaction hash.
   */

  async restoreCountAndTimeIndexUnconfirmed(b, accounts, hash) {
    const count = await this.getUndoCountForTX(hash);

    if (!count)
      throw new Error('Transaction count not found.');

    b.put(layout.Oc.encode(hash), count.encode());
    b.put(layout.Ot.encode(count.height, count.index), hash);

    // We no longer need undo count as it becomes the count.
    b.del(layout.Ou.encode(hash));

    const time = await this.getUnconfirmedTimeForTX(hash);
    b.put(layout.Om.encode(time, count.index, hash), null);

    for (const [acct] of accounts) {
      b.put(layout.OT.encode(acct, count.height, count.index), hash);
      b.put(layout.OM.encode(acct, time, count.index, hash), null);
    }
  }

  /**
   * Remove all unconfirmed count and time based indexing.
   * @private
   * @param {Batch} b
   * @param {Map<Number, Balance>} accounts
   * @param {Hash} hash - Transaction hash.
   * @returns {Promise}
   */

  async removeCountAndTimeIndexUnconfirmed(b, accounts, hash) {
    const count = await this.getCountForTX(hash);

    if (!count)
      throw new Error('Transaction count not found.');

    if (count.height !== UNCONFIRMED_HEIGHT)
      throw new Error('Transaction is confirmed.');

    b.del(layout.Ot.encode(count.height, count.index));
    b.del(layout.Oc.encode(hash));

    const time = await this.getUnconfirmedTimeForTX(hash);
    b.del(layout.Om.encode(time, count.index, hash));
    b.del(layout.Oe.encode(hash));

    for (const [acct] of accounts) {
      b.del(layout.OT.encode(acct, count.height, count.index));
      b.del(layout.OM.encode(acct, time, count.index, hash));
    }
  }

  /**
   * Add monotonic time and count based indexing to support
   * querying transaction history in subsets and by time.
   * @private
   * @param {Batch} b
   * @param {Object} options
   * @param {Map<Number, Balance>} options.accounts
   * @param {Hash} options.hash - Transaction hash.
   * @param {Number} options.height
   * @param {BlockExtraInfo} options.blockextra
   * @returns {Promise}
   */

  async addCountAndTimeIndex(b, options) {
    const {
      accounts,
      hash,
      height,
      blockextra
    } = options;

    const index = blockextra.txIndex;
    const count = new TXCount(height, index);

    b.put(layout.Ot.encode(height, index), hash);
    b.put(layout.Oc.encode(hash), count.encode());

    const time = blockextra.medianTime;
    b.put(layout.Oi.encode(time, height, index, hash), null);

    for (const [acct] of accounts) {
      b.put(layout.OT.encode(acct, height, index), hash);
      b.put(layout.OI.encode(acct, time, height, index, hash), null);
    }
  }

  /**
   * Remove monotonic time and count based indexing.
   * @private
   * @param {Batch} b
   * @param {Object} options
   * @param {Hash} options.hash - Transaction hash.
   * @param {Number} options.medianTime - Block median time.
   * @param {Map<Number, Balance>} options.accounts
   * @returns {Promise}
   */

  async removeCountAndTimeIndex(b, options) {
    const {
      accounts,
      hash,
      medianTime
    } = options;

    const count = await this.getCountForTX(hash);

    if (!count)
      throw new Error('Transaction count not found.');

    b.del(layout.Ot.encode(count.height, count.index));
    b.del(layout.Oc.encode(hash));

    const time = medianTime;
    b.del(layout.Oi.encode(time, count.height,
                          count.index, options.hash));

    for (const [acct] of accounts) {
      b.del(layout.OT.encode(acct, count.height, count.index));

      b.del(layout.OI.encode(acct, time, count.height,
                            count.index, options.hash));
    }
  }

  /**
   * Get all transactions in ascending or decending order
   * limited at a configurable max transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistory(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    assert(typeof options.limit === 'number');
    assert(typeof options.reverse === 'boolean');

    if (options.limit > this.maxTXs)
      throw new Error(`Limit exceeds max of ${this.maxTXs}.`);

    let hashes = [];

    if (acct !== -1) {
      hashes = await this.bucket.values({
        gte: layout.OT.min(acct),
        lte: layout.OT.max(acct),
        limit: options.limit,
        reverse: options.reverse
      });
    } else {
      hashes = await this.bucket.values({
        gte: layout.Ot.min(),
        lte: layout.Ot.max(),
        limit: options.limit,
        reverse: options.reverse
      });
    }

    return Promise.all(hashes.map(async (hash) => {
      return await this.getTX(hash);
    }));
  }

  /**
   * Get all transactions in ascending or decending
   * order from a time (inclusive) and limited at a
   * configurable max of transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Number} options.time
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistoryByTime(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    assert(typeof options.time === 'number');
    assert(typeof options.limit === 'number');
    assert(typeof options.reverse === 'boolean');

    if (options.limit > this.maxTXs)
      throw new Error(`Limit exceeds max of ${this.maxTXs}.`);

    let max = null;
    let min = null;
    let parse = null;

    if (acct !== -1) {
      if (options.reverse) {
        min = layout.OI.min();
        max = layout.OI.max(acct, options.time);
      } else {
        min = layout.OI.min(acct, options.time);
        max = layout.OI.max();
      }
      parse = (key) => {
        const [,,,,hash] = layout.OI.decode(key);
        return hash;
      };
    } else {
      if (options.reverse) {
        min = layout.Oi.min();
        max = layout.Oi.max(options.time);
      } else {
        min = layout.Oi.min(options.time);
        max = layout.Oi.max();
      }
      parse = (key) => {
        const [,,,hash] = layout.Oi.decode(key);
        return hash;
      };
    }

    const keys = await this.bucket.keys({
      gte: min,
      lte: max,
      limit: 1,
      reverse: options.reverse,
      parse: parse
    });

    const hash = keys.length > 0 ? keys[0] : null;

    if (!hash)
      return [];

    return this.listHistoryFrom(acct, {
      hash,
      limit: options.limit,
      reverse: options.reverse
    });
  }

  /**
   * Get all transactions in ascending or decending
   * order after a txid/hash (exclusive) and limited at a
   * configurable max of transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistoryAfter(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    return this._listHistory(acct, {
      hash: options.hash,
      limit: options.limit,
      reverse: options.reverse,
      inclusive: false
    });
  }

  /**
   * Get all transactions in ascending or decending
   * order after a txid/hash (inclusive) and limited at a
   * configurable max of transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistoryFrom(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    return this._listHistory(acct, {
      hash: options.hash,
      limit: options.limit,
      reverse: options.reverse,
      inclusive: true
    });
  }

  /**
   * Get all transactions in ascending or decending
   * order after or from a txid/hash, inclusive or exclusive
   * and limited at a configurable max of transactions.
   * @private
   * @param {Number} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @param {Boolean} options.inclusive
   * @returns {Promise<TXRecord[]>}
   */

  async _listHistory(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    assert(Buffer.isBuffer(options.hash));
    assert(typeof options.limit === 'number');
    assert(typeof options.reverse === 'boolean');
    assert(typeof options.inclusive === 'boolean');

    if (options.limit > this.maxTXs)
      throw new Error(`Limit exceeds max of ${this.maxTXs}.`);

    const count = await this.getCountForTX(options.hash);

    if (!count)
      throw new Error('Transaction not found.');

    const zopts = {
      limit: options.limit,
      reverse: options.reverse
    };

    const lesser = options.inclusive ? 'lte' : 'lt';
    const greater = options.inclusive ? 'gte' : 'gt';

    if (acct !== -1) {
      if (zopts.reverse) {
        zopts['gte'] = layout.OT.min(acct);
        zopts[lesser] = layout.OT.encode(acct, count.height, count.index);
      } else {
        zopts[greater] = layout.OT.encode(acct, count.height, count.index);
        zopts['lte'] = layout.OT.max(acct);
      }
    } else {
      if (zopts.reverse) {
        zopts['gte'] = layout.Ot.min();
        zopts[lesser] = layout.Ot.encode(count.height, count.index);
      } else {
        zopts[greater] = layout.Ot.encode(count.height, count.index);
        zopts['lte'] = layout.Ot.max();
      }
    }

    const hashes = await this.bucket.values(zopts);

    return Promise.all(hashes.map(async (hash) => {
      return await this.getTX(hash);
    }));
  }

  /**
   * Get all unconfirmed transactions in ascending or
   * decending order limited at a configurable
   * max transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmed(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    assert(typeof options.limit === 'number');
    assert(typeof options.reverse === 'boolean');

    if (options.limit > this.maxTXs)
      throw new Error(`Limit exceeds max of ${this.maxTXs}.`);

    const height = UNCONFIRMED_HEIGHT;

    let hashes = [];

    if (acct !== -1) {
      hashes = await this.bucket.values({
        gte: layout.OT.min(acct, height),
        lte: layout.OT.max(acct, height),
        limit: options.limit,
        reverse: options.reverse
      });
    } else {
      hashes = await this.bucket.values({
        gte: layout.Ot.min(height),
        lte: layout.Ot.max(height),
        limit: options.limit,
        reverse: options.reverse
      });
    }

    return Promise.all(hashes.map(async (hash) => {
      return await this.getTX(hash);
    }));
  }

  /**
   * Get all unconfirmed transactions in ascending or
   * decending order limited at a configurable
   * max transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Number} options.time
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmedByTime(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    assert(typeof options.time === 'number');
    assert(typeof options.limit === 'number');
    assert(typeof options.reverse === 'boolean');

    if (options.limit > this.maxTXs)
      throw new Error(`Limit exceeds max of ${this.maxTXs}.`);

    let max = null;
    let min = null;
    let parse = null;

    if (acct !== -1) {
      if (options.reverse) {
        min = layout.OM.min();
        max = layout.OM.max(acct, options.time);
      } else {
        min = layout.OM.min(acct, options.time);
        max = layout.OM.max();
      }
      parse = (key) => {
        const [,,,hash] = layout.OM.decode(key);
        return hash;
      };
    } else {
      if (options.reverse) {
        min = layout.Om.min();
        max = layout.Om.max(options.time);
      } else {
        min = layout.Om.min(options.time);
        max = layout.Om.max();
      }
      parse = (key) => {
        const [,,hash] = layout.Om.decode(key);
        return hash;
      };
    }

    const keys = await this.bucket.keys({
      gte: min,
      lte: max,
      limit: 1,
      reverse: options.reverse,
      parse: parse
    });

    const hash = keys.length > 0 ? keys[0] : null;

    if (!hash)
      return [];

    return this.listUnconfirmedFrom(acct, {
      hash,
      limit: options.limit,
      reverse: options.reverse
    });
  }

  /**
   * Get all unconfirmed transactions in ascending or
   * decending order after a txid/hash (exclusive) and limited
   * at a max of 100 transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmedAfter(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');

    return this._listUnconfirmed(acct, {
      hash: options.hash,
      limit: options.limit,
      reverse: options.reverse,
      inclusive: false
    });
  }

  /**
   * Get all unconfirmed transactions in ascending or
   * decending order after a txid/hash (inclusive) and limited
   * at a max of 100 transactions.
   * @param {Number} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmedFrom(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');

    return this._listUnconfirmed(acct, {
      hash: options.hash,
      limit: options.limit,
      reverse: options.reverse,
      inclusive: true
    });
  }

  /**
   * Get all unconfirmed transactions in ascending or
   * decending order after or from a txid/hash, inclusive or
   * exclusive and limited at a configurable max
   * of transactions
   * @private
   * @param {Number} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @param {Boolean} options.inclusive
   * @returns {Promise<TXRecord[]>}
   */

  async _listUnconfirmed(acct, options) {
    assert(typeof acct === 'number');
    assert(options && typeof options === 'object');
    assert(Buffer.isBuffer(options.hash));
    assert(typeof options.limit === 'number');
    assert(typeof options.reverse === 'boolean');
    assert(typeof options.inclusive === 'boolean');

    if (options.limit > this.maxTXs)
      throw new Error(`Limit exceeds max of ${this.maxTXs}.`);

    const count = await this.getCountForTX(options.hash);

    if (!count)
      throw new Error('Transaction not found.');

    if (count.height !== UNCONFIRMED_HEIGHT)
      throw new Error('Transaction is confirmed.');

    const {height, index} = count;

    const uopts = {
      limit: options.limit,
      reverse: options.reverse
    };

    const lesser = options.inclusive ? 'lte' : 'lt';
    const greater = options.inclusive ? 'gte' : 'gt';

    if (acct !== -1) {
      if (uopts.reverse) {
        uopts['gte'] = layout.OT.min(acct, height);
        uopts[lesser] = layout.OT.encode(acct, height, index);
      } else {
        uopts[greater] = layout.OT.encode(acct, height, index);
        uopts['lte'] = layout.OT.max(acct, height);
      }
    } else {
      if (uopts.reverse) {
        uopts['gte'] = layout.Ot.min(height);
        uopts[lesser] = layout.Ot.encode(height, index);
      } else {
        uopts[greater] = layout.Ot.encode(height, index);
        uopts['lte'] = layout.Ot.max(height);
      }
    }

    const hashes = await this.bucket.values(uopts);

    return Promise.all(hashes.map(async (hash) => {
      return await this.getTX(hash);
    }));
  }

  /**
   * Remove spenders that have not been confirmed. We do this in the
   * odd case of stuck transactions or when a coin is double-spent
   * by a newer transaction. All previously-spending transactions
   * of that coin that are _not_ confirmed will be removed from
   * the database.
   * @private
   * @param {TXRecord} wtx
   * @returns {Promise<Details?>}
   */

  async removeConflict(wtx) {
    const tx = wtx.tx;

    this.logger.warning('Handling conflicting tx: %x.', tx.hash());

    const details = await this.removeRecursive(wtx);

    if (!details)
      return null;

    this.logger.warning('Removed conflict: %x.', tx.hash());

    // Emit the _removed_ transaction.
    this.emit('conflict', tx, details);

    return details;
  }

  /**
   * Retrieve coins for own inputs, remove
   * double spenders, and verify inputs.
   * @private
   * @param {TX} tx
   * @param {Boolean} conf
   * @returns {Promise<Boolean>}
   */

  async removeConflicts(tx, conf) {
    if (tx.isCoinbase())
      return true;

    const txid = tx.hash();
    const spends = [];

    // Gather all spent records first.
    for (const {prevout} of tx.inputs) {
      const {hash, index} = prevout;

      // Is it already spent?
      const spent = await this.getSpent(hash, index);

      if (!spent)
        continue;

      // Did _we_ spend it?
      if (spent.hash.equals(txid))
        continue;

      const spender = await this.getTX(spent.hash);
      assert(spender);

      if (conf && spender.height !== -1)
        return false;

      spends.push(spender);
    }

    // Once we know we're not going to
    // screw things up, remove the double
    // spenders.
    for (const spender of spends) {
      // Remove the double spender.
      await this.removeConflict(spender);
    }

    return true;
  }

  /**
   * Lock balances according to covenant.
   * Inserting or confirming: TX outputs.
   * Removing or undoing: Coins spent by the wallet in tx inputs.
   * @param {BalanceDelta} state
   * @param {Credit} credit
   * @param {Path} path
   * @param {Number} height
   */

  lockBalances(state, credit, path, height) {
    const {value, covenant} = credit.coin;

    switch (covenant.type) {
      case types.CLAIM:    // output is locked until REGISTER
      case types.BID:      // output is locked until REVEAL
      case types.REVEAL:   // output is locked until REDEEM
      case types.REGISTER: // output is now locked or "burned"
      case types.UPDATE:   // output has been locked since REGISTER
      case types.RENEW:
      case types.TRANSFER:
      case types.FINALIZE:
      case types.REVOKE:
      {
        if (height === -1)
          state.ulocked(path, value);
        else
          state.clocked(path, value);
        break;
      }

      case types.REDEEM:   // noop: already unlocked by the BID in the input
        break;
    }
  }

  /**
   * Unlock balances according to covenants.
   * Inserting or confirming: Coins spent by the wallet in TX inputs.
   * Removing or undoing: TX outputs.
   * @param {BalanceDelta} state
   * @param {Credit} credit
   * @param {Path} path
   * @param {Number} height
   */

  unlockBalances(state, credit, path, height) {
    const {value, covenant} = credit.coin;

    switch (covenant.type) {
      case types.CLAIM:    // output is locked until REGISTER
      case types.BID:      // output is locked until REVEAL
      case types.REVEAL:   // output is locked until REDEEM
      case types.REGISTER: // output is now locked or "burned"
      case types.UPDATE:   // output has been locked since REGISTER
      case types.RENEW:
      case types.TRANSFER:
      case types.FINALIZE:
      case types.REVOKE:
      {
        if (height === -1)
          state.ulocked(path, -value);
        else
          state.clocked(path, -value);
        break;
      }
      case types.REDEEM:   // noop: already unlocked by the BID in the input
        break;
    }
  }

  /**
   * Start tracking OPENs right away.
   * This does not check if the name is owned by the wallet.
   * @private
   * @param {Batch} b
   * @param {Output} output
   * @returns {Promise}
   */

  async watchOpensEarly(b, output) {
    const {covenant} = output;

    if (!covenant.isOpen())
      return;

    const nameHash = covenant.getHash(0);

    if (!await this.wdb.hasNameMap(nameHash, this.wid))
      await this.addNameMap(b, nameHash);
  }

  /**
   * Handle incoming covenant.
   * @param {Object} b
   * @param {TX} tx
   * @param {CoinView} view
   * @param {Number} height
   * @returns {Promise<Boolean>} updated
   */

  async connectNames(b, tx, view, height) {
    const hash = tx.hash();
    const network = this.wdb.network;

    assert(height !== -1);

    // If namestate has been updated we need to write to DB
    let updated = false;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (!covenant.isName())
        continue;

      const path = await this.getPath(output);
      const nameHash = covenant.getHash(0);
      const outpoint = tx.outpoint(i);
      const ns = await view.getNameState(this, nameHash);

      if (!ns.isNull())
        ns.maybeExpire(height, network);

      switch (covenant.type) {
        case types.CLAIM: {
          if (!path)
            break;

          const name = covenant.get(2);
          const flags = covenant.getU8(3);
          const claimed = covenant.getU32(5);

          if (ns.isNull()) {
            await this.addNameMap(b, nameHash);
            ns.set(name, height);
          }

          ns.setHeight(height);
          ns.setRenewal(height);
          ns.setClaimed(claimed);
          ns.setValue(0);
          ns.setOwner(outpoint);
          ns.setHighest(0);
          ns.setWeak((flags & 1) !== 0);

          updated = true;

          break;
        }

        case types.OPEN: {
          if (!path) {
            // Are we "watching" this name?
            if (!await this.wdb.hasNameMap(nameHash, this.wid))
              break;

            const name = covenant.get(2);
            ns.set(name, height);
            updated = true;
            break;
          }

          if (ns.isNull()) {
            const name = covenant.get(2);

            await this.addNameMap(b, nameHash);

            ns.set(name, height);

            updated = true;
          }

          break;
        }

        case types.BID: {
          const start = covenant.getU32(1);
          const name = covenant.get(2);
          const blind = covenant.getHash(3);
          const lockup = output.value;

          if (!path) {
            if (ns.isNull())
              break;

            this.putBid(b, nameHash, outpoint, {
              name,
              lockup,
              blind,
              height,
              own: false
            });

            updated = true;

            break;
          }

          if (ns.isNull())
            await this.addNameMap(b, nameHash);

          ns.set(name, start);

          this.putBid(b, nameHash, outpoint, {
            name,
            lockup,
            blind,
            height,
            own: true
          });

          updated = true;

          break;
        }

        case types.REVEAL: {
          if (ns.isNull())
            break;

          if (ns.owner.isNull() || output.value > ns.highest) {
            ns.setValue(ns.highest);
            ns.setOwner(outpoint);
            ns.setHighest(output.value);
          } else if (output.value > ns.value) {
            ns.setValue(output.value);
          }

          const {prevout} = tx.inputs[i];

          if (!path) {
            this.putReveal(b, nameHash, outpoint, {
              name: ns.name,
              value: output.value,
              height: height,
              own: false,
              bidPrevout: prevout
            });
            updated = true;
            break;
          }

          const coin = view.getOutput(prevout);

          if (coin) {
            const uc = coin.covenant;
            const blind = uc.getHash(3);
            const nonce = covenant.getHash(2);

            this.putBlind(b, blind, {
              value: output.value,
              nonce: nonce
            });
          }

          this.putReveal(b, nameHash, outpoint, {
            name: ns.name,
            value: output.value,
            height: height,
            own: true,
            bidPrevout: prevout
          });

          updated = true;

          break;
        }

        case types.REDEEM: {
          break;
        }

        case types.REGISTER: {
          if (ns.isNull())
            break;

          const data = covenant.get(2);

          ns.setRegistered(true);
          ns.setOwner(outpoint);

          if (data.length > 0)
            ns.setData(data);

          ns.setRenewal(height);

          updated = true;

          break;
        }

        case types.UPDATE: {
          if (ns.isNull())
            break;

          const data = covenant.get(2);

          ns.setOwner(outpoint);

          if (data.length > 0)
            ns.setData(data);

          ns.setTransfer(0);

          updated = true;

          break;
        }

        case types.RENEW: {
          if (ns.isNull())
            break;

          ns.setOwner(outpoint);
          ns.setTransfer(0);
          ns.setRenewal(height);
          ns.setRenewals(ns.renewals + 1);

          updated = true;

          break;
        }

        case types.TRANSFER: {
          if (ns.isNull())
            break;

          ns.setOwner(outpoint);

          assert(ns.transfer === 0);
          ns.setTransfer(height);

          updated = true;

          break;
        }

        case types.FINALIZE: {
          if (ns.isNull()) {
            if (!path)
              break;

            await this.addNameMap(b, nameHash);

            const start = covenant.getU32(1);
            const name = covenant.get(2);
            const flags = covenant.getU8(3);
            const weak = (flags & 1) !== 0;
            const claimed = covenant.getU32(4);
            const renewals = covenant.getU32(5);

            ns.set(name, start);
            ns.setRegistered(true);
            ns.setValue(output.value);
            ns.setWeak(weak);
            ns.setClaimed(claimed);
            ns.setRenewals(renewals);

            // Cannot get data or highest.
            ns.setHighest(output.value);
          } else {
            assert(ns.transfer !== 0);
            ns.setTransfer(0);
          }

          ns.setOwner(tx.outpoint(i));
          ns.setRenewal(height);
          ns.setRenewals(ns.renewals + 1);

          updated = true;

          break;
        }

        case types.REVOKE: {
          if (ns.isNull())
            break;

          assert(ns.revoked === 0);
          ns.setRevoked(height);
          ns.setTransfer(0);
          ns.setData(null);

          updated = true;

          break;
        }
      }
    }

    for (const ns of view.names.values()) {
      const {nameHash} = ns;

      if (ns.isNull()) {
        b.del(layout.A.encode(nameHash));
        continue;
      }

      b.put(layout.A.encode(nameHash), ns.encode());
    }

    if (updated) {
      const undo = view.toNameUndo();

      // Always write the undo record as it
      // serves as a marker to determine whether
      // we have a processed a transaction's
      // covenants before. This function is
      // probably better served by its own
      // special record, but that would require
      // a data migration.
      b.put(layout.U.encode(hash), undo.encode());
    }

    return updated;
  }

  /**
   * Handle reorg'd covenant.
   * @param {Object} b
   * @param {TX} tx
   * @returns {Promise<Boolean>} applied undo.
   */

  async undoNameState(b, tx) {
    const hash = tx.hash();

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (!covenant.isName())
        continue;

      switch (covenant.type) {
        case types.BID: {
          const nameHash = covenant.getHash(0);
          this.removeBid(b, nameHash, tx.outpoint(i));
          break;
        }
        case types.REVEAL: {
          const input = tx.inputs[i];
          const nameHash = covenant.getHash(0);
          this.removeReveal(b, nameHash, tx.outpoint(i), input.prevout);
          break;
        }
      }
    }

    return this.applyNameUndo(b, hash);
  }

  /**
   * Apply namestate undo data by hash without transaction.
   * Should only be called directly to undo namestate transitions
   * that do not affect wallet balance like a TRANSFER for a name
   * that is in the nameMap but does not involve wallet addresses.
   * @param {Object} b
   * @param {Hash} hash
   * @returns {Promise<Boolean>} - applied undo.
   */

  async applyNameUndo(b, hash) {
    const raw = await this.bucket.get(layout.U.encode(hash));

    if (!raw)
      return false;

    const undo = NameUndo.decode(raw);
    const view = new CoinView();

    for (const [nameHash, delta] of undo.names) {
      const ns = await view.getNameState(this, nameHash);

      ns.applyState(delta);

      if (ns.isNull()) {
        // Even though we are removing the namestate from the database,
        // we are going to keep the name in the wallet's "watch list"
        // by NOT calling removeNameMap(). This will preserve names
        // added by rpc importname. The side effect will be potential db bloat,
        // but only in the edge case where an auction we are interested in
        // is re-org'ed completely out of existence. In that case,
        // we will still track the name even though the OPEN has vanished.
        b.del(layout.A.encode(nameHash));
      } else {
        b.put(layout.A.encode(nameHash), ns.encode());
      }
    }

    b.del(layout.U.encode(hash));

    return true;
  }

  /**
   * Recalculate wallet balances.
   * @returns {Promise}
   */

  async recalculateBalances() {
    const state = new BalanceDelta();

    const creditIter = this.bucket.iterator({
      gte: layout.c.min(),
      lte: layout.c.max(),
      values: true
    });

    await creditIter.each(async (key, raw) => {
      const credit = Credit.decode(raw);
      const coin = credit.coin;
      const value = coin.value;
      const path = await this.getPath(coin);

      assert(path);

      state.coin(path, 1);
      state.unconfirmed(path, value);
      this.lockBalances(state, credit, path, -1);

      // Unconfirmed coins
      if (coin.height !== -1) {
        state.confirmed(path, value);
        this.lockBalances(state, credit, path, coin.height);
      }

      if (credit.spent) {
        state.coin(path, -1);
        state.unconfirmed(path, -value);
        this.unlockBalances(state, credit, path, -1);
      }
    });

    const batch = this.bucket.batch();

    for (const [acct, delta] of state.accounts) {
      const oldAccountBalance = await this.getAccountBalance(acct);
      const finalAcctBalance = new Balance();
      finalAcctBalance.tx = oldAccountBalance.tx;

      delta.applyTo(finalAcctBalance);
      batch.put(layout.r.encode(acct), finalAcctBalance.encode());
    }

    const walletBalance = await this.getWalletBalance();
    const finalWalletBalance = new Balance();
    finalWalletBalance.tx = walletBalance.tx;
    state.applyTo(finalWalletBalance);
    batch.put(layout.R.encode(), finalWalletBalance.encode());

    await batch.write();
  }

  /**
   * Lock all coins in a transaction.
   * @param {TX} tx
   */

  lockTX(tx) {
    if (tx.isCoinbase())
      return;

    for (const input of tx.inputs)
      this.lockCoin(input.prevout);
  }

  /**
   * Unlock all coins in a transaction.
   * @param {TX} tx
   */

  unlockTX(tx) {
    if (tx.isCoinbase())
      return;

    for (const input of tx.inputs)
      this.unlockCoin(input.prevout);
  }

  /**
   * Lock a single coin.
   * @param {Coin|Outpoint} coin
   */

  lockCoin(coin) {
    const key = coin.toKey();
    this.locked.add(key);
  }

  /**
   * Unlock a single coin.
   * @param {Coin|Outpoint} coin
   * @returns {Boolean} - whether the coin was locked.
   */

  unlockCoin(coin) {
    const key = coin.toKey();
    return this.locked.delete(key);
  }

  /**
   * Unlock all locked coins.
   */

  unlockCoins() {
    for (const coin of this.getLocked())
      this.unlockCoin(coin);
  }

  /**
   * Test locked status of a single coin.
   * @param {Coin|Outpoint} coin
   * @returns {Boolean}
   */

  isLocked(coin) {
    const key = coin.toKey();
    return this.locked.has(key);
  }

  /**
   * Filter array of coins or outpoints
   * for only unlocked ones.
   * jsdoc can't express this type.
   * @param {Coin[]|Outpoint[]} coins
   * @returns {Coin[]|Outpoint[]}
   */

  filterLocked(coins) {
    const out = [];

    for (const coin of coins) {
      if (!this.isLocked(coin))
        out.push(coin);
    }

    return out;
  }

  /**
   * Return an array of all locked outpoints.
   * @returns {Outpoint[]}
   */

  getLocked() {
    const outpoints = [];

    for (const key of this.locked.keys())
      outpoints.push(Outpoint.fromKey(key));

    return outpoints;
  }

  /**
   * Test whether an account owns a coin.
   * @param {Number} acct
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Boolean>}
   */

  hasCoinByAccount(acct, hash, index) {
    assert(typeof acct === 'number');

    return this.bucket.has(layout.C.encode(acct, hash, index));
  }

  /**
   * Get hashes of all unconfirmed transactions in the database.
   * @param {Number} acct
   * @returns {Promise<Hash[]>}
   */

  getAccountPendingHashes(acct) {
    assert(typeof acct === 'number');
    return this.bucket.keys({
      gte: layout.P.min(acct),
      lte: layout.P.max(acct),
      parse: (key) => {
        const [, hash] = layout.P.decode(key);
        return hash;
      }
    });
  }

  /**
   * Get hashes of all unconfirmed transactions in the database.
   * @param {Number} acct
   * @returns {Promise<Hash[]>}
   */

  getPendingHashes(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1)
      return this.getAccountPendingHashes(acct);

    return this.bucket.keys({
      gte: layout.p.min(),
      lte: layout.p.max(),
      parse: key => layout.p.decode(key)[0]
    });
  }

  /**
   * Test whether the database has a pending transaction.
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  async hasPending(hash) {
    return this.bucket.has(layout.p.encode(hash));
  }

  /**
   * Get all coin hashes in the database.
   * @param {Number} acct
   * @returns {Promise<Outpoint[]>}
   */

  getAccountOutpoints(acct) {
    assert(typeof acct === 'number');
    return this.bucket.keys({
      gte: layout.C.min(acct),
      lte: layout.C.max(acct),
      parse: (key) => {
        const [, hash, index] = layout.C.decode(key);
        return new Outpoint(hash, index);
      }
    });
  }

  /**
   * Get all coin hashes in the database.
   * @param {Number} acct
   * @returns {Promise<Outpoint[]>}
   */

  getOutpoints(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1)
      return this.getAccountOutpoints(acct);

    return this.bucket.keys({
      gte: layout.c.min(),
      lte: layout.c.max(),
      parse: (key) => {
        const [hash, index] = layout.c.decode(key);
        return new Outpoint(hash, index);
      }
    });
  }

  /**
   * Get TX hashes by height range.
   * @param {Number} acct
   * @param {Object} options
   * @param {Number} options.start - Start height.
   * @param {Number} options.end - End height.
   * @param {Number?} options.limit - Max number of records.
   * @param {Boolean?} options.reverse - Reverse order.
   * @returns {Promise<Hash[]>}
   */

  getAccountHeightRangeHashes(acct, options) {
    assert(typeof acct === 'number');

    const start = options.start || 0;
    const end = options.end || 0xffffffff;

    return this.bucket.keys({
      gte: layout.H.min(acct, start),
      lte: layout.H.max(acct, end),
      limit: options.limit,
      reverse: options.reverse,
      parse: (key) => {
        const [,, hash] = layout.H.decode(key);
        return hash;
      }
    });
  }

  /**
   * Get TX hashes by height range.
   * @param {Number} acct
   * @param {Object} options
   * @param {Number} options.start - Start height.
   * @param {Number} options.end - End height.
   * @param {Number?} options.limit - Max number of records.
   * @param {Boolean?} options.reverse - Reverse order.
   * @returns {Promise<Hash[]>}
   */

  getHeightRangeHashes(acct, options) {
    assert(typeof acct === 'number');

    if (acct !== -1)
      return this.getAccountHeightRangeHashes(acct, options);

    const start = options.start || 0;
    const end = options.end || 0xffffffff;

    return this.bucket.keys({
      gte: layout.h.min(start),
      lte: layout.h.max(end),
      limit: options.limit,
      reverse: options.reverse,
      parse: (key) => {
        const [, hash] = layout.h.decode(key);
        return hash;
      }
    });
  }

  /**
   * Get unconfirmed transactions.
   * @param {Number} acct
   * @returns {Promise<TXRecord[]>}
   */

  async getPending(acct) {
    const hashes = await this.getPendingHashes(acct);
    const txs = [];

    for (const hash of hashes) {
      const tx = await this.getTX(hash);
      assert(tx);
      txs.push(tx);
    }

    return txs;
  }

  /**
   * Get coins.
   * @param {Number} acct
   * @returns {Promise<Credit[]>}
   */

  getCredits(acct) {
    assert(typeof acct === 'number');

    // Slow case
    if (acct !== -1)
      return this.getAccountCredits(acct);

    // Fast case
    return this.bucket.range({
      gte: layout.c.min(),
      lte: layout.c.max(),
      parse: (key, value) => {
        const [hash, index] = layout.c.decode(key);
        const credit = Credit.decode(value);
        credit.coin.hash = hash;
        credit.coin.index = index;
        return credit;
      }
    });
  }

  /**
   * Get coins by account.
   * @param {Number} acct
   * @returns {Promise<Credit[]>}
   */

  async getAccountCredits(acct) {
    const outpoints = await this.getOutpoints(acct);
    const credits = [];

    for (const {hash, index} of outpoints) {
      const credit = await this.getCredit(hash, index);
      assert(credit);
      credits.push(credit);
    }

    return credits;
  }

  /**
   * Fill a transaction with coins (all historical coins).
   * @param {TX} tx
   * @returns {Promise<Array<Credit|null>>}
   */

  async getSpentCredits(tx) {
    if (tx.isCoinbase())
      return [];

    const hash = tx.hash();
    const credits = [];

    for (let i = 0; i < tx.inputs.length; i++)
      credits.push(null);

    await this.bucket.range({
      gte: layout.d.min(hash),
      lte: layout.d.max(hash),
      parse: (key, value) => {
        const [, index] = layout.d.decode(key);
        const coin = Coin.decode(value);
        const input = tx.inputs[index];
        assert(input);
        coin.hash = input.prevout.hash;
        coin.index = input.prevout.index;
        credits[index] = new Credit(coin);
      }
    });

    return credits;
  }

  /**
   * Get coins.
   * @param {Number} acct
   * @returns {Promise<Coin[]>}
   */

  async getCoins(acct) {
    const credits = await this.getCredits(acct);
    const coins = [];

    for (const credit of credits) {
      if (credit.spent)
        continue;

      coins.push(credit.coin);
    }

    return coins;
  }

  /**
   * Get coins by account.
   * @param {Number} acct
   * @returns {Promise<Coin[]>}
   */

  async getAccountCoins(acct) {
    const credits = await this.getAccountCredits(acct);
    const coins = [];

    for (const credit of credits) {
      if (credit.spent)
        continue;

      coins.push(credit.coin);
    }

    return coins;
  }

  /**
   * Get historical coins for a transaction.
   * @param {TX} tx
   * @returns {Promise<Coin[]>}
   */

  async getSpentCoins(tx) {
    if (tx.isCoinbase())
      return [];

    const credits = await this.getSpentCredits(tx);
    const coins = [];

    for (const credit of credits) {
      if (!credit) {
        coins.push(null);
        continue;
      }

      coins.push(credit.coin);
    }

    return coins;
  }

  /**
   * Get a coin viewpoint.
   * @param {TX} tx
   * @returns {Promise<CoinView>}
   */

  async getCoinView(tx) {
    const view = new CoinView();

    if (tx.isCoinbase())
      return view;

    for (const {prevout} of tx.inputs) {
      const {hash, index} = prevout;
      const coin = await this.getCoin(hash, index);

      if (!coin)
        continue;

      view.addCoin(coin);
    }

    return view;
  }

  /**
   * Get historical coin viewpoint.
   * @param {TX} tx
   * @returns {Promise<CoinView>}
   */

  async getSpentView(tx) {
    const view = new CoinView();

    if (tx.isCoinbase())
      return view;

    const coins = await this.getSpentCoins(tx);

    for (const coin of coins) {
      if (!coin)
        continue;

      view.addCoin(coin);
    }

    return view;
  }

  /**
   * Get transaction.
   * @param {Hash} hash
   * @returns {Promise<TXRecord?>}
   */

  async getTX(hash) {
    const raw = await this.bucket.get(layout.t.encode(hash));

    if (!raw)
      return null;

    return TXRecord.decode(raw);
  }

  /**
   * Get transaction details.
   * @param {Hash} hash
   * @returns {Promise<Details?>}
   */

  async getDetails(hash) {
    const wtx = await this.getTX(hash);

    if (!wtx)
      return null;

    return this.toDetails(wtx);
  }

  /**
   * Convert transaction to transaction details.
   * @param {TXRecord[]|TXRecord} wtxs
   * @returns {Promise<Details[]|Details>}
   */

  async toDetails(wtxs) {
    const out = [];

    if (!Array.isArray(wtxs))
      return this._toDetails(wtxs);

    for (const wtx of wtxs) {
      const details = await this._toDetails(wtx);

      if (!details)
        continue;

      out.push(details);
    }

    return out;
  }

  /**
   * Convert transaction to transaction details.
   * @private
   * @param {TXRecord} wtx
   * @returns {Promise<Details>}
   */

  async _toDetails(wtx) {
    const tx = wtx.tx;
    const block = wtx.getBlock();
    const details = new Details(wtx, block);
    const coins = await this.getSpentCoins(tx);

    for (let i = 0; i < tx.inputs.length; i++) {
      const coin = coins[i];

      let path = null;

      if (coin)
        path = await this.getPath(coin);

      details.setInput(i, path, coin);
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const path = await this.getPath(output);
      details.setOutput(i, path);
    }

    return details;
  }

  /**
   * Test whether the database has a transaction.
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  hasTX(hash) {
    return this.bucket.has(layout.t.encode(hash));
  }

  /**
   * Get coin.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Coin?>}
   */

  async getCoin(hash, index) {
    const credit = await this.getCredit(hash, index);

    if (!credit)
      return null;

    return credit.coin;
  }

  /**
   * Get credit.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Credit?>}
   */

  async getCredit(hash, index) {
    const data = await this.bucket.get(layout.c.encode(hash, index));

    if (!data)
      return null;

    const credit = Credit.decode(data);
    credit.coin.hash = hash;
    credit.coin.index = index;

    return credit;
  }

  /**
   * Get spender coin.
   * @param {Outpoint} spent
   * @param {Outpoint} prevout
   * @returns {Promise<Coin?>}
   */

  async getSpentCoin(spent, prevout) {
    const key = layout.d.encode(spent.hash, spent.index);
    const data = await this.bucket.get(key);

    if (!data)
      return null;

    const coin = Coin.decode(data);
    coin.hash = prevout.hash;
    coin.index = prevout.index;

    return coin;
  }

  /**
   * Test whether the database has a spent coin.
   * @param {Outpoint} spent
   * @returns {Promise<Boolean>}
   */

  hasSpentCoin(spent) {
    return this.bucket.has(layout.d.encode(spent.hash, spent.index));
  }

  /**
   * Update spent coin height in storage.
   * @param {Batch} b
   * @param {TX} tx - Sending transaction.
   * @param {Number} index
   * @param {Number} height
   * @returns {Promise}
   */

  async updateSpentCoin(b, tx, index, height) {
    const prevout = Outpoint.fromTX(tx, index);
    const spent = await this.getSpent(prevout.hash, prevout.index);

    if (!spent)
      return;

    const coin = await this.getSpentCoin(spent, prevout);

    if (!coin)
      return;

    coin.height = height;

    b.put(layout.d.encode(spent.hash, spent.index), coin.encode());
  }

  /**
   * Test whether the database has a transaction.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Boolean>}
   */

  async hasCoin(hash, index) {
    return this.bucket.has(layout.c.encode(hash, index));
  }

  /**
   * Calculate balance.
   * @param {Number} acct
   * @returns {Promise<Balance>}
   */

  async getBalance(acct) {
    assert(typeof acct === 'number');

    if (acct !== -1)
      return this.getAccountBalance(acct);

    return this.getWalletBalance();
  }

  /**
   * Calculate balance.
   * @returns {Promise<Balance>}
   */

  async getWalletBalance() {
    const data = await this.bucket.get(layout.R.encode());

    if (!data)
      return new Balance();

    return Balance.decode(data);
  }

  /**
   * Calculate balance by account.
   * @param {Number} acct
   * @returns {Promise<Balance>}
   */

  async getAccountBalance(acct) {
    const data = await this.bucket.get(layout.r.encode(acct));

    if (!data)
      return new Balance(acct);

    const balance = Balance.decode(data);
    balance.account = acct;
    return balance;
  }

  /**
   * Zap pending transactions older than `age`.
   * @param {Number} acct
   * @param {Number} age - Age delta.
   * @returns {Promise<Number>} - zapped tx hashes.
   */

  async zap(acct, age) {
    assert((age >>> 0) === age);

    const now = this.nowFn();
    const options = {
      time: now - age,
      limit: Math.min(100, this.maxTXs),
      reverse: true
    };

    let txs = await this.listUnconfirmedByTime(acct, options);

    let zapped = 0;

    while (txs.length) {
      for (const wtx of txs) {
        this.logger.debug('Zapping TX: %h (%d)',
                          wtx.hash, this.wid);

        await this.remove(wtx.hash);

        zapped++;
      }

      txs = await this.listUnconfirmedByTime(acct, options);
    }

    return zapped;
  }

  /**
   * Abandon transaction.
   * @param {Hash} hash
   * @returns {Promise<Details>} - removed tx details.
   */

  async abandon(hash) {
    const result = await this.bucket.has(layout.p.encode(hash));

    if (!result)
      throw new Error('TX not eligible.');

    return this.remove(hash);
  }

  /**
   * Dump database (for debugging).
   * @returns {Promise<Object>}
   */

  async dump() {
    const iter = this.bucket.iterator({
      values: true
    });

    const records = Object.create(null);

    for await (const {key, value} of iter)
      records[key.toString('hex')] = value.toString('hex');

    return records;
  }
}

/**
 * Balance
 * @alias module:wallet.Balance
 */

class Balance extends bio.Struct {
  /**
   * Create a balance.
   * @constructor
   * @param {Number} acct
   */

  constructor(acct = -1) {
    super();

    assert(typeof acct === 'number');

    this.account = acct;
    this.tx = 0;
    this.coin = 0;
    this.unconfirmed = 0;
    this.confirmed = 0;
    this.ulocked = 0;
    this.clocked = 0;
  }

  /**
   * Apply delta.
   * @param {Balance} balance
   */

  applyTo(balance) {
    balance.tx += this.tx;
    balance.coin += this.coin;
    balance.unconfirmed += this.unconfirmed;
    balance.confirmed += this.confirmed;
    balance.ulocked += this.ulocked;
    balance.clocked += this.clocked;

    assert(balance.tx >= 0);
    assert(balance.coin >= 0);
    assert(balance.unconfirmed >= 0);
    assert(balance.confirmed >= 0);
    assert(balance.ulocked >= 0);
    assert(balance.clocked >= 0);
  }

  /**
   * Calculate size.
   * @returns {Number}
   */

  getSize() {
    return 48;
  }

  /**
   * Serialize balance.
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    bw.writeU64(this.tx);
    bw.writeU64(this.coin);
    bw.writeU64(this.unconfirmed);
    bw.writeU64(this.confirmed);
    bw.writeU64(this.ulocked);
    bw.writeU64(this.clocked);
    return bw;
  }

  /**
   * Inject properties from serialized data.
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    this.tx = br.readU64();
    this.coin = br.readU64();
    this.unconfirmed = br.readU64();
    this.confirmed = br.readU64();
    this.ulocked = br.readU64();
    this.clocked = br.readU64();
    return this;
  }

  /**
   * Convert balance to a more json-friendly object.
   * @param {Boolean} [minimal=false]
   * @returns {Object}
   */

  getJSON(minimal) {
    return {
      account: !minimal ? this.account : undefined,
      tx: this.tx,
      coin: this.coin,
      unconfirmed: this.unconfirmed,
      confirmed: this.confirmed,
      lockedUnconfirmed: this.ulocked,
      lockedConfirmed: this.clocked
    };
  }

  /**
   * Inspect balance.
   * @returns {String}
   */

  format() {
    return '<Balance'
      + ` tx=${this.tx}`
      + ` coin=${this.coin}`
      + ` unconfirmed=${Amount.coin(this.unconfirmed)}`
      + ` confirmed=${Amount.coin(this.confirmed)}`
      + ` lockedUnconfirmed=${Amount.coin(this.ulocked)}`
      + ` lockedConfirmed=${Amount.coin(this.clocked)}`
      + '>';
  }
}

/**
 * Balance Delta
 * @ignore
 */

class BalanceDelta {
  /**
   * Create a balance delta.
   * @constructor
   */

  constructor() {
    /** @type {Balance} */
    this.wallet = new Balance();

  /** @type {Map<Number, Balance>} */
    this.accounts = new Map();
  }

  updated() {
    return this.wallet.tx !== 0;
  }

  /**
   * @param {Balance} balance
   */

  applyTo(balance) {
    this.wallet.applyTo(balance);
  }

  get(path) {
    if (!this.accounts.has(path.account))
      this.accounts.set(path.account, new Balance());

    return this.accounts.get(path.account);
  }

  tx(path, value) {
    const account = this.get(path);
    account.tx = value;
    this.wallet.tx = value;
  }

  coin(path, value) {
    const account = this.get(path);
    account.coin += value;
    this.wallet.coin += value;
  }

  unconfirmed(path, value) {
    const account = this.get(path);
    account.unconfirmed += value;
    this.wallet.unconfirmed += value;
  }

  confirmed(path, value) {
    const account = this.get(path);
    account.confirmed += value;
    this.wallet.confirmed += value;
  }

  ulocked(path, value) {
    const account = this.get(path);
    account.ulocked += value;
    this.wallet.ulocked += value;
  }

  clocked(path, value) {
    const account = this.get(path);
    account.clocked += value;
    this.wallet.clocked += value;
  }
}

/**
 * Credit (wrapped coin)
 * @alias module:wallet.Credit
 * @property {Coin} coin
 * @property {Boolean} spent
 */

class Credit extends bio.Struct {
  /**
   * Create a credit.
   * @constructor
   * @param {Coin?} [coin]
   * @param {Boolean?} [spent]
   */

  constructor(coin, spent) {
    super();
    this.coin = coin || new Coin();
    this.spent = spent || false;
    this.own = false;
  }

  /**
   * Inject properties from serialized data.
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    this.coin.read(br);
    this.spent = br.readU8() === 1;
    this.own = br.readU8() === 1;
    return this;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.coin.getSize() + 2;
  }

  /**
   * Serialize credit.
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    this.coin.write(bw);
    bw.writeU8(this.spent ? 1 : 0);
    bw.writeU8(this.own ? 1 : 0);
    return bw;
  }

  /**
   * Inject properties from tx object.
   * @private
   * @param {TX} tx
   * @param {Number} index
   * @param {Number} height
   * @returns {Credit}
   */

  fromTX(tx, index, height) {
    this.coin.fromTX(tx, index, height);
    this.spent = false;
    this.own = false;
    return this;
  }

  /**
   * Instantiate credit from transaction.
   * @param {TX} tx
   * @param {Number} index
   * @param {Number} height
   * @returns {Credit}
   */

  static fromTX(tx, index, height) {
    return new this().fromTX(tx, index, height);
  }
}

/**
 * Transaction Details
 * @alias module:wallet.Details
 */

class Details {
  /**
   * Create transaction details.
   * @constructor
   * @param {TXRecord} wtx
   * @param {BlockMeta} block
   */

  constructor(wtx, block) {
    this.hash = wtx.hash;
    this.tx = wtx.tx;
    this.mtime = wtx.mtime;
    this.size = this.tx.getSize();
    this.vsize = this.tx.getVirtualSize();

    this.block = null;
    this.height = -1;
    this.time = 0;

    if (block) {
      this.block = block.hash;
      this.height = block.height;
      this.time = block.time;
    }

    this.inputs = [];
    this.outputs = [];

    this.init();
  }

  /**
   * Initialize transaction details.
   * @private
   */

  init() {
    for (const input of this.tx.inputs) {
      const member = new DetailsMember();
      member.address = input.getAddress();
      this.inputs.push(member);
    }

    for (const output of this.tx.outputs) {
      const member = new DetailsMember();
      member.value = output.value;
      member.address = output.getAddress();
      member.covenant = output.covenant;
      this.outputs.push(member);
    }
  }

  /**
   * Add necessary info to input member.
   * @param {Number} i
   * @param {Path} path
   * @param {Coin} coin
   */

  setInput(i, path, coin) {
    const member = this.inputs[i];

    if (coin) {
      member.value = coin.value;
      member.address = coin.getAddress();
    }

    if (path)
      member.path = path;
  }

  /**
   * Add necessary info to output member.
   * @param {Number} i
   * @param {Path} path
   */

  setOutput(i, path) {
    const member = this.outputs[i];

    if (path)
      member.path = path;
  }

  /**
   * Calculate confirmations.
   * @param {Number} height
   * @returns {Number}
   */

  getDepth(height) {
    if (this.height === -1)
      return 0;

    if (height == null)
      return 0;

    const depth = height - this.height;

    if (depth < 0)
      return 0;

    return depth + 1;
  }

  /**
   * Calculate fee. Only works if wallet
   * owns all inputs. Returns 0 otherwise.
   * @returns {AmountValue}
   */

  getFee() {
    let inputValue = 0;
    let outputValue = 0;

    for (const input of this.inputs) {
      if (!input.path)
        return 0;

      inputValue += input.value;
    }

    for (const output of this.outputs)
      outputValue += output.value;

    return inputValue - outputValue;
  }

  /**
   * Calculate fee rate. Only works if wallet
   * owns all inputs. Returns 0 otherwise.
   * @param {AmountValue} fee
   * @returns {Rate}
   */

  getRate(fee) {
    return policy.getRate(this.vsize, fee);
  }

  /**
   * Convert details to a more json-friendly object.
   * @param {(Network|NetworkType)?} [network]
   * @param {Number} [height]
   * @returns {Object}
   */

  getJSON(network, height) {
    const fee = this.getFee();
    const rate = this.getRate(fee);

    return {
      hash: this.hash.toString('hex'),
      height: this.height,
      block: this.block ? this.block.toString('hex') : null,
      time: this.time,
      mtime: this.mtime,
      date: util.date(this.time),
      mdate: util.date(this.mtime),
      size: this.size,
      virtualSize: this.vsize,
      fee: fee,
      rate: rate,
      confirmations: this.getDepth(height),
      inputs: this.inputs.map((input) => {
        return input.getJSON(network);
      }),
      outputs: this.outputs.map((output) => {
        return output.getJSON(network);
      }),
      tx: this.tx.toHex()
    };
  }

  /**
   * Convert details to a more json-friendly object.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON();
  }
}

/**
 * Transaction Details Member
 * @property {Number} value
 * @property {Address} address
 * @property {Path} path
 */

class DetailsMember {
  /**
   * Create details member.
   * @constructor
   */

  constructor() {
    this.value = 0;
    this.address = null;
    this.covenant = null;
    this.path = null;
  }

  /**
   * Convert the member to a more json-friendly object.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON();
  }

  /**
   * Convert the member to a more json-friendly object.
   * @param {(Network|NetworkType)?} [network]
   * @returns {Object}
   */

  getJSON(network) {
    return {
      value: this.value,
      address: this.address
        ? this.address.toString(network)
        : null,
      covenant: this.covenant
        ? this.covenant.toJSON()
        : undefined,
      path: this.path
        ? this.path.toJSON()
        : null
    };
  }
}

/**
 * Block Record
 * @alias module:wallet.BlockRecord
 */

class BlockRecord extends bio.Struct {
  /**
   * Create a block record.
   * @constructor
   * @param {Hash} [hash]
   * @param {Number} [height]
   * @param {Number} [time]
   */

  constructor(hash, height, time) {
    super();
    this.hash = hash || consensus.ZERO_HASH;
    this.height = height != null ? height : -1;
    this.time = time || 0;
    this.hashes = new BufferSet();
  }

  /**
   * Add transaction to block record.
   * @param {Hash} hash
   * @returns {Boolean}
   */

  add(hash) {
    if (this.hashes.has(hash))
      return false;

    this.hashes.add(hash);

    return true;
  }

  /**
   * Remove transaction from block record.
   * @param {Hash} hash
   * @returns {Boolean}
   */

  remove(hash) {
    return this.hashes.delete(hash);
  }

  /**
   * Instantiate wallet block from serialized tip data.
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    this.hash = br.readHash();
    this.height = br.readU32();
    this.time = br.readU32();

    const count = br.readU32();

    for (let i = 0; i < count; i++) {
      const hash = br.readHash();
      this.hashes.add(hash);
    }

    return this;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 44 + this.hashes.size * 32;
  }

  /**
   * Serialize the wallet block as a tip (hash and height).
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    bw.writeHash(this.hash);
    bw.writeU32(this.height);
    bw.writeU32(this.time);

    bw.writeU32(this.hashes.size);

    for (const hash of this.hashes)
      bw.writeHash(hash);

    return bw;
  }

  /**
   * Convert hashes set to an array.
   * @returns {Hash[]}
   */

  toArray() {
    return this.hashes.toArray();
  }

  /**
   * Convert the block to a more json-friendly object.
   * @returns {Object}
   */

  getJSON() {
    return {
      hash: this.hash.toString('hex'),
      height: this.height,
      time: this.time,
      hashes: this.toArray().map(h => h.toString('hex'))
    };
  }

  /**
   * Instantiate wallet block from block meta.
   * @private
   * @param {BlockMeta} block
   */

  fromMeta(block) {
    this.hash = block.hash;
    this.height = block.height;
    this.time = block.time;
    return this;
  }

  /**
   * Instantiate wallet block from block meta.
   * @param {BlockMeta} block
   * @returns {BlockRecord}
   */

  static fromMeta(block) {
    return new this().fromMeta(block);
  }
}

/**
 * Blind Bid
 */

class BlindBid extends bio.Struct {
  constructor() {
    super();
    this.name = EMPTY;
    this.nameHash = consensus.ZERO_HASH;
    this.prevout = new Outpoint();
    this.value = -1;
    this.lockup = 0;
    this.blind = consensus.ZERO_HASH;
    this.height = -1;
    this.own = false;
  }

  /**
   * @returns {Number}
   */

  getSize() {
    return 1 + this.name.length + 45;
  }

  /**
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    let height = this.height;

    if (height === -1)
      height = 0xffffffff;

    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU64(this.lockup);
    bw.writeBytes(this.blind);
    bw.writeU32(height);
    bw.writeU8(this.own ? 1 : 0);
    return bw;
  }

  /**
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    this.name = br.readBytes(br.readU8());
    this.lockup = br.readU64();
    this.blind = br.readBytes(32);
    this.height = br.readU32();
    this.own = br.readU8() === 1;

    if (this.height === 0xffffffff)
      this.height = -1;

    return this;
  }

  getJSON() {
    return {
      name: this.name.toString('ascii'),
      nameHash: this.nameHash.toString('hex'),
      prevout: this.prevout.toJSON(),
      value: this.value === -1 ? undefined : this.value,
      lockup: this.lockup,
      blind: this.blind.toString('hex'),
      height: this.height,
      own: this.own
    };
  }
}

/**
 * Blind Value
 */

class BlindValue extends bio.Struct {
  constructor() {
    super();
    this.value = 0;
    this.nonce = consensus.ZERO_HASH;
  }

  getSize() {
    return 40;
  }

  /**
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    bw.writeU64(this.value);
    bw.writeBytes(this.nonce);
    return bw;
  }

  /**
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    this.value = br.readU64();
    this.nonce = br.readBytes(32);
    return this;
  }

  getJSON() {
    return {
      value: this.value,
      nonce: this.nonce.toString('hex')
    };
  }
}

/**
 * Bid Reveal
 */

class BidReveal extends bio.Struct {
  constructor() {
    super();
    this.name = EMPTY;
    this.nameHash = consensus.ZERO_HASH;
    this.prevout = new Outpoint();
    this.bidPrevout = new Outpoint();
    this.value = 0;
    this.height = -1;
    this.own = false;
  }

  getSize() {
    return 1 + this.name.length + 13 + 36;
  }

  /**
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    let height = this.height;

    if (height === -1)
      height = 0xffffffff;

    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU64(this.value);
    bw.writeU32(height);
    bw.writeU8(this.own ? 1 : 0);
    this.bidPrevout.write(bw);

    return bw;
  }

  /**
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    this.name = br.readBytes(br.readU8());
    this.value = br.readU64();
    this.height = br.readU32();
    this.own = br.readU8() === 1;
    this.bidPrevout.read(br);

    if (this.height === 0xffffffff)
      this.height = -1;

    return this;
  }

  getJSON() {
    return {
      name: this.name.toString('ascii'),
      nameHash: this.nameHash.toString('hex'),
      prevout: this.prevout.toJSON(),
      bidPrevout: this.bidPrevout.isNull() ? null : this.bidPrevout.toJSON(),
      value: this.value,
      height: this.height,
      own: this.own
    };
  }
}

/**
 * TX Count
 *
 * This is used for tracking the block height and transaction
 * index for the wallet. This is used as entry point into
 * indexes that are organized by count.
 */

class TXCount {
  /**
   * Create tx count record.
   * @constructor
   * @param {Number} [height]
   * @param {Number} [index]
   */

  constructor(height, index) {
    this.height = height || 0;
    this.index = index || 0;
  }

  /**
   * Serialize.
   * @returns {Buffer}
   */

  encode() {
    const bw = bio.write(8);

    bw.writeU32(this.height);
    bw.writeU32(this.index);

    return bw.render();
  }

  /**
   * Deserialize.
   * @private
   * @param {Buffer} data
   */

  decode(data) {
    const br = bio.read(data);

    this.height = br.readU32();
    this.index = br.readU32();

    return this;
  }

  /**
   * Instantiate a tx count from a buffer.
   * @param {Buffer} data
   * @returns {TXCount}
   */

  static decode(data) {
    return new this().decode(data);
  }
}

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

TXDB.Balance = Balance;
TXDB.BalanceDelta = BalanceDelta;
TXDB.Credit = Credit;
TXDB.Details = Details;
TXDB.DetailsMember = DetailsMember;
TXDB.BlockRecord = BlockRecord;
TXDB.BlindBid = BlindBid;
TXDB.BlindValue = BlindValue;
TXDB.BidReveal = BidReveal;
TXDB.TXCount = TXCount;

module.exports = TXDB;
