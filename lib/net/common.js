/*!
 * common.js - p2p constants for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module net/common
 */

const random = require('bcrypto/lib/random');
const pkg = require('../pkg');

/**
 * Default protocol version.
 * @const {Number}
 * @default
 */

exports.PROTOCOL_VERSION = 3;

/**
 * Minimum protocol version we're willing to talk to.
 * @const {Number}
 * @default
 */

exports.MIN_VERSION = 1;

/**
 * Service bits.
 * @enum {Number}
 * @default
 */

exports.services = {
  /**
   * Whether network services are enabled.
   */

  NETWORK: 1 << 0,

  /**
   * Whether the peer supports BIP37.
   */

  BLOOM: 1 << 1
};

/**
 * Experimental DNS relay service bit.
 *
 * This is a private proof-of-concept assignment. It must not be treated as a
 * standardized Handshake service bit.
 * @const {Number}
 * @default
 */

exports.EXPERIMENTAL_DNS_RELAY_SERVICE = 0x40000000;

exports.services.EXPERIMENTAL_DNS_RELAY =
  exports.EXPERIMENTAL_DNS_RELAY_SERVICE;

/**
 * Experimental DNS relay packet types.
 *
 * These are private proof-of-concept assignments. Packet framing permits the
 * full uint8 range and legacy peers decode these values as unknown packets.
 * @const {Number}
 * @default
 */

exports.EXPERIMENTAL_GET_DNS_RELAY = 0xf0;
exports.EXPERIMENTAL_DNS_RELAY = 0xf1;

/**
 * Experimental DNS relay limits.
 * @enum {Number}
 * @default
 */

exports.dnsRelay = {
  MAX_QUERY_SIZE: 4096,
  MAX_RESPONSE_SIZE: 0xffff,
  MAX_REQUEST_PAYLOAD_SIZE: 8 + 2 + 4096,
  MAX_RESPONSE_PAYLOAD_SIZE: 8 + 1 + 2 + 0xffff,
  REQUEST_ID_SIZE: 8,
  DEFAULT_TIMEOUT: 3000,
  DEFAULT_RATE: 20,
  DEFAULT_BURST: 40,
  DEFAULT_GLOBAL_RATE: 200,
  DEFAULT_GLOBAL_BURST: 400,
  DEFAULT_AUTHORITY_RATE: 50,
  DEFAULT_AUTHORITY_BURST: 100,
  MAX_AUTHORITY_RATE_BUCKETS: 1024,
  DEFAULT_PEER_INFLIGHT: 16,
  DEFAULT_GLOBAL_INFLIGHT: 64
};

/**
 * Experimental DNS relay transport statuses.
 * @enum {Number}
 * @default
 */

exports.dnsRelayStatus = {
  OK: 0,
  REFUSED: 1,
  UNSUPPORTED: 2,
  BUSY: 3,
  INVALID_QUERY: 4,
  RESOLVER_UNAVAILABLE: 5,
  TIMEOUT: 6,
  INTERNAL_ERROR: 7
};

/**
 * Our node's services (we support everything).
 * @const {Number}
 * @default
 */

exports.LOCAL_SERVICES = 0
  | exports.services.NETWORK;

/**
 * Required services (network).
 * @const {Number}
 * @default
 */

exports.REQUIRED_SERVICES = 0
  | exports.services.NETWORK;

/**
 * Default user agent: `/[pkg.name]:[version]/`.
 * @const {String}
 * @default
 */

exports.USER_AGENT = `/${pkg.name}:${pkg.version}/`;

/**
 * Max message size (~8mb)
 * @const {Number}
 * @default
 */

exports.MAX_MESSAGE = 8 * 1000 * 1000;

/**
 * Amount of time to ban misbheaving peers.
 * @const {Number}
 * @default
 */

exports.BAN_TIME = 24 * 60 * 60;

/**
 * Ban score threshold before ban is placed in effect.
 * @const {Number}
 * @default
 */

exports.BAN_SCORE = 100;

/**
 * Create a nonce.
 * @returns {Buffer}
 */

exports.nonce = function nonce() {
  return random.randomBytes(8);
};

/**
 * A compressed pubkey of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_KEY = Buffer.alloc(33, 0x00);

/**
 * A 64 byte signature of all zeroes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_SIG = Buffer.alloc(64, 0x00);

/**
 * 8 zero bytes.
 * @const {Buffer}
 * @default
 */

exports.ZERO_NONCE = Buffer.alloc(8, 0x00);

/**
 * Maximum inv/getdata size.
 * @const {Number}
 * @default
 */

exports.MAX_INV = 50000;

/**
 * Maximum number of requests.
 * @const {Number}
 * @default
 */

exports.MAX_REQUEST = 5000;

/**
 * Maximum number of block requests.
 * @const {Number}
 * @default
 */

exports.MAX_BLOCK_REQUEST = 50000 + 1000;

/**
 * Maximum number of tx requests.
 * @const {Number}
 * @default
 */

exports.MAX_TX_REQUEST = 10000;

/**
 * Maximum number of claim requests.
 * @const {Number}
 * @default
 */

exports.MAX_CLAIM_REQUEST = 1000;
