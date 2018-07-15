/*!
 * memwallet.js - in-memory wallet object for hsk
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const {BufferMap, BufferSet} = require('buffer-map');
const rules = require('../../lib/covenants/rules');
const Network = require('../../lib/protocol/network');
const MTX = require('../../lib/primitives/mtx');
const HD = require('../../lib/hd/hd');
const {BloomFilter} = require('bfilter');
const KeyRing = require('../../lib/primitives/keyring');
const Outpoint = require('../../lib/primitives/outpoint');
const CoinView = require('../../lib/coins/coinview');
const Output = require('../../lib/primitives/output');
const Coin = require('../../lib/primitives/coin');
const consensus = require('../../lib/protocol/consensus');
const Claim = require('../../lib/primitives/claim');
const Auction = require('../../lib/covenants/auction');
const AuctionUndo = require('../../lib/covenants/undo');
const reserved = require('../../lib/covenants/reserved');
const ownership = require('../../lib/covenants/ownership');
const policy = require('../../lib/protocol/policy');
const Resource = require('../../lib/dns/resource');
const Address = require('../../lib/primitives/address');
const {states} = Auction;
const {types} = rules;

const EMPTY = Buffer.alloc(0);

class MemWallet {
  constructor(options) {
    this.network = Network.primary;
    this.master = null;
    this.key = null;
    this.witness = false;
    this.account = 0;
    this.height = 0;
    this.receiveDepth = 1;
    this.changeDepth = 1;
    this.receive = null;
    this.change = null;
    this.map = new BufferSet();
    this.coins = new BufferMap();
    this.spent = new BufferMap();
    this.paths = new BufferMap();

    this.chain = [];
    this.auctions = new BufferMap();
    this.auctionUndo = new BufferMap();
    this.bids = new BufferMap();
    this.reveals = new BufferMap();
    this.blinds = new BufferMap();

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
    const hash = key.getHash();
    this.filter.add(hash);
    this.paths.set(hash, new Path(hash, 0, index));
    this.receive = key;
    return key;
  }

  createChange() {
    const index = this.changeDepth++;
    const key = this.deriveChange(index);
    const hash = key.getHash();
    this.filter.add(hash);
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

    this.filter.add(op.encode());

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
    this.height = entry.height;
  }

  removeBlock(entry, txs) {
    for (let i = txs.length - 1; i >= 0; i--) {
      const tx = txs[i];
      this.removeTX(tx, entry.height);
    }
    this.chain.pop();
    this.height = entry.height - 1;
  }

  addTX(tx, height) {
    const hash = tx.hash();

    let result = false;

    if (height == null)
      height = -1;

    if (this.map.has(hash))
      return true;

    const view = new CoinView();

    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const op = input.prevout.toKey();
      const coin = this.getCoin(op);

      if (!coin)
        continue;

      result = true;

      this.removeCoin(op);

      view.addCoin(coin);
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const addr = output.getHash();

      if (!addr)
        continue;

      const path = this.getPath(addr);

      if (!path)
        continue;

      result = true;

      const coin = Coin.fromTX(tx, i, height);

      this.addCoin(coin);
      this.syncKey(path);
    }

    if (height !== -1)
      this.connectAuctions(tx, view, height);

    if (result) {
      this.txs += 1;
      this.map.add(hash);
    }

    return result;
  }

  connectAuctions(tx, view, height) {
    const hash = tx.hash();
    const network = this.network;

    assert(height !== -1);

    let updated = false;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type < types.CLAIM
          || covenant.type > types.REVOKE) {
        continue;
      }

      const addr = output.getHash();

      if (!addr)
        continue;

      const path = this.getPath(addr);
      const nameHash = covenant.items[0];
      const outpoint = tx.outpoint(i);
      const auction = view.getAuctionSync(this, nameHash);

      if (!auction.isNull()) {
        if (auction.isExpired(height, network))
          auction.reset(height);
      }

      switch (covenant.type) {
        case types.CLAIM: {
          if (!path)
            break;

          const name = covenant.items[1];
          const flags = covenant.items[2];

          // if (auction.isNull())
          //   this.addNameMap(b, nameHash);

          auction.setAuction(name, height);
          auction.setClaimed(true);
          auction.setValue(0);
          auction.setOwner(outpoint);
          auction.setHighest(0);
          auction.setWeak((flags[0] & 1) === 1);

          updated = true;

          break;
        }

        case types.OPEN: {
          if (!path)
            break;

          if (auction.isNull()) {
            const name = covenant.items[1];

            // this.addNameMap(b, nameHash);

            auction.setAuction(name, height);

            updated = true;
          }

          break;
        }

        case types.BID: {
          const name = covenant.items[1];
          const start = covenant.items[2].readUInt32LE(0);
          const blind = covenant.items[3];
          const lockup = output.value;

          if (!path) {
            if (auction.isNull())
              break;

            this.putBid(nameHash, outpoint, {
              name,
              lockup,
              blind,
              own: false
            });

            updated = true;

            break;
          }

          // if (auction.isNull())
          //   this.addNameMap(b, nameHash);

          auction.setAuction(name, start);

          this.putBid(nameHash, outpoint, {
            name,
            lockup,
            blind,
            own: true
          });

          updated = true;

          break;
        }

        case types.REVEAL: {
          if (auction.isNull())
            break;

          if (output.value > auction.highest) {
            auction.setValue(auction.highest);
            auction.setOwner(outpoint);
            auction.setHighest(output.value);
          } else if (output.value > auction.value) {
            auction.setValue(output.value);
          }

          if (!path) {
            this.putReveal(nameHash, outpoint, {
              name: auction.name,
              value: output.value,
              height: height,
              own: false
            });
            updated = true;
            break;
          }

          const coin = view.getOutputFor(tx.inputs[i]);

          if (coin) {
            const blind = coin.covenant.items[3];
            const nonce = covenant.items[1];

            this.putBlind(blind, {
              value: output.value,
              nonce: nonce
            });
          }

          this.putReveal(nameHash, outpoint, {
            name: auction.name,
            value: output.value,
            height: height,
            own: true
          });

          updated = true;

          break;
        }

        case types.REDEEM: {
          break;
        }

        case types.REGISTER: {
          if (auction.isNull())
            break;

          const data = covenant.items[1];

          // If we didn't have a second
          // bidder, use our own bid.
          if (auction.value === -1) {
            assert(auction.highest !== -1);
            auction.setValue(auction.highest);
          }

          auction.setOwner(outpoint);

          if (data.length > 0)
            auction.setData(data);

          auction.setRenewal(height);

          updated = true;

          break;
        }

        case types.UPDATE: {
          if (auction.isNull())
            break;

          const data = covenant.items[1];

          auction.setOwner(outpoint);
          auction.setTransfer(-1);

          if (data.length > 0)
            auction.setData(data);

          if (covenant.items.length === 3)
            auction.setRenewal(height);

          updated = true;

          break;
        }

        case types.TRANSFER: {
          if (auction.isNull())
            break;

          auction.setOwner(outpoint);

          assert(auction.transfer === -1);
          auction.setTransfer(height);

          if (covenant.items.length === 3)
            auction.setRenewal(height);

          updated = true;

          break;
        }

        case types.FINALIZE: {
          if (auction.isNull()) {
            if (!path)
              break;

            const name = covenant.items[1];
            const start = covenant.items[2].readUInt32LE(0);
            const weak = (covenant.items[3][0] & 1) === 1;
            const claimed = (covenant.items[3][0] & 4) === 4;

            auction.setAuction(name, start);
            auction.setValue(output.value);
            auction.setWeak(weak);
            auction.setClaimed(claimed);

            // Cannot get data or highest.
            auction.setHighest(output.value);
          } else {
            assert(auction.transfer !== -1);
          }

          auction.setOwner(tx.outpoint(i));
          auction.setTransfer(-1);
          auction.setRenewal(height);

          updated = true;

          break;
        }

        case types.REVOKE: {
          if (auction.isNull())
            break;

          assert(auction.revoked === -1);
          auction.setRevoked(height);
          auction.setData(null);

          updated = true;

          break;
        }
      }
    }

    for (const auction of view.auctions.values()) {
      const {nameHash} = auction;

      if (auction.isNull())
        this.removeAuction(nameHash);
      else
        this.putAuction(nameHash, auction);
    }

    if (updated) {
      const undo = view.toAuctionUndo();

      if (undo.auctions.length > 0)
        this.putAuctionUndo(hash, undo);
    }

    return updated;
  }

  removeTX(tx, height) {
    const hash = tx.hash();

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

    this.undoAuction(tx);

    if (result)
      this.txs -= 1;

    this.map.delete(hash);

    return result;
  }

  undoAuction(tx) {
    const hash = tx.hash();

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type < types.CLAIM
          || covenant.type > types.REVOKE) {
        continue;
      }

      switch (covenant.type) {
        case types.BID: {
          const nameHash = covenant.items[0];
          this.removeBid(nameHash, tx.outpoint(i));
          break;
        }
        case types.REVEAL: {
          const nameHash = covenant.items[0];
          this.removeReveal(nameHash, tx.outpoint(i));
          break;
        }
      }
    }

    const undo = this.getAuctionUndo(hash);

    if (!undo)
      return;

    const view = new CoinView();

    for (const [nameHash, delta] of undo.auctions) {
      const auction = view.getAuctionSync(this, nameHash);

      auction.applyState(delta);

      if (auction.isNull())
        this.removeAuction(nameHash);
      else
        this.putAuction(nameHash, auction);
    }

    this.removeAuctionUndo(hash);
  }

  deriveInputs(mtx) {
    const keys = [];

    for (let i = 0; i < mtx.inputs.length; i++) {
      const input = mtx.inputs[i];
      const coin = mtx.view.getOutputFor(input);

      if (!coin)
        continue;

      const addr = coin.getHash();

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

  generateNonce(nameHash, address, value) {
    const path = this.getPath(address.hash);

    if (!path)
      throw new Error('Account not found.');

    const hi = (value * (1 / 0x100000000)) >>> 0;
    const lo = value >>> 0;
    const index = (hi ^ lo) & 0x7fffffff;

    const {publicKey} = this.master.derive(index);

    return blake2b.multi(address.hash, publicKey, nameHash);
  }

  generateBlind(nameHash, address, value) {
    const nonce = this.generateNonce(nameHash, address, value);
    const blind = rules.blind(value, nonce);

    this.putBlind(blind, {value, nonce});

    return blind;
  }

  async getAuctionState(nameHash) {
    return {
      state: 0,
      height: 0,
      renewal: 0,
      revoked: -1,
      claimed: false,
      weak: false,
      owned: false
    };
  }

  async isAvailable(nameHash) {
    const state = await this.getAuctionState(nameHash);
    return state.state === 0;
  }

  async buildClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');
    assert(options && typeof options === 'object');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.height + 1;
    const hardened = Boolean(options.hardened);
    const network = this.network;

    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const auction = await this.getAuction(nameHash);

    let forked = false;

    if (auction) {
      if (hardened) {
        if (auction.isWeak(height, network)) {
          auction.reset(height);
          forked = true;
        }
      }

      if (!auction.isExpired(height, network))
        throw new Error('Name already claimed.');
    } else {
      if (!await this.isAvailable(nameHash))
        throw new Error('Name is not available.');
    }

    const item = reserved.get(nameHash);
    assert(item);

    let rate = options.rate;
    if (rate == null)
      rate = 1000;

    let size = 5 << 10;
    let proof = null;

    try {
      proof = await ownership.prove(item.target, true);
    } catch (e) {
      ;
    }

    if (proof) {
      const zones = proof.zones;
      const zone = zones.length >= 2
        ? zones[zones.length - 1]
        : null;

      let added = 0;

      // TXT record.
      added += item.target.length; // rrname
      added += 10; // header
      added += 1; // txt size
      added += 183; // max string size

      // RRSIG record size.
      if (!zone || zone.claim.length === 0) {
        added += item.target.length; // rrname
        added += 10; // header
        added += 275; // avg rsa sig size
      }

      const claim = Claim.fromProof(proof);

      size = claim.getVirtualSize() + (added >>> 2);
    }

    let minFee = options.fee;

    if (minFee == null)
      minFee = policy.getMinFee(size, rate);

    let fee = Math.min(item.value, minFee);

    if (forked)
      fee = 0;

    const renewal = this.getRenewalBlock();
    const block = renewal;

    const address = this.createReceive().getAddress();
    const txt = ownership.createData(fee, block, address, forked, network);

    return {
      name,
      target: item.target,
      value: item.value,
      proof,
      size,
      fee,
      block,
      address,
      txt
    };
  }

  async fakeClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.height + 1;
    const hardened = Boolean(options.hardened);
    const network = this.network;

    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const auction = this.getAuction(nameHash);

    let forked = false;

    if (auction) {
      if (hardened && auction.isWeak(height, network))
        forked = true;

      if (!forked && !auction.isExpired(height, network))
        throw new Error('Name already claimed.');
    } else {
      if (!await this.isAvailable(nameHash))
        throw new Error('Name is not available.');
    }

    const {proof, txt} = await this.buildClaim(name, options);

    if (!proof)
      throw new Error('Could not resolve name.');

    proof.addData([txt]);

    const data = proof.getData(this.network);

    if (!data)
      throw new Error(`No valid DNS commitment found for ${name}.`);

    if (data.forked !== forked)
      throw new Error('Proof data must have the correct fork flag.');

    return Claim.fromProof(proof);
  }

  async createClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.height + 1;
    const hardened = Boolean(options.hardened);
    const network = this.network;

    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const auction = this.getAuction(nameHash);

    let forked = false;

    if (auction) {
      if (hardened && auction.isWeak(height, network))
        forked = true;

      if (!forked && !auction.isExpired(height, network))
        throw new Error('Name already claimed.');
    } else {
      if (!await this.isAvailable(nameHash))
        throw new Error('Name is not available.');
    }

    const item = reserved.get(nameHash);
    assert(item);

    const proof = await ownership.prove(item.target);
    const data = proof.getData(this.network);

    if (!data)
      throw new Error(`No valid DNS commitment found for ${name}.`);

    if (data.forked !== forked)
      throw new Error('Proof data must have the correct fork flag.');

    return Claim.fromProof(proof);
  }

  async createOpen(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.height + 1;
    const network = this.network;

    if (rules.isReserved(nameHash, height, network))
      throw new Error('Name is reserved.');

    if (!rules.verifyRollout(nameHash, height, network))
      throw new Error('Name not yet available.');

    const auction = this.getAuction(nameHash);

    let state = -1;
    let start = -1;

    if (auction) {
      if (auction.isExpired(height, network))
        auction.reset(height);

      state = auction.state(height, network);
      start = auction.height;
    } else {
      const s = await this.getAuctionState(nameHash);

      state = s.state;
      start = s.height;
    }

    if (state !== states.OPENING)
      throw new Error('Name is not available.');

    if (start !== 0 && start !== height)
      throw new Error('Name is already opening.');

    const addr = this.createReceive().getAddress();

    const output = new Output();
    output.address = addr;
    output.value = 0;
    output.covenant.type = types.OPEN;
    output.covenant.items.push(nameHash);
    output.covenant.items.push(rawName);

    const mtx = new MTX();
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createBid(name, value, lockup, options) {
    assert(typeof name === 'string');
    assert(Number.isSafeInteger(value) && value >= 0);
    assert(Number.isSafeInteger(lockup) && lockup >= 0);

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.height + 1;
    const network = this.network;

    if (rules.isReserved(nameHash, height, network))
      throw new Error('Name is reserved.');

    if (!rules.verifyRollout(nameHash, height, network))
      throw new Error('Name not yet available.');

    let state = -1;
    let start = -1;

    const auction = this.getAuction(nameHash);

    if (auction) {
      if (auction.isExpired(height, network))
        auction.reset(height);

      state = auction.state(height, network);
      start = auction.height;
    } else {
      const s = await this.getAuctionState(nameHash);

      state = s.state;
      start = s.height;
    }

    if (state === states.OPENING)
      throw new Error('Name has not reached the bidding phase yet.');

    if (state !== states.BIDDING)
      throw new Error('Name is not available.');

    if (value > lockup)
      throw new Error('Bid exceeds lockup value.');

    const addr = this.createReceive().getAddress();
    const blind = this.generateBlind(nameHash, addr, value);

    const output = new Output();
    output.address = addr;
    output.value = lockup;
    output.covenant.type = types.BID;
    output.covenant.items.push(nameHash);
    output.covenant.items.push(rawName);
    output.covenant.items.push(encodeU32(start));
    output.covenant.items.push(blind);

    const mtx = new MTX();
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createReveal(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    if (auction.isExpired(height, network))
      auction.reset(height);

    const state = auction.state(height, network);

    if (state < states.REVEAL)
      throw new Error('Cannot reveal yet.');

    if (state > states.REVEAL)
      throw new Error('Reveal period has passed.');

    const bids = this.getBids(nameHash);
    const mtx = new MTX();

    for (const {prevout, own} of bids) {
      if (!own)
        continue;

      const coin = this.getCoin(prevout.toKey());

      if (!coin)
        continue;

      // Is local?
      if (coin.height < auction.height)
        continue;

      const blind = coin.covenant.items[3];
      const bv = this.getBlind(blind);

      if (!bv)
        throw new Error('Blind value not found.');

      const {value, nonce} = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.type = types.REVEAL;
      output.covenant.items.push(nameHash);
      output.covenant.items.push(nonce);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error('No bids to reveal.');

    return this._create(mtx, options);
  }

  async createRedeem(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    const state = auction.state(height, network);

    if (state < states.CLOSED)
      throw new Error('Auction is not yet closed.');

    const reveals = this.getReveals(nameHash);
    const mtx = new MTX();

    for (const {prevout, own} of reveals) {
      if (!own)
        continue;

      if (prevout.equals(auction.owner))
        continue;

      const coin = this.getCoin(prevout.toKey());

      if (!coin)
        continue;

      // Is local?
      if (coin.height < auction.height)
        continue;

      mtx.addOutpoint(prevout);

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.items.push(nameHash);

      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0)
      throw new Error('No reveals to redeem.');

    return this._create(mtx, options);
  }

  async createRegister(name, resource, options) {
    assert(typeof name === 'string');

    if (resource instanceof Resource)
      resource = resource.encode();

    assert(!resource || Buffer.isBuffer(resource));

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    const coin = this.getCoin(auction.owner.toKey());

    if (!coin)
      throw new Error('Wallet did not win the auction.');

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < auction.height)
      throw new Error('Wallet did not win the auction.');

    if (coin.covenant.type !== types.REVEAL
        && coin.covenant.type !== types.CLAIM) {
      throw new Error('Name must be in REVEAL or CLAIM state.');
    }

    if (coin.covenant.type === types.CLAIM) {
      if (height < coin.height + network.coinbaseMaturity)
        throw new Error('Claim is not yet mature.');
    }

    const state = auction.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (auction.highest === -1)
      throw new Error('Value not recorded (rescan required).');

    let value = auction.value;

    // If we were the only bidder.
    if (value === -1)
      value = auction.highest;

    const output = new Output();
    output.address = coin.address;
    output.value = value;

    output.covenant.type = types.REGISTER;
    output.covenant.items.push(nameHash);

    if (resource)
      output.covenant.items.push(resource);
    else
      output.covenant.items.push(EMPTY);

    output.covenant.items.push(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createUpdate(name, resource, options) {
    assert(typeof name === 'string');

    if (resource instanceof Resource)
      resource = resource.encode();

    assert(!resource || Buffer.isBuffer(resource));

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    const coin = this.getCoin(auction.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (coin.covenant.type === types.REVEAL
        || coin.covenant.type === types.CLAIM) {
      return this.createRegister(name, resource, options);
    }

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < auction.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = auction.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (coin.covenant.type !== types.REGISTER
        && coin.covenant.type !== types.UPDATE
        && coin.covenant.type !== types.FINALIZE) {
      throw new Error('Name must be registered.');
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.items.push(nameHash);

    if (resource)
      output.covenant.items.push(resource);
    else
      output.covenant.items.push(EMPTY);

    output.covenant.items.push(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createRenewal(name, options) {
    assert(typeof name === 'string');
    return this.createUpdate(name, null, options);
  }

  async createTransfer(name, address, options) {
    assert(typeof name === 'string');
    assert(address instanceof Address);

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    const coin = this.getCoin(auction.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < auction.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = auction.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (coin.covenant.type !== types.REGISTER
        && coin.covenant.type !== types.UPDATE
        && coin.covenant.type !== types.FINALIZE) {
      throw new Error('Name must be registered.');
    }

    // if (auction.isWeak(height, network))
    //   throw new Error('Cannot transfer a weak name prematurely.');

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.TRANSFER;
    output.covenant.items.push(nameHash);
    output.covenant.items.push(address.encode());
    output.covenant.items.push(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createCancel(name, resource, options) {
    assert(typeof name === 'string');

    if (resource instanceof Resource)
      resource = resource.encode();

    assert(!resource || Buffer.isBuffer(resource));

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    const coin = this.getCoin(auction.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < auction.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = auction.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (coin.covenant.type !== types.TRANSFER)
      throw new Error('Name is not being transfered.');

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.items.push(nameHash);

    if (resource)
      output.covenant.items.push(resource);
    else
      output.covenant.items.push(EMPTY);

    output.covenant.items.push(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createFinalize(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    const coin = this.getCoin(auction.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < auction.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = auction.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (coin.covenant.type !== types.TRANSFER)
      throw new Error('Name is not being transfered.');

    // if (height < coin.height + network.names.transferLockup)
    //   throw new Error('Transfer is still locked up.');

    const rawAddr = coin.covenant.items[1];
    const address = Address.decode(rawAddr);

    let flags = 0;

    if (auction.weak)
      flags |= 1;

    if (auction.claimed)
      flags |= 4;

    const output = new Output();
    output.address = address;
    output.value = coin.value;
    output.covenant.type = types.FINALIZE;
    output.covenant.items.push(nameHash);
    output.covenant.items.push(rawName);
    output.covenant.items.push(encodeU32(auction.height));
    output.covenant.items.push(Buffer.from([flags]));
    output.covenant.items.push(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createRevoke(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const auction = this.getAuction(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!auction)
      throw new Error('Auction not found.');

    const coin = this.getCoin(auction.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    // Is local?
    if (coin.height < auction.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (auction.isExpired(height, network))
      throw new Error('Name has expired!');

    const state = auction.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (coin.covenant.type !== types.REGISTER
        && coin.covenant.type !== types.UPDATE
        && coin.covenant.type !== types.TRANSFER
        && coin.covenant.type !== types.FINALIZE) {
      throw new Error('Name must be registered.');
    }

    // if (auction.isWeak(height, network))
    //   throw new Error('Cannot revoke a weak name prematurely.');

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.REVOKE;
    output.covenant.items.push(nameHash);

    const mtx = new MTX();
    mtx.addOutpoint(auction.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  getRenewalBlock() {
    let height = this.chain.length - this.network.names.renewalMaturity * 2;

    if (height < 0)
      height = 0;

    return this.chain[height];
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

  putAuction(nameHash, auction) {
    assert(Buffer.isBuffer(nameHash));
    this.auctions.set(nameHash, auction.encode());
  }

  getAuction(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    const raw = this.auctions.get(nameHash);

    if (!raw)
      return null;

    const auction = Auction.decode(raw);
    auction.nameHash = nameHash;
    return auction;
  }

  removeAuction(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    this.auctions.delete(nameHash);
  }

  putAuctionUndo(hash, undo) {
    this.auctionUndo.set(hash, undo.encode());
  }

  getAuctionUndo(hash) {
    const raw = this.auctionUndo.get(hash);

    if (!raw)
      return null;

    return AuctionUndo.decode(raw);
  }

  removeAuctionUndo(hash) {
    this.auctionUndo.delete(hash);
  }

  getBid(nameHash, outpoint) {
    assert(Buffer.isBuffer(nameHash));

    const map = this.bids.get(nameHash);

    if (!map)
      return null;

    const raw = map.get(outpoint.toKey());

    if (!raw)
      return null;

    const bb = BlindBid.decode(raw);
    bb.nameHash = nameHash;
    bb.prevout = outpoint;

    return bb;
  }

  putBid(nameHash, outpoint, options) {
    assert(Buffer.isBuffer(nameHash));

    if (!this.bids.has(nameHash))
      this.bids.set(nameHash, new BufferMap());

    const map = this.bids.get(nameHash);

    const bb = new BlindBid();

    bb.nameHash = nameHash;
    bb.name = options.name;
    bb.lockup = options.lockup;
    bb.blind = options.blind;
    bb.own = options.own;

    map.set(outpoint.toKey(), bb.encode());
  }

  removeBid(nameHash, outpoint) {
    assert(Buffer.isBuffer(nameHash));

    const map = this.bids.get(nameHash);

    if (!map)
      return;

    map.delete(outpoint.toKey());

    if (map.size === 0)
      this.bids.delete(nameHash);
  }

  getBids(nameHash) {
    if (nameHash) {
      assert(Buffer.isBuffer(nameHash));

      const map = this.bids.get(nameHash);

      if (!map)
        return [];

      const bids = [];

      for (const [key, raw] of map) {
        const bb = BlindBid.decode(raw);

        bb.nameHash = nameHash;
        bb.prevout = Outpoint.fromKey(key);

        const bv = this.getBlind(bb.blind);

        if (bv)
          bb.value = bv.value;

        bids.push(bb);
      }

      return bids;
    }

    const bids = [];

    for (const [nameHash, map] of this.bids) {
      for (const [key, raw] of map) {
        const bb = BlindBid.decode(raw);

        bb.nameHash = nameHash;
        bb.prevout = Outpoint.fromKey(key);

        const bv = this.getBlind(bb.blind);

        if (bv)
          bb.value = bv.value;

        bids.push(bb);
      }
    }

    return bids;
  }

  removeBids(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    this.bids.delete(nameHash);
  }

  getReveal(nameHash, outpoint) {
    assert(Buffer.isBuffer(nameHash));

    const map = this.reveals.get(nameHash);

    if (!map)
      return null;

    const raw = map.get(outpoint.toKey());

    if (!raw)
      return null;

    const brv = BidReveal.decode(raw);
    brv.nameHash = nameHash;
    brv.prevout = outpoint;

    return brv;
  }

  putReveal(nameHash, outpoint, options) {
    assert(Buffer.isBuffer(nameHash));

    if (!this.reveals.get(nameHash))
      this.reveals.set(nameHash, new BufferMap());

    const map = this.reveals.get(nameHash);

    const brv = new BidReveal();
    brv.nameHash = nameHash;
    brv.name = options.name;
    brv.value = options.value;
    brv.height = options.height;
    brv.own = options.own;

    map.set(outpoint.toKey(), brv.encode());
  }

  removeReveal(nameHash, outpoint) {
    assert(Buffer.isBuffer(nameHash));

    const map = this.reveals.get(nameHash);

    if (!map)
      return;

    map.delete(outpoint.toKey());

    if (map.size === 0)
      this.bids.delete(nameHash);
  }

  getReveals(nameHash) {
    if (nameHash) {
      assert(Buffer.isBuffer(nameHash));

      const map = this.reveals.get(nameHash);

      if (!map)
        return [];

      const reveals = [];

      for (const [key, raw] of map) {
        const brv = BidReveal.decode(raw);
        brv.nameHash = nameHash;
        brv.prevout = Outpoint.fromKey(key);
        reveals.push(brv);
      }

      return reveals;
    }

    const reveals = [];

    for (const [nameHash, map] of this.reveals) {
      for (const [key, raw] of map) {
        const brv = BidReveal.decode(raw);
        brv.nameHash = nameHash;
        brv.prevout = Outpoint.fromKey(key);
        reveals.push(brv);
      }
    }

    return reveals;
  }

  removeReveals(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    this.reveals.delete(nameHash);
  }

  getBlind(blind) {
    assert(Buffer.isBuffer(blind));
    const key = blind;
    const raw = this.blinds.get(key);

    if (!raw)
      return null;

    return BlindValue.decode(raw);
  }

  putBlind(blind, options) {
    assert(Buffer.isBuffer(blind));
    const key = blind;
    const {value, nonce} = options;
    const bv = new BlindValue();
    bv.value = value;
    bv.nonce = nonce;
    this.blinds.set(key, bv.encode());
  }

  removeBlind(blind) {
    assert(Buffer.isBuffer(blind));
    const key = blind;
    this.blinds.remove(key);
  }
}

class Path {
  constructor(hash, branch, index) {
    this.hash = hash;
    this.branch = branch;
    this.index = index;
  }
}

class BlindBid extends bio.Struct {
  constructor() {
    super();
    this.name = EMPTY;
    this.nameHash = consensus.ZERO_HASH;
    this.prevout = new Outpoint();
    this.value = -1;
    this.lockup = 0;
    this.blind = consensus.ZERO_HASH;
    this.own = false;
  }

  getSize() {
    return 1 + this.name.length + 41;
  }

  write(bw) {
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU64(this.lockup);
    bw.writeBytes(this.blind);
    bw.writeU8(this.own ? 1 : 0);
    return bw;
  }

  read(br) {
    this.name = br.readBytes(br.readU8());
    this.lockup = br.readU64();
    this.blind = br.readBytes(32);
    this.own = br.readU8() === 1;
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
      own: this.own
    };
  }
}

class BlindValue extends bio.Struct {
  constructor() {
    super();
    this.value = 0;
    this.nonce = consensus.ZERO_HASH;
  }

  getSize() {
    return 40;
  }

  write(bw) {
    bw.writeU64(this.value);
    bw.writeBytes(this.nonce);
    return bw;
  }

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

class BidReveal extends bio.Struct {
  constructor() {
    super();
    this.name = EMPTY;
    this.nameHash = consensus.ZERO_HASH;
    this.prevout = new Outpoint();
    this.value = 0;
    this.height = -1;
    this.own = false;
  }

  getSize() {
    return 1 + this.name.length + 13;
  }

  write(bw) {
    let height = this.height;

    if (height === -1)
      height = 0xffffffff;

    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU64(this.value);
    bw.writeU32(height);
    bw.writeU8(this.own);

    return bw;
  }

  read(br) {
    this.name = br.readBytes(br.readU8());
    this.value = br.readU64();
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
      value: this.value,
      height: this.height,
      own: this.own
    };
  }
}

function encodeU32(num) {
  assert((num >>> 0) === num);
  const buf = Buffer.allocUnsafe(4);
  bio.writeU32(buf, num, 0);
  return buf;
}

module.exports = MemWallet;
