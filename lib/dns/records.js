/*!
 * records.js - hns records for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {encoding, wire, util} = require('bns');
const base32 = require('bs32');
const {IP, onion} = require('binet');
const {bech32} = require('bstring');
const {Struct} = require('bufio');
const sha3 = require('bcrypto/lib/sha3');
const compress = require('./compress');
const records = exports;

const {
  sizeName,
  writeNameBW,
  readNameBR,
  isName
} = encoding;

const {
  ipSize,
  ipWrite,
  ipRead,
  ipPack,
  ipUnpack,
  readAscii
} = compress;

/*
 * Constants
 */

const DUMMY = Buffer.alloc(0);

/**
 * Record Types
 * @enum {Number}
 */

const types = {
  INET4: 1, // A
  INET6: 2, // AAAA
  // new record
  ONION: 3, // TXT (appended to A/AAA responses)
  // new record
  ONIONNG: 4, // TXT (appended to A/AAA responses)
  NAME: 5, // CNAME
  // pseudo record
  GLUE: 6,
  CANONICAL: 7, // CNAME
  DELEGATE: 8, // DNAME
  NS: 9, // NS
  // needs protocol and service
  SERVICE: 10, // SRV
  // smaller bytes?
  URI: 11, // URI
  EMAIL: 12, // RP
  TEXT: 13, // TXT
  LOCATION: 14, // LOC
  // new record
  MAGNET: 15, // TXT
  DS: 16, // DS
  TLS: 17, // TLSA
  SMIME: 18, // SMIMEA
  SSH: 19, // SSHFP
  PGP: 20, // OPENPGPKEY
  // new record
  ADDR: 21 // TXT
};

/**
 * Target
 * @extends {Struct}
 */

class Target extends Struct {
  constructor(type, target) {
    super();
    this.type = types.INET4;
    this.target = '0.0.0.0';
    this.inet4 = '0.0.0.0';
    this.inet6 = '::';
    this.from(type, target);
  }

  from(type, target) {
    if (typeof type === 'string')
      return this.fromString(type);

    if (type != null)
      this.type = type;

    if (target != null)
      this.target = target;

    return this;
  }

  static from(type, target) {
    return new this().from(type, target);
  }

  toString() {
    if (this.isGlue()) {
      if (this.inet4 === '0.0.0.0' && this.inet6 === '::')
        throw new Error('Bad glue address.');

      const ips = [];

      if (this.inet4 !== '0.0.0.0')
        ips.push(this.inet4);

      if (this.inet6 !== '::')
        ips.push(this.inet6);

      return `${this.target}@${ips.join(',')}`;
    }

    return this.target;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 255);

    str = str.toLowerCase();

    const parts = str.split('@');

    if (parts.length > 1) {
      const name = util.fqdn(parts[0]);
      assert(isName(name));

      const ips = parts[1].split(',');
      assert(ips.length <= 2);

      this.type = types.GLUE;
      this.target = name;

      for (const ip of ips) {
        const [type, addr] = parseIP(ip);

        switch (type) {
          case types.ONION:
            throw new Error('Bad glue address.');
          case types.INET4:
            if (addr === '0.0.0.0')
              throw new Error('Bad glue address.');
            this.inet4 = addr;
            break;
          case types.INET6:
            if (addr === '::')
              throw new Error('Bad glue address.');
            this.inet6 = addr;
            break;
        }
      }

      return this;
    }

    if (IP.isIPv4String(str) || IP.isIPv6String(str)) {
      const [type, target] = parseIP(str);

      this.type = type;
      this.target = target;

      return this;
    }

    if (onion.isLegacyString(str)) {
      this.type = types.ONION;
      this.target = onion.normalizeLegacy(str);
      return this;
    }

    if (onion.isNGString(str)) {
      this.type = types.ONIONNG;
      this.target = onion.normalizeNG(str, sha3.digest);
      return this;
    }

    const name = util.fqdn(str);
    assert(isName(name));

    this.type = types.NAME;
    this.target = name;

