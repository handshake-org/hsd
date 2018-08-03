/*!
 * namestate.js - name states for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const Network = require('../protocol/network');
const Outpoint = require('../primitives/outpoint');
const {ZERO_HASH} = require('../protocol/consensus');
const NameDelta = require('./namedelta');
const {encoding} = bio;

/*
 * Constants
 */

const states = {
  OPENING: 0,
  BIDDING: 1,
  REVEAL: 2,
  CLOSED: 3,
  REVOKED: 4
};

const statesByVal = {
  [states.OPENING]: 'OPENING',
  [states.BIDDING]: 'BIDDING',
  [states.REVEAL]: 'REVEAL',
  [states.CLOSED]: 'CLOSED',
  [states.REVOKED]: 'REVOKED'
};

const EMPTY = Buffer.alloc(0);

/**
 * NameState
 * @extends {bio.Struct}
 */

class NameState extends bio.Struct {
  constructor() {
    super();

    this.name = EMPTY;
    this.nameHash = ZERO_HASH;
    this.height = 0;
    this.renewal = 0;
    this.owner = new Outpoint();
    this.value = 0;
    this.highest = 0;
    this.data = EMPTY;
    this.transfer = 0;
    this.revoked = 0;
    this.claimed = false;
    this.weak = false;

    // Not serialized.
    this._delta = null;
  }

  get delta() {
    if (!this._delta)
      this._delta = new NameDelta();
    return this._delta;
  }

  set delta(delta) {
    this._delta = delta;
  }

  inject(ns) {
    assert(ns instanceof this.constructor);

    this.name = ns.name;
    this.nameHash = ns.nameHash;
    this.height = ns.height;
    this.renewal = ns.renewal;
    this.owner = ns.owner;
    this.value = ns.value;
    this.highest = ns.highest;
    this.data = ns.data;
    this.transfer = ns.transfer;
    this.revoked = ns.revoked;
    this.claimed = ns.claimed;
    this.weak = ns.weak;

    return this;
  }

  clear() {
    this._delta = null;
    return this;
  }

  isNull() {
    return this.height === 0
        && this.renewal === 0
        && this.owner.isNull()
        && this.value === 0
        && this.highest === 0
        && this.data.length === 0
        && this.transfer === 0
        && this.revoked === 0
        && this.claimed === false
        && this.weak === false;
  }

  hasDelta() {
    return this._delta && !this._delta.isNull();
  }

  state(height, network) {
    assert((height >>> 0) === height);
    assert(network && network.names);

    if (this.revoked !== 0)
      return states.REVOKED;

    if (this.claimed)
      return states.CLOSED;

    const {
      treeInterval,
      biddingPeriod,
      revealPeriod
    } = network.names;

    const openPeriod = treeInterval + 1;

    if (height < this.height + openPeriod)
      return states.OPENING;

    if (height < this.height + openPeriod + biddingPeriod)
      return states.BIDDING;

    if (height < this.height + openPeriod + biddingPeriod + revealPeriod)
      return states.REVEAL;

    return states.CLOSED;
  }

