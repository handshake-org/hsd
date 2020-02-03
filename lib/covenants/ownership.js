/*!
 * ownership.js - DNSSEC ownership proofs for hsd
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const base32 = require('bcrypto/lib/encoding/base32');
const util = require('bns/lib/util');
const blake2b = require('bcrypto/lib/blake2b');
const StubResolver = require('bns/lib/resolver/stub');
const BNSOwnership = require('bns/lib/ownership');
const consensus = require('../protocol/consensus');
const reserved = require('./reserved');
const {Proof: BNSProof} = BNSOwnership;

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

let ownership = null;

/**
 * Proof
 */

class Proof extends BNSProof {
  constructor() {
    super();
  }

  decode(data) {
    const br = bio.read(data);

    if (data.length > 10000)
      throw new Error('Proof too large.');

    this.read(br);

    if (br.left() !== 0)
      throw new Error('Trailing data.');

    return this;
  }

  getNames() {
    const target = this.getTarget();

    if (target === '.')
      return ['', target];

    return [util.label(target, 0), target];
  }

  getName() {
    return this.getNames()[0];
  }

  addData(items) {
    return ownership.addData(this, items);
  }

  getData(network) {
    return ownership.getData(this, network);
  }

  isWeak() {
    return ownership.isWeak(this);
  }

  getWindow() {
    return ownership.getWindow(this);
  }

  isSane() {
    return ownership.isSane(this);
  }

  verifyTimes(time) {
    return ownership.verifyTimes(this, time);
  }

  verifySignatures() {
    return ownership.verifySignatures(this);
  }
}

/**
 * Ownership
 */

class Ownership extends BNSOwnership {
  constructor() {
    super();

    this.Resolver = StubResolver;
    this.secure = true;

    this.Proof = Proof;
    this.OwnershipProof = Proof;
  }

  hasPrefix(proof, target, [txt]) {
    // Used only in testing.
    return /^hns-[0-9a-z]+:/.test(txt);
  }

  isData(proof, target, [txt], network) {
    assert(network && typeof network.claimPrefix === 'string');

    const prefix = network.claimPrefix;

    return util.startsWith(txt, prefix);
  }

  parseData(proof, target, [txt], network) {
    assert(target !== '.');
    assert(network && typeof network.claimPrefix === 'string');

    const prefix = network.claimPrefix;
    const b32 = txt.substring(prefix.length);
    const raw = base32.decode(b32);

    const br = bio.read(raw);
    const version = br.readU8();

    if (version > 31)
      return null;

    const size = br.readU8();

    if (size < 2 || size > 40)
      return null;

    const hash = br.readBytes(size);
    const fee = br.readVarint();

    if (fee > consensus.MAX_MONEY)
      return null;

    const commitHash = br.readHash();
    const commitHeight = br.readU32();

    br.verifyChecksum(blake2b.digest);

    if (br.left() !== 0)
      return null;

    const name = util.label(target, 0);
    const item = reserved.getByName(name);

    if (!item)
      return null;

    if (target !== item.target)
      return null;

    const value = item.value;

    if (fee > value)
      return null;

    const [inception, expiration] = proof.getWindow();

    if (inception === 0 && expiration === 0)
      return null;

    const weak = proof.isWeak();
    const data = new ProofData();

    data.name = name;
    data.target = target;
    data.weak = weak;
    data.commitHash = commitHash;
    data.commitHeight = commitHeight;
    data.inception = inception;
    data.expiration = expiration;
    data.fee = fee;
    data.value = value;
    data.version = version;
    data.hash = hash;

    return data;
  }

  createData(address, fee, commitHash, commitHeight, network) {
    assert(address && address.hash);
    assert(Number.isSafeInteger(fee) && fee >= 0);
    assert(Buffer.isBuffer(commitHash) && commitHash.length === 32);
    assert((commitHeight >>> 0) === commitHeight);
    assert(commitHeight !== 0);
    assert(network && network.claimPrefix);

    const prefix = network.claimPrefix;
    const {version, hash} = address;

    assert(typeof prefix === 'string');
    assert((version & 0xff) === version);
    assert(Buffer.isBuffer(hash));
    assert(version <= 31);
    assert(hash.length >= 2 && hash.length <= 40);

    const size = 1
               + 1 + hash.length
               + bio.sizeVarint(fee)
               + 32
               + 4
               + 4;

    const bw = bio.write(size);

    bw.writeU8(version);
    bw.writeU8(hash.length);
    bw.writeBytes(hash);
    bw.writeVarint(fee);
    bw.writeHash(commitHash);
    bw.writeU32(commitHeight);
    bw.writeChecksum(blake2b.digest);

    const raw = bw.render();

    return prefix + base32.encode(raw);
  }
}

Ownership.Proof = Proof;
Ownership.OwnershipProof = Proof;

/**
 * ProofData
 */

class ProofData {
  constructor() {
    this.name = '';
    this.target = '.';
    this.weak = false;
    this.commitHash = blake2b.zero;
    this.commitHeight = 0;
    this.inception = 0;
    this.expiration = 0;
    this.fee = 0;
    this.value = 0;
    this.version = 0;
    this.hash = EMPTY;
  }
}

/*
 * Ownership
 */

ownership = new Ownership();

/*
 * Expose
 */

module.exports = ownership;
