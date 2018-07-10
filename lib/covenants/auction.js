/*!
 * auction.js - name auctions for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const Network = require('../protocol/network');
const Outpoint = require('../primitives/outpoint');
const {ZERO_HASH} = require('../protocol/consensus');
const AuctionDelta = require('./auctiondelta');
const {encoding} = bio;

/*
 * Constants
 */

const states = {
  BIDDING: 0,
  REVEAL: 1,
  CLOSED: 2,
  REVOKED: 3
};

const statesByVal = {
  [states.BIDDING]: 'BIDDING',
  [states.REVEAL]: 'REVEAL',
  [states.CLOSED]: 'CLOSED',
  [states.REVOKED]: 'REVOKED'
};

const EMPTY = Buffer.alloc(0);

/**
 * Auction
 * @extends {bio.Struct}
 */

class Auction extends bio.Struct {
  constructor() {
    super();

    this.name = EMPTY;
    this.nameHash = ZERO_HASH;
    this.height = 0;
    this.renewal = 0;
    this.owner = new Outpoint();
    this.value = -1;
    this.highest = -1;
    this.data = null;
    this.transfer = -1;
    this.revoked = -1;
    this.claimed = false;
    this.weak = false;

    // Not serialized.
    this._delta = null;
    this.dirty = false;
  }

  get delta() {
    if (!this._delta)
      this._delta = new AuctionDelta();
    return this._delta;
  }

  set delta(delta) {
    this._delta = delta;
  }

  clone() {
    const copy = new this.constructor();
    return copy.inject(this);
  }

  inject(auction) {
    assert(auction instanceof this.constructor);

    this.name = auction.name;
    this.nameHash = auction.nameHash;
    this.height = auction.height;
    this.renewal = auction.renewal;
    this.owner = auction.owner;
    this.value = auction.value;
    this.highest = auction.highest;
    this.data = auction.data;
    this.transfer = auction.transfer;
    this.revoked = auction.revoked;
    this.claimed = auction.claimed;
    this.weak = auction.weak;

    return this;
  }

  clear() {
    this._delta = null;
    this.dirty = false;
    return this;
  }

  isNull() {
    return this.height === 0
        && this.renewal === 0
        && this.owner.isNull()
        && this.value === -1
        && this.highest === -1
        && this.data === null
        && this.transfer === -1
        && this.revoked === -1
        && this.claimed === false
        && this.weak === false;
  }

  hasDelta() {
    return this._delta && !this._delta.isNull();
  }

  state(height, network) {
    assert((height >>> 0) === height);
    assert(network && network.names);

    if (this.revoked !== -1)
      return states.REVOKED;

    if (this.claimed)
      return states.CLOSED;

    if (height < this.height + network.names.biddingPeriod)
      return states.BIDDING;

    if (height < this.height + network.names.totalPeriod)
      return states.REVEAL;

    return states.CLOSED;
  }

  isBidding(height, network) {
    return this.state(height, network) === states.BIDDING;
  }

  isReveal(height, network) {
    return this.state(height, network) === states.REVEAL;
  }

  isClosed(height, network) {
    return this.state(height, network) === states.CLOSED;
  }

  isRevoked(height, network) {
    return this.state(height, network) === states.REVOKED;
  }

  isExpired(height, network) {
    assert((height >>> 0) === height);
    assert(network && network.names);

    if (this.revoked !== -1) {
      if (height < this.revoked + network.names.auctionMaturity)
        return false;
      return true;
    }

    // Can only renew once we reach the closed state.
    if (!this.isClosed(height, network))
      return false;

    // If we haven't been renewed in a year, start over.
    if (height >= this.renewal + network.names.renewalWindow)
      return true;

    // If nobody revealed their bids, start over.
    if (this.owner.isNull())
      return true;

    return false;
  }

  isWeak(height, network) {
    assert((height >>> 0) === height);
    assert(network && network.names);

    if (!this.weak)
      return false;

    return height < this.height + network.names.weakLockup;
  }

  isLocal(view, prevout) {
    assert(view);
    assert(prevout instanceof Outpoint);

    const entry = view.getEntry(prevout);

    // Revalidation in the mempool.
    if (!entry)
      return true;

    // Initial validation in the mempool.
    if (entry.height === -1)
      return true;

    // On-chain.
    return entry.height >= this.height;
  }