    return this;
  }

  getJSON() {
    return this.toString();
  }

  fromJSON(json) {
    return this.fromString(json);
  }

  isNull() {
    return this.type === types.INET4 && this.target === '0.0.0.0';
  }

  toPointer(name) {
    assert(typeof name === 'string');
    assert(util.isFQDN(name));
    assert(this.isINET());

    const ip = IP.toBuffer(this.target);
    const data = ipPack(ip);
    const hash = base32.encodeHex(data);
    const labels = util.split(name);
    const tld = util.label(name, labels, -1);

    return `_${hash}.${tld}.`;
  }

  fromPointer(name) {
    assert(typeof name === 'string');
    assert(name.length > 0 && name[0] === '_');

    const data = base32.decodeHex(name.substring(1));
    assert(data.length > 0 && data.length <= 17);

    const ip = ipUnpack(data);

    if (IP.isIPv4(ip)) {
      this.type = types.INET4;
      this.target = IP.toString(ip);
    } else {
      this.type = types.INET6;
      this.target = IP.toString(ip);
    }

    return this;
  }

  static fromPointer(name) {
    return new this().fromPointer(name);
  }

  static isPointer(name, type) {
    if (type != null
        && type !== wire.types.ANY
        && type !== wire.types.A
        && type !== wire.types.AAAA) {
      return false;
    }

    if (name.length < 2 || name.length > 29)
      return false;

    if (name[0] !== '_')
      return false;

    return base32.testHex(name.substring(1));
  }

  matches(type) {
    switch (type) {
      case wire.types.ANY:
        return true;
      case wire.types.A:
        return this.isINET4();
      case wire.types.AAAA:
        return this.isINET6();
      default:
        return false;
    }
  }

  isINET4() {
    return this.type === types.INET4;
  }

  isINET6() {
    return this.type === types.INET6;
  }

  isOnion() {
    return this.type === types.ONION;
  }

  isOnionNG() {
    return this.type === types.ONIONNG;
  }

  isINET() {
    return this.type <= types.INET6;
  }

  isName() {
    return this.type === types.NAME || this.type === types.GLUE;
  }

  isGlue() {
    return this.type === types.GLUE;
  }

  isTor() {
    return this.isOnion() || this.isOnionNG();
  }

  toDNS() {
    return this.target;
  }

  compress() {}

  getSize(c) {
    if (this.type === types.GLUE) {
      let size = 1;
      size += sizeTarget(types.NAME, this.target, c);
      size += sizeTarget(types.INET4, this.inet4, c);
      size += sizeTarget(types.INET6, this.inet6, c);
      return size;
    }
    return 1 + sizeTarget(this.type, this.target, c);
  }

  write(bw, c) {
    bw.writeU8(this.type);
    if (this.type === types.GLUE) {
      if (this.inet4 === '0.0.0.0' && this.inet6 === '::')
        throw new Error('Bad glue address.');
      writeTarget(types.NAME, this.target, bw, c);
      writeTarget(types.INET4, this.inet4, bw, c);
      writeTarget(types.INET6, this.inet6, bw, c);
    } else {
      writeTarget(this.type, this.target, bw, c);
    }
    return this;
  }

  read(br) {
    this.type = br.readU8();
    if (this.type === types.GLUE) {
      this.target = readTarget(types.NAME, br);
      this.inet4 = readTarget(types.INET4, br);
      this.inet6 = readTarget(types.INET6, br);
      if (this.inet4 === '0.0.0.0' && this.inet6 === '::')
        throw new Error('Bad glue address.');
    } else {
      this.target = readTarget(this.type, br);
    }
    return this;
  }

  format() {
    return `<Target: ${this.toString()}>`;
  }
}

/**
 * Service
 * @extends {Struct}
 */

class Service extends Struct {
  constructor() {
    super();
    this.service = 'tcpmux.';
    this.protocol = 'icmp.';
    this.priority = 0;
    this.weight = 0;
    this.target = new Target();
    this.port = 0;
  }

  compress() {}

  getSize() {
    let size = 0;
    size += sizeName(this.service);
    size += sizeName(this.protocol);
    size += 1;
    size += 1;
    size += this.target.getSize();
    size += 2;
    return size;
  }

