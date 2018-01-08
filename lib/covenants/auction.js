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
  ADD_REVEAL: 3,
  REMOVE_REVEAL: 4,
  COMMIT: 5,
  UNCOMMIT: 6,
  ADD_UNDO: 7,
  REMOVE_UNDO: 8,
  ADD_RENEWAL: 9,
  REMOVE_RENEWAL: 10
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

  addReveal(prevout, value) {
    this.ops.push(new Op(types.ADD_REVEAL, [this.height, prevout, value]));
    return this;
  }

  removeReveal(prevout) {
    this.ops.push(new Op(types.REMOVE_REVEAL, [this.height, prevout]));
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

  addRenewal(prevout) {
    this.ops.push(new Op(types.ADD_RENEWAL, [prevout, this.renewal]));
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
    size += 48;
    return size;
  }

  toRaw() {
    const bw = bio.write(this.getSize());
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    this.owner.toWriter(bw);
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
