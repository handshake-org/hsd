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
const Ownership = require('../covenants/ownership');
const InvItem = require('./invitem');
const TX = require('./tx');
const Input = require('./input');
const Output = require('./output');
const {OwnershipProof} = Ownership;

/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../types').Amount} AmountValue */
/** @typedef {import('../types').Rate} Rate */
/** @typedef {import('../types').BufioWriter} BufioWriter */
/** @typedef {import('../protocol/network')} Network */

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/**
 * Claim
 * @extends {bio.Struct}
 */

class Claim extends bio.Struct {
  constructor() {
    super();

    this.blob = EMPTY;

    /** @type {Hash?} */
    this._hash = null;
    this._data = null;
  }

  /**
   * @returns {this}
   */

  refresh() {
    this._hash = null;
    this._data = null;
    return this;
  }

  /**
   * @returns {Hash}
   */

  hash() {
    if (!this._hash)
      this._hash = blake2b.digest(this.blob);

    return this._hash;
  }

  /**
   * @returns {String}
   */

  hashHex() {
    return this.hash().toString('hex');
  }

  /**
   * @param {Network} network
   * @returns {Object}
   */

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

  /**
   * @returns {Number}
   */

  getSize() {
    return 2 + this.blob.length;
  }

  /**
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    bw.writeU16(this.blob.length);
    bw.writeBytes(this.blob);
    return bw;
  }

  /**
   * @param {Buffer} data
   * @returns {this}
   */

  decode(data) {
    const br = bio.read(data);

    if (data.length > 2 + 10000)
      throw new Error('Proof too large.');

    this.read(br);

    if (br.left() !== 0)
      throw new Error('Trailing data.');

    return this;
  }

  /**
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    const size = br.readU16();

    if (size > 10000)
      throw new Error('Invalid claim size.');

    this.blob = br.readBytes(size);

    return this;
  }

  /**
   * @returns {InvItem}
   */

  toInv() {
    return new InvItem(InvItem.types.CLAIM, this.hash());
  }

  /**
   * @returns {Number}
   */

  getWeight() {
    return this.getSize();
  }

  /**
   * @returns {Number}
   */

  getVirtualSize() {
    const scale = consensus.WITNESS_SCALE_FACTOR;
    return (this.getWeight() + scale - 1) / scale | 0;
  }

  /**
   * @param {Number} [size]
   * @param {Number} [rate]
   * @returns {AmountValue}
   */

  getMinFee(size, rate) {
    if (size == null)
      size = this.getVirtualSize();

    return policy.getMinFee(size, rate);
  }

  /**
   * @param {Network} [network]
   * @returns {AmountValue}
   */

  getFee(network) {
    const data = this.getData(network);
    assert(data);
    return data.fee;
  }

  /**
   * @param {Number} [size]
   * @param {Network} [network]
   * @returns {Rate}
   */

  getRate(size, network) {
    const fee = this.getFee(network);

    if (size == null)
      size = this.getVirtualSize();

    return policy.getRate(size, fee);
  }

  /**
   * @param {Network} network
   * @param {Number} height
   * @returns {TX}
   */

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

    output.covenant.setClaim(
      rules.hashName(data.name),
      height,
      Buffer.from(data.name, 'binary'),
      flags,
      data.commitHash,
      data.commitHeight
    );

    tx.inputs.push(input);
    tx.outputs.push(output);

    tx.refresh();

    return tx;
  }

  /**
   * @returns {OwnershipProof}
   */

  getProof() {
    try {
      return this.toProof();
    } catch (e) {
      return new OwnershipProof();
    }
  }

  /**
   * @returns {OwnershipProof}
   */

  toProof() {
    return OwnershipProof.decode(this.blob);
  }

  /**
   * @returns {Buffer}
   */

  toBlob() {
    return this.blob;
  }

  /**
   * @returns {Object}
   */

  getJSON() {
    const proof = this.getProof();
    return proof.toJSON();
  }

  /**
   * Inject properties from blob.
   * @param {Buffer} blob
   * @returns {this}
   */

  fromBlob(blob) {
    assert(Buffer.isBuffer(blob));
    this.blob = blob;
    return this;
  }

  /**
   * @param {OwnershipProof} proof
   * @returns {this}
   */

  fromProof(proof) {
    assert(proof instanceof OwnershipProof);
    this.blob = proof.encode();
    return this;
  }

  /**
   * Instantiate claim from raw proof.
   * @param {Buffer} blob
   * @returns {Claim}
   */

  static fromBlob(blob) {
    return new this().fromBlob(blob);
  }

  /**
   * Instantiate claim from proof.
   * @param {OwnershipProof} proof
   * @returns {Claim}
   */

  static fromProof(proof) {
    return new this().fromProof(proof);
  }
}

/*
 * Expose
 */

module.exports = Claim;
