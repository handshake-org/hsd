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
 *   n[hash][index] -> name hash (auction by prevout)
 *   r[name-hash][hash][index] -> reveal value (prevout by name hash)
 *   u[hash][index] -> undo record for auction
 *   k[hash][index] -> undo record for renewal height
 */

const layout = {
  c: bdb.key('c'),
  t: bdb.key('t'),
  a: bdb.key('a', ['hash256']),
  n: bdb.key('n', ['hash256', 'uint32']),
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

  async pickWinner(nameHash, auctionHeight) {
    const iter = this.bucket.iterator({
      gte: layout.r.min(nameHash),
      lte: layout.r.max(nameHash),
      values: true
    });

    let best = 0;
    let winner = null;

    await iter.each((key, value) => {
      const {value, height} = fromReveal(value);

      if (auctionHeight > height)
        return;

      if (bid >= best) {
        const [, hash, index] = layout.r.parse(key);
        winner = new Outpoint(hash, index);
        best = bid;
      }
    });

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

  async getRecord(key) {
    const auction = await this.getAuction(key);

    if (!auction || auction.owner.isNull())
      return null;

    const entry = await this.chaindb.readCoin(auction.owner);
    assert(entry);

    // Not provable yet.
    // if (entry.height === height)
    //   return null;

    const {output} = entry;
    const {covenant} = output;

    return covenant.items[1];
  }

  async connect(tx, height, view) {
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

      let output = null;
      let covenant = null;
      let outpoint = null;

      if (i < tx.outputs.length) {
        output = tx.outputs[i];
        covenant = output.covenant;
        outpoint = new Outpoint(hash, i);
      }

      if (uc.type === types.NONE)
        continue;

      if (uc.type === types.BID) {
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);

        if (auction.state(height, network) > states.REVEAL)
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
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
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
          // reveal -> update
          case types.UPDATE: {
            // Must be the winner in order
            // to update the name record.
            if (!prevout.equals(winner))
              return false;

            auction.removeReveal(prevout);
            auction.owner = outpoint;
            auction.renewal = height;
            auction.commit(covenant.items[1]);
            auction.save();

            break;
          }
          // reveal -> transfer
          case types.TRANSFER: {
            // Must be the winner in order
            // to update the name record.
            if (!prevout.equals(winner))
              return false;

            auction.removeReveal(prevout);
            // XXX Need to set owner here.
            // auction.owner = owner;
            auction.renewal = height;
            auction.save();

            break;
          }
          // reveal -> release
          case types.RELEASE: {
            // Must be the winner in order
            // to update the name record.
            if (!prevout.equals(winner))
              return false;

            auction.removeReveal(prevout);
            auction.addUndo(prevout);
            auction.setNull();

            break;
          }
          default: {
            assert(false);
            break;
          }
        }

        continue;
      }

      if (uc.type === types.UPDATE) {
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
          return false;

        // Must be the owner to update.
        assert(prevout.equals(auction.owner));

        switch (covenant.type) {
          // update -> update
          case types.UPDATE: {
            auction.owner = outpoint;
            auction.commit(covenant.items[1]);

            // Renewal!
            if (covenant.items.length === 3) {
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

              auction.addRenewal(prevout);
              auction.renewal = height;
            }

            auction.save();
          }
          // update -> transfer
          case types.TRANSFER: {
            break;
          }
          // update -> release
          case types.RELEASE: {
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

      if (uc.type === types.TRANSFER) {
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);

        if (auction.state(height, network) !== states.CLOSED)
          return false;

        switch (covenant.type) {
          // transfer -> update
          case types.UPDATE: {
            auction.owner = outpoint;
            auction.commit(covenant.items[1]);
            auction.save();
            break;
          }
          // transfer -> release
          case types.RELEASE: {
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

      // Should not be a release.
      assert(uc.type > rules.MAX_COVENANT_TYPE);
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type === types.BID) {
        const name = covenant.items[0];
        const nameHash = blake2b.digest(name);
        const outpoint = new Outpoint(hash, i);

        // On mainnet, names are released on a
        // weekly basis for the first year.
        if (this.network.type === 'main') {
          const start = (nameHash[0] % 52) * rules.ROLLOUT_INTERVAL;

          if (height < start)
            return false;
        }

        const auction =
          await view.ensureAuction(this, name, nameHash, height);

        // If we haven't been renewed in a year, start over.
        // Treat this like a release.
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

        if (auction.state(height, network) !== states.BIDDING)
          return false;

        auction.bids += 1;
        auction.save();

        continue;
      }
    }

    return true;
  }

  async disconnect(tx, height, view) {
    const {types} = rules;
    const network = this.network;
    const hash = tx.hash('hex');

    for (let i = tx.outputs.length - 1; i >= 0; i--) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type === types.BID) {
        const outpoint = new Outpoint(hash, i);
        const nameHash = blake2b.digest(covenant.items[0]);
        const auction = await view.getAuction(this, nameHash);

        assert(auction && auction.height === height);
        assert(auction.state(height, network) === states.BIDDING);

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
            if (!auction.owner.isNull())
              auction.commit();
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

      let output = null;
      let covenant = null;
      let outpoint = null;

      if (i < tx.outputs.length) {
        output = tx.outputs[i];
        covenant = output.covenant;
        outpoint = new Outpoint(hash, i);
      }

      if (uc.type === types.NONE)
        continue;

      if (uc.type === types.BID) {
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);
        assert(auction.state(height, network) <= states.REVEAL);

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
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);

        switch (covenant.type) {
          // reveal <- redeem
          case types.REDEEM: {
            assert(auction.state(height, network) === states.CLOSED);
            assert(!auction.owner.equals(outpoint));
            auction.addReveal(prevout, coin.value, entry.height);
            break;
          }
          // reveal <- update
          case types.UPDATE: {
            assert(auction.state(height, network) === states.CLOSED);
            assert(auction.owner.equals(outpoint));
            auction.addReveal(prevout, coin.value, entry.height);
            auction.owner = new Outpoint();
            auction.renewal = auction.height;
            auction.uncommit();
            auction.save();
            break;
          }
          // reveal <- transfer
          case types.TRANSFER: {
            assert(auction.state(height, network) === states.CLOSED);
            auction.addReveal(prevout, coin.value, entry.height);
            auction.renewal = auction.height;
            auction.save();
            break;
          }
          // reveal <- release
          case types.RELEASE: {
            assert(auction.isNull());
            const undo = await this.getUndo(prevout);
            auction.removeUndo(prevout);
            assert(auction.owner.isNull());
            auction.addReveal(prevout, coin.value, entry.height);
            auction.height = undo.height;
            auction.renewal = undo.renewal;
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

      if (uc.type === types.UPDATE) {
        const auction = await view.getAuctionFor(this, prevout);

        assert(output);
        assert(auction);
        assert(auction.state(height, network) === states.CLOSED);

        switch (covenant.type) {
          // update <- update
          case types.UPDATE: {
            // Switch back to previous owner and data.
            assert(auction.owner.equals(outpoint));

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
          // update <- transfer
          case types.TRANSFER: {
            break;
          }
          // update <- release
          case types.RELEASE: {
            const undo = await this.getUndo(prevout);

            assert(undo);
            assert(auction.isNull());

            auction.removeUndo(prevout);
            auction.owner = prevout;
            auction.commit(uc.items[1]);
            auction.height = undo.height;
            auction.renewal = undo.renewal;
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

      // Should not be a release.
      assert(uc.type > rules.MAX_COVENANT_TYPE);
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
    height: data.readUInt32LE(0, true);
  ];
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
