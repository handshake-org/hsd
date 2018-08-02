/*!
 * common.js - chain constants for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module blockchain/common
 */

/**
 * Locktime flags.
 * @enum {Number}
 */

exports.lockFlags = {};

/**
 * Consensus locktime flags (used for block validation).
 * @const {LockFlags}
 * @default
 */

exports.lockFlags.MANDATORY_LOCKTIME_FLAGS = 0;;

/**
 * Standard locktime flags (used for mempool validation).
 * @const {LockFlags}
 * @default
 */

exports.lockFlags.STANDARD_LOCKTIME_FLAGS = 0
  | exports.lockFlags.MANDATORY_LOCKTIME_FLAGS;

/**
 * Threshold states for versionbits
 * @enum {Number}
 * @default
 */

exports.thresholdStates = {
  DEFINED: 0,
  STARTED: 1,
  LOCKED_IN: 2,
  ACTIVE: 3,
  FAILED: 4
};

/**
 * Verify flags for blocks.
 * @enum {Number}
 * @default
 */

exports.flags = {
  VERIFY_NONE: 0,
  VERIFY_POW: 1 << 0,
  VERIFY_BODY: 1 << 1
};

/**
 * Default block verify flags.
 * @const {Number}
 * @default
 */

exports.flags.DEFAULT_FLAGS = 0
  | exports.flags.VERIFY_POW
  | exports.flags.VERIFY_BODY;
