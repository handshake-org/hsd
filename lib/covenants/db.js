/*!
 * namedb.js - name database for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const bdb = require('bdb');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const Trie = require('../trie/trie');
const Auction = require('./auction');
const Outpoint = require('../primitives/outpoint');
const rules = require('./rules');
const CoinView = require('../coins/coinview');
const {Op} = Auction;
const {types, states} = Auction;

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/*
 * Database Layout:
 *   c -> name bucket
 *   t -> trie bucket
 *   a[name-hash] -> auction data
 *   u[height] -> undo ops
 */

const layout = {
  c: bdb.key('c'),
  t: bdb.key('t'),
  a: bdb.key('a', ['hash256']),
  u: bdb.key('u', ['uint32'])
};

/**
 * NameDB
 */

class NameDB {
  constructor(chaindb) {
    this.chaindb = chaindb;
    this.db = chaindb.db;
    this.network = chaindb.network;
    this.bucket = this.db.bucket(layout.c.build());
    this.trieBucket = this.bucket.child(layout.t.build());
    this.trie = new Trie(this.trieBucket);
  }

  async open() {
    await this.trie.open();
  }

  async close() {
    await this.trie.close();
  }

  async getAuction(nameHash) {
    assert(Buffer.isBuffer(nameHash));

    const raw = await this.bucket.get(layout.a.build(nameHash));

    if (!raw)
      return null;

    const auction = Auction.fromRaw(raw);
    auction.nameHash = nameHash;
    return auction;
  }

  async getAuctionByName(name) {
    if (typeof name === 'string')
      name = Buffer.from(name, 'ascii');

    return this.getAuction(blake2b.digest(name));
  }

  async getUndo(prevout) {
    assert(prevout instanceof Outpoint);

    const {hash, index} = prevout;
    const raw = await this.bucket.get(layout.u.build(hash, index));

    if (!raw)
      return null;

    const auction = Auction.fromRaw(raw);
    auction.nameHash = blake2b.digest(auction.name);
    return auction;
  }

  root() {
    return this.trie.hash('hex');
  }

  commitTrie(batch) {
    const b = this.trieBucket.wrap(batch);
    return this.trie.commit(b);
  }

  async prove(root, key) {
    const trie = this.trie.snapshot(root);
    return trie.prove(key);
  }

  async proveName(root, name) {
    if (typeof name === 'string')
      name = Buffer.from(name, 'ascii');

    const key = blake2b.digest(name);
    return [key, await this.prove(root, key)];
  }

  async getProof(name) {
    const entry = await this.chaindb.getTip();
    const [, nodes] = await this.proveName(entry.trieRoot, name);
    return [Buffer.from(entry.hash, 'hex'), nodes];
  }

  async getTip() {
    const entry = await this.chaindb.getTip();
    return entry.toHeaders();
  }

  async getHeader(hash) {
    const tip = await this.chaindb.getTip();
    const entry = await this.chaindb.getEntry(hash);

    if (!await this.chaindb.isMainChain(entry))
      return null;

    if (entry.height < tip.height - 1152) // 4 days
      return null;

    return entry.toHeaders();
  }

  async isAvailable(name, height) {
    const network = this.network;

    if (!rules.isAvailable(name, height, network))
      return false;

    const auction = await this.getAuctionByName(name);

    if (auction && !auction.isBidding(height, network))
      return false;

    return true;
  }

  async saveView(batch, view, height) {
    const b = this.bucket.wrap(batch);

    for (const auction of view.auctions.values())
      await this.applyState(b, auction, auction.ops);

    this.writeUndo(b, view, height);

    this.commitTrie(batch);
  }

  writeUndo(b, view, height) {
    let count = 0;
    let size = 0;

    size += 4;

    for (const {undo} of view.auctions.values()) {
      if (undo.length === 0)
        continue;

      count += 1;
      size += 32;
      size += 4;

      for (const op of undo)
        size += op.getSize();
    }

    if (count === 0) {
      b.del(layout.u.build(height));
      return;
    }

    const bw = bio.write(size);

    bw.writeU32(count);

    for (const auction of view.auctions.values()) {
      if (auction.undo.length === 0)
        continue;

      bw.writeHash(auction.nameHash);
      bw.writeU32(auction.undo.length);

      // Write undo ops backwards.
      for (let i = auction.undo.length - 1; i >= 0; i--) {
        const op = auction.undo[i];
        op.toWriter(bw);
      }
    }

    b.put(layout.u.build(height), bw.render());
  }

  async revert(batch, view, height) {
    const b = this.bucket.wrap(batch);
    const raw = this.bucket.get(layout.u.build(height));

    if (!raw)
      return;

    const br = bio.read(raw);
    const count = br.readU32();

    for (let i = 0; i < count; i++) {
      const nameHash = br.readHash();
      const auction = await view.getAuction(this, nameHash);
      const count = br.readU32();
      const ops = [];

      for (let j = 0; j < count; j++)
        ops.push(Op.fromReader(br));

      await this.applyState(b, auction, ops);
    }
  }

