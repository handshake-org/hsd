/*!
 * memwallet.js - in-memory wallet object for hsk
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/handshake
 */

'use strict';

const assert = require('assert');
const random = require('bcrypto/lib/random');
const rules = require('../../lib/covenants/rules');
const Network = require('../../lib/protocol/network');
const MTX = require('../../lib/primitives/mtx');
const HD = require('../../lib/hd/hd');
const {BloomFilter} = require('bfilter');
const KeyRing = require('../../lib/primitives/keyring');
const Outpoint = require('../../lib/primitives/outpoint');
const Output = require('../../lib/primitives/output');
const Coin = require('../../lib/primitives/coin');
const consensus = require('../../lib/protocol/consensus');
const {types} = rules;

class MemWallet {
  constructor(options) {
    this.network = Network.primary;
    this.master = null;
    this.key = null;
    this.witness = false;
    this.account = 0;
    this.receiveDepth = 1;
    this.changeDepth = 1;
    this.receive = null;
    this.change = null;
    this.map = new Set();
    this.coins = new Map();
    this.spent = new Map();
    this.paths = new Map();

    this.chain = [];
    this.auctions = new Map();
    this.bids = new Map();
    this.reveals = new Map();
    this.values = new Map();

    this.balance = 0;
    this.txs = 0;
    this.filter = BloomFilter.fromRate(1000000, 0.001, -1);

    if (options)
      this.fromOptions(options);

    this.init();
  }

  fromOptions(options) {
    if (options.network != null) {
      assert(options.network);
      this.network = Network.get(options.network);
    }

    if (options.master != null) {
      assert(options.master);
      this.master = HD.PrivateKey.fromOptions(options.master, this.network);
    }

    if (options.key != null) {
      assert(HD.isPrivate(options.key));
      this.key = options.key;
    }

    if (options.witness != null) {
      assert(typeof options.witness === 'boolean');
      this.witness = options.witness;
    }

    if (options.account != null) {
      assert(typeof options.account === 'number');
      this.account = options.account;
    }

    if (options.receiveDepth != null) {
      assert(typeof options.receiveDepth === 'number');
      this.receiveDepth = options.receiveDepth;
    }

    if (options.changeDepth != null) {
      assert(typeof options.changeDepth === 'number');
      this.changeDepth = options.changeDepth;
    }

    return this;
  }

  init() {
    let i;

    if (!this.master)
      this.master = HD.PrivateKey.generate();

    if (!this.key) {
      const type = this.network.keyPrefix.coinType;
      this.key = this.master.deriveAccount(44, type, this.account);
    }

    i = this.receiveDepth;
    while (i--)
      this.createReceive();

    i = this.changeDepth;
    while (i--)
      this.createChange();
  }

  createReceive() {
    const index = this.receiveDepth++;
    const key = this.deriveReceive(index);
    const hash = key.getHash('hex');
    this.filter.add(hash, 'hex');
    this.paths.set(hash, new Path(hash, 0, index));
    this.receive = key;
    return key;
  }

  createChange() {
    const index = this.changeDepth++;
    const key = this.deriveChange(index);
    const hash = key.getHash('hex');
    this.filter.add(hash, 'hex');
    this.paths.set(hash, new Path(hash, 1, index));
    this.change = key;
    return key;
  }

  deriveReceive(index) {
    return this.deriveKey(0, index);
  }

  deriveChange(index) {
    return this.deriveKey(1, index);
  }

  derivePath(path) {
    return this.deriveKey(path.branch, path.index);
  }

  deriveKey(branch, index) {
    const type = this.network.keyPrefix.coinType;

    let key = this.master.deriveAccount(44, type, this.account);

    key = key.derive(branch).derive(index);

    const ring = new KeyRing({
      network: this.network,
      privateKey: key.privateKey
    });

    return ring;
  }

  getKey(hash) {
    const path = this.paths.get(hash);

    if (!path)
      return null;

    return this.derivePath(path);
  }

  getPath(hash) {
    return this.paths.get(hash);
  }

  getCoin(key) {
    return this.coins.get(key);
  }

  getUndo(key) {
    return this.spent.get(key);
  }

  addCoin(coin) {
    const op = new Outpoint(coin.hash, coin.index);
    const key = op.toKey();

    this.filter.add(op.toRaw());

    this.spent.delete(key);

    this.coins.set(key, coin);
    this.balance += coin.value;
  }

