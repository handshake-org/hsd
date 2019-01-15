/*!
 * ownership.js - DNSSEC ownership proofs for hsd
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const base32 = require('bs32');
const util = require('bns/lib/util');
const blake2b = require('bcrypto/lib/blake2b');
const StubResolver = require('bns/lib/resolver/stub');
const BNSOwnership = require('bns/lib/ownership');
const aliases = require('./alias');
const reserved = require('./reserved');
const {Proof: BNSProof} = BNSOwnership;

/*
 * Constants
 */

// MAX_MONEY * 0.075
// (2.04e9 * 1e6) * 0.075
const MAX_REWARD = 153e6 * 1e6;
const EMPTY = Buffer.alloc(0);

// Trademark claims which require an alias.
const aliasMap = new Map(aliases);

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

  isKSK2010() {
    return ownership.isKSK2010(this);
  }

  isKSK2017() {
    return ownership.isKSK2017(this);
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
    this.secure = false;

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

    if (fee > MAX_REWARD)
      return null;

    const forked = (br.readU8() & 1) !== 0;

    if (forked && fee !== 0)
      return null;

    br.verifyChecksum(blake2b.digest);

    if (br.left() !== 0)
      return null;

    const name = aliasMap.get(target) || util.label(target, 0);
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

    if (forked && weak)
      return null;

    const rollover = proof.isKSK2017();

    const data = new ProofData();

    data.name = name;
    data.target = target;
    data.weak = weak;
    data.forked = forked;
    data.rollover = rollover;
    data.inception = inception;
    data.expiration = expiration;
    data.fee = fee;
    data.value = value;
    data.version = version;
    data.hash = hash;

    return data;
  }

  createData(address, fee, forked, network) {
    assert(address && address.hash);
    assert(Number.isSafeInteger(fee) && fee >= 0);
    assert(typeof forked === 'boolean');
    assert(network && network.claimPrefix);

    const prefix = network.claimPrefix;
    const {version, hash} = address;

    assert(typeof prefix === 'string');
    assert((version & 0xff) === version);
    assert(Buffer.isBuffer(hash));
    assert(version <= 31);
    assert(hash.length >= 2 && hash.length <= 40);

    const size = 2 + hash.length + bio.sizeVarint(fee) + 1 + 4;
    const bw = bio.write(size);

    bw.writeU8(version);
    bw.writeU8(hash.length);
    bw.writeBytes(hash);
    bw.writeVarint(fee);
    bw.writeU8(forked ? 1 : 0);
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
    this.forked = false;
    this.rollover = false;
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
