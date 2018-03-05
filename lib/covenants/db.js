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
const Auction = require('./auction');
const rules = require('./rules');
const CoinView = require('../coins/coinview');
const {Op} = Auction;
const {types, states} = Auction;

/*
 * Database Layout:
 *   c -> name bucket
 *   a[name-hash] -> auction data
 *   u[height] -> undo ops
 *   p[name-hash] -> trie pending list
 *   j[height] -> trie journal
 *   r[height] -> previous root
 */

const layout = {
  c: bdb.key('c'),
  a: bdb.key('a', ['hash256']),
  u: bdb.key('u', ['uint32']),
  p: bdb.key('p', ['hash256']),
  j: bdb.key('j', ['uint32']),
  r: bdb.key('r', ['uint32'])
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
    return this.getAuction(rules.hashName(name));
  }

  async getData(nameHash, height) {
    const auction = await this.getAuction(nameHash);

    if (height !== -1) {
      if (auction.height >= (height - (height % rules.TRIE_INTERVAL)))
        return null;
    }

    return auction.data;
  }

  async getDataByName(name, height) {
    return this.getData(rules.hashName(name), height);
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

  /*
   * Connecting
   */

  async connect(batch, trie, view, height) {
    const b = this.bucket.wrap(batch);

    for (const auction of view.auctions.values()) {
      const {nameHash} = auction;

      await this.applyState(b, auction, auction.ops);

      b.put(layout.p.build(nameHash), null);
    }

    this.writeUndo(b, view, height);

    if (height === 1 || (height % rules.TRIE_INTERVAL) === 0)
      await this.connectTrie(b, trie, height);
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

  async updateTrie(b, trie) {
    const updates = [];

    const iter = this.bucket.iterator({
      gte: layout.p.min(),
      lte: layout.p.max()
    });

    await iter.each(async (key) => {
      assert(key.length === 33);
      assert(key[0] === 0x70);

      const nameHash = key.slice(1);
      const auction = await this.getAuction(nameHash);

      assert(!auction || !auction.isNull());

      if (auction && auction.data)
        await trie.insert(nameHash, auction.data);
      else
        await trie.remove(nameHash);

      updates.push(nameHash);

      b.del(key);
    });

    return updates;
  }

  async connectTrie(b, trie, height) {
    assert(height === 1 || (height % rules.TRIE_INTERVAL) === 0);

    const prev = trie.hash();
    const updates = await this.updateTrie(b, trie);

    if (updates.length === 0)
      return;

    const size = 4 + updates.length * 32;
    const bw = bio.write(size);

    bw.writeU32(updates.length);

    for (const nameHash of updates)
      bw.writeHash(nameHash);

    b.put(layout.j.build(height), bw.render());
    b.put(layout.r.build(height), prev);
  }

  /*
   * Disconnecting
   */

  async disconnect(batch, trie, view, height) {
    const b = this.bucket.wrap(batch);

    await this.disconnectState(b, view, height);

    if (height === 1 || (height % rules.TRIE_INTERVAL) === 0)
      await this.disconnectTrie(b, trie, height);
  }

  async disconnectState(b, view, height) {
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

    b.del(layout.u.build(height));
  }

  async unupdateTrie(b, trie, height) {
    const iter = this.bucket.iterator({
      gte: layout.p.min(),
      lte: layout.p.max()
    });

    await iter.each(key => b.del(key));

    const prev = this.bucket.get(layout.r.build(height));

    if (!prev)
      return;

    assert(prev.length === 32);

    trie.inject(prev);

    b.del(layout.r.build(height));
  }

  async disconnectTrie(b, trie, height) {
    assert(height === 1 || (height % rules.TRIE_INTERVAL) === 0);

    await this.unupdateTrie(b, trie, height);

    const raw = this.bucket.get(layout.j.build(height));

    if (!raw)
      return;

    const br = bio.read(raw);
    const count = br.readU32();

    for (let i = 0; i < count; i++) {
      const nameHash = br.readBytes(32);
      b.put(layout.p.build(nameHash), null);
    }

    b.del(layout.j.build(height));
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
    return this.process(tx, view, height);
  }

  async process(tx, view, height) {
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
      const nameHash = blake2b.digest(name);
      const auction = await view.getAuction(this, nameHash);

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

          if (data.length > 0)
            auction.setData(data);

          auction.setOwner(tx.outpoint(i), output.value);

          // Verify renewal if there is one.
          if (covenant.items.length === 3) {
            if (!await this.verifyRenewal(covenant, height))
              return false;
            auction.setRenewal(height);
          }

          break;
        }
        // none/redeem -> revoke
        case types.REVOKE: {
          auction.setRevoke(tx.outpoint(i));
          break;
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
