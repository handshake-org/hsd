/*!
 * client.js - http client for wallets
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const NodeClient = require('../client/node');
const TX = require('../primitives/tx');
const Coin = require('../primitives/coin');
const NameState = require('../covenants/namestate');

const parsers = {
  'block connect': (entry, txs) => parseBlock(entry, txs),
  'block disconnect': entry => [parseEntry(entry)],
  'block rescan': (entry, txs) => parseBlock(entry, txs),
  'chain reset': entry => [parseEntry(entry)],
  'tx': tx => [TX.decode(tx)]
};

class WalletClient extends NodeClient {
  constructor(options) {
    super(options);
  }

  bind(event, handler) {
    const parser = parsers[event];

    if (!parser) {
      super.ws.bind(event, handler);
      return;
    }

    super.ws.bind(event, (...args) => {
      return handler(...parser(...args));
    });
  }

  hook(event, handler) {
    const parser = parsers[event];

    if (!parser) {
      super.ws.hook(event, handler);
      return;
    }

    super.ws.hook(event, (...args) => {
      return handler(...parser(...args));
    });
  }

  async getTip() {
    return parseEntry(await super.ws.getTip());
  }

  async getEntry(block) {
    if (Buffer.isBuffer(block))
      block = block.toString('hex');

    return parseEntry(await super.ws.getEntry(block));
  }

  async send(tx) {
    return super.ws.send(tx.encode());
  }

  async sendClaim(claim) {
    return super.ws.sendClaim(claim.encode());
  }

  async setFilter(filter) {
    return super.ws.setFilter(filter.encode());
  }

  async rescan(start) {
    return super.ws.rescan(start);
  }

  async getNameStatus(nameHash) {
    const json = await super.ws.getNameStatus(nameHash);
    return NameState.fromJSON(json);
  }

  async getCoin(hash, index) {
    const json = super.getCoin(hash, index);
    return Coin.fromJSON(json);
  }
}

/*
 * Helpers
 */

function parseEntry(data) {
  // 32  hash
  // 4   height
  // 4   nonce
  // 8   time
  // 32  prev
  // 32  tree
  // 24  extranonce
  // 32  reserved
  // 32  witness
  // 32  merkle
  // 4   version
  // 4   bits
  // 32  mask
  // 32  chainwork
  // 304 TOTAL

  assert(Buffer.isBuffer(data));
  // Just enough to read the three data below
  assert(data.length >= 44);

  return {
    hash: data.slice(0, 32),
    height: data.readUInt32LE(32),
    time: data.readUInt32LE(40)
  };
}

function parseBlock(entry, txs) {
  const block = parseEntry(entry);
  const out = [];

  for (const tx of txs)
    out.push(TX.decode(tx));

  return [block, out];
}

/*
 * Expose
 */

module.exports = WalletClient;