  write(bw, c) {
    writeNameBW(bw, this.service, c.labels);
    writeNameBW(bw, this.protocol, c.labels);
    bw.writeU8(this.priority);
    bw.writeU8(this.weight);
    this.target.write(bw, c);
    bw.writeU16BE(this.port);
    return this;
  }

  read(br) {
    this.service = readNameBR(br);

    if (util.countLabels(this.service) !== 1)
      throw new Error('Invalid label.');

    this.protocol = readNameBR(br);

    if (util.countLabels(this.protocol) !== 1)
      throw new Error('Invalid label.');

    this.priority = br.readU8();
    this.weight = br.readU8();
    this.target.read(br);
    this.port = br.readU16BE();

    return this;
  }

  getJSON() {
    return {
      service: util.trimFQDN(this.service),
      protocol: util.trimFQDN(this.protocol),
      priority: this.priority,
      weight: this.weight,
      target: this.target.toJSON(),
      port: this.port
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');

    if (json.service != null) {
      assert(isSingle(json.service));
      this.service = util.fqdn(json.service);
    }

    if (json.protocol != null) {
      assert(isSingle(json.protocol));
      this.protocol = util.fqdn(json.protocol);
    }

    if (json.priority != null) {
      assert((json.priority & 0xff) === json.priority);
      this.priority = json.priority;
    }

    if (json.weight != null) {
      assert((json.weight & 0xff) === json.weight);
      this.weight = json.weight;
    }

    if (json.target != null)
      this.target.fromJSON(json.target);

    if (json.port != null) {
      assert((json.port & 0xffff) === json.port);
      this.port = json.port;
    }

    return this;
  }
}

/**
 * Location
 * @extends {Struct}
 */

class Location extends Struct {
  constructor() {
    super();
    this.version = 0;
    this.size = 0;
    this.horizPre = 0;
    this.vertPre = 0;
    this.latitude = 0;
    this.longitude = 0;
    this.altitude = 0;
  }

  compress() {}

  getSize() {
    return 16;
  }

  write(bw) {
    bw.writeU8(this.version);
    bw.writeU8(this.size);
    bw.writeU8(this.horizPre);
    bw.writeU8(this.vertPre);
    bw.writeU32BE(this.latitude);
    bw.writeU32BE(this.longitude);
    bw.writeU32BE(this.altitude);
    return this;
  }

  read(br) {
    this.version = br.readU8();
    this.size = br.readU8();
    this.horizPre = br.readU8();
    this.vertPre = br.readU8();
    this.latitude = br.readU32BE();
    this.longitude = br.readU32BE();
    this.altitude = br.readU32BE();
    return this;
  }

  getJSON() {
    return {
      version: this.version,
      size: this.size,
      horizPre: this.horizPre,
      vertPre: this.vertPre,
      latitude: this.latitude,
      longitude: this.longitude,
      altitude: this.altitude
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');

    if (json.version != null) {
      assert((json.version & 0xff) === json.version);
      this.version = json.version;
    }

    if (json.size != null) {
      assert((json.size & 0xff) === json.size);
      this.size = json.size;
    }

    if (json.horizPre != null) {
      assert((json.horizPre & 0xff) === json.horizPre);
      this.horizPre = json.horizPre;
    }

    if (json.vertPre != null) {
      assert((json.vertPre & 0xff) === json.vertPre);
      this.vertPre = json.vertPre;
    }

    if (json.latitude != null) {
      assert((json.latitude >>> 0) === json.latitude);
      this.latitude = json.latitude;
    }

    if (json.longitude != null) {
      assert((json.longitude >>> 0) === json.longitude);
      this.longitude = json.longitude;
    }

    if (json.altitude != null) {
      assert((json.altitude >>> 0) === json.altitude);
      this.altitude = json.altitude;
    }

    return this;
  }
}

/**
 * Magnet
 * @extends {Struct}
 */

class Magnet extends Struct {
  constructor(nid, nin) {
    super();
    this.nid = nid || 'bt.';
    this.nin = nin || '';
  }

