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
const nsec = require('./nsec');
const {Struct} = bio;
const {
  DUMMY,
  DEFAULT_TTL,
  TYPE_MAP_EMPTY,
  TYPE_MAP_NS,
  TYPE_MAP_TXT,
  hsTypes
} = require('./common');

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
  CNAMERecord,
  DNAMERecord,
  MXRecord,
  SRVRecord,
  TLSARecord,
  SSHFPRecord,
  CAARecord,
  SOARecord,
  PTRRecord,
  NAPTRRecord,
  SMIMEARecord,
  OPENPGPKEYRecord,
  URIRecord,
  LOCRecord,
  RPRecord,
  NSECRecord,
  UNKNOWNRecord,
  types
} = wire;

/**
 * Map hsType to DNS wire type.
 * @param {Number} hsType
 * @returns {Number|null}
 */

function hsToDNSType(hsType) {
  switch (hsType) {
    case hsTypes.DS:
      return types.DS;
    case hsTypes.NS:
    case hsTypes.GLUE4:
    case hsTypes.GLUE6:
    case hsTypes.SYNTH4:
    case hsTypes.SYNTH6:
      return types.NS;
    case hsTypes.TXT:
      return types.TXT;
    case hsTypes.A:
      return types.A;
    case hsTypes.AAAA:
      return types.AAAA;
    case hsTypes.CNAME:
      return types.CNAME;
    case hsTypes.DNAME:
      return types.DNAME;
    case hsTypes.MX:
      return types.MX;
    case hsTypes.SRV:
      return types.SRV;
    case hsTypes.TLSA:
      return types.TLSA;
    case hsTypes.SSHFP:
      return types.SSHFP;
    case hsTypes.CAA:
      return types.CAA;
    case hsTypes.SOA:
      return types.SOA;
    case hsTypes.PTR:
      return types.PTR;
    case hsTypes.NAPTR:
      return types.NAPTR;
    case hsTypes.SMIMEA:
      return types.SMIMEA;
    case hsTypes.OPENPGPKEY:
      return types.OPENPGPKEY;
    case hsTypes.URI:
      return types.URI;
    case hsTypes.LOC:
      return types.LOC;
    case hsTypes.RP:
      return types.RP;
    default:
      return null;
  }
}

/**
 * Get the label-qualified FQDN for a record.
 * @param {String} name - The TLD FQDN (e.g. "example.")
 * @param {String} label - The subdomain label (e.g. "www" or "_443._tcp")
 * @returns {String} FQDN
 */

