'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const Auction = require('./auction');
const AuctionUndo = require('./undo');

class View {
  constructor() {
    this.auctions = new BufferMap();
  }

  getAuctionSync(db, nameHash) {
    assert(db && typeof db.getAuction === 'function');
    assert(Buffer.isBuffer(nameHash));

    const cache = this.auctions.get(nameHash);

    if (cache)
      return cache;

    const auction = db.getAuction(nameHash);

    if (!auction) {
      const auction = new Auction();
      auction.nameHash = nameHash;
      this.auctions.set(nameHash, auction);
      return auction;
    }

    this.auctions.set(nameHash, auction);

    return auction;
  }

  async getAuction(db, nameHash) {
    assert(db && typeof db.getAuction === 'function');
    assert(Buffer.isBuffer(nameHash));

    const cache = this.auctions.get(nameHash);

    if (cache)
      return cache;

    const auction = await db.getAuction(nameHash);

    if (!auction) {
      const auction = new Auction();
      auction.nameHash = nameHash;
      this.auctions.set(nameHash, auction);
      return auction;
    }

    this.auctions.set(nameHash, auction);

    return auction;
  }

  toAuctionUndo() {
    return AuctionUndo.fromView(this);
  }
}

module.exports = View;
