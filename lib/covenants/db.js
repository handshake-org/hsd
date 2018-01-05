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
const {VerifyError} = require('../protocol/errors');
const {encoding} = bio;
const {types, states} = Auction;
const {NULL_HASH} = consensus;

/*
 * Database Layout:
 *   c -> name bucket
 *   t -> trie bucket
 *   a[name-hash] -> auction data
 *   A[hash][index] -> name hash (auction by prevout)
 *   b[name-hash][hash][index] -> bid index (prevout by name hash)
 *   r[name-hash][hash][index] -> reveal value (prevout by name hash)
 *   q[name-hash] -> trie update queue (0 or 1)
 */

const layout = {
  c: bdb.key('c'),
  t: bdb.key('t'),
  a: bdb.key('a', ['hash256']),
  n: bdb.key('n', ['hash256', 'uint32']),
  b: bdb.key('b', ['hash256', 'hash256', 'uint32']),
  r: bdb.key('r', ['hash256', 'hash256', 'uint32']),
  q: bdb.key('q', ['hash256'])
};

const EMPTY = Buffer.alloc(0);
const ZERO = Buffer.from([0]);
const ONE = Buffer.from([1]);

/**
 * NameDB
 */

class NameDB {
  constructor(db, network) {
    this.db = db;
    this.network = network;
    this.bucket = db.bucket(layout.c.build());
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
    const raw = await this.bucket.get(layout.a(nameHash));

    if (!raw)
      return null;

    const auction = Auction.fromRaw(raw);
    auction.nameHash = nameHash;
    return auction;
  }

  async getAuctionHash(prevout) {
    const {hash, index} = prevout;
    return this.bucket.get(layout.n(hash, index));
  }

  async getAuctionFor(prevout) {
    const nameHash = await this.getAuctionHash(prevout);

    if (!nameHash)
      return null;

    return this.getAuction(nameHash);
  }

  async pickWinner(nameHash) {
    const iter = this.bucket.iterator({
      gte: layout.r.min(nameHash),
      lte: layout.r.max(nameHash),
      values: true
    });

    let best = 0;
    let winner = null;

    await iter.each((key, value) => {
      const bid = toU64(value);

      if (bid >= best) {
        const [, hash, index] = layout.r.parse(key);
        winner = new Outpoint(hash, index);
        best = bid;
      }
    });

    return winner;
  }

  async getPendingNames() {
    return this.bucket.keys({
      gte: layout.q.min(),
      lte: layout.q.max(),
      values: true,
      parse: (k, v) => [k.slice(1), v[0] === 1]
    });
  }

  async updateTrie_(trie, batch) {
    const b = batch ? this.bucket.wrap(batch) : null;
    const names = await this.getPendingNames();

    for (const [nameHash, remove] of names) {
      const raw = await this.bucket.get(layout.a.build(nameHash));
      assert(raw);

      if (remove) {
        await trie.remove(nameHash);
      } else {
        const hash = blake2b.digest(raw);
        await trie.insert(nameHash, hash);
      }

      if (b)
        b.del(layout.q.build(nameHash));
    }

    return trie.hash('hex');
  }

  async updateTrie(trie) {
    const names = await this.getPendingNames();

    for (const [nameHash, remove] of names) {
      const raw = await this.bucket.get(layout.a.build(nameHash));
      assert(raw);

      if (remove) {
        await trie.remove(nameHash);
        continue;
      }

      const hash = blake2b.digest(raw);
      await trie.insert(nameHash, hash);
    }

    return trie.hash('hex');
  }

  async clearQueue(batch) {
    const b = this.bucket.wrap(batch);
    const names = await this.getPendingNames();

    for (const [nameHash] of names)
      b.del(layout.q.build(nameHash));
  }

  async getTrieRoot() {
    const trie = this.trie.clone();
    return this.updateTrie(trie);
  }

  async connectBlock_(batch, block) {
    const nameRoot = await this.updateTrie(this.trie, batch);
    const b = this.trieBucket.wrap(batch);

    if (block.trieRoot !== nameRoot) {
      this.trie.clear();
      throw new VerifyError(block, 'invalid', 'invalid-trie-root', 100);
    }

    this.trie.commitTo(b);
  }

  async connectBlock(batch, block) {
    const b = this.trieBucket.wrap(batch);
    this.trie.commitTo(b);
    return this.clearQueue(batch);
  }

  saveView(batch, view) {
    const b = this.bucket.wrap(batch);

    for (const auction of view.auctions.values())
      this.saveAuction(b, auction);
  }

  saveAuction(b, auction) {
    const {nameHash} = auction;

    for (const op of auction.ops) {
      const {hash, index, value} = op;

      switch (op.code) {
        case types.ADD_AUCTION:
          b.put(layout.a.build(nameHash), auction.toRaw());
          break;
        case types.REMOVE_AUCTION:
          b.del(layout.a.build(nameHash));
          break;
        case types.ADD_BID:
          b.put(layout.b.build(nameHash, hash, index), null);
          b.put(layout.n.build(hash, index), nameHash);
          break;
        case types.REMOVE_BID:
          b.del(layout.b.build(nameHash, hash, index));
          b.del(layout.n.build(hash, index));
          break;
        case types.ADD_REVEAL:
          b.put(layout.r.build(nameHash, hash, index), fromU64(value));
          b.put(layout.n.build(hash, index), nameHash);
          break;
        case types.REMOVE_REVEAL:
          b.del(layout.r.build(nameHash, hash, index));
          b.del(layout.n.build(hash, index));
          break;
        case types.ADD_OWNER:
          b.put(layout.n.build(hash, index), nameHash);
          break;
        case types.REMOVE_OWNER:
          b.del(layout.n.build(hash, index));
          break;
        case types.ADD_QUEUE:
          b.put(layout.q.build(nameHash), ZERO);
          break;
        case types.REMOVE_QUEUE:
          b.put(layout.q.build(nameHash), ONE);
          break;
      }
    }

    auction.ops.length = 0;
  }