  compress() {}

  getSize() {
    let size = 0;
    size += sizeName(this.nid);
    size += 1 + (this.nin.length >>> 1);
    return size;
  }

  write(bw, c) {
    writeNameBW(bw, this.nid, c.labels);
    bw.writeU8(this.nin.length >>> 1);
    bw.writeString(this.nin, 'hex');
    return this;
  }

  read(br) {
    this.nid = readNameBR(br);

    if (util.countLabels(this.nid) !== 1)
      throw new Error('Invalid label.');

    const size = br.readU8();
    assert(size <= 64);

    this.nin = br.readString(size, 'hex');

    return this;
  }

  toString() {
    const nid = util.trimFQDN(this.nid);
    return `magnet:?xt=urn:${nid.toLowerCase()}:${this.nin}`;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 1024);
    assert(str.length >= 7);

    str = str.toLowerCase();

    assert(str.substring(0, 7) === 'magnet:');

    const index = str.indexOf('xt=urn:');
    assert(index !== -1);
    assert(index !== 0);

    assert(str[index - 1] === '?' || str[index - 1] === '&');

    str = str.substring(index + 7);

    const parts = str.split(/[:&]/);
    assert(parts.length >= 2);

    const [nid, nin] = parts;

    assert(nid.length <= 255);
    assert(nin.length <= 255);

    assert(isSingle(nid));

    this.nid = util.fqdn(nid);
    this.nin = nin;

    return this;
  }

  getJSON() {
    return this.toString();
  }

  fromJSON(json) {
    return this.fromString(json);
  }
}

/**
 * DS
 * @extends {Struct}
 */

class DS extends Struct {
  constructor() {
    super();
    this.keyTag = 0;
    this.algorithm = 0;
    this.digestType = 0;
    this.digest = DUMMY;
  }

  compress() {}

  getSize() {
    return 4 + 1 + this.digest.length;
  }

  write(bw) {
    bw.writeU16BE(this.keyTag);
    bw.writeU8(this.algorithm);
    bw.writeU8(this.digestType);
    bw.writeU8(this.digest.length);
    bw.writeBytes(this.digest);
    return this;
  }

  read(br) {
    this.keyTag = br.readU16BE();
    this.algorithm = br.readU8();
    this.digestType = br.readU8();
    const size = br.readU8();
    assert(size <= 64);
    this.digest = br.readBytes(size);
    return this;
  }

  getJSON() {
    return {
      keyTag: this.keyTag,
      algorithm: this.algorithm,
      digestType: this.digestType,
      digest: this.digest.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert((json.keyTag & 0xffff) === json.keyTag);
    assert((json.algorithm & 0xff) === json.algorithm);
    assert((json.digestType & 0xff) === json.digestType);
    assert(typeof json.digest === 'string');
    assert((json.digest.length >>> 1) <= 255);
    this.keyTag = json.keyTag;
    this.algorithm = json.algorithm;
    this.digestType = json.digestType;
    this.digest = util.parseHex(json.digest);
    return this;
  }
}

/**
 * TLS
 * @extends {Struct}
 */

class TLS extends Struct {
  constructor() {
    super();
    this.protocol = 'icmp.';
    this.port = 0;
    this.usage = 0;
    this.selector = 0;
    this.matchingType = 0;
    this.certificate = DUMMY;
  }

  compress() {}

  getSize() {
    return sizeName(this.protocol) + 6 + this.certificate.length;
  }

  write(bw, c) {
    writeNameBW(bw, this.protocol, c.labels);
    bw.writeU16BE(this.port);
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return this;
  }

  read(br) {
    this.protocol = readNameBR(br);

    if (util.countLabels(this.protocol) !== 1)
      throw new Error('Invalid label.');

    this.port = br.readU16BE();
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());

    return this;
  }

