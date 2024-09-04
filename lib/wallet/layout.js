/*!
 * layout.js - data layout for wallets
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const bdb = require('bdb');

/*
 * Wallet Database Layout:
 *  WDB State
 *  ---------
 *  V -> db version
 *  O -> flags
 *  D -> wallet id depth
 *  M -> migration state
 *
 *  Chain Sync
 *  ----------
 *  R -> chain sync state
 *  h[height] -> block hash
 *
 *  WID mappings
 *  --------
 *  b[height] -> block->wid map
 *  T[tx-hash] -> tx->wid map
 *  o[tx-hash][index] -> outpoint->wid map
 *  p[addr-hash] -> address->wid map
 *  N[name-hash] -> name->wid map
 *
 *  Wallet
 *  ------
 *  l[id] -> wid
 *  w[wid] -> wallet
 *  W[wid] -> wallet id
 *
 *  Wallet Account
 *  --------------
 *  a[wid][index] -> account
 *  i[wid][name] -> account index
 *  n[wid][index] -> account name
 *
 *  Wallet Path
 *  -----------
 *  P[wid][addr-hash] -> path data
 *  r[wid][index][addr-hash] -> dummy (addr by account)
 *
 *  TXDB
 *  ----
 *  t[wid]* -> txdb
 */

exports.wdb = {
  // WDB State
  V: bdb.key('V'),
  O: bdb.key('O'),
  D: bdb.key('D'),
  M: bdb.key('M'),

  // Chain Sync
  R: bdb.key('R'),
  h: bdb.key('h', ['uint32']),

  // WID Mappings
  b: bdb.key('b', ['uint32']),
  T: bdb.key('T', ['hash256']),
  p: bdb.key('p', ['hash']),
  o: bdb.key('o', ['hash256', 'uint32']),
  N: bdb.key('N', ['hash256']),

  // Wallet
  l: bdb.key('l', ['ascii']),
  w: bdb.key('w', ['uint32']),
  W: bdb.key('W', ['uint32']),

  // Wallet Account
  a: bdb.key('a', ['uint32', 'uint32']),
  i: bdb.key('i', ['uint32', 'ascii']),
  n: bdb.key('n', ['uint32', 'uint32']),

  // Wallet Path
  P: bdb.key('P', ['uint32', 'hash']),
  r: bdb.key('r', ['uint32', 'uint32', 'hash']),

  // TXDB
  t: bdb.key('t', ['uint32'])
};

/*
 * TXDB Database Layout:
 *   Balance
 *   -------
 *   R -> wallet balance
 *   r[account] -> account balance
 *   I -> Latest Unconfirmed Index
 *
 *   Coin
 *   ----
 *   c[tx-hash][index] -> coin
 *   C[account][tx-hash][index] -> dummy (coin by account)
 *   d[tx-hash][index] -> undo coin
 *   s[tx-hash][index] -> spent by hash
 *
 *   Transaction
 *   -----------
 *   t[tx-hash] -> extended tx
 *   T[account][tx-hash] -> dummy (tx by account)
 *   z[height][index] -> tx hash (tx by count)
 *   Z[account][height][index] -> tx hash (tx by count + account)
 *   y[hash] -> count (count for tx)
 *   x[hash] -> undo count (unconfirmed count for tx)
 *
 *   Confirmed
 *   ---------
 *   b[height] -> block record
 *   h[height][tx-hash] -> dummy (tx by height)
 *   H[account][height][tx-hash] -> dummy (tx by height + account)
 *   g[time][height][index][hash] -> dummy (tx by time)
 *   G[account][time][height][index][hash] -> dummy (tx by time + account)
 *
 *   Unconfirmed
 *   -----------
 *   p[hash] -> dummy (pending tx)
 *   P[account][tx-hash] -> dummy (pending tx by account)
 *   w[time][count][hash] -> dummy (tx by time)
 *   W[account][time][count][hash] -> dummy (tx by time + account)
 *   e[hash] -> undo time (unconfirmed time for tx)
 *
 *   Names
 *   -----
 *   A[name-hash] -> name record (name record by name hash)
 *   U[tx-hash] -> name undo record (name undo record by tx hash)
 *   i[name-hash][tx-hash][index] -> bid (BlindBid by name + tx + index)
 *   B[name-hash][tx-hash][index] -> reveal (BidReveal by name + tx + index)
 *   E[name-hash][tx-hash][index] - bid to reveal out (by bid txhash + index)
 *   v[blind-hash] -> blind (Blind Value by blind hash)
 *   o[name-hash] -> tx hash OPEN only (tx hash by name hash)
 */

exports.txdb = {
  prefix: bdb.key('t', ['uint32']),

  // Balance
  R: bdb.key('R'),
  r: bdb.key('r', ['uint32']),
  I: bdb.key('I'),

  // Coin
  c: bdb.key('c', ['hash256', 'uint32']),
  C: bdb.key('C', ['uint32', 'hash256', 'uint32']),
  d: bdb.key('d', ['hash256', 'uint32']),
  s: bdb.key('s', ['hash256', 'uint32']),

  // Transaction
  t: bdb.key('t', ['hash256']),
  T: bdb.key('T', ['uint32', 'hash256']),
  z: bdb.key('z', ['uint32', 'uint32']),
  Z: bdb.key('Z', ['uint32', 'uint32', 'uint32']),
  y: bdb.key('y', ['hash256']),
  x: bdb.key('x', ['hash256']),

  // Confirmed
  b: bdb.key('b', ['uint32']),
  h: bdb.key('h', ['uint32', 'hash256']),
  H: bdb.key('H', ['uint32', 'uint32', 'hash256']),
  g: bdb.key('g', ['uint32', 'uint32', 'uint32', 'hash256']),
  G: bdb.key('G', ['uint32', 'uint32', 'uint32', 'uint32', 'hash256']),

  // Unconfirmed
  p: bdb.key('p', ['hash256']),
  P: bdb.key('P', ['uint32', 'hash256']),
  w: bdb.key('w', ['uint32', 'uint32', 'hash256']),
  W: bdb.key('W', ['uint32', 'uint32', 'uint32', 'hash256']),
  e: bdb.key('e', ['hash256']),

  // Names
  A: bdb.key('A', ['hash256']),
  U: bdb.key('U', ['hash256']),
  i: bdb.key('i', ['hash256', 'hash256', 'uint32']),
  B: bdb.key('B', ['hash256', 'hash256', 'uint32']),
  E: bdb.key('E', ['hash256', 'hash256', 'uint32']),
  v: bdb.key('v', ['hash256']),
  o: bdb.key('o', ['hash256'])
};
