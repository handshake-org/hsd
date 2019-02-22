/*!
 * claim.js - DNSSEC ownership proofs for hsd
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const rules = require('../covenants/rules');
const ownership = require('../covenants/ownership');
const InvItem = require('./invitem');
const TX = require('./tx');
const Input = require('./input');
const Output = require('./output');
const {types} = rules;
const {OwnershipProof} = ownership;

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/**
 * Claim
 * @extends {bufio.Struct}
 */

class Claim extends bio.Struct {
  constructor() {
    super();

    this.blob = EMPTY;

    this._hash = null;
    this._data = null;
  }

  refresh() {
    this._hash = null;
    this._data = null;
    return this;
  }

  hash() {
    if (!this._hash)
      this._hash = blake2b.digest(this.blob);

    return this._hash;
  }

  hashHex() {
    return this.hash().toString('hex');
  }

  getData(network) {
    if (!this._data) {
      const proof = this.getProof();

      if (!proof)
        return null;

      const data = proof.getData(network);

      if (!data)
        return null;

      this._data = data;
    }

    return this._data;
  }

  getSize() {
    return 2 + this.blob.length;
  }

  write(bw) {
    bw.writeU16(this.blob.length);
    bw.writeBytes(this.blob);
    return bw;
  }

  decode(data) {
    const br = bio.read(data);

    if (data.length > 2 + 10000)
      throw new Error('Proof too large.');

    this.read(br);

    if (br.left() !== 0)
      throw new Error('Trailing data.');

    return this;
  }

  read(br) {
    const size = br.readU16();

    if (size > 10000)
      throw new Error('Invalid claim size.');

    this.blob = br.readBytes(size);

    return this;
  }

  toInv() {
    return new InvItem(InvItem.types.CLAIM, this.hash());
  }

  getWeight() {
    return this.getSize();
  }

  getVirtualSize() {
    const scale = consensus.WITNESS_SCALE_FACTOR;
    return (this.getWeight() + scale - 1) / scale | 0;
  }

  getMinFee(size, rate) {
    if (size == null)
      size = this.getVirtualSize();

    return policy.getMinFee(size, rate);
  }

  getFee(network) {
    const data = this.getData(network);
    assert(data);
    return data.fee;
  }

  getRate(size, network) {
    const fee = this.getFee(network);

    if (size == null)
      size = this.getVirtualSize();

    return policy.getRate(size, fee);
  }

  toTX(network, height) {
    const data = this.getData(network);
    assert(data);

    const tx = new TX();

    tx.inputs.push(new Input());
    tx.outputs.push(new Output());

    const input = new Input();
    input.witness.items.push(this.blob);

    const output = new Output();

    output.value = data.value - data.fee;

    output.address.version = data.version;
    output.address.hash = data.hash;

    let flags = 0;

    if (data.weak)
      flags |= 1;

    output.covenant.type = types.CLAIM;
    output.covenant.pushHash(rules.hashName(data.name));
    output.covenant.pushU32(height);
    output.covenant.pushString(data.name);
    output.covenant.pushU8(flags);
    output.covenant.pushHash(data.commitHash);
    output.covenant.pushU32(data.commitHeight);

    tx.inputs.push(input);
    tx.outputs.push(output);

    tx.refresh();

    return tx;
  }

  getProof() {
    try {
      return this.toProof();
    } catch (e) {
      return new OwnershipProof();
    }
  }

  toProof() {
    return OwnershipProof.decode(this.blob);
  }

  toBlob() {
    return this.blob;
  }

  getJSON() {
    const proof = this.getProof();
    return proof.toJSON();
  }

  fromBlob(blob) {
    assert(Buffer.isBuffer(blob));
    this.blob = blob;
    return this;
  }

  fromProof(proof) {
    assert(proof instanceof OwnershipProof);
    this.blob = proof.encode();
    return this;
  }

  static fromBlob(blob) {
    return new this().fromBlob(blob);
  }

  static fromProof(proof) {
    return new this().fromProof(proof);
  }
}

/*
 * Expose
 */

module.exports = Claim;
