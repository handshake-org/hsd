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

  getData(network) {
    return ownership.getData(this, network);
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
    // Note: should be changed
    // to `true` for mainnet.
    super(StubResolver, false);

    this.Proof = Proof;
    this.OwnershipProof = Proof;
  }

  static get Proof() {
    return Proof;
  }

  static get OwnershipProof() {
    return Proof;
  }

  parseData(dname, items, network) {
    assert(typeof dname === 'string');
    assert(Array.isArray(items));
    assert(network && (network.magic >>> 0) === network.magic);
    assert(util.isFQDN(dname));

    if (items.length !== 1)
      return null;

    if (dname === '.')
      return null;

    const txt = items[0];
    const parts = txt.split(':');

    if (parts.length !== 2)
      return null;

    const [prefix, hex] = parts;

    if (prefix !== 'hns-claim')
      return null;

    // if (hex.length & 1)
    //   return null;
    //
    // const data = Buffer.from(hex, 'hex');
    //
    // if (data.length !== (hex.length >>> 1))
    //   return null;

    const data = Buffer.from(hex, 'base64');

    const br = bio.read(data);
    const magic = br.readU32();

    if (magic !== network.magic)
      return null;

    const fee = br.readU64();

    if (fee > MAX_REWARD)
      return null;

    const block = br.readHash('hex');
    const version = br.readU8();
    const size = br.readU8();

    if (version > 31)
      return null;

    if (size < 2 || size > 40)
      return null;

    const hash = br.readBytes(size);

    const target = dname.toLowerCase();
    const name = util.label(target, 0);
    const item = reserved.get(name);

    if (!item)
      return null;

    if (target !== item.target)
      return null;

    if (fee > item.value)
      return null;

    const nameRaw = Buffer.from(name, 'ascii');
    const nameHash = sha3.digest(nameRaw);

    return {
      name,
      nameRaw,
      nameHash,
      target,
      fee,
      value: item.value,
      block,
      version,
      hash
    };
  }

  createData(fee, block, address, network) {
    assert(Number.isSafeInteger(fee) && fee >= 0);
    assert(typeof block === 'string');
    assert(address);
    assert(network);

    const {magic} = network;
    const {version, hash} = address;

    assert((magic >>> 0) === magic);
    assert((version & 0xff) === version);
    assert(Buffer.isBuffer(hash));
    assert(version <= 31);
    assert(hash.length >= 2 && hash.length <= 40);

    const size = 4 + 8 + 32 + 2 + hash.length;
    const bw = bio.write(size);

    bw.writeU32(magic);
    bw.writeU64(fee);
    bw.writeHash(block);
    bw.writeU8(version);
    bw.writeU8(hash.length);
    bw.writeBytes(hash);

    const raw = bw.render();

    // return `hns-claim:${raw.toString('hex')}`;
    return `hns-claim:${raw.toString('base64')}`;
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