function labelName(name, label) {
  if (!label)
    return name;

  return `${label}.${name}`;
}

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

  /**
   * Check if any records exist for a given subdomain label.
   * @param {String} label
   * @returns {Boolean}
   */

  hasLabel(label) {
    for (const record of this.records) {
      if ((record.label || '') === label)
        return true;
    }

    return false;
  }

  /**
   * Get all distinct labels used in records.
   * @returns {Set<String>}
   */

  getLabels() {
    const labels = new Set();

    for (const record of this.records)
      labels.add(record.label || '');

    return labels;
  }

  encode() {
    const bw = bio.write(8192);
    this.write(bw, new Map());
    return bw.slice();
  }

  getSize(map) {
    let size = 1; // version byte
    let currentLabel = '';

    for (const rr of this.records) {
      const label = rr.label || '';

      if (label !== currentLabel) {
        size += 1 + sizeString(label); // LABEL type + string
        currentLabel = label;
      }

      size += 1 + rr.getSize(map);
    }

    return size;
  }

  write(bw, map) {
    bw.writeU8(0);

    let currentLabel = '';

    for (const rr of this.records) {
      const label = rr.label || '';

      if (label !== currentLabel) {
        bw.writeU8(hsTypes.LABEL);
        writeStringBW(bw, label);
        currentLabel = label;
      }

      bw.writeU8(rr.type);
      rr.write(bw, map);
    }

    return this;
  }

  read(br) {
    const version = br.readU8();

    if (version !== 0)
      throw new Error(`Unknown serialization version: ${version}.`);

    let currentLabel = '';

    while (br.left()) {
      const type = br.readU8();

      // Handle LABEL pseudo-record.
      if (type === hsTypes.LABEL) {
        currentLabel = readStringBR(br);
        continue;
      }

      const RD = typeToClass(type);

      // Break at unknown records.
      if (!RD)
        break;

      const record = RD.read(br);
      record.label = currentLabel;
      this.records.push(record);
    }

    return this;
  }

  /**
   * Filter records by type and optional label.
   * @param {Number} hsType
   * @param {String} [label='']
   * @returns {Array}
   */

  recordsByType(hsType, label = '') {
    const result = [];

    for (const record of this.records) {
      if (record.type !== hsType)
        continue;

      if ((record.label || '') !== label)
        continue;

      result.push(record);
    }

    return result;
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
    return this._toDNSByType(hsTypes.DS, name);
  }

  toTXT(name) {
    return this._toDNSByType(hsTypes.TXT, name);
  }

  toA(name, label = '') {
    return this._toDNSByType(hsTypes.A, name, label);
  }

  toAAAA(name, label = '') {
    return this._toDNSByType(hsTypes.AAAA, name, label);
  }

  toCNAME(name, label = '') {
    return this._toDNSByType(hsTypes.CNAME, name, label);
  }

  toDNAME(name, label = '') {
    return this._toDNSByType(hsTypes.DNAME, name, label);
  }

  toMX(name, label = '') {
    return this._toDNSByType(hsTypes.MX, name, label);
  }

  toSRV(name, label = '') {
    return this._toDNSByType(hsTypes.SRV, name, label);
  }

  toTLSA(name, label = '') {
    return this._toDNSByType(hsTypes.TLSA, name, label);
  }

  toSSHFP(name, label = '') {
    return this._toDNSByType(hsTypes.SSHFP, name, label);
  }

  toCAA(name, label = '') {
    return this._toDNSByType(hsTypes.CAA, name, label);
  }

  toSOA(name, label = '') {
    return this._toDNSByType(hsTypes.SOA, name, label);
  }

  toPTR(name, label = '') {
    return this._toDNSByType(hsTypes.PTR, name, label);
  }

  toNAPTR(name, label = '') {
    return this._toDNSByType(hsTypes.NAPTR, name, label);
  }

  toSMIMEA(name, label = '') {
    return this._toDNSByType(hsTypes.SMIMEA, name, label);
  }

  toOPENPGPKEY(name, label = '') {
    return this._toDNSByType(hsTypes.OPENPGPKEY, name, label);
  }

  toURI(name, label = '') {
    return this._toDNSByType(hsTypes.URI, name, label);
  }

  toLOC(name, label = '') {
    return this._toDNSByType(hsTypes.LOC, name, label);
  }

  toRP(name, label = '') {
    return this._toDNSByType(hsTypes.RP, name, label);
  }

  toRAW(name, label = '') {
    return this._toDNSByType(hsTypes.RAW, name, label);
  }

  /**
   * Convert records of a given hsType (and label) to DNS records.
   * @param {Number} hsType
   * @param {String} name - FQDN
   * @param {String} [label='']
   * @returns {Array<Record>}
   */

  _toDNSByType(hsType, name, label = '') {
    const answer = [];

    for (const record of this.records) {
      if (record.type !== hsType)
        continue;

      if ((record.label || '') !== label)
        continue;

      answer.push(record.toDNS(name, this.ttl));
    }

    return answer;
  }

  /**
   * Get all DNS records for a given label (subdomain).
   * @param {String} name - FQDN for the subdomain
   * @param {String} label - subdomain label
   * @returns {Array<Record>}
   */

  _allDNSForLabel(name, label) {
    const answer = [];

    for (const record of this.records) {
      if ((record.label || '') !== label)
        continue;

      answer.push(record.toDNS(name, this.ttl));
    }

    return answer;
  }

  toZone(name, sign = false) {
    const zone = [];
    const set = new Set();

    for (const record of this.records) {
      const recordName = labelName(name, record.label);
      const rr = record.toDNS(recordName, this.ttl);

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

  toReferral(name, type, isTLD) {
    const res = new Message();

    // no DS referrals for TLDs
    const badReferral = isTLD && type === types.DS;

    if (this.hasNS() && !badReferral) {
      res.authority = this.toNS(name).concat(this.toDS(name));

      res.additional = this.toGlue(name);

      if (this.hasDS()) {
        key.signZSK(res.authority, types.DS);
      } else {
        // unsigned zone proof
        res.authority.push(this.toNSEC(name));
        key.signZSK(res.authority, types.NSEC);
      }
    } else {
      // Needs SOA.
      res.aa = true;
      // negative answer proof
      res.authority.push(this.toNSEC(name));
      key.signZSK(res.authority, types.NSEC);
    }

    return res;
  }

  /**
   * Generate NSEC bitmap for records at a given label.
   * @param {String} name - FQDN
   * @param {String} [label=''] - subdomain label
   * @returns {Record}
   */

  toNSEC(name, label = '') {
    const dnsTypes = [types.RRSIG, types.NSEC];

    for (const record of this.records) {
      if ((record.label || '') !== label)
        continue;

      // For RAW records, use the stored DNS type directly.
      if (record.type === hsTypes.RAW) {
        if (!dnsTypes.includes(record.dnsType))
          dnsTypes.push(record.dnsType);
        continue;
      }

      const dnsType = hsToDNSType(record.type);

      if (dnsType && !dnsTypes.includes(dnsType))
        dnsTypes.push(dnsType);
    }

    const rd = new NSECRecord();
    rd.setTypes(dnsTypes);

    return nsec.create(name, nsec.nextName(name), rd.typeBitmap);
  }

  toDNS(name, type) {
    assert(util.isFQDN(name));
    assert((type >>> 0) === type);

    const labels = util.split(name);

    // Multi-label query (e.g. "www.example." or "_443._tcp.example.").
    if (labels.length > 1) {
      const tld = util.from(name, labels, -1);

      // If we have NS delegation, always refer (except for on-chain SLD).
      if (!this.hasNS()) {
        // Extract subdomain prefix.
        const tldPos = name.length - tld.length;
        const prefix = tldPos > 0
          ? name.slice(0, tldPos - 1)
          : '';

        if (prefix && this.hasLabel(prefix))
          return this._resolveLabel(tld, prefix, name, type);

        // No matching on-chain records for this subdomain.
        // Return authoritative negative answer (NODATA/NXDOMAIN).
        const res = new Message();
        res.aa = true;
        res.authority.push(this.toNSEC(name, prefix));
        key.signZSK(res.authority, types.NSEC);
        return res;
      }

      return this.toReferral(tld, type, false);
    }

    // TLD-level query.
    const res = new Message();

    // If a CNAME exists, return it for any query type (per RFC 1034).
    if (!this.hasNS() && this.hasType(hsTypes.CNAME) && type !== types.CNAME) {
      res.aa = true;
      res.answer = this.toCNAME(name);
      key.signZSK(res.answer, types.CNAME);
      return res;
    }

    switch (type) {
      case types.TXT:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toTXT(name);
          key.signZSK(res.answer, types.TXT);
        }
        break;
      case types.DS:
        res.aa = true;
        res.answer = this.toDS(name);
        key.signZSK(res.answer, types.DS);
        break;
      case types.A:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toA(name);
          key.signZSK(res.answer, types.A);
        }
        break;
      case types.AAAA:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toAAAA(name);
          key.signZSK(res.answer, types.AAAA);
        }
        break;
      case types.CNAME:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toCNAME(name);
          key.signZSK(res.answer, types.CNAME);
        }
        break;
      case types.DNAME:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toDNAME(name);
          key.signZSK(res.answer, types.DNAME);
        }
        break;
      case types.MX:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toMX(name);
          key.signZSK(res.answer, types.MX);
        }
        break;
      case types.SRV:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toSRV(name);
          key.signZSK(res.answer, types.SRV);
        }
        break;
      case types.TLSA:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toTLSA(name);
          key.signZSK(res.answer, types.TLSA);
        }
        break;
      case types.SSHFP:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toSSHFP(name);
          key.signZSK(res.answer, types.SSHFP);
        }
        break;
      case types.CAA:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toCAA(name);
          key.signZSK(res.answer, types.CAA);
        }
        break;
      case types.SOA:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toSOA(name);
          key.signZSK(res.answer, types.SOA);
        }
        break;
      case types.PTR:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toPTR(name);
          key.signZSK(res.answer, types.PTR);
        }
        break;
      case types.NAPTR:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toNAPTR(name);
          key.signZSK(res.answer, types.NAPTR);
        }
        break;
      case types.SMIMEA:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toSMIMEA(name);
          key.signZSK(res.answer, types.SMIMEA);
        }
        break;
      case types.OPENPGPKEY:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toOPENPGPKEY(name);
          key.signZSK(res.answer, types.OPENPGPKEY);
        }
        break;
      case types.URI:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toURI(name);
          key.signZSK(res.answer, types.URI);
        }
        break;
      case types.LOC:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toLOC(name);
          key.signZSK(res.answer, types.LOC);
        }
        break;
      case types.RP:
        if (!this.hasNS()) {
          res.aa = true;
          res.answer = this.toRP(name);
          key.signZSK(res.answer, types.RP);
        }
        break;
      default:
        // Handle RAW and any unknown query types.
        if (!this.hasNS()) {
          const raws = this.toRAW(name);
          const matching = raws.filter(rr => rr.type === type);

          if (matching.length > 0) {
            res.aa = true;
            res.answer = matching;
            key.signZSK(res.answer, type);
          }
        }
        break;
    }

    // Nope, we may need a referral.
    if (res.answer.length === 0 && res.authority.length === 0) {
      return this.toReferral(name, type, true);
    }

    return res;
  }

  /**
   * Resolve a query for a subdomain label.
   * @param {String} tld - TLD FQDN (e.g. "example.")
   * @param {String} label - subdomain prefix (e.g. "www" or "_443._tcp")
   * @param {String} fqdn - full query name (e.g. "www.example.")
   * @param {Number} type - DNS query type
   * @returns {Message}
   */

  _resolveLabel(tld, label, fqdn, type) {
    const res = new Message();
    res.aa = true;

    // Collect matching records for this label and type.
    const answer = [];

    for (const record of this.records) {
      if ((record.label || '') !== label)
        continue;

      // For RAW, check if the DNS type matches.
      if (record.type === hsTypes.RAW) {
        const rr = record.toDNS(fqdn, this.ttl);
        if (rr.type === type)
          answer.push(rr);
        continue;
      }

      const dnsType = hsToDNSType(record.type);

      if (dnsType === type)
        answer.push(record.toDNS(fqdn, this.ttl));
    }

    // Check for CNAME at this label (returned for any query type).
    if (answer.length === 0 && type !== types.CNAME) {
      const cnames = this._toDNSByType(hsTypes.CNAME, fqdn, label);

      if (cnames.length > 0) {
        res.answer = cnames;
        key.signZSK(res.answer, types.CNAME);
        return res;
      }
    }

    if (answer.length > 0) {
      res.answer = answer;
      key.signZSK(res.answer, type);
    } else {
      // NODATA: type doesn't exist at this label.
      res.authority.push(this.toNSEC(fqdn, label));
      key.signZSK(res.authority, types.NSEC);
    }

    return res;
  }

  getJSON(name) {
    const json = { records: [] };

    for (const record of this.records) {
      const rj = record.getJSON();

      if (record.label)
        rj.name = record.label;

      json.records.push(rj);
    }

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

      const record = RD.fromJSON(item);
      record.label = item.name || '';
      this.records.push(record);
    }

    // Sort: unlabeled (TLD) records first for backwards compatibility.
    // Old nodes break on first unknown type (LABEL), so TLD records
    // must precede any labeled records.
    this.records.sort((a, b) => {
      const la = a.label || '';
      const lb = b.label || '';

      if (la === '' && lb !== '') return -1;
      if (la !== '' && lb === '') return 1;
      if (la < lb) return -1;
      if (la > lb) return 1;
      return 0;
    });

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

