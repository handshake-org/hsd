/*!
 * records.js - chaindb records
 * Copyright (c) 2024 The Handshake Developers (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {BufferMap} = require('buffer-map');
const consensus = require('../protocol/consensus');
const Network = require('../protocol/network');

/**
 * ChainFlags
 */

class ChainFlags extends bio.Struct {
  /**
   * Create chain flags.
   * @alias module:blockchain.ChainFlags
   * @constructor
   */

  constructor(options) {
    super();

    this.network = Network.primary;
    this.spv = false;
    this.prune = false;
    this.indexTX = false;
    this.indexAddress = false;

    if (options)
      this.fromOptions(options);
  }

  fromOptions(options) {
    this.network = Network.get(options.network);

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }

    if (options.indexTX != null) {
      assert(typeof options.indexTX === 'boolean');
      this.indexTX = options.indexTX;
    }

    if (options.indexAddress != null) {
      assert(typeof options.indexAddress === 'boolean');
      this.indexAddress = options.indexAddress;
    }

    return this;
  }

  getSize() {
    return 12;
  }

  write(bw) {
    let flags = 0;

    if (this.spv)
      flags |= 1 << 0;

    if (this.prune)
      flags |= 1 << 1;

    if (this.indexTX)
      flags |= 1 << 2;

    if (this.indexAddress)
      flags |= 1 << 3;

    bw.writeU32(this.network.magic);
    bw.writeU32(flags);
    bw.writeU32(0);

    return bw;
  }

  read(br) {
    this.network = Network.fromMagic(br.readU32());

    const flags = br.readU32();

    this.spv = (flags & 1) !== 0;
    this.prune = (flags & 2) !== 0;
    this.indexTX = (flags & 4) !== 0;
    this.indexAddress = (flags & 8) !== 0;

    return this;
  }
}

/**
 * Chain State
 */

class ChainState extends bio.Struct {
  /**
   * Create chain state.
   * @alias module:blockchain.ChainState
   * @constructor
   */

  constructor() {
    super();
    this.tip = consensus.ZERO_HASH;
    this.tx = 0;
    this.coin = 0;
    this.value = 0;
    this.burned = 0;
    this.committed = false;
  }

  inject(state) {
    this.tip = state.tip;
    this.tx = state.tx;
    this.coin = state.coin;
    this.value = state.value;
    this.burned = state.burned;
    return this;
  }

  connect(block) {
    this.tx += block.txs.length;
  }

  disconnect(block) {
    this.tx -= block.txs.length;
  }

  add(coin) {
    this.coin += 1;
    this.value += coin.value;
  }

  spend(coin) {
    this.coin -= 1;
    this.value -= coin.value;
  }

  burn(coin) {
    this.coin += 1;
    this.burned += coin.value;
  }

  unburn(coin) {
    this.coin -= 1;
    this.burned -= coin.value;
  }

  commit(hash) {
    assert(Buffer.isBuffer(hash));
    this.tip = hash;
    this.committed = true;
    return this.encode();
  }

  getSize() {
    return 64;
  }

  write(bw) {
    bw.writeHash(this.tip);
    bw.writeU64(this.tx);
    bw.writeU64(this.coin);
    bw.writeU64(this.value);
    bw.writeU64(this.burned);
    return bw;
  }

  read(br) {
    this.tip = br.readHash();
    this.tx = br.readU64();
    this.coin = br.readU64();
    this.value = br.readU64();
    this.burned = br.readU64();
    return this;
  }
}

/**
 * State Cache
 */

class StateCache {
  /**
   * Create state cache.
   * @alias module:blockchain.StateCache
   * @constructor
   */

  constructor(network) {
    this.network = network;
    this.bits = [];
    this.updates = [];
    this.init();
  }

  init() {
    for (let i = 0; i < 32; i++)
      this.bits.push(null);

    for (const {bit} of this.network.deploys) {
      assert(!this.bits[bit]);
      this.bits[bit] = new BufferMap();
    }
  }

  set(bit, entry, state) {
    const cache = this.bits[bit];

    assert(cache);

    if (cache.get(entry.hash) !== state) {
      cache.set(entry.hash, state);
      this.updates.push(new CacheUpdate(bit, entry.hash, state));
    }
  }

  get(bit, entry) {
    const cache = this.bits[bit];

    assert(cache);

    const state = cache.get(entry.hash);

    if (state == null)
      return -1;

    return state;
  }

  commit() {
    this.updates.length = 0;
  }

  drop() {
    for (const {bit, hash} of this.updates) {
      const cache = this.bits[bit];
      assert(cache);
      cache.delete(hash);
    }

    this.updates.length = 0;
  }

  insert(bit, hash, state) {
    const cache = this.bits[bit];
    assert(cache);
    cache.set(hash, state);
  }
}

/**
 * Cache Update
 */

class CacheUpdate {
  /**
   * Create cache update.
   * @constructor
   * @ignore
   */

  constructor(bit, hash, state) {
    this.bit = bit;
    this.hash = hash;
    this.state = state;
  }

  encode() {
    const data = Buffer.allocUnsafe(1);
    data[0] = this.state;
    return data;
  }
}

/**
 * Tree related state.
 */

class TreeState extends bio.Struct {
  /**
   * Create tree state.
   * @constructor
   * @ignore
   */

  constructor() {
    super();
    this.treeRoot = consensus.ZERO_HASH;
    this.commitHeight = 0;
    this.compactionRoot = consensus.ZERO_HASH;
    this.compactionHeight = 0;

    this.committed = false;
  }

  inject(state) {
    this.treeRoot = state.treeRoot;
    this.commitHeight = state.treeHeight;
    this.compactionHeight = state.compactionHeight;
    this.compactionRoot = state.compactionRoot;

    return this;
  }

  compact(hash, height) {
    assert(Buffer.isBuffer(hash));
    assert((height >>> 0) === height);

    this.compactionRoot = hash;
    this.compactionHeight = height;
  };

  commit(hash, height) {
    assert(Buffer.isBuffer(hash));
    assert((height >>> 0) === height);

    this.treeRoot = hash;
    this.commitHeight = height;
    this.committed = true;
    return this.encode();
  }

  getSize() {
    return 72;
  }

  write(bw) {
    bw.writeHash(this.treeRoot);
    bw.writeU32(this.commitHeight);
    bw.writeHash(this.compactionRoot);
    bw.writeU32(this.compactionHeight);

    return bw;
  }

  read(br) {
    this.treeRoot = br.readHash();
    this.commitHeight = br.readU32();
    this.compactionRoot = br.readHash();
    this.compactionHeight = br.readU32();

    return this;
  }
}

/*
 * Expose
 */

exports.ChainFlags = ChainFlags;
exports.ChainState = ChainState;
exports.StateCache = StateCache;
exports.TreeState = TreeState;
exports.CacheUpdate = CacheUpdate;
