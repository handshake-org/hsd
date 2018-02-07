'use strict';

const assert = require('assert');
const bns = require('bns');
const {IP, onion, base32} = require('binet');
const {bech32} = require('bstring');
const compress = require('./compress');

const {
  wire,
  util
} = bns;

const {
  Message,
  Record,
  RecordData,
  ARecord,
  AAAARecord,
  NSRecord,
  MXRecord,
  SOARecord,
  CNAMERecord,
  DNAMERecord,
  SRVRecord,
  TXTRecord,
  LOCRecord,
  DSRecord,
  TLSARecord,
  SSHFPRecord,
  OPENPGPKEYRecord,
  types
} = wire;

const {
  Compressor,
  Decompressor,
  ipSize,
  ipWrite,
  ipRead,
  ipPack,
  readAscii
} = compress;

/*
 * Constants
 */

const DUMMY = Buffer.alloc(0);

const ICANN = 'i';
const HSK = 'h';
const ICANNP = `.${ICANN}`;
const ICANNS = `${ICANN}.`;
const HSKP = `.${HSK}`;
const HSKS = `${HSK}.`;

const rtypes = {
  INET4: 1, // A
  INET6: 2, // AAAA
  ONION: 3, // TXT (appended to A/AAA responses)
  ONIONNG: 5, // TXT (appended to A/AAA responses)
  INAME: 6, // N/A
  HNAME: 7, // N/A

  CANONICAL: 8, // CNAME
  DELEGATE: 9, // DNAME
  NS: 10, // NS
  SERVICE: 11, // SRV
  URL: 12, // TXT
  EMAIL: 13, // TXT
  TEXT: 14, // TXT
  LOCATION: 15, // LOC
  MAGNET: 16, // TXT
  DS: 17, // DS
  TLS: 18, // TLSA
  SSH: 19, // SSHFP
  PGP: 20, // OPENPGPKEY (XXX)
  ADDR: 21 // TXT
};

class Extra extends RecordData {
  constructor() {
    super();
    this.type = 0;
    this.data = DUMMY;
  }

  compress() {
  }

  getSize(c) {
    return 2 + this.data.length;
  }

  toWriter(bw, c) {
    bw.writeU8(this.type);
    bw.writeU8(this.data.length);
    bw.writeBytes(this.data);
    return bw;
  }

  fromReader(br, d) {
    this.type = br.readU8();
    this.data = br.readBytes(br.readU8());
    return this;
  }

