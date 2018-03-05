/*!
 * client.js - http client for wallets
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const {NodeClient} = require('bclient');
const TX = require('../primitives/tx');

const parsers = {
  'block connect': (entry, txs) => parseBlock(entry, txs),
  'block disconnect': entry => [parseEntry(entry)],
  'block rescan': (entry, txs) => parseBlock(entry, txs),
  'chain reset': entry => [parseEntry(entry)],
  'tx': tx => [TX.fromRaw(tx)]
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
    return parseEntry(await super.getEntry(block));
  }

  async send(tx) {
    return super.send(tx.toRaw());
  }

  async setFilter(filter) {
    return super.setFilter(filter.toRaw());
  }

  async rescan(start) {
    return super.rescan(start);
  }
}

/*
 * Helpers
 */

function parseEntry(data) {
  assert(Buffer.isBuffer(data));
  assert(data.length >= 168);

  return {
    hash: data.toString('hex', 0, 32),
    height: data.readUInt32LE(36, true),
    time: data.readUInt32LE(168, true)
  };
}

function parseBlock(entry, txs) {
  const block = parseEntry(entry);
  const out = [];

  for (const tx of txs)
    out.push(TX.fromRaw(tx));

  return [block, out];
}

/*
 * Expose
 */

module.exports = WalletClient;
