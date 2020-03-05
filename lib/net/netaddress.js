/*!
 * netaddress.js - network address object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const IP = require('binet');
const base32 = require('bcrypto/lib/encoding/base32');
const Network = require('../protocol/network');
const util = require('../utils/util');
const common = require('./common');

/*
 * Constants
 */

const ZERO_KEY = Buffer.alloc(33, 0x00);

/**
 * Net Address
 * Represents a network address.
 * @alias module:net.NetAddress
 * @property {Host} host
 * @property {Number} port
 * @property {Number} services
 * @property {Number} time
 */

class NetAddress extends bio.Struct {
  /**
   * Create a network address.
   * @constructor
   * @param {Object} options
   * @param {Number?} options.time - Timestamp.
   * @param {Number?} options.services - Service bits.
   * @param {String?} options.host - IP address (IPv6 or IPv4).
   * @param {Number?} options.port - Port.
   */

  constructor(options) {
    super();

    this.host = '0.0.0.0';
    this.port = 0;
    this.services = 0;
    this.time = 0;
    this.hostname = '0.0.0.0:0';
    this.raw = IP.ZERO_IP;
    this.key = ZERO_KEY;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(typeof options.host === 'string');
    assert(typeof options.port === 'number');

    this.raw = IP.toBuffer(options.host);
    this.host = IP.toString(this.raw);
    this.port = options.port;

    if (options.services) {
      assert(typeof options.services === 'number');
      this.services = options.services;
    }

    if (options.time) {
      assert(typeof options.time === 'number');
      this.time = options.time;
    }

    if (options.key) {
      assert(Buffer.isBuffer(options.key));
      assert(options.key.length === 33);
      this.key = options.key;
    }

    this.hostname = IP.toHostname(this.host, this.port, this.key);

    return this;
  }

  /**
   * Test whether required services are available.
   * @param {Number} services
   * @returns {Boolean}
   */

  hasServices(services) {
    return (this.services & services) === services;
  }

  /**
   * Test whether the address is IPv4.
   * @returns {Boolean}
   */

  isIPv4() {
    return IP.isIPv4(this.raw);
  }

  /**
   * Test whether the address is IPv6.
   * @returns {Boolean}
   */

  isIPv6() {
    return IP.isIPv6(this.raw);
  }

  /**
   * Test whether the host is null.
   * @returns {Boolean}
   */

  isNull() {
    return IP.isNull(this.raw);
  }

  /**
   * Test whether the host is a local address.
   * @returns {Boolean}
   */

  isLocal() {
    return IP.isLocal(this.raw);
  }

  /**
   * Test whether the host is valid.
   * @returns {Boolean}
   */

  isValid() {
    return IP.isValid(this.raw);
  }

  /**
   * Test whether the host is routable.
   * @returns {Boolean}
   */

  isRoutable() {
    return IP.isRoutable(this.raw);
  }

  /**
   * Test whether the host is an onion address.
   * @returns {Boolean}
   */

  isOnion() {
    return IP.isOnion(this.raw);
  }

  /**
   * Test whether the peer has a key.
   * @returns {Boolean}
   */

  hasKey() {
    return !this.key.equals(ZERO_KEY);
  }

  /**
   * Compare against another network address.
   * @returns {Boolean}
   */

  equal(addr) {
    return this.compare(addr) === 0;
  }

  /**
   * Compare against another network address.
   * @returns {Number}
   */

  compare(addr) {
    const cmp = this.raw.compare(addr.raw);

    if (cmp !== 0)
      return cmp;

    return this.port - addr.port;
  }

  /**
   * Get reachable score to destination.
   * @param {NetAddress} dest
   * @returns {Number}
   */

  getReachability(dest) {
    return IP.getReachability(this.raw, dest.raw);
  }

  /**
   * Set null host.
   */

  setNull() {
    this.raw = IP.ZERO_IP;
    this.host = '0.0.0.0';
    this.key = ZERO_KEY;
    this.hostname = IP.toHostname(this.host, this.port, this.key);
  }

  /**
   * Set host.
   * @param {String} host
   */

  setHost(host) {
    this.raw = IP.toBuffer(host);
    this.host = IP.toString(this.raw);
    this.hostname = IP.toHostname(this.host, this.port, this.key);
  }

  /**
   * Set port.
   * @param {Number} port
   */

  setPort(port) {
    assert(port >= 0 && port <= 0xffff);
    this.port = port;
    this.hostname = IP.toHostname(this.host, this.port, this.key);
  }

  /**
   * Set key.
   * @param {Buffer} key
   */

  setKey(key) {
    if (key == null)
      key = ZERO_KEY;

    assert(Buffer.isBuffer(key) && key.length === 33);

    this.key = key;
    this.hostname = IP.toHostname(this.host, this.port, this.key);
  }

  /**
   * Get key.
   * @param {String} enc
   * @returns {String|Buffer}
   */