  async verifyBlock_(block, prev, view) {
    const height = prev.height + 1;

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      if (!await this.connectNames(tx, height, view))
        return false;
    }

    return true;
  }

  async verifyBlock(block, prev, view) {
    const height = prev.height + 1;

    await this.trie.ensure(prev.trieRoot);

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      if (!await this.connectNames(tx, height, view))
        return false;
    }

    if (block.trieRoot !== this.trie.hash('hex'))
      return false;

    return true;
  }

  async verifyTX(tx, height, view) {
    return this.connectNames(tx, height, view);
  }

  async connectNames(tx, height, view) {
    if (this.isCoinbase())
      return true;

    const {types} = rules;
    const network = this.network;
    const hash = tx.hash('hex');

    for (const input of tx.inputs) {
      if (input.link === 0xffffffff)
        continue;

      assert(input.link < tx.outputs.length);

      const {prevout} = input;
      const coin = view.getOutput(prevout);
      assert(coin);
      const uc = coin.covenant;

      const index = input.link;
      const output = tx.outputs[index];
      const {covenant} = output;

      if (uc.type === types.BID) {
        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);

        if (auction.state(height, network) !== states.REVEAL)
          return false;

        auction.removeBid(prevout.hash, prevout.index);
        auction.addReveal(hash, index, output.value);
        auction.save();

        continue;
      }

      if (uc.type === types.REVEAL) {
        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
          return false;

        let owner = auction.owner;

        if (owner.isNull())
          owner = await this.pickWinner(auction.nameHash);

        if (uc.type !== types.UPDATE) {
          // Must be the loser in order
          // to redeem the money now.
          if (prevout.equals(owner))
            return false;
          auction.removeReveal(prevout.hash, prevout.index);
          continue;
        }

        assert(uc.type === types.UPDATE);

        // Must be the winner in order
        // to update the name record.
        if (!prevout.equals(owner))
          return false;

        auction.removeReveal(prevout.hash, prevout.index);
        auction.setOwner(hash, index);
        auction.setData(covenant.items[1]);
        auction.save();
        auction.queue();

        continue;
      }

      if (uc.type === types.UPDATE) {
        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
          return false;

        // Must be the owner to update.
        if (!prevout.equals(auction.owner))
          return false;

        auction.setOwner(hash, index);
        auction.setData(covenant.items[1]);
        auction.save();
        auction.queue();

        continue;
      }
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type === types.BID) {
        const name = covenant.items[0];
        const nameHash = blake2b.digest(name);
        const auction =
          await view.ensureAuction(this, name, nameHash, height);

        if (auction.state(height, network) !== states.BIDDING)
          return false;

        auction.addBid(hash, i);
        auction.save();

        continue;
      }
    }

    return true;
  }

  async disconnectBlock(entry, block, view) {
    const height = entry.height;

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      await this.disconnectNames(tx, height, view);
    }
  }

  async disconnectNames(tx, height, view) {
    const {types} = rules;
    const network = this.network;
    const hash = tx.hash('hex');

    for (let i = tx.outputs.length - 1; i >= 0; i--) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type === types.BID) {
        const nameHash = blake2b.digest(covenant.items[0]);
        const auction = await view.getAuction(this, nameHash);

        assert(auction && auction.height === height);
        assert(auction.state(height, network) === states.BIDDING);

        auction.removeBid(hash, i);
        auction.save();

        if (auction.total() === 0)
          auction.remove();

        continue;
      }
    }

    for (let i = tx.inputs.length - 1; i >= 0; i--) {
      const input = tx.inputs[i];

      if (input.link === 0xffffffff)
        continue;

      assert(input.link < tx.outputs.length);

      const {prevout} = input;
      const coin = view.getOutput(prevout);
      assert(coin);
      const uc = coin.covenant;

      const index = input.link;
      const output = tx.outputs[index];
      const {covenant} = output;

      if (uc.type === types.BID) {
        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);
        assert(auction.state(height, network) === states.REVEAL);

        auction.removeReveal(hash, index);
        auction.save();

        continue;
      }

      if (uc.type === types.REVEAL) {
        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);
        assert(auction.state(height, network) === states.CLOSED);

        if (covenant.type !== types.UPDATE) {
          assert(!prevout.equals(auction.owner));
          auction.addReveal(prevout.hash, prevout.index, coin.value);
          auction.save();
          continue;
        }

        assert(!prevout.equals(auction.owner));

        // Switch back to previous owner and data.
        auction.addReveal(prevout.hash, prevout.index, coin.value);
        auction.setOwner(NULL_HASH, 0xffffffff);
        auction.setData(EMPTY);
        auction.save();
        auction.unqueue();

        continue;
      }

      if (uc.type === types.UPDATE) {
        assert(covenant.type === types.UPDATE);

        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);
        assert(auction.state(height, network) === states.CLOSED);
        assert(!auction.owner.isNull());
        assert(!prevout.equals(auction.owner));
        assert(auction.owner.hash === hash && auction.owner.index === index);

        // Switch back to previous owner and data.
        auction.setOwner(prevout.hash, prevout.index);
        auction.setData(uc.items[1]);
        auction.save();
        auction.queue();

        continue;
      }
    }
  }
}

/*
 * Helpers
 */

function toU64(data) {
  assert(data.length === 8);
  return encoding.readU64(data, 0);
}

function fromU64(value) {
  const data = Buffer.alloc(8);
  encoding.writeU64(data, value, 0);
  return data;
}

/*
 * Expose
 */

module.exports = NameDB;
