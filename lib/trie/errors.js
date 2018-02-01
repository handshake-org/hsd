/*!
 * errors.js - patricia merkle trie errors
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 *
 * Patricia Merkle Tries:
 *   https://github.com/ethereum/wiki/wiki/Patricia-Tree
 *
 * Parts of this software are based on go-ethereum:
 *   Copyright (C) 2014 The go-ethereum Authors.
 *   https://github.com/ethereum/go-ethereum/tree/master/trie
 */

'use strict';

const common = require('./common');

/*
 * Constants
 */

const {
  ZERO_HASH,
  fromNibbles
} = common;

/**
 * Missing Node Error
 */

class MissingNodeError extends Error {
  /**
   * Create an error.
   * @constructor
   * @param {Object?} options
   */

  constructor(options = {}) {
    super();
    this.type = 'MissingNodeError';
    this.code = 'ERR_MISSING_NODE';
    this.rootHash = options.rootHash || ZERO_HASH;
    this.nodeHash = options.nodeHash || ZERO_HASH;
    this.key = options.key ? fromNibbles(options.key) : null;
    this.pos = options.pos >>> 0;
    this.message = `Missing node: ${this.nodeHash.toString('hex')}.`;

    if (Error.captureStackTrace)
      Error.captureStackTrace(this, MissingNodeError);
  }
}

/*
 * Expose
 */

exports.MissingNodeError = MissingNodeError;
