/*!
 * memwallet.js - in-memory wallet object for bcoin
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
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
    this.auctions = new Map();
    this.bids = new Map();
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
  }

  removeBlock(entry, txs) {
    for (let i = txs.length - 1; i >= 0; i--) {
      const tx = txs[i];
      this.removeTX(tx, entry.height);
    }
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

      switch (covenant.type) {
        case 1: {
          if (!path)
            break;

          const name = covenant.string(0);

          if (!this.auctions.has(name))
            this.auctions.set(name, [new Outpoint(hash, i), 1]);

          break;
        }
        case 2: {
          const name = covenant.string(0);
          const nonce = covenant.items[1];

          if (!this.auctions.has(name))
            break;

          if (!this.bids.has(name))
            this.bids.set(name, new Map());

          const key = Outpoint.toKey(hash, i);

          this.bids.get(name).set(key, output.value);

          if (!path)
            break;

          // Useful for rescans:
          if (!this.values.has(name))
            this.values.set(name, [output.value, nonce]);

          this.auctions.set(name, [new Outpoint(hash, i), 2]);

          break;
        }
        case 3: {
          if (!path)
            break;

          const name = covenant.string(0);

          this.auctions.set(name, [new Outpoint(hash, i), 3]);

          break;
        }
        case 4: {
          if (!path)
            break;

          const name = covenant.string(0);

          // We lost.
          this.auctions.delete(name);
          this.bids.delete(name);
          // this.values.delete(name);

          break;
        }
        case 5: {
          const name = covenant.string(0);

          // Someone released it.
          this.auctions.delete(name);
          this.bids.delete(name);
          // this.values.delete(name);

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
      const output = tx.outputs[i];
      const op = new Outpoint(hash, i).toKey();
      const coin = this.getCoin(op);
      const uc = output.covenant;

      switch (uc.type) {
        case 1: {
          if (!coin)
            break;

          const name = uc.string(0);

          this.auctions.delete(name);

          break;
        }
        case 2: {
          const name = uc.string(0);

          if (!this.auctions.has(name))
            break;

          if (!this.bids.has(name))
            break;

          const key = Outpoint.toKey(hash, i);

          const bids = this.bids.get(name);

          bids.delete(key);

          if (bids.size === 0)
            this.bids.delete(name);

          if (!coin)
            break;

          this.values.delete(name);
          this.auctions.set(name, [new Outpoint(hash, i), 1]);

          break;
        }
        case 3: {
          if (!coin)
            break;

          const name = uc.string(0);

          this.auctions.set(name, [new Outpoint(hash, i), 2]);

          break;
        }
        case 4: {
          if (!coin)
            break;

          const name = uc.string(0);

          // We lost.
          this.auctions.set(name, [new Outpoint(hash, i), 2]);

          break;
        }
        case 5: {
          const name = uc.string(0);

          // Someone released it.
          this.auctions.set(name, [new Outpoint(hash, i), 3]);

          break;
        }
      }

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

  async bidName(name, bid, value, options) {
    const raw = Buffer.from(name, 'ascii');
    const nonce = random.randomBytes(32);
    const blind = rules.blind(bid, nonce);

    if (this.auctions.has(name))
      return null;

    const output = new Output();
    output.address = this.createReceive().getAddress();
    output.value = value;
    output.covenant.type = 1;
    output.covenant.items.push(raw);
    output.covenant.items.push(blind);

    this.values.set(name, [bid, nonce]);

    const mtx = new MTX();
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async revealName(name, options) {
    const auction = this.auctions.get(name);
    const item = this.values.get(name);

    if (!auction || !item)
      return null;

    const raw = Buffer.from(name, 'ascii');
    const [prevout, state] = auction;
    const [value, nonce] = item;

    if (state !== 1)
      return null;

    const output = new Output();
    output.address = this.createReceive().getAddress();
    output.value = value;
    output.covenant.type = 2;
    output.covenant.items.push(raw);
    output.covenant.items.push(nonce);

    const mtx = new MTX();
    mtx.addOutpoint(prevout);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async registerName(name, data, options) {
    const auction = this.auctions.get(name);
    const item = this.values.get(name);

    if (!auction || !item)
      return null;

    const raw = Buffer.from(name, 'ascii');
    const [prevout, state] = auction;
    const [value] = item;

    if (state !== 2 && state !== 3)
      return null;

    if (state === 2) {
      if (!this.isWinner(name))
        return null;
    }

    const output = new Output();
    output.address = this.createReceive().getAddress();
    output.value = value;
    output.covenant.type = 3;
    output.covenant.items.push(raw);
    output.covenant.items.push(data);

    const mtx = new MTX();
    mtx.addOutpoint(prevout);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  // async closeAuction(name, data, options) {
  //   const auction = this.auctions.get(name);
  //   const item = this.values.get(name);
  //
  //   if (!auction || !item)
  //     return null;
  //
  //   const [prevout, state] = auction;
  //   const [value] = item;
  //
  //   if (!data)
  //     data = Buffer.alloc(0);
  //
  //   return null;
  // }

  async redeemName(name, options) {
    const auction = this.auctions.get(name);
    const item = this.values.get(name);

    if (!auction || !item)
      return null;

    const [prevout] = auction;
    const [value] = item;

    const output = new Output();
    output.address = this.createReceive().getAddress();
    output.value = value;

    const mtx = new MTX();
    mtx.addOutpoint(prevout);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  isWinner(name) {
    const bids = this.bids.get(name);

    if (!bids)
      return false;

    let best = -1;
    let winner = null;

    for (const [key, value] of bids) {
      if (value >= best) {
        winner = key;
        best = value;
      }
    }

    if (!winner)
      return false;

    return this.coins.has(winner);
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

module.exports = MemWallet;