  setAuction(name, height) {
    assert(Buffer.isBuffer(name));
    assert((height >>> 0) === height);

    this.name = name;
    this.setHeight(height);
    this.setRenewal(height);
    this.setOwner(new Outpoint());
    this.setValue(-1);
    this.setHighest(-1);
    this.setData(null);
    this.setTransfer(-1);
    this.setRevoked(-1);
    this.setClaimed(false);
    this.setWeak(false);

    return this;
  }

  setHeight(height) {
    assert((height >>> 0) === height);

    if (height === this.height)
      return this;

    if (this.delta.height === undefined)
      this.delta.height = this.height;

    this.height = height;

    return this;
  }

  setRenewal(renewal) {
    assert((renewal >>> 0) === renewal);

    if (renewal === this.renewal)
      return this;

    if (this.delta.renewal === undefined)
      this.delta.renewal = this.renewal;

    this.renewal = renewal;

    return this;
  }

  setOwner(owner) {
    assert(owner instanceof Outpoint);

    if (owner.equals(this.owner))
      return this;

    if (this.delta.owner === undefined)
      this.delta.owner = this.owner;

    this.owner = owner;

    return this;
  }

  setValue(value) {
    assert(Number.isSafeInteger(value) && value >= -1);

    if (value === this.value)
      return this;

    if (this.delta.value === undefined)
      this.delta.value = this.value;

    this.value = value;

    return this;
  }

  setHighest(highest) {
    assert(Number.isSafeInteger(highest) && highest >= -1);

    if (highest === this.highest)
      return this;

    if (this.delta.highest === undefined)
      this.delta.highest = this.highest;

    this.highest = highest;

    return this;
  }

  setData(data) {
    assert(data === null || Buffer.isBuffer(data));

    if (bufferEqual(this.data, data))
      return this;

    if (this.delta.data === undefined)
      this.delta.data = this.data;

    this.data = data;
    this.dirty = true;

    return this;
  }

  setTransfer(transfer) {
    assert(transfer === -1 || (transfer >>> 0) === transfer);

    if (transfer === this.transfer)
      return this;

    if (this.delta.transfer === undefined)
      this.delta.transfer = this.transfer;

    this.transfer = transfer;

    return this;
  }

  setRevoked(revoked) {
    assert(revoked === -1 || (revoked >>> 0) === revoked);

    if (revoked === this.revoked)
      return this;

    if (this.delta.revoked === undefined)
      this.delta.revoked = this.revoked;

    this.revoked = revoked;

    return this;
  }

  setClaimed(claimed) {
    assert(typeof claimed === 'boolean');

    if (claimed === this.claimed)
      return this;

    if (this.delta.claimed === undefined)
      this.delta.claimed = this.claimed;

    this.claimed = claimed;

    return this;
  }

  setWeak(weak) {
    assert(typeof weak === 'boolean');

    if (weak === this.weak)
      return this;

    if (this.delta.weak === undefined)
      this.delta.weak = this.weak;

    this.weak = weak;

    return this;
  }

  applyState(delta) {
    assert(delta instanceof AuctionDelta);

    if (delta.height !== undefined)
      this.height = delta.height;

    if (delta.renewal !== undefined)
      this.renewal = delta.renewal;

    if (delta.owner !== undefined)
      this.owner = delta.owner;

    if (delta.value !== undefined)
      this.value = delta.value;

    if (delta.highest !== undefined)
      this.highest = delta.highest;

    if (delta.data !== undefined) {
      this.data = delta.data;
      this.dirty = true;
    }

    if (delta.transfer !== undefined)
      this.transfer = delta.transfer;

    if (delta.revoked !== undefined)
      this.revoked = delta.revoked;

    if (delta.claimed !== undefined)
      this.claimed = delta.claimed;

    if (delta.weak !== undefined)
      this.weak = delta.weak;

    return this;
  }

  getSize() {
    let size = 0;

    size += 1;
    size += this.name.length;

    size += 4;
    size += 4;

    size += 1;

    if (!this.owner.isNull())
      size += 32 + encoding.sizeVarint(this.owner.index);

    if (this.value !== -1)
      size += encoding.sizeVarint(this.value);

    if (this.highest !== -1)
      size += encoding.sizeVarint(this.highest);

    if (this.data)
      size += encoding.sizeVarlen(this.data.length);

    if (this.transfer !== -1)
      size += 4;

    if (this.revoked !== -1)
      size += 4;

    return size;
  }

  getField() {
    let field = 0;

    if (!this.owner.isNull())
      field |= 1;

    if (this.value !== -1)
      field |= 2;

    if (this.highest !== -1)
      field |= 4;

    if (this.data)
      field |= 8;

    if (this.transfer !== -1)
      field |= 16;

    if (this.revoked !== -1)
      field |= 32;

    if (this.claimed)
      field |= 64;

    if (this.weak)
      field |= 128;

    return field;
  }

