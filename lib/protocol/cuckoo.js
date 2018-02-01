/*!
 * cuckoo.js - cuckoo cycle implementation
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 *
 * Parts of this software are based on tromp/cuckoo:
 *   https://github.com/tromp/cuckoo/blob/master/src/cuckoo.h
 *   https://github.com/tromp/cuckoo/blob/master/src/simple_miner.cpp
 */

'use strict';

const assert = require('assert');
const blake2b = require('bcrypto/lib/blake2b');
const {siphash32, siphash32k256} = require('bcrypto/lib/siphash');

/*
 * Constants
 */

const MAX = Number.MAX_SAFE_INTEGER;
const EMPTY_PROOF = Buffer.alloc(8, 0x00);
const MAX_PATH = 8192;

const codes = {
  POW_OK: 0,
  POW_PROOF_SIZE: 1,
  POW_TOO_BIG: 2,
  POW_TOO_SMALL: 3,
  POW_NON_MATCHING: 4,
  POW_BRANCH: 5,
  POW_DEAD_END: 6,
  POW_SHORT_CYCLE: 7,
  POW_UNKNOWN: 8
};

const codesByVal = [
  'POW_OK',
  'POW_PROOF_SIZE',
  'POW_TOO_BIG',
  'POW_TOO_SMALL',
  'POW_NON_MATCHING',
  'POW_BRANCH',
  'POW_DEAD_END',
  'POW_SHORT_CYCLE',
  'POW_UNKNOWN'
];

const msgByVal = [
  'OK.',
  'Wrong proof size.',
  'Nonce too big.',
  'Nonces not ascending.',
  'Endpoints don\'t match up.',
  'Branch in cycle.',
  'Cycle dead ends.',
  'Cycle too short.',
  'Unknown error.'
];

/**
 * Cuckoo Cycle
 */

class Cuckoo {
  /**
   * Create a cuckoo context.
   * @constructor
   * @param {Number} bits - Size of graph (EDGEBITS + 1).
   * @param {Number} size - Size of cycle (PROOFSIZE).
   * @param {Number} [ease=50] - Percentage of easiness (easipct).
   * @param {Boolean} [legacy=false] - Whether to use old-style
   * hashing (SIPHASH_COMPAT).
   */

  constructor(bits, size, ease = 50, legacy = false) {
    assert((bits >>> 0) === bits);
    assert((size >>> 0) === size);
    assert((ease >>> 0) === ease);
    assert(typeof legacy === 'boolean');

    assert(bits >= 1 && bits <= 32, 'Graph bits must be 1 to 32.');
    assert(size >= 2 && size <= 254, 'Cycle size must be 2 to 254.');
    assert((size & 1) === 0, 'Cycle size must be even.');
    assert(ease >= 1 && ease <= 100, 'Ease must be 1 to 100.');

    // Maximum number of nodes on the graph (NNODES).
    this.nodes = Math.pow(2, bits);

    // Mask of edges for convenience (EDGEMASK).
    this.mask = (this.nodes / 2) - 1;

    // Size of cycle to find (PROOFSIZE).
    // The odds of a graph containing an
    // L-cycle are 1 in L.
    this.size = size;

    // Maximum nonce size (easiness).
    this.easiness = Math.floor((ease * this.nodes) / 100);

    // Which style of hashing to use (SIPHASH_COMPAT).
    this.siphash32 = legacy ? siphash32 : siphash32k256;
  }

  /**
   * Get cuckoo error code string.
   * @param {Number} value
   * @returns {String}
   */

  static code(value) {
    assert((value & 0xff) === value);

    if (value >= codesByVal.length)
      value = codes.POW_UNKNOWN;

    return codesByVal[value];
  }

  /**
   * Get cuckoo error code message.
   * @param {Number} value
   * @returns {String}
   */

  static msg(value) {
    assert((value & 0xff) === value);

    if (value >= msgByVal.length)
      value = codes.POW_UNKNOWN;

    return msgByVal[value];
  }

