/*!
 * layout.js - mempool data layout for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bdb = require('bdb');

/*
 * Database Layout:
 *   V -> db version
 *   v -> serialization version
 *   R -> tip hash
 *   e[hash] -> entry
 */

const layout = {
  V: bdb.key('V'),
  v: bdb.key('v'),
  R: bdb.key('R'),
  F: bdb.key('F'),
  e: bdb.key('e', ['hash256'])
};

/*
 * Expose
 */

module.exports = layout;
