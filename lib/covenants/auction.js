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
const {ZERO_HASH} = consensus;

/*
 * Constants
 */

const states = {
  BIDDING: 0,
  REVEAL: 1,
  CLOSED: 2,
  REVOKED: 3
};

const types = {
  SET_AUCTION: 0,
  SET_WINNER: 2,
  SET_OWNER: 3,
  SET_DATA: 4,
  SET_RENEWAL: 5
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

  getSize() {
    switch (this.type) {
      case types.SET_AUCTION: {
        const [state] = this.params;
        return 1 + state.getSize();
      }
      case types.SET_WINNER: {
        const [winner] = this.params;
        return 1 + 1 + (!winner.isNull() ? 36 + 8 : 0);
      }
      case types.SET_OWNER: {
        const [owner] = this.params;
        return 1 + 1 + (!owner.isNull() ? 36 : 0);
      }
      case types.SET_DATA: {
        const [data] = this.params;
        return 1 + 1 + (data ? 32 : 0);
      }
      case types.SET_RENEWAL: {
        return 1 + 4;
      }
    }
    throw new Error('Bad op type.');
  }

  toWriter(bw) {
    bw.writeU8(this.type);
    switch (this.type) {
      case types.SET_AUCTION: {
        const [state] = this.params;
        state.toWriter(bw);
        break;
      }
      case types.SET_WINNER: {
        const [winner, value] = this.params;
        if (!winner.isNull()) {
          bw.writeU8(1);
          winner.toWriter(bw);
          bw.writeU64(value);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_OWNER: {
        const [owner] = this.params;
        if (!owner.isNull()) {
          bw.writeU8(1);
          owner.toWriter(bw);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_DATA: {
        const [data] = this.params;
        if (data) {
          bw.writeU8(1);
          bw.writeBytes(data);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_RENEWAL: {
        const [renewal] = this.params;
        bw.writeU32(renewal);
        break;
      }
    }
    return bw;
  }

  fromReader(br) {
    this.type = br.readU8();
    switch (this.type) {
      case types.SET_AUCTION: {
        this.params.push(Auction.fromReader(br));
        break;
      }
      case types.SET_WINNER: {
        if (br.readU8() === 1) {
          this.params.push(Outpoint.fromReader(br));
          this.params.push(br.readU64());
        } else {
          this.params.push(new Outpoint());
          this.params.push(0);
        }
        break;
      }
      case types.SET_OWNER: {
        if (br.readU8() === 1)
          this.params.push(Outpoint.fromReader(br));
        else
          this.params.push(new Outpoint());
        break;
      }
      case types.SET_DATA: {
        if (br.readU8() === 1)
          this.params.push(br.readBytes(32));
        else
          this.params.push(null);
        break;
      }
      case types.SET_RENEWAL: {
        this.params.push(br.readU32());
        break;
      }
    }
  }
}

/**
 * Auction
 */

class Auction {
  constructor() {
    this.name = EMPTY;
    this.nameHash = ZERO_HASH;
    this.owner = new Outpoint();
    this.data = null;
    this.winner = new Outpoint();
    this.value = 0;
    this.height = 0;
    this.renewal = 0;

    // Not serialized.
    this.ops = [];
    this.undo = [];
  }

  clone() {
    const copy = new this.constructor();
    return copy.inject(this);
  }

  inject(auction) {
    this.name = auction.name;
    this.nameHash = auction.nameHash;
    this.owner = auction.owner;
    this.data = auction.data;
    this.winner = auction.winner;
    this.value = auction.value;
    this.height = auction.height;
    this.renewal = auction.renewal;
    return this;
  }

  isNull() {
    return this.owner.isNull()
      && this.data === null
      && this.winner.isNull()
      && this.value === 0
      && this.height === 0
      && this.renewal === 0;
  }

  setNull() {
    this.owner = new Outpoint();
    this.data = null;
    this.winner = new Outpoint();
    this.value = 0;
    this.height = 0;
    this.renewal = 0;
    return this;
  }

  state(height, network) {
    if (height < this.height)
      return states.REVOKED;

    if (height < this.height + rules.BIDDING_PERIOD)
      return states.BIDDING;

    if (height < this.height + rules.TOTAL_PERIOD)
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
    // Can only renew once we reach the closed state.
    if (!this.isClosed(height, network))
      return false;

    // If we haven't been renewed in a year, start over.
    if (height >= this.renewal + rules.RENEWAL_WINDOW)
      return true;

    // If nobody revealed their bids, start over.
    if (this.winner.isNull() && this.owner.isNull())
      return true;

    return false;
  }

  isLocal(view, prevout) {
    const entry = view.getEntry(prevout);

    if (!entry)
      return true;

    if (entry.height === -1)
      return true;

    return entry.height >= this.height;
  }

  setAuction(name, height) {
    this.name = name;

    if (this.data) {
      this.undo.push(new Op(types.SET_DATA, [this.data]));
      this.ops.push(new Op(types.SET_DATA, [null]));
    }

    this.undo.push(new Op(types.SET_AUCTION, [this.clone()]));
    this.ops.push(new Op(types.SET_AUCTION, [this]));

    this.setNull();
    this.height = height;
    this.renewal = height;

    return this;
  }

  setWinner(winner, value) {
    this.undo.push(new Op(types.SET_WINNER, [winner, this.winner, this.value]));
    this.ops.push(new Op(types.SET_WINNER, [this.winner, winner, value]));
    this.winner = winner;
    this.value = value;
    return this;
  }

  setOwner(owner) {
    this.undo.push(new Op(types.SET_OWNER, [this.owner]));
    this.ops.push(new Op(types.SET_OWNER, [owner]));
    this.owner = owner;
    return this;
  }

  setData(data) {
    this.undo.push(new Op(types.SET_DATA, [this.data]));
    this.ops.push(new Op(types.SET_DATA, [data]));
    this.data = data;
    return this;
  }

  setRenewal(renewal) {
    this.undo.push(new Op(types.SET_RENEWAL, [this.renewal]));
    this.ops.push(new Op(types.SET_RENEWAL, [renewal]));
    this.renewal = renewal;
    return this;
  }

  getSize() {
    let size = 0;

    size += 1 + this.name.length;

    size += 1;
    if (!this.owner.isNull())
      size += 36;

    size += 1;
    if (this.data)
      size += 32;

    size += 1;
    if (!this.winner.isNull())
      size += 36 + 8;

    size += 4 + 4;
    return size;
  }

  toRaw() {
    const bw = bio.write(this.getSize());
    return this.toWriter(bw).render();
  }

  toWriter(bw) {
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);

    if (!this.owner.isNull()) {
      bw.writeU8(1);
      this.owner.toWriter(bw);
    } else {
      bw.writeU8(0);
    }

    if (this.data) {
      bw.writeU8(1);
      bw.writeBytes(this.data);
    } else {
      bw.writeU8(0);
    }

    if (!this.winner.isNull()) {
      bw.writeU8(1);
      this.winner.toWriter(bw);
      bw.writeU64(this.value);
    } else {
      bw.writeU8(0);
    }

    bw.writeU32(this.height);
    bw.writeU32(this.renewal);

    return bw;
  }

  static fromReader(br) {
    const auction = new this();

    auction.name = br.readBytes(br.readU8());

    if (br.readU8() === 1)
      auction.owner.fromReader(br);

    if (br.readU8() === 1)
      auction.data = br.readBytes(32);

    if (br.readU8() === 1) {
      auction.winner.fromReader(br);
      auction.value = br.readU64();
    }

    auction.height = br.readU32();
    auction.renewal = br.readU32();

    return auction;
  }

  static fromRaw(data) {
    const br = bio.read(data);
    return this.fromReader(br);
  }

  toJSON(height, network) {
    return {
      name: this.name.toString('ascii'),
      state: this.state(height, network),
      owner: this.owner.toJSON(),
      data: this.data ? this.data.toString('hex') : null,
      winner: this.winner.toJSON(),
      value: this.value,
      height: this.height,
      renewal: this.renewal
    };
  }
}

Auction.states = states;
Auction.types = types;
Auction.Op = Op;

/*
 * Expose
 */

module.exports = Auction;
