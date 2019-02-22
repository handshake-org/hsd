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
    this.renewals = null;
    this.registered = null;
    this.expired = null;
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
        && this.renewals === null
        && this.registered === null
        && this.expired === null
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

    if (this.claimed !== null) {
      if (this.claimed !== 0)
        size += 4;
    }

    if (this.renewals !== null) {
      if (this.renewals !== 0)
        size += encoding.sizeVarint(this.renewals);
    }

    return size;
  }

  getField() {
    let field = 0;

    if (this.height !== null)
      field |= 1 << 0;

    if (this.renewal !== null)
      field |= 1 << 1;

    if (this.owner !== null) {
      field |= 1 << 2;
      if (!this.owner.isNull())
        field |= 1 << 3;
    }

    if (this.value !== null) {
      field |= 1 << 4;
      if (this.value !== 0)
        field |= 1 << 5;
    }

    if (this.highest !== null) {
      field |= 1 << 6;
      if (this.highest !== 0)
        field |= 1 << 7;
    }

    if (this.data !== null) {
      field |= 1 << 8;
      if (this.data)
        field |= 1 << 9;
    }

    if (this.transfer !== null) {
      field |= 1 << 10;
      if (this.transfer !== 0)
        field |= 1 << 11;
    }

    if (this.revoked !== null) {
      field |= 1 << 12;
      if (this.revoked !== 0)
        field |= 1 << 13;
    }

    if (this.claimed !== null) {
      field |= 1 << 14;
      if (this.claimed !== 0)
        field |= 1 << 15;
    }

    if (this.renewals !== null) {
      field |= 1 << 16;
      if (this.renewals !== 0)
        field |= 1 << 17;
    }

    if (this.registered !== null) {
      field |= 1 << 18;
      if (this.registered)
        field |= 1 << 19;
    }

    if (this.expired !== null) {
      field |= 1 << 20;
      if (this.expired)
        field |= 1 << 21;
    }

    if (this.weak !== null) {
      field |= 1 << 22;
      if (this.weak)
        field |= 1 << 23;
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

    if (this.claimed !== null) {
      if (this.claimed !== 0)
        bw.writeU32(this.claimed);
    }

    if (this.renewals !== null) {
      if (this.renewals !== 0)
        bw.writeVarint(this.renewals);
    }

    return bw;
  }

  read(br) {
    const field = br.readU32();

    if (field & (1 << 0))
      this.height = br.readU32();

    if (field & (1 << 1))
      this.renewal = br.readU32();

    if (field & (1 << 2)) {
      this.owner = new Outpoint();
      if (field & (1 << 3)) {
        this.owner.hash = br.readHash();
        this.owner.index = br.readVarint();
      }
    }

    if (field & (1 << 4)) {
      this.value = 0;
      if (field & (1 << 5))
        this.value = br.readVarint();
    }

    if (field & (1 << 6)) {
      this.highest = 0;
      if (field & (1 << 7))
        this.highest = br.readVarint();
    }

    if (field & (1 << 8)) {
      this.data = EMPTY;
      if (field & (1 << 9))
        this.data = br.readVarBytes();
    }

    if (field & (1 << 10)) {
      this.transfer = 0;
      if (field & (1 << 11))
        this.transfer = br.readU32();
    }

    if (field & (1 << 12)) {
      this.revoked = 0;
      if (field & (1 << 13))
        this.revoked = br.readU32();
    }

    if (field & (1 << 14)) {
      this.claimed = 0;
      if (field & (1 << 15))
        this.claimed = br.readU32();
    }

    if (field & (1 << 16)) {
      this.renewals = 0;
      if (field & (1 << 17))
        this.renewals = br.readVarint();
    }

    if (field & (1 << 18)) {
      this.registered = false;
      if (field & (1 << 19))
        this.registered = true;
    }

    if (field & (1 << 20)) {
      this.expired = false;
      if (field & (1 << 21))
        this.expired = true;
    }

    if (field & (1 << 22)) {
      this.weak = false;
      if (field & (1 << 23))
        this.weak = true;
    }

    return this;
  }
}

/*
 * Expose
 */

module.exports = NameDelta;