/**
 * A
 * @extends {Struct}
 */

class A extends Struct {
  constructor() {
    super();
    this.address = '0.0.0.0';
  }

  get type() {
    return hsTypes.A;
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
    return createA(name, ttl, this.address);
  }

  getJSON() {
    return {
      type: 'A',
      address: this.address
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid A record.');
    assert(json.type === 'A',
      'Invalid A record. Type must be "A".');
    assert(IP.isIPv4String(json.address),
      'Invalid A record. Address must be a valid IPv4 address.');

    this.address = IP.normalize(json.address);

    return this;
  }
}

/**
 * AAAA
 * @extends {Struct}
 */

class AAAA extends Struct {
  constructor() {
    super();
    this.address = '::';
  }

  get type() {
    return hsTypes.AAAA;
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
    return createAAAA(name, ttl, this.address);
  }

  getJSON() {
    return {
      type: 'AAAA',
      address: this.address
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid AAAA record.');
    assert(json.type === 'AAAA',
      'Invalid AAAA record. Type must be "AAAA".');
    assert(IP.isIPv6String(json.address),
      'Invalid AAAA record. Address must be a valid IPv6 address.');

    this.address = IP.normalize(json.address);

    return this;
  }
}

/**
 * CNAME
 * @extends {Struct}
 */

class CNAME extends Struct {
  constructor() {
    super();
    this.target = '.';
  }

