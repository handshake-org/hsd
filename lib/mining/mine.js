/*!
 * mine.js - mining function for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const KMAC256 = require('bcrypto/lib/kmac256');
const BLAKE2b256 = require('bcrypto/lib/blake2b256');
const consensus = require('../protocol/consensus');

/**
 * Hash until the nonce overflows.
 * @alias module:mining.mine
 * @param {Buffer} hdr
 * @param {Buffer} target
 * @param {Number} rounds
 * @returns {Buffer|null}
 */

function mine(hdr, target, rounds) {
  const data = hdr.slice(0, consensus.NONCE_POS);
  const nonce = hdr.slice(consensus.NONCE_POS);

  // The heart and soul of the miner: match the target.
  for (let i = 0; i < rounds; i++) {
    const key = KMAC256.digest(data, nonce);
    const hash = BLAKE2b256.digest(data, key);

    if (hash.compare(target) <= 0)
      return [nonce, true];

    for (let j = 0; j < consensus.NONCE_SIZE; j++) {
      if (nonce[j] !== 0xff) {
        nonce[j] += 1;
        break;
      }
      nonce[j] = 0;
    }
  }

  return [nonce, false];
}

/*
 * Expose
 */

module.exports = mine;
