/*!
 * records.js - hsk records for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const {wire, util} = require('bns');
const {IP, onion, base32} = require('binet');
const {bech32} = require('bstring');
const {Struct} = require('bufio');
const sha3 = require('bcrypto/lib/sha3');
const compress = require('./compress');
const records = exports;

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
  ONION: 3, // TXT (appended to A/AAA responses)
  ONIONNG: 4, // TXT (appended to A/AAA responses)
  NAME: 5, // CNAME
  GLUE: 6,
  CANONICAL: 7, // CNAME
  DELEGATE: 8, // DNAME
  NS: 9, // NS
  SERVICE: 10, // SRV
  URL: 11, // URI
  EMAIL: 12, // RP
  TEXT: 13, // TXT
  LOCATION: 14, // LOC
  MAGNET: 15, // TXT
  DS: 16, // DS
  TLS: 17, // TLSA
  SSH: 18, // SSHFP
  PGP: 19, // OPENPGPKEY
  ADDR: 20 // TXT
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

      return `${this.target}.@${ips.join(',')}`;
    }

    if (this.isName())
      return `${this.target}.`;

    return this.target;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 255);

    str = str.toLowerCase();

    const parts = str.split('@');

    if (parts.length > 1) {
      const name = util.trimFQDN(parts[0]);
      assert(verifyName(name));

      const ips = parts[1].split(',');
      assert(ips.length <= 2);

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

    const name = util.trimFQDN(str);
    assert(verifyName(name));

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

    return `_${hash}.${name}`;
  }

  fromPointer(name) {
    assert(typeof name === 'string');
    assert(name.length > 0 && name[0] === '_');

    const data = base32.decodeHex(name.substring(1));
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

    if (name.length === 0)
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
    if (this.isName()) {
      assert(!util.isFQDN(this.target));
      return `${this.target}.`;
    }

    return this.target;
  }

  compress(c) {
    if (this.type === types.GLUE)
      compressTarget(types.NAME, this.target, c);
    else
      compressTarget(this.type, this.target, c);
  }

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

  read(br, d) {
    this.type = br.readU8();
    if (this.type === types.GLUE) {
      this.target = readTarget(types.NAME, br, d);
      this.inet4 = readTarget(types.INET4, br, d);
      this.inet6 = readTarget(types.INET6, br, d);
      if (this.inet4 === '0.0.0.0' && this.inet6 === '::')
        throw new Error('Bad glue address.');
    } else {
      this.target = readTarget(this.type, br, d);
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
    this.service = '';
    this.protocol = '';
    this.priority = 0;
    this.weight = 0;
    this.target = new Target();
    this.port = 0;
  }

  isSMTP() {
    return this.service === 'smtp' && this.protocol === 'tcp';
  }

  compress(c) {
    c.addString(this.service);
    c.addString(this.protocol);
  }

  getSize(c) {
    let size = 0;
    size += c.size(this.service);
    size += c.size(this.protocol);
    size += 1;
    size += 1;
    size += this.target.getSize(c);
    size += 2;
    return size;
  }

  write(bw, c) {
    c.writeString(bw, this.service);
    c.writeString(bw, this.protocol);
    bw.writeU8(this.priority);
    bw.writeU8(this.weight);
    this.target.write(bw, c);
    bw.writeU16(this.port);
    return this;
  }

  read(br, d) {
    this.service = d.readString(br);
    this.protocol = d.readString(br);
    this.priority = br.readU8();
    this.weight = br.readU8();
    this.target.read(br, d);
    this.port = br.readU16();
    return this;
  }

  getJSON() {
    return {
      service: this.service,
      protocol: this.protocol,
      priority: this.priority,
      weight: this.weight,
      target: this.target.toJSON(),
      port: this.port
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');

    if (json.service != null) {
      assert(typeof json.service === 'string');
      this.service = json.service;
    }

    if (json.protocol != null) {
      assert(typeof json.protocol === 'string');
      this.protocol = json.protocol;
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
    bw.writeU32(this.latitude);
    bw.writeU32(this.longitude);
    bw.writeU32(this.altitude);
    return this;
  }

  read(br) {
    this.version = br.readU8();
    this.size = br.readU8();
    this.horizPre = br.readU8();
    this.vertPre = br.readU8();
    this.latitude = br.readU32();
    this.longitude = br.readU32();
    this.altitude = br.readU32();
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
    this.nid = nid || '';
    this.nin = nin || '';
  }

  compress(c) {
    c.addString(this.nid);
  }

  getSize(c) {
    let size = 0;
    size += c.size(this.nid);
    size += 1 + (this.nin.length >>> 1);
    return size;
  }

  write(bw, c) {
    c.writeString(bw, this.nid);
    bw.writeU8(this.nin.length >>> 1);
    bw.writeString(this.nin, 'hex');
    return this;
  }

  read(br, d) {
    this.nid = d.readString(br);
    this.nin = br.readString('hex', br.readU8());
    return this;
  }

  toString() {
    return `magnet:?xt=urn:${this.nid}:${this.nin}`;
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

    this.nid = nid;
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
    bw.writeU16(this.keyTag);
    bw.writeU8(this.algorithm);
    bw.writeU8(this.digestType);
    bw.writeU8(this.digest.length);
    bw.writeBytes(this.digest);
    return this;
  }

  read(br) {
    this.keyTag = br.readU16();
    this.algorithm = br.readU8();
    this.digestType = br.readU8();
    this.digest = br.readBytes(br.readU8());
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
    this.digest = Buffer.from(json.digest, 'hex');
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
    this.protocol = '';
    this.port = 0;
    this.usage = 0;
    this.selector = 0;
    this.matchingType = 0;
    this.certificate = DUMMY;
  }

  compress(c) {
    c.addString(this.protocol);
  }

  getSize(c) {
    return c.size(this.protocol) + 6 + this.certificate.length;
  }

  write(bw, c) {
    c.writeString(bw, this.protocol);
    bw.writeU16(this.port);
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return this;
  }

  read(br, d) {
    this.protocol = d.readString(br);
    this.port = br.readU16();
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());
    return this;
  }

  getJSON() {
    return {
      protocol: this.protocol,
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
    assert(typeof json.fingerprint === 'string');
    assert((json.fingerprint.length >>> 1) <= 255);
    this.protocol = json.protocol;
    this.port = json.port;
    this.usage = json.usage;
    this.selector = json.selector;
    this.matchingType = json.matchingType;
    this.certificate = Buffer.from(json.certificate, 'hex');
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
    this.fingerprint = br.readBytes(br.readU8());
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
    this.fingerprint = Buffer.from(json.fingerprint, 'hex');
    return this;
  }
}

/**
 * PGP
 * @extends {Struct}
 */

