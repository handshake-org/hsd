/*!
 * auctionstate.js - mempool auction-state handling for hskd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const rules = require('../covenants/rules');
const Auction = require('../covenants/auction');
const CoinView = require('../coins/coinview');
const {types} = rules;
const {states} = Auction;

/*
 * Auction State
 */

class AuctionState {
  constructor(network) {
    assert(network);

    // Current network.
    this.network = network;

    // Reference counter.
    this.names = new Map();

    // Map of nameHash->set-of-txids.
    this.bids = new Map();

    // Map of nameHash->set-of-txids.
    this.reveals = new Map();

    // Map of nameHash->set-of-txids.
    this.updates = new Map();

    // Current on-chain state
    // of all watched auctions.
    this.view = new CoinView();
    this.auctions = this.view.auctions;
  }

  clear() {
    this.names.clear();
    this.bids.clear();
    this.reveals.clear();
    this.auctions.clear();
    return this;
  }

  addMap(map, nameHash, hash) {
    let set = map.get(nameHash);

    if (!set) {
      set = new Set();
      map.set(nameHash, set);
    }

    set.add(hash);

    return this;
  }

  removeMap(map, nameHash, hash) {
    const set = map.get(nameHash);

    if (!set)
      return this;

    set.delete(hash);

    if (set.size === 0)
      map.delete(nameHash);

    return this;
  }

  addBid(nameHash, hash) {
    return this.addMap(this.bids, nameHash, hash);
  }

  removeBid(nameHash, hash) {
    return this.removeMap(this.bids, nameHash, hash);
  }

  addReveal(nameHash, hash) {
    return this.addMap(this.reveals, nameHash, hash);
  }

  removeReveal(nameHash, hash) {
    return this.removeMap(this.reveals, nameHash, hash);
  }

  addUpdate(nameHash, hash) {
    return this.addMap(this.updates, nameHash, hash);
  }

  removeUpdate(nameHash, hash) {
    return this.removeMap(this.updates, nameHash, hash);
  }

  reference(nameHash) {
    let count = this.names.get(nameHash);

    if (count == null)
      count = 0;

    count += 1;

    this.names.set(nameHash, count);

    return this;
  }

  dereference(nameHash) {
    let count = this.names.get(nameHash);

    if (count == null)
      return this;

    count -= 1;

    assert(count >= 0);

    if (count === 0) {
      this.names.delete(nameHash);
      this.auctions.delete(nameHash);
      return this;
    }

    this.names.set(nameHash, count);

    return this;
  }

  track(tx, view) {
    const hash = tx.hash('hex');

    if (view.auctions.size === 0)
      return this;

    for (const {covenant} of tx.outputs) {
      if (covenant.type < types.CLAIM
          || covenant.type > types.REVOKE) {
        continue;
      }

      const nameHash = covenant.items[0].toString('hex');

      switch (covenant.type) {
        case types.BID:
          this.addBid(nameHash, hash);
          break;
        case types.REVEAL:
        case types.CLAIM:
          this.addReveal(nameHash, hash);
          break;
        default:
          // redeem, register, update,
          // transfer, finalize, revoke
          this.addUpdate(nameHash, hash);
          break;
      }
    }

    for (const [nameHash, auction] of view.auctions) {
      this.reference(nameHash);

      if (this.auctions.has(nameHash))
        continue;

      const state = auction.clone();

      // We want the on-chain state.
      if (auction.undo.length > 0) {
        const undo = auction.undo.reverse();

        state.applyState(undo);

        if (state.isNull())
          continue;
      }

      assert(!state.isNull());

      state.data = null;

      this.auctions.set(nameHash, state);
    }

    return this;
  }

  untrack(tx) {
    const hash = tx.hash('hex');
    const names = new Set();

    for (const {covenant} of tx.outputs) {
      if (covenant.type < types.CLAIM
          || covenant.type > types.REVOKE) {
        continue;
      }

      const nameHash = covenant.items[0].toString('hex');

      switch (covenant.type) {
        case types.BID:
          this.removeBid(nameHash, hash);
          break;
        case types.REVEAL:
        case types.CLAIM:
          this.removeReveal(nameHash, hash);
          break;
        default:
          this.removeUpdate(nameHash, hash);
          break;
      }

      names.add(nameHash);
    }

    for (const nameHash of names)
      this.dereference(nameHash);

    return this;
  }

  merge(view) {
    for (const [nameHash, auction] of view.auctions) {
      if (!this.names.has(nameHash))
        continue;

      const state = auction.clone();
      state.data = null;

      this.auctions.set(nameHash, state);
    }

    return this;
  }

  toArray(map, nameHash, items) {
    const hashes = map.get(nameHash);

    if (!hashes)
      return this;

    for (const hash of hashes)
      items.add(hash);

    return this;
  }

  handleExpired(nameHash, items) {
    return this.toArray(this.updates, nameHash, items);
  }

  handleBidding(nameHash, items) {
    return this.toArray(this.updates, nameHash, items);
  }

  handleReveal(nameHash, items) {
    return this.toArray(this.bids, nameHash, items);
  }

  handleClosed(nameHash, items) {
    return this.toArray(this.reveals, nameHash, items);
  }

  invalidate(height) {
    const nextHeight = height + 1;
    const network = this.network;
    const invalid = new Set();

    for (const [nameHash, auction] of this.auctions) {
      if (auction.isExpired(nextHeight, network)) {
        this.handleExpired(nameHash, invalid);
        continue;
      }

      const state = auction.state(nextHeight, network);

      switch (state) {
        case states.BIDDING:
          this.handleBidding(nameHash, invalid);
          break;
        case states.REVEAL:
          this.handleReveal(nameHash, invalid);
          break;
        case states.CLOSED:
          this.handleClosed(nameHash, invalid);
          break;
      }
    }

    return invalid;
  }
}

/*
 * Expose
 */

module.exports = AuctionState;
