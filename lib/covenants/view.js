'use strict';

const assert = require('assert');
const blake2b = require('bcrypto/lib/blake2b');
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

    if (!auction) {
      const auction = new Auction();
      auction.nameHash = nameHash;
      this.auctions.set(hash, auction);
      return auction;
    }

    this.auctions.set(hash, auction);

    return auction;
  }
}

module.exports = View;
