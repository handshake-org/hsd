/*!
 * auctiondelta.js - name auctions for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const bio = require('bufio');
const Outpoint = require('../primitives/outpoint');
const {encoding} = bio;

/**
 * AuctionDelta
 * @extends {bio.Struct}
 */

class AuctionDelta extends bio.Struct {
  constructor() {
    super();

    this.height = undefined;
    this.renewal = undefined;
    this.owner = undefined;
    this.value = undefined;
    this.highest = undefined;
    this.data = undefined;
    this.transfer = undefined;
    this.revoked = undefined;
    this.claimed = undefined;
  }

  isNull() {
    return this.height === undefined
        && this.renewal === undefined
        && this.owner === undefined
        && this.value === undefined
        && this.highest === undefined
        && this.data === undefined
        && this.transfer === undefined
        && this.revoked === undefined
        && this.claimed === undefined;
  }

  getSize() {
    let size = 0;

    size += 2;

    if (this.height !== undefined)
      size += 4;

    if (this.renewal !== undefined)
      size += 4;

    if (this.owner !== undefined) {
      if (!this.owner.isNull())
        size += 32 + encoding.sizeVarint(this.owner.index);
    }

    if (this.value !== undefined) {
      if (this.value !== -1)
        size += encoding.sizeVarint(this.value);
    }

    if (this.highest !== undefined) {
      if (this.highest !== -1)
        size += encoding.sizeVarint(this.highest);
    }

    if (this.data !== undefined) {
      if (this.data)
        size += encoding.sizeVarlen(this.data.length);
    }

    if (this.transfer !== undefined) {
      if (this.transfer !== -1)
        size += 4;
    }

    if (this.revoked !== undefined) {
      if (this.revoked !== -1)
        size += 4;
    }

    return size;
  }

  getField() {
    let field = 0;

    if (this.height !== undefined)
      field |= 1;

    if (this.renewal !== undefined)
      field |= 2;

    if (this.owner !== undefined) {
      field |= 4;
      if (!this.owner.isNull())
        field |= 8;
    }

    if (this.value !== undefined) {
      field |= 16;
      if (this.value !== -1)
        field |= 32;
    }

    if (this.highest !== undefined) {
      field |= 64;
      if (this.highest !== -1)
        field |= 128;
    }

    if (this.data !== undefined) {
      field |= 256;
      if (this.data)
        field |= 512;
    }

    if (this.transfer !== undefined) {
      field |= 1024;
      if (this.transfer !== -1)
        field |= 2048;
    }

    if (this.revoked !== undefined) {
      field |= 4096;
      if (this.revoked !== -1)
        field |= 8192;
    }

    if (this.claimed !== undefined) {
      field |= 16384;
      if (this.claimed)
        field |= 32768;
    }

    return field;
  }

  write(bw) {
    bw.writeU16(this.getField());

    if (this.height !== undefined)
      bw.writeU32(this.height);

    if (this.renewal !== undefined)
      bw.writeU32(this.renewal);

    if (this.owner !== undefined) {
      if (!this.owner.isNull()) {
        bw.writeHash(this.owner.hash);
        bw.writeVarint(this.owner.index);
      }
    }

    if (this.value !== undefined) {
      if (this.value !== -1)
        bw.writeVarint(this.value);
    }

    if (this.highest !== undefined) {
      if (this.highest !== -1)
        bw.writeVarint(this.highest);
    }

    if (this.data !== undefined) {
      if (this.data)
        bw.writeVarBytes(this.data);
    }

    if (this.transfer !== undefined) {
      if (this.transfer !== -1)
        bw.writeU32(this.transfer);
    }

    if (this.revoked !== undefined) {
      if (this.revoked !== -1)
        bw.writeU32(this.revoked);
    }

    return bw;
  }

  read(br) {
    const field = br.readU16();

    if (field & 1)
      this.height = br.readU32();

    if (field & 2)
      this.renewal = br.readU32();

    if (field & 4) {
      this.owner = new Outpoint();
      if (field & 8) {
        this.owner.hash = br.readHash('hex');
        this.owner.index = br.readVarint();
      }
    }

    if (field & 16) {
      this.value = -1;
      if (field & 32)
        this.value = br.readVarint();
    }

    if (field & 64) {
      this.highest = -1;
      if (field & 128)
        this.highest = br.readVarint();
    }

    if (field & 256) {
      this.data = null;
      if (field & 512)
        this.data = br.readVarBytes();
    }

    if (field & 1024) {
      this.transfer = -1;
      if (field & 2048)
        this.transfer = br.readU32();
    }

    if (field & 4096) {
      this.revoked = -1;
      if (field & 8192)
        this.revoked = br.readU32();
    }

    if (field & 16384) {
      this.claimed = false;
      if (field & 32768)
        this.claimed = true;
    }

    return this;
  }
}

/*
 * Expose
 */

module.exports = AuctionDelta;
