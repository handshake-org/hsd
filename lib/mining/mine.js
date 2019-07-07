/*!
 * mine.js - mining function for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bio = require('bufio');
const SHA3 = require('bcrypto/lib/sha3');
const BLAKE2b = require('bcrypto/lib/blake2b');

/**
 * Hash until the nonce overflows.
 * @alias module:mining.mine
 * @param {Buffer} raw
 * @param {Buffer} target
 * @param {Number} rounds
 * @returns {Buffer|null}
 */

function mine(hdr, target, rounds) {
  const prevBlock = hdr.slice(32, 64);
  const treeRoot = hdr.slice(64, 96);
  const preHead = Buffer.from(hdr.slice(0, 128));
  const maskHash = hdr.slice(96, 128);
  const subHead = Buffer.from(hdr.slice(128, 256));

  const subHash = BLAKE2b.digest(subHead);
  const commitHash = BLAKE2b.multi(subHash, maskHash);

  commitHash.copy(preHead, 96);

  const pad32 = Buffer.alloc(32);
  const pad8 = pad32.slice(0, 8);

  for (let i = 0; i < 32; i++)
    pad32[i] = prevBlock[i] ^ treeRoot[i];

  let nonce = 0;

  // The heart and soul of the miner: match the target.
  for (let i = 0; i < rounds; i++) {
    const left = BLAKE2b.digest(preHead, 64);
    const right = SHA3.multi(preHead, pad8);
    const hash = BLAKE2b.multi(left, pad32, right);

    if (hash.compare(target) <= 0)
      return [nonce, true];

    nonce += 1;

    bio.writeU32(preHead, nonce, 0);
  }

  return [nonce, false];
}

/*
 * Expose
 */

module.exports = mine;
