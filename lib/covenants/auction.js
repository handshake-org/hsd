/*!
 * chain.js - blockchain management for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const bio = require('bufio');
const Outpoint = require('../primitives/outpoint');
const consensus = require('../protocol/consensus');
const rules = require('./rules');
const {ZERO_HASH} = consensus;
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

const types = {
  SET_AUCTION: 0,
  SET_OWNER: 1,
  SET_VALUE: 2,
  SET_HIGHEST: 3,
  SET_COLD: 4,
  SET_DATA: 5,
  SET_RENEWAL: 6,
  SET_CLAIMED: 7
};

const typesByVal = {
  [types.SET_AUCTION]: 'SET_AUCTION',
  [types.SET_OWNER]: 'SET_OWNER',
  [types.SET_VALUE]: 'SET_VALUE',
  [types.SET_HIGHEST]: 'SET_HIGHEST',
  [types.SET_COLD]: 'SET_COLD',
  [types.SET_DATA]: 'SET_DATA',
  [types.SET_RENEWAL]: 'SET_RENEWAL',
  [types.SET_CLAIMED]: 'SET_CLAIMED'
};

const EMPTY = Buffer.alloc(0);

/**
 * Op
 * @extends {bio.Struct}
 */

class Op extends bio.Struct {
  constructor(type, value) {
    this.type = type || 0;
    this.value = value || null;
  }

  getSize() {
    switch (this.type) {
      case types.SET_AUCTION: {
        const state = this.value;
        return 1 + state.getSize();
      }
      case types.SET_OWNER: {
        const owner = this.value;
        if (owner.isNull())
          return 1 + 1;
        return 1 + 1 + 32 + encoding.sizeVarint(owner.index);
      }
      case types.SET_VALUE: {
        if (this.value === -1)
          return 1 + 1;
        return 1 + 1 + encoding.sizeVarint(this.value);
      }
      case types.SET_HIGHEST: {
        if (this.value === -1)
          return 1 + 1;
        return 1 + 1 + encoding.sizeVarint(this.value);
      }
      case types.SET_COLD: {
        const cold = this.value;
        if (cold.isNull())
          return 1 + 1;
        return 1 + 1 + 32 + encoding.sizeVarint(cold.index);
      }
      case types.SET_DATA: {
        const data = this.value;
        if (!data)
          return 1 + 1;
        return 1 + 1 + encoding.sizeVarlen(data.length);
      }
      case types.SET_RENEWAL: {
        return 1 + 4;
      }
      case types.SET_CLAIMED: {
        return 1 + 1;
      }
      default: {
        throw new Error('Bad op type.');
      }
    }
  }

