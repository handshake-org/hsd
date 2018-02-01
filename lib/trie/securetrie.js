/*!
 * securetrie.js - secure patricia merkle trie
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
const {Iterator} = require('./iterator');
const Trie = require('./trie');

/*
 * Constants
 */

const SEC_PREFIX = Buffer.from('secure-key-', 'ascii');
const SEC_LENGTH = 11 + 32;

/**
 * Secure Trie
 */

class SecureTrie {
  /**
   * Create a secure trie.
   * @constructor
   * @param {Object} db
   * @param {Number} [limit=4]
   */

  constructor(db, limit) {
    assert(db, 'SecureTrie requires a database.');

    this.trie = new Trie(db, limit);
    this.keyCache = new Map();
  }

  open(root) {
    return this.trie.open(root);
  }

  close() {
    this.keyCache.clear();
    return this.trie.close();
  }

  async get(key) {
    const sk = this.hashKey(key);
    return this.trie.get(sk);
  }

  async insert(key, value) {
    const sk = this.hashKey(key);
    const hk = sk.toString('hex');

    const res = await this.trie.insert(sk, value);

    this.keyCache.set(hk, [sk, key]);

    return res;
  }

  async remove(key) {
    const sk = this.hashKey(key);
    const hk = sk.toString('hex');

    this.keyCache.delete(hk);

    return this.trie.remove(sk);
  }

  iterator(resolve) {
    if (!resolve)
      return this.trie.iterator();

    return new Iterator(this.trie, sk => this.getKey(sk));
  }

  hash(enc) {
    return this.trie.hash(enc);
  }

  commit(batch, enc) {
    assert(batch);

    if (this.keyCache.size > 0) {
      for (const [sk, key] of this.keyCache.values())
        batch.put(this.secKey(sk), key);

      this.keyCache.clear();
    }

    return this.trie.commit(batch, enc);
  }

  snapshot(root) {
    const {db, cacheLimit} = this.trie;
    const st = new this.constructor(db, cacheLimit);
    st.trie = this.trie.snapshot(root);
    return st;
  }

  async prove(key) {
    const sk = this.hashKey(key);
    return this.trie.prove(sk);
  }

  verify(root, key, proof) {
    const sk = this.hashKey(key);
    return this.trie.verify(root, sk, proof);
  }

  async getKey(sk) {
    assert(Buffer.isBuffer(sk));

    const hk = sk.toString('hex');
    const item = this.keyCache.get(hk);

    if (item) {
      const [, key] = item;
      return key;
    }

    return this.trie.db.get(this.secKey(sk));
  }

  secKey(key) {
    assert(Buffer.isBuffer(key));
    assert(key.length === 32, 'Bad key size.');
    const buf = Buffer.allocUnsafe(SEC_LENGTH);
    SEC_PREFIX.copy(buf, 0);
    key.copy(buf, 11);
    return buf;
  }

  hashKey(key) {
    return blake2b.digest(key);
  }
}

/*
 * Expose
 */

module.exports = SecureTrie;