  async applyState(b, auction, ops) {
    const {nameHash} = auction;

    for (const {type, params} of ops) {
      switch (type) {
        case types.SET_AUCTION: {
          const [state] = params;
          auction.inject(state);
          break;
        }
        case types.SET_OWNER: {
          const [owner, value] = params;
          auction.owner = owner;
          auction.value = value;
          break;
        }
        case types.SET_REVOKE: {
          const [revoke] = params;
          auction.revoke = revoke;
          break;
        }
        case types.SET_DATA: {
          const [data] = params;

          auction.data = data;

          if (data) {
            const hash = blake2b.digest(data);
            await this.trie.insert(nameHash, hash);
          } else {
            await this.trie.remove(nameHash);
          }

          break;
        }
        case types.SET_RENEWAL: {
          const [height] = params;
          auction.renewal = height;
          break;
        }
        case types.SET_CLAIMED: {
          const [claimed] = params;
          auction.claimed = claimed;
          break;
        }
      }
    }

    if (auction.isNull())
      b.del(layout.a.build(nameHash));
    else
      b.put(layout.a.build(nameHash), auction.toRaw());
  }

  async getDataByName(name, height) {
    if (typeof name === 'string')
      name = Buffer.from(name, 'ascii');

    const key = blake2b.digest(name);
    return this.getData(key, height);
  }

  async getData(key, height) {
    const auction = await this.getAuction(key);

    if (!auction || auction.owner.isNull())
      return null;

    return auction.data;
  }

  async verifyRenewal(covenant, height) {
    assert(covenant.items.length === 3);

    // We require renewals to commit to a block
    // within the past 6 months, to prove that
    // the user still owns the key. This prevents
    // people from presigning thousands of years
    // worth of renewals. The block must be at
    // least 400 blocks back to prevent the
    // possibility of a reorg invalidating the
    // covenant.

    const hash = covenant.items[2].toString('hex');
    const entry = await this.chaindb.getEntry(hash);

    if (!entry)
      return false;

    // Must be the current chain.
    if (!await this.chaindb.isMainChain(entry))
      return false;

    // Cannot renew yet.
    if (height < rules.RENEWAL_MATURITY)
      return true;

    // Make sure it's a mature block (unlikely to be reorgd).
    if (entry.height > height - rules.RENEWAL_MATURITY)
      return false;

    // Block committed to must be
    // no older than a 6 months.
    if (entry.height < height - rules.RENEWAL_PERIOD)
      return false;

    return true;
  }

  async validate(tx, height) {
    const view = new CoinView();
    return this.connect(tx, view, height);
  }

  async connect(tx, view, height) {
    if (tx.isCoinbase())
      return true;

    const {types} = rules;
    const network = this.network;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type < types.CLAIM
          || covenant.type > types.REVOKE) {
        continue;
      }

      const [name] = covenant.items;
      const auction = await view.getAuctionByName(this, name);

      if (auction.isNull()) {
        assert(covenant.type === types.BID || covenant.type === types.CLAIM,
          'Database inconsistency.');
        auction.setAuction(name, height);
      }

      if (auction.isExpired(height, network))
        auction.setAuction(name, height);

      const state = auction.state(height, network);

      // none/redeem -> claim
      if (covenant.type === types.CLAIM) {
        if (state !== states.BIDDING)
          return false;

        // Can only claim reserved names.
        if (!rules.isReserved(name, height, network))
          return false;

        auction.setClaimed(true);
        auction.setOwner(tx.outpoint(i), output.value);

        continue;
      }

      // none/redeem -> bid
      if (covenant.type === types.BID) {
        if (state !== states.BIDDING)
          return false;

        // Cannot bid on a reserved name.
        if (rules.isReserved(name, height, network))
          return false;

        // On mainnet, names are released on a
        // weekly basis for the first year.
        if (!rules.verifyRollout(name, height, network))
          return false;

        continue;
      }

      assert(i < tx.inputs.length);

      const {prevout} = tx.inputs[i];
      const local = auction.isLocal(view, prevout);

      // Do not allow an expired
      // output to update record.
      if (!local)
        return false;

      switch (covenant.type) {
        // bid -> reveal
        case types.REVEAL: {
          // Allow early reveals.
          if (state > states.REVEAL)
            return false;

          // Pick owner in order they appear in the block.
          if (auction.owner.isNull() || output.value > auction.value)
            auction.setOwner(tx.outpoint(i), output.value);

          break;
        }
        // reveal -> redeem
        case types.REDEEM: {
          if (state !== states.CLOSED)
            return false;

          // Must be the loser in order
          // to redeem the money now.
          if (prevout.equals(auction.owner))
            return false;

          break;
        }
        // update -> update
        case types.UPDATE: {
          if (state !== states.CLOSED)
            return false;

          // Must be the winner in
          // order to redeem the name.
          if (!prevout.equals(auction.owner))
            return false;

          const [, data] = covenant.items;

          if (data.length > 0) {
            auction.setData(data);
          } else {
            if (!auction.data)
              auction.setData(EMPTY);
          }

          auction.setOwner(tx.outpoint(i), output.value);

          // Verify renewal if there is one.
          if (covenant.items.length === 3) {
            if (!await this.verifyRenewal(covenant, height))
              return false;
            auction.setRenewal(height);
          }

          if (i + 1 < tx.outputs.length) {
            const revoke = tx.outputs[i + 1];
            if (revoke.covenant.type === types.REVOKE) {
              auction.setRevoke(tx.outpoint(i + 1));
              i += 1;
            }
          }

          break;
        }
        // claim/reveal/update -> 1 + revoke
        case types.REVOKE: {
          return false;
        }
      }
    }

    return true;
  }
}

/*
 * Expose
 */

module.exports = NameDB;
