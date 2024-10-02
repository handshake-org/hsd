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

/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../protocol/network')} Network */
/** @typedef {import('../primitives/tx')} TX */

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/*
 * Contract State
 */

class ContractState {
  /**
   * @constructor
   * @param {Network} network
   */

  constructor(network) {
    assert(network);

    // Current network.
    this.network = network;

    // Unique names.
    this.unique = new BufferSet();

    // Reference counter.
    /** @type {BufferMap<Number>} */
    this.refs = new BufferMap();

    // Map of nameHash->set-of-txids.
    /** @type {BufferMap<BufferSet>} */
    this.opens = new BufferMap();

    // Map of nameHash->set-of-txids.
    /** @type {BufferMap<BufferSet>} */
    this.bids = new BufferMap();

    // Map of nameHash->set-of-txids.
    /** @type {BufferMap<BufferSet>} */
    this.reveals = new BufferMap();

    // Map of nameHash->set-of-txids.
    /** @type {BufferMap<BufferSet>} */
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

  /**
   * @param {Hash} nameHash
   * @returns {Boolean}
   */

  hasName(nameHash) {
    return this.unique.has(nameHash);
  }

  /**
   * @param {Hash} nameHash
   * @returns {ContractState}
   */

  addName(nameHash) {
    this.unique.add(nameHash);
    return this;
  }

  /**
   * @param {Hash} nameHash
   * @returns {ContractState}
   */

  removeName(nameHash) {
    this.unique.delete(nameHash);
    return this;
  }

  /**
   * @param {TX} tx
   * @returns {Boolean}
   */

  hasNames(tx) {
    return rules.hasNames(tx, this.unique);
  }

  /**
   * @param {BufferMap<BufferSet>} map
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  addMap(map, nameHash, hash) {
    let set = map.get(nameHash);

    if (!set) {
      set = new BufferSet();
      map.set(nameHash, set);
    }

    set.add(hash);

    return this;
  }

  /**
   * @param {BufferMap<BufferSet>} map
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  removeMap(map, nameHash, hash) {
    const set = map.get(nameHash);

    if (!set)
      return this;

    set.delete(hash);

    if (set.size === 0)
      map.delete(nameHash);

    return this;
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  addOpen(nameHash, hash) {
    return this.addMap(this.opens, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  removeOpen(nameHash, hash) {
    return this.removeMap(this.opens, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  addBid(nameHash, hash) {
    return this.addMap(this.bids, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  removeBid(nameHash, hash) {
    return this.removeMap(this.bids, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  addReveal(nameHash, hash) {
    return this.addMap(this.reveals, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  removeReveal(nameHash, hash) {
    return this.removeMap(this.reveals, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  addUpdate(nameHash, hash) {
    return this.addMap(this.updates, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @param {Hash} hash
   * @returns {ContractState}
   */

  removeUpdate(nameHash, hash) {
    return this.removeMap(this.updates, nameHash, hash);
  }

  /**
   * @param {Hash} nameHash
   * @returns {ContractState}
   */

  reference(nameHash) {
    let count = this.refs.get(nameHash);

    if (count == null)
      count = 0;

    count += 1;

    this.refs.set(nameHash, count);

    return this;
  }

  /**
   * @param {Hash} nameHash
   * @returns {ContractState}
   */

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

  /**
   * @param {TX} tx
   * @param {CoinView} view
   * @returns {ContractState}
   */

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

  /**
   * @param {TX} tx
   * @returns {ContractState}
   */

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

  /**
   * @param {CoinView} view
   * @returns {ContractState}
   */

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

  /**
   * @param {BufferMap<BufferSet>} map
   * @param {Hash} nameHash
   * @param {BufferSet} items
   * @returns {ContractState}
   */

  toSet(map, nameHash, items) {
    const hashes = map.get(nameHash);

    if (!hashes)
      return this;

    for (const hash of hashes)
      items.add(hash);

    return this;
  }

  /**
   * @param {Hash} nameHash
   * @param {BufferSet} items
   * @returns {ContractState}
   */

  handleExpired(nameHash, items) {
    this.toSet(this.updates, nameHash, items);
    this.toSet(this.reveals, nameHash, items);
    return this;
  }

  /**
   * @param {Hash} nameHash
   * @param {BufferSet} items
   * @returns {ContractState}
   */

  handleOpen(nameHash, items) {
    return this.toSet(this.updates, nameHash, items);
  }

  /**
   * @param {Hash} nameHash
   * @param {BufferSet} items
   * @returns {ContractState}
   */

  handleBidding(nameHash, items) {
    return this.toSet(this.opens, nameHash, items);
  }

  /**
   * @param {Hash} nameHash
   * @param {BufferSet} items
   * @returns {ContractState}
   */

  handleReveal(nameHash, items) {
    return this.toSet(this.bids, nameHash, items);
  }

  /**
   * @param {Hash} nameHash
   * @param {BufferSet} items
   * @returns {ContractState}
   */

  handleClosed(nameHash, items) {
    return this.toSet(this.reveals, nameHash, items);
  }

  /**
   * Invalidate transactions in the mempool.
   * @param {Number} height
   * @param {Boolean} hardened
   * @returns {BufferSet} - list of invalidated tx hashes.
   */

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
        case states.OPENING:
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
