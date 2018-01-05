'use strict';

const assert = require('assert');
const Auction = require('./auction');

class View {
  constructor() {
    this.auctions = new Map();
  }

  async getAuction(db, nameHash) {
    assert(Buffer.isBuffer(nameHash));

    const hash = nameHash.toString('hex');
    const cache = this.auctions.get(hash);

    if (cache)
      return cache;

    const auction = await db.getAuction(nameHash);

    if (!auction)
      return null;

    this.auctions.set(hash, auction);

    return auction;
  }

  async getAuctionFor(db, prevout) {
    const nameHash = await db.getAuctionHash(prevout);

    if (!nameHash)
      return null;

    return this.getAuction(db, nameHash);
  }

  async ensureAuction(db, name, nameHash, height) {
    assert(Buffer.isBuffer(name));
    assert(Buffer.isBuffer(nameHash));

    const hash = nameHash.toString('hex');
    const cache = await this.getAuction(db, nameHash);

    if (cache)
      return cache;

    const auction = new Auction();
    auction.name = name;
    auction.nameHash = nameHash;
    auction.height = height;
    this.auctions.set(hash, auction);

    return auction;
  }
}

module.exports = View;