  toJSON() {
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

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class Addr extends RecordData {
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

    c.add(this.currency);
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

  toWriter(bw, c) {
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

      return bw;
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

      return bw;
    }

    if (this.currency === 'eth') {
      bw.writeU8(3);
      bw.writeString(this.address, 'hex');
      return bw;
    }

    bw.writeU8(0);
    c.write(bw, this.currency);
    bw.writeU8(this.address.length);
    bw.writeString(this.address, 'ascii');

    return bw;
  }

  fromReader(br, d) {
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

    this.currency = d.read(br);
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

  toJSON() {
    return this.toString();
  }

  fromJSON(json) {
    return this.fromString(json);
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class SSH extends RecordData {
  constructor() {
    super();
    this.algorithm = 0;
    this.type = 0;
    this.fingerprint = DUMMY;
  }

  compress() {
  }

  getSize() {
    return 2 + 1 + this.fingerprint.length;
  }

  toWriter(bw) {
    bw.writeU8(this.algorithm);
    bw.writeU8(this.type);
    bw.writeU8(this.fingerprint.length);
    bw.writeBytes(this.fingerprint);
    return bw;
  }

  fromReader(br) {
    this.algorithm = br.readU8();
    this.type = br.readU8();
    this.fingerprint = br.readBytes(br.readU8());
    return this;
  }

  toJSON() {
    return {
      algorithm: this.algorithm,
      type: this.type,
      fingerprint: this.fingerprint.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert((json.algorithm & 0xff) === json.algorithm);
    assert((json.type & 0xff) === json.type);
    assert(typeof json.fingerprint === 'string');
    assert((json.fingerprint >>> 1) <= 255);
    this.algorithm = json.algorithm;
    this.type = json.type;
    this.fingerprint = Buffer.from(json.fingerprint, 'hex');
    return this;
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class PGP extends SSH {
  constructor() {
    super();
  }
}

class TLS extends RecordData {
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
    c.add(this.protocol);
  }

  getSize(c) {
    return c.size(this.protocol) + 6 + this.certificate.length;
  }

  toWriter(bw, c) {
    c.write(bw, this.protocol);
    bw.writeU16(this.port);
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return bw;
  }

  fromReader(br, d) {
    this.protocol = d.read(br);
    this.port = br.readU16();
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());
    return this;
  }

  toJSON() {
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

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class DS extends RecordData {
  constructor() {
    super();
    this.keyTag = 0;
    this.algorithm = 0;
    this.digestType = 0;
    this.digest = DUMMY;
  }

  compress() {
  }

  getSize() {
    return 4 + 1 + this.digest.length;
  }

  toWriter(bw) {
    bw.writeU16(this.keyTag);
    bw.writeU8(this.algorithm);
    bw.writeU8(this.digestType);
    bw.writeU8(this.digest.length);
    bw.writeBytes(this.digest);
    return bw;
  }

  fromReader(br) {
    this.keyTag = br.readU16BE();
    this.algorithm = br.readU8();
    this.digestType = br.readU8();
    this.digest = br.readBytes(br.readU8());
    return this;
  }

  toJSON() {
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

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class Magnet extends RecordData {
  constructor(nid, nin) {
    super();
    this.nid = nid || '';
    this.nin = nin || '';
  }

  compress(c) {
    c.add(this.nid);
  }

  getSize(c) {
    let size = 0;
    size += c.size(this.nid);
    size += 1 + (this.nin.length >>> 1);
    return size;
  }

  toWriter(bw, c) {
    c.write(bw, this.nid);
    bw.writeU8(this.nin.length >>> 1);
    bw.writeString(this.nin, 'hex');
    return bw;
  }

  fromReader(br, d) {
    this.nid = d.read(br);
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

  static fromString(str) {
    return new this().fromString(str);
  }

  toJSON() {
    return this.toString();
  }

  fromJSON(json) {
    return this.fromString(json);
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class Service extends RecordData {
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
    c.add(this.service);
    c.add(this.protocol);
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

  toWriter(bw, c) {
    c.write(bw, this.service);
    c.write(bw, this.protocol);
    bw.writeU8(this.priority);
    bw.writeU8(this.weight);
    this.target.toWriter(bw, c);
    bw.writeU16(this.port);
    return bw;
  }

  fromReader(br, d) {
    this.service = d.read(br);
    this.protocol = d.read(br);
    this.priority = br.readU8();
    this.weight = br.readU8();
    this.target.fromReader(br, d);
    this.port = br.readU16();
    return this;
  }

  toJSON() {
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

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

class Location extends RecordData {
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

  compress() {
  }

  getSize() {
    return 16;
  }

  toWriter(bw) {
    bw.writeU8(this.version);
    bw.writeU8(this.size);
    bw.writeU8(this.horizPre);
    bw.writeU8(this.vertPre);
    bw.writeU32(this.latitude);
    bw.writeU32(this.longitude);
    bw.writeU32(this.altitude);
    return bw;
  }

  fromReader(br) {
    this.version = br.readU8();
    this.size = br.readU8();
    this.horizPre = br.readU8();
    this.vertPre = br.readU8();
    this.latitude = br.readU32();
    this.longitude = br.readU32();
    this.altitude = br.readU32();
    return this;
  }

  toJSON() {
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

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

function compressTarget(type, target, c) {
  switch (type) {
    case rtypes.INAME:
    case rtypes.HNAME: {
      c.add(target);
      break;
    }
  }
}

function sizeTarget(type, target, c) {
  let size = 0;

  switch (type) {
    case rtypes.INET4:
      size += 4;
      break;
    case rtypes.INET6:
      size += ipSize(IP.toBuffer(target));
      break;
    case rtypes.ONION:
      size += 10;
      break;
    case rtypes.ONIONNG:
      size += 33;
      break;
    case rtypes.INAME:
    case rtypes.HNAME: {
      size += c.size(target);
      break;
    }
  }

  return size;
}

function writeTarget(type, target, bw, c) {
  switch (type) {
    case rtypes.INET4: {
      const ip = IP.toBuffer(target);
      assert(IP.isIPv4(ip));
      bw.copy(ip, 12, 16);
      break;
    }
    case rtypes.INET6: {
      const ip = IP.toBuffer(target);
      assert(!IP.isIPv4(ip));
      ipWrite(bw, ip);
      break;
    }
    case rtypes.ONION: {
      const on = onion.decodeLegacy(target);
      bw.writeBytes(on);
      break;
    }
    case rtypes.ONIONNG: {
      const key = onion.decodeNG(target, null);
      bw.writeBytes(key);
      break;
    }
    case rtypes.INAME:
    case rtypes.HNAME: {
      c.write(bw, target);
      break;
    }
    default: {
      throw new Error('Unknown target type.');
    }
  }
  return bw;
}

function readTarget(type, br, d) {
  switch (type) {
    case rtypes.INET4:
      return IP.toString(br.readBytes(4));
    case rtypes.INET6:
      return IP.toString(ipRead(br));
    case rtypes.ONION:
      return onion.encodeLegacy(br.readBytes(10));
    case rtypes.ONIONNG:
      return onion.encodeNG(br.readBytes(33), null);
    case rtypes.INAME: {
      const name = d.read(br);
      assert(verifyICANN(name));
      return name;
    }
    case rtypes.HNAME: {
      const name = d.read(br);
      assert(verifyHSK(name));
      return name;
    }
    default:
      throw new Error('Unknown target type.');
  }
}

function verifyICANN(name) {
  return verifyName(name, false);
}

function verifyHSK(name) {
  return verifyName(name, true);
}

function verifyName(name, hsk) {
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
    if (ch === 0x2d || (hsk && ch === 0x5f)) {
      if (i === 0 || i === name.length - 1)
        return false; // Bad dash.

      if (name.charCodeAt(i - 1) === 0x2e)
        return false; // Bad dash.

      continue;
    }

    return false; // Unexpected character.
  }

  if (util.endsWith(name, HSKP))
    return false;

  if (util.endsWith(name, ICANNP))
    return false;

  return true;
}

class Target extends RecordData {
  constructor(type, target) {
    super();
    this.type = rtypes.INET4;
    this.target = '0.0.0.0';
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

  compress(c) {
    compressTarget(this.type, this.target, c);
  }

  toString() {
    if (this.isHSK())
      return `${this.target}.${HSK}`;
    if (this.isICANN())
      return `${this.target}.${ICANN}`;
    return this.target;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 255);

    str = str.toLowerCase();

    if (IP.isIPv4String(str)
        || IP.isIPv6String(str)) {
      const ip = IP.toBuffer(str);

      if (IP.isIPv4(ip)) {
        this.type = rtypes.INET4;
        this.target = IP.toString(ip);
      } else if (IP.isIPv6(ip)) {
        this.type = rtypes.INET6;
        this.target = IP.toString(ip);
      } else if (IP.isOnion(ip)) {
        this.type = rtypes.ONION;
        this.target = IP.toString(ip);
      } else {
        throw new Error('Invalid IP.');
      }

      return this;
    }

    if (onion.isLegacyString(str)) {
      this.type = rtypes.ONION;
      this.target = onion.normalizeLegacy(str);
      return this;
    }

    if (onion.isNGString(str)) {
      this.type = rtypes.ONIONNG;
      this.target = onion.normalizeNG(str, null);
      return this;
    }

    let name = util.trimFQDN(str);

    if (util.endsWith(name, HSKP)) {
      name = name.slice(0, -HSKP.length);
      assert(verifyHSK(name));
      this.type = rtypes.HNAME;
      this.target = name;
    } else if (util.endsWith(name, ICANNP)) {
      name = name.slice(0, -ICANNP.length);
      assert(verifyICANN(name));
      this.type = rtypes.INAME;
      this.target = name;
    } else {
      assert(verifyICANN(name));
      this.type = rtypes.INAME;
      this.target = name;
    }

    return this;
  }

  static fromString(str) {
    return new this().fromString(str);
  }

  toJSON() {
    return this.toString();
  }

  fromJSON(json) {
    return this.fromString(json);
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  isNull() {
    return this.type === rtypes.INET4 && this.target === '0.0.0.0';
  }

  toPointer(name) {
    assert(this.isINET());

    const ip = IP.toBuffer(this.target);
    const data = ipPack(ip);
    const hash = base32.encodeHex(data);

    if (name) {
      assert(util.isFQDN(name));
      return `_${hash}.${name}`;
    }

    return `_${hash}.${HSK}`;
  }

  isINET4() {
    return this.type === rtypes.INET4;
  }

  isINET6() {
    return this.type === rtypes.INET6;
  }

  isOnion() {
    return this.type === rtypes.ONION;
  }

  isOnionNG() {
    return this.type === rtypes.ONIONNG;
  }

  isHSK() {
    return this.type === rtypes.HNAME;
  }

  isICANN() {
    return this.type === rtypes.INAME;
  }

  isINET() {
    return this.type <= rtypes.INET6;
  }

  isName() {
    return this.type > rtypes.ONIONNG;
  }

  isTor() {
    return this.isOnion() || this.isOnionNG();
  }

  toDNS() {
    if (this.isHSK()) {
      assert(!util.isFQDN(this.target));
      return `${this.target}.${HSK}.`;
    }

    if (this.isICANN()) {
      assert(!util.isFQDN(this.target));
      return `${this.target}.`;
    }

    return this.target;
  }

  getSize(c) {
    return 1 + sizeTarget(this.type, this.target, c);
  }

  toWriter(bw, c) {
    bw.writeU8(this.type);
    writeTarget(this.type, this.target, bw, c);
    return bw;
  }

  fromReader(br, d) {
    this.type = br.readU8();
    this.target = readTarget(this.type, br, d);
    return this;
  }

  inspect() {
    return `<Target: ${this.toString()}>`;
  }
}

class HSKRecord extends RecordData {
  constructor() {
    super();
    this.version = 0;
    this.ttl = 0;
    this.compat = false;
    this.hosts = [];
    this.canonical = null;
    this.delegate = null;
    this.ns = [];
    this.service = [];
    this.url = [];
    this.email = [];
    this.text = [];
    this.location = [];
    this.magnet = [];
    this.ds = [];
    this.tls = [];
    this.ssh = [];
    this.pgp = [];
    this.addr = [];
    this.extra = [];
  }

  compress() {
    const c = new Compressor();

    for (const host of this.hosts)
      host.compress(c);

    if (this.canonical)
      this.canonical.compress(c);

    if (this.delegate)
      this.delegate.compress(c);

    for (const ns of this.ns)
      ns.compress(c);

    for (const srv of this.service)
      srv.compress(c);

    for (const url of this.url)
      c.add(url);

    for (const email of this.email)
      c.add(email);

    for (const text of this.text)
      c.add(text);

    for (const loc of this.location)
      loc.compress(c);

    for (const urn of this.magnet)
      urn.compress(c);

    for (const ds of this.ds)
      ds.compress(c);

    for (const tls of this.tls)
      tls.compress(c);

    for (const ssh of this.ssh)
      ssh.compress(c);

    for (const pgp of this.pgp)
      pgp.compress(c);

    for (const addr of this.addr)
      addr.compress(c);

    for (const extra of this.extra)
      extra.compress(c);

    return c;
  }

  toRaw() {
    const c = this.compress();
    return super.toRaw(c);
  }

  getSize(c) {
    let size = 1 + 2;

    size += c.getSize();

    for (const host of this.hosts)
      size += host.getSize(c);

    if (this.canonical)
      size += 1 + this.canonical.getSize(c);

    if (this.delegate)
      size += 1 + this.delegate.getSize(c);

    for (const ns of this.ns)
      size += 1 + ns.getSize(c);

    for (const srv of this.service)
      size += 1 + srv.getSize(c);

    for (const url of this.url)
      size += 1 + c.size(url);

    for (const email of this.email)
      size += 1 + c.size(email);

    for (const text of this.text)
      size += 1 + c.size(text);

    for (const loc of this.location)
      size += 1 + loc.getSize(c);

    for (const urn of this.magnet)
      size += 1 + urn.getSize(c);

    for (const ds of this.ds)
      size += 1 + ds.getSize(c);

    for (const tls of this.tls)
      size += 1 + tls.getSize(c);

    for (const ssh of this.ssh)
      size += 1 + ssh.getSize(c);

    for (const pgp of this.pgp)
      size += 1 + pgp.getSize(c);

    for (const addr of this.addr)
      size += 1 + addr.getSize(c);

    for (const extra of this.extra)
      size += 1 + extra.getSize(c);

    return size;
  }

  toWriter(bw, c) {
    // Serialization version.
    bw.writeU8(this.version);

    // TTL has a granularity of 6
    // (about 1 minute per unit).
    const cmp = this.compat ? 0x8000 : 0;
    const ttl = this.ttl >>> 6;
    assert((ttl & 0x8000) === 0); // 15 bits max

    bw.writeU16(cmp | ttl);

    // Write the symbol table.
    c.toWriter(bw);

    for (const host of this.hosts)
      host.toWriter(bw, c);

    if (this.canonical) {
      bw.writeU8(rtypes.CANONICAL);
      this.canonical.toWriter(bw, c);
    }

    if (this.delegate) {
      bw.writeU8(rtypes.DELEGATE);
      this.delegate.toWriter(bw, c);
    }

    for (const ns of this.ns) {
      bw.writeU8(rtypes.NS);
      ns.toWriter(bw, c);
    }

    for (const srv of this.service) {
      bw.writeU8(rtypes.SERVICE);
      srv.toWriter(bw, c);
    }

    for (const url of this.url) {
      bw.writeU8(rtypes.URL);
      c.write(bw, url);
    }

    for (const email of this.email) {
      bw.writeU8(rtypes.EMAIL);
      c.write(bw, email);
    }

    for (const text of this.text) {
      bw.writeU8(rtypes.TEXT);
      c.write(bw, text);
    }

    for (const loc of this.location) {
      bw.writeU8(rtypes.LOCATION);
      loc.toWriter(bw, c);
    }

    for (const urn of this.magnet) {
      bw.writeU8(rtypes.MAGNET);
      urn.toWriter(bw, c);
    }

    for (const ds of this.ds) {
      bw.writeU8(rtypes.DS);
      ds.toWriter(bw, c);
    }

    for (const tls of this.tls) {
      bw.writeU8(rtypes.TLS);
      tls.toWriter(bw, c);
    }

    for (const ssh of this.ssh) {
      bw.writeU8(rtypes.SSH);
      ssh.toWriter(bw, c);
    }

    for (const pgp of this.pgp) {
      bw.writeU8(rtypes.PGP);
      pgp.toWriter(bw, c);
    }

    for (const addr of this.addr) {
      bw.writeU8(rtypes.ADDR);
      addr.toWriter(bw, c);
    }

    for (const extra of this.extra) {
      bw.writeU8(extra.type);
      extra.toWriter(bw, c);
    }

    return bw;
  }

  fromReader(br) {
    // Serialization version.
    const version = br.readU8();

    if (version !== 0)
      throw new Error(`Unknown serialization version: ${version}.`);

    // TTL has a granularity of 6
    // (about 1 minute per unit).
    const field = br.readU16();
    this.compat = (field & 0x8000) !== 0;
    this.ttl = (field & 0x7fff) << 6;

    // Read the symbol table.
    const d = Decompressor.fromReader(br);

    while (br.left()) {
      const type = br.readU8();
      switch (type) {
        case rtypes.INET4:
        case rtypes.INET6:
        case rtypes.ONION:
        case rtypes.ONIONNG: {
          const target = readTarget(type, br, d);
          this.hosts.push(new Target(type, target));
          break;
        }
        case rtypes.INAME:
        case rtypes.HNAME: {
          assert(!this.canonical);
          const target = readTarget(type, br, d);
          this.canonical = new Target(type, target);
          assert(!this.canonical.isTor());
          break;
        }
        case rtypes.CANONICAL:
          assert(!this.canonical);
          this.canonical = Target.fromReader(br, d);
          assert(!this.canonical.isTor());
          break;
        case rtypes.DELEGATE:
          assert(!this.delegate);
          this.delegate = Target.fromReader(br, d);
          assert(this.delegate.isName());
          break;
        case rtypes.NS: {
          const ns = Target.fromReader(br, d);
          assert(!ns.isTor());
          this.ns.push(ns);
          break;
        }
        case rtypes.SERVICE:
          this.service.push(Service.fromReader(br, d));
          break;
        case rtypes.URL:
          this.url.push(d.read(br));
          break;
        case rtypes.EMAIL:
          this.email.push(d.read(br));
          break;
        case rtypes.TEXT:
          this.text.push(d.read(br));
          break;
        case rtypes.LOCATION:
          this.location.push(Location.fromReader(br, d));
          break;
        case rtypes.MAGNET:
          this.magnet.push(Magnet.fromReader(br, d));
          break;
        case rtypes.DS:
          this.ds.push(DS.fromReader(br, d));
          break;
        case rtypes.TLS:
          this.tls.push(TLS.fromReader(br, d));
          break;
        case rtypes.SSH:
          this.ssh.push(SSH.fromReader(br, d));
          break;
        case rtypes.PGP:
          this.pgp.push(PGP.fromReader(br, d));
          break;
        case rtypes.ADDR:
          this.addr.push(Addr.fromReader(br, d));
          break;
        default:
          this.extra.push(Extra.fromReader(br, d));
          break;
      }
    }

    return this;
  }

  toA(name) {
    const answer = [];

    for (const host of this.hosts) {
      if (!host.isINET4())
        continue;

      const rr = new Record();
      rr.name = name;
      rr.ttl = this.ttl;
      rr.type = types.A;
      rr.data = new ARecord();
      rr.data.address = host.target;

      answer.push(rr);
    }

    if (this.hasTor())
      answer.push(this.toTorTXT(name));

    return answer;
  }

  toAAAA(name) {
    const answer = [];

    for (const host of this.hosts) {
      if (!host.isINET6())
        continue;

      const rr = new Record();
      rr.name = name;
      rr.ttl = this.ttl;
      rr.type = types.AAAA;
      rr.data = new AAAARecord();
      rr.data.address = host.target;

      answer.push(rr);
    }

    if (this.hasTor())
      answer.push(this.toTorTXT(name));

    return answer;
  }

  toCNAME(name, naked) {
    if (!this.canonical)
      return [];

    const cn = this.canonical;
    const rr = new Record();
    rr.name = name;
    rr.ttl = this.ttl;
    rr.type = types.CNAME;
    rr.data = new CNAMERecord();

    if (cn.isINET()) {
      if (!naked)
        return [];
      rr.data.target = this.canonical.toPointer();
      return [rr];
    }

    if (!cn.isName())
      return [];

    rr.data.target = this.canonical.toDNS();

    return [rr];
  }

  toCNAMEIP(name, naked) {
    if (!naked)
      return [];

    const cn = this.canonical;

    if (!cn || !cn.isINET())
      return [];

    const rr = new Record();
    rr.name = cn.toPointer();
    rr.ttl = this.ttl;

    if (cn.isINET4()) {
      rr.type = types.A;
      rr.data = new ARecord();
    } else {
      rr.type = types.AAAA;
      rr.data = new AAAARecord();
    }

    rr.data.address = cn.target;

    return [rr];
  }

  toDNAME(name) {
    if (!this.delegate)
      return [];

    assert(this.delegate.isName());
    const rr = new Record();
    rr.name = name;
    rr.ttl = this.ttl;
    rr.type = types.DNAME;
    rr.data = new DNAMERecord();
    rr.data.target = this.delegate.toDNS();

    return [rr];
  }

  toNS(name, naked) {
    const authority = [];

    for (const ns of this.ns) {
      let nsname = null;

      if (ns.isName())
        nsname = ns.toDNS();
      else if (naked && ns.isINET())
        nsname = ns.toPointer(name);

      if (!nsname)
        continue;

      const rr = new Record();
      const rd = new NSRecord();
      rr.name = name;
      rr.ttl = this.ttl;
      rr.type = types.NS;
      rr.data = rd;
      rd.ns = nsname;

      authority.push(rr);
    }

    return authority;
  }

  toNSIP(name, naked) {
    if (!naked)
      return [];

    const additional = [];

    for (const ns of this.ns) {
      if (!ns.isINET())
        continue;

      const rr = new Record();
      rr.name = ns.toPointer(name);
      rr.ttl = this.ttl;

      if (ns.isINET4()) {
        rr.type = types.A;
        rr.data = new ARecord();
      } else {
        rr.type = types.AAAA;
        rr.data = new AAAARecord();
      }

      rr.data.address = ns.target;

      additional.push(rr);
    }

    return additional;
  }

  toSOA(name) {
    assert(util.isFQDN(name));

    const tld = util.from(name, -2);
    const rr = new Record();
    const rd = new SOARecord();

    rr.name = tld;
    rr.type = types.SOA;
    rr.ttl = this.ttl;
    rr.data = rd;

    rd.ns = tld;
    rd.mbox = tld;
    rd.serial = 0;
    rd.refresh = 1800;
    rd.retry = this.ttl;
    rd.expire = 604800;
    rd.minttl = 86400;

    const ns = this.toNS(tld, true);

    if (ns.length > 0)
      rd.ns = ns[0].data.ns;

    const mx = this.toMX(tld, true);

    if (mx.length > 0)
      rd.mbox = mx[0].data.mx;

    return [rr];
  }

  toMX(name, naked) {
    const answer = [];

    for (const srv of this.service) {
      if (!srv.isSMTP())
        continue;

      let mxname = null;

      if (srv.target.isName())
        mxname = srv.target.toDNS();
      else if (naked && srv.target.isINET())
        mxname = srv.target.toPointer(name);

      if (!mxname)
        continue;

      const rr = new Record();
      const rd = new MXRecord();

      rr.name = name;
      rr.type = types.MX;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.preference = srv.priority;
      rd.mx = mxname;

      answer.push(rr);
    }

    return answer;
  }

  toMXIP(name, naked) {
    return this.toSRVIP(name, naked, true);
  }

  toSRV(name, naked) {
    const answer = [];

    for (const srv of this.service) {
      let target = null;

      if (srv.target.isName())
        target = srv.target.toDNS();
      else if (naked && srv.target.isINET())
        target = srv.target.toPointer(name);

      if (!target)
        continue;

      const rr = new Record();
      const rd = new SRVRecord();

      rr.name = `_${srv.service}._${srv.protocol}.${name}`;
      rr.type = types.SRV;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.priority = srv.priority;
      rd.weight = srv.weight;
      rd.target = target;
      rd.port = srv.port;

      answer.push(rr);
    }

    return answer;
  }

  toSRVIP(name, naked, mx) {
    if (!naked)
      return [];

    const additional = [];

    for (const srv of this.service) {
      if (mx && !srv.isSMTP())
        continue;

      if (!srv.target.isINET())
        continue;

      const rr = new Record();
      rr.name = srv.target.toPointer(name);
      rr.ttl = this.ttl;

      if (srv.target.isINET4()) {
        rr.type = types.A;
        rr.data = new ARecord();
      } else {
        rr.type = types.AAAA;
        rr.data = new AAAARecord();
      }

      rr.data.address = srv.target.target;

      additional.push(rr);
    }

    return additional;
  }

  toLOC(name) {
    const answer = [];

    for (const loc of this.location) {
      const rr = new Record();
      const rd = new LOCRecord();

      rr.name = name;
      rr.type = types.LOC;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.version = loc.version;
      rd.size = loc.size;
      rd.horizPre = loc.horizPre;
      rd.vertPre = loc.vertPre;
      rd.latitude = loc.latitude;
      rd.longitude = loc.longitude;
      rd.altitude = loc.altitude;

      answer.push(rr);
    }

    return answer;
  }

  toDS(name) {
    const answer = [];

    for (const ds of this.ds) {
      const rr = new Record();
      const rd = new DSRecord();

      rr.name = name;
      rr.type = types.DS;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.keyTag = ds.keyTag;
      rd.algorithm = ds.algorithm;
      rd.digestType = ds.digestType;
      rd.digest = ds.digest;

      answer.push(rr);
    }

    return answer;
  }

  toTLSA(name) {
    const answer = [];

    for (const tls of this.tls) {
      const rr = new Record();
      const rd = new TLSARecord();

      rr.name = `_${tls.port}._${tls.protocol}.${name}`;
      rr.type = types.TLSA;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.usage = tls.usage;
      rd.selector = tls.selector;
      rd.matchingType = tls.matchingType;
      rd.certificate = tls.certificate;

      answer.push(rr);
    }

    return answer;
  }

  toSSHFP(name) {
    const answer = [];

    for (const ssh of this.ssh) {
      const rr = new Record();
      const rd = new SSHFPRecord();

      rr.name = name;
      rr.type = types.SSHFP;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.algorithm = ssh.algorithm;
      rd.type = ssh.type;
      rd.fingerprint = ssh.fingerprint;

      answer.push(rr);
    }

    return answer;
  }

  toOPENPGPKEY(name) {
    const answer = [];

    for (const pgp of this.pgp) {
      const rr = new Record();
      const rd = new OPENPGPKEYRecord();

      rr.name = name;
      rr.type = types.OPENPGPKEY;
      rr.ttl = this.ttl;
      rr.data = rd;

      // XXX
      rd.publicKey = pgp.toRaw();

      answer.push(rr);
    }

    return answer;
  }

  hasTor() {
    for (const host of this.hosts) {
      if (host.isTor())
        return true;
    }
    return false;
  }

  toTorTXT(name) {
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = this.ttl;
    rr.data = rd;

    rd.txt.push('hsk:tor');

    for (const host of this.hosts) {
      if (host.isTor())
        rd.txt.push(host.target);
    }

    return rr;
  }

  toURLTXT(name) {
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = this.ttl;
    rr.data = rd;

    rd.txt.push('hsk:url');

    for (const url of this.url)
      rd.txt.push(url);

    return rr;
  }

  toEmailTXT(name) {
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = this.ttl;
    rr.data = rd;

    rd.txt.push('hsk:email');

    for (const email of this.email)
      rd.txt.push(email);

    return rr;
  }

  toMagnetTXT(name) {
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = this.ttl;
    rr.data = rd;

    rd.txt.push('hsk:magnet');

    for (const urn of this.magnet)
      rd.txt.push(urn.toString());

    return rr;
  }

  toAddrTXT(name) {
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = this.ttl;
    rr.data = rd;

    rd.txt.push('hsk:addr');

    for (const addr of this.addr)
      rd.txt.push(addr.toString());

    return rr;
  }

  toTextTXT(name) {
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = this.ttl;
    rr.data = rd;

    for (const txt of this.text)
      rd.txt.push(txt);

    return rr;
  }

  toTXT(name) {
    const answer = [];

    if (this.text.length > 0)
      answer.push(this.toTextTXT(name));

    if (this.url.length > 0)
      answer.push(this.toURLTXT(name));

    if (this.email.length > 0)
      answer.push(this.toEmailTXT(name));

    if (this.magnet.length > 0)
      answer.push(this.toMagnetTXT(name));

    if (this.addr.length > 0)
      answer.push(this.toAddrTXT(name));

    return answer;
  }

  toDNS(name, type, naked = true) {
    // Our fake resolution.
    const res = new Message();

    res.qr = true;
    res.ad = true;

    assert(util.isFQDN(name));

    name += `${HSK}.`;

    const labels = util.split(name);

    // Referral.
    if (labels.length > 2) {
      const tld = util.from(name, labels, -2);

      if (this.ns.length > 0) {
        res.authority = this.toNS(tld, naked);
        res.additional = this.toNSIP(tld, naked);
      } else if (this.delegate) {
        res.answer = this.toDNAME(tld);
      } else {
        res.authority = this.toSOA(tld);
      }

      // Always push on DS records for a referral.
      for (const rr of this.toDS(tld))
        res.authority.push(rr);

      res.setEDNS0(4096, true);

      return res;
    }

    // Authoritative response.
    res.aa = true;

    switch (type) {
      case types.ANY:
        res.answer = this.toSOA(name);
        for (const rr of this.toNS(name, naked))
          res.answer.push(rr);
        res.additional = this.toNSIP(name, naked);
        break;
      case types.SOA:
        res.answer = this.toSOA(name);
        res.authority = this.toNS(name, naked);
        res.additional = this.toNSIP(name, naked);
        break;
      case types.A:
        res.answer = this.toA(name);
        break;
      case types.AAAA:
        res.answer = this.toAAAA(name);
        break;
      case types.CNAME:
        res.answer = this.toCNAME(name, naked);
        // Put it in the additional section if
        // they didn't ask for an A/AAAA record.
        res.additional = this.toCNAMEIP(name, naked);
        break;
      case types.DNAME:
        res.answer = this.toDNAME(name);
        break;
      case types.NS:
        res.answer = this.toNS(name, naked);
        res.additional = this.toNSIP(name, naked);
        break;
      case types.MX:
        res.answer = this.toMX(name, naked);
        res.additional = this.toMXIP(name, naked);
        break;
      case types.SRV:
        res.answer = this.toSRV(name, naked);
        res.additional = this.toSRVIP(name, naked);
        break;
      case types.TXT:
        res.answer = this.toTXT(name);
        break;
      case types.LOC:
        res.answer = this.toLOC(name);
        break;
      case types.DS:
        res.answer = this.toDS(name);
        break;
      case types.TLSA:
        res.answer = this.toTLSA(name);
        break;
      case types.OPENPGPKEY:
        res.answer = this.toOPENPGPKEY(name);
        break;
    }

    if (res.answer.length === 0
        && res.authority.length === 0) {
      if (this.canonical) {
        if (type === types.A || type === types.AAAA) {
          res.answer = this.toCNAME(name, naked);
          // Add the correct IP record.
          const ptr = this.toCNAMEIP(name, naked);
          if (ptr.length > 0 && ptr[0].type === type)
            res.answer.push(ptr[0]);
        } else {
          res.answer = this.toCNAME(name, false);
          // We could add A/AAAA records to the
          // additional section here, but I don't
          // think it's standard recursive resolver
          // behavior to pay attention to them.
        }
        res.setEDNS0(4096, true);
        return res;
      }

      // Nothing. Return the SOA.
      res.authority = this.toSOA(name);
    }

    res.setEDNS0(4096, true);

    return res;
  }

  toJSON(name) {
    const json = {
      version: this.version,
      name,
      compat: this.compat,
      ttl: this.ttl
    };

    if (this.hosts.length > 0) {
      json.hosts = [];
      for (const host of this.hosts)
        json.hosts.push(host.toJSON());
    }

    if (this.canonical)
      json.canonical = this.canonical.toJSON();

    if (this.delegate)
      json.delegate = this.delegate.toJSON();

    if (this.ns.length > 0) {
      json.ns = [];
      for (const ns of this.ns)
        json.ns.push(ns.toJSON());
    }

    if (this.service.length > 0) {
      json.service = [];
      for (const srv of this.service)
        json.service.push(srv.toJSON());
    }

    if (this.url.length > 0) {
      json.url = [];
      for (const url of this.url)
        json.url.push(url);
    }

    if (this.email.length > 0) {
      json.email = [];
      for (const email of this.email)
        json.email.push(email);
    }

    if (this.text.length > 0) {
      json.text = [];
      for (const txt of this.text)
        json.text.push(txt);
    }

    if (this.location.length > 0) {
      json.location = [];
      for (const loc of this.location)
        json.location.push(loc.toJSON());
    }

    if (this.magnet.length > 0) {
      json.magnet = [];
      for (const urn of this.magnet)
        json.magnet.push(urn.toJSON());
    }

    if (this.ds.length > 0) {
      json.ds = [];
      for (const ds of this.ds)
        json.ds.push(ds.toJSON());
    }

    if (this.tls.length > 0) {
      json.tls = [];
      for (const tls of this.tls)
        json.tls.push(tls.toJSON());
    }

    if (this.ssh.length > 0) {
      json.ssh = [];
      for (const ssh of this.ssh)
        json.ssh.push(ssh.toJSON());
    }

    if (this.pgp.length > 0) {
      json.pgp = [];
      for (const pgp of this.pgp)
        json.pgp.push(pgp.toJSON());
    }

    if (this.pgp.length > 0) {
      json.pgp = [];
      for (const pgp of this.pgp)
        json.pgp.push(pgp.toJSON());
    }

    if (this.addr.length > 0) {
      json.addr = [];
      for (const addr of this.addr)
        json.addr.push(addr.toJSON());
    }

    if (this.extra.length > 0) {
      json.extra = [];
      for (const extra of this.extra)
        json.extra.push(extra.toJSON());
    }

    return json;
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');

    if (json.version != null) {
      assert(json.version === 0);
      this.version = json.version;
    }

    if (json.ttl != null) {
      assert((json.ttl >>> 0) === json.ttl);
      this.ttl = json.ttl;
    }

    if (json.compat != null) {
      assert(typeof json.compat === 'boolean');
      this.compat = json.compat;
    }

    if (json.hosts != null) {
      assert(Array.isArray(json.hosts));
      for (const host of json.hosts)
        this.hosts.push(Target.fromJSON(host));
    }

    if (json.canonical != null) {
      this.canonical = Target.fromJSON(json.canonical);
      assert(!this.canonical.isTor());
    }

    if (json.delegate != null) {
      this.delegate = Target.fromJSON(json.delegate);
      assert(this.delegate.isName());
    }

    if (json.ns != null) {
      assert(Array.isArray(json.ns));
      for (const ns of json.ns) {
        const target = Target.fromJSON(ns);
        assert(!target.isTor());
        this.ns.push(target);
      }
    }

    if (json.service != null) {
      assert(Array.isArray(json.service));
      for (const srv of json.service)
        this.service.push(Service.fromJSON(srv));
    }

    if (json.url != null) {
      assert(Array.isArray(json.url));
      for (const url of json.url) {
        assert(typeof url === 'string');
        assert(url.length <= 255);
        this.url.push(url);
      }
    }

    if (json.email != null) {
      assert(Array.isArray(json.email));
      for (const email of json.email) {
        assert(typeof email === 'string');
        assert(email.length <= 255);
        this.email.push(email);
      }
    }

    if (json.text != null) {
      assert(Array.isArray(json.text));
      for (const txt of json.text) {
        assert(typeof txt === 'string');
        assert(txt.length <= 255);
        this.text.push(txt);
      }
    }

    if (json.location != null) {
      assert(Array.isArray(json.location));
      for (const loc of json.location)
        this.location.push(Location.fromJSON(loc));
    }

    if (json.magnet != null) {
      assert(Array.isArray(json.magnet));
      for (const urn of json.magnet)
        this.magnet.push(Magnet.fromJSON(urn));
    }

    if (json.ds != null) {
      assert(Array.isArray(json.ds));
      for (const ds of json.ds)
        this.ds.push(DS.fromJSON(ds));
    }

    if (json.tls != null) {
      assert(Array.isArray(json.tls));
      for (const tls of json.tls)
        this.tls.push(TLS.fromJSON(tls));
    }

    if (json.ssh != null) {
      assert(Array.isArray(json.ssh));
      for (const ssh of json.ssh)
        this.ssh.push(SSH.fromJSON(ssh));
    }

    if (json.pgp != null) {
      assert(Array.isArray(json.pgp));
      for (const pgp of json.pgp)
        this.pgp.push(PGP.fromJSON(pgp));
    }

    if (json.addr != null) {
      assert(Array.isArray(json.addr));
      for (const addr of json.addr)
        this.addr.push(Addr.fromJSON(addr));
    }

    if (json.extra != null) {
      assert(Array.isArray(json.extra));
      for (const extra of json.extra)
        this.extra.push(Extra.fromJSON(extra));
    }

    return this;
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  inspect() {
    return this.toJSON();
  }
}

exports.ICANN = ICANN;
exports.HSK = HSK;
exports.ICANNP = ICANNP;
exports.ICANNS = ICANNS;
exports.HSKP = HSKP;
exports.HSKS = HSKS;
exports.HSKRecord = HSKRecord;