class PGP extends SSH {
  constructor() {
    super();
  }
}

/**
 * Addr
 * @extends {Struct}
 */

class Addr extends Struct {
  constructor(currency, address) {
    super();
    this.currency = currency || '';
    this.address = address || '';
  }

  compress(c) {
    if (this.currency === 'hsk')
      return;

    if (this.currency === 'btc' && bech32.test(this.address))
      return;

    if (this.currency === 'eth')
      return;

    c.addString(this.currency);
  }

  getSize(c) {
    if (this.currency === 'hsk') {
      const {hash} = bech32.decode(this.address);
      return 1 + 2 + hash.length;
    }

    if (this.currency === 'btc' && bech32.test(this.address)) {
      const {hash} = bech32.decode(this.address);
      return 1 + 2 + hash.length;
    }

    if (this.currency === 'eth')
      return 1 + 20;

    return 1 + c.size(this.currency) + 1 + this.address.length;
  }

  write(bw, c) {
    if (this.currency === 'hsk') {
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

    if (this.currency === 'btc' && bech32.test(this.address)) {
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

    if (this.currency === 'eth') {
      bw.writeU8(3);
      bw.writeString(this.address, 'hex');
      return this;
    }

    bw.writeU8(0);
    c.writeString(bw, this.currency);
    bw.writeU8(this.address.length);
    bw.writeString(this.address, 'ascii');

    return this;
  }

  read(br, d) {
    const type = br.readU8();

    if (type === 1) {
      const field = br.readU8();
      const test = (field & 0x80) !== 0;
      const size = (field & 0x7f) + 1;

      const hrp = test ? 'ts' : 'hs';
      const version = br.readU8();
      const hash = br.readBytes(size);

      this.currency = 'hsk';
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

      this.currency = 'btc';
      this.address = bech32.encode(hrp, version, hash);

      return this;
    }

    if (type === 3) {
      this.currency = 'eth';
      this.address = br.readString('hex', 20);
      return this;
    }

    if (type !== 0)
      return this;

    this.currency = d.readString(br);
    this.address = readAscii(br, br.readU8());

    return this;
  }

  toAddress(Address, network) {
    assert(this.currency === 'hsk');
    return Address.fromString(this.address, network);
  }

  fromAddress(addr, network) {
    assert(addr && typeof addr === 'object');
    this.currency = 'hsk';
    this.address = addr.toString(network);
    return this;
  }

  static fromAddress(addr, network) {
    return new this().fromAddress(addr, network);
  }

  toString() {
    return `${this.currency}:${this.address}`;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 512);

    const parts = str.split(':');
    assert(parts.length === 2);

    const [currency, address] = parts;

    assert(currency.length <= 255);
    assert(address.length <= 255);

    this.currency = currency;
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

  getSize(c) {
    return 2 + this.data.length;
  }

  write(bw, c) {
    bw.writeU8(this.type);
    bw.writeU8(this.data.length);
    bw.writeBytes(this.data);
    return this;
  }

  read(br, d) {
    this.type = br.readU8();
    this.data = br.readBytes(br.readU8());
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
    this.data = Buffer.from(json.data, 'hex');
    return this;
  }
}

/*
 * Helpers
 */

function compressTarget(type, target, c) {
  switch (type) {
    case types.NAME: {
      c.addString(target);
      break;
    }
  }
}

function sizeTarget(type, target, c) {
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
      size += c.size(target);
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
      c.writeString(bw, target);
      break;
    }
    default: {
      throw new Error('Unknown target type.');
    }
  }
}

function readTarget(type, br, d) {
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
      const name = d.readString(br);
      assert(verifyName(name));
      return name;
    }
    default:
      throw new Error('Unknown target type.');
  }
}

function verifyName(name) {
  if (name.length === 0)
    return false;

  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);

    // 0 - 9
    if (ch >= 0x30 && ch <= 0x39)
      continue;

    // a - z
    if (ch >= 0x61 && ch <= 0x7a)
      continue;

    // .
    if (ch === 0x2e) {
      if (i > 0 && name.charCodeAt(i - 1) === 0x2e)
        return false; // Double dot.

      if (i === name.length - 1)
        return false; // Unexpected FQDN.

      continue;
    }

    // - and _
    if (ch === 0x2d || ch === 0x5f) {
      if (i === 0 || i === name.length - 1)
        return false; // Bad dash.

      if (name.charCodeAt(i - 1) === 0x2e)
        return false; // Bad dash.

      continue;
    }

    return false; // Unexpected character.
  }

  return true;
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
records.SSH = SSH;
records.PGP = PGP;
records.Addr = Addr;
records.Extra = Extra;

records.compressTarget = compressTarget;
records.sizeTarget = sizeTarget;
records.writeTarget = writeTarget;
records.readTarget = readTarget;