  getJSON() {
    const protocol = util.trimFQDN(this.protocol);
    return {
      protocol: protocol.toLowerCase(),
      port: this.port,
      usage: this.usage,
      selector: this.selector,
      matchingType: this.matchingType,
      certificate: this.certificate.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert(typeof json.protocol === 'string');
    assert(json.protocol.length <= 255);
    assert((json.port & 0xffff) === json.port);
    assert((json.usage & 0xff) === json.usage);
    assert((json.selector & 0xff) === json.selector);
    assert((json.matchingType & 0xff) === json.matchingType);
    assert(typeof json.certificate === 'string');
    assert((json.certificate.length >>> 1) <= 255);
    assert(isSingle(json.protocol));
    this.protocol = util.fqdn(json.protocol);
    this.port = json.port;
    this.usage = json.usage;
    this.selector = json.selector;
    this.matchingType = json.matchingType;
    this.certificate = util.parseHex(json.certificate);
    return this;
  }
}

/**
 * SMIME
 * @extends {Struct}
 */

class SMIME extends Struct {
  constructor() {
    super();
    this.hash = DUMMY;
    this.usage = 0;
    this.selector = 0;
    this.matchingType = 0;
    this.certificate = DUMMY;
  }

  compress() {}

  getSize() {
    return 28 + 4 + this.certificate.length;
  }

  write(bw) {
    bw.writeBytes(this.hash);
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return this;
  }

  read(br) {
    this.hash = br.readBytes(28);
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());
    return this;
  }

  getJSON() {
    return {
      hash: this.hash.toString('hex'),
      usage: this.usage,
      selector: this.selector,
      matchingType: this.matchingType,
      certificate: this.certificate.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert(typeof json.hash === 'string');
    assert(json.hash.length === 56);
    assert((json.usage & 0xff) === json.usage);
    assert((json.selector & 0xff) === json.selector);
    assert((json.matchingType & 0xff) === json.matchingType);
    assert(typeof json.fingerprint === 'string');
    assert((json.fingerprint.length >>> 1) <= 255);
    this.hash = util.parseHex(json.hash);
    this.port = json.port;
    this.usage = json.usage;
    this.selector = json.selector;
    this.matchingType = json.matchingType;
    this.certificate = util.parseHex(json.certificate);
    return this;
  }
}

/**
 * SSH
 * @extends {Struct}
 */

class SSH extends Struct {
  constructor() {
    super();
    this.algorithm = 0;
    this.keyType = 0;
    this.fingerprint = DUMMY;
  }

  compress() {}

  getSize() {
    return 2 + 1 + this.fingerprint.length;
  }

  write(bw) {
    bw.writeU8(this.algorithm);
    bw.writeU8(this.keyType);
    bw.writeU8(this.fingerprint.length);
    bw.writeBytes(this.fingerprint);
    return this;
  }

  read(br) {
    this.algorithm = br.readU8();
    this.keyType = br.readU8();
    const size = br.readU8();
    assert(size <= 64);
    this.fingerprint = br.readBytes(size);
    return this;
  }

  getJSON() {
    return {
      algorithm: this.algorithm,
      keyType: this.keyType,
      fingerprint: this.fingerprint.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert((json.algorithm & 0xff) === json.algorithm);
    assert((json.keyType & 0xff) === json.keyType);
    assert(typeof json.fingerprint === 'string');
    assert((json.fingerprint >>> 1) <= 255);
    this.algorithm = json.algorithm;
    this.keyType = json.keyType;
    this.fingerprint = util.parseHex(json.fingerprint);
    return this;
  }
}

/**
 * PGP
 * @extends {Struct}
 */

class PGP extends Struct {
  constructor() {
    super();
    this.hash = DUMMY;
    this.publicKey = DUMMY;
  }

  compress() {}

  getSize() {
    return 28 + 2 + this.publicKey.length;
  }

  write(bw) {
    bw.writeBytes(this.hash);
    bw.writeU16BE(this.publicKey.length);
    bw.writeBytes(this.publicKey);
    return this;
  }

  read(br) {
    this.hash = br.readBytes(28);
    const size = br.readU16BE();
    assert(size <= 512);
    this.publicKey = br.readBytes(size);
    return this;
  }

