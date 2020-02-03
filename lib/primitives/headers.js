/*!
 * headers.js - headers object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const util = require('../utils/util');
const AbstractBlock = require('./abstractblock');

/**
 * Headers
 * Represents block headers obtained
 * from the network via `headers`.
 * @alias module:primitives.Headers
 * @extends AbstractBlock
 */

class Headers extends AbstractBlock {
  /**
   * Create headers.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    if (options)
      this.parseOptions(options);
  }

  /**
   * Perform non-contextual
   * verification on the headers.
   * @returns {Boolean}
   */

  verifyBody() {
    return true;
  }

  /**
   * Get size of the headers.
   * @returns {Number}
   */

  getSize() {
    return this.sizeHead();
  }

  /**
   * Serialize the headers to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    this.writeHead(bw);
    return bw;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {Buffer} data
   */

  read(br) {
    this.readHead(br);
    return this;
  }

  /**
   * Instantiate headers from serialized data.
   * @param {Buffer} data
   * @returns {Headers}
   */

  static fromHead(data) {
    return new this().fromHead(data);
  }

  /**
   * Instantiate headers from a chain entry.
   * @param {ChainEntry} entry
   * @returns {Headers}
   */

  static fromEntry(entry) {
    const headers = new this();
    headers.version = entry.version;
    headers.prevBlock = entry.prevBlock;
    headers.merkleRoot = entry.merkleRoot;
    headers.witnessRoot = entry.witnessRoot;
    headers.treeRoot = entry.treeRoot;
    headers.reservedRoot = entry.reservedRoot;
    headers.time = entry.time;
    headers.bits = entry.bits;
    headers.nonce = entry.nonce;
    headers.extraNonce = entry.extraNonce;
    headers.mask = entry.mask;
    headers._hash = entry.hash;
    return headers;
  }

  /**
   * Convert the block to a headers object.
   * @returns {Headers}
   */

  toHeaders() {
    return this;
  }

  /**
   * Convert the block to a headers object.
   * @param {Block|MerkleBlock} block
   * @returns {Headers}
   */

  static fromBlock(block) {
    const headers = new this(block);
    headers._hash = block._hash;
    return headers;
  }

  /**
   * Convert the block to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @param {CoinView} view
   * @param {Number} height
   * @returns {Object}
   */

  getJSON(network, view, height) {
    return {
      hash: this.hash().toString('hex'),
      height: height,
      version: this.version,
      prevBlock: this.prevBlock.toString('hex'),
      merkleRoot: this.merkleRoot.toString('hex'),
      witnessRoot: this.witnessRoot.toString('hex'),
      treeRoot: this.treeRoot.toString('hex'),
      reservedRoot: this.reservedRoot.toString('hex'),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce,
      extraNonce: this.extraNonce.toString('hex'),
      mask: this.mask.toString('hex')
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    this.parseJSON(json);
    return this;
  }

  /**
   * Inspect the headers and return a more
   * user-friendly representation of the data.
   * @param {CoinView} view
   * @param {Number} height
   * @returns {Object}
   */

  format(view, height) {
    return {
      hash: this.hash().toString('hex'),
      height: height != null ? height : -1,
      date: util.date(this.time),
      version: this.version.toString(16),
      prevBlock: this.prevBlock.toString('hex'),
      merkleRoot: this.merkleRoot.toString('hex'),
      witnessRoot: this.witnessRoot.toString('hex'),
      treeRoot: this.treeRoot.toString('hex'),
      reservedRoot: this.reservedRoot.toString('hex'),
      time: this.time,
      bits: this.bits,
      nonce: this.nonce,
      extraNonce: this.extraNonce.toString('hex'),
      mask: this.mask.toString('hex')
    };
  }

  /**
   * Test an object to see if it is a Headers object.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isHeaders(obj) {
    return obj instanceof Headers;
  }
}

/*
 * Expose
 */

module.exports = Headers;
