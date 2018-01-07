/*!
 * chain.js - blockchain management for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const bio = require('bufio');
const Outpoint = require('../primitives/outpoint');
const consensus = require('../protocol/consensus');
const rules = require('./rules');
const {NULL_HASH} = consensus;

/*
 * Constants
 */

const states = {
  BIDDING: 0,
  REVEAL: 1,
  CLOSED: 2
};

const types = {
  ADD_AUCTION: 0,
  REMOVE_AUCTION: 1,
  ADD_BID: 2,
  REMOVE_BID: 3,
  ADD_REVEAL: 4,
  REMOVE_REVEAL: 5,
  ADD_OUTPOINT: 6,
  REMOVE_OUTPOINT: 7,
  COMMIT: 8,
  UNCOMMIT: 9,
  ADD_UNDO: 10,
  REMOVE_UNDO: 11,
  ADD_RENEWAL: 12,
  REMOVE_RENEWAL: 13
};

const EMPTY = Buffer.alloc(0);

/**
 * Op
 */

class Op {
  constructor(type, params) {
    this.type = type;
    this.params = params || [];
  }
}

/**
 * Auction
 */

class Auction {
  constructor() {
    this.name = EMPTY;
    this.nameHash = NULL_HASH;
    this.owner = new Outpoint();
    this.transfer = new Outpoint();
    this.height = 0;
    this.renewal = 0;
    this.bids = 0;

    // Not serialized.
    this.ops = [];
  }

  isNull() {
    return this.owner.isNull()
      && this.height === 0
      && this.renewal === 0
      && this.bids === 0;
  }

  setNull() {
    this.owner = new Outpoint();
    this.height = 0;
    this.renewal = 0;
    this.bids = 0;
  }

  state(height, network) {
    if (height < this.height)
      return states.CLOSED;

    if (height < this.height + rules.BIDDING_PERIOD)
      return states.BIDDING;

    if (height < this.height + rules.TOTAL_PERIOD)
      return states.REVEAL;

    return states.CLOSED;
  }

  addBid(prevout) {
    this.ops.push(new Op(types.ADD_BID, [prevout]));
    this.bids += 1;
    return this;
  }

  removeBid(prevout) {
    this.ops.push(new Op(types.REMOVE_BID, [prevout]));
    this.bids -= 1;
    return this;
  }

  addReveal(prevout, value, height) {
    this.ops.push(new Op(types.ADD_REVEAL, [prevout, value, height]));
    return this;
  }

  removeReveal(prevout) {
    this.ops.push(new Op(types.REMOVE_REVEAL, [prevout]));
    return this;
  }

  setOwner(prevout) {
    if (this.owner.equals(prevout))
      return this;

    if (!this.owner.isNull())
      this.ops.push(new Op(types.REMOVE_OUTPOINT, [this.owner]));

    if (!prevout.isNull())
      this.ops.push(new Op(types.ADD_OUTPOINT, [prevout]));

    this.owner = prevout;

    return this;
  }

  setTransfer(prevout) {
    if (this.transfer.equals(prevout))
      return this;

    if (!this.transfer.isNull())
      this.ops.push(new Op(types.REMOVE_OUTPOINT, [this.transfer]));

    if (!prevout.isNull())
      this.ops.push(new Op(types.ADD_OUTPOINT, [prevout]));

    this.transfer = prevout;

    return this;
  }

  addUndo(prevout) {
    this.ops.push(new Op(types.ADD_UNDO, [prevout, this.toRaw()]));
    return this;
  }

  removeUndo(prevout) {
    this.ops.push(new Op(types.REMOVE_UNDO, [prevout]));
    return this;
  }

  addRenewal(prevout, height) {
    this.ops.push(new Op(types.ADD_RENEWAL, [prevout, this.renewal]));
    this.renewal = height;
    return this;
  }

  removeRenewal(prevout) {
    this.ops.push(new Op(types.REMOVE_RENEWAL, [prevout]));
    return this;
  }

  commit(data) {
    this.ops.push(new Op(types.COMMIT, [data]));
    return this;
  }

  uncommit() {
    this.ops.push(new Op(types.UNCOMMIT));
    return this;
  }

  save() {
    this.ops.push(new Op(types.ADD_AUCTION));
    return this;
  }

  remove() {
    this.ops.push(new Op(types.REMOVE_AUCTION));
    return this;
  }

  getSize() {
    let size = 0;
    size += 1 + this.name.length;
    size += 48 + 36;
    return size;
  }

  toRaw() {
    const bw = bio.write(this.getSize());
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    this.owner.toWriter(bw);
    this.transfer.toWriter(bw);
    bw.writeU32(this.height);
    bw.writeU32(this.renewal);
    bw.writeU32(this.bids);
    return bw.render();
  }

  static fromRaw(data) {
    const br = bio.read(data);
    const auction = new this();
    auction.name = br.readBytes(br.readU8());
    auction.owner.fromReader(br);
    auction.transfer.fromReader(br);
    auction.height = br.readU32();
    auction.renewal = br.readU32();
    auction.bids = br.readU32();
    return auction;
  }
}

Auction.states = states;
Auction.types = types;

/*
 * Expose
 */

module.exports = Auction;
