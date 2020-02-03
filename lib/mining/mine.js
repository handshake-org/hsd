/*!
 * mine.js - mining function for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bio = require('bufio');
const SHA3 = require('bcrypto/lib/sha3');
const BLAKE2b = require('bcrypto/lib/blake2b');
const Headers = require('../primitives/headers');

/**
 * Hash until the nonce overflows.
 * @alias module:mining.mine
 * @param {Buffer} raw
 * @param {Buffer} target
 * @param {Number} rounds
 * @returns {Buffer|null}
 */

function mine(raw, target, rounds) {
  const hdr = Headers.fromMiner(raw);
  const data = hdr.toPrehead();
  const pad8 = hdr.padding(8);
  const pad32 = hdr.padding(32);

  let nonce = 0;

  // The heart and soul of the miner: match the target.
  for (let i = 0; i < rounds; i++) {
    const left = BLAKE2b.digest(data, 64);
    const right = SHA3.multi(data, pad8);
    const hash = BLAKE2b.multi(left, pad32, right);

    if (hash.compare(target) <= 0)
      return [nonce, true];

    nonce += 1;

    bio.writeU32(data, nonce, 0);
  }

  return [nonce, false];
}

/*
 * Expose
 */

module.exports = mine;
