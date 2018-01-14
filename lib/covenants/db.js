/*!
 * namedb.js - name database for bcoin
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const bdb = require('bdb');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const Trie = require('thc/trie/trie');
const Auction = require('./auction');
const Outpoint = require('../primitives/outpoint');
const consensus = require('../protocol/consensus');
const rules = require('./rules');
const {Op} = Auction;
const {encoding} = bio;
const {types, states} = Auction;

/*
 * Database Layout:
 *   c -> name bucket
 *   t -> trie bucket
 *   a[name-hash] -> auction data
 *   u[height] -> state log
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
    return this.trie.prove(key);
    const trie = this.trie.snapshot(root);
    return trie.prove(key);
  }

  async saveView(batch, view, height) {
    const b = this.bucket.wrap(batch);

    for (const auction of view.auctions.values())
      await this.applyState(b, auction, auction.ops);

    this.writeUndo(b, view, height);

    this.commitTrie(batch);
  }

  writeUndo(b, view, height) {
    let size = 0;

    size += 4;

    for (const {undo} of view.auctions.values()) {
      size += 32;
      size += 4;
      for (const op of undo)
        size += op.getSize();
    }

    if (size === 4 + view.auctions.size * 36) {
      b.del(layout.u.build(height));
      return;
    }

    const bw = bio.write(size);

    bw.writeU32(view.auctions.size);

    for (const auction of view.auctions.values()) {
      bw.writeHash(auction.nameHash);
      bw.writeU32(auction.undo.length);
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
          const [owner] = params;
          auction.owner = owner;
          break;
        }
        case types.SET_WINNER: {
          const [winner, value] = params;
          auction.winner = winner;
          auction.value = value;
          break;
        }
        case types.SET_RENEWAL: {
          const [height] = params;
          auction.renewal = height;
          break;
        }
        case types.SET_DATA: {
          const [data] = params;
          auction.data = data;
          if (data)
            await this.trie.insert(nameHash, data);
          else
            await this.trie.remove(nameHash);
          break;
        }
      }
    }

    if (auction.isNull())
      b.del(layout.a.build(nameHash));
    else
      b.put(layout.a.build(nameHash), auction.toRaw());

    auction.ops.length = 0;
  }

  async getDataByName(name, height) {
    const key = blake2b.digest(name);
    return this.getData(key, height);
  }

  async getData(key, height) {
    const auction = await this.getAuction(key);

    if (!auction || auction.owner.isNull())
      return null;

    return this.getDataFor(auction.owner, height);
  }

  async getDataFor(prevout, height) {
    if (height == null)
      height = -1;

    const entry = await this.chaindb.readCoin(prevout);
    assert(entry);

    // Not provable yet.
    if (height !== -1) {
      if (entry.height >= height)
        return null;
    }

    const {output} = entry;
    const {covenant} = output;

    return covenant.items[1];
  }

  async verifyRenewal(covenant, height) {
    assert(covenant.items.length === 3);

    // We require renewals to commit to a block
    // within the past 6 months, to prove that
    // the user still owns the key. This prevents
    // people from presigning thousands years
    // worth of renewals. The block must be at
    // least 400 blocks back to prevent the
    // possibility of a reorg invalidating the
    // covenant.

    const hash = covenant.items[2].toString('hex');
    const entry = await this.chaindb.getEntry(hash);

    if (!entry)
      return false;

    // Must be main chain.
    if (!await this.chaindb.isMainChain(entry))
      return false;

    // Cannot renew yet.
    if (height < consensus.COINBASE_MATURITY)
      return true;

    // Make sure it's a mature block (unlikely to be reorgd).
    if (entry.height > height - consensus.COINBASE_MATURITY)
      return false;

    // Block committed to must be
    // no older than a 6 months.
    if (entry.height < height - rules.RENEWAL_PERIOD)
      return false;

    return true;
  }

  async connectBlock(block, view, height) {
    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      await this.connect(tx, view, height);
    }
  }

  async validate(tx, height) {
    if (tx.isCoinbase())
      return true;

    const {types} = rules;
    const network = this.network;
    const view = new CoinView();

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type < types.BID
          || covenant.type > types.REVOKE) {
        continue;
      }

      const [name] = covenant.items;
      const nameHash = blake2b.digest(name);
      const auction = await view.getAuction(this, nameHash);

      if (auction.isNull()) {
        assert(covenant.type === types.BID);
        auction.setAuction(name, height);
      }

      if (auction.isClosed(height, network)) {
        if (height >= auction.renewal + rules.RENEWAL_WINDOW) {
          // If we haven't been renewed in a year, start over.
          auction.setAuction(name, height);
        } else if (auction.winner.isNull() && auction.owner.isNull()) {
          // If nobody revealed their bids, start over.
          auction.setAuction(name, height);
        }
      }

      const state = auction.state(height, network);

      // none/redeem -> bid
      if (covenant.type === types.BID) {
        if (state !== states.BIDDING)
          return false;
        continue;
      }

      switch (covenant.type) {
        // bid -> reveal
        case types.REVEAL: {
          if (state > states.REVEAL)
            return false;
          break;
        }
        // reveal -> redeem
        case types.REDEEM: {
          if (state !== states.CLOSED)
            return false;
          break;
        }
        // reveal/register/transfer -> register
        case types.REGISTER: {
          if (state !== states.CLOSED)
            return false;

          if (!auction.winner.isNull()) {
            // Must be the winner in order
            // to register the name record.
            if (!prevout.equals(auction.winner))
              return false;
          }

          // Verify renewal if there is one.
          if (covenant.items.length === 3) {
            if (!await this.verifyRenewal(covenant, height))
              return false;
          }

          break;
        }
        // register -> transfer
        case types.TRANSFER: {
          if (state !== states.CLOSED)
            return false;
          break;
        }
        // transfer -> revoke
        case types.REVOKE: {
          if (state !== states.CLOSED)
            return false;
          break;
        }
      }
    }

    return true;
  }

  async connect(tx, view, height) {
    if (tx.isCoinbase())
      return true;

    const {types} = rules;
    const network = this.network;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type < types.BID
          || covenant.type > types.REVOKE) {
        continue;
      }

      const [name] = covenant.items;
      const nameHash = blake2b.digest(name);
      const auction = await view.getAuction(this, nameHash);

      if (!auction.isNull()) {
        const state = auction.state(height, network);
        if (state === states.CLOSED) {
          if (height >= auction.renewal + rules.RENEWAL_WINDOW) {
            // If we haven't been renewed in a year, start over.
            auction.setAuction(name, height);
          } else if (auction.winner.isNull() && auction.owner.isNull()) {
            // If nobody revealed their bids, start over.
            auction.setAuction(name, height);
          }
        }
      }

      // none/redeem -> bid
      if (covenant.type === types.BID) {
        if (auction.isNull())
          auction.setAuction(name, height);

        const state = auction.state(height, network);

        if (state !== states.BIDDING)
          return false;

        continue;
      }

      assert(i < tx.inputs.length);

      const {prevout} = tx.inputs[i];
      const entry = view.getEntry(prevout);
      const local = auction.isLocal(entry.height);

      const {type} = entry.output.covenant;
      const state = auction.state(height, network);

      switch (covenant.type) {
        // bid -> reveal
        case types.REVEAL: {
          assert(type === types.BID);

          if (!local)
            return false;

          if (state > states.REVEAL)
            return false;

          if (auction.winner.isNull() || output.value > auction.value)
            auction.setWinner(tx.outpoint(i), output.value);

          break;
        }
        // reveal -> redeem
        case types.REDEEM: {
          assert(type === types.REVEAL);

          if (local) {
            if (state !== states.CLOSED)
              return false;
          }

          // Must be the loser in order
          // to redeem the money now.
          if (prevout.equals(auction.winner))
            return false;

          break;
        }
        // reveal/register/transfer -> register
        case types.REGISTER: {
          assert(type === types.REVEAL
            || type === types.REGISTER
            || type === types.TRANSFER);

          if (!local)
            return false;

          if (state !== states.CLOSED)
            return false;

          if (type === types.REVEAL) {
            // Must be the winner in order
            // to register the name record.
            if (!prevout.equals(auction.winner))
              return false;

            // Don't need to store this anymore.
            auction.setWinner(new Outpoint(), 0);
          }

          const [, data] = covenant.items;
          const dataHash = blake2b.digest(data);

          auction.setOwner(tx.outpoint(i));
          auction.setData(dataHash);

          // Verify renewal if there is one.
          if (covenant.items.length === 3) {
            if (!await this.verifyRenewal(covenant, height))
              return false;
            auction.setRenewal(height);
          }

          break;
        }
        // register -> transfer
        case types.TRANSFER: {
          assert(type === types.REGISTER);

          if (!local)
            return false;

          if (state !== states.CLOSED)
            return false;

          auction.setOwner(tx.outpoint(i));

          break;
        }
        // transfer -> revoke
        case types.REVOKE: {
          assert(type === types.TRANSFER);

          if (!local)
            return false;

          if (state !== states.CLOSED)
            return false;

          // Auction starts on the next block.
          auction.setAuction(name, height + 1);

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
