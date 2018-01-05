'use strict';

const Auction = require('./auction');

class View {
  constructor() {
    this.auctions = new Map();
  }

  async getAuction(db, nameHash) {
    const cache = this.auctions.get(nameHash);

    if (!cache)
      return null;

    const auction = await db.getAuction(nameHash);

    if (!auction)
      return null;

    this.auctions.set(nameHash, auction);

    return auction;
  }

  async getAuctionFor(db, prevout) {
    const nameHash = await db.getAuctionHash(prevout);

    if (!nameHash)
      return null;

    return this.getAuction(db, nameHash);
  }

  async ensureAuction(db, name, nameHash, height) {
    const cache = await this.getAuction(db, nameHash);

    if (cache)
      return cache;

    const auction = new Auction();
    auction.name = name;
    auction.nameHash = nameHash;
    auction.height = height;

    return auction;
  }
}

module.exports = View;