  get type() {
    return hsTypes.CNAME;
  }

  getSize(map) {
    return sizeName(this.target, map);
  }

  write(bw, map) {
    writeNameBW(bw, this.target, map);
    return this;
  }

  read(br) {
    this.target = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new CNAMERecord();

    rr.name = name;
    rr.type = types.CNAME;
    rr.ttl = ttl;
    rr.data = rd;
    rd.target = this.target;

    return rr;
  }

  getJSON() {
    return {
      type: 'CNAME',
      target: this.target
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid CNAME record.');
    assert(json.type === 'CNAME',
      'Invalid CNAME record. Type must be "CNAME".');
    assert(isName(json.target),
      'Invalid CNAME record. target must be a valid name.');

    this.target = json.target;

    return this;
  }
}

/**
 * DNAME
 * @extends {Struct}
 */

class DNAME extends Struct {
  constructor() {
    super();
    this.target = '.';
  }

  get type() {
    return hsTypes.DNAME;
  }

  getSize(map) {
    return sizeName(this.target, map);
  }

  write(bw, map) {
    writeNameBW(bw, this.target, map);
    return this;
  }

  read(br) {
    this.target = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new DNAMERecord();

    rr.name = name;
    rr.type = types.DNAME;
    rr.ttl = ttl;
    rr.data = rd;
    rd.target = this.target;

    return rr;
  }

  getJSON() {
    return {
      type: 'DNAME',
      target: this.target
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid DNAME record.');
    assert(json.type === 'DNAME',
      'Invalid DNAME record. Type must be "DNAME".');
    assert(isName(json.target),
      'Invalid DNAME record. target must be a valid name.');

    this.target = json.target;

    return this;
  }
}

/**
 * PTR
 * @extends {Struct}
 */

class PTR extends Struct {
  constructor() {
    super();
    this.target = '.';
  }

  get type() {
    return hsTypes.PTR;
  }

  getSize(map) {
    return sizeName(this.target, map);
  }

  write(bw, map) {
    writeNameBW(bw, this.target, map);
    return this;
  }

  read(br) {
    this.target = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new PTRRecord();

    rr.name = name;
    rr.type = types.PTR;
    rr.ttl = ttl;
    rr.data = rd;
    rd.target = this.target;

    return rr;
  }

  getJSON() {
    return {
      type: 'PTR',
      target: this.target
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid PTR record.');
    assert(json.type === 'PTR',
      'Invalid PTR record. Type must be "PTR".');
    assert(isName(json.target),
      'Invalid PTR record. target must be a valid name.');

    this.target = json.target;

    return this;
  }
}

/**
 * MX
 * @extends {Struct}
 */

class MX extends Struct {
  constructor() {
    super();
    this.preference = 0;
    this.mx = '.';
  }

  get type() {
    return hsTypes.MX;
  }

  getSize(map) {
    return 2 + sizeName(this.mx, map);
  }

  write(bw, map) {
    bw.writeU16BE(this.preference);
    writeNameBW(bw, this.mx, map);
    return this;
  }

  read(br) {
    this.preference = br.readU16BE();
    this.mx = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new MXRecord();

    rr.name = name;
    rr.type = types.MX;
    rr.ttl = ttl;
    rr.data = rd;
    rd.preference = this.preference;
    rd.mx = this.mx;

    return rr;
  }

  getJSON() {
    return {
      type: 'MX',
      preference: this.preference,
      mx: this.mx
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid MX record.');
    assert(json.type === 'MX',
      'Invalid MX record. Type must be "MX".');
    assert((json.preference & 0xffff) === json.preference,
      'Invalid MX record. preference must be a uint16.');
    assert(isName(json.mx),
      'Invalid MX record. mx must be a valid name.');

    this.preference = json.preference;
    this.mx = json.mx;

    return this;
  }
}

/**
 * SRV
 * @extends {Struct}
 */

class SRV extends Struct {
  constructor() {
    super();
    this.priority = 0;
    this.weight = 0;
    this.port = 0;
    this.target = '.';
  }

  get type() {
    return hsTypes.SRV;
  }

  getSize(map) {
    return 6 + sizeName(this.target, map);
  }

  write(bw, map) {
    bw.writeU16BE(this.priority);
    bw.writeU16BE(this.weight);
    bw.writeU16BE(this.port);
    writeNameBW(bw, this.target, map);
    return this;
  }

  read(br) {
    this.priority = br.readU16BE();
    this.weight = br.readU16BE();
    this.port = br.readU16BE();
    this.target = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new SRVRecord();

    rr.name = name;
    rr.type = types.SRV;
    rr.ttl = ttl;
    rr.data = rd;
    rd.priority = this.priority;
    rd.weight = this.weight;
    rd.port = this.port;
    rd.target = this.target;

    return rr;
  }

  getJSON() {
    return {
      type: 'SRV',
      priority: this.priority,
      weight: this.weight,
      port: this.port,
      target: this.target
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid SRV record.');
    assert(json.type === 'SRV',
      'Invalid SRV record. Type must be "SRV".');
    assert((json.priority & 0xffff) === json.priority,
      'Invalid SRV record. priority must be a uint16.');
    assert((json.weight & 0xffff) === json.weight,
      'Invalid SRV record. weight must be a uint16.');
    assert((json.port & 0xffff) === json.port,
      'Invalid SRV record. port must be a uint16.');
    assert(isName(json.target),
      'Invalid SRV record. target must be a valid name.');

    this.priority = json.priority;
    this.weight = json.weight;
    this.port = json.port;
    this.target = json.target;

    return this;
  }
}

/**
 * TLSA
 * @extends {Struct}
 */

class TLSA extends Struct {
  constructor() {
    super();
    this.usage = 0;
    this.selector = 0;
    this.matchingType = 0;
    this.certificate = DUMMY;
  }

