'use strict';

const assert = require('assert');
const bns = require('bns');
const {onion, IP} = require('binet');
const {base58} = require('bstring');
const Address = require('../primitives/address');
const ICANN = 'icann';
const HSK = 'hsk';
const ICANNP = `.${ICANN}`;
const ICANNS = `${ICANN}.`;
const HSKP = `.${HSK}`;
const HSKS = `${HSK}.`;
const DATA = Buffer.alloc(0);

const {
  DNSServer,
  RecursiveResolver,
  wire,
  util
} = bns;

const {
  Question,
  Message,
  Record,
  RecordData,
  ARecord,
  AAAARecord,
  NSRecord,
  SOARecord,
  CNAMERecord,
  DNAMERecord,
  types
} = wire;

const rtypes = {
  INET4: 1,
  INET6: 2,
  ONION: 3,
  ONIONNG: 5,
  INAME: 6,
  HNAME: 7,

  CANONICAL: 8,
  DELEGATE: 9,
  NS: 10,
  SERVICE: 11,
  URL: 12,
  EMAIL: 12,
  TEXT: 13,
  LOCATION: 14,
  MAGNET: 15,
  DS: 16,
  TLS: 17,
  SSH: 18,
  PGP: 19,
  ADDR: 20
};

class Extra extends RecordData {
  constructor() {
    this.type = 0;
    this.data = DUMMY;
  }

  getSize() {
    return 2 + this.data.length;
  }

  toWriter(bw) {
    bw.writeU8(this.type);
    bw.writeU8(this.data.length);
    bw.writeBytes(this.data);
    return bw;
  }

  fromReader(br) {
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
}

class Addr extends RecordData {
  constructor() {
    this.currency = '';
    this.address = '';
  }

  getSize() {
    if (this.currency === 'hsk') {
      const addr = Address.fromString(this.address);
      return 2 + addr.hash.length;
    }
    return 1 + this.currency.length + 1 + this.address.length;
  }

  toWriter(bw) {
    if (this.currency === 'hsk') {
      const addr = Address.fromString(this.address);
      const mid = this.address[0] === 't' ? 0x40 : 0x00;
      bw.writeU8(0x80 | mid | addr.hash.length);
      bw.writeU8(addr.version);
      bw.writeBytes(addr.hash);
      return bw;
    }
    bw.writeU8(this.currency.length);
    bw.writeString(this.currency, 'ascii');
    bw.writeU8(this.address.length);
    bw.writeString(this.address, 'ascii');
    return bw;
  }

  fromReader(br) {
    let len = br.readU8();

    const hsk = (len & 0x80) !== 0;
    const test = (len & 0x40) !== 0;

    if (hsk) {
      len &= 0x3f;

      const addr = new Address();
      addr.version = br.readU8();
      addr.hash = br.readBytes(len);

      this.currency = 'hsk';
      this.address = addr.toString(test ? 'testnet' : 'main');

      return this;
    }

    this.currency = br.readString('ascii', br.readU8());
    this.address = br.readString('ascii', br.readU8());

    return this;
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
    assert(currency.length <= 0x3f);
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
}

class SSH extends RecordData {
  constructor() {
    super();
    this.algorithm = 0;
    this.type = 0;
    this.fingerprint = DUMMY;
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
}

class PGP extends SSH {
  constructor() {
    super();
  }
}

class TLS extends RecordData {
  constructor() {
    super();
    this.usage = 0;
    this.selector = 0;
    this.matchingType = 0;
    this.certificate = DUMMY;
  }

  getSize() {
    return 3 + 1 + this.certificate.length;
  }

  toWriter(bw) {
    bw.writeU8(this.usage);
    bw.writeU8(this.selector);
    bw.writeU8(this.matchingType);
    bw.writeU8(this.certificate.length);
    bw.writeBytes(this.certificate);
    return bw;
  }

  fromReader(br) {
    this.usage = br.readU8();
    this.selector = br.readU8();
    this.matchingType = br.readU8();
    this.certificate = br.readBytes(br.readU8());
    return this;
  }

  toJSON() {
    return {
      usage: this.usage,
      selector: this.selector,
      matchingType: this.matchingType,
      certificate: this.certificate.toString('hex')
    };
  }

