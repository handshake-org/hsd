// @ts-check
/*!
 * errors.js - error objects for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module protocol/errors
 */

const assert = require('bsert');

/** @typedef {import('../primitives/block')} Block */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('../primitives/claim')} Claim */
/** @typedef {import('../types').Hash} Hash */

/**
 * Verify Error
 * An error thrown during verification. Can be either
 * a mempool transaction validation error or a blockchain
 * block verification error. Ultimately used to send
 * `reject` packets to peers.
 * @extends Error
 * @property {Block|TX|Claim} msg
 * @property {String} code - Reject packet code.
 * @property {String} reason - Reject packet reason.
 * @property {Number} score - Ban score increase
 * (can be -1 for no reject packet).
 * @property {Boolean} malleated
 */

class VerifyError extends Error {
  /**
   * Create a verify error.
   * @constructor
   * @param {Block|TX|Claim} msg
   * @param {String} code - Reject packet code.
   * @param {String} reason - Reject packet reason.
   * @param {Number} score - Ban score increase
   * (can be -1 for no reject packet).
   * @param {Boolean} [malleated=false]
   */

  constructor(msg, code, reason, score, malleated) {
    super();

    assert(typeof code === 'string');
    assert(typeof reason === 'string');
    assert(score >= 0);

    this.type = 'VerifyError';
    this.message = '';
    this.code = code;
    this.reason = reason;
    this.score = score;
    this.hash = msg.hash();
    this.malleated = malleated || false;

    this.message = `Verification failure: ${reason}`
      + ` (code=${code} score=${score} hash=${msg.hash().toString('hex')})`;

    if (Error.captureStackTrace)
      Error.captureStackTrace(this, VerifyError);
  }
}

/*
 * Expose
 */

exports.VerifyError = VerifyError;
