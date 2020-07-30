/*!
 * resource.js - hns records for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {encoding, wire, util} = require('bns');
const base32 = require('bcrypto/lib/encoding/base32');
const {IP} = require('binet');
const bio = require('bufio');
const key = require('./key');
const {Struct} = bio;

const {
  sizeName,
  writeNameBW,
  readNameBR,
  sizeString,
  writeStringBW,
  readStringBR,
  isName,
  readIP,
  writeIP
} = encoding;

const {
  Message,
  Record,
  ARecord,
  AAAARecord,
  NSRecord,
  TXTRecord,
  DSRecord,
  types
} = wire;

/*
 * Constants
 */

const DUMMY = Buffer.alloc(0);

const DEFAULT_TTL = 21600;

const hsTypes = {
  DS: 0,
  NS: 1,
  GLUE4: 2,
  GLUE6: 3,
  SYNTH4: 4,
  SYNTH6: 5,
  TXT: 6
};

const hsTypesByVal = {
  [hsTypes.DS]: 'DS',
  [hsTypes.NS]: 'NS',
  [hsTypes.GLUE4]: 'GLUE4',
  [hsTypes.GLUE6]: 'GLUE6',
  [hsTypes.SYNTH4]: 'SYNTH4',
  [hsTypes.SYNTH6]: 'SYNTH6',
  [hsTypes.TXT]: 'TXT'
};

/**
 * Resource
 * @extends {Struct}
 */

class Resource extends Struct {
  constructor() {
    super();
    this.ttl = DEFAULT_TTL;
    this.records = [];
  }

  hasType(type) {
    assert((type & 0xff) === type);

    for (const record of this.records) {
      if (record.type === type)
        return true;
    }

    return false;
  }

  hasNS() {
    for (const {type} of this.records) {
      if (type < hsTypes.NS || type > hsTypes.SYNTH6)
        continue;

      return true;
    }

    return false;
  }

  hasDS() {
    return this.hasType(hsTypes.DS);
  }

  encode() {
    const bw = bio.write(512);
    this.write(bw, new Map());
    return bw.slice();
  }

  getSize(map) {
    let size = 1;

    for (const rr of this.records)
      size += 1 + rr.getSize(map);

    return size;
  }

  write(bw, map) {
    bw.writeU8(0);

    for (const rr of this.records) {
      bw.writeU8(rr.type);
      rr.write(bw, map);
    }

    return this;
  }

  read(br) {
    const version = br.readU8();

    if (version !== 0)
      throw new Error(`Unknown serialization version: ${version}.`);

    while (br.left()) {
      const RD = typeToClass(br.readU8());

      // Break at unknown records.
      if (!RD)
        break;

      this.records.push(RD.read(br));
    }

    return this;
  }

  toNS(name) {
    const authority = [];
    const set = new Set();

    for (const record of this.records) {
      switch (record.type) {
        case hsTypes.NS:
        case hsTypes.GLUE4:
        case hsTypes.GLUE6:
        case hsTypes.SYNTH4:
        case hsTypes.SYNTH6:
          break;
        default:
          continue;
      }

      const rr = record.toDNS(name, this.ttl);

      if (set.has(rr.data.ns))
        continue;

      set.add(rr.data.ns);
      authority.push(rr);
    }

    return authority;
  }

  toGlue(name) {
    const additional = [];

    for (const record of this.records) {
      switch (record.type) {
        case hsTypes.GLUE4:
        case hsTypes.GLUE6:
          if (!util.isSubdomain(name, record.ns))
            continue;
          break;
        case hsTypes.SYNTH4:
        case hsTypes.SYNTH6:
          break;
        default:
          continue;
      }

      additional.push(record.toGlue(record.ns, this.ttl));
    }

    return additional;
  }

  toDS(name) {
    const answer = [];

    for (const record of this.records) {
      if (record.type !== hsTypes.DS)
        continue;

      answer.push(record.toDNS(name, this.ttl));
    }

    return answer;
  }

  toTXT(name) {
    const answer = [];

    for (const record of this.records) {
      if (record.type !== hsTypes.TXT)
        continue;

      answer.push(record.toDNS(name, this.ttl));
    }

    return answer;
  }

