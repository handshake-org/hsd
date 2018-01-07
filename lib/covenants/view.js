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

  async getDataFor(db, prevout) {
    const cache = this.getEntry(prevout);

    if (cache)
      return cache;

    const entry = await db.readCoin(prevout);

    if (!entry)
      return null;

    const {output} = entry;
    const {covenant} = output;

    return covenant.items[1];
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
