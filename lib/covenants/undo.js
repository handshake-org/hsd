'use strict';

const assert = require('bsert');
const bio = require('bufio');
const AuctionDelta = require('./auctiondelta');

class AuctionUndo extends bio.Struct {
  constructor() {
    super();
    this.auctions = [];
  }

  fromView(view) {
    assert(view && view.auctions);

    for (const auction of view.auctions.values()) {
      if (!auction.hasDelta())
        continue;

      this.auctions.push([auction.nameHash, auction.delta]);
    }

    return this;
  }

  getSize() {
    let size = 0;

    size += 4;

    for (const [, delta] of this.auctions) {
      size += 32;
      size += delta.getSize();
    }

    return size;
  }

  write(bw) {
    bw.writeU32(this.auctions.length);

    for (const [nameHash, delta] of this.auctions) {
      bw.writeBytes(nameHash);
      delta.write(bw);
    }

    return bw;
  }

  read(br) {
    const count = br.readU32();

    for (let i = 0; i < count; i++) {
      const nameHash = br.readBytes(32);
      const delta = AuctionDelta.read(br);

      this.auctions.push([nameHash, delta]);
    }

    return this;
  }

  static fromView(view) {
    return new this().fromView(view);
  }
}

module.exports = AuctionUndo;