  /**
   * Compute a siphash key from a header.
   * @param {Buffer} hdr
   * @returns {Buffer}
   */

  sipkey(hdr) {
    const hash = blake2b.digest(hdr, 32);

    // Legacy hashing only uses the first 128 bits.
    if (this.siphash32 === siphash32)
      return hash.slice(0, 16);

    return hash;
  }

  /**
   * Create a new siphash node.
   * @param {Buffer} key - Siphash key.
   * @param {Number} nonce
   * @param {Number} uorv
   * @returns {Number}
   */

  sipnode(key, nonce, uorv) {
    assert(Buffer.isBuffer(key));
    assert((nonce >>> 0) === nonce);
    assert(uorv === 0 || uorv === 1);

    const num = ((nonce << 1) | uorv) >>> 0;
    const node = this.siphash32(num, key) & this.mask;

    return ((node << 1) | uorv) >>> 0;
  }

  /**
   * Verify a cuckoo cycle solution against a key.
   * @param {Buffer} key
   * @param {Uint32Array} nonces
   * @returns {Number} error code
   */

  verify(key, nonces) {
    assert(Buffer.isBuffer(key));
    assert(ArrayBuffer.isView(nonces));

    if (nonces.length !== this.size)
      return codes.POW_PROOF_SIZE;

    const uvs = new Uint32Array(this.size * 2);

    let xor0 = 0;
    let xor1 = 0;

    for (let n = 0; n < this.size; n++) {
      if (nonces[n] >= this.easiness)
        return codes.POW_TOO_BIG;

      if (n > 0 && nonces[n] <= nonces[n - 1])
        return codes.POW_TOO_SMALL;

      const x = this.sipnode(key, nonces[n], 0);
      const y = this.sipnode(key, nonces[n], 1);

      uvs[2 * n] = x;
      uvs[2 * n + 1] = y;

      xor0 ^= x;
      xor1 ^= y;
    }

    // Matching endpoint implies zero xors.
    if (xor0 | xor1)
      return codes.POW_NON_MATCHING;

    let n = 0;
    let i = 0;

    // Follow cycle.
    do {
      let j = i;
      let k = j;

      for (;;) {
        k = (k + 2) % (2 * this.size);

        if (k === i)
          break;

        // Find other edge point identical to one at `i`.
        if (uvs[k] === uvs[i]) {
          // Already found one before?
          if (j !== i)
            return codes.POW_BRANCH;

          j = k;
        }
      }

      // No matching endpoint.
      if (j === i)
        return codes.POW_DEAD_END;

      // Must cycle back to start
      // or we would have found branch.
      i = j ^ 1;
      n += 1;
    } while (i !== 0);

    if (n !== this.size)
      return codes.POW_SHORT_CYCLE;

    return codes.POW_OK;
  }

  /**
   * Verify a header's cuckoo cycle solution.
   * @param {Buffer} hdr - Raw header (minus the solution).
   * @param {Solution} sol
   * @returns {Number} error code
   */

  verifyHeader(hdr, sol) {
    assert(Buffer.isBuffer(hdr));
    assert(sol instanceof Solution);

    if (sol.size() !== this.size)
      return codes.POW_PROOF_SIZE;

    return this.verify(this.sipkey(hdr), sol.toArray());
  }
}

Cuckoo.codes = codes;
Cuckoo.codesByVal = codesByVal;
Cuckoo.msgByVal = msgByVal;

/**
 * Cuckoo Miner
 * @extends {Cuckoo}
 */

class Miner extends Cuckoo {
  /**
   * Create a cuckoo miner.
   * @constructor
   * @param {Number} bits - Size of graph (EDGEBITS + 1).
   * @param {Number} size - Size of cycle (PROOFSIZE).
   * @param {Number} [ease=50] - Percentage of easiness (easipct).
   * @param {Boolean} [legacy=false] - Whether to use old-style
   * hashing (SIPHASH_COMPAT).
   */

