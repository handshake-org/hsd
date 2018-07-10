'use strict';

const assert = require('assert');
const Auction = require('./auction');
const AuctionUndo = require('./undo');

class View {
  constructor() {
    this.auctions = new Map();
  }

  getAuctionSync(db, nameHash) {
    assert(db && typeof db.getAuction === 'function');
    assert(Buffer.isBuffer(nameHash));

    const hash = nameHash.toString('hex');
    const cache = this.auctions.get(hash);

    if (cache)
      return cache;

    const auction = db.getAuction(nameHash);

    if (!auction) {
      const auction = new Auction();
      auction.nameHash = nameHash;
      this.auctions.set(hash, auction);
      return auction;
    }

    this.auctions.set(hash, auction);

    return auction;
  }

  async getAuction(db, nameHash) {
    assert(db && typeof db.getAuction === 'function');
    assert(Buffer.isBuffer(nameHash));

    const hash = nameHash.toString('hex');
    const cache = this.auctions.get(hash);

    if (cache)
      return cache;

    const auction = await db.getAuction(nameHash);

    if (!auction) {
      const auction = new Auction();
      auction.nameHash = nameHash;
      this.auctions.set(hash, auction);
      return auction;
    }

    this.auctions.set(hash, auction);

    return auction;
  }

  toAuctionUndo() {
    return AuctionUndo.fromView(this);
  }
}

module.exports = View;