  fromJSON(json) {
    assert(json && typeof json === 'object');
    assert((json.usage & 0xff) === json.usage);
    assert((json.selector & 0xff) === json.selector);
    assert((json.matchingType & 0xff) === json.matchingType);
    assert(typeof json.fingerprint === 'string');
    assert((json.fingerprint >>> 1) <= 255);
    this.usage = json.usage;
    this.selector = json.selector;
    this.matchingType = json.matchingType;
    this.certificate = Buffer.from(json.certificate, 'hex');
    return this;
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
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
  constructor() {
    super();
    this.nid = '';
    this.nin = '';
  }

  getSize() {
    let size = 0;
    size += 1 + this.nid.length;
    size += 1 + (this.nin.length >>> 2);
    return size;
  }

  toWriter(bw) {
    bw.writeU8(this.nid.length);
    bw.writeString(this.nid, 'ascii');
    bw.writeU8(this.nin.length >>> 1);
    bw.writeString(this.nin, 'hex');
    return bw;
  }

  fromReader(br) {
    this.nid = br.readString('ascii', br.readU8());
    this.nin = br.readString('hex', br.readU8());
    return this;
  }

  toString() {
    return `magnet:?xt=urn:${this.nid}:${this.nin}`;
  }

  fromString(str) {
    assert(typeof str === 'string');
    assert(str.length <= 512);
    const index = str.indexOf('xt=urn:');
    assert(index !== -1);
    assert(index !== 0);
    assert(str[index - 1] === '?' || str[index - 1] === '&');
    str = str.substring(index + 7);
    const parts = str.split(/[:&]/);
    assert(parts.length >= 2);
    const [nid, nin] = parts;
    asset(nid.length <= 255);
    asset(nin.length <= 255);
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
}

class Service extends RecordData {
  constructor() {
    super();
    this.service = '';
    this.protocol = '';
    this.priority = 0;
    this.weight = 0;
    this.port = 0;
    this.target = new Target();
  }

  getSize() {
    let size = 0;
    size += 1 + this.service.length;
    size += 1 + this.protocol.length;
    size += 1;
    size += 1;
    size += 2;
    size += this.target.getSize();
    return size;
  }

  toWriter(bw) {
    bw.writeU8(this.service.length);
    bw.writeString(this.service, 'ascii');
    bw.writeU8(this.protocol.length);
    bw.writeString(this.protocol, 'ascii');
    bw.writeU8(this.priority);
    bw.writeU8(this.weight);
    bw.writeU16(this.port);
    this.target.toWriter(bw);
    return bw;
  }

  fromReader(br) {
    this.service = br.readString('ascii', br.readU8());
    this.protocol = br.readString('ascii', br.readU8());
    this.priority = br.readU8();
    this.weight = br.readU8();
    this.port = br.readU16();
    this.target.fromReader(br);
    return this;
  }

  toJSON() {
    return {
      service: this.service,
      protocol: this.protocol,
      priority: this.priority,
      weight: this.weight,
      port: this.port,
      target: this.target.toJSON()
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

    if (json.port != null) {
      assert((json.port & 0xffff) === json.port);
      this.port = json.port;
    }

    if (json.target != null) {
      assert(typeof json.target === 'object');
      this.target.fromJSON(json.target);
    }

    return this;
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
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
}

function sizeTarget(type, target) {
  let size = 0;

  switch (type) {
    case rtypes.INET4:
      size += 4;
      break;
    case rtypes.INET6:
      size += 16;
      break;
    case rtypes.ONION:
      size += 10;
      break;
    case rtypes.ONIONNG:
      size += 33;
      break;
    case rtypes.INAME:
      size += 1;
      size += target.length - ICANNP.length;
      break;
    case rtypes.HNAME:
      size += 1;
      size += target.length - HSKP.length;
      break;
  }

  return size;
}

function writeTarget(type, target, bw) {
  switch (type) {
    case rtypes.INET4: {
      const ip = IP.decode(target);
      assert(ip.length === 4);
      bw.writeBytes(ip);
      break;
    }
    case rtypes.INET6: {
      const ip = IP.decode(target);
      assert(ip.length === 16);
      bw.writeBytes(ip);
      break;
    }
    case rtypes.ONION: {
      const onion = onion.decode(target);
      bw.writeBytes(onion);
      break;
    }
    case rtypes.ONIONNG: {
      const key = onion.decodeNG(target);
      bw.writeBytes(key);
      break;
    }
    case rtypes.INAME: {
      const name = target.slice(0, ICANNP.length);
      bw.writeU8(name.length);
      bw.writeString(name, 'ascii');
      break;
    }
    case rtypes.HNAME: {
      const name = target.slice(0, HSKP.length);
      bw.writeU8(name.length);
      bw.writeString(name, 'ascii');
      break;
    }
    default: {
      throw new Error('Unknown target type.');
    }
  }
  return bw;
}

function readTarget(type, br) {
  switch (type) {
    case rtypes.INET4: {
      return IP.encode(br.readBytes(4));
    }
    case rtypes.INET6: {
      return IP.encode(br.readBytes(16));
    }
    case rtypes.ONION: {
      return onion.encode(br.readBytes(10));
    }
    case rtypes.ONIONNG: {
      return onion.encodeNG(br.readBytes(33));
    }
    case rtypes.INAME: {
      const name = br.readString(br.readU8(), 'ascii');
      return name + ICANNP;
    }
    case rtypes.HNAME: {
      const name = br.readString(br.readU8(), 'ascii');
      return name + HSKP;
    }
    default: {
      throw new Error('Unknown target type.');
    }
  }
}

class Target extends RecordData {
  constructor(type, target) {
    super();
    this.type = type || rtypes.INET4;
    this.target = target || '0.0.0.0';
  }

  toString() {
    return this.target;
  }

  fromString(str) {
    assert(typeof str === 'string');

    const st = IP.getStringType(str);

    switch (st) {
      case IP.types.INET4: {
        this.type = rtypes.INET4;
        this.target = IP.normalize(str);
        break;
      }
      case IP.types.INET6: {
        this.type = rtypes.INET6;
        this.target = IP.normalize(str);
        break;
      }
      case IP.types.ONION: {
        this.type = rtypes.ONION;
        this.target = str;
        break;
      }
      case IP.types.NAME: {
        assert(util.isName(str));

        if (onion.isNGString(str)) {
          this.type = rtypes.ONIONNG;
          this.target = str;
          break;
        }

        if (str[str.length - 1] === '.')
          str = str.slice(0, -1);

        if (str.endsWith(HSKP)) {
          this.type = rtypes.HNAME;
          this.target = str;
        } else {
          if (str.endsWith(ICANNP))
            str = str.slice(0, -ICANNP.length);
          this.type = rtypes.INAME;
          this.target = str;
        }

        break;
      }
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
    return this.fromJSON(json);
  }

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  isNull() {
    return this.type === rtypes.INET4 && this.target === '0.0.0.0';
  }

  dnsType() {
    if (this.isINET4())
      return types.A;

    if (this.isINET6())
      return types.AAAA;

    return -1;
  }

  toNS(name) {
    assert(this.isINET());
    const ip = IP.encode(this.target);
    const hash = base58.encode(ip);
    return `ns-${hash}.${name}`;
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

  isOnion() {
    return this.isOnion() || this.isOnionNG();
  }

  toDNS() {
    if (this.isHSK())
      return this.target + '.';

    if (this.isICANN())
      return this.target.slice(0, ICANNP.length) + '.';

    return this.target;
  }

  getSize(nt) {
    return 1 + sizeTarget(this.target);
  }

  toWriter(bw) {
    bw.writeU8(this.type);
    writeTarget(this.type, this.target, bw);
    return bw;
  }

  fromReader(br) {
    this.type = br.readU8();
    this.target = readTarget(this.type, br);
    return this;
  }

  static fromReader(br, type) {
    return new this().fromReader(br, type);
  }
}

class HSKRecord extends RecordData {
  constructor() {
    super();
    this.version = 0;
    this.ttl = 0;
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

  getSize() {
    let size = 1 + 2;

    for (const host of this.hosts)
      size += host.getSize();

    if (this.canonical)
      size += 1 + this.canonical.getSize();

    if (this.delegate)
      size += 1 + this.delegate.getSize();

    for (const ns of this.ns)
      size += 1 + ns.getSize();

    for (const srv of this.service)
      size += 1 + srv.getSize();

    for (const url of this.url)
      size += 2 + url.length;

    for (const email of this.email)
      size += 2 + email.length;

    for (const text of this.text)
      size += 2 + text.length;

    for (const loc of this.location)
      size += 1 + loc.getSize();

    for (const urn of this.magnet)
      size += 1 + urn.getSize();

    for (const ds of this.ds)
      size += 1 + ds.getSize();

    for (const tls of this.tls)
      size += 1 + tls.getSize();

    for (const ssh of this.ssh)
      size += 1 + ssh.getSize();

    for (const pgp of this.pgp)
      size += 1 + pgp.getSize();

    for (const addr of this.addr)
      size += 1 + addr.getSize();

    for (const extra of this.extra)
      size += 1 + extra.getSize();

    return size;
  }

  toWriter(bw) {
    bw.writeU8(this.version);
    bw.writeU16(this.ttl >>> 6);

    for (const host of this.hosts)
      host.toWriter(bw);

    if (this.canonical) {
      bw.writeU8(rtypes.CANONICAL);
      this.canonical.toWriter(bw);
    }

    if (this.delegate) {
      bw.writeU8(rtypes.DELEGATE);
      this.delegate.toWriter(bw);
    }

    for (const ns of this.ns) {
      bw.writeU8(rtypes.NS);
      ns.toWriter(bw);
    }

    for (const srv of this.service) {
      bw.writeU8(rtypes.SERVICE);
      srv.toWriter(bw);
    }

    for (const url of this.url) {
      bw.writeU8(rtypes.URL);
      bw.writeU8(url.length);
      bw.writeString(url, 'ascii');
    }

    for (const email of this.email) {
      bw.writeU8(rtypes.EMAIL);
      bw.writeU8(email.length);
      bw.writeString(email, 'ascii');
    }

    for (const text of this.text) {
      bw.writeU8(rtypes.TEXT);
      bw.writeU8(text.length);
      bw.writeString(text, 'ascii');
    }

    for (const loc of this.location) {
      bw.writeU8(rtypes.LOC);
      loc.toWriter(bw);
    }

    for (const urn of this.magnet) {
      bw.writeU8(rtypes.MAGNET);
      urn.toWriter(bw);
    }

    for (const ds of this.ds) {
      bw.writeU8(rtypes.DS);
      ds.toWriter(bw);
    }

    for (const tls of this.tls) {
      bw.writeU8(rtypes.TLS);
      tls.toWriter(bw);
    }

    for (const ssh of this.ssh) {
      bw.writeU8(rtypes.SSH);
      ssh.toWriter(bw);
    }

    for (const pgp of this.pgp) {
      bw.writeU8(rtypes.PGP);
      pgp.toWriter(bw);
    }

    for (const addr of this.addr) {
      bw.writeU8(rtypes.ADDR);
      addr.toWriter(bw);
    }

    for (const extra of this.extra) {
      bw.writeU8(extra.type);
      extra.toWriter(bw);
    }

    return bw;
  }

  fromReader(br) {
    const version = br.readU8();

    if (version !== 0)
      throw new Error('Unknown version.');

    this.ttl = br.readU16() << 6;

    while (br.left()) {
      const type = br.readU8();
      switch (type) {
        case rtypes.INET4:
        case rtypes.INET6:
        case rtypes.ONION:
        case rtypes.ONIONNG: {
          const target = readTarget(type, br);
          this.hosts.push(new Target(type, target));
          break;
        }
        case rtypes.INAME:
        case rtypes.HNAME: {
          assert(!this.canonical);
          const target = readTarget(type, br);
          this.canonical = new Target(type, target);
          break;
        }
        case rtypes.CANONICAL:
          assert(!this.canonical);
          this.canonical = Target.fromReader(br);
          break;
        case rtypes.DELEGATE:
          assert(!this.delegate);
          this.delegate = Target.fromReader(br);
          break;
        case rtypes.NS:
          this.ns.push(Target.fromReader(br));
          break;
        case rtypes.SERVICE:
          this.service.push(Service.fromReader(br));
          break;
        case rtypes.URL:
          this.url.push(br.readString('ascii', br.readU8()));
          break;
        case rtypes.EMAIL:
          this.email.push(br.readString('ascii', br.readU8()));
          break;
        case rtypes.TEXT:
          this.text.push(br.readString('ascii', br.readU8()));
          break;
        case rtypes.LOCATION:
          this.location.push(Location.fromReader(br));
          break;
        case rtypes.MAGNET:
          this.magnet.push(Magnet.fromReader(br));
          break;
        case rtypes.DS:
          this.ds.push(DS.fromReader(br));
          break;
        case rtypes.TLS:
          this.tls.push(TLS.fromReader(br));
          break;
        case rtypes.SSH:
          this.ssh.push(SSH.fromReader(br));
          break;
        case rtypes.PGP:
          this.pgp.push(PGP.fromReader(br));
          break;
        case rtypes.ADDR:
          this.addr.push(Addr.fromReader(br));
          break;
        default:
          this.extra.push(Extra.fromReader(br));
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

    return answer;
  }

  toCNAME(name) {
    if (!this.canonical)
      return [];

    assert(this.canonical.isName());
    const rr = new Record();
    rr.name = name;
    rr.ttl = this.ttl;
    rr.type = types.CNAME;
    rr.data = new CNAMERecord();
    rr.data.target = this.canonical.toDNS();

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
      const rr = new Record();
      rr.name = name;
      rr.ttl = this.ttl;
      rr.type = types.NS;
      rr.data = new NSRecord();

      if (ns.isName())
        rr.data.ns = ns.toDNS();
      else if (naked && ns.isINET())
        rr.data.ns = ns.toNS(name);

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
      rr.name = ns.toNS(name);
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
    const labels = util.split(name);
    const top = util.label(name, labels, -2);
    // return in authority section
    const rr = new Record();
    const rd = new SOARecord();
    rr.name = top;
    rr.type = types.SOA;
    rr.ttl = 900;
    rr.data = rd;
    rd.ns = top; // Need to put an ns here
    rd.mbox = HSKS;
    rd.serial = 0;
    rd.refresh = 1800;
    rd.retry = 900;
    rd.expire = 604800;
    rd.minttl = 86400;
    return [rr];
  }

  toMX() {
    return [];
  }

  toSRV() {
    return [];
  }

  toDS() {
    return [];
  }

  toDNS(name, type, naked) {
    const label = util.split(name);
    const end = label[label.length - 1];

    if (name.substring(end) !== HSKS)
      throw new Error('Non-handshake domain.');

    // Our fake resolution.
    const res = new Message();

    res.qr = true;
    res.ad = true;

    if (label.length > 2) {
      if (this.ns.length > 0) {
        res.authority = this.toNS(name, naked);
        res.additional = this.toNSIP(name, naked);
      } else if (this.delegate) {
        res.answer = this.toDNAME(name);
      } else {
        res.answer = this.toSOA(name);
      }
      res.setEDNS0(4096, true);
      return res;
    }

    res.aa = true;

    if (this.canonical) {
      res.answer = this.toCNAME(name);
      res.setEDNS0(4096, true);
      return res;
    }

    switch (type) {
      case types.ANY:
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
        res.answer = this.toCNAME(name);
        break;
      case types.DNAME:
        res.answer = this.toDNAME(name);
        break;
      case types.NS:
        res.authority = this.toNS(name, naked);
        res.additional = this.toNSIP(name, naked);
        break;
      case types.MX:
        res.answer = this.toMX(name);
        break;
      case types.SRV:
        res.answer = this.toSRV(name);
        break;
      case types.DS:
        res.authority = this.toDS(name);
        break;
    }

    if (res.answer.length === 0
        && res.authority.length === 0) {
      res.authority = this.toSOA(name);
    }

    if (type !== types.DS) {
      for (const rr of this.toDS(name))
        res.authority.push(rr);
    }

    res.setEDNS0(4096, true);

    return res;
  }

  toJSON(name) {
    const json = {
      version: this.version,
      name,
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
        json.email.push(url);
    }

    if (this.text.length > 0) {
      json.text = [];
      for (const txt of this.text)
        json.text.push(txt);
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
      assert((json.version & 0xff) === json.version);
      this.version = json.version;
    }

    if (json.ttl != null) {
      assert((json.ttl >>> 0) === json.ttl);
      this.ttl = json.ttl;
    }

    if (json.hosts != null) {
      assert(Array.isArray(json.hosts));
      for (const host of json.hosts)
        this.hosts.push(Target.fromJSON(host));
    }

    if (json.canonical != null)
      this.canonical = Target.fromJSON(json.canonical);

    if (json.delegate != null)
      this.delegate = Target.fromJSON(json.delegate);

    if (json.ns != null) {
      assert(Array.isArray(json.ns));
      for (const ns of json.ns)
        this.ns.push(Target.fromJSON(ns));
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
}

/*
const r = new HSKRecord();
r.ttl = 3600;
r.hosts.push(new Target(rtypes.INET4, '127.0.0.1'));
r.hosts.push(new Target(rtypes.INET6, '::1'));
r.ns.push(new Target(rtypes.INET4, '8.8.8.8'));
util.dir(HSKRecord.fromRaw(r.toRaw()));
util.dir(r.hosts[0].toNS('test.h.'));
util.dir(r.toDNS('test.h.', types.NS, true));
*/

exports.ICANN = ICANN;
exports.HSK = HSK;
exports.ICANNP = ICANNP;
exports.ICANNS = ICANNS;
exports.HSKP = HSKP;
exports.HSKS = HSKS;
exports.HSKRecord = HSKRecord;
