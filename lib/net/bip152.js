/*!
 * bip152.js - compact block object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module net/bip152
 */

const assert = require('bsert');
const bio = require('bufio');
const consensus = require('../protocol/consensus');
const blake2b = require('bcrypto/lib/blake2b');
const {siphash} = require('bcrypto/lib/siphash');
const AbstractBlock = require('../primitives/abstractblock');
const TX = require('../primitives/tx');
const Headers = require('../primitives/headers');
const Block = require('../primitives/block');
const common = require('./common');
const {encoding} = bio;

const {
  MAX_BLOCK_SIZE,
  HEADER_SIZE
} = consensus;

/**
 * Compact Block
 * Represents a compact block (bip152): `cmpctblock` packet.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0152.mediawiki
 * @extends AbstractBlock
 * @property {Buffer|null} keyNonce - Nonce for siphash key.
 * @property {Number[]} ids - Short IDs.
 * @property {Object[]} ptx - Prefilled transactions.
 * @property {TX[]} available - Available transaction vector.
 * @property {Object} idMap - Map of short ids to indexes.
 * @property {Number} count - Transactions resolved.
 * @property {Buffer|null} sipKey - Siphash key.
 */

class CompactBlock extends AbstractBlock {
  /**
   * Create a compact block.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.keyNonce = null;
    this.ids = [];
    this.ptx = [];

    this.available = [];
    this.idMap = new Map();
    this.count = 0;
    this.sipKey = null;
    this.totalTX = 0;
    this.now = 0;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    this.parseOptions(options);

    assert(Buffer.isBuffer(options.keyNonce));
    assert(Array.isArray(options.ids));
    assert(Array.isArray(options.ptx));

    this.keyNonce = options.keyNonce;
    this.ids = options.ids;
    this.ptx = options.ptx;

    if (options.available)
      this.available = options.available;

    if (options.idMap)
      this.idMap = options.idMap;

    if (options.count)
      this.count = options.count;

    if (options.totalTX != null)
      this.totalTX = options.totalTX;

    this.sipKey = this.getKey();

    return this;
  }

  /**
   * Verify the block.
   * @returns {Boolean}
   */

  verifyBody() {
    return true;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.readHead(br);

    this.keyNonce = br.readBytes(8);
    this.sipKey = this.getKey();

    const idCount = br.readVarint();

    this.totalTX += idCount;

    for (let i = 0; i < idCount; i++) {
      const lo = br.readU32();
      const hi = br.readU16();
      this.ids.push(hi * 0x100000000 + lo);
    }

    const txCount = br.readVarint();

    this.totalTX += txCount;

    for (let i = 0; i < txCount; i++) {
      const index = br.readVarint();

      assert(index <= 0xffff);
      assert(index < this.totalTX);

      const tx = TX.read(br);

      this.ptx.push([index, tx]);
    }

    return this;
  }

  /**
   * Calculate block serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += this.sizeHead();
    size += 8;
    size += encoding.sizeVarint(this.ids.length);
    size += this.ids.length * 6;
    size += encoding.sizeVarint(this.ptx.length);

    for (const [index, tx] of this.ptx) {
      size += encoding.sizeVarint(index);
      size += tx.getSize();
    }

    return size;
  }

  /**
   * Serialize block to buffer writer.
   * @private
   * @param {BufferWriter} bw
   */

  write(bw) {
    this.writeHead(bw);

    bw.writeBytes(this.keyNonce);

    bw.writeVarint(this.ids.length);

    for (const id of this.ids) {
      const lo = id % 0x100000000;
      const hi = (id - lo) / 0x100000000;
      assert(hi <= 0xffff);
      bw.writeU32(lo);
      bw.writeU16(hi);
    }

    bw.writeVarint(this.ptx.length);

    for (const [index, tx] of this.ptx) {
      bw.writeVarint(index);
      tx.write(bw);
    }

    return bw;
  }

  /**
   * Convert block to a TXRequest
   * containing missing indexes.
   * @returns {TXRequest}
   */

  toRequest() {
    return TXRequest.fromCompact(this);
  }

  /**
   * Attempt to fill missing transactions from mempool.
   * @param {Mempool} mempool
   * @returns {Boolean}
   */

