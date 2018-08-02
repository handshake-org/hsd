/*!
 * parser.js - packet parser for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint nonblock-statement-body-position: "off" */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const {format} = require('util');
const Network = require('../protocol/network');
const common = require('./common');
const packets = require('./packets');

/**
 * Protocol Message Parser
 * @alias module:net.Parser
 * @extends EventEmitter
 * @emits Parser#error
 * @emits Parser#packet
 */

class Parser extends EventEmitter {
  /**
   * Create a parser.
   * @constructor
   * @param {Network} network
   */

  constructor(network) {
    super();

    this.network = Network.get(network);

    this.pending = [];
    this.total = 0;
    this.waiting = 9;
    this.header = null;
  }

  /**
   * Emit an error.
   * @private
   * @param {...String} msg
   */

  error() {
    const msg = format.apply(null, arguments);
    this.emit('error', new Error(msg));
  }

  /**
   * Feed data to the parser.
   * @param {Buffer} data
   */

  feed(data) {
    this.total += data.length;
    this.pending.push(data);

    while (this.total >= this.waiting) {
      const chunk = Buffer.allocUnsafe(this.waiting);

      let off = 0;

      while (off < chunk.length) {
        const len = this.pending[0].copy(chunk, off);
        if (len === this.pending[0].length)
          this.pending.shift();
        else
          this.pending[0] = this.pending[0].slice(len);
        off += len;
      }

      assert.strictEqual(off, chunk.length);

      this.total -= chunk.length;
      this.parse(chunk);
    }
  }

  /**
   * Parse a fully-buffered chunk.
   * @param {Buffer} chunk
   */

  parse(data) {
    assert(data.length <= common.MAX_MESSAGE);

    if (!this.header) {
      this.header = this.parseHeader(data);
      return;
    }

    let payload;
    try {
      payload = this.parsePayload(this.header.type, data);
    } catch (e) {
      this.waiting = 9;
      this.header = null;
      this.emit('error', e);
      return;
    }

    this.waiting = 9;
    this.header = null;

    this.emit('packet', payload);
  }

  /**
   * Parse buffered packet header.
   * @param {Buffer} data - Header.
   * @returns {Header}
   */

  parseHeader(data) {
    const magic = data.readUInt32LE(0, true);

    if (magic !== this.network.magic) {
      this.error('Invalid magic value: %s.', magic.toString(16));
      return null;
    }

    const type = data[4];
    const size = data.readUInt32LE(5, true);

    if (size > common.MAX_MESSAGE) {
      this.waiting = 9;
      this.error('Packet length too large: %d.', size);
      return null;
    }

    this.waiting = size;

    return new Header(type, size);
  }

  /**
   * Parse a payload.
   * @param {Number} type - Packet type.
   * @param {Buffer} data - Payload.
   * @returns {Object}
   */

  parsePayload(type, data) {
    return packets.decode(type, data);
  }
}

/**
 * Packet Header
 * @ignore
 */

class Header {
  /**
   * Create a header.
   * @constructor
   */

  constructor(type, size) {
    this.type = type;
    this.size = size;
  }
}

/*
 * Expose
 */

module.exports = Parser;
