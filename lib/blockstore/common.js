/*!
 * common.js - blockstore constants for hsd
 * Copyright (c) 2019, Braydon Fuller (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module blockstore/common
 */

/**
 * Block data types.
 * @enum {Number}
 */

exports.types = {
  BLOCK: 1,
  UNDO: 2,
  MERKLE: 3
};

/**
 * File prefixes for block data types.
 * @enum {String}
 */

exports.prefixes = {
  1: 'blk',
  2: 'blu',
  3: 'blm'
};
