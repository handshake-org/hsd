/*!
 * mine.js - mining function for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const {Miner} = require('bcuckoo');
const consensus = require('../protocol/consensus');

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
  const {bits, size, perc} = params;
  const miner = new Miner(bits, size, perc);
  const nonce = hdr.slice(consensus.NONCE_POS);

  // The heart and soul of the miner: match the target.
  for (let i = 0; i < rounds; i++) {
    const sol = miner.mineHeader(hdr);

    if (sol && sol.sha3().compare(target) <= 0)
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
