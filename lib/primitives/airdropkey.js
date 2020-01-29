/* eslint camelcase: 'off' */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const base16 = require('bcrypto/lib/encoding/base16');
const bech32 = require('bcrypto/lib/encoding/bech32');
const BLAKE2b = require('bcrypto/lib/blake2b');
const SHA256 = require('bcrypto/lib/sha256');
const rsa = require('bcrypto/lib/rsa');
const p256 = require('bcrypto/lib/p256');
const ed25519 = require('bcrypto/lib/ed25519');
const {countLeft} = require('bcrypto/lib/encoding/util');
const Goo = require('goosig');

/*
 * Goo
 */

const goo = new Goo(Goo.RSA2048, 2, 3);

/*
 * Constants
 */

const keyTypes = {
  RSA: 0,
  GOO: 1,
  P256: 2,
  ED25519: 3,
  ADDRESS: 4
};

const keyTypesByVal = {
  [keyTypes.RSA]: 'RSA',
  [keyTypes.GOO]: 'GOO',
  [keyTypes.P256]: 'P256',
  [keyTypes.ED25519]: 'ED25519',
  [keyTypes.ADDRESS]: 'ADDRESS'
};

const EMPTY = Buffer.alloc(0);

/**
 * AirdropKey
 */

class AirdropKey extends bio.Struct {
  constructor() {
    super();
    this.type = keyTypes.RSA;
    this.n = EMPTY;
    this.e = EMPTY;
    this.C1 = EMPTY;
    this.point = EMPTY;
    this.version = 0;
    this.address = EMPTY;
    this.value = 0;
    this.sponsor = false;
    this.nonce = SHA256.zero;
    this.tweak = null;
  }

  inject(key) {
    assert(key instanceof AirdropKey);

    this.type = key.type;
    this.n = key.n;
    this.e = key.e;
    this.C1 = key.C1;
    this.point = key.point;
    this.version = key.version;
    this.address = key.address;
    this.value = key.value;
    this.sponsor = key.sponsor;
    this.nonce = key.nonce;
    this.tweak = key.tweak;

    return this;
  }

  isRSA() {
    return this.type === keyTypes.RSA;
  }

  isGoo() {
    return this.type === keyTypes.GOO;
  }

  isP256() {
    return this.type === keyTypes.P256;
  }

  isED25519() {
    return this.type === keyTypes.ED25519;
  }

  isAddress() {
    return this.type === keyTypes.ADDRESS;
  }

  isWeak() {
    if (!this.isRSA())
      return false;

    return countLeft(this.n) < 2048 - 7;
  }

  validate() {
    switch (this.type) {
      case keyTypes.RSA: {
        let key;

        try {
          key = rsa.publicKeyImport({ n: this.n, e: this.e });
        } catch (e) {
          return false;
        }

        const bits = rsa.publicKeyBits(key);

        // Allow 1024 bit RSA for now.
        // We can softfork out later.
        return bits >= 1024 && bits <= 4096;
      }

      case keyTypes.GOO: {
        return this.C1.length === goo.size;
      }

      case keyTypes.P256: {
        return p256.publicKeyVerify(this.point);
      }

      case keyTypes.ED25519: {
        return ed25519.publicKeyVerify(this.point);
      }

      case keyTypes.ADDRESS: {
        return true;
      }

      default: {
        throw new assert.AssertionError('Invalid key type.');
      }
    }
  }

  verify(msg, sig) {
    assert(Buffer.isBuffer(msg));
    assert(Buffer.isBuffer(sig));

    switch (this.type) {
      case keyTypes.RSA: {
        let key;

        try {
          key = rsa.publicKeyImport({ n: this.n, e: this.e });
        } catch (e) {
          return false;
        }

        return rsa.verify(SHA256, msg, sig, key);
      }

      case keyTypes.GOO: {
        return goo.verify(msg, sig, this.C1);
      }

      case keyTypes.P256: {
        return p256.verify(msg, sig, this.point);
      }

      case keyTypes.ED25519: {
        return ed25519.verify(msg, sig, this.point);
      }

      case keyTypes.ADDRESS: {
        return true;
      }

      default: {
        throw new assert.AssertionError('Invalid key type.');
      }
    }
  }

  hash() {
    const bw = bio.pool(this.getSize());
    this.write(bw);
    return BLAKE2b.digest(bw.render());
  }

  getSize() {
    let size = 0;

    size += 1;

    switch (this.type) {
      case keyTypes.RSA:
        assert(this.n.length <= 0xffff);
        assert(this.e.length <= 0xff);
        size += 2;
        size += this.n.length;
        size += 1;
        size += this.e.length;
        size += 32;
        break;
      case keyTypes.GOO:
        size += goo.size;
        break;
      case keyTypes.P256:
        size += 33;
        size += 32;
        break;
      case keyTypes.ED25519:
        size += 32;
        size += 32;
        break;
      case keyTypes.ADDRESS:
        size += 1;
        size += 1;
        size += this.address.length;
        size += 8;
        size += 1;
        break;
      default:
        throw new assert.AssertionError('Invalid key type.');
    }

    return size;
  }