  fillMempool(mempool) {
    if (this.count === this.totalTX)
      return true;

    const set = new Set();

    for (const {tx} of mempool.map.values()) {
      const hash = tx.witnessHash();
      const id = this.sid(hash);
      const index = this.idMap.get(id);

      if (index == null)
        continue;

      if (set.has(index)) {
        // Siphash collision, just request it.
        this.available[index] = null;
        this.count -= 1;
        continue;
      }

      this.available[index] = tx;
      set.add(index);
      this.count += 1;

      // We actually may have a siphash collision
      // here, but exit early anyway for perf.
      if (this.count === this.totalTX)
        return true;
    }

    return false;
  }

  /**
   * Attempt to fill missing transactions from TXResponse.
   * @param {TXResponse} res
   * @returns {Boolean}
   */

  fillMissing(res) {
    let offset = 0;

    for (let i = 0; i < this.available.length; i++) {
      if (this.available[i])
        continue;

      if (offset >= res.txs.length)
        return false;

      this.available[i] = res.txs[offset++];
    }

    return offset === res.txs.length;
  }

  /**
   * Calculate a transaction short ID.
   * @param {Hash} hash
   * @returns {Number}
   */

  sid(hash) {
    const [hi, lo] = siphash(hash, this.sipKey);
    return (hi & 0xffff) * 0x100000000 + (lo >>> 0);
  }

  /**
   * Test whether an index is available.
   * @param {Number} index
   * @returns {Boolean}
   */

  hasIndex(index) {
    return this.available[index] != null;
  }

  /**
   * Initialize the siphash key.
   * @private
   * @returns {Buffer}
   */

  getKey() {
    const hash = blake2b.multi(this.toHead(), this.keyNonce);
    return hash.slice(0, 16);
  }

  /**
   * Initialize compact block and short id map.
   * @private
   */

  init() {
    if (this.totalTX === 0)
      throw new Error('Empty vectors.');

    if (this.totalTX > MAX_BLOCK_SIZE / 10)
      throw new Error('Compact block too big.');

    // Custom limit to avoid a hashdos.
    // Min valid tx size: (4 + 1 + 40 + 1 + 10 + 4) = 60
    // Min block header size: 334
    // Max number of transactions: (1000000 - 334) / 60 = 16661
    if (this.totalTX > (MAX_BLOCK_SIZE - (HEADER_SIZE + 1)) / 60)
      throw new Error('Compact block too big.');

    // No sparse arrays here, v8.
    for (let i = 0; i < this.totalTX; i++)
      this.available.push(null);

    let last = -1;
    let offset = 0;

    for (let i = 0; i < this.ptx.length; i++) {
      const [index, tx] = this.ptx[i];
      last += index + 1;
      assert(last <= 0xffff);
      assert(last <= this.ids.length + i);
      this.available[last] = tx;
      this.count += 1;
    }

    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i];

      while (this.available[i + offset])
        offset += 1;

      // Fails on siphash collision.
      if (this.idMap.has(id))
        return false;

      this.idMap.set(id, i + offset);
    }

    return true;
  }

  /**
   * Convert completely filled compact
   * block to a regular block.
   * @returns {Block}
   */

  toBlock() {
    const block = new Block();

    block.version = this.version;
    block.prevBlock = this.prevBlock;
    block.merkleRoot = this.merkleRoot;
    block.witnessRoot = this.witnessRoot;
    block.treeRoot = this.treeRoot;
    block.reservedRoot = this.reservedRoot;
    block.time = this.time;
    block.bits = this.bits;
    block.nonce = this.nonce;
    block.extraNonce = this.extraNonce;
    block.mask = this.mask;
    block._hash = this._hash;

    for (const tx of this.available) {
      assert(tx, 'Compact block is not full.');
      block.txs.push(tx);
    }

    return block;
  }

  /**
   * Inject properties from block.
   * @private
   * @param {Block} block
   * @param {Buffer?} nonce
   * @returns {CompactBlock}
   */

  fromBlock(block, nonce) {
    this.version = block.version;
    this.prevBlock = block.prevBlock;
    this.merkleRoot = block.merkleRoot;
    this.witnessRoot = block.witnessRoot;
    this.treeRoot = block.treeRoot;
    this.reservedRoot = block.reservedRoot;
    this.time = block.time;
    this.bits = block.bits;
    this.nonce = block.nonce;
    this.extraNonce = block.extraNonce;
    this.mask = block.mask;
    this.totalTX = block.txs.length;
    this._hash = block._hash;

    if (!nonce)
      nonce = common.nonce();

    this.keyNonce = nonce;
    this.sipKey = this.getKey();

    for (let i = 1; i < block.txs.length; i++) {
      const tx = block.txs[i];
      const hash = tx.witnessHash();
      const id = this.sid(hash);

      this.ids.push(id);
    }

    this.ptx.push([0, block.txs[0]]);

    return this;
  }

  /**
   * Instantiate compact block from a block.
   * @param {Block} block
   * @param {Buffer?} nonce
   * @returns {CompactBlock}
   */

  static fromBlock(block, nonce) {
    return new this().fromBlock(block, nonce);
  }

  /**
   * Convert block to headers.
   * @returns {Headers}
   */

  toHeaders() {
    return Headers.fromBlock(this);
  }
}

