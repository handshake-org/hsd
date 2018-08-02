/*!
 * key.js - dnssec key for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const {dnssec, wire} = require('bns');
const {Record} = wire;

// pub: 034fd714449d8cfcccfdaba52c64d63e3aca72be3f94bfeb60aeb5a42ed3d0c205
exports.kskPriv = Buffer.from(
  '1c74c825c5b0f08cf6be846bfc93c423f03e3e1f6202fb2d96474b1520bbafad',
  'hex');

// pub: 032399cfb3a72515ad609f09fd22954319d24b7c438dce00f535c7ee13010856e2
exports.zskPriv = Buffer.from(
  '54276ff8604a3494c5c76d6651f14b289c7253ba636be4bfd7969308f48da47d',
  'hex');

exports.ksk = Record.fromJSON({
  name: '.',
  ttl: 10800,
  class: 'IN',
  type: 'DNSKEY',
  data: {
    flags: 257,
    protocol: 3,
    algorithm: 13,
    publicKey: ''
      + 'T9cURJ2M/Mz9q6UsZNY+Ospyvj+Uv+tgrrWkLtPQwgU/Xu5Yk0l02Sn5ua2x'
      + 'AQfEYIzRO6v5iA+BejMeEwNP4Q=='
  }
});

exports.zsk = Record.fromJSON({
  name: '.',
  ttl: 10800,
  class: 'IN',
  type: 'DNSKEY',
  data: {
    flags: 256,
    protocol: 3,
    algorithm: 13,
    publicKey: ''
      + 'I5nPs6clFa1gnwn9IpVDGdJLfEONzgD1NcfuEwEIVuIoHdZGgvVblsLNbRO+'
      + 'spW3nQYHg92svhy1HOjTiFBIsQ=='
  }
});

// . DS 35215 13 2
// 7C50EA94A63AEECB65B510D1EAC1846C973A89D4AB292287D5A4D715136B57A3
exports.ds = dnssec.createDS(exports.ksk, dnssec.hashes.SHA256);

exports.signKSK = function signKSK(section, type) {
  return dnssec.signType(section, type, exports.ksk, exports.kskPriv);
};

exports.signZSK = function signZSK(section, type) {
  return dnssec.signType(section, type, exports.zsk, exports.zskPriv);
};