  write(bw) {
    bw.writeU8(this.type);

    switch (this.type) {
      case keyTypes.RSA:
        bw.writeU16(this.n.length);
        bw.writeBytes(this.n);
        bw.writeU8(this.e.length);
        bw.writeBytes(this.e);
        bw.writeBytes(this.nonce);
        break;
      case keyTypes.GOO:
        bw.writeBytes(this.C1);
        break;
      case keyTypes.P256:
      case keyTypes.ED25519:
        bw.writeBytes(this.point);
        bw.writeBytes(this.nonce);
        break;
      case keyTypes.ADDRESS:
        bw.writeU8(this.version);
        bw.writeU8(this.address.length);
        bw.writeBytes(this.address);
        bw.writeU64(this.value);
        bw.writeU8(this.sponsor ? 1 : 0);
        break;
      default:
        throw new assert.AssertionError('Invalid key type.');
    }

    return bw;
  }

  read(br) {
    this.type = br.readU8();

    switch (this.type) {
      case keyTypes.RSA: {
        this.n = br.readBytes(br.readU16());
        this.e = br.readBytes(br.readU8());
        this.nonce = br.readBytes(32);
        break;
      }

      case keyTypes.GOO: {
        this.C1 = br.readBytes(goo.size);
        break;
      }

      case keyTypes.P256: {
        this.point = br.readBytes(33);
        this.nonce = br.readBytes(32);
        break;
      }

      case keyTypes.ED25519: {
        this.point = br.readBytes(32);
        this.nonce = br.readBytes(32);
        break;
      }

      case keyTypes.ADDRESS: {
        this.version = br.readU8();
        this.address = br.readBytes(br.readU8());
        this.value = br.readU64();
        this.sponsor = br.readU8() === 1;
        break;
      }

      default: {
        throw new Error('Unknown key type.');
      }
    }

    return this;
  }

  fromAddress(addr, value, sponsor = false) {
    assert(typeof addr === 'string');
    assert(Number.isSafeInteger(value) && value >= 0);
    assert(typeof sponsor === 'boolean');

    const [hrp, version, hash] = bech32.decode(addr);

    assert(hrp === 'hs' || hrp === 'ts' || hrp === 'rs');
    assert(version === 0);
    assert(hash.length === 20 || hash.length === 32);

    this.type = keyTypes.ADDRESS;
    this.version = version;
    this.address = hash;
    this.value = value;
    this.sponsor = sponsor;

    return this;
  }

  getJSON() {
    return {
      type: keyTypesByVal[this.type] || 'UNKNOWN',
      n: this.n.length > 0
        ? this.n.toString('hex')
        : undefined,
      e: this.e.length > 0
        ? this.e.toString('hex')
        : undefined,
      C1: this.C1.length > 0
        ? this.C1.toString('hex')
        : undefined,
      point: this.point.length > 0
        ? this.point.toString('hex')
        : undefined,
      version: this.address.length > 0
        ? this.version
        : undefined,
      address: this.address.length > 0
        ? this.address.toString('hex')
        : undefined,
      value: this.value || undefined,
      sponsor: this.value
        ? this.sponsor
        : undefined,
      nonce: !this.isGoo() && !this.isAddress()
        ? this.nonce.toString('hex')
        : undefined
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert(typeof json.type === 'string');
    assert(keyTypes.hasOwnProperty(json.type));

    this.type = keyTypes[json.type];

    switch (this.type) {
      case keyTypes.RSA: {
        this.n = base16.decode(json.n);
        this.e = base16.decode(json.e);
        this.nonce = base16.decode(json.nonce, 32);
        break;
      }

      case keyTypes.GOO: {
        this.C1 = base16.decode(json.C1);
        break;
      }

      case keyTypes.P256: {
        this.point = base16.decode(json.point, 33);
        this.nonce = base16.decode(json.nonce, 32);
        break;
      }

      case keyTypes.ED25519: {
        this.point = base16.decode(json.point, 32);
        this.nonce = base16.decode(json.nonce, 32);
        break;
      }

      case keyTypes.ADDRESS: {
        assert((json.version & 0xff) === json.version);
        assert(Number.isSafeInteger(json.value) && json.value >= 0);
        assert(typeof json.sponsor === 'boolean');
        this.version = json.version;
        this.address = base16.decode(json.address);
        this.value = json.value;
        this.sponsor = json.sponsor;
        break;
      }

      default: {
        throw new Error('Unknown key type.');
      }
    }

    return this;
  }

  static fromAddress(addr, value, sponsor) {
    return new this().fromAddress(addr, value, sponsor);
  }
}

/*
 * Static
 */

AirdropKey.keyTypes = keyTypes;
AirdropKey.keyTypesByVal = keyTypesByVal;

/*
 * Expose
 */

module.exports = AirdropKey;
