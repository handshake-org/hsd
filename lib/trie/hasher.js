/*!
 * hasher.js - patricia merkle trie hasher
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 *
 * Patricia Merkle Tries:
 *   https://github.com/ethereum/wiki/wiki/Patricia-Tree
 *
 * Parts of this software are based on go-ethereum:
 *   Copyright (C) 2014 The go-ethereum Authors.
 *   https://github.com/ethereum/go-ethereum/tree/master/trie
 */

'use strict';

const assert = require('assert');
const blake2b = require('bcrypto/lib/blake2b');
const nodes = require('./nodes');
const {HashNode} = nodes;
const {SHORTNODE, FULLNODE} = nodes.types;

/**
 * Hasher
 */

class Hasher {
  /**
   * Create a hasher.
   * @constructor
   * @param {Number} [cacheGen=0]
   * @param {Number} [cacheLimit=0]
   */

  constructor(cacheGen = 0, cacheLimit = 0) {
    assert((cacheGen >>> 0) === cacheGen);
    assert((cacheLimit >>> 0) === cacheLimit);

    this.cacheGen = cacheGen;
    this.cacheLimit = cacheLimit;
  }

  hash(n, batch, force) {
    const [h, dirty] = n.cache();

    if (h) {
      if (!batch)
        return [h, n];

      if (n.canUnload(this.cacheGen, this.cacheLimit))
        return [h, h];

      if (!dirty)
        return [h, n];
    }

    const [collapsed, cached] = this.hashChildren(n, batch);
    const hashed = this.store(collapsed, batch, force);

    if (hashed.isHash() && !force) {
      switch (cached.type) {
        case SHORTNODE:
        case FULLNODE: {
          const c = cached.clone();
          c.flags.hash = hashed;
          if (batch)
            c.flags.dirty = false;
          return [hashed, c];
        }
      }
    }

    return [hashed, cached];
  }

  hashChildren(n, batch) {
    switch (n.type) {
      case SHORTNODE: {
        const collapsed = n.clone();
        const cached = n.clone();

        if (!n.value.isValue()) {
          const [h, c] = this.hash(n.value, batch, false);
          collapsed.value = h;
          cached.value = c;
        }

        return [collapsed, cached];
      }
      case FULLNODE: {
        const collapsed = n.clone();
        const cached = n.clone();

        for (let i = 0; i < 16; i++) {
          if (!n.children[i].isNull()) {
            const [h, c] = this.hash(n.children[i], batch, false);
            collapsed.children[i] = h;
            cached.children[i] = c;
          }
        }

        return [collapsed, cached];
      }
      default: {
        return [n, n];
      }
    }
  }

  store(n, batch, force) {
    if (n.isNull() || n.isHash())
      return n;

    const raw = n.encode();

    if (raw.length < 32 && !force)
      return n;

    let [hash] = n.cache();
    if (!hash)
      hash = new HashNode(blake2b.digest(raw));

    if (batch)
      batch.put(hash.data, raw);

    return hash;
  }
}

/*
 * Expose
 */

module.exports = Hasher;