  get type() {
    return hsTypes.TLSA;
  }

  getSize() {
    return 4 + this.certificate.length;
  }

  write(bw) {
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return this;
  }

  read(br) {
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new TLSARecord();

    rr.name = name;
    rr.type = types.TLSA;
    rr.ttl = ttl;
    rr.data = rd;
    rd.usage = this.usage;
    rd.selector = this.selector;
    rd.matchingType = this.matchingType;
    rd.certificate = this.certificate;

    return rr;
  }

  getJSON() {
    return {
      type: 'TLSA',
      usage: this.usage,
      selector: this.selector,
      matchingType: this.matchingType,
      certificate: this.certificate.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid TLSA record.');
    assert(json.type === 'TLSA',
      'Invalid TLSA record. Type must be "TLSA".');
    assert((json.usage & 0xff) === json.usage,
      'Invalid TLSA record. usage must be a uint8.');
    assert((json.selector & 0xff) === json.selector,
      'Invalid TLSA record. selector must be a uint8.');
    assert((json.matchingType & 0xff) === json.matchingType,
      'Invalid TLSA record. matchingType must be a uint8.');
    assert(typeof json.certificate === 'string',
      'Invalid TLSA record. certificate must be a String.');
    assert((json.certificate.length >>> 1) <= 255,
      'Invalid TLSA record. certificate is too large.');

    this.usage = json.usage;
    this.selector = json.selector;
    this.matchingType = json.matchingType;
    this.certificate = util.parseHex(json.certificate);

    return this;
  }
}

/**
 * SSHFP
 * @extends {Struct}
 */

class SSHFP extends Struct {
  constructor() {
    super();
    this.algorithm = 0;
    this.digestType = 0;
    this.fingerprint = DUMMY;
  }

  get type() {
    return hsTypes.SSHFP;
  }

  getSize() {
    return 3 + this.fingerprint.length;
  }

  write(bw) {
    bw.writeU8(this.algorithm);
    bw.writeU8(this.digestType);
    bw.writeU8(this.fingerprint.length);
    bw.writeBytes(this.fingerprint);
    return this;
  }

  read(br) {
    this.algorithm = br.readU8();
    this.digestType = br.readU8();
    this.fingerprint = br.readBytes(br.readU8());
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new SSHFPRecord();

    rr.name = name;
    rr.type = types.SSHFP;
    rr.ttl = ttl;
    rr.data = rd;
    rd.algorithm = this.algorithm;
    rd.digestType = this.digestType;
    rd.fingerprint = this.fingerprint;

    return rr;
  }

  getJSON() {
    return {
      type: 'SSHFP',
      algorithm: this.algorithm,
      digestType: this.digestType,
      fingerprint: this.fingerprint.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid SSHFP record.');
    assert(json.type === 'SSHFP',
      'Invalid SSHFP record. Type must be "SSHFP".');
    assert((json.algorithm & 0xff) === json.algorithm,
      'Invalid SSHFP record. algorithm must be a uint8.');
    assert((json.digestType & 0xff) === json.digestType,
      'Invalid SSHFP record. digestType must be a uint8.');
    assert(typeof json.fingerprint === 'string',
      'Invalid SSHFP record. fingerprint must be a String.');
    assert((json.fingerprint.length >>> 1) <= 255,
      'Invalid SSHFP record. fingerprint is too large.');

    this.algorithm = json.algorithm;
    this.digestType = json.digestType;
    this.fingerprint = util.parseHex(json.fingerprint);

    return this;
  }
}

/**
 * CAA
 * @extends {Struct}
 */

class CAA extends Struct {
  constructor() {
    super();
    this.flags = 0;
    this.tag = '';
    this.value = '';
  }

  get type() {
    return hsTypes.CAA;
  }

  getSize() {
    return 1 + sizeString(this.tag) + sizeString(this.value);
  }

  write(bw) {
    bw.writeU8(this.flags);
    writeStringBW(bw, this.tag);
    writeStringBW(bw, this.value);
    return this;
  }

  read(br) {
    this.flags = br.readU8();
    this.tag = readStringBR(br);
    this.value = readStringBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new CAARecord();

    rr.name = name;
    rr.type = types.CAA;
    rr.ttl = ttl;
    rr.data = rd;
    rd.flags = this.flags;
    rd.tag = this.tag;
    rd.value = this.value;

    return rr;
  }

  getJSON() {
    return {
      type: 'CAA',
      flags: this.flags,
      tag: this.tag,
      value: this.value
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid CAA record.');
    assert(json.type === 'CAA',
      'Invalid CAA record. Type must be "CAA".');
    assert((json.flags & 0xff) === json.flags,
      'Invalid CAA record. flags must be a uint8.');
    assert(typeof json.tag === 'string',
      'Invalid CAA record. tag must be a String.');
    assert(json.tag.length <= 255,
      'Invalid CAA record. tag is too large.');
    assert(typeof json.value === 'string',
      'Invalid CAA record. value must be a String.');
    assert(json.value.length <= 255,
      'Invalid CAA record. value is too large.');

    this.flags = json.flags;
    this.tag = json.tag;
    this.value = json.value;

    return this;
  }
}

/**
 * SOA
 * @extends {Struct}
 */

class SOA extends Struct {
  constructor() {
    super();
    this.ns = '.';
    this.mbox = '.';
    this.serial = 0;
    this.refresh = 0;
    this.retry = 0;
    this.expire = 0;
    this.minimum = 0;
  }