  getKey(enc) {
    if (!this.hasKey())
      return null;

    if (enc === 'base32')
      return base32.encode(this.key);

    if (enc === 'hex')
      return this.key.toString('hex');

    return this.key;
  }

  /**
   * Inject properties from host, port, and network.
   * @private
   * @param {String} host
   * @param {Number} port
   * @param {(Network|NetworkType)?} network
   */

  fromHost(host, port, key, network) {
    network = Network.get(network);

    assert(port >= 0 && port <= 0xffff);
    assert(!key || Buffer.isBuffer(key));
    assert(!key || key.length === 33);

    this.raw = IP.toBuffer(host);
    this.host = IP.toString(this.raw);
    this.port = port;
    this.services = NetAddress.DEFAULT_SERVICES;
    this.time = network.now();
    this.key = key || ZERO_KEY;
    this.hostname = IP.toHostname(this.host, this.port, this.key);

    return this;
  }

  /**
   * Instantiate a network address
   * from a host and port.
   * @param {String} host
   * @param {Number} port
   * @param {(Network|NetworkType)?} network
   * @returns {NetAddress}
   */

  static fromHost(host, port, key, network) {
    return new this().fromHost(host, port, key, network);
  }

  /**
   * Inject properties from hostname and network.
   * @private
   * @param {String} hostname
   * @param {(Network|NetworkType)?} network
   */

  fromHostname(hostname, network) {
    network = Network.get(network);

    const addr = IP.fromHostname(hostname);

    if (addr.port === 0)
      addr.port = addr.key ? network.brontidePort : network.port;

    return this.fromHost(addr.host, addr.port, addr.key, network);
  }

  /**
   * Instantiate a network address
   * from a hostname (i.e. 127.0.0.1:8333).
   * @param {String} hostname
   * @param {(Network|NetworkType)?} network
   * @returns {NetAddress}
   */

  static fromHostname(hostname, network) {
    return new this().fromHostname(hostname, network);
  }

  /**
   * Inject properties from socket.
   * @private
   * @param {net.Socket} socket
   */

  fromSocket(socket, network) {
    const host = socket.remoteAddress;
    const port = socket.remotePort;
    assert(typeof host === 'string');
    assert(typeof port === 'number');
    return this.fromHost(IP.normalize(host), port, null, network);
  }

  /**
   * Instantiate a network address
   * from a socket.
   * @param {net.Socket} socket
   * @returns {NetAddress}
   */

  static fromSocket(hostname, network) {
    return new this().fromSocket(hostname, network);
  }

  /**
   * Calculate serialization size of address.
   * @returns {Number}
   */

  getSize() {
    return 88;
  }

  /**
   * Write network address to a buffer writer.
   * @param {BufferWriter} bw
   * @returns {Buffer}
   */

  write(bw) {
    bw.writeU64(this.time);
    bw.writeU32(this.services);
    bw.writeU32(0);
    bw.writeU8(0);
    bw.writeBytes(this.raw);
    bw.fill(0, 20); // reserved
    bw.writeU16(this.port);
    bw.writeBytes(this.key);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.time = br.readU64();
    this.services = br.readU32();

    // Note: hi service bits
    // are currently unused.
    br.readU32();

    if (br.readU8() === 0) {
      this.raw = br.readBytes(16);
      br.seek(20);
    } else {
      this.raw = Buffer.alloc(16, 0x00);
      br.seek(36);
    }

    this.port = br.readU16();
    this.key = br.readBytes(33);

    this.host = IP.toString(this.raw);
    this.hostname = IP.toHostname(this.host, this.port, this.key);

    return this;
  }

  /**
   * Convert net address to json-friendly object.
   * @returns {Object}
   */

  getJSON() {
    return {
      host: this.host,
      port: this.port,
      services: this.services,
      time: this.time,
      key: this.key.toString('hex')
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   * @returns {NetAddress}
   */

  fromJSON(json) {
    assert((json.port & 0xffff) === json.port);
    assert((json.services >>> 0) === json.services);
    assert((json.time >>> 0) === json.time);
    assert(typeof json.key === 'string');
    this.raw = IP.toBuffer(json.host);
    this.host = json.host;
    this.port = json.port;
    this.services = json.services;
    this.time = json.time;
    this.key = Buffer.from(json.key, 'hex');
    this.hostname = IP.toHostname(this.host, this.port, this.key);
    return this;
  }

  /**
   * Inspect the network address.
   * @returns {Object}
   */

  format() {
    return '<NetAddress:'
      + ` hostname=${this.hostname}`
      + ` services=${this.services.toString(2)}`
      + ` date=${util.date(this.time)}`
      + '>';
  }
}

/**
 * Default services for
 * unknown outbound peers.
 * @const {Number}
 * @default
 */

NetAddress.DEFAULT_SERVICES = 0
  | common.services.NETWORK
  | common.services.BLOOM;

/*
 * Expose
 */

module.exports = NetAddress;
