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
const {encoding} = bio;
const {types, states} = Auction;

/*
 * Database Layout:
 *   c -> name bucket
 *   t -> trie bucket
 *   a[name-hash] -> auction data
 *   r[name-hash][hash][index] -> reveal value (prevout by name hash)
 *   u[hash][index] -> undo record for auction
 *   k[hash][index] -> undo record for renewal height
 */

const layout = {
  c: bdb.key('c'),
  t: bdb.key('t'),
  a: bdb.key('a', ['hash256']),
  r: bdb.key('r', ['hash256', 'hash256', 'uint32']),
  u: bdb.key('u', ['hash256', 'uint32']),
  k: bdb.key('k', ['hash256', 'uint32'])
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

  async pickWinner(nameHash, auctionHeight) {
    const iter = this.bucket.iterator({
      gte: layout.r.min(nameHash),
      lte: layout.r.max(nameHash),
      values: true
    });

    let best = 0;
    let winner = null;

    await iter.each((key, data) => {
      const {value, height} = fromReveal(data);

      if (auctionHeight > height)
        return;

      if (value >= best) {
        const [, hash, index] = layout.r.parse(key);
        winner = new Outpoint(hash, index);
        best = value;
      }
    });

    if (!winner)
      throw new Error('Could not find winner.');

    return winner;
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

  async getUndoRenewal(prevout) {
    assert(prevout instanceof Outpoint);

    const {hash, index} = prevout;
    const raw = await this.bucket.get(layout.k.build(hash, index));

    if (!raw)
      return null;

    return fromRenewal(raw);
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
      await this.saveAuction(b, auction, view);
  }

  async saveAuction(b, auction, view) {
    const {nameHash} = auction;

    for (const {type, params} of auction.ops) {
      switch (type) {
        case types.ADD_AUCTION: {
          b.put(layout.a.build(nameHash), auction.toRaw());
          break;
        }
        case types.REMOVE_AUCTION: {
          b.del(layout.a.build(nameHash));
          break;
        }
        case types.ADD_REVEAL: {
          const [{hash, index}, value, height] = params;
          b.put(layout.r.build(nameHash, hash, index), toReveal(value, height));
          break;
        }
        case types.REMOVE_REVEAL: {
          const [{hash, index}] = params;
          b.del(layout.r.build(nameHash, hash, index));
          break;
        }
        case types.COMMIT: {
          const [data] = params;
          const hash = blake2b.digest(data);
          await this.trie.insert(nameHash, hash);
          break;
        }
        case types.UNCOMMIT: {
          await this.trie.remove(nameHash);
          break;
        }
        case types.ADD_UNDO: {
          const [{hash, index}, raw] = params;
          b.put(layout.u.build(hash, index), raw);
          break;
        }
        case types.REMOVE_UNDO: {
          const [{hash, index}] = params;
          b.del(layout.u.build(hash, index));
          break;
        }
        case types.ADD_RENEWAL: {
          const [{hash, index}, height] = params;
          b.put(layout.k.build(hash, index), toRenewal(height));
          break;
        }
        case types.REMOVE_RENEWAL: {
          const [{hash, index}] = params;
          b.del(layout.k.build(hash, index));
          break;
        }
      }
    }

    auction.ops.length = 0;
  }

  async getData(key, height) {
    const auction = await this.getAuction(key);

    if (!auction || auction.owner.isNull())
      return null;

    return this.getDataFor(auction.owner, height);
  }

  async readCoin(db, prevout) {
    return this.chaindb.readCoin(db, prevout);
  }

  async getDataFor(prevout, height) {
    if (height == null)
      height = -1;

    const entry = await this.chaindb.readCoin(prevout);
    assert(entry);

    // Not provable yet.
    if (height !== -1) {
      if (entry.height === height)
        return null;
    }

    const {output} = entry;
    const {covenant} = output;

    return covenant.items[1];
  }

  async verifyRenewal(covenant, height) {
    if (covenant.items.length !== 3)
      return false;

    const hash = covenant.items[2].toString('hex');
    const entry = await this.chaindb.getEntry(hash);

    if (!entry)
      return false;

    // Must be main chain.
    if (!await this.chaindb.isMainChain(entry))
      return false;

    // Make sure it's a mature block (unlikely to be reorgd).
    if (entry.height > height - consensus.COINBASE_MATURITY)
      return false;

    // Block committed to must be
    // no older than a 6 months.
    if (entry.height < height - rules.RENEWAL_PERIOD)
      return false;

    return true;
  }

  async connect(tx, view, height) {
    if (tx.isCoinbase())
      return true;

    const {types} = rules;
    const network = this.network;
    const hash = tx.hash('hex');

    for (let i = 0; i < tx.inputs.length; i++) {
      const {prevout} = tx.inputs[i];
      const entry = view.getEntry(prevout);
      const coin = entry.output;
      const uc = coin.covenant;

      if (uc.type === types.NONE)
        continue;

      if (uc.type > rules.MAX_COVENANT_TYPE)
        continue;

      assert(i < tx.outputs.length);

      const output = tx.outputs[i];
      const {covenant} = output;
      const outpoint = new Outpoint(hash, i);
      const auction = await view.getAuctionByName(this, uc.items[0]);
      const state = auction.state(height, network);

      if (uc.type === types.BID) {
        if (state > states.REVEAL)
          return false;

        if (auction.height > entry.height)
          return false;

        switch (covenant.type) {
          // bid -> reveal
          case types.REVEAL: {
            auction.bids -= 1;
            auction.addReveal(outpoint, output.value, entry.height);
            auction.save();
            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      if (uc.type === types.REVEAL) {
        if (state !== states.CLOSED)
          return false;

        if (auction.height > entry.height)
          return false;

        let winner = auction.owner;

        if (winner.isNull())
          winner = await this.pickWinner(auction.nameHash, auction.height);

        switch (covenant.type) {
          // reveal -> redeem
          case types.REDEEM: {
            // Must be the loser in order
            // to redeem the money now.
            if (prevout.equals(winner))
              return false;

            auction.removeReveal(prevout);

            break;
          }
          // reveal -> register
          case types.REGISTER: {
            // Must be the winner in order
            // to register the name record.
            if (!prevout.equals(winner))
              return false;

            auction.removeReveal(prevout);
            auction.owner = outpoint;
            auction.renewal = height;
            auction.commit(covenant.items[1]);
            auction.save();

            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      if (uc.type === types.REGISTER) {
        if (state !== states.CLOSED)
          return false;

        if (auction.height > entry.height)
          return false;

        // Must be the owner to register.
        assert(prevout.equals(auction.owner));

        switch (covenant.type) {
          // register -> register
          case types.REGISTER: {
            auction.owner = outpoint;
            auction.commit(covenant.items[1]);

            // Renewal!
            if (covenant.items.length === 3) {
              if (!await this.verifyRenewal(covenant, height))
                return false;
              auction.addRenewal(prevout);
              auction.renewal = height;
            }

            auction.save();

            break;
          }
          // register -> transfer
          case types.TRANSFER: {
            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      if (uc.type === types.TRANSFER) {
        if (state !== states.CLOSED)
          return false;

        if (auction.height > entry.height)
          return false;

        switch (covenant.type) {
          // transfer -> register
          case types.REGISTER: {
            auction.addUndo(prevout);
            auction.owner = outpoint;
            auction.commit(covenant.items[1]);

            // Renewal!
            if (covenant.items.length === 3) {
              if (!await this.verifyRenewal(covenant, height))
                return false;
              auction.renewal = height;
            }

            auction.save();

            break;
          }
          // transfer -> revoke
          case types.REVOKE: {
            auction.addUndo(prevout);
            auction.setNull();
            auction.save();
            auction.uncommit();
            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      // Should not be a REVOKE.
      assert(false);
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type === types.BID) {
        const name = covenant.items[0];
        const outpoint = new Outpoint(hash, i);

        // On mainnet, names are released on a
        // weekly basis for the first year.
        if (this.network.type === 'main') {
          const week = blake2b.digest(name)[0] % 52;
          const start = week * rules.ROLLOUT_INTERVAL;

          if (height < start)
            return false;
        }

        const auction = await view.ensureAuction(this, name, height);

        // If we haven't been renewed in a year, start over.
        if (height >= auction.renewal + rules.RENEWAL_WINDOW) {
          const index = (i | 0x80000000) >>> 0;
          const prevout = new Outpoint(hash, index);
          auction.addUndo(prevout);
          if (!auction.owner.isNull())
            auction.uncommit();
          auction.owner = new Outpoint();
          auction.height = height;
          auction.renewal = height;
          auction.bids = 0;
        }

        const state = auction.state(height, network);

        if (state !== states.BIDDING)
          return false;

        auction.bids += 1;
        auction.save();

        continue;
      }
    }

    return true;
  }

  async disconnect(tx, view, height) {
    const {types} = rules;
    const network = this.network;
    const hash = tx.hash('hex');

    for (let i = tx.outputs.length - 1; i >= 0; i--) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type === types.BID) {
        const outpoint = new Outpoint(hash, i);
        const auction = await view.getAuctionByName(this, covenant.items[0]);
        const state = auction.state(height, network);

        assert(state === states.BIDDING);

        auction.bids -= 1;

        if (auction.bids === 0) {
          const index = (i | 0x80000000) >>> 0;
          const prevout = new Outpoint(hash, index);
          const undo = await this.getUndo(prevout);
          if (undo) {
            auction.removeUndo(prevout);
            auction.owner = undo.owner;
            auction.height = undo.height;
            auction.renewal = undo.renewal;
            auction.bids = undo.bids;
            // May have been in a reveal state.
            if (!auction.owner.isNull()) {
              const data = await view.getDataFor(this, auction.owner);
              assert(data);
              auction.commit(data);
            }
            auction.save();
          } else {
            auction.remove();
          }
        } else {
          auction.save();
        }

        continue;
      }
    }

    for (let i = tx.inputs.length - 1; i >= 0; i--) {
      const {prevout} = tx.inputs[i];
      const coin = view.getOutput(prevout);
      const uc = coin.covenant;

      if (uc.type === types.NONE)
        continue;

      if (uc.type > rules.MAX_COVENANT_TYPE)
        continue;

      assert(i < tx.outputs.length);

      const output = tx.outputs[i];
      const {covenant} = output;
      const outpoint = new Outpoint(hash, i);
      const auction = await view.getAuctionByName(this, uc.items[0]);
      const state = auction.state(height, network);

      if (uc.type === types.BID) {
        assert(!auction.isNull());
        assert(state <= states.REVEAL);
        switch (covenant.type) {
          // bid <- reveal
          case types.REVEAL: {
            auction.removeReveal(outpoint);
            break;
          }
          default: {
            assert(false);
            break;
          }
        }
        continue;
      }

      if (uc.type === types.REVEAL) {
        assert(!auction.isNull());
        switch (covenant.type) {
          // reveal <- redeem
          case types.REDEEM: {
            assert(state === states.CLOSED);
            assert(!auction.owner.equals(outpoint));
            auction.addReveal(prevout, coin.value, entry.height);
            break;
          }
          // reveal <- register
          case types.REGISTER: {
            assert(state === states.CLOSED);
            assert(auction.owner.equals(outpoint));
            auction.addReveal(prevout, coin.value, entry.height);
            auction.owner = new Outpoint();
            auction.renewal = auction.height;
            auction.uncommit();
            auction.save();
            break;
          }
          default: {
            assert(false);
            break;
          }
        }
        continue;
      }

      if (uc.type === types.REGISTER) {
        assert(!auction.isNull());
        assert(state === states.CLOSED);

        switch (covenant.type) {
          // register <- register
          case types.REGISTER: {
            assert(auction.owner.equals(outpoint));

            // Switch back to previous owner and data.
            auction.owner = prevout;
            auction.commit(uc.items[1]);

            // Renewal!
            if (uc.items.length === 3) {
              const undo = await this.getUndoRenewal(prevout);
              assert(undo !== -1);
              auction.removeRenewal(prevout);
              auction.renewal = undo;
            }

            auction.save();

            break;
          }
          // register <- transfer
          case types.TRANSFER: {
            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      if (uc.type === types.TRANSFER) {
        assert(state === states.CLOSED);
        switch (covenant.type) {
          // transfer <- register
          case types.REGISTER: {
            const undo = await this.getUndo(prevout);

            assert(!auction.isNull());
            assert(auction.owner.equals(outpoint));
            assert(undo);

            // Switch back to previous owner and data.
            auction.removeUndo(prevout);
            auction.owner = undo.owner;
            auction.renewal = undo.renewal;
            auction.commit(uc.data[1]);

            auction.save();

            break;
          }
          // transfer <- revoke
          case types.REVOKE: {
            const undo = await this.getUndo(prevout);

            assert(auction.isNull());
            assert(undo);

            // Switch back to previous owner and data.
            auction.removeUndo(prevout);
            auction.owner = undo.owner;
            auction.height = undo.height;
            auction.renewal = undo.renewal;
            auction.commit(uc.data[1]);
            auction.save();

            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      // Should not be a REVOKE.
      assert(false);
    }
  }
}

/*
 * Helpers
 */

function fromRenewal(data) {
  assert(data.length === 4);
  return data.readUInt32LE(0, true);
}

function toRenewal(value) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value, 0, true);
  return data;
}

function fromReveal(data) {
  assert(data.length === 12);
  return {
    value: encoding.readU64(data, 0),
    height: data.readUInt32LE(0, true)
  };
}

function toReveal(value, height) {
  const data = Buffer.alloc(12);
  encoding.writeU64(data, value, 0);
  data.writeUInt32LE(height, 8, true);
  return data;
}

/*
 * Expose
 */

module.exports = NameDB;