  get type() {
    return hsTypes.SOA;
  }

  getSize(map) {
    return sizeName(this.ns, map) + sizeName(this.mbox, map) + 20;
  }

  write(bw, map) {
    writeNameBW(bw, this.ns, map);
    writeNameBW(bw, this.mbox, map);
    bw.writeU32BE(this.serial);
    bw.writeU32BE(this.refresh);
    bw.writeU32BE(this.retry);
    bw.writeU32BE(this.expire);
    bw.writeU32BE(this.minimum);
    return this;
  }

  read(br) {
    this.ns = readNameBR(br);
    this.mbox = readNameBR(br);
    this.serial = br.readU32BE();
    this.refresh = br.readU32BE();
    this.retry = br.readU32BE();
    this.expire = br.readU32BE();
    this.minimum = br.readU32BE();
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new SOARecord();

    rr.name = name;
    rr.type = types.SOA;
    rr.ttl = ttl;
    rr.data = rd;
    rd.ns = this.ns;
    rd.mbox = this.mbox;
    rd.serial = this.serial;
    rd.refresh = this.refresh;
    rd.retry = this.retry;
    rd.expire = this.expire;
    rd.minimum = this.minimum;

    return rr;
  }

  getJSON() {
    return {
      type: 'SOA',
      ns: this.ns,
      mbox: this.mbox,
      serial: this.serial,
      refresh: this.refresh,
      retry: this.retry,
      expire: this.expire,
      minimum: this.minimum
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid SOA record.');
    assert(json.type === 'SOA',
      'Invalid SOA record. Type must be "SOA".');
    assert(isName(json.ns),
      'Invalid SOA record. ns must be a valid name.');
    assert(isName(json.mbox),
      'Invalid SOA record. mbox must be a valid name.');
    assert((json.serial >>> 0) === json.serial,
      'Invalid SOA record. serial must be a uint32.');
    assert((json.refresh >>> 0) === json.refresh,
      'Invalid SOA record. refresh must be a uint32.');
    assert((json.retry >>> 0) === json.retry,
      'Invalid SOA record. retry must be a uint32.');
    assert((json.expire >>> 0) === json.expire,
      'Invalid SOA record. expire must be a uint32.');
    assert((json.minimum >>> 0) === json.minimum,
      'Invalid SOA record. minimum must be a uint32.');

    this.ns = json.ns;
    this.mbox = json.mbox;
    this.serial = json.serial;
    this.refresh = json.refresh;
    this.retry = json.retry;
    this.expire = json.expire;
    this.minimum = json.minimum;

    return this;
  }
}

/**
 * NAPTR
 * @extends {Struct}
 */

class NAPTR extends Struct {
  constructor() {
    super();
    this.order = 0;
    this.preference = 0;
    this.flags = '';
    this.service = '';
    this.regexp = '';
    this.replacement = '.';
  }

  get type() {
    return hsTypes.NAPTR;
  }

  getSize(map) {
    return 4
      + sizeString(this.flags)
      + sizeString(this.service)
      + sizeString(this.regexp)
      + sizeName(this.replacement, map);
  }

  write(bw, map) {
    bw.writeU16BE(this.order);
    bw.writeU16BE(this.preference);
    writeStringBW(bw, this.flags);
    writeStringBW(bw, this.service);
    writeStringBW(bw, this.regexp);
    writeNameBW(bw, this.replacement, map);
    return this;
  }

  read(br) {
    this.order = br.readU16BE();
    this.preference = br.readU16BE();
    this.flags = readStringBR(br);
    this.service = readStringBR(br);
    this.regexp = readStringBR(br);
    this.replacement = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new NAPTRRecord();

    rr.name = name;
    rr.type = types.NAPTR;
    rr.ttl = ttl;
    rr.data = rd;
    rd.order = this.order;
    rd.preference = this.preference;
    rd.flags = this.flags;
    rd.service = this.service;
    rd.regexp = this.regexp;
    rd.replacement = this.replacement;

    return rr;
  }

  getJSON() {
    return {
      type: 'NAPTR',
      order: this.order,
      preference: this.preference,
      flags: this.flags,
      service: this.service,
      regexp: this.regexp,
      replacement: this.replacement
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid NAPTR record.');
    assert(json.type === 'NAPTR',
      'Invalid NAPTR record. Type must be "NAPTR".');
    assert((json.order & 0xffff) === json.order,
      'Invalid NAPTR record. order must be a uint16.');
    assert((json.preference & 0xffff) === json.preference,
      'Invalid NAPTR record. preference must be a uint16.');
    assert(typeof json.flags === 'string',
      'Invalid NAPTR record. flags must be a String.');
    assert(json.flags.length <= 255,
      'Invalid NAPTR record. flags is too large.');
    assert(typeof json.service === 'string',
      'Invalid NAPTR record. service must be a String.');
    assert(json.service.length <= 255,
      'Invalid NAPTR record. service is too large.');
    assert(typeof json.regexp === 'string',
      'Invalid NAPTR record. regexp must be a String.');
    assert(json.regexp.length <= 255,
      'Invalid NAPTR record. regexp is too large.');
    assert(isName(json.replacement),
      'Invalid NAPTR record. replacement must be a valid name.');

    this.order = json.order;
    this.preference = json.preference;
    this.flags = json.flags;
    this.service = json.service;
    this.regexp = json.regexp;
    this.replacement = json.replacement;

    return this;
  }
}

/**
 * SMIMEA
 * @extends {Struct}
 */

class SMIMEA extends Struct {
  constructor() {
    super();
    this.usage = 0;
    this.selector = 0;
    this.matchingType = 0;
    this.certificate = DUMMY;
  }

