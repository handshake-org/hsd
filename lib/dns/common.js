/*!
 * common.js - dns constants for hsd
 * Copyright (c) 2021, The Handshake Developers (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module dns/common
 */

exports.DUMMY = Buffer.alloc(0);

// About one mainnet Urkel Tree interval.
// (60 seconds * 10 minutes * 36)
exports.DEFAULT_TTL = 21600;

// NS SOA RRSIG NSEC DNSKEY
// Types available for the root "."
exports.TYPE_MAP_ROOT = Buffer.from('000722000000000380', 'hex');

// RRSIG NSEC
exports.TYPE_MAP_EMPTY =  Buffer.from('0006000000000003', 'hex');

// NS RRSIG NSEC
exports.TYPE_MAP_NS = Buffer.from('0006200000000003', 'hex');

// TXT RRSIG NSEC
exports.TYPE_MAP_TXT = Buffer.from('0006000080000003', 'hex');

// A RRSIG NSEC
exports.TYPE_MAP_A = Buffer.from('0006400000000003', 'hex');

// AAAA RRSIG NSEC
exports.TYPE_MAP_AAAA = Buffer.from('0006000000080003', 'hex');

exports.hsTypes = {
  DS: 0,
  NS: 1,
  GLUE4: 2,
  GLUE6: 3,
  SYNTH4: 4,
  SYNTH6: 5,
  TXT: 6
};

exports.hsTypesByVal = {
  [exports.hsTypes.DS]: 'DS',
  [exports.hsTypes.NS]: 'NS',
  [exports.hsTypes.GLUE4]: 'GLUE4',
  [exports.hsTypes.GLUE6]: 'GLUE6',
  [exports.hsTypes.SYNTH4]: 'SYNTH4',
  [exports.hsTypes.SYNTH6]: 'SYNTH6',
  [exports.hsTypes.TXT]: 'TXT'
};
