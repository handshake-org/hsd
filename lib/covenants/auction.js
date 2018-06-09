/*!
 * auction.js - name auctions for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const bio = require('bufio');
const Network = require('../protocol/network');
const Outpoint = require('../primitives/outpoint');
const {ZERO_HASH} = require('../protocol/consensus');
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
  SET_DATA: 4,
  SET_RENEWAL: 5,
  SET_TRANSFER: 6,
  SET_CLAIMED: 7
};

const typesByVal = {
  [types.SET_AUCTION]: 'SET_AUCTION',
  [types.SET_OWNER]: 'SET_OWNER',
  [types.SET_VALUE]: 'SET_VALUE',
  [types.SET_HIGHEST]: 'SET_HIGHEST',
  [types.SET_DATA]: 'SET_DATA',
  [types.SET_RENEWAL]: 'SET_RENEWAL',
  [types.SET_TRANSFER]: 'SET_TRANSFER',
  [types.SET_CLAIMED]: 'SET_CLAIMED'
};

const EMPTY = Buffer.alloc(0);

/**
 * Op
 * @extends {bio.Struct}
 */

class Op extends bio.Struct {
  constructor(type, value) {
    super();
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
      case types.SET_DATA: {
        const data = this.value;
        if (!data)
          return 1 + 1;
        return 1 + 1 + encoding.sizeVarlen(data.length);
      }
      case types.SET_RENEWAL: {
        return 1 + 4;
      }
      case types.SET_TRANSFER: {
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

  write(bw) {
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
      case types.SET_TRANSFER: {
        const transfer = this.value;
        bw.writeU32(transfer >>> 0);
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
    return this;
  }

  read(br) {
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
      case types.SET_TRANSFER: {
        this.value = br.readU32();
        if (this.value === 0xffffffff)
          this.value = -1;
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
}

/**
 * Auction
 * @extends {bio.Struct}
 */

class Auction extends bio.Struct {
  constructor() {
    super();

    this.name = EMPTY;
    this.nameHash = ZERO_HASH;
    this.owner = new Outpoint();
    this.value = -1;
    this.highest = -1;
    this.data = null;
    this.height = 0;
    this.renewal = 0;
    this.transfer = -1;
    this.claimed = false;

    // Not serialized.
    this.ops = [];
    this.undo = [];
    this.dirty = false;
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
    this.data = auction.data;
    this.height = auction.height;
    this.renewal = auction.renewal;
    this.transfer = auction.transfer;
    this.claimed = auction.claimed;
    return this;
  }

  isNull() {
    return this.owner.isNull()
      && this.value === -1
      && this.highest === -1
      && this.data === null
      && this.height === 0
      && this.renewal === 0
      && this.transfer === -1
      && this.claimed === false;
  }

  setNull() {
    this.owner = new Outpoint();
    this.value = -1;
    this.highest = -1;
    this.data = null;
    this.height = 0;
    this.renewal = 0;
    this.transfer = -1;
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
    if (this.owner.isNull())
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
    this.name = name;

    if (this.data) {
      this.undo.push(new Op(types.SET_DATA, this.data));
      this.ops.push(new Op(types.SET_DATA, null));
      this.dirty = true;
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

  setData(data) {
    if (bufferEqual(this.data, data))
      return this;

    this.undo.push(new Op(types.SET_DATA, this.data));
    this.ops.push(new Op(types.SET_DATA, data));
    this.data = data;
    this.dirty = true;

    return this;
  }

  setRenewal(renewal) {
    this.undo.push(new Op(types.SET_RENEWAL, this.renewal));
    this.ops.push(new Op(types.SET_RENEWAL, renewal));
    this.renewal = renewal;
    return this;
  }

  setTransfer(transfer) {
    this.undo.push(new Op(types.SET_TRANSFER, this.transfer));
    this.ops.push(new Op(types.SET_TRANSFER, transfer));
    this.transfer = transfer;
    return this;
  }

  setClaimed(claimed) {
    this.undo.push(new Op(types.SET_CLAIMED, this.claimed));
    this.ops.push(new Op(types.SET_CLAIMED, claimed));
    this.claimed = claimed;
    return this;
  }

  applyState(ops) {
    for (const {type, value} of ops) {
      switch (type) {
        case types.SET_AUCTION: {
          const state = value;
          this.inject(state);
          break;
        }
        case types.SET_OWNER: {
          const owner = value;
          this.owner = owner;
          break;
        }
        case types.SET_VALUE: {
          const val = value;
          this.value = val;
          break;
        }
        case types.SET_HIGHEST: {
          const highest = value;
          this.highest = highest;
          break;
        }
        case types.SET_DATA: {
          const data = value;
          this.data = data;
          this.dirty = true;
          break;
        }
        case types.SET_RENEWAL: {
          const height = value;
          this.renewal = height;
          break;
        }
        case types.SET_TRANSFER: {
          const height = value;
          this.transfer = height;
          break;
        }
        case types.SET_CLAIMED: {
          const claimed = value;
          this.claimed = claimed;
          break;
        }
      }
    }

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

    if (this.data)
      size += encoding.sizeVarlen(this.data.length);

    size += 4;
    size += 4;

    if (this.transfer !== -1)
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

    if (this.claimed)
      field |= 32;

    return field;
  }

  write(bw) {
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

    if (this.data)
      bw.writeVarBytes(this.data);

    bw.writeU32(this.height);
    bw.writeU32(this.renewal);

    if (this.transfer !== -1)
      bw.writeU32(this.transfer);

    return bw;
  }

  read(br) {
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

    if (field & 8)
      this.data = br.readVarBytes();

    this.height = br.readU32();
    this.renewal = br.readU32();

    if (field & 16)
      this.transfer = br.readU32();

    if (field & 32)
      this.claimed = true;

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
      owner: this.owner.toJSON(),
      value: this.value,
      highest: this.highest,
      data: this.data ? this.data.toString('hex') : null,
      height: this.height,
      renewal: this.renewal,
      transfer: this.transfer,
      claimed: this.claimed
    };
  }

  format(height, network) {
    return this.getJSON(height, network);
  }
}

Auction.states = states;
Auction.statesByVal = statesByVal;
Auction.types = types;
Auction.typesByVal = typesByVal;
Auction.Op = Op;

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
