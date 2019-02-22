/*!
 * contractstate.js - mempool contract-state handling for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {BufferMap, BufferSet} = require('buffer-map');
const rules = require('../covenants/rules');
const NameState = require('../covenants/namestate');
const CoinView = require('../coins/coinview');
const {types} = rules;
const {states} = NameState;

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/*
 * Contract State
 */

class ContractState {
  constructor(network) {
    assert(network);

    // Current network.
    this.network = network;

    // Unique names.
    this.unique = new BufferSet();

    // Reference counter.
    this.refs = new BufferMap();

    // Map of nameHash->set-of-txids.
    this.opens = new BufferMap();

    // Map of nameHash->set-of-txids.
    this.bids = new BufferMap();

    // Map of nameHash->set-of-txids.
    this.reveals = new BufferMap();

    // Map of nameHash->set-of-txids.
    this.updates = new BufferMap();

    // Current on-chain state
    // of all watched names.
    this.view = new CoinView();
    this.names = this.view.names;
  }

  clear() {
    this.unique.clear();
    this.refs.clear();
    this.opens.clear();
    this.bids.clear();
    this.reveals.clear();
    this.names.clear();
    return this;
  }

  hasName(nameHash) {
    return this.unique.has(nameHash);
  }

  addName(nameHash) {
    this.unique.add(nameHash);
    return this;
  }

  removeName(nameHash) {
    this.unique.delete(nameHash);
    return this;
  }

  hasNames(tx) {
    return rules.hasNames(tx, this.unique);
  }

  addMap(map, nameHash, hash) {
    let set = map.get(nameHash);

    if (!set) {
      set = new BufferSet();
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

  addOpen(nameHash, hash) {
    return this.addMap(this.opens, nameHash, hash);
  }

  removeOpen(nameHash, hash) {
    return this.removeMap(this.opens, nameHash, hash);
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
    let count = this.refs.get(nameHash);

    if (count == null)
      count = 0;

    count += 1;

    this.refs.set(nameHash, count);

    return this;
  }

  dereference(nameHash) {
    let count = this.refs.get(nameHash);

    if (count == null)
      return this;

    count -= 1;

    assert(count >= 0);

    if (count === 0) {
      this.refs.delete(nameHash);
      this.names.delete(nameHash);
      return this;
    }

    this.refs.set(nameHash, count);

    return this;
  }

  track(tx, view) {
    const hash = tx.hash();

    if (view.names.size === 0)
      return this;

    for (const {covenant} of tx.outputs) {
      if (!covenant.isName())
        continue;

      const nameHash = covenant.getHash(0);

      switch (covenant.type) {
        case types.OPEN:
          this.addOpen(nameHash, hash);
          break;
        case types.BID:
          this.addBid(nameHash, hash);
          break;
        case types.REVEAL:
        case types.CLAIM:
          this.addReveal(nameHash, hash);
          break;
        default:
          this.addUpdate(nameHash, hash);
          break;
      }
    }

    for (const [nameHash, ns] of view.names) {
      this.reference(nameHash);

      if (this.names.has(nameHash))
        continue;

      const state = ns.clone();

      // We want the on-chain state.
      if (ns.hasDelta()) {
        state.applyState(ns.delta);

        if (state.isNull())
          continue;
      }

      assert(!state.isNull());

      state.data = EMPTY;

      this.names.set(nameHash, state);
    }

    rules.addNames(tx, this.unique);

    return this;
  }

  untrack(tx) {
    const hash = tx.hash();
    const names = new BufferSet();

    for (const {covenant} of tx.outputs) {
      if (!covenant.isName())
        continue;

      const nameHash = covenant.getHash(0);

      switch (covenant.type) {
        case types.OPEN:
          this.removeOpen(nameHash, hash);
          break;
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

    rules.removeNames(tx, this.unique);

    return this;
  }

  merge(view) {
    for (const [nameHash, ns] of view.names) {
      if (!this.refs.has(nameHash))
        continue;

      const state = ns.clone();
      state.data = EMPTY;

      this.names.set(nameHash, state);
    }

    return this;
  }

  toSet(map, nameHash, items) {
    const hashes = map.get(nameHash);

    if (!hashes)
      return this;

    for (const hash of hashes)
      items.add(hash);

    return this;
  }

  handleExpired(nameHash, items) {
    return this.toSet(this.updates, nameHash, items);
  }

  handleOpen(nameHash, items) {
    return this.toSet(this.updates, nameHash, items);
  }

  handleBidding(nameHash, items) {
    return this.toSet(this.opens, nameHash, items);
  }

  handleReveal(nameHash, items) {
    return this.toSet(this.bids, nameHash, items);
  }

  handleClosed(nameHash, items) {
    return this.toSet(this.reveals, nameHash, items);
  }

  invalidate(height, hardened) {
    const nextHeight = height + 1;
    const network = this.network;
    const invalid = new BufferSet();

    for (const [nameHash, ns] of this.names) {
      if (hardened && ns.weak) {
        this.handleExpired(nameHash, invalid);
        continue;
      }

      if (ns.isExpired(nextHeight, network)) {
        this.handleExpired(nameHash, invalid);
        continue;
      }

      const state = ns.state(nextHeight, network);

      switch (state) {
        case states.OPEN:
          this.handleOpen(nameHash, invalid);
          break;
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

module.exports = ContractState;