  getJSON() {
    return {
      hash: this.hash.toString('hex'),
      publicKey: this.publicKey.toString('hex')
    };
  }

  fromJSON(json) {
    assert(typeof json === 'object');
    assert(typeof json.hash === 'string');
    assert((json.hash.length >>> 1) === 28);
    this.hash = util.parseHex(json.hash);
    this.publicKey = util.parseHex(json.publicKey);
    return this;
  }
}

/**
 * Addr
 * @extends {Struct}
 */

class Addr extends Struct {
  constructor(currency, address) {
    super();
    this.currency = currency || 'bitcoin.';
    this.address = address || '';
  }

  compress() {}

  getSize() {
    if (util.equal(this.currency, 'handshake.')) {
      const {hash} = bech32.decode(this.address);
      return 1 + 2 + hash.length;
    }

    if (util.equal(this.currency, 'bitcoin.') && bech32.test(this.address)) {
      const {hash} = bech32.decode(this.address);
      return 1 + 2 + hash.length;
    }

    if (util.equal(this.currency, 'ethereum.'))
      return 1 + 20;

    return 1 + sizeName(this.currency) + 1 + this.address.length;
  }

  write(bw, c) {
    if (util.equal(this.currency, 'handshake.')) {
      const {hrp, version, hash} = bech32.decode(this.address);

      assert(hash.length >= 1);
      assert(hash.length <= 128);

      const test = hrp === 'ts' ? 0x80 : 0x00;
      const size = hash.length - 1;
      const field = test | size;

      bw.writeU8(1);
      bw.writeU8(field);
      bw.writeU8(version);
      bw.writeBytes(hash);

      return this;
    }

    if (util.equal(this.currency, 'bitcoin.') && bech32.test(this.address)) {
      const {hrp, version, hash} = bech32.decode(this.address);

      assert(hash.length >= 1);
      assert(hash.length <= 128);

      const test = hrp === 'tb' ? 0x80 : 0x00;
      const size = hash.length - 1;
      const field = test | size;

      bw.writeU8(2);
      bw.writeU8(field);
      bw.writeU8(version);
      bw.writeBytes(hash);

      return this;
    }

    if (util.equal(this.currency, 'ethereum.')) {
      bw.writeU8(3);
      bw.writeString(this.address.substring(2), 'hex');
      return this;
    }

    bw.writeU8(0);
    writeNameBW(bw, this.currency, c.labels);
    bw.writeU8(this.address.length);
    bw.writeString(this.address, 'ascii');

    return this;
  }

  read(br) {
    const type = br.readU8();

    if (type === 1) {
      const field = br.readU8();
      const test = (field & 0x80) !== 0;
      const size = (field & 0x7f) + 1;

      const hrp = test ? 'ts' : 'hs';
      const version = br.readU8();
      const hash = br.readBytes(size);

      this.currency = 'handshake.';
      this.address = bech32.encode(hrp, version, hash);

      return this;
    }

    if (type === 2) {
      const field = br.readU8();
      const test = (field & 0x80) !== 0;
      const size = (field & 0x7f) + 1;

      const hrp = test ? 'tb' : 'bc';
      const version = br.readU8();
      const hash = br.readBytes(size);

      this.currency = 'bitcoin.';
      this.address = bech32.encode(hrp, version, hash);

      return this;
    }

    if (type === 3) {
      this.currency = 'ethereum.';
      this.address = '0x' + br.readString(20, 'hex');
      return this;
    }

    this.currency = readNameBR(br);
    this.address = readAscii(br, br.readU8());

    return this;
  }

  toAddress(Address, network) {
    assert(util.equal(this.currency, 'handshake.'));
    return Address.fromString(this.address, network);
  }

  fromAddress(addr, network) {
    assert(addr && typeof addr === 'object');
    this.currency = 'handshake.';
    this.address = addr.toString(network);
    return this;
  }

  static fromAddress(addr, network) {
    return new this().fromAddress(addr, network);
  }

  toString() {
    const currency = util.trimFQDN(this.currency);
    return `${currency.toLowerCase()}:${this.address}`;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 512);