  isOpening(height, network) {
    return this.state(height, network) === states.OPENING;
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

    if (this.revoked !== 0) {
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

  reset(height) {
    assert((height >>> 0) === height);

    this.setHeight(height);
    this.setRenewal(height);
    this.setOwner(new Outpoint());
    this.setValue(0);
    this.setHighest(0);
    this.setData(null);
    this.setTransfer(0);
    this.setRevoked(0);
    this.setClaimed(false);
    this.setWeak(false);

    return this;
  }

  set(name, height) {
    assert(Buffer.isBuffer(name));

    this.name = name;
    this.reset(height);

    return this;
  }

  setHeight(height) {
    assert((height >>> 0) === height);

    if (height === this.height)
      return this;

    if (this.delta.height === null)
      this.delta.height = this.height;

    this.height = height;

    return this;
  }

  setRenewal(renewal) {
    assert((renewal >>> 0) === renewal);

    if (renewal === this.renewal)
      return this;

    if (this.delta.renewal === null)
      this.delta.renewal = this.renewal;

    this.renewal = renewal;

    return this;
  }

  setOwner(owner) {
    assert(owner instanceof Outpoint);

    if (owner.equals(this.owner))
      return this;

    if (this.delta.owner === null)
      this.delta.owner = this.owner;

    this.owner = owner;

    return this;
  }

  setValue(value) {
    assert(Number.isSafeInteger(value) && value >= 0);

    if (value === this.value)
      return this;

    if (this.delta.value === null)
      this.delta.value = this.value;

    this.value = value;

    return this;
  }

  setHighest(highest) {
    assert(Number.isSafeInteger(highest) && highest >= 0);

    if (highest === this.highest)
      return this;

    if (this.delta.highest === null)
      this.delta.highest = this.highest;

    this.highest = highest;

    return this;
  }

  setData(data) {
    if (data === null)
      data = EMPTY;

    assert(Buffer.isBuffer(data));

    if (this.data.equals(data))
      return this;

    if (this.delta.data === null)
      this.delta.data = this.data;

    this.data = data;

    return this;
  }

  setTransfer(transfer) {
    assert((transfer >>> 0) === transfer);

    if (transfer === this.transfer)
      return this;

    if (this.delta.transfer === null)
      this.delta.transfer = this.transfer;

    this.transfer = transfer;

    return this;
  }

  setRevoked(revoked) {
    assert((revoked >>> 0) === revoked);

    if (revoked === this.revoked)
      return this;

    if (this.delta.revoked === null)
      this.delta.revoked = this.revoked;

    this.revoked = revoked;

    return this;
  }

  setClaimed(claimed) {
    assert(typeof claimed === 'boolean');

    if (claimed === this.claimed)
      return this;

    if (this.delta.claimed === null)
      this.delta.claimed = this.claimed;

    this.claimed = claimed;

    return this;
  }

  setWeak(weak) {
    assert(typeof weak === 'boolean');

    if (weak === this.weak)
      return this;

    if (this.delta.weak === null)
      this.delta.weak = this.weak;

    this.weak = weak;

    return this;
  }

  applyState(delta) {
    assert(delta instanceof NameDelta);

    if (delta.height !== null)
      this.height = delta.height;

    if (delta.renewal !== null)
      this.renewal = delta.renewal;

    if (delta.owner !== null)
      this.owner = delta.owner;

    if (delta.value !== null)
      this.value = delta.value;

    if (delta.highest !== null)
      this.highest = delta.highest;

    if (delta.data !== null)
      this.data = delta.data;

    if (delta.transfer !== null)
      this.transfer = delta.transfer;

    if (delta.revoked !== null)
      this.revoked = delta.revoked;

    if (delta.claimed !== null)
      this.claimed = delta.claimed;

    if (delta.weak !== null)
      this.weak = delta.weak;

    return this;
  }

  getSize() {
    let size = 0;

    size += 1;
    size += this.name.length;
    size += 2;
    size += this.data.length;

    size += 4;
    size += 4;

    size += 1;

    if (!this.owner.isNull())
      size += 32 + encoding.sizeVarint(this.owner.index);

    if (this.value !== 0)
      size += encoding.sizeVarint(this.value);

    if (this.highest !== 0)
      size += encoding.sizeVarint(this.highest);

    if (this.transfer !== 0)
      size += 4;

    if (this.revoked !== 0)
      size += 4;

    return size;
  }

  getField() {
    let field = 0;

    if (!this.owner.isNull())
      field |= 1;

    if (this.value !== 0)
      field |= 2;

    if (this.highest !== 0)
      field |= 4;

    if (this.transfer !== 0)
      field |= 8;

    if (this.revoked !== 0)
      field |= 16;

    if (this.claimed)
      field |= 32;

    if (this.weak)
      field |= 64;

    return field;
  }

  write(bw) {
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU16(this.data.length);
    bw.writeBytes(this.data);

    bw.writeU32(this.height);
    bw.writeU32(this.renewal);

    bw.writeU8(this.getField());

    if (!this.owner.isNull()) {
      bw.writeHash(this.owner.hash);
      bw.writeVarint(this.owner.index);
    }

    if (this.value !== 0)
      bw.writeVarint(this.value);

    if (this.highest !== 0)
      bw.writeVarint(this.highest);

    if (this.transfer !== 0)
      bw.writeU32(this.transfer);

    if (this.revoked !== 0)
      bw.writeU32(this.revoked);

    return bw;
  }

  read(br) {
    this.name = br.readBytes(br.readU8());
    this.data = br.readBytes(br.readU16());
    this.height = br.readU32();
    this.renewal = br.readU32();

    const field = br.readU8();

    if (field & 1) {
      this.owner.hash = br.readHash();
      this.owner.index = br.readVarint();
    }

    if (field & 2)
      this.value = br.readVarint();

    if (field & 4)
      this.highest = br.readVarint();

    if (field & 8)
      this.transfer = br.readU32();

    if (field & 16)
      this.revoked = br.readU32();

    if (field & 32)
      this.claimed = true;

    if (field & 64)
      this.weak = true;

    return this;
  }

  getJSON(height, network) {
    let state = undefined;
    let stats = undefined;

    if (height != null) {
      network = Network.get(network);
      state = this.state(height, network);
      state = statesByVal[state];
      stats = this.toStats(height, network);
    }

    return {
      name: this.name.toString('binary'),
      nameHash: this.nameHash.toString('hex'),
      state: state,
      height: this.height,
      renewal: this.renewal,
      owner: this.owner.toJSON(),
      value: this.value,
      highest: this.highest,
      data: this.data.toString('hex'),
      transfer: this.transfer,
      revoked: this.revoked,
      claimed: this.claimed,
      weak: this.weak,
      stats: stats
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert(typeof json.name === 'string');
    assert(json.name.length >= 0 && json.name.length <= 63);
    assert(typeof json.nameHash === 'string');
    assert(json.nameHash.length === 64);
    assert((json.height >>> 0) === json.height);
    assert((json.renewal >>> 0) === json.renewal);
    assert(json.owner && typeof json.owner === 'object');
    assert(Number.isSafeInteger(json.value) && json.value >= 0);
    assert(Number.isSafeInteger(json.highest) && json.highest >= 0);
    assert(typeof json.data === 'string');
    assert((json.data.length & 1) === 0);
    assert((json.transfer >>> 0) === json.transfer);
    assert((json.revoked >>> 0) === json.revoked);
    assert(typeof json.claimed === 'boolean');
    assert(typeof json.weak === 'boolean');

    this.name = Buffer.from(json.name, 'binary');
    this.nameHash = Buffer.from(json.nameHash, 'hex');
    this.height = json.height;
    this.renewal = json.renewal;
    this.owner = Outpoint.fromJSON(json.owner);
    this.value = json.value;
    this.highest = json.highest;
    this.data = Buffer.from(json.data, 'hex');
    this.transfer = json.transfer;
    this.revoked = json.revoked;
    this.claimed = json.claimed;
    this.weak = json.weak;

    return this;
  }

  toStats(height, network) {
    assert((height >>> 0) === height);
    assert(network && network.names);

    const spacing = network.pow.targetSpacing;

    const {
      treeInterval,
      biddingPeriod,
      revealPeriod,
      renewalWindow,
      auctionMaturity
    } = network.names;

    const openPeriod = treeInterval + 1;

    const stats = {};

    if (this.isOpening(height, network)) {
      const start = this.height;
      const end = this.height + openPeriod;
      const blocks = end - height;
      const hours = ((blocks * spacing) / 60 / 60);

      stats.openPeriodStart = start;
      stats.openPeriodEnd = end;

      stats.blocksUntilBidding = blocks;
      stats.hoursUntilBidding = Number(hours.toFixed(2));
    }

    if (this.isBidding(height, network)) {
      const start = this.height + openPeriod;
      const end = start + biddingPeriod;
      const blocks = end - height;
      const hours = ((blocks * spacing) / 60 / 60);

      stats.bidPeriodStart = start;
      stats.bidPeriodEnd = end;

      stats.blocksUntilReveal = blocks;
      stats.hoursUntilReveal = Number(hours.toFixed(2));
    }

    if (this.isReveal(height, network)) {
      const start = this.height + openPeriod + biddingPeriod;
      const end = start + revealPeriod;
      const blocks = end - height;
      const hours = ((blocks * spacing) / 60 / 60);

      stats.revealPeriodStart = start;
      stats.revealPeriodEnd = end;

      stats.blocksUntilClose = blocks;
      stats.hoursUntilClose = Number(hours.toFixed(2));
    }

    if (this.isClosed(height, network)) {
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

/*
 * Static
 */

NameState.states = states;
NameState.statesByVal = statesByVal;

// Max size: 654
NameState.MAX_SIZE = (0
  + 1 + 63
  + 2 + 512
  + 4
  + 4
  + 1
  + 32
  + 9
  + 9
  + 9
  + 4
  + 4);

/*
 * Expose
 */

module.exports = NameState;