  get type() {
    return hsTypes.SMIMEA;
  }

  getSize() {
    return 4 + this.certificate.length;
  }

  write(bw) {
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return this;
  }

  read(br) {
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new SMIMEARecord();

    rr.name = name;
    rr.type = types.SMIMEA;
    rr.ttl = ttl;
    rr.data = rd;
    rd.usage = this.usage;
    rd.selector = this.selector;
    rd.matchingType = this.matchingType;
    rd.certificate = this.certificate;

    return rr;
  }

  getJSON() {
    return {
      type: 'SMIMEA',
      usage: this.usage,
      selector: this.selector,
      matchingType: this.matchingType,
      certificate: this.certificate.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid SMIMEA record.');
    assert(json.type === 'SMIMEA',
      'Invalid SMIMEA record. Type must be "SMIMEA".');
    assert((json.usage & 0xff) === json.usage,
      'Invalid SMIMEA record. usage must be a uint8.');
    assert((json.selector & 0xff) === json.selector,
      'Invalid SMIMEA record. selector must be a uint8.');
    assert((json.matchingType & 0xff) === json.matchingType,
      'Invalid SMIMEA record. matchingType must be a uint8.');
    assert(typeof json.certificate === 'string',
      'Invalid SMIMEA record. certificate must be a String.');
    assert((json.certificate.length >>> 1) <= 255,
      'Invalid SMIMEA record. certificate is too large.');

    this.usage = json.usage;
    this.selector = json.selector;
    this.matchingType = json.matchingType;
    this.certificate = util.parseHex(json.certificate);

    return this;
  }
}

/**
 * OPENPGPKEY
 * @extends {Struct}
 */

class OPENPGPKEY extends Struct {
  constructor() {
    super();
    this.publicKey = DUMMY;
  }

  get type() {
    return hsTypes.OPENPGPKEY;
  }

  getSize() {
    return 2 + this.publicKey.length;
  }

  write(bw) {
    bw.writeU16BE(this.publicKey.length);
    bw.writeBytes(this.publicKey);
    return this;
  }

  read(br) {
    this.publicKey = br.readBytes(br.readU16BE());
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new OPENPGPKEYRecord();

    rr.name = name;
    rr.type = types.OPENPGPKEY;
    rr.ttl = ttl;
    rr.data = rd;
    rd.publicKey = this.publicKey;

    return rr;
  }

  getJSON() {
    return {
      type: 'OPENPGPKEY',
      publicKey: this.publicKey.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid OPENPGPKEY record.');
    assert(json.type === 'OPENPGPKEY',
      'Invalid OPENPGPKEY record. Type must be "OPENPGPKEY".');
    assert(typeof json.publicKey === 'string',
      'Invalid OPENPGPKEY record. publicKey must be a String.');
    assert((json.publicKey.length >>> 1) <= 65535,
      'Invalid OPENPGPKEY record. publicKey is too large.');

    this.publicKey = util.parseHex(json.publicKey);

    return this;
  }
}

/**
 * URI
 * @extends {Struct}
 */

class URI extends Struct {
  constructor() {
    super();
    this.priority = 0;
    this.weight = 0;
    this.target = '';
  }

  get type() {
    return hsTypes.URI;
  }

  getSize() {
    return 4 + sizeString(this.target);
  }

  write(bw) {
    bw.writeU16BE(this.priority);
    bw.writeU16BE(this.weight);
    writeStringBW(bw, this.target);
    return this;
  }

  read(br) {
    this.priority = br.readU16BE();
    this.weight = br.readU16BE();
    this.target = readStringBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new URIRecord();

    rr.name = name;
    rr.type = types.URI;
    rr.ttl = ttl;
    rr.data = rd;
    rd.priority = this.priority;
    rd.weight = this.weight;
    rd.target = this.target;

    return rr;
  }

  getJSON() {
    return {
      type: 'URI',
      priority: this.priority,
      weight: this.weight,
      target: this.target
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid URI record.');
    assert(json.type === 'URI',
      'Invalid URI record. Type must be "URI".');
    assert((json.priority & 0xffff) === json.priority,
      'Invalid URI record. priority must be a uint16.');
    assert((json.weight & 0xffff) === json.weight,
      'Invalid URI record. weight must be a uint16.');
    assert(typeof json.target === 'string',
      'Invalid URI record. target must be a String.');
    assert(json.target.length <= 255,
      'Invalid URI record. target is too large.');

    this.priority = json.priority;
    this.weight = json.weight;
    this.target = json.target;

    return this;
  }
}

/**
 * LOC
 * @extends {Struct}
 */

class LOC extends Struct {
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

  get type() {
    return hsTypes.LOC;
  }

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

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new LOCRecord();

    rr.name = name;
    rr.type = types.LOC;
    rr.ttl = ttl;
    rr.data = rd;
    rd.version = this.version;
    rd.size = this.size;
    rd.horizPre = this.horizPre;
    rd.vertPre = this.vertPre;
    rd.latitude = this.latitude;
    rd.longitude = this.longitude;
    rd.altitude = this.altitude;

    return rr;
  }