    const parts = str.split(':');
    assert(parts.length === 2);

    const [currency, address] = parts;

    assert(currency.length <= 255);
    assert(address.length <= 255);
    assert(isSingle(currency));

    this.currency = util.fqdn(currency);
    this.address = address;

    return this;
  }

  static fromString(str) {
    return new this().fromString(str);
  }

  getJSON() {
    return this.toString();
  }

  fromJSON(json) {
    return this.fromString(json);
  }
}

/**
 * Extra
 * @extends {Struct}
 */

class Extra extends Struct {
  constructor() {
    super();
    this.type = 0;
    this.data = DUMMY;
  }

  compress() {}

  getSize() {
    return 3 + this.data.length;
  }

  write(bw) {
    bw.writeU8(this.type);
    bw.writeU16BE(this.data.length);
    bw.writeBytes(this.data);
    return this;
  }

  read(br) {
    this.type = br.readU8();
    this.data = br.readBytes(br.readU16BE());
    return this;
  }

  getJSON() {
    return {
      type: this.type,
      data: this.data.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert((json.type & 0xff) === json.type);
    assert(typeof json.data === 'string');
    assert((json.data >>> 1) <= 255);
    this.type = json.type;
    this.data = util.parseHex(json.data);
    return this;
  }
}

/*
 * Helpers
 */

function sizeTarget(type, target) {
  let size = 0;

  switch (type) {
    case types.INET4:
      size += 4;
      break;
    case types.INET6:
      size += ipSize(IP.toBuffer(target));
      break;
    case types.ONION:
      size += 10;
      break;
    case types.ONIONNG:
      size += 33;
      break;
    case types.NAME: {
      size += sizeName(target);
      break;
    }
  }

  return size;
}

function writeTarget(type, target, bw, c) {
  switch (type) {
    case types.INET4: {
      const ip = IP.toBuffer(target);
      assert(IP.isIPv4(ip));
      bw.copy(ip, 12, 16);
      break;
    }
    case types.INET6: {
      const ip = IP.toBuffer(target);
      assert(!IP.isIPv4(ip));
      ipWrite(bw, ip);
      break;
    }
    case types.ONION: {
      const on = onion.decodeLegacy(target);
      bw.writeBytes(on);
      break;
    }
    case types.ONIONNG: {
      const key = onion.decodeNG(target, sha3.digest);
      bw.writeBytes(key);
      break;
    }
    case types.NAME: {
      writeNameBW(bw, target, c.labels);
      break;
    }
    default: {
      throw new Error('Unknown target type.');
    }
  }
}

function readTarget(type, br) {
  switch (type) {
    case types.INET4:
      return IP.toString(br.readBytes(4));
    case types.INET6:
      return IP.toString(ipRead(br));
    case types.ONION:
      return onion.encodeLegacy(br.readBytes(10));
    case types.ONIONNG:
      return onion.encodeNG(br.readBytes(33), sha3.digest);
    case types.NAME: {
      return readNameBR(br);
    }
    default:
      throw new Error('Unknown target type.');
  }
}

function parseIP(str) {
  const ip = IP.toBuffer(str);

  if (IP.isIPv4(ip))
    return [types.INET4, IP.toString(ip)];

  if (IP.isIPv6(ip))
    return [types.INET6, IP.toString(ip)];

  if (IP.isOnion(ip))
    return [types.ONION, IP.toString(ip)];

  throw new Error('Invalid IP.');
}

function isSingle(label) {
  label = util.fqdn(label);

  if (!isName(label))
    return false;

  if (util.countLabels(label) !== 1)
    return false;

  return true;
}

/*
 * Expose
 */

records.types = types;

records.Target = Target;
records.Service = Service;
records.Location = Location;
records.Magnet = Magnet;
records.DS = DS;
records.TLS = TLS;
records.SMIME = SMIME;
records.SSH = SSH;
records.PGP = PGP;
records.Addr = Addr;
records.Extra = Extra;

records.sizeTarget = sizeTarget;
records.writeTarget = writeTarget;
records.readTarget = readTarget;