  toZone(name, sign = false) {
    const zone = [];
    const set = new Set();

    for (const record of this.records) {
      const rr = record.toDNS(name, this.ttl);

      if (rr.type === types.NS) {
        if (set.has(rr.data.ns))
          continue;

        set.add(rr.data.ns);
      }

      zone.push(rr);
    }

    if (sign) {
      const set = new Set();

      for (const rr of zone)
        set.add(rr.type);

      const types = [...set].sort();

      for (const type of types)
        key.signZSK(zone, type);
    }

    // Add the glue last.
    for (const record of this.records) {
      switch (record.type) {
        case hsTypes.GLUE4:
        case hsTypes.GLUE6:
        case hsTypes.SYNTH4:
        case hsTypes.SYNTH6: {
          if (!util.isSubdomain(name, record.ns))
            continue;

          zone.push(record.toGlue(record.ns, this.ttl));
          break;
        }
      }
    }

    return zone;
  }

  toReferral(name) {
    const res = new Message();

    if (this.hasNS()) {
      res.authority = [
        ...this.toNS(name),
        ...this.toDS(name)
      ];

      res.additional = this.toGlue(name);

      // Note: should have nsec unsigned zone proof.
      if (!this.hasDS())
        key.signZSK(res.authority, types.NS);
      else
        key.signZSK(res.authority, types.DS);
    } else {
      // Needs SOA.
    }

    return res;
  }

  toDNS(name, type) {
    assert(util.isFQDN(name));
    assert((type >>> 0) === type);

    const labels = util.split(name);

    // Referral.
    if (labels.length > 1) {
      const tld = util.from(name, labels, -1);
      return this.toReferral(tld);
    }

    // Potentially an answer.
    const res = new Message();

    switch (type) {
      case types.NS:
        res.authority = this.toNS(name);
        res.additional = this.toGlue(name);
        key.signZSK(res.authority, types.NS);
        break;
      case types.TXT:
        res.answer = this.toTXT(name);
        key.signZSK(res.answer, types.TXT);
        break;
      case types.DS:
        res.answer = this.toDS(name);
        key.signZSK(res.answer, types.DS);
        break;
    }

    // Nope, we need a referral.
    if (res.answer.length === 0
        && res.authority.length === 0) {
      return this.toReferral(name);
    }

    // We're authoritative for the answer.
    res.aa = res.answer.length !== 0;

    return res;
  }

