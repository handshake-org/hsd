/*!
 * proof.js - patricia merkle trie proofs
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
const blake2b = require('bcrypto/lib/blake2b');
const nodes = require('./nodes');
const common = require('./common');
const Hasher = require('./hasher');
const {encoding} = bio;

const {
  EMPTY,
  ZERO_HASH,
  toNibbles,
  startsWith
} = common;

const {
  NIL,
  decodeNode
} = nodes;

const {
  NULLNODE,
  HASHNODE,
  SHORTNODE,
  FULLNODE,
  VALUENODE
} = nodes.types;

/*
 * Constants
 */

const PROOF_OK = 0;
const PROOF_HASH_MISMATCH = 1;
const PROOF_MALFORMED_NODE = 2;
const PROOF_UNEXPECTED_NODE = 3;
const PROOF_EARLY_END = 4;
const PROOF_NO_RESULT = 5;
const PROOF_UNKNOWN_ERROR = 6;

/**
 * Verification error codes.
 * @enum {Number}
 */

exports.codes = {
  PROOF_OK,
  PROOF_HASH_MISMATCH,
  PROOF_MALFORMED_NODE,
  PROOF_UNEXPECTED_NODE,
  PROOF_EARLY_END,
  PROOF_NO_RESULT,
  PROOF_UNKNOWN_ERROR
};

/**
 * Verification error codes (strings).
 * @const {String[]}
 * @default
 */

exports.codesByVal = [
  'PROOF_OK',
  'PROOF_HASH_MISMATCH',
  'PROOF_MALFORMED_NODE',
  'PROOF_UNEXPECTED_NODE',
  'PROOF_EARLY_END',
  'PROOF_NO_RESULT',
  'PROOF_UNKNOWN_ERROR'
];

/**
 * Get verification error code as a string.
 * @param {Number} value
 * @returns {String}
 */

exports.code = function code(value) {
  assert((value & 0xff) === value);

  if (value >= exports.codesByVal.length)
    value = PROOF_UNKNOWN_ERROR;

  return exports.codesByVal[value];
};

/**
 * Create a merkle trie proof.
 * @param {Trie} trie
 * @param {Buffer} key
 * @returns {Buffer[]} proof
 */

exports.prove = async function prove(trie, key) {
  const nodes = [];
  const k = toNibbles(key);

  let n = trie.root;
  let p = 0;

  while (k.length - p > 0 && !n.isNull()) {
    switch (n.type) {
      case SHORTNODE: {
        nodes.push(n);
        if (!startsWith(k, n.key, p)) {
          // Trie doesn't contain the key.
          n = NIL;
        } else {
          p += n.key.length;
          n = n.value;
        }
        break;
      }
      case FULLNODE: {
        nodes.push(n);
        n = n.children[k[p]];
        p += 1;
        break;
      }
      case HASHNODE: {
        n = await trie.resolveHash(n, k, p);
        break;
      }
      default: {
        assert(false, 'Invalid node type.');
        break;
      }
    }
  }

  const hasher = new Hasher(0, 0);
  const proof = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const [nn] = hasher.hashChildren(n, null);
    const hn = hasher.store(nn, null, false);

    if (hn.isHash() || i === 0)
      proof.push(nn.encode());
  }

  return proof;
};

/**
 * Verify a merkle trie proof.
 * @param {Buffer} root
 * @param {Buffer} key
 * @param {Buffer[]} proof
 * @returns {Array} [code, data]
 */

exports.verify = function verify(root, key, proof) {
  assert(Buffer.isBuffer(root));
  assert(Array.isArray(proof));

  const k = toNibbles(key);

  let h = root;
  let p = 0;

  for (let i = 0; i < proof.length; i++) {
    const raw = proof[i];

    if (!blake2b.digest(raw).equals(h))
      return [PROOF_HASH_MISMATCH, null];

    let n;
    try {
      n = decodeNode(raw);
    } catch (e) {
      return [PROOF_MALFORMED_NODE, null];
    }

    let child, pos;
    try {
      [child, pos] = nextChild(n, k, p);
    } catch (e) {
      return [PROOF_UNEXPECTED_NODE, null];
    }

    switch (child.type) {
      case HASHNODE: {
        p = pos;
        h = child.data;
        break;
      }
      case NULLNODE: {
        if (i !== proof.length - 1)
          return [PROOF_EARLY_END, null];
        return [PROOF_OK, null];
      }
      case VALUENODE: {
        if (i !== proof.length - 1)
          return [PROOF_EARLY_END, null];
        return [PROOF_OK, child.data];
      }
    }
  }

  return [PROOF_NO_RESULT, null];
};

/**
 * Trie Proof
 */

class TrieProof {
  /**
   * Create a proof.
   * @constructor
   * @param {Buffer|null} root
   * @param {Buffer|null} key
   * @param {(Buffer[])|null} root
   */

  constructor(root, key, nodes) {
    if (typeof root === 'string') {
      root = Buffer.from(root, 'hex');
      assert(root.length === 32);
    }

    this.root = root || ZERO_HASH;
    this.key = key || EMPTY;
    this.nodes = nodes || [];
    this.height = 0;
    this.data = EMPTY;
  }

  verify() {
    return exports.verify(this.root, this.key, this.nodes);
  }

  getSize() {
    let size = 0;

    size += 32;
    size += 1 + this.key.length;

    size += encoding.sizeVarint(this.nodes.length);

    for (const data of this.nodes)
      size += encoding.sizeVarint(data.length);

    size += 4;
    size += 2 + this.data.length;

    return size;
  }

  toRaw() {
    return this.toWriter(bio.write(this.getSize())).render();
  }

  toWriter(bw) {
    bw.writeHash(this.root);
    bw.writeU8(this.key.length);
    bw.writeBytes(this.key);
    bw.writeVarint(this.nodes.length);

    for (const data of this.nodes)
      bw.writeVarBytes(data);

    bw.writeU32(this.height);
    bw.writeU16(this.data.length);
    bw.writeBytes(this.data);

    return bw;
  }

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  fromReader(br) {
    this.root = br.readHash();
    this.key = br.readBytes(br.readU8());

    const count = br.readVarint();

    for (let i = 0; i < count; i++)
      this.nodes.push(br.readVarBytes());

    this.height = br.readU32();
    this.data = br.readBytes(br.readU16());

    return this;
  }

  static fromRaw(data) {
    return new this().fromRaw(data);
  }

  static fromReader(br) {
    return new this().fromReader(br);
  }

  toJSON() {
    return {
      root: this.root.toString('hex'),
      key: this.key.toString('hex'),
      nodes: this.nodes.map(n => n.toString('hex')),
      height: this.height,
      data: this.data.toString('hex')
    };
  }

  inspect() {
    return this.toJSON();
  }
}

/*
 * Helpers
 */

function nextChild(n, k, p) {
  while (k.length - p > 0) {
    switch (n.type) {
      case SHORTNODE: {
        if (!startsWith(k, n.key, p))
          return [NIL, -1];

        p += n.key.length;
        n = n.value;
        break;
      }
      case FULLNODE: {
        n = n.children[k[p]];
        p += 1;
        break;
      }
      case HASHNODE: {
        return [n, p];
      }
      case NULLNODE: {
        return [NIL, -1];
      }
      case VALUENODE: {
        throw new Error('Unexpected node.');
      }
      default: {
        assert(false, 'Invalid node type.');
        break;
      }
    }
  }

  if (!n.isValue())
    return [NIL, -1];

  return [n, -1];
}

/*
 * Expose
 */

exports.TrieProof = TrieProof;
