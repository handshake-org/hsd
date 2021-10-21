/*!
 * errors.js - internal error objects for hsd
 * Copyright (c) 2022 The Handshake Developers (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module errors
 */

const assert = require('bsert');

/**
 * Critical Error
 * An error severe enough to warrant shutting down the node.
 * @extends Error
 * @param {Block|TX} msg
 * @param {String} code - Reject packet code.
 * @param {String} reason - Reject packet reason.
 * @param {Number} score - Ban score increase
 * (can be -1 for no reject packet).
 * @param {Boolean} malleated
 */

class CriticalError extends Error {
  /**
   * Create a verify error.
   * @constructor
   * @param {Block|TX} msg
   * @param {String} code - Reject packet code.
   * @param {String} reason - Reject packet reason.
   * @param {Number} score - Ban score increase
   * (can be -1 for no reject packet).
   * @param {Boolean} malleated
   */

  constructor(err) {
    super();

    this.type = 'CriticalError';

    if (err instanceof Error) {
      this.message = `Critical Error: ${err.message}`;
    } else {
      assert(typeof err === 'string');
      this.message = `Critical Error: ${err}`;
    }

    if (Error.captureStackTrace)
      Error.captureStackTrace(this, CriticalError);
  }
}

/*
 * Expose
 */

exports.CriticalError = CriticalError;
