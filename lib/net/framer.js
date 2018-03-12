/*!
 * framer.js - packet framer for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const Network = require('../protocol/network');
const hash256 = require('bcrypto/lib/hash256');

/**
 * Protocol Message Framer
 * @alias module:net.Framer
 */

class Framer {
  /**
   * Create a framer.
   * @constructor
   * @param {Network} network
   */

  constructor(network) {
    this.network = Network.get(network);
  }

  /**
   * Frame a payload with a header.
   * @param {Number} cmd - Packet type.
   * @param {Buffer} payload
   * @param {Buffer?} checksum - Precomputed checksum.
   * @returns {Buffer} Payload with header prepended.
   */

  packet(cmd, payload) {
    assert((cmd & 0xff) === cmd);
    assert(Buffer.isBuffer(payload));
    assert(payload.length <= 0xffffffff);

    const msg = Buffer.allocUnsafe(9 + payload.length);

    // Magic value
    msg.writeUInt32LE(this.network.magic, 0, true);

    // Command
    msg[4] = cmd;

    // Payload length
    msg.writeUInt32LE(payload.length, 5, true);

    payload.copy(msg, 9);

    return msg;
  }
}

/*
 * Expose
 */

module.exports = Framer;