  removeCoin(key) {
    const coin = this.coins.get(key);

    if (!coin)
      return;

    this.spent.set(key, coin);
    this.balance -= coin.value;

    this.coins.delete(key);
  }

  getAddress() {
    return this.receive.getAddress();
  }

  getReceive() {
    return this.receive.getAddress();
  }

  getChange() {
    return this.change.getAddress();
  }

  getCoins() {
    const coins = [];

    for (const coin of this.coins.values())
      coins.push(coin);

    return coins;
  }

  syncKey(path) {
    switch (path.branch) {
      case 0:
        if (path.index === this.receiveDepth - 1)
          this.createReceive();
        break;
      case 1:
        if (path.index === this.changeDepth - 1)
          this.createChange();
        break;
      default:
        assert(false);
        break;
    }
  }

  addBlock(entry, txs) {
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      this.addTX(tx, entry.height);
    }
    this.chain.push(entry.hash);
  }

  removeBlock(entry, txs) {
    for (let i = txs.length - 1; i >= 0; i--) {
      const tx = txs[i];
      this.removeTX(tx, entry.height);
    }
    this.chain.pop();
  }

  addBid(bb) {
    if (!this.bids.has(bb.name))
      this.bids.set(bb.name, new Map());

    this.bids.get(bb.name).set(bb.prevout.toKey(), bb);
  }

  addReveal(brv) {
    if (!this.reveals.has(brv.name))
      this.reveals.set(brv.name, new Map());

    this.reveals.get(brv.name).set(brv.prevout.toKey(), brv);
  }

  addValue(blind, bv) {
    this.values.set(blind.toString('hex'), bv);
  }

  addTX(tx, height) {
    const hash = tx.hash('hex');

    let result = false;

    if (height == null)
      height = -1;

    if (this.map.has(hash))
      return true;

    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const op = input.prevout.toKey();
      const coin = this.getCoin(op);

      if (!coin)
        continue;

      result = true;

      this.removeCoin(op);
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;
      const addr = output.getHash('hex');

      if (!addr)
        continue;

      const path = this.getPath(addr);
      const outpoint = tx.outpoint(i);

      switch (covenant.type) {
        case types.CLAIM: {
          if (!path)
            break;

          const name = covenant.string(0);

          if (!this.auction.has(name)) {
            const auction = new Auction();
            auction.name = name;
            auction.owner = outpoint;
            auction.state = types.CLAIM;
            auction.height = height;

            this.auctions.set(name, auction);
          }

          break;
        }
        case types.BID: {
          if (!path)
            break;

          const name = covenant.string(0);

          if (!this.auctions.has(name)) {
            const auction = new Auction();
            auction.name = name;
            auction.owner = outpoint;
            auction.state = types.BID;
            auction.height = height;

            this.auctions.set(name, auction);
          }

          const bb = new BlindBid();
          bb.name = name;
          bb.prevout = outpoint;
          bb.lockup = output.value;
          bb.blind = covenant.items[1];
          this.addBid(bb);

          break;
        }
        case types.REVEAL: {
          const name = covenant.string(0);
          const auction = this.auctions.get(name);

          if (!auction)
            break;

          const brv = new BidReveal();
          brv.name = name;
          brv.prevout = outpoint;
          brv.value = output.value;
          brv.height = height;
          brv.own = path ? true : false;

          this.addReveal(brv);

          if (path) {
            // Useful for rescans:
            // const nonce = covenant.items[1];
            // const bv = new BlindValue();
            // bv.value = output.value;
            // bv.nonce = nonce;
            // this.addValue(blind, bv);

            auction.outpoint = outpoint;
            auction.state = types.REVEAL;
          }

          break;
        }
        case types.REDEEM: {
          if (!path)
            break;

          const name = covenant.string(0);
          const auction = this.auctions.get(name);

          if (!auction)
            break;

          // We lost.
          auction.state = types.REVOKE;

          break;
        }
        case types.REGISTER: {
          if (!path)
            break;

          const name = covenant.string(0);
          const auction = this.auctions.get(name);

          if (!auction)
            break;

          auction.state = types.UPDATE;
          auction.owner = tx.outpoint(i);
          auction.cold = tx.outpoint(i + 1);
          auction.data = covenant.items[1];

          break;
        }
        case types.COLD: {
          break;
        }
        case types.UPDATE: {
          if (!path)
            break;

          const name = covenant.string(0);
          const auction = this.auctions.get(name);

          if (!auction)
            break;

          auction.owner = tx.outpoint(i);

          if (covenant.items[1].length > 0)
            auction.data = covenant.items[1];

          break;
        }
        case types.TRANSFER: {
          const name = covenant.string(0);
          const auction = this.auctions.get(name);

          if (!auction)
            break;

          auction.state = types.TRANSFER;
          auction.owner = tx.outpoint(i);
          auction.cold = tx.outpoint(i + 1);

          break;
        }
        case types.REVOKE: {
          if (!path)
            break;

          const name = covenant.string(0);
          const auction = this.auctions.get(name);

          if (!auction)
            break;

          // Someone released it.
          auction.state = types.REVOKE;

          break;
        }
      }

      if (!path)
        continue;

      result = true;

      const coin = Coin.fromTX(tx, i, height);

      this.addCoin(coin);
      this.syncKey(path);
    }

    if (result) {
      this.txs += 1;
      this.map.add(hash);
    }

    return result;
  }

  removeTX(tx, height) {
    const hash = tx.hash('hex');

    let result = false;

    if (!this.map.has(hash))
      return false;

    for (let i = 0; i < tx.outputs.length; i++) {
      const op = new Outpoint(hash, i).toKey();
      const coin = this.getCoin(op);

      if (!coin)
        continue;

      result = true;

      this.removeCoin(op);
    }

    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const op = input.prevout.toKey();
      const coin = this.getUndo(op);

      if (!coin)
        continue;

      result = true;

      this.addCoin(coin);
    }

    if (result)
      this.txs -= 1;

    this.map.delete(hash);

    return result;
  }

  deriveInputs(mtx) {
    const keys = [];

    for (let i = 0; i < mtx.inputs.length; i++) {
      const input = mtx.inputs[i];
      const coin = mtx.view.getOutputFor(input);

      if (!coin)
        continue;

      const addr = coin.getHash('hex');

      if (!addr)
        continue;

      const path = this.getPath(addr);

      if (!path)
        continue;

      const key = this.derivePath(path);

      keys.push(key);
    }

    return keys;
  }

  async createBid(name, bid, value, options) {
    const raw = Buffer.from(name, 'ascii');
    const nonce = random.randomBytes(32);
    const blind = rules.blind(bid, nonce);

    const output = new Output();
    output.address = this.createReceive().getAddress();
    output.value = value;
    output.covenant.type = types.BID;
    output.covenant.items.push(raw);
    output.covenant.items.push(blind);

    const bv = new BlindValue();
    bv.value = bid;
    bv.nonce = nonce;
    this.addValue(blind, bv);

    const mtx = new MTX();
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createReveal(name, options) {
    const auction = this.auctions.get(name);

    if (!auction)
      throw new Error('No auction found.');

    const raw = Buffer.from(name, 'ascii');

    if (auction.state !== types.BID)
      throw new Error('Bad auction state.');

    const bids = this.bids.get(name);

    if (!bids || bids.size === 0)
      throw new Error('No bids found.');

    const mtx = new MTX();

    for (const bb of bids.values()) {
      const coin = this.getCoin(bb.prevout.toKey());
      assert(coin);

      // XXX Put on blindbid object?
      const blind = coin.covenant.items[1];

      const bv = this.values.get(blind.toString('hex'));
      assert(bv);

      const output = new Output();
      output.address = coin.address;
      output.value = bv.value;
      output.covenant.type = types.REVEAL;
      output.covenant.items.push(raw);
      output.covenant.items.push(bv.nonce);

      mtx.addOutpoint(bb.prevout);
      mtx.outputs.push(output);
    }

    return this._create(mtx, options);
  }

  async createRegister(name, data, options) {
    const auction = this.auctions.get(name);

    if (!auction)
      throw new Error('No auction found.');

    if (auction.state !== types.REVEAL)
      throw new Error('Bad auction state.');

    const [value, winner] = this.getWinningReveal(name);

    const coin = this.getCoin(winner.toKey());

    if (!coin)
      return null;

    const raw = Buffer.from(name, 'ascii');

    const output = new Output();
    output.address = coin.address;
    output.value = value;
    output.covenant.type = types.REGISTER;
    output.covenant.items.push(raw);
    output.covenant.items.push(data);
    output.covenant.items.push(this.getRenewalBlock());

    const cold = new Output();
    cold.address = coin.address;
    cold.value = 0;
    cold.covenant.type = types.COLD;
    cold.covenant.items.push(raw);

    const mtx = new MTX();
    mtx.addOutpoint(winner);
    mtx.outputs.push(output);
    mtx.outputs.push(cold);

    return this._create(mtx, options);
  }

  async createUpdate(name, data, options) {
    const auction = this.auctions.get(name);

    if (!auction)
      throw new Error('No auction found.');

    if (auction.state === types.REVEAL)
      return this.createRegister(name, data, options);

    if (auction.state !== types.REGISTER
        && auction.state !== types.UPDATE) {
      throw new Error('Bad auction state.');
    }

    const raw = Buffer.from(name, 'ascii');

    const output = new Output();
    const coin = this.getCoin(auction.owner.toKey());
    assert(coin);

    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.items.push(raw);
    output.covenant.items.push(data);

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createRedeem(name, options) {
    const auction = this.auctions.get(name);

    if (!auction)
      throw new Error('No auction found.');

    const raw = Buffer.from(name, 'ascii');

    if (auction.state !== types.REVEAL)
      throw new Error('Bad auction state.');

    const reveals = this.reveals.get(name);

    if (!reveals || reveals.size === 0)
      throw new Error('No reveals found.');

    const [, winner] = this.getWinningReveal(name);

    const mtx = new MTX();

    for (const brv of reveals.values()) {
      if (!brv.own)
        continue;

      if (brv.prevout.equals(winner))
        continue;

      const coin = this.getCoin(brv.prevout.toKey());
      assert(coin);

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.items.push(raw);

      mtx.addOutpoint(brv.prevout);
      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error('No suitable reveals found.');

    return this._create(mtx, options);
  }

  getWinningReveal(name) {
    const reveals = this.reveals.get(name);

    if (!reveals)
      throw new Error('Could not find winner.');

    let highest = -1;
    let value = -1;
    let winner = null;

    for (const brv of reveals.values()) {
      if (brv.value > highest) {
        value = highest;
        winner = brv.prevout;
        highest = brv.value;
      } else if (brv.value > value) {
        value = brv.value;
      }
    }

    if (!winner)
      throw new Error('Could not find winner.');

    if (value === -1)
      value = highest;

    return [value, winner];
  }

  getRenewalBlock() {
    let height = this.chain.length - this.network.names.renewalMaturity * 2;

    if (height < 0)
      height = 0;

    return Buffer.from(this.chain[height], 'hex');
  }

  fund(mtx, options) {
    const coins = this.getCoins();

    if (!options)
      options = {};

    return mtx.fund(coins, {
      selection: options.selection || 'age',
      round: options.round,
      depth: options.depth,
      hardFee: options.hardFee,
      subtractFee: options.subtractFee,
      changeAddress: this.getChange(),
      coinbaseMaturity: this.network.coinbaseMaturity,
      height: -1,
      rate: options.rate,
      maxFee: options.maxFee
    });
  }

  template(mtx) {
    const keys = this.deriveInputs(mtx);
    mtx.template(keys);
  }

  sign(mtx) {
    const keys = this.deriveInputs(mtx);
    mtx.template(keys);
    mtx.sign(keys);
  }

  async _create(mtx, options) {
    await this.fund(mtx, options);

    assert(mtx.getFee() <= MTX.Selector.MAX_FEE, 'TX exceeds MAX_FEE.');

    mtx.sortMembers();

    if (options && options.locktime != null)
      mtx.setLocktime(options.locktime);

    this.sign(mtx);

    if (!mtx.isSigned())
      throw new Error('Cannot sign tx.');

    return mtx;
  }

  async create(options) {
    const mtx = new MTX(options);
    return this._create(mtx, options);
  }

  async send(options) {
    const mtx = await this.create(options);
    this.addTX(mtx.toTX());
    return mtx;
  }
}

class Path {
  constructor(hash, branch, index) {
    this.hash = hash;
    this.branch = branch;
    this.index = index;
  }
}

class Auction {
  constructor() {
    this.name = '';
    this.owner = new Outpoint();
    this.cold = new Outpoint();
    this.state = 0;
    this.height = -1;
    this.data = Buffer.alloc(0);
  }
}

class BlindBid {
  constructor() {
    this.name = '';
    this.prevout = new Outpoint();
    this.lockup = 0;
    this.blind = consensus.ZERO_HASH;
  }
}

class BlindValue {
  constructor() {
    this.value = 0;
    this.nonce = consensus.ZERO_HASH;
  }
}

class BidReveal {
  constructor() {
    this.name = '';
    this.prevout = new Outpoint();
    this.value = 0;
    this.height = -1;
    this.own = false;
  }
}

module.exports = MemWallet;