  getJSON() {
    return {
      type: 'LOC',
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
    assert(json && typeof json === 'object', 'Invalid LOC record.');
    assert(json.type === 'LOC',
      'Invalid LOC record. Type must be "LOC".');
    assert((json.version & 0xff) === json.version,
      'Invalid LOC record. version must be a uint8.');
    assert((json.size & 0xff) === json.size,
      'Invalid LOC record. size must be a uint8.');
    assert((json.horizPre & 0xff) === json.horizPre,
      'Invalid LOC record. horizPre must be a uint8.');
    assert((json.vertPre & 0xff) === json.vertPre,
      'Invalid LOC record. vertPre must be a uint8.');
    assert((json.latitude >>> 0) === json.latitude,
      'Invalid LOC record. latitude must be a uint32.');
    assert((json.longitude >>> 0) === json.longitude,
      'Invalid LOC record. longitude must be a uint32.');
    assert((json.altitude >>> 0) === json.altitude,
      'Invalid LOC record. altitude must be a uint32.');

    this.version = json.version;
    this.size = json.size;
    this.horizPre = json.horizPre;
    this.vertPre = json.vertPre;
    this.latitude = json.latitude;
    this.longitude = json.longitude;
    this.altitude = json.altitude;

    return this;
  }
}

/**
 * RP
 * @extends {Struct}
 */

class RP extends Struct {
  constructor() {
    super();
    this.mbox = '.';
    this.txt = '.';
  }

  get type() {
    return hsTypes.RP;
  }

  getSize(map) {
    return sizeName(this.mbox, map) + sizeName(this.txt, map);
  }

  write(bw, map) {
    writeNameBW(bw, this.mbox, map);
    writeNameBW(bw, this.txt, map);
    return this;
  }

  read(br) {
    this.mbox = readNameBR(br);
    this.txt = readNameBR(br);
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new RPRecord();

    rr.name = name;
    rr.type = types.RP;
    rr.ttl = ttl;
    rr.data = rd;
    rd.mbox = this.mbox;
    rd.txt = this.txt;

    return rr;
  }

  getJSON() {
    return {
      type: 'RP',
      mbox: this.mbox,
      txt: this.txt
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid RP record.');
    assert(json.type === 'RP',
      'Invalid RP record. Type must be "RP".');
    assert(isName(json.mbox),
      'Invalid RP record. mbox must be a valid name.');
    assert(isName(json.txt),
      'Invalid RP record. txt must be a valid name.');

    this.mbox = json.mbox;
    this.txt = json.txt;

    return this;
  }
}

/**
 * RAW - Generic record for arbitrary DNS types.
 * Stores raw DNS rdata for any record type, including
 * future types not yet defined.
 * @extends {Struct}
 */

class RAW extends Struct {
  constructor() {
    super();
    this.dnsType = 0;
    this.data = DUMMY;
  }

  get type() {
    return hsTypes.RAW;
  }

  getSize() {
    return 4 + this.data.length;
  }

  write(bw) {
    bw.writeU16BE(this.dnsType);
    bw.writeU16BE(this.data.length);
    bw.writeBytes(this.data);
    return this;
  }

  read(br) {
    this.dnsType = br.readU16BE();
    this.data = br.readBytes(br.readU16BE());
    return this;
  }

  toDNS(name = '.', ttl = DEFAULT_TTL) {
    assert(util.isFQDN(name));
    assert((ttl >>> 0) === ttl);

    const rr = new Record();
    const rd = new UNKNOWNRecord();

    rr.name = name;
    rr.type = this.dnsType;
    rr.ttl = ttl;
    rr.data = rd;
    rd.data = this.data;

    return rr;
  }

  getJSON() {
    return {
      type: 'RAW',
      dnsType: this.dnsType,
      data: this.data.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object', 'Invalid RAW record.');
    assert(json.type === 'RAW',
      'Invalid RAW record. Type must be "RAW".');
    assert((json.dnsType & 0xffff) === json.dnsType,
      'Invalid RAW record. dnsType must be a uint16.');
    assert(typeof json.data === 'string',
      'Invalid RAW record. data must be a hex String.');
    assert((json.data.length >>> 1) <= 65535,
      'Invalid RAW record. data is too large.');

    this.dnsType = json.dnsType;
    this.data = util.parseHex(json.data);

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
    case hsTypes.A:
      return A;
    case hsTypes.AAAA:
      return AAAA;
    case hsTypes.CNAME:
      return CNAME;
    case hsTypes.DNAME:
      return DNAME;
    case hsTypes.MX:
      return MX;
    case hsTypes.SRV:
      return SRV;
    case hsTypes.TLSA:
      return TLSA;
    case hsTypes.SSHFP:
      return SSHFP;
    case hsTypes.CAA:
      return CAA;
    case hsTypes.SOA:
      return SOA;
    case hsTypes.PTR:
      return PTR;
    case hsTypes.NAPTR:
      return NAPTR;
    case hsTypes.SMIMEA:
      return SMIMEA;
    case hsTypes.OPENPGPKEY:
      return OPENPGPKEY;
    case hsTypes.URI:
      return URI;
    case hsTypes.LOC:
      return LOC;
    case hsTypes.RP:
      return RP;
    case hsTypes.RAW:
      return RAW;
    default:
      return null;
  }
}

function stringToClass(type) {
  assert(typeof type === 'string');

  if (!Object.prototype.hasOwnProperty.call(hsTypes, type))
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

exports.Resource = Resource;
exports.DS = DS;
exports.NS = NS;
exports.GLUE4 = GLUE4;
exports.GLUE6 = GLUE6;
exports.SYNTH4 = SYNTH4;
exports.SYNTH6 = SYNTH6;
exports.TXT = TXT;
exports.A = A;
exports.AAAA = AAAA;
exports.CNAME = CNAME;
exports.DNAME = DNAME;
exports.MX = MX;
exports.SRV = SRV;
exports.TLSA = TLSA;
exports.SSHFP = SSHFP;
exports.CAA = CAA;
exports.SOA = SOA;
exports.PTR = PTR;
exports.NAPTR = NAPTR;
exports.SMIMEA = SMIMEA;
exports.OPENPGPKEY = OPENPGPKEY;
exports.URI = URI;
exports.LOC = LOC;
exports.RP = RP;
exports.RAW = RAW;
