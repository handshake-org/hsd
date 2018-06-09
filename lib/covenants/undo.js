'use strict';

const assert = require('assert');
const bio = require('bufio');
const {Op} = require('./auction');

class AuctionUndo extends bio.Struct {
  constructor() {
    super();
    this.auctions = [];
  }

  fromView(view) {
    assert(view);

    for (const auction of view.auctions.values()) {
      if (auction.undo.length === 0)
        continue;

      const ops = [];

      // Write undo ops backwards.
      for (let i = auction.undo.length - 1; i >= 0; i--) {
        const op = auction.undo[i];
        ops.push(op);
      }

      this.auctions.push([auction.nameHash, ops]);
    }

    return this;
  }

  getSize() {
    let size = 0;

    size += 4;

    for (const [, ops] of this.auctions) {
      size += 32;
      size += 4;

      for (const op of ops)
        size += op.getSize();
    }

    return size;
  }

  write(bw) {
    bw.writeU32(this.auctions.length);

    for (const [nameHash, ops] of this.auctions) {
      bw.writeBytes(nameHash);
      bw.writeU32(ops.length);

      // Note: backwards.
      for (const op of ops)
        op.toWriter(bw);
    }

    return bw;
  }

  read(br) {
    const count = br.readU32();

    for (let i = 0; i < count; i++) {
      const nameHash = br.readBytes(32);
      const count = br.readU32();
      const ops = [];

      // Note: backwards.
      for (let j = 0; j < count; j++)
        ops.push(Op.fromReader(br));

      this.auctions.push([nameHash, ops]);
    }

    return this;
  }

  static fromView(view) {
    return new this().fromView(view);
  }
}

module.exports = AuctionUndo;
