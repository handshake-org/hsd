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
  ADD_OWNER: 6,
  REMOVE_OWNER: 7,
  ADD_QUEUE: 8,
  REMOVE_QUEUE: 9
};

const EMPTY = Buffer.alloc(0);

/**
 * Op
 */

class Op {
  constructor(type, hash, index, value) {
    this.type = type;
    this.hash = hash;
    this.index = index;
    this.value = value || 0;
  }
}

/**
 * Auction
 */

class Auction {
  constructor() {
    this.name = EMPTY;
    this.nameHash = NULL_HASH;
    this.height = 0;
    this.bids = 0;
    this.reveals = 0;
    this.owner = new Outpoint();
    this.data = EMPTY;

    // Not serialized.
    this.ops = [];
  }

  total() {
    return this.bids + this.reveals;
  }

  state(height, network) {
    if (height < this.height)
      return states.CLOSED;

    if (height < this.height + network.biddingPeriod)
      return states.BIDDING;

    if (height < this.height + network.totalPeriod)
      return states.REVEAL;

    return states.CLOSED;
  }

  addBid(hash, index) {
    this.ops.push(new Op(types.ADD_BID, hash, index));
    this.bids += 1;
    return this;
  }

  removeBid(hash, index) {
    this.ops.push(new Op(types.REMOVE_BID, hash, index));
    this.bids -= 1;
    return this;
  }

  addReveal(hash, index, value) {
    this.ops.push(new Op(types.ADD_REVEAL, hash, index, value));
    this.reveals += 1;
    return this;
  }

  removeReveal(hash, index) {
    this.ops.push(new Op(types.REMOVE_REVEAL, hash, index));
    this.reveals -= 1;
    return this;
  }

  setOwner(hash, index) {
    if (!this.owner.isNull()) {
      const {hash, index} = this.owner;
      this.ops.push(new Op(types.REMOVE_OWNER, hash, index));
    }

    this.owner = new Outpoint(hash, index);

    if (!this.owner.isNull())
      this.ops.push(new Op(types.ADD_OWNER, hash, index));

    return this;
  }

  setData(data) {
    this.data = data;
    return this;
  }

  queue() {
    this.ops.push(new Op(types.ADD_QUEUE, NULL_HASH, 0));
    return this;
  }

  unqueue() {
    this.ops.push(new Op(types.REMOVE_QUEUE, NULL_HASH, 0));
    return this;
  }

  save() {
    this.ops.push(new Op(types.ADD_AUCTION, NULL_HASH, 0));
    return this;
  }

  remove() {
    this.ops.push(new Op(types.REMOVE_AUCTION, NULL_HASH, 0));
    return this;
  }

  getSize() {
    let size = 55;
    size += this.name.length;
    size += this.data.length;
    return size;
  }

  toRaw() {
    const bw = bio.write(this.getSize());
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU32(this.height);
    bw.writeU32(this.bids);
    bw.writeU32(this.reveals);
    this.owner.toWriter(bw);
    bw.writeU16(this.data.length);
    bw.writeBytes(this.data);
    return bw.render();
  }

  static fromRaw(data) {
    const br = bio.read(data);
    const auction = new this();
    auction.name = br.readBytes(br.readU8());
    auction.height = br.readU32();
    auction.bids = br.readU32();
    auction.reveals = br.readU32();
    auction.owner.fromRaw(br);
    auction.data = br.readBytes(br.readU16());
    return auction;
  }
}

Auction.states = states;
Auction.types = types;

/*
 * Expose
 */

module.exports = Auction;
