/*!
 * ownership.js - DNSSEC ownership proofs for hskd
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const sha3 = require('bcrypto/lib/sha3');
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

  verifyName() {
    const [name, target] = this.getNames();
    const item = reserved.get(name);

    if (!item)
      return '';

    if (target !== item.target)
      return '';

    return name;
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
    const fee = br.readU64();

    if (fee > MAX_REWARD)
      return null;

    const block = br.readHash('hex');
    const version = br.readU8();

    if (version > 31)
      return null;

    const size = br.readU8();

    if (size < 2 || size > 40)
      return null;

    const hash = br.readBytes(size);
    const forked = (br.readU8() & 1) === 1;

    if (forked && fee !== 0)
      return null;

    const name = util.label(target, 0);
    const item = reserved.get(name);

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
    const nameRaw = Buffer.from(name, 'ascii');
    const nameHash = sha3.digest(nameRaw);

    return {
      name,
      nameRaw,
      nameHash,
      target,
      weak,
      forked,
      rollover,
      inception,
      expiration,
      fee,
      value,
      block,
      version,
      hash
    };
  }

  createData(fee, block, address, forked, network) {
    assert(Number.isSafeInteger(fee) && fee >= 0);
    assert(typeof block === 'string');
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

    const size = 8 + 32 + 2 + hash.length + 1;
    const bw = bio.write(size);

    bw.writeU64(fee);
    bw.writeHash(block);
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

  return Buffer.from(b64, 'base64');
}

function pad64(str) {
  assert(typeof str === 'string');

  const pad = 4 - (str.length % 4);

  if (pad === 4)
    return str;

  for (let i = 0; i < pad; i++)
    str += '=';

  return str;
}

/*
 * Expose
 */

module.exports = ownership;