/**
 * TX Request
 * Represents a BlockTransactionsRequest (bip152): `getblocktxn` packet.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0152.mediawiki
 * @property {Hash} hash
 * @property {Number[]} indexes
 */

class TXRequest extends bio.Struct {
  /**
   * TX Request
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.hash = consensus.ZERO_HASH;
    this.indexes = [];

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {TXRequest}
   */

  fromOptions(options) {
    this.hash = options.hash;

    if (options.indexes)
      this.indexes = options.indexes;

    return this;
  }

  /**
   * Inject properties from compact block.
   * @private
   * @param {CompactBlock} block
   * @returns {TXRequest}
   */

  fromCompact(block) {
    this.hash = block.hash();

    for (let i = 0; i < block.available.length; i++) {
      if (!block.available[i])
        this.indexes.push(i);
    }

    return this;
  }

  /**
   * Instantiate request from compact block.
   * @param {CompactBlock} block
   * @returns {TXRequest}
   */

  static fromCompact(block) {
    return new this().fromCompact(block);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   * @returns {TXRequest}
   */

  read(br) {
    this.hash = br.readHash();

    const count = br.readVarint();

    for (let i = 0; i < count; i++) {
      const index = br.readVarint();
      assert(index <= 0xffff);
      this.indexes.push(index);
    }

    let offset = 0;

    for (let i = 0; i < count; i++) {
      let index = this.indexes[i];
      index += offset;
      assert(index <= 0xffff);
      this.indexes[i] = index;
      offset = index + 1;
    }

    return this;
  }

  /**
   * Calculate request serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += 32;
    size += encoding.sizeVarint(this.indexes.length);

    for (let i = 0; i < this.indexes.length; i++) {
      let index = this.indexes[i];

      if (i > 0)
        index -= this.indexes[i - 1] + 1;

      size += encoding.sizeVarint(index);
    }

    return size;
  }

  /**
   * Write serialized request to buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeHash(this.hash);

    bw.writeVarint(this.indexes.length);

    for (let i = 0; i < this.indexes.length; i++) {
      let index = this.indexes[i];

      if (i > 0)
        index -= this.indexes[i - 1] + 1;

      bw.writeVarint(index);
    }

    return bw;
  }
}

/**
 * TX Response
 * Represents BlockTransactions (bip152): `blocktxn` packet.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0152.mediawiki
 * @property {Hash} hash
 * @property {TX[]} txs
 */

class TXResponse extends bio.Struct {
  /**
   * Create a tx response.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.hash = consensus.ZERO_HASH;
    this.txs = [];

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {TXResponse}
   */

  fromOptions(options) {
    this.hash = options.hash;

    if (options.txs)
      this.txs = options.txs;

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   * @returns {TXResponse}
   */

  read(br) {
    this.hash = br.readHash();

    const count = br.readVarint();

    for (let i = 0; i < count; i++)
      this.txs.push(TX.read(br));

    return this;
  }

  /**
   * Inject properties from block.
   * @private
   * @param {Block} block
   * @returns {TXResponse}
   */

  fromBlock(block, req) {
    this.hash = req.hash;

    for (const index of req.indexes) {
      if (index >= block.txs.length)
        break;

      this.txs.push(block.txs[index]);
    }

    return this;
  }

  /**
   * Instantiate response from block.
   * @param {Block} block
   * @returns {TXResponse}
   */

  static fromBlock(block, req) {
    return new this().fromBlock(block, req);
  }

  /**
   * Calculate request serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += 32;
    size += encoding.sizeVarint(this.txs.length);

    for (const tx of this.txs)
      size += tx.getSize();

    return size;
  }

  /**
   * Write serialized response to buffer writer.
   * @private
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeHash(this.hash);

    bw.writeVarint(this.txs.length);

    for (const tx of this.txs)
      tx.write(bw);

    return bw;
  }
}

/*
 * Expose
 */

exports.CompactBlock = CompactBlock;
exports.TXRequest = TXRequest;
exports.TXResponse = TXResponse;