  constructor(bits, size, ease = 50, legacy = false) {
    super(bits, size, ease, legacy);

    this.bits = bits;
    this.ease = ease;
    this.buckets = new Uint32Array(this.nodes + 1);
    this.debug = () => {};
  }

  /**
   * Create a path.
   * @param {Number} u
   * @param {Uint32Array} us
   * @returns {Number}
   */

  path(u, us) {
    let nu = 0;

    while (u > 0) {
      nu += 1;

      if (nu >= MAX_PATH) {
        while (nu > 0 && us[nu - 1] !== u)
          nu -= 1;

        if (nu === 0)
          throw new Error('Maximum path length exceeded.');

        throw new Error(`Illegal ${MAX_PATH - nu}-cycle.`);
      }

      us[nu] = u;

      u = this.buckets[u];
    }

    return nu;
  }

  /**
   * Find solution after detecting a cycle.
   * @param {Buffer} key
   * @param {Uint32Array} us
   * @param {Number} nu
   * @param {Uint32Array} vs
   * @param {Number} nv
   * @returns {Uint32Array} nonces
   */

  solution(key, us, nu, vs, nv) {
    const cycle = new Set();

    cycle.add(edge(us[0], vs[0]));

    // u's in even position; v's in odd
    while (nu--)
      cycle.add(edge(us[(nu + 1) & ~1], us[nu | 1]));

    // u's in odd position; v's in even
    while (nv--)
      cycle.add(edge(vs[nv | 1], vs[(nv + 1) & ~1]));

    const nonces = new Uint32Array(this.size);

    let n = 0;
    for (let nonce = 0; nonce < this.easiness; nonce++) {
      const x = this.sipnode(key, nonce, 0);
      const y = this.sipnode(key, nonce, 1);
      const e = edge(x, y);
      if (cycle.has(e)) {
        if (this.size > 2)
          cycle.delete(e);
        nonces[n] = nonce;
        n += 1;
      }
    }

    assert(n === this.size);

    return nonces;
  }

  /**
   * Find a cycle for a given key.
   * @param {Buffer} key
   * @returns {Uint32Array|null} nonces
   */

  mine(key) {
    assert(Buffer.isBuffer(key));

    const us = new Uint32Array(MAX_PATH);
    const vs = new Uint32Array(MAX_PATH);

    for (let i = 0; i < this.buckets.length; i++)
      this.buckets[i] = 0;

    this.debug(
      'Attempting to find %d-cycle for %s (bits=%d, ease=%d).',
      this.size,
      key.toString('hex'),
      this.bits,
      this.ease);

    for (let nonce = 0; nonce < this.easiness; nonce++) {
      const u0 = this.sipnode(key, nonce, 0);

      if (u0 === 0)
        continue;

      const v0 = this.sipnode(key, nonce, 1);
      const u = this.buckets[u0];
      const v = this.buckets[v0];

      us[0] = u0;
      vs[0] = v0;

      let nu = this.path(u, us);
      let nv = this.path(v, vs);

      if (us[nu] === vs[nv]) {
        const min = nu < nv ? nu : nv;

        nu -= min;
        nv -= min;

        while (us[nu] !== vs[nv]) {
          nu += 1;
          nv += 1;
        }

        const len = nu + nv + 1;

        this.debug('%d-cycle found at %d.', len, nonce * 100 / this.easiness);

        if (len === this.size)
          return this.solution(key, us, nu, vs, nv);

        continue;
      }

      if (nu < nv) {
        while (nu--)
          this.buckets[us[nu + 1]] = us[nu];
        this.buckets[u0] = v0;
      } else {
        while (nv--)
          this.buckets[vs[nv + 1]] = vs[nv];
        this.buckets[v0] = u0;
      }
    }

    this.debug('Traversed %d nodes without solution.', this.easiness);

    return null;
  }

  mineHeader(hdr) {
    assert(Buffer.isBuffer(hdr));

    const key = this.sipkey(hdr);
    const nonces = this.mine(key);

    if (nonces)
      return Solution.fromArray(nonces);

    return null;
  }
}

