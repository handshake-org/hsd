/*!
 * keyring.js - keyring object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const base58 = require('bcrypto/lib/encoding/base58');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const hash256 = require('bcrypto/lib/hash256');
const Network = require('../protocol/network');
const Script = require('../script/script');
const Address = require('./address');
const Output = require('./output');
const secp256k1 = require('bcrypto/lib/secp256k1');

/*
 * Constants
 */

const ZERO_KEY = Buffer.alloc(33, 0x00);

/**
 * Key Ring
 * Represents a key ring which amounts to an address.
 * @alias module:primitives.KeyRing
 */

class KeyRing extends bio.Struct {
  /**
   * Create a key ring.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.publicKey = ZERO_KEY;
    this.privateKey = null;
    this.script = null;

    this._keyHash = null;
    this._keyAddress = null;
    this._scriptHash = null;
    this._scriptAddress = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    let key = toKey(options);

    if (Buffer.isBuffer(key))
      return this.fromKey(key);

    key = toKey(options.key);

    if (options.publicKey)
      key = toKey(options.publicKey);

    if (options.privateKey)
      key = toKey(options.privateKey);

    const script = options.script;

    if (script)
      return this.fromScript(key, script);

    return this.fromKey(key);
  }

  /**
   * Clear cached key/script hashes.
   */

  refresh() {
    this._keyHash = null;
    this._keyAddress = null;
    this._scriptHash = null;
    this._scriptAddress = null;
    return this;
  }

  /**
   * Inject data from private key.
   * @private
   * @param {Buffer} key
   */

  fromPrivate(key) {
    assert(Buffer.isBuffer(key), 'Private key must be a buffer.');
    assert(secp256k1.privateKeyVerify(key), 'Not a valid private key.');

    this.privateKey = key;
    this.publicKey = secp256k1.publicKeyCreate(key, true);

    return this;
  }

  /**
   * Instantiate keyring from a private key.
   * @param {Buffer} key
   * @returns {KeyRing}
   */

  static fromPrivate(key) {
    return new this().fromPrivate(key);
  }

  /**
   * Inject data from public key.
   * @private
   * @param {Buffer} key
   */

  fromPublic(key) {
    assert(Buffer.isBuffer(key), 'Public key must be a buffer.');
    assert(secp256k1.publicKeyVerify(key) && key.length === 33,
      'Not a valid public key.');
    this.publicKey = key;
    return this;
  }

  /**
   * Generate a keyring.
   * @private
   * @returns {KeyRing}
   */

  generate() {
    const key = secp256k1.privateKeyGenerate();
    return this.fromKey(key);
  }

  /**
   * Generate a keyring.
   * @returns {KeyRing}
   */

  static generate() {
    return new this().generate();
  }

  /**
   * Instantiate keyring from a public key.
   * @param {Buffer} publicKey
   * @returns {KeyRing}
   */

  static fromPublic(key) {
    return new this().fromPublic(key);
  }

  /**
   * Inject data from public key.
   * @private
   * @param {Buffer} privateKey
   */

  fromKey(key) {
    assert(Buffer.isBuffer(key), 'Key must be a buffer.');

    if (key.length === 32)
      return this.fromPrivate(key, true);

    return this.fromPublic(key);
  }

  /**
   * Instantiate keyring from a public key.
   * @param {Buffer} publicKey
   * @returns {KeyRing}
   */

  static fromKey(key) {
    return new this().fromKey(key);
  }

  /**
   * Inject data from script.
   * @private
   * @param {Buffer} key
   * @param {Script} script
   */

  fromScript(key, script) {
    assert(script instanceof Script, 'Non-script passed into KeyRing.');

    this.fromKey(key);
    this.script = script;

    return this;
  }

  /**
   * Instantiate keyring from script.
   * @param {Buffer} key
   * @param {Script} script
   * @returns {KeyRing}
   */

  static fromScript(key, script) {
    return new this().fromScript(key, script);
  }

  /**
   * Calculate WIF serialization size.
   * @returns {Number}
   */

  getSecretSize() {
    let size = 0;

    size += 1;
    size += this.privateKey.length;
    size += 1;
    size += 4;

    return size;
  }

  /**
   * Convert key to a secret.
   * @param {(Network|NetworkType)?} network
   * @returns {Base58String}
   */

  toSecret(network) {
    const size = this.getSecretSize();
    const bw = bio.write(size);

    assert(this.privateKey, 'Cannot serialize without private key.');

    network = Network.get(network);

    bw.writeU8(network.keyPrefix.privkey);
    bw.writeBytes(this.privateKey);
    bw.writeU8(1);

    bw.writeChecksum(hash256.digest);

    return base58.encode(bw.render());
  }

  /**
   * Inject properties from serialized secret.
   * @private
   * @param {Base58String} secret
   * @param {(Network|NetworkType)?} network
   */

  fromSecret(data, network) {
    const br = bio.read(base58.decode(data), true);

    const version = br.readU8();

    Network.fromWIF(version, network);

    const key = br.readBytes(32);

    assert(br.readU8() === 1, 'Bad compression flag.');
    br.verifyChecksum(hash256.digest);

    return this.fromPrivate(key);
  }

  /**
   * Instantiate a keyring from a serialized secret.
   * @param {Base58String} secret
   * @param {(Network|NetworkType)?} network
   * @returns {KeyRing}
   */

  static fromSecret(data, network) {
    return new this().fromSecret(data, network);
  }

  /**
   * Get private key.
   * @returns {Buffer} Private key.
   */

  getPrivateKey() {
    if (!this.privateKey)
      return null;

    return this.privateKey;
  }

