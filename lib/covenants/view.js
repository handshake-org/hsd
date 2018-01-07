'use strict';

const assert = require('assert');
const Auction = require('./auction');

class View {
  constructor() {
    this.auctions = new Map();
    this.prevout = new Map();
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

  addOutpoint(prevout, nameHash) {
    this.prevout.set(prevout.toKey(), nameHash);
  }

  removeOutpoint(prevout, nameHash) {
    this.prevout.set(prevout.toKey(), null);
  }

  async getAuctionFor(db, prevout) {
    const cache = this.prevout.get(prevout.toKey());

    if (cache !== undefined) {
      if (cache === null)
        return null;
      return this.getAuction(db, cache);
    }

    const nameHash = await db.getAuctionHash(prevout);

    if (!nameHash)
      return null;

    return this.getAuction(db, nameHash);
  }

  newAuction(name, nameHash, height) {
    const hash = nameHash.toString('hex');
    const auction = new Auction();
    auction.name = name;
    auction.nameHash = nameHash;
    auction.height = height;
    auction.renewal = height;
    this.auctions.set(hash, auction);
    return auction;
  }

  async ensureAuction(db, name, nameHash, height) {
    assert(Buffer.isBuffer(name));
    assert(Buffer.isBuffer(nameHash));

    const hash = nameHash.toString('hex');
    const cache = await this.getAuction(db, nameHash);

    if (cache && !cache.isNull())
      return cache;

    const auction = new Auction();
    auction.name = name;
    auction.nameHash = nameHash;
    auction.height = height;
    auction.renewal = height;
    this.auctions.set(hash, auction);

    return auction;
  }
}

module.exports = View;