  toWriter(bw) {
    bw.writeU8(this.type);
    switch (this.type) {
      case types.SET_AUCTION: {
        const state = this.value;
        state.toWriter(bw);
        break;
      }
      case types.SET_OWNER: {
        const owner = this.value;
        if (!owner.isNull()) {
          bw.writeU8(1);
          bw.writeHash(owner.hash);
          bw.writeVarint(owner.index);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_VALUE: {
        const value = this.value;
        if (value !== -1) {
          bw.writeU8(1);
          bw.writeVarint(value);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_HIGHEST: {
        const highest = this.value;
        if (highest !== -1) {
          bw.writeU8(1);
          bw.writeVarint(highest);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_COLD: {
        const cold = this.value;
        if (!cold.isNull()) {
          bw.writeU8(1);
          cold.writeHash(cold.hash);
          cold.writeVarint(cold.index);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_DATA: {
        const data = this.value;
        if (data) {
          bw.writeU8(1);
          bw.writeVarBytes(data);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_RENEWAL: {
        const renewal = this.value;
        bw.writeU32(renewal);
        break;
      }
      case types.SET_CLAIMED: {
        const claimed = this.value;
        bw.writeU8(claimed ? 1 : 0);
        break;
      }
      default: {
        throw new Error('Bad op type.');
      }
    }
    return bw;
  }

  toRaw() {
    const size = this.getSize();
    return this.toWriter(bio.write(size)).render();
  }

  fromReader(br) {
    this.type = br.readU8();
    switch (this.type) {
      case types.SET_AUCTION: {
        this.value = Auction.fromReader(br);
        break;
      }
      case types.SET_OWNER: {
        this.value = new Outpoint();
        if (br.readU8() === 1) {
          this.value.hash = br.readHash('hex');
          this.value.index = br.readVarint();
        }
        break;
      }
      case types.SET_VALUE: {
        if (br.readU8() === 1)
          this.value = br.readVarint();
        else
          this.value = -1;
        break;
      }
      case types.SET_HIGHEST: {
        if (br.readU8() === 1)
          this.value = br.readVarint();
        else
          this.value = -1;
        break;
      }
      case types.SET_COLD: {
        this.value = new Outpoint();
        if (br.readU8() === 1) {
          this.value.hash = br.readHash('hex');
          this.value.index = br.readVarint();
        }
        break;
      }
      case types.SET_DATA: {
        if (br.readU8() === 1)
          this.value = br.readVarBytes();
        else
          this.value = null;
        break;
      }
      case types.SET_RENEWAL: {
        this.value = br.readU32();
        break;
      }
      case types.SET_CLAIMED: {
        this.value = br.readU8() === 1;
        break;
      }
      default: {
        throw new Error('Bad op type.');
      }
    }
    return this;
  }

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  static fromReader(br) {
    return new this().fromReader(br);
  }

  static fromRaw(data) {
    return new this().fromRaw(data);
  }
}

/**
 * Auction
 * @extends {bio.Struct}
 */

class Auction extends bio.Struct {
  constructor() {
    this.name = EMPTY;
    this.nameHash = ZERO_HASH;
    this.owner = new Outpoint();
    this.value = -1;
    this.highest = -1;
    this.cold = new Outpoint();
    this.data = null;
    this.height = 0;
    this.renewal = 0;
    this.claimed = false;

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
    this.value = auction.value;
    this.highest = auction.highest;
    this.cold = auction.cold;
    this.data = auction.data;
    this.height = auction.height;
    this.renewal = auction.renewal;
    this.claimed = auction.claimed;
    return this;
  }

  isNull() {
    return this.owner.isNull()
      && this.value === -1
      && this.highest === -1
      && this.cold.isNull()
      && this.data === null
      && this.height === 0
      && this.renewal === 0
      && this.claimed === false;
  }

  setNull() {
    this.owner = new Outpoint();
    this.value = -1;
    this.highest = -1;
    this.cold = new Outpoint();
    this.data = null;
    this.height = 0;
    this.renewal = 0;
    this.claimed = false;
    return this;
  }

  state(height, network) {
    if (this.claimed)
      return states.CLOSED;

    if (height < this.height)
      return states.REVOKED;

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
    // Can only renew once we reach the closed state.
    if (!this.isClosed(height, network))
      return false;

    // If we haven't been renewed in a year, start over.
    if (height >= this.renewal + network.names.renewalWindow)
      return true;

    // If nobody revealed their bids, start over.
    if (this.owner.isNull() && this.cold.isNull())
      return true;

    return false;
  }

  isMature(height, network) {
    if (this.claimed)
      return true;

    return height >= this.height + network.names.auctionMaturity;
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
      this.undo.push(new Op(types.SET_DATA, this.data));
      this.ops.push(new Op(types.SET_DATA, null));
    }

    this.undo.push(new Op(types.SET_AUCTION, this.clone()));
    this.ops.push(new Op(types.SET_AUCTION, this));

    this.setNull();
    this.height = height;
    this.renewal = height;

    return this;
  }

  setOwner(owner) {
    this.undo.push(new Op(types.SET_OWNER, this.owner));
    this.ops.push(new Op(types.SET_OWNER, owner));
    this.owner = owner;
    return this;
  }

  setHighest(highest) {
    this.undo.push(new Op(types.SET_HIGHEST, this.highest));
    this.ops.push(new Op(types.SET_HIGHEST, highest));
    this.highest = highest;
    return this;
  }

  setValue(value) {
    this.undo.push(new Op(types.SET_VALUE, this.value));
    this.ops.push(new Op(types.SET_VALUE, value));
    this.value = value;
    return this;
  }

  setCold(cold) {
    this.undo.push(new Op(types.SET_COLD, this.cold));
    this.ops.push(new Op(types.SET_COLD, cold));
    this.cold = cold;
    return this;
  }

  setData(data) {
    this.undo.push(new Op(types.SET_DATA, this.data));
    this.ops.push(new Op(types.SET_DATA, data));
    this.data = data;
    return this;
  }

  setRenewal(renewal) {
    this.undo.push(new Op(types.SET_RENEWAL, this.renewal));
    this.ops.push(new Op(types.SET_RENEWAL, renewal));
    this.renewal = renewal;
    return this;
  }

  setClaimed(claimed) {
    this.undo.push(new Op(types.SET_CLAIMED, this.claimed));
    this.ops.push(new Op(types.SET_CLAIMED, claimed));
    this.claimed = claimed;
    return this;
  }

  getSize() {
    let size = 0;

    size += 1;
    size += this.name.length;
    size += 1;

    if (!this.owner.isNull())
      size += 32 + encoding.sizeVarint(this.owner.index);

    if (this.value !== -1)
      size += encoding.sizeVarint(this.value);

    if (this.highest !== -1)
      size += encoding.sizeVarint(this.highest);

    if (!this.cold.isNull())
      size += 32 + encoding.sizeVarint(this.cold.index);

    if (this.data)
      size += encoding.sizeVarlen(this.data.length);

    size += 4
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

    if (!this.cold.isNull())
      field |= 8;

    if (this.data)
      field |= 16;

    if (this.claimed)
      field |= 32;

    return field;
  }

  toWriter(bw) {
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);
    bw.writeU8(this.getField());

    if (!this.owner.isNull()) {
      bw.writeHash(this.owner.hash);
      bw.writeVarint(this.owner.index);
    }

    if (this.value !== -1)
      bw.writeVarint(this.value);

    if (this.highest !== -1)
      bw.writeVarint(this.highest);

    if (!this.cold.isNull()) {
      bw.writeHash(this.cold.hash);
      bw.writeVarint(this.cold.index);
    }

    if (this.data)
      bw.writeVarBytes(this.data);

    bw.writeU32(this.height);
    bw.writeU32(this.renewal);

    return bw;
  }

  fromReader(br) {
    this.name = br.readBytes(br.readU8());

    const field = br.readU8();

    if (field & 1) {
      this.owner.hash = br.readHash('hex');
      this.owner.index = br.readVarint();
    }

    if (field & 2)
      this.value = br.readVarint();

    if (field & 4)
      this.highest = br.readVarint();

    if (field & 8) {
      this.cold.hash = br.readHash('hex');
      this.cold.index = br.readVarint();
    }

    if (field & 16)
      this.data = br.readVarBytes();

    this.height = br.readU32();
    this.renewal = br.readU32();

    if (field & 32)
      this.claimed = true;

    return this;
  }

  toJSON(height, network) {
    return {
      name: this.name.toString('ascii'),
      state: this.state(height, network),
      owner: this.owner.toJSON(),
      value: this.value,
      highest: this.highest,
      cold: this.cold.toJSON(),
      data: this.data ? this.data.toString('hex') : null,
      height: this.height,
      renewal: this.renewal,
      claimed: this.claimed
    };
  }
}

Auction.states = states;
Auction.statesByVal = statesByVal;
Auction.types = types;
Auction.typesByVal = typesByVal;
Auction.Op = Op;

/*
 * Expose
 */

module.exports = Auction;
