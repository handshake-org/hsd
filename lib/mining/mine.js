/*!
 * mine.js - mining function for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const {Miner} = require('../protocol/cuckoo');
const consensus = require('../protocol/consensus');
const {rcmp} = require('./common');

/**
 * Hash until the nonce overflows.
 * @alias module:mining.mine
 * @param {Buffer} hdr
 * @param {Buffer} target
 * @param {Number} rounds
 * @param {Object} params
 * @returns {Buffer|null}
 */

function mine(hdr, target, rounds, params) {
  const {bits, size, ease} = params;
  const miner = new Miner(bits, size, ease);
  const nonce = hdr.slice(consensus.NONCE_POS);

  // The heart and soul of the miner: match the target.
  for (let i = 0; i < rounds; i++) {
    const sol = miner.mineHeader(hdr);

    if (sol && rcmp(sol.hash(), target) <= 0)
      return [nonce, sol];

    for (let j = 0; j < consensus.NONCE_SIZE; j++) {
      if (nonce[j] !== 0xff) {
        nonce[j] += 1;
        break;
      }
      nonce[j] = 0;
    }
  }

  return [nonce, null];
}

/*
 * Expose
 */

module.exports = mine;
