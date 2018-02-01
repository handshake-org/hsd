/*!
 * keyring.js - keyring object for hsk
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const {base58} = require('bstring');
const bio = require('bufio');
const hash160 = require('bcrypto/lib/hash160');
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

class KeyRing {
  /**
   * Create a key ring.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
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
   * Instantiate key ring from options.
   * @param {Object} options
   * @returns {KeyRing}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Clear cached key/script hashes.
   */

  refresh() {
    this._keyHash = null;
    this._keyAddress = null;
    this._scriptHash = null;
    this._scriptAddress = null;
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
    const key = secp256k1.generatePrivateKey();
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
   * Convert key to a CBitcoinSecret.
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
   * Inject properties from serialized CBitcoinSecret.
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
   * Instantiate a keyring from a serialized CBitcoinSecret.
   * @param {Base58String} secret
   * @param {(Network|NetworkType)?} network
   * @returns {KeyRing}
   */

  static fromSecret(data, network) {
    return new this().fromSecret(data, network);
  }

  /**
   * Get private key.
   * @param {String?} enc - Can be `"hex"`, `"base58"`, or `null`.
   * @returns {Buffer} Private key.
   */

  getPrivateKey(enc, network) {
    if (!this.privateKey)
      return null;

    if (enc === 'base58')
      return this.toSecret(network);

    if (enc === 'hex')
      return this.privateKey.toString('hex');

    return this.privateKey;
  }

  /**
   * Get public key.
   * @param {String?} enc - `"hex"` or `null`.
   * @returns {Buffer}
   */

  getPublicKey(enc) {
    if (enc === 'base58')
      return base58.encode(this.publicKey);

    if (enc === 'hex')
      return this.publicKey.toString('hex');

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
   * Get ripemd160 scripthash.
   * @param {String?} enc - `"hex"` or `null`.
   * @returns {Buffer}
   */

  getScriptHash(enc) {
    if (!this.script)
      return null;

    if (!this._scriptHash)
      this._scriptHash = this.script.hash256();

    return enc === 'hex'
      ? this._scriptHash.toString('hex')
      : this._scriptHash;
  }

  /**
   * Get scripthash address.
   * @param {String?} enc - `"base58"` or `null`.
   * @returns {Address|AddressString}
   */

  getScriptAddress(enc, network) {
    if (!this.script)
      return null;

    if (!this._scriptAddress) {
      const hash = this.getScriptHash();
      const addr = Address.fromScripthash(hash);
      this._scriptAddress = addr;
    }

    if (enc === 'string')
      return this._scriptAddress.toString(network);

    return this._scriptAddress;
  }

  /**
   * Get public key hash.
   * @param {String?} enc - `"hex"` or `null`.
   * @returns {Buffer}
   */

  getKeyHash(enc) {
    if (!this._keyHash)
      this._keyHash = hash160.digest(this.publicKey);

    return enc === 'hex'
      ? this._keyHash.toString('hex')
      : this._keyHash;
  }

  /**
   * Get pubkeyhash address.
   * @param {String?} enc - `"base58"` or `null`.
   * @returns {Address|AddressString}
   */

  getKeyAddress(enc, network) {
    if (!this._keyAddress) {
      const hash = this.getKeyHash();
      const addr = Address.fromPubkeyhash(hash);
      this._keyAddress = addr;
    }

    if (enc === 'string')
      return this._keyAddress.toString(network);

    return this._keyAddress;
  }

  /**
   * Get hash.
   * @param {String?} enc - `"hex"` or `null`.
   * @returns {Buffer}
   */

  getHash(enc) {
    if (this.script)
      return this.getScriptHash(enc);

    return this.getKeyHash(enc);
  }

  /**
   * Get base58 address.
   * @param {String?} enc - `"base58"` or `null`.
   * @returns {Address|AddressString}
   */

  getAddress(enc, network) {
    if (this.script)
      return this.getScriptAddress(enc, network);

    return this.getKeyAddress(enc, network);
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

  inspect() {
    return this.toJSON();
  }

  /**
   * Convert an KeyRing to a more json-friendly object.
   * @returns {Object}
   */

  toJSON(network) {
    return {
      publicKey: this.publicKey.toString('hex'),
      script: this.script ? this.script.toRaw().toString('hex') : null,
      address: this.getAddress('string', network)
    };
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json);
    assert(typeof json.witness === 'boolean');
    assert(typeof json.nested === 'boolean');
    assert(typeof json.publicKey === 'string');
    assert(!json.script || typeof json.script === 'string');

    this.publicKey = Buffer.from(json.publicKey, 'hex');

    if (json.script)
      this.script = Buffer.from(json.script, 'hex');

    return this;
  }

  /**
   * Instantiate an KeyRing from a jsonified transaction object.
   * @param {Object} json - The jsonified transaction object.
   * @returns {KeyRing}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
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

  toWriter(bw) {
    if (this.privateKey) {
      bw.writeU8(0);
      bw.writeVarBytes(this.privateKey);
    } else {
      bw.writeU8(1);
      bw.writeVarBytes(this.publicKey);
    }

    if (this.script)
      bw.writeVarBytes(this.script.toRaw());
    else
      bw.writeVarint(0);

    return bw;
  }

  /**
   * Serialize the keyring.
   * @returns {Buffer}
   */

  toRaw() {
    const size = this.getSize();
    return this.toWriter(bio.write(size)).render();
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  fromReader(br) {
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
      this.script = Script.fromRaw(script);

    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  /**
   * Instantiate a keyring from buffer reader.
   * @param {BufferReader} br
   * @returns {KeyRing}
   */

  static fromReader(br) {
    return new this().fromReader(br);
  }

  /**
   * Instantiate a keyring from serialized data.
   * @param {Buffer} data
   * @returns {KeyRing}
   */

  static fromRaw(data) {
    return new this().fromRaw(data);
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