/**
 * Cuckoo Cycle Solution
 */

class Solution {
  /**
   * Create a cuckoo solution.
   * @constructor
   */

  constructor() {
    this.proof = EMPTY_PROOF;
  }

  hash() {
    return blake2b.digest(this.proof, 32);
  }

  size() {
    return this.proof.length >>> 2;
  }

  set(proof) {
    assert(Buffer.isBuffer(proof));
    assert((proof.length % 4) === 0);

    const size = proof.length >>> 2;

    assert(size !== 0);
    assert((size & 1) === 0);

    this.proof = proof;

    return this;
  }

  toArrayLike(ArrayLike) {
    const arr = new ArrayLike(this.size());
    for (let i = 0; i < arr.length; i++)
      arr[i] = this.proof.readUInt32LE(i * 4, true);
    return arr;
  }

  toArray() {
    return this.toArrayLike(Uint32Array);
  }

  getSize() {
    return 1 + this.proof.length;
  }

  toWriter(bw) {
    bw.writeU8(this.size());
    bw.writeBytes(this.proof);
    return bw;
  }

  toRaw() {
    const data = Buffer.allocUnsafe(this.getSize());
    data[0] = this.size();
    this.proof.copy(data, 1);
    return data;
  }

  toJSON() {
    return this.toArrayLike(Array);
  }

  toString() {
    return this.toJSON().join(', ');
  }

  inspect() {
    return `<Solution: ${this.toString()}>`;
  }

  static fromArrayLike(arr) {
    assert(arr.length > 0 && arr.length <= 254);
    assert((arr.length & 1) === 0);

    const proof = Buffer.allocUnsafe(arr.length * 4);

    for (let i = 0; i < arr.length; i++)
      proof.writeUInt32LE(arr[i], i * 4, true);

    const sol = new this();
    sol.proof = proof;

    return sol;
  }

  static fromOptions(obj) {
    assert(obj && typeof obj === 'object');

    if (Buffer.isBuffer(obj)) {
      const sol = new Solution();
      sol.set(obj);
      return sol;
    }

    if (typeof obj.length === 'number')
      return this.fromArrayLike(obj);

    const sol = new Solution();
    sol.set(obj.proof);
    return sol;
  }

  static fromArray(arr) {
    assert(ArrayBuffer.isView(arr));
    return this.fromArrayLike(arr);
  }

  static fromReader(br) {
    const size = br.readU8();

    if (size === 0 || (size & 1) === 1)
      throw new Error('Invalid proof size.');

    const sol = new this();
    sol.proof = br.readBytes(size * 4);

    return sol;
  }

  static fromRaw(data) {
    assert(Buffer.isBuffer(data));

    if (data.length === 0)
      throw new Error('Invalid proof size.');

    const size = data[0];

    if (size === 0 || (size & 1) === 1)
      throw new Error('Invalid proof size.');

    if (data.length !== 1 + size * 4)
      throw new Error('Invalid proof size.');

    const proof = Buffer.allocUnsafe(size * 4);
    data.copy(proof, 0, 0, size * 4);

    const sol = new this();
    sol.proof = proof;

    return sol;
  }

  static fromJSON(json) {
    assert(Array.isArray(json));
    return this.fromArrayLike(json);
  }

  static fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 3060);

    const parts = str.split(', ');
    assert(parts.length <= 254);

    const arr = [];

    for (const item of parts) {
      assert(item.length <= 10);
      assert(/^\d{1,10}$/.test(item));
      const num = parseInt(item, 10);
      assert((num >>> 0) === num);
      arr.push(num);
    }

    return this.fromArrayLike(arr);
  }
}

/*
 * Helpers
 */

function edge(x, y) {
  return `${x},${y}`;
}

/*
 * Expose
 */

exports.codes = codes;
exports.codesByVal = codesByVal;
exports.msgByVal = msgByVal;
exports.Cuckoo = Cuckoo;
exports.Miner = Miner;
exports.Solution = Solution;
