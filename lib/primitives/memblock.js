/*!
 * memblock.js - memblock block object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const bio = require('bufio');
const AbstractBlock = require('./abstractblock');
const Block = require('./block');
const Headers = require('./headers');
const Input = require('./input');
const Output = require('./output');
const consensus = require('../protocol/consensus');
const DUMMY = Buffer.alloc(0);

/**
 * Mem Block
 * A block object which is essentially a "placeholder"
 * for a full {@link Block} object. The v8 garbage
 * collector's head will explode if there is too much
 * data on the javascript heap. Blocks can currently
 * be up to 1mb in size. In the future, they may be
 * 2mb, 8mb, or maybe 20mb, who knows? A MemBlock
 * is an optimization in Bcoin which defers parsing of
 * the serialized transactions (the block Buffer) until
 * the block has passed through the chain queue and
 * is about to enter the chain. This keeps a lot data
 * off of the javascript heap for most of the time a
 * block even exists in memory, and manages to keep a
 * lot of strain off of the garbage collector. Having
 * 500mb of blocks on the js heap would not be a good
 * thing.
 * @alias module:primitives.MemBlock
 * @extends AbstractBlock
 */

class MemBlock extends AbstractBlock {
  /**
   * Create a mem block.
   * @constructor
   */

  constructor() {
    super();

    this._raw = DUMMY;
  }

  /**
   * Test whether the block is a memblock.
   * @returns {Boolean}
   */

  isMemory() {
    return true;
  }

  /**
   * Serialize the block headers.
   * @returns {Buffer}
   */

  toPrehead() {
    return this._raw.slice(0, consensus.HEADER_SIZE);
  }

  /**
   * Serialize the block headers.
   * @returns {Buffer}
   */

  toHead() {
    const size = consensus.HEADER_SIZE;
    return this._raw.slice(0, size + 1 + this._raw[size] * 4);
  }

  /**
   * Get the full block size.
   * @returns {Number}
   */

  getSize() {
    return this._raw.length;
  }

  /**
   * Verify the block.
   * @returns {Boolean}
   */

  verifyBody() {
    return true;
  }

  /**
   * Retrieve the coinbase height
   * from the coinbase input script.
   * @returns {Number} height (-1 if not present).
   */

  getCoinbaseHeight() {
    try {
      return this.parseCoinbaseHeight();
    } catch (e) {
      return -1;
    }
  }

  /**
   * Parse the coinbase height
   * from the coinbase input script.
   * @private
   * @returns {Number} height (-1 if not present).
   */

  parseCoinbaseHeight() {
    const br = bio.read(this._raw, true);

    br.seek(consensus.HEADER_SIZE);

    const proofSize = br.readU8();
    br.seek(proofSize * 4);

    const txCount = br.readVarint();

    if (txCount === 0)
      return -1;

    br.seek(4);

    const inCount = br.readVarint();

    for (let i = 0; i < inCount; i++)
      Input.fromReader(br);

    const outCount = br.readVarint();

    for (let i = 0; i < outCount; i++)
      Output.fromReader(br);

    return br.readU32();
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    const br = bio.read(data, true);

    this.readHead(br);

    this._raw = br.data;

    return this;
  }

  /**
   * Insantiate a memblock from serialized data.
   * @param {Buffer} data
   * @returns {MemBlock}
   */

  static fromRaw(data) {
    return new this().fromRaw(data);
  }

  /**
   * Return serialized block data.
   * @returns {Buffer}
   */

  toRaw() {
    return this._raw;
  }

  /**
   * Return serialized block data.
   * @returns {Buffer}
   */

  toNormal() {
    return this._raw;
  }

  /**
   * Parse the serialized block data
   * and create an actual {@link Block}.
   * @returns {Block}
   * @throws Parse error
   */

  toBlock() {
    const block = Block.fromRaw(this._raw);

    block._hash = this._hash;
    block._hhash = this._hhash;

    return block;
  }

  /**
   * Convert the block to a headers object.
   * @returns {Headers}
   */

  toHeaders() {
    return Headers.fromBlock(this);
  }

  /**
   * Test whether an object is a MemBlock.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isMemBlock(obj) {
    return obj instanceof MemBlock;
  }
}

/*
 * Expose
 */

module.exports = MemBlock;
