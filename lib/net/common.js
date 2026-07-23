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
 * Private regtest-only HNSR proof-of-concept assignments.
 *
 * These values are deliberately not protocol assignments and MUST NOT be
 * advertised on public networks. They occupy the same experimental namespace
 * as the companion DNS relay prototypes.
 * @const {Number}
 */

exports.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE = 0x04000000;
exports.EXPERIMENTAL_HNSR_RELAY_SERVICE = 0x08000000;
exports.EXPERIMENTAL_HNSR = 0xf3;

exports.services.EXPERIMENTAL_HNSR_RENDEZVOUS =
  exports.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE;
exports.services.EXPERIMENTAL_HNSR_RELAY =
  exports.EXPERIMENTAL_HNSR_RELAY_SERVICE;

/**
 * Regtest HNSR proof-of-concept limits.
 * @enum {Number}
 */

exports.hnsr = {
  VERSION: 1,
  MAX_PACKET_SIZE: 65535,
  MAX_RECORD_SIZE: 8192,
  MAX_RECORDS_PER_KEY: 16,
  MAX_STORED_RECORDS: 50000,
  MAX_CONTACTS: 16,
  MAX_ROUTING_CONTACTS: 2048,
  MAX_FIND_QUERIES: 32,
  ROUTE_REPLICATION: 8,
  MIN_ROUTE_STORES: 3,
  MAX_DATA_SIZE: 16384,
  MAX_CIRCUIT_QUEUE: 65536,
  MAX_SOCKET_QUEUE: 8 * 1000 * 1000 + 65536,
  MAX_RELAY_QUEUE: 8 * 1024 * 1024,
  RELAY_BURST: 32768,
  MIN_WINDOW: 16384,
  DEFAULT_WINDOW: 65536,
  MAX_WINDOW: 1048576,
  DEFAULT_TIMEOUT: 5000,
  MAX_TICKET_LIFETIME: 7200,
  MAX_ROUTE_LIFETIME: 7200,
  MAX_CIRCUITS: 32,
  MAX_RESERVATIONS: 1024,
  MAX_RESERVATIONS_PER_PEER: 16,
  MAX_SIGNATURE_SIZE: 80,
  MAX_REQUESTS_PER_SECOND: 64,
  MAX_REQUEST_BYTES_PER_SECOND: 1048576,
  MAX_STORES_PER_PEER: 256
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
