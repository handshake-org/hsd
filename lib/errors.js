/*!
 * errors.js - internal error objects for hsd
 * Copyright (c) 2022 The Handshake Developers (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module errors
 */

/**
 * Critical Error
 * An error severe enough to warrant shutting down the node.
 * @extends Error
 */

class CriticalError extends Error {
  /**
   * Create a verify error.
   * @constructor
   * @param {String} msg
   */

  constructor(msg) {
    super();

    this.type = 'CriticalError';
    this.message = `Critical Error: ${msg}`;

    if (Error.captureStackTrace)
      Error.captureStackTrace(this, CriticalError);
  }
}

/*
 * Expose
 */

exports.CriticalError = CriticalError;
