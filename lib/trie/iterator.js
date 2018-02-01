/*!
 * iterator.js - patricia merkle trie iterators
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
const bio = require('bufio');
const nodes = require('./nodes');
const common = require('./common');

/*
 * Constants
 */

const {
  EMPTY_ROOT,
  hasTerm,
  decodeCompact
} = common;

const {NIL} = nodes;

const {
  HASHNODE,
  SHORTNODE,
  FULLNODE
} = nodes.types;

/**
 * Node Iterator State
 */

class NodeIteratorState {
  /**
   * Create a state.
   * @constructor
   * @private
   */

  constructor() {
    this.hash = null;
    this.node = NIL;
    this.parent = null;
    this.child = -1;
  }

  inspect() {
    return {
      type: 'NodeIteratorState',
      hash: this.hash ? this.hash.toString('hex') : null,
      node: this.node,
      parent: this.parent ? this.parent.toString('hex') : null,
      child: this.child
    };
  }
}

/**
 * Node Iterator
 */

class NodeIterator {
  /**
   * Create a node iterator.
   * @constructor
   * @private
   */

  constructor(trie) {
    assert(trie, 'NodeIterator requires a trie.');

    this.trie = trie;
    this.stack = [];
    this.hash = null;
    this.node = NIL;
    this.parent = null;
    this.leaf = false;
    this.data = null;
    this.error = null;
  }

  async next() {
    if (this.error != null)
      return false;

    try {
      await this.step();
    } catch (e) {
      this.error = e;
      return false;
    }

    return this.retrieve();
  }

  async step() {
    if (!this.trie)
      return;

    if (this.stack.length === 0) {
      const root = this.trie.hash();
      const state = new NodeIteratorState();

      state.node = this.trie.root;
      state.child = -1;

      if (!root.equals(EMPTY_ROOT))
        state.hash = root;

      this.stack.push(state);
    } else {
      this.stack.pop();

      if (this.stack.length === 0) {
        this.trie = null;
        return;
      }
    }

outer:
    for (;;) {
      const parent = this.stack[this.stack.length - 1];
      const ancestor = parent.hash || parent.parent;
      const node = parent.node;

      switch (node.type) {
        case FULLNODE: {
          if (parent.child >= 17)
            break outer;

          parent.child += 1;

          for (; parent.child < 17; parent.child++) {
            const cur = node.children[parent.child];
            if (!cur.isNull()) {
              const state = new NodeIteratorState();
              state.hash = node.hash();
              state.node = cur;
              state.parent = ancestor;
              state.child = -1;
              this.stack.push(state);
              break;
            }
          }

          break;
        }
        case SHORTNODE: {
          if (parent.child >= 0)
            break outer;

          parent.child += 1;

          const state = new NodeIteratorState();
          state.hash = node.hash();
          state.node = node.value;
          state.parent = ancestor;
          state.child = -1;

          this.stack.push(state);

          break;
        }
        case HASHNODE: {
          if (parent.child >= 0)
            break outer;

          parent.child += 1;

          const rn = await this.trie.resolveHash(node);

          const state = new NodeIteratorState();
          state.hash = node.data;
          state.node = rn;
          state.parent = ancestor;
          state.child = -1;

          this.stack.push(state);

          break;
        }
        default: {
          break outer;
        }
      }
    }
  }

  retrieve() {
    this.hash = null;
    this.node = NIL;
    this.parent = null;
    this.leaf = false;
    this.data = null;

    if (!this.trie)
      return false;

    const state = this.stack[this.stack.length - 1];

    this.hash = state.hash;
    this.node = state.node;
    this.parent = state.parent;

    if (this.node.isValue()) {
      this.leaf = true;
      this.data = this.node.data;
    }

    return true;
  }

  inspect() {
    return {
      type: 'NodeIterator',
      stack: this.stack,
      hash: this.hash ? this.hash.toString('hex') : null,
      node: this.node,
      parent: this.parent ? this.parent.toString('hex') : null,
      leaf: this.leaf,
      data: this.data ? this.data.toString('hex') : null,
      error: this.error ? this.error.message : null
    };
  }
}

/**
 * Iterator
 */

class Iterator {
  /**
   * Create an iterator.
   * @constructor
   * @param {Trie} trie
   * @param {Function?} getKey
   */

  constructor(trie, getKey) {
    assert(trie, 'Iterator requires a trie.');

    this.trie = trie;
    this.getKey = getKey || null;
    this.nit = new NodeIterator(trie);
    this.key = null;
    this.value = null;
  }

  async next() {
    for (;;) {
      if (!await this.nit.next())
        break;

      if (this.nit.leaf) {
        this.key = this.makeKey();
        this.value = this.nit.data;

        if (this.getKey) {
          try {
            const key = await this.getKey(this.key);
            if (!key)
              throw new Error('Could not convert key.');
            this.key = key;
          } catch (e) {
            this.nit.error = e;
            break;
          }
        }

        return true;
      }
    }

    this.key = null;
    this.value = null;

    if (this.nit.error)
      throw this.nit.error;

    return false;
  }

  makeSize() {
    let size = 0;

    for (const state of this.nit.stack) {
      const node = state.node;
      switch (node.type) {
        case FULLNODE: {
          if (state.child <= 16)
            size += 1;
          break;
        }
        case SHORTNODE: {
          if (hasTerm(node.key))
            size += node.key.length - 1;
          else
            size += node.key.length;
          break;
        }
      }
    }

    return size;
  }

  makeKey() {
    const bw = bio.write(this.makeSize());

    for (const state of this.nit.stack) {
      const node = state.node;
      switch (node.type) {
        case FULLNODE: {
          if (state.child <= 16)
            bw.writeU8(state.child);
          break;
        }
        case SHORTNODE: {
          if (hasTerm(node.key))
            bw.copy(node.key, 0, node.key.length - 1);
          else
            bw.writeBytes(node.key);
          break;
        }
      }
    }

    return decodeCompact(bw.render());
  }

  inspect() {
    return {
      type: 'Iterator',
      nit: this.nit,
      key: this.key ? this.key.toString('hex') : null,
      value: this.value ? this.value.toString('hex') : null
    };
  }
}

/*
 * Expose
 */

exports.NodeIteratorState = NodeIteratorState;
exports.NodeIterator = NodeIterator;
exports.Iterator = Iterator;