  write(bw) {
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);

    bw.writeU32(this.height);
    bw.writeU32(this.renewal);

    bw.writeU8(this.getField());

    if (!this.owner.isNull()) {
      bw.writeHash(this.owner.hash);
      bw.writeVarint(this.owner.index);
    }

    if (this.value !== -1)
      bw.writeVarint(this.value);

    if (this.highest !== -1)
      bw.writeVarint(this.highest);

    if (this.data)
      bw.writeVarBytes(this.data);

    if (this.transfer !== -1)
      bw.writeU32(this.transfer);

    if (this.revoked !== -1)
      bw.writeU32(this.revoked);

    return bw;
  }

  read(br) {
    this.name = br.readBytes(br.readU8());
    this.height = br.readU32();
    this.renewal = br.readU32();

    const field = br.readU8();

    if (field & 1) {
      this.owner.hash = br.readHash('hex');
      this.owner.index = br.readVarint();
    }

    if (field & 2)
      this.value = br.readVarint();

    if (field & 4)
      this.highest = br.readVarint();

    if (field & 8)
      this.data = br.readVarBytes();

    if (field & 16)
      this.transfer = br.readU32();

    if (field & 32)
      this.revoked = br.readU32();

    if (field & 64)
      this.claimed = true;

    if (field & 128)
      this.weak = true;

    return this;
  }

  getJSON(height, network) {
    if (!height)
      height = 0;

    network = Network.get(network);

    return {
      name: this.name.toString('ascii'),
      nameHash: this.nameHash.toString('hex'),
      state: statesByVal[this.state(height, network)],
      height: this.height,
      renewal: this.renewal,
      owner: this.owner.toJSON(),
      value: this.value,
      highest: this.highest,
      data: this.data ? this.data.toString('hex') : null,
      transfer: this.transfer,
      revoked: this.revoked,
      claimed: this.claimed,
      weak: this.weak,
      stats: this.toStats(height, network)
    };
  }

  toStats(height, network) {
    if (!height)
      height = 0;

    network = Network.get(network);

    const spacing = network.pow.targetSpacing;
    const stats = {};

    if (this.isBidding(height, network)) {
      const {biddingPeriod} = network.names;
      const start = this.height;
      const end = this.height + biddingPeriod;
      const blocks = end - height;
      const hours = ((blocks * spacing) / 60 / 60);

      stats.bidPeriodStart = start;
      stats.bidPeriodEnd = end;

      stats.blocksUntilReveal = blocks;
      stats.hoursUntilReveal = Number(hours.toFixed(2));
    }

    if (this.isReveal(height, network)) {
      const {biddingPeriod} = network.names;
      const {revealPeriod} = network.names;
      const start = this.height + biddingPeriod;
      const end = start + revealPeriod;
      const blocks = end - height;
      const hours = ((blocks * spacing) / 60 / 60);

      stats.revealPeriodStart = start;
      stats.revealPeriodEnd = end;

      stats.blocksUntilClose = blocks;
      stats.hoursUntilClose = Number(hours.toFixed(2));
    }

    if (this.isClosed(height, network)) {
      const {renewalWindow} = network.names;
      const start = this.renewal;
      const end = start + renewalWindow;
      const blocks = end - height;
      const days = ((blocks * spacing) / 60 / 60 / 24);

      stats.renewalPeriodStart = start;
      stats.renewalPeriodEnd = end;

      stats.blocksUntilExpire = blocks;
      stats.daysUntilExpire = Number(days.toFixed(2));
    }

    if (this.isRevoked(height, network)) {
      const {auctionMaturity} = network.names;
      const start = this.revoked;
      const end = start + auctionMaturity;
      const blocks = end - height;
      const hours = ((blocks * spacing) / 60 / 60);

      stats.revokePeriodStart = start;
      stats.revokePeriodEnd = end;

      stats.blocksUntilReopen = blocks;
      stats.hoursUntilReopen = Number(hours.toFixed(2));
    }

    return stats;
  }

  format(height, network) {
    return this.getJSON(height, network);
  }
}

Auction.states = states;
Auction.statesByVal = statesByVal;

/*
 * Helpers
 */

function bufferEqual(a, b) {
  if (!a && !b)
    return true;

  if (!a || !b)
    return false;

  return a.equals(b);
}

/*
 * Expose
 */

module.exports = Auction;