  getJSON(name) {
    const json = { records: [] };

    for (const record of this.records)
      json.records.push(record.getJSON());

    return json;
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid json.');
    assert(Array.isArray(json.records), 'Invalid records.');

    for (const item of json.records) {
      assert(item && typeof item === 'object', 'Invalid record.');

      const RD = stringToClass(item.type);

      if (!RD)
        throw new Error(`Unknown type: ${item.type}.`);

      this.records.push(RD.fromJSON(item));
    }

    return this;
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

  get type() {
    return hsTypes.DS;
  }

  getSize() {
    return 5 + this.digest.length;
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
    this.digest = br.readBytes(br.readU8());
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new DSRecord();

    rr.name = name;
    rr.type = types.DS;
    rr.ttl = ttl;
    rr.data = rd;

    rd.keyTag = this.keyTag;
    rd.algorithm = this.algorithm;
    rd.digestType = this.digestType;
    rd.digest = this.digest;

    return rr;
  }

  getJSON() {
    return {
      type: 'DS',
      keyTag: this.keyTag,
      algorithm: this.algorithm,
      digestType: this.digestType,
      digest: this.digest.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid DS record.');
    assert(json.type === 'DS',
      'Invalid DS record. Type must be "DS".');
    assert((json.keyTag & 0xffff) === json.keyTag,
      'Invalid DS record. KeyTag must be a uint16.');
    assert((json.algorithm & 0xff) === json.algorithm,
      'Invalid DS record. Algorithm must be a uint8.');
    assert((json.digestType & 0xff) === json.digestType,
      'Invalid DS record. DigestType must be a uint8.');
    assert(typeof json.digest === 'string',
      'Invalid DS record. Digest must be a String.');
    assert((json.digest.length >>> 1) <= 255,
      'Invalid DS record. Digest is too large.');

    this.keyTag = json.keyTag;
    this.algorithm = json.algorithm;
    this.digestType = json.digestType;
    this.digest = util.parseHex(json.digest);

    return this;
  }
}

/**
 * NS
 * @extends {Struct}
 */

class NS extends Struct {
  constructor() {
    super();
    this.ns = '.';
  }

  get type() {
    return hsTypes.NS;
  }

  getSize(map) {
    return sizeName(this.ns, map);
  }

  write(bw, map) {
    writeNameBW(bw, this.ns, map);
    return this;
  }

  read(br) {
    this.ns = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    return createNS(name, ttl, this.ns);
  }

  getJSON() {
    return {
      type: 'NS',
      ns: this.ns
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object',
      'Invalid NS record.');
    assert(json.type === 'NS',
      'Invalid NS record. Type must be "NS".');
    assert(isName(json.ns),
      'Invalid NS record. ns must be a valid name.');

    this.ns = json.ns;

    return this;
  }
}

/**
 * GLUE4
 * @extends {Struct}
 */

class GLUE4 extends Struct {
  constructor() {
    super();
    this.ns = '.';
    this.address = '0.0.0.0';
  }

  get type() {
    return hsTypes.GLUE4;
  }

  getSize(map) {
    return sizeName(this.ns, map) + 4;
  }

  write(bw, map) {
    writeNameBW(bw, this.ns, map);
    writeIP(bw, this.address, 4);
    return this;
  }

  read(br) {
    this.ns = readNameBR(br);
    this.address = readIP(br, 4);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    return createNS(name, ttl, this.ns);
  }

  toGlue(name = '.', ttl = DEFAULT_TTL) {
    return createA(name, ttl, this.address);
  }

  getJSON() {
    return {
      type: 'GLUE4',
      ns: this.ns,
      address: this.address
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid GLUE4 record.');
    assert(json.type === 'GLUE4',
      'Invalid GLUE4 record. Type must be "GLUE4".');
    assert(isName(json.ns),
      'Invalid GLUE4 record. ns must be a valid name.');
    assert(IP.isIPv4String(json.address),
      'Invalid GLUE4 record. Address must be a valid IPv4 address.');

    this.ns = json.ns;
    this.address = IP.normalize(json.address);

    return this;
  }
}

/**
 * GLUE6
 * @extends {Struct}
 */

class GLUE6 extends Struct {
  constructor() {
    super();
    this.ns = '.';
    this.address = '::';
  }

  get type() {
    return hsTypes.GLUE6;
  }

  getSize(map) {
    return sizeName(this.ns, map) + 16;
  }

  write(bw, map) {
    writeNameBW(bw, this.ns, map);
    writeIP(bw, this.address, 16);
    return this;
  }

  read(br) {
    this.ns = readNameBR(br);
    this.address = readIP(br, 16);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    return createNS(name, ttl, this.ns);
  }

  toGlue(name = '.', ttl = DEFAULT_TTL) {
    return createAAAA(name, ttl, this.address);
  }

  getJSON() {
    return {
      type: 'GLUE6',
      ns: this.ns,
      address: this.address
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid GLUE6 record.');
    assert(json.type === 'GLUE6',
      'Invalid GLUE6 record. Type must be "GLUE6".');
    assert(isName(json.ns),
      'Invalid GLUE6 record. ns must be a valid name.');
    assert(IP.isIPv6String(json.address),
      'Invalid GLUE6 record. Address must be a valid IPv6 address.');

    this.ns = json.ns;
    this.address = IP.normalize(json.address);

    return this;
  }
}

/**
 * SYNTH4
 * @extends {Struct}
 */

class SYNTH4 extends Struct {
  constructor() {
    super();
    this.address = '0.0.0.0';
  }

  get type() {
    return hsTypes.SYNTH4;
  }

  get ns() {
    const ip = IP.toBuffer(this.address).slice(12);
    return `_${base32.encodeHex(ip)}._synth.`;
  }

  getSize() {
    return 4;
  }

  write(bw) {
    writeIP(bw, this.address, 4);
    return this;
  }

  read(br) {
    this.address = readIP(br, 4);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    return createNS(name, ttl, this.ns);
  }

  toGlue(name = '.', ttl = DEFAULT_TTL) {
    return createA(name, ttl, this.address);
  }

  getJSON() {
    return {
      type: 'SYNTH4',
      address: this.address
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid SYNTH4 record.');
    assert(json.type === 'SYNTH4',
      'Invalid SYNTH4 record. Type must be "SYNTH4".');
    assert(IP.isIPv4String(json.address),
      'Invalid SYNTH4 record. Address must be a valid IPv4 address.');

    this.address = IP.normalize(json.address);

    return this;
  }
}

/**
 * SYNTH6
 * @extends {Struct}
 */

class SYNTH6 extends Struct {
  constructor() {
    super();
    this.address = '::';
  }

  get type() {
    return hsTypes.SYNTH6;
  }

  get ns() {
    const ip = IP.toBuffer(this.address);
    return `_${base32.encodeHex(ip)}._synth.`;
  }

  getSize() {
    return 16;
  }

  write(bw) {
    writeIP(bw, this.address, 16);
    return this;
  }

  read(br) {
    this.address = readIP(br, 16);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    return createNS(name, ttl, this.ns);
  }

  toGlue(name = '.', ttl = DEFAULT_TTL) {
    return createAAAA(name, ttl, this.address);
  }

  getJSON() {
    return {
      type: 'SYNTH6',
      address: this.address
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid SYNTH6 record.');
    assert(json.type === 'SYNTH6',
      'Invalid SYNTH6 record. Type must be "SYNTH6".');
    assert(IP.isIPv6String(json.address),
      'Invalid SYNTH6 record. Address must be a valid IPv6 address.');

    this.address = IP.normalize(json.address);

    return this;
  }
}

/**
 * TXT
 * @extends {Struct}
 */

class TXT extends Struct {
  constructor() {
    super();
    this.txt = [];
  }

  get type() {
    return hsTypes.TXT;
  }

  getSize() {
    let size = 1;
    for (const txt of this.txt)
      size += sizeString(txt);
    return size;
  }

  write(bw) {
    bw.writeU8(this.txt.length);

    for (const txt of this.txt)
      writeStringBW(bw, txt);

    return this;
  }

  read(br) {
    const count = br.readU8();

    for (let i = 0; i < count; i++)
      this.txt.push(readStringBR(br));

    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = name;
    rr.type = types.TXT;
    rr.ttl = ttl;
    rr.data = rd;

    rd.txt.push(...this.txt);

    return rr;
  }

  getJSON() {
    return {
      type: 'TXT',
      txt: this.txt
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object',
      'Invalid TXT record.');
    assert(json.type === 'TXT',
      'Invalid TXT record. Type must be "TXT".');
    assert(Array.isArray(json.txt),
      'Invalid TXT record. txt must be an Array.');

    for (const txt of json.txt) {
      assert(typeof txt === 'string',
        'Invalid TXT record. Entries in txt Array must be type String.');
      assert(txt.length <= 255,
        'Invalid TXT record. Entries in txt Array must be <= 255 in length.');

      this.txt.push(txt);
    }

    return this;
  }
}

/*
 * Helpers
 */

function typeToClass(type) {
  assert((type & 0xff) === type);
  switch (type) {
    case hsTypes.DS:
      return DS;
    case hsTypes.NS:
      return NS;
    case hsTypes.GLUE4:
      return GLUE4;
    case hsTypes.GLUE6:
      return GLUE6;
    case hsTypes.SYNTH4:
      return SYNTH4;
    case hsTypes.SYNTH6:
      return SYNTH6;
    case hsTypes.TXT:
      return TXT;
    default:
      return null;
  }
}

function stringToClass(type) {
  assert(typeof type === 'string');

  if (!hsTypes.hasOwnProperty(type))
    return null;

  return typeToClass(hsTypes[type]);
}

function createNS(name, ttl, ns) {
  assert(util.isFQDN(name));
  assert((ttl >>> 0) === ttl);
  assert(util.isFQDN(ns));

  const rr = new Record();
  const rd = new NSRecord();

  rr.name = name;
  rr.ttl = ttl;
  rr.type = types.NS;
  rr.data = rd;
  rd.ns = ns;

  return rr;
}

function createA(name, ttl, address) {
  assert(util.isFQDN(name));
  assert((ttl >>> 0) === ttl);
  assert(IP.isIPv4String(address));

  const rr = new Record();
  const rd = new ARecord();

  rr.name = name;
  rr.ttl = ttl;
  rr.type = types.A;
  rr.data = rd;
  rd.address = address;

  return rr;
}

function createAAAA(name, ttl, address) {
  assert(util.isFQDN(name));
  assert((ttl >>> 0) === ttl);
  assert(IP.isIPv6String(address));

  const rr = new Record();
  const rd = new AAAARecord();

  rr.name = name;
  rr.ttl = ttl;
  rr.type = types.AAAA;
  rr.data = rd;
  rd.address = address;

  return rr;
}

/*
 * Expose
 */

exports.types = hsTypes;
exports.typesByVal = hsTypesByVal;
exports.Resource = Resource;
exports.DS = DS;
exports.NS = NS;
exports.GLUE4 = GLUE4;
exports.GLUE6 = GLUE6;
exports.SYNTH4 = SYNTH4;
exports.SYNTH6 = SYNTH6;
exports.TXT = TXT;
