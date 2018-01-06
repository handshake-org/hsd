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
 *   n[hash][index] -> name hash (auction by prevout)
 *   b[name-hash][hash][index] -> bid index (prevout by name hash)
 *   r[name-hash][hash][index] -> reveal value (prevout by name hash)
 */

const layout = {
  c: bdb.key('c'),
  t: bdb.key('t'),
  a: bdb.key('a', ['hash256']),
  n: bdb.key('n', ['hash256', 'uint32']),
  b: bdb.key('b', ['hash256', 'hash256', 'uint32']),
  r: bdb.key('r', ['hash256', 'hash256', 'uint32'])
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
    const raw = await this.bucket.get(layout.a.build(nameHash));

    if (!raw)
      return null;

    const auction = Auction.fromRaw(raw);
    auction.nameHash = nameHash;
    return auction;
  }

  async getAuctionHash(prevout) {
    const {hash, index} = prevout;
    return this.bucket.get(layout.n.build(hash, index));
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

  getTrieRoot() {
    return this.trie.hash('hex');
  }

  async connectBlock(batch, block) {
    const b = this.trieBucket.wrap(batch);
    this.trie.commitTo(b);
  }

  async saveView(batch, view) {
    const b = this.bucket.wrap(batch);

    for (const auction of view.auctions.values())
      await this.saveAuction(b, auction);
  }

  async saveAuction(b, auction) {
    const {nameHash} = auction;

    for (const op of auction.ops) {
      const {hash, index, value} = op;

      switch (op.type) {
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
          await this.trie.insert(nameHash, auction.toRaw());
          break;
        case types.REMOVE_QUEUE:
          await this.trie.remove(nameHash);
          break;
      }
    }

    auction.ops.length = 0;
  }

  async verifyBlock(block, prev, view) {
    const height = prev.height + 1;

    if (block.trieRoot !== this.trie.hash('hex'))
      return false;

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      if (!await this.connectNames(tx, height, view))
        return false;
    }

    return true;
  }

  async verifyTX(tx, height, view) {
    return this.connectNames(tx, height, view);
  }

  async connectNames(tx, height, view) {
    if (tx.isCoinbase())
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
      const uc = coin.covenant;

      const index = input.link;
      const output = tx.outputs[index];
      const {covenant} = output;

      if (uc.type === types.BID) {
        assert(covenant.type === types.REVEAL);

        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);

        if (auction.state(height, network) > states.REVEAL)
          return false;

        auction.removeBid(prevout.hash, prevout.index);
        auction.addReveal(hash, index, output.value);
        auction.save();

        continue;
      }

      if (uc.type === types.REVEAL) {
        assert(covenant.type === types.REDEEM
          || covenant.type === types.UPDATE
          || covenant.type === types.RELEASE);

        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
          return false;

        let owner = auction.owner;

        if (owner.isNull())
          owner = await this.pickWinner(auction.nameHash);

        if (covenant.type === types.REDEEM) {
          // Must be the loser in order
          // to redeem the money now.
          if (prevout.equals(owner))
            return false;
          auction.removeReveal(prevout.hash, prevout.index);
          continue;
        }

        // Must be the winner in order
        // to update the name record.
        if (!prevout.equals(owner))
          return false;

        auction.removeReveal(prevout.hash, prevout.index);

        if (covenant.type === types.UPDATE) {
          auction.setOwner(hash, index);
          auction.setData(covenant.items[1]);
          auction.save();
          auction.queue();
        } else {
          auction.remove();
        }

        continue;
      }

      if (uc.type === types.UPDATE) {
        assert(covenant.type === types.UPDATE
          || covenant.type === types.RELEASE);

        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
          return false;

        // Must be the owner to update.
        if (!prevout.equals(auction.owner))
          return false;

        if (covenant.type === types.UPDATE) {
          auction.setOwner(hash, index);
          auction.setData(covenant.items[1]);
          auction.save();
          auction.queue();
        } else {
          auction.remove();
          auction.unqueue();
        }

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

        if (!auction.owner.isNull())
          return false;

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
        assert(covenant.type === types.REVEAL);

        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);
        assert(auction.state(height, network) <= states.REVEAL);

        auction.removeReveal(hash, index);
        auction.save();

        continue;
      }

      if (uc.type === types.REVEAL) {
        assert(covenant.type === types.REDEEM
          || covenant.type === types.UPDATE
          || covenant.type === types.RELEASE);

        // XXX Figure out what to do here:
        // Add a `released` property to auction object!
        assert(covenant.type !== types.RELEASE);

        const auction = await view.getAuctionFor(this, prevout);
        assert(auction);
        assert(auction.state(height, network) === states.CLOSED);

        if (covenant.type === types.REDEEM) {
          assert(!prevout.equals(auction.owner));
          auction.addReveal(prevout.hash, prevout.index, coin.value);
          auction.save();
          continue;
        }

        assert(prevout.equals(auction.owner));

        // Switch back to previous owner and data.
        auction.addReveal(prevout.hash, prevout.index, coin.value);
        auction.setOwner(NULL_HASH, 0xffffffff);
        auction.setData(EMPTY);
        auction.save();
        auction.unqueue();

        continue;
      }

      if (uc.type === types.UPDATE) {
        assert(covenant.type === types.UPDATE
          || covenant.type === types.RELEASE);

        // XXX Figure out what to do here:
        // Add a `released` property to auction object!
        assert(covenant.type !== types.RELEASE);

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
