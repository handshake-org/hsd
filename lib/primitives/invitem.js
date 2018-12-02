/*!
 * invitem.js - inv item object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bio = require('bufio');

/**
 * Inv Item
 * @alias module:primitives.InvItem
 * @constructor
 * @property {InvType} type
 * @property {Hash} hash
 */

class InvItem extends bio.Struct {
  /**
   * Create an inv item.
   * @constructor
   * @param {Number} type
   * @param {Hash} hash
   */

  constructor(type, hash) {
    super();
    this.type = type;
    this.hash = hash;
  }

  /**
   * Write inv item to buffer writer.
   * @param {BufferWriter} bw
   */

  getSize() {
    return 36;
  }

  /**
   * Write inv item to buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeU32(this.type);
    bw.writeHash(this.hash);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.type = br.readU32();
    this.hash = br.readHash();
    return this;
  }

  /**
   * Test whether the inv item is a block.
   * @returns {Boolean}
   */

  isBlock() {
    switch (this.type) {
      case InvItem.types.BLOCK:
      case InvItem.types.FILTERED_BLOCK:
      case InvItem.types.CMPCT_BLOCK:
        return true;
      default:
        return false;
    }
  }

  /**
   * Test whether the inv item is a tx.
   * @returns {Boolean}
   */

  isTX() {
    switch (this.type) {
      case InvItem.types.TX:
        return true;
      default:
        return false;
    }
  }

  /**
   * Test whether the inv item is a claim.
   * @returns {Boolean}
   */

  isClaim() {
    switch (this.type) {
      case InvItem.types.CLAIM:
        return true;
      default:
        return false;
    }
  }

  /**
   * Test whether the inv item is an airdrop proof.
   * @returns {Boolean}
   */

  isAirdrop() {
    switch (this.type) {
      case InvItem.types.AIRDROP:
        return true;
      default:
        return false;
    }
  }
}

/**
 * Inv types.
 * @enum {Number}
 * @default
 */

InvItem.types = {
  TX: 1,
  BLOCK: 2,
  FILTERED_BLOCK: 3,
  CMPCT_BLOCK: 4,
  CLAIM: 5,
  AIRDROP: 6
};

/**
 * Inv types by value.
 * @const {Object}
 */

InvItem.typesByVal = {
  1: 'TX',
  2: 'BLOCK',
  3: 'FILTERED_BLOCK',
  4: 'CMPCT_BLOCK',
  5: 'CLAIM',
  6: 'AIRDROP'
};

/*
 * Expose
 */

module.exports = InvItem;
