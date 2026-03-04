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

exports.hsTypes = {
  DS: 0,
  NS: 1,
  GLUE4: 2,
  GLUE6: 3,
  SYNTH4: 4,
  SYNTH6: 5,
  TXT: 6,
  A: 7,
  AAAA: 8,
  CNAME: 9,
  DNAME: 10,
  MX: 11,
  SRV: 12,
  TLSA: 13,
  SSHFP: 14,
  CAA: 15,
  SOA: 16,
  PTR: 17,
  NAPTR: 18,
  SMIMEA: 19,
  OPENPGPKEY: 20,
  URI: 21,
  LOC: 22,
  RP: 23,
  LABEL: 24,
  RAW: 25
};

exports.hsTypesByVal = {
  [exports.hsTypes.DS]: 'DS',
  [exports.hsTypes.NS]: 'NS',
  [exports.hsTypes.GLUE4]: 'GLUE4',
  [exports.hsTypes.GLUE6]: 'GLUE6',
  [exports.hsTypes.SYNTH4]: 'SYNTH4',
  [exports.hsTypes.SYNTH6]: 'SYNTH6',
  [exports.hsTypes.TXT]: 'TXT',
  [exports.hsTypes.A]: 'A',
  [exports.hsTypes.AAAA]: 'AAAA',
  [exports.hsTypes.CNAME]: 'CNAME',
  [exports.hsTypes.DNAME]: 'DNAME',
  [exports.hsTypes.MX]: 'MX',
  [exports.hsTypes.SRV]: 'SRV',
  [exports.hsTypes.TLSA]: 'TLSA',
  [exports.hsTypes.SSHFP]: 'SSHFP',
  [exports.hsTypes.CAA]: 'CAA',
  [exports.hsTypes.SOA]: 'SOA',
  [exports.hsTypes.PTR]: 'PTR',
  [exports.hsTypes.NAPTR]: 'NAPTR',
  [exports.hsTypes.SMIMEA]: 'SMIMEA',
  [exports.hsTypes.OPENPGPKEY]: 'OPENPGPKEY',
  [exports.hsTypes.URI]: 'URI',
  [exports.hsTypes.LOC]: 'LOC',
  [exports.hsTypes.RP]: 'RP',
  [exports.hsTypes.LABEL]: 'LABEL',
  [exports.hsTypes.RAW]: 'RAW'
};
