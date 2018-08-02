/*!
 * ownership.js - DNSSEC ownership proofs for hsd
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const util = require('bns/lib/util');
const StubResolver = require('bns/lib/resolver/stub');
const BNSOwnership = require('bns/lib/ownership');
const reserved = require('./reserved');
const {Proof: BNSProof} = BNSOwnership;

/*
 * Constants
 */

// MAX_MONEY * 0.075
// (2.04e9 * 1e6) * 0.075
const MAX_REWARD = 153e6 * 1e6;

let ownership = null;

/**
 * Proof
 */

class Proof extends BNSProof {
  constructor() {
    super();
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
    const b64 = txt.substring(prefix.length);
    const data = fromBase64URL(b64);

    const br = bio.read(data);
    const fee = br.readVarint();

    if (fee > MAX_REWARD)
      return null;

    const version = br.readU8();

    if (version > 31)
      return null;

    const size = br.readU8();

    if (size < 2 || size > 40)
      return null;

    const hash = br.readBytes(size);
    const forked = (br.readU8() & 1) !== 0;

    if (forked && fee !== 0)
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

    if (forked && weak)
      return null;

    const rollover = proof.isKSK2017();

    return {
      name,
      target,
      weak,
      forked,
      rollover,
      inception,
      expiration,
      fee,
      value,
      version,
      hash
    };
  }

  createData(fee, address, forked, network) {
    assert(Number.isSafeInteger(fee) && fee >= 0);
    assert(address);
    assert(typeof forked === 'boolean');
    assert(network);

    const prefix = network.claimPrefix;
    const {version, hash} = address;

    assert(typeof prefix === 'string');
    assert((version & 0xff) === version);
    assert(Buffer.isBuffer(hash));
    assert(version <= 31);
    assert(hash.length >= 2 && hash.length <= 40);

    const size = bio.sizeVarint(fee) + hash.length + 3;
    const bw = bio.write(size);

    bw.writeVarint(fee);
    bw.writeU8(version);
    bw.writeU8(hash.length);
    bw.writeBytes(hash);
    bw.writeU8(forked ? 1 : 0);

    const raw = bw.render();

    return prefix + toBase64URL(raw);
  }
}

Ownership.Proof = Proof;
Ownership.OwnershipProof = Proof;

/*
 * Ownership
 */

ownership = new Ownership();

/*
 * Helpers
 */

function toBase64URL(buf) {
  assert(Buffer.isBuffer(buf));

  const b64 = buf.toString('base64');
  const str = b64
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return str;
}

function fromBase64URL(str) {
  assert(typeof str === 'string');

  const b64 = pad64(str)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const buf = Buffer.from(b64, 'base64');

  if (b64.length !== size64(buf.length))
    throw new Error('Invalid base64-url string.');

  return buf;
}

function pad64(str) {
  switch (str.length & 3) {
    case 2:
      str += '==';
      break;
    case 3:
      str += '=';
      break;
  }
  return str;
}

function size64(size) {
  const expect = ((4 * size / 3) + 3) & ~3;
  return expect >>> 0;
}

/*
 * Expose
 */

module.exports = ownership;
