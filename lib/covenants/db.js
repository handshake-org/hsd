/*!
 * namedb.js - name database for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const bdb = require('bdb');
const Auction = require('./auction');
const rules = require('./rules');
const AuctionUndo = require('./undo');
const CoinView = require('../coins/coinview');
const HashList = require('../utils/hashlist');
const {states} = Auction;

/*
 * Database Layout:
 *   w -> name bucket
 *   a[name-hash] -> auction data
 *   u[height] -> undo ops
 *   p[name-hash] -> name tree pending list
 *   j[height] -> name tree journal
 *   r[height] -> previous root
 */

const layout = {
  w: bdb.key('w'),
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
    this.logger = chaindb.logger;
    this.bucket = this.db.bucket(layout.w.build());
    this.treeInterval = this.network.names.treeInterval;
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

  async getData(nameHash) {
    const auction = await this.getAuction(nameHash);

    if (!auction)
      return null;

    return auction.data;
  }

  async getDataByName(name, height) {
    return this.getData(rules.hashName(name), height);
  }

  async isAvailable(name, height) {
    const network = this.network;

    if (!rules.isAvailable(name, height, network))
      return false;

    const nameHash = rules.hashName(name);

    return this.isBiddable(nameHash, height);
  }

  async isBiddable(nameHash, height) {
    const network = this.network;
    const auction = await this.getAuction(nameHash);

    if (auction) {
      if (auction.isExpired(height, network))
        auction.setAuction(auction.name, height);

      if (!auction.isBidding(height, network))
        return false;
    }

    return true;
  }

  /*
   * Connecting
   */

  async connect(batch, tree, view, height) {
    const b = this.bucket.wrap(batch);

    for (const auction of view.auctions.values()) {
      const {nameHash} = auction;

      this.applyState(b, auction, auction.ops);

      if (auction.dirty)
        b.put(layout.p.build(nameHash), null);
    }

    this.writeUndo(b, view, height);

    if (height === 1 || (height % this.treeInterval) === 0)
      await this.connectTree(b, tree, height);
  }

  writeUndo(b, view, height) {
    const undo = view.toAuctionUndo();

    if (undo.auctions.length === 0) {
      b.del(layout.u.build(height));
      return;
    }

    b.put(layout.u.build(height), undo.encode());
  }

  async updateTree(b, tree) {
    const updates = new HashList(32);

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
        await tree.insert(nameHash, auction.data);
      else
        await tree.remove(nameHash);

      updates.push(nameHash);

      b.del(key);
    });

    return updates;
  }

  async connectTree(b, tree, height) {
    assert(height === 1 || (height % this.treeInterval) === 0);

    const prev = tree.rootHash();
    const updates = await this.updateTree(b, tree);

    if (updates.length === 0)
      return;

    b.put(layout.j.build(height), updates.encode());
    b.put(layout.r.build(height), prev);
  }

  /*
   * Disconnecting
   */

  async disconnect(batch, tree, view, height) {
    const b = this.bucket.wrap(batch);

    await this.disconnectState(b, view, height);

    if (height === 1 || (height % this.treeInterval) === 0)
      await this.disconnectTree(b, tree, height);
  }

  async disconnectState(b, view, height) {
    const raw = await this.bucket.get(layout.u.build(height));

    if (!raw)
      return;

    const undo = AuctionUndo.decode(raw);

    for (const [nameHash, ops] of undo.auctions) {
      const auction = await view.getAuction(this, nameHash);

      this.applyState(b, auction, ops);
    }

    b.del(layout.u.build(height));
  }

  async unupdateTree(b, tree, height) {
    const iter = this.bucket.iterator({
      gte: layout.p.min(),
      lte: layout.p.max()
    });

    await iter.each(key => b.del(key));

    const prev = await this.bucket.get(layout.r.build(height));

    if (!prev)
      return;

    assert(prev.length === 32);

    await tree.inject(prev);

    b.del(layout.r.build(height));
  }

  async disconnectTree(b, tree, height) {
    assert(height === 1 || (height % this.treeInterval) === 0);

    await this.unupdateTree(b, tree, height);

    const raw = await this.bucket.get(layout.j.build(height));

    if (!raw)
      return;

    const updates = HashList.decode(raw, 32);

    for (const nameHash of updates)
      b.put(layout.p.build(nameHash), null);

    b.del(layout.j.build(height));
  }

  applyState(b, auction, ops) {
    const {nameHash} = auction;

    auction.applyState(ops);

    if (auction.isNull())
      b.del(layout.a.build(nameHash));
    else
      b.put(layout.a.build(nameHash), auction.toRaw());
  }

  async verifyRenewal(blockHash, height) {
    // Cannot renew yet.
    if (height < this.network.names.renewalMaturity)
      return true;

    // We require renewals to commit to a block
    // within the past 6 months, to prove that
    // the user still owns the key. This prevents
    // people from presigning thousands of years
    // worth of renewals. The block must be at
    // least 400 blocks back to prevent the
    // possibility of a reorg invalidating the
    // covenant.

    const hash = blockHash.toString('hex');
    const entry = await this.chaindb.getEntry(hash);

    if (!entry)
      return false;

    // Must be the current chain.
    if (!await this.chaindb.isMainChain(entry))
      return false;

    // Make sure it's a mature block (unlikely to be reorgd).
    if (entry.height > height - this.network.names.renewalMaturity)
      return false;

    // Block committed to must be
    // no older than a 6 months.
    if (entry.height < height - this.network.names.renewalPeriod)
      return false;

    return true;
  }

  async validate(tx, height) {
    const view = new CoinView();
    return this.process(tx, view, height);
  }

  async process(tx, view, height) {
    const [valid, reason] = await this.check(tx, view, height);

    if (!valid) {
      this.logger.debug(
        'Invalid covenant for %s (%d): %s.',
        tx.hash('hex'),
        height,
        reason);
    }

    return valid;
  }

  async check(tx, view, height) {
    if (tx.isCoinbase())
      return [true, 'valid'];

    const {types} = rules;
    const network = this.network;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      if (covenant.type < types.CLAIM
          || covenant.type > types.REVOKE) {
        continue;
      }

      const nameHash = covenant.items[0];
      const auction = await view.getAuction(this, nameHash);

      if (auction.isNull()) {
        switch (covenant.type) {
          case types.CLAIM:
          case types.BID:
            break;
          default:
            throw new Error('Database inconsistency.');
        }
        const name = covenant.items[1];
        auction.setAuction(name, height);
      }

      if (auction.isExpired(height, network))
        auction.setAuction(auction.name, height);

      const state = auction.state(height, network);

      // none/redeem -> claim
      if (covenant.type === types.CLAIM) {
        const name = covenant.items[1];

        if (state !== states.BIDDING)
          return [false, 'bad-claim-state'];

        if (network.names.noReserved && height === 0) {
          ; // nothing
        } else {
          // Can only claim reserved names.
          if (!rules.isReserved(name, height, network))
            return [false, 'bad-claim-notreserved'];
        }

        auction.setClaimed(true);
        auction.setValue(output.value);
        auction.setOwner(tx.outpoint(i));
        auction.setHighest(output.value);

        continue;
      }

      // none/redeem -> bid
      if (covenant.type === types.BID) {
        const name = covenant.items[1];

        if (height < network.names.auctionStart)
          return [false, 'bad-auction-height'];

        if (state !== states.BIDDING)
          return [false, 'bad-bid-state'];

        // Cannot bid on a reserved name.
        if (rules.isReserved(name, height, network))
          return [false, 'bad-bid-reserved'];

        // On mainnet, names are released on a
        // weekly basis for the first year.
        if (!rules.verifyHashRollout(nameHash, height, network))
          return [false, 'bad-bid-rollout'];

        continue;
      }

      assert(i < tx.inputs.length);

      const {prevout} = tx.inputs[i];
      const local = auction.isLocal(view, prevout);

      switch (covenant.type) {
        // bid -> reveal
        case types.REVEAL: {
          if (!local)
            return [false, 'bad-reveal-nonlocal'];

          // Allow early reveals.
          if (state > states.REVEAL)
            return [false, 'bad-reveal-state'];

          if (output.value > auction.highest) {
            auction.setValue(auction.highest);
            auction.setOwner(tx.outpoint(i));
            auction.setHighest(output.value);
          } else if (output.value > auction.value) {
            auction.setValue(output.value);
          }

          break;
        }

        // reveal -> redeem
        case types.REDEEM: {
          if (!local)
            return [false, 'bad-redeem-nonlocal'];

          // Allow participants to get their
          // money out, even in a revoked state.
          if (state < states.CLOSED)
            return [false, 'bad-redeem-state'];

          // Must be the loser in order
          // to redeem the money now.
          if (prevout.equals(auction.owner))
            return [false, 'bad-redeem-owner'];

          break;
        }

        // claim/reveal -> register
        case types.REGISTER: {
          if (!local)
            return [false, 'bad-register-nonlocal'];

          if (state !== states.CLOSED)
            return [false, 'bad-register-state'];

          const data = covenant.items[1];
          const hash = covenant.items[2];

          // Verify block hash for renewal.
          if (!await this.verifyRenewal(hash, height))
            return [false, 'bad-register-renewal'];

          // Must be the winner in
          // order to redeem the name.
          if (!prevout.equals(auction.owner))
            return [false, 'bad-register-owner'];

          // If we didn't have a second
          // bidder, use our own bid.
          if (auction.value === -1) {
            assert(auction.highest !== -1);
            auction.setValue(auction.highest);
          }

          // Must match the second highest bid.
          if (output.value !== auction.value)
            return [false, 'bad-register-value'];

          auction.setOwner(tx.outpoint(i));

          if (data.length > 0)
            auction.setData(data);

          auction.setRenewal(height);

          break;
        }

        // update/register/finalize -> update
        case types.UPDATE: {
          if (!local)
            return [false, 'bad-update-nonlocal'];

          if (state !== states.CLOSED)
            return [false, 'bad-update-state'];

          const data = covenant.items[1];

          auction.setOwner(tx.outpoint(i));

          if (auction.transfer !== -1)
            auction.setTransfer(-1);

          if (data.length > 0)
            auction.setData(data);

          // Verify renewal if there is one.
          if (covenant.items.length === 3) {
            const hash = covenant.items[2];

            if (!await this.verifyRenewal(hash, height))
              return [false, 'bad-update-renewal'];

            auction.setRenewal(height);
          }

          break;
        }

        // update/register/finalize -> transfer
        case types.TRANSFER: {
          if (!local)
            return [false, 'bad-transfer-nonlocal'];

          if (state !== states.CLOSED)
            return [false, 'bad-transfer-state'];

          auction.setOwner(tx.outpoint(i));

          assert(auction.transfer === -1);
          auction.setTransfer(height);

          // Verify renewal if there is one.
          if (covenant.items.length === 3) {
            const hash = covenant.items[2];

            if (!await this.verifyRenewal(hash, height))
              return [false, 'bad-transfer-renewal'];

            auction.setRenewal(height);
          }

          break;
        }

        // transfer -> finalize
        case types.FINALIZE: {
          if (!local)
            return [false, 'bad-finalize-nonlocal'];

          if (state !== states.CLOSED)
            return [false, 'bad-finalize-state'];

          assert(auction.transfer !== -1);

          if (height < auction.transfer + network.names.transferLockup)
            return [false, 'bad-finalize-maturity'];

          auction.setOwner(tx.outpoint(i));
          auction.setTransfer(-1);

          // Verify renewal if there is one.
          if (covenant.items.length === 2) {
            const hash = covenant.items[1];

            if (!await this.verifyRenewal(hash, height))
              return [false, 'bad-finalize-renewal'];

            auction.setRenewal(height);
          }

          break;
        }

        // register/update/transfer/finalize -> revoke
        case types.REVOKE: {
          if (!local)
            return [false, 'bad-revoke-nonlocal'];

          if (state !== states.CLOSED)
            return [false, 'bad-revoke-state'];

          assert(auction.revoked === -1);
          auction.setRevoked(height);
          auction.setData(null);

          break;
        }
      }
    }

    return [true, 'valid'];
  }
}

/*
 * Expose
 */

module.exports = NameDB;
