/*!
 * namedelta.js - name deltas for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bio = require('bufio');
const Outpoint = require('../primitives/outpoint');
const {encoding} = bio;

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/**
 * NameDelta
 * @extends {bio.Struct}
 */

class NameDelta extends bio.Struct {
  constructor() {
    super();

    this.height = null;
    this.renewal = null;
    this.owner = null;
    this.value = null;
    this.highest = null;
    this.data = null;
    this.transfer = null;
    this.revoked = null;
    this.claimed = null;
    this.weak = null;
  }

  isNull() {
    return this.height === null
        && this.renewal === null
        && this.owner === null
        && this.value === null
        && this.highest === null
        && this.data === null
        && this.transfer === null
        && this.revoked === null
        && this.claimed === null
        && this.weak === null;
  }

  getSize() {
    let size = 0;

    size += 4;

    if (this.height !== null)
      size += 4;

    if (this.renewal !== null)
      size += 4;

    if (this.owner !== null) {
      if (!this.owner.isNull())
        size += 32 + encoding.sizeVarint(this.owner.index);
    }

    if (this.value !== null) {
      if (this.value !== 0)
        size += encoding.sizeVarint(this.value);
    }

    if (this.highest !== null) {
      if (this.highest !== 0)
        size += encoding.sizeVarint(this.highest);
    }

    if (this.data !== null) {
      if (this.data)
        size += encoding.sizeVarlen(this.data.length);
    }

    if (this.transfer !== null) {
      if (this.transfer !== 0)
        size += 4;
    }

    if (this.revoked !== null) {
      if (this.revoked !== 0)
        size += 4;
    }

    return size;
  }

  getField() {
    let field = 0;

    if (this.height !== null)
      field |= 1;

    if (this.renewal !== null)
      field |= 2;

    if (this.owner !== null) {
      field |= 4;
      if (!this.owner.isNull())
        field |= 8;
    }

    if (this.value !== null) {
      field |= 16;
      if (this.value !== 0)
        field |= 32;
    }

    if (this.highest !== null) {
      field |= 64;
      if (this.highest !== 0)
        field |= 128;
    }

    if (this.data !== null) {
      field |= 256;
      if (this.data)
        field |= 512;
    }

    if (this.transfer !== null) {
      field |= 1024;
      if (this.transfer !== 0)
        field |= 2048;
    }

    if (this.revoked !== null) {
      field |= 4096;
      if (this.revoked !== 0)
        field |= 8192;
    }

    if (this.claimed !== null) {
      field |= 16384;
      if (this.claimed)
        field |= 32768;
    }

    if (this.weak !== null) {
      field |= 65536;
      if (this.weak)
        field |= 131072;
    }

    return field;
  }

  write(bw) {
    bw.writeU32(this.getField());

    if (this.height !== null)
      bw.writeU32(this.height);

    if (this.renewal !== null)
      bw.writeU32(this.renewal);

    if (this.owner !== null) {
      if (!this.owner.isNull()) {
        bw.writeHash(this.owner.hash);
        bw.writeVarint(this.owner.index);
      }
    }

    if (this.value !== null) {
      if (this.value !== 0)
        bw.writeVarint(this.value);
    }

    if (this.highest !== null) {
      if (this.highest !== 0)
        bw.writeVarint(this.highest);
    }

    if (this.data !== null) {
      if (this.data)
        bw.writeVarBytes(this.data);
    }

    if (this.transfer !== null) {
      if (this.transfer !== 0)
        bw.writeU32(this.transfer);
    }

    if (this.revoked !== null) {
      if (this.revoked !== 0)
        bw.writeU32(this.revoked);
    }

    return bw;
  }

  read(br) {
    const field = br.readU32();

    if (field & 1)
      this.height = br.readU32();

    if (field & 2)
      this.renewal = br.readU32();

    if (field & 4) {
      this.owner = new Outpoint();
      if (field & 8) {
        this.owner.hash = br.readHash();
        this.owner.index = br.readVarint();
      }
    }

    if (field & 16) {
      this.value = 0;
      if (field & 32)
        this.value = br.readVarint();
    }

    if (field & 64) {
      this.highest = 0;
      if (field & 128)
        this.highest = br.readVarint();
    }

    if (field & 256) {
      this.data = EMPTY;
      if (field & 512)
        this.data = br.readVarBytes();
    }

    if (field & 1024) {
      this.transfer = 0;
      if (field & 2048)
        this.transfer = br.readU32();
    }

    if (field & 4096) {
      this.revoked = 0;
      if (field & 8192)
        this.revoked = br.readU32();
    }

    if (field & 16384) {
      this.claimed = false;
      if (field & 32768)
        this.claimed = true;
    }

    if (field & 65536) {
      this.weak = false;
      if (field & 131072)
        this.weak = true;
    }

    return this;
  }
}

/*
 * Expose
 */

module.exports = NameDelta;
