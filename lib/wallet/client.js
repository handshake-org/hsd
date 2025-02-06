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
const {encoding} = require('bufio');

const parsers = {
  'block connect': (entry, txs) => parseBlock(entry, txs),
  'block disconnect': entry => [parseEntry(entry)],
  'block rescan': (entry, txs) => parseBlock(entry, txs),
  'block rescan interactive': (entry, txs) => parseBlock(entry, txs),
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
      super.bind(event, handler);
      return;
    }

    super.bind(event, (...args) => {
      return handler(...parser(...args));
    });
  }

  hook(event, handler) {
    const parser = parsers[event];

    if (!parser) {
      super.hook(event, handler);
      return;
    }

    super.hook(event, (...args) => {
      return handler(...parser(...args));
    });
  }

  async getTip() {
    return parseEntry(await super.getTip());
  }

  async getEntry(block) {
    if (Buffer.isBuffer(block))
      block = block.toString('hex');

    return parseEntry(await super.getEntry(block));
  }

  /**
   * Get entries.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise<Object[]>}
   */

  async getEntries(start, end) {
    const entries = await super.getEntries(start, end);
    return entries.map(parseEntry);
  }

  async send(tx) {
    return super.send(tx.encode());
  }

  async sendClaim(claim) {
    return super.sendClaim(claim.encode());
  }

  async setFilter(filter) {
    return super.setFilter(filter.encode());
  }

  /**
   * Rescan for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @returns {Promise}
   */

  async rescan(start) {
    return super.rescan(start);
  }

  /**
   * Rescan interactive for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @param {Boolean} [fullLock=false]
   * @returns {Promise}
   */

  async rescanInteractive(start, fullLock) {
    return super.rescanInteractive(start, null, fullLock);
  }

  async getNameStatus(nameHash) {
    const json = await super.getNameStatus(nameHash);
    return NameState.fromJSON(json);
  }

  /**
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Coin>}
   */

  async getCoin(hash, index) {
    const json = super.getCoin(hash, index);
    return Coin.fromJSON(json);
  }
}

/*
 * Helpers
 */

function parseEntry(data) {
  if (!data)
    return null;

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
  assert(data.length >= 80);

  const hash = data.slice(0, 32);
  const height = encoding.readU32(data, 32);
  // skip nonce 4.
  const time = encoding.readU64(data, 40);
  const prevBlock = data.slice(48, 80);

  return {
    hash,
    height,
    time,
    prevBlock
  };
}

function parseBlock(entry, txs) {
  const block = parseEntry(entry);
  assert(block);
  const out = [];

  for (const tx of txs)
    out.push(TX.decode(tx));

  return [block, out];
}

/*
 * Expose
 */

module.exports = WalletClient;
