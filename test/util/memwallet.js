/*!
 * memwallet.js - in-memory wallet object for hsd
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
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
const NameState = require('../../lib/covenants/namestate');
const NameUndo = require('../../lib/covenants/undo');
const reserved = require('../../lib/covenants/reserved');
const ownership = require('../../lib/covenants/ownership');
const policy = require('../../lib/protocol/policy');
const {Resource} = require('../../lib/dns/resource');
const Address = require('../../lib/primitives/address');
const {OwnershipProof} = ownership;
const {states} = NameState;
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
    this.proofs = new Map();

    this.chain = [];
    this.names = new BufferMap();
    this.nameUndo = new BufferMap();
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

    this.chain = [this.network.genesis.hash];

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
      this.connectNames(tx, view, height);

    if (result) {
      this.txs += 1;
      this.map.add(hash);
    }

    return result;
  }

  connectNames(tx, view, height) {
    const hash = tx.hash();
    const network = this.network;

    assert(height !== -1);

    let updated = false;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (!covenant.isName())
        continue;

      const addr = output.getHash();

      if (!addr)
        continue;

      const path = this.getPath(addr);
      const nameHash = covenant.getHash(0);
      const outpoint = tx.outpoint(i);
      const ns = view.getNameStateSync(this, nameHash);

      if (!ns.isNull())
        ns.maybeExpire(height, network);

      switch (covenant.type) {
        case types.CLAIM: {
          if (!path)
            break;

          const name = covenant.get(2);
          const flags = covenant.getU8(3);
          const claimed = covenant.getU32(5);

          // if (ns.isNull())
          //   this.addNameMap(b, nameHash);

          if (ns.isNull())
            ns.set(name, height);

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
          if (!path)
            break;

          if (ns.isNull()) {
            const name = covenant.get(2);

            // this.addNameMap(b, nameHash);

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

            this.putBid(nameHash, outpoint, {
              name,
              lockup,
              blind,
              own: false
            });

            updated = true;

            break;
          }

          // if (ns.isNull())
          //   this.addNameMap(b, nameHash);

          ns.set(name, start);

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
          if (ns.isNull())
            break;

          if (ns.owner.isNull() || output.value > ns.highest) {
            ns.setValue(ns.highest);
            ns.setOwner(outpoint);
            ns.setHighest(output.value);
          } else if (output.value > ns.value) {
            ns.setValue(output.value);
          }

          if (!path) {
            this.putReveal(nameHash, outpoint, {
              name: ns.name,
              value: output.value,
              height: height,
              own: false
            });
            updated = true;
            break;
          }

          const coin = view.getOutputFor(tx.inputs[i]);

          if (coin) {
            const blind = coin.covenant.getHash(3);
            const nonce = covenant.getHash(2);

            this.putBlind(blind, {
              value: output.value,
              nonce: nonce
            });
          }

          this.putReveal(nameHash, outpoint, {
            name: ns.name,
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
          }

          ns.setOwner(tx.outpoint(i));
          ns.setTransfer(0);
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
          ns.setData(null);

          updated = true;

          break;
        }
      }
    }

    for (const ns of view.names.values()) {
      const {nameHash} = ns;

      if (ns.isNull())
        this.removeNameState(nameHash);
      else
        this.putNameState(nameHash, ns);
    }

    if (updated) {
      const undo = view.toNameUndo();

      if (undo.names.length > 0)
        this.putNameUndo(hash, undo);
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

    this.undoNameState(tx);

    if (result)
      this.txs -= 1;

    this.map.delete(hash);

    return result;
  }

  undoNameState(tx) {
    const hash = tx.hash();

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (!covenant.isName())
        continue;

      switch (covenant.type) {
        case types.BID: {
          const nameHash = covenant.getHash(0);
          this.removeBid(nameHash, tx.outpoint(i));
          break;
        }
        case types.REVEAL: {
          const nameHash = covenant.getHash(0);
          this.removeReveal(nameHash, tx.outpoint(i));
          break;
        }
      }
    }

    const undo = this.getNameUndo(hash);

    if (!undo)
      return;

    const view = new CoinView();

    for (const [nameHash, delta] of undo.names) {
      const ns = view.getNameStateSync(this, nameHash);

      ns.applyState(delta);

      if (ns.isNull())
        this.removeNameState(nameHash);
      else
        this.putNameState(nameHash, ns);
    }

    this.removeNameUndo(hash);
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

  async getNameStatus(nameHash) {
    return new NameState();
  }

  async isAvailable(nameHash) {
    const ns = await this.getNameStatus(nameHash);
    return ns.state(this.height + 1, this.network) === 0;
  }

  async proveOwnership(name) {
    if (this.proofs.has(name))
      return OwnershipProof.fromJSON(this.proofs.get(name));

    let proof;
    try {
      proof = await ownership.prove(name, true);
    } catch (e) {
      return null;
    }

    this.proofs.set(name, proof.toJSON());

    return proof;
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
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const ns = await this.getNameState(nameHash);

    if (ns) {
      if ((options.commitHeight >>> 0) <= 1 && !ns.isExpired(height, network))
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

    const proof = await this.proveOwnership(item.target);

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
      added += 200; // max string size

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

    if (this.chain.length < 2)
      throw new Error('Chain too immature for name claim.');

    let commitHash = this.chain[1];
    let commitHeight = 1;

    if (options.commitHeight != null) {
      const block = this.chain[options.commitHeight];

      if (!block)
        throw new Error('Block not found.');

      commitHeight = options.commitHeight;
      commitHash = block;
    }

    const fee = Math.min(item.value, minFee);
    const address = this.createReceive().getAddress();
    const txt = ownership.createData(address,
                                     fee,
                                     commitHash,
                                     commitHeight,
                                     network);

    return {
      name,
      target: item.target,
      value: item.value,
      proof,
      size,
      fee,
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
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const ns = this.getNameState(nameHash);

    if (ns) {
      if ((options.commitHeight >>> 0) <= 1 && !ns.isExpired(height, network))
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
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const ns = this.getNameState(nameHash);

    if (ns) {
      if (!ns.isExpired(height, network))
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

    // TODO: Handle expired behavior.
    if (rules.isReserved(nameHash, height, network))
      throw new Error('Name is reserved.');

    if (!rules.hasRollout(nameHash, height, network))
      throw new Error('Name not yet available.');

    let ns = this.getNameState(nameHash);

    if (!ns)
      ns = await this.getNameStatus(nameHash);

    ns.maybeExpire(height, network);

    const state = ns.state(height, network);
    const start = ns.height;

    if (state !== states.OPENING)
      throw new Error('Name is not available.');

    if (start !== 0 && start !== height)
      throw new Error('Name is already opening.');

    const addr = this.createReceive().getAddress();

    const output = new Output();
    output.address = addr;
    output.value = 0;
    output.covenant.type = types.OPEN;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(0);
    output.covenant.push(rawName);

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

    if (!rules.hasRollout(nameHash, height, network))
      throw new Error('Name not yet available.');

    let ns = this.getNameState(nameHash);

    if (!ns)
      ns = await this.getNameStatus(nameHash);

    ns.maybeExpire(height, network);

    const state = ns.state(height, network);
    const start = ns.height;

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
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(start);
    output.covenant.push(rawName);
    output.covenant.pushHash(blind);

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
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    ns.maybeExpire(height, network);

    const state = ns.state(height, network);

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
      if (coin.height < ns.height)
        continue;

      const blind = coin.covenant.getHash(3);
      const bv = this.getBlind(blind);

      if (!bv)
        throw new Error('Blind value not found.');

      const {value, nonce} = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.type = types.REVEAL;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);
      output.covenant.pushHash(nonce);

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
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    const state = ns.state(height, network);

    if (state < states.CLOSED)
      throw new Error('Auction is not yet closed.');

    const reveals = this.getReveals(nameHash);
    const mtx = new MTX();

    for (const {prevout, own} of reveals) {
      if (!own)
        continue;

      if (prevout.equals(ns.owner))
        continue;

      const coin = this.getCoin(prevout.toKey());

      if (!coin)
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      mtx.addOutpoint(prevout);

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);

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
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error('Wallet did not win the auction.');

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error('Wallet did not win the auction.');

    if (!coin.covenant.isReveal() && !coin.covenant.isClaim())
      throw new Error('Name must be in REVEAL or CLAIM state.');

    if (coin.covenant.isClaim()) {
      if (height < coin.height + network.coinbaseMaturity)
        throw new Error('Claim is not yet mature.');
    }

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    const output = new Output();
    output.address = coin.address;
    output.value = ns.value;

    output.covenant.type = types.REGISTER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);

    if (resource)
      output.covenant.push(resource);
    else
      output.covenant.push(EMPTY);

    output.covenant.pushHash(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createUpdate(name, resource, options) {
    assert(typeof name === 'string');

    if (resource instanceof Resource)
      resource = resource.encode();

    assert(Buffer.isBuffer(resource));

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (coin.covenant.isReveal() || coin.covenant.isClaim())
      return this.createRegister(name, resource, options);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error('Name must be registered.');
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(resource);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createRenewal(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error('Name must be registered.');
    }

    // if (height < ns.renewal + network.names.treeInterval)
    //   throw new Error('Must wait to renew.');

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.RENEW;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.pushHash(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createTransfer(name, address, options) {
    assert(typeof name === 'string');
    assert(address instanceof Address);

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error('Name must be registered.');
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.TRANSFER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.pushU8(address.version);
    output.covenant.push(address.hash);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
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
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isTransfer())
      throw new Error('Name is not being transfered.');

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(EMPTY);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createFinalize(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isTransfer())
      throw new Error('Name is not being transfered.');

    // if (height < coin.height + network.names.transferLockup)
    //   throw new Error('Transfer is still locked up.');

    const version = coin.covenant.getU8(2);
    const hash = coin.covenant.get(3);
    const address = Address.fromHash(hash, version);

    let flags = 0;

    if (ns.weak)
      flags |= 1;

    const output = new Output();
    output.address = address;
    output.value = coin.value;
    output.covenant.type = types.FINALIZE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(rawName);
    output.covenant.pushU8(flags);
    output.covenant.pushU32(ns.claimed);
    output.covenant.pushU32(ns.renewals);
    output.covenant.pushHash(this.getRenewalBlock());

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return this._create(mtx, options);
  }

  async createRevoke(name, options) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = this.getNameState(nameHash);
    const height = this.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const coin = this.getCoin(ns.owner.toKey());

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isTransfer()
        && !coin.covenant.isFinalize()) {
      throw new Error('Name must be registered.');
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.REVOKE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
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

  putNameState(nameHash, ns) {
    assert(Buffer.isBuffer(nameHash));
    this.names.set(nameHash, ns.encode());
  }

  getNameState(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    const raw = this.names.get(nameHash);

    if (!raw)
      return null;

    const ns = NameState.decode(raw);
    ns.nameHash = nameHash;
    return ns;
  }

  removeNameState(nameHash) {
    assert(Buffer.isBuffer(nameHash));
    this.names.delete(nameHash);
  }

  putNameUndo(hash, undo) {
    this.nameUndo.set(hash, undo.encode());
  }

  getNameUndo(hash) {
    const raw = this.nameUndo.get(hash);

    if (!raw)
      return null;

    return NameUndo.decode(raw);
  }

  removeNameUndo(hash) {
    this.nameUndo.delete(hash);
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
    bw.writeU8(this.own ? 1 : 0);

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

module.exports = MemWallet;