  /**
   * Get public key.
   * @returns {Buffer}
   */

  getPublicKey() {
    return this.publicKey;
  }

  /**
   * Get redeem script.
   * @returns {Script}
   */

  getScript() {
    return this.script;
  }

  /**
   * Get scripthash.
   * @returns {Buffer}
   */

  getScriptHash() {
    if (!this.script)
      return null;

    if (!this._scriptHash)
      this._scriptHash = this.script.sha3();

    return this._scriptHash;
  }

  /**
   * Get scripthash address.
   * @returns {Address}
   */

  getScriptAddress() {
    if (!this.script)
      return null;

    if (!this._scriptAddress) {
      const hash = this.getScriptHash();
      const addr = Address.fromScripthash(hash);
      this._scriptAddress = addr;
    }

    return this._scriptAddress;
  }

  /**
   * Get public key hash.
   * @returns {Buffer}
   */

  getKeyHash() {
    if (!this._keyHash)
      this._keyHash = blake2b.digest(this.publicKey, 20);

    return this._keyHash;
  }

  /**
   * Get pubkeyhash address.
   * @returns {Address}
   */

  getKeyAddress() {
    if (!this._keyAddress) {
      const hash = this.getKeyHash();
      const addr = Address.fromPubkeyhash(hash);
      this._keyAddress = addr;
    }

    return this._keyAddress;
  }

  /**
   * Get hash.
   * @returns {Buffer}
   */

  getHash() {
    if (this.script)
      return this.getScriptHash();

    return this.getKeyHash();
  }

  /**
   * Get base58 address.
   * @returns {Address}
   */

  getAddress() {
    if (this.script)
      return this.getScriptAddress();

    return this.getKeyAddress();
  }

  /**
   * Test an address hash against hash and program hash.
   * @param {Buffer} hash
   * @returns {Boolean}
   */

  ownHash(hash) {
    if (!hash)
      return false;

    if (hash.equals(this.getKeyHash()))
      return true;

    if (this.script) {
      if (hash.equals(this.getScriptHash()))
        return true;
    }

    return false;
  }

  /**
   * Check whether transaction output belongs to this address.
   * @param {TX|Output} tx - Transaction or Output.
   * @param {Number?} index - Output index.
   * @returns {Boolean}
   */

  ownOutput(tx, index) {
    let output;

    if (tx instanceof Output) {
      output = tx;
    } else {
      output = tx.outputs[index];
      assert(output, 'Output does not exist.');
    }

    return this.ownHash(output.getHash());
  }

  /**
   * Test a hash against script hashes to
   * find the correct redeem script, if any.
   * @param {Buffer} hash
   * @returns {Script|null}
   */

  getRedeem(hash) {
    if (this.script) {
      if (hash.equals(this.getScriptHash()))
        return this.script;
    }

    return null;
  }

  /**
   * Sign a message.
   * @param {Buffer} msg
   * @returns {Buffer} Signature in DER format.
   */

  sign(msg) {
    assert(this.privateKey, 'Cannot sign without private key.');
    return secp256k1.sign(msg, this.privateKey);
  }

  /**
   * Verify a message.
   * @param {Buffer} msg
   * @param {Buffer} sig - Signature in DER format.
   * @returns {Boolean}
   */

  verify(msg, sig) {
    return secp256k1.verify(msg, sig, this.publicKey);
  }

  /**
   * Get witness program version.
   * @returns {Number}
   */

  getVersion() {
    return 0;
  }

  /**
   * Inspect keyring.
   * @returns {Object}
   */

  format() {
    return this.toJSON();
  }

  /**
   * Convert an KeyRing to a more json-friendly object.
   * @returns {Object}
   */

  getJSON(network) {
    return {
      publicKey: this.publicKey.toString('hex'),
      script: this.script ? this.script.toHex() : null,
      address: this.getAddress().toString(network)
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json);
    assert(typeof json.publicKey === 'string');
    assert(!json.script || typeof json.script === 'string');

    this.publicKey = Buffer.from(json.publicKey, 'hex');

    if (json.script)
      this.script = Buffer.from(json.script, 'hex');

    return this;
  }

  /**
   * Calculate serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += 1;

    if (this.privateKey)
      size += 32;
    else
      size += 33;

    size += this.script
      ? this.script.getVarSize()
      : 1;

    return size;
  }

  /**
   * Write the keyring to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    if (this.privateKey) {
      bw.writeU8(0);
      bw.writeBytes(this.privateKey);
    } else {
      bw.writeU8(1);
      bw.writeBytes(this.publicKey);
    }

    if (this.script)
      bw.writeVarBytes(this.script.encode());
    else
      bw.writeVarint(0);

    return bw;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    const type = br.readU8();

    switch (type) {
      case 0: {
        const key = br.readBytes(32);
        this.privateKey = key;
        this.publicKey = secp256k1.publicKeyCreate(key, true);
        break;
      }
      case 1: {
        const key = br.readBytes(33);
        assert(secp256k1.publicKeyVerify(key), 'Invalid public key.');
        this.publicKey = key;
        break;
      }
      default: {
        throw new Error('Invalid key.');
      }
    }

    const script = br.readVarBytes();

    if (script.length > 0)
      this.script = Script.decode(script);

    return this;
  }

  /**
   * Test whether an object is a KeyRing.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isKeyRing(obj) {
    return obj instanceof KeyRing;
  }
}

/*
 * Helpers
 */

function toKey(opt) {
  if (!opt)
    return opt;

  if (opt.privateKey)
    return opt.privateKey;

  if (opt.publicKey)
    return opt.publicKey;

  return opt;
}

/*
 * Expose
 */

module.exports = KeyRing;
