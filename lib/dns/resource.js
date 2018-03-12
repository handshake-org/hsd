/*!
 * resource.js - hsk resource for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const assert = require('assert');
const bns = require('bns');
const {Struct} = require('bufio');
const compress = require('./compress');
const records = require('./records');

const {
  Target,
  Service,
  Location,
  Magnet,
  DS,
  TLS,
  SSH,
  PGP,
  Addr,
  Extra,
  readTarget
} = records;

const {
  wire,
  util
} = bns;

const {
  Message,
  Record,
  ARecord,
  AAAARecord,
  NSRecord,
  MXRecord,
  CNAMERecord,
  DNAMERecord,
  SRVRecord,
  TXTRecord,
  LOCRecord,
  DSRecord,
  TLSARecord,
  SSHFPRecord,
  OPENPGPKEYRecord,
  URIRecord,
  RPRecord,
  types
} = wire;

const {
  Compressor,
  Decompressor
} = compress;

/**
 * Resource
 * @extends {Struct}
 */

class Resource extends Struct {
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
      c.addString(url);

    for (const email of this.email)
      c.addString(email);

    for (const text of this.text)
      c.addString(text);

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

  encode() {
    const c = this.compress();
    return super.encode(c);
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

  write(bw, c) {
    // Serialization version.
    bw.writeU8(this.version);

    // TTL has a granularity of 6
    // (about 1 minute per unit).
    const cmp = this.compat ? 0x8000 : 0;
    const ttl = this.ttl >>> 6;
    assert((ttl & 0x8000) === 0); // 15 bits max

    bw.writeU16(cmp | ttl);

    // Write the symbol table.
    c.write(bw);

    for (const host of this.hosts)
      host.write(bw, c);

    if (this.canonical) {
      bw.writeU8(records.types.CANONICAL);
      this.canonical.write(bw, c);
    }

    if (this.delegate) {
      bw.writeU8(records.types.DELEGATE);
      this.delegate.write(bw, c);
    }

    for (const ns of this.ns) {
      bw.writeU8(records.types.NS);
      ns.write(bw, c);
    }

    for (const srv of this.service) {
      bw.writeU8(records.types.SERVICE);
      srv.write(bw, c);
    }

    for (const url of this.url) {
      bw.writeU8(records.types.URL);
      c.writeString(bw, url);
    }

    for (const email of this.email) {
      bw.writeU8(records.types.EMAIL);
      c.writeString(bw, email);
    }

    for (const text of this.text) {
      bw.writeU8(records.types.TEXT);
      c.writeString(bw, text);
    }

    for (const loc of this.location) {
      bw.writeU8(records.types.LOCATION);
      loc.write(bw, c);
    }

    for (const urn of this.magnet) {
      bw.writeU8(records.types.MAGNET);
      urn.write(bw, c);
    }

    for (const ds of this.ds) {
      bw.writeU8(records.types.DS);
      ds.write(bw, c);
    }

    for (const tls of this.tls) {
      bw.writeU8(records.types.TLS);
      tls.write(bw, c);
    }

    for (const ssh of this.ssh) {
      bw.writeU8(records.types.SSH);
      ssh.write(bw, c);
    }

    for (const pgp of this.pgp) {
      bw.writeU8(records.types.PGP);
      pgp.write(bw, c);
    }

    for (const addr of this.addr) {
      bw.writeU8(records.types.ADDR);
      addr.write(bw, c);
    }

    for (const extra of this.extra) {
      bw.writeU8(extra.type);
      extra.write(bw, c);
    }

    return this;
  }

  read(br) {
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
    const d = Decompressor.read(br);

    while (br.left()) {
      const type = br.readU8();
      switch (type) {
        case records.types.INET4:
        case records.types.INET6:
        case records.types.ONION:
        case records.types.ONIONNG: {
          const target = readTarget(type, br, d);
          this.hosts.push(new Target(type, target));
          break;
        }
        case records.types.NAME: {
          assert(!this.canonical);
          const target = readTarget(type, br, d);
          this.canonical = new Target(type, target);
          assert(!this.canonical.isTor());
          break;
        }
        case records.types.CANONICAL: {
          assert(!this.canonical);
          this.canonical = Target.read(br, d);
          assert(!this.canonical.isTor());
          break;
        }
        case records.types.DELEGATE: {
          assert(!this.delegate);
          this.delegate = Target.read(br, d);
          assert(this.delegate.isName());
          break;
        }
        case records.types.NS: {
          const ns = Target.read(br, d);
          assert(!ns.isTor());
          this.ns.push(ns);
          break;
        }
        case records.types.SERVICE: {
          this.service.push(Service.read(br, d));
          break;
        }
        case records.types.URL: {
          this.url.push(d.readString(br));
          break;
        }
        case records.types.EMAIL: {
          this.email.push(d.readString(br));
          break;
        }
        case records.types.TEXT: {
          this.text.push(d.readString(br));
          break;
        }
        case records.types.LOCATION: {
          this.location.push(Location.read(br, d));
          break;
        }
        case records.types.MAGNET: {
          this.magnet.push(Magnet.read(br, d));
          break;
        }
        case records.types.DS: {
          this.ds.push(DS.read(br, d));
          break;
        }
        case records.types.TLS: {
          this.tls.push(TLS.read(br, d));
          break;
        }
        case records.types.SSH: {
          this.ssh.push(SSH.read(br, d));
          break;
        }
        case records.types.PGP: {
          this.pgp.push(PGP.read(br, d));
          break;
        }
        case records.types.ADDR: {
          this.addr.push(Addr.read(br, d));
          break;
        }
        default: {
          this.extra.push(Extra.read(br, d));
          break;
        }
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

  toCNAME(name) {
    if (!this.canonical)
      return [];

    const cn = this.canonical;
    const rr = new Record();
    rr.name = name;
    rr.ttl = this.ttl;
    rr.type = types.CNAME;
    rr.data = new CNAMERecord();

    if (!cn.isName())
      return [];

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

  toNS(name) {
    const authority = [];

    for (const ns of this.ns) {
      let nsname = null;

      if (ns.isName())
        nsname = ns.toDNS();
      else if (ns.isINET())
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

  toNSIP(name) {
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

  toMX(name) {
    const answer = [];

    for (const srv of this.service) {
      if (!srv.isSMTP())
        continue;

      let mxname = null;

      if (srv.target.isName())
        mxname = srv.target.toDNS();
      else if (srv.target.isINET())
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

  toMXIP(name) {
    return this.toSRVIP(name, true);
  }

  toSRV(name) {
    const answer = [];

    for (const srv of this.service) {
      let target = null;

      if (srv.target.isName())
        target = srv.target.toDNS();
      else if (srv.target.isINET())
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

  toSRVIP(name, mx) {
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
      rd.keyType = ssh.keyType;
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
      rd.publicKey = pgp.encode();

      answer.push(rr);
    }

    return answer;
  }

  toURI(name) {
    const answer = [];

    for (const url of this.url) {
      const rr = new Record();
      const rd = new URIRecord();

      rr.name = name;
      rr.type = types.URI;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.priority = 0;
      rd.weight = 0;
      rd.target = url;

      answer.push(rr);
    }

    return answer;
  }

  toRP(name) {
    const answer = [];

    for (const email of this.email) {
      const rr = new Record();
      const rd = new RPRecord();

      rr.name = name;
      rr.type = types.RP;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.mbox = email;
      rd.txt = '.';

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

    if (this.magnet.length > 0)
      answer.push(this.toMagnetTXT(name));

    if (this.addr.length > 0)
      answer.push(this.toAddrTXT(name));

    return answer;
  }

  toGlue() {
    const additional = [];
    const glue = [];

    if (this.canonical && this.canonical.isGlue())
      glue.push(this.canonical);

    if (this.delegate && this.delegate.isGlue())
      glue.push(this.delegate);

    for (const ns of this.ns) {
      if (ns.isGlue())
        glue.push(ns);
    }

    for (const service of this.service) {
      if (service.target.isGlue())
        glue.push(service.target);
    }

    for (const target of glue) {
      if (target.inet4 !== '0.0.0.0') {
        const rr = new Record();
        const rd = new ARecord();

        rr.name = util.fqdn(target.name);
        rr.type = types.A;
        rr.ttl = this.ttl;
        rr.data = rd;

        rd.address = target.inet4;

        additional.push(rr);
      }

      if (target.inet6 !== '::') {
        const rr = new Record();
        const rd = new AAAARecord();

        rr.name = util.fqdn(target.name);
        rr.type = types.AAAA;
        rr.ttl = this.ttl;
        rr.data = rd;

        rd.address = target.inet6;

        additional.push(rr);
      }
    }

    return additional;
  }

  toDNS(name, type, ds) {
    assert(util.isFQDN(name));
    assert(typeof type === 'number');
    assert(typeof ds === 'boolean');

    const res = new Message();

    res.qr = true;

    const labels = util.split(name);

    // Referral.
    if (labels.length > 1) {
      const hash = util.label(name, labels, -2);

      if (Target.isPointer(hash, type)) {
        const ptr = Target.fromPointer(hash);

        if (!ptr.matches(type))
          return res;

        res.aa = true;

        const rr = new Record();

        rr.name = name;
        rr.ttl = this.ttl;

        if (ptr.isINET4()) {
          rr.type = types.A;
          rr.data = new ARecord();
        } else {
          rr.type = types.AAAA;
          rr.data = new AAAARecord();
        }

        rr.data.address = ptr.target;

        res.answer.push(rr);

        return res;
      }

      const tld = util.from(name, labels, -1);

      if (this.ns.length > 0) {
        res.authority = this.toNS(tld);
        res.additional = this.toNSIP(tld);
        if (ds) {
          for (const rr of this.toDS(tld))
            res.authority.push(rr);
        }
      } else if (this.delegate) {
        res.answer = this.toDNAME(tld);
      }

      for (const rr of this.toGlue())
        res.additional.push(rr);

      return res;
    }

    switch (type) {
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
        res.authority = this.toNS(name);
        res.additional = this.toNSIP(name);
        break;
      case types.MX:
        res.answer = this.toMX(name);
        res.additional = this.toMXIP(name);
        break;
      case types.SRV:
        res.answer = this.toSRV(name);
        res.additional = this.toSRVIP(name);
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
      case types.SSHFP:
        res.answer = this.toSSHFP(name);
        break;
      case types.OPENPGPKEY:
        res.answer = this.toOPENPGPKEY(name);
        break;
      case types.URI:
        res.answer = this.toURI(name);
        break;
      case types.RP:
        res.answer = this.toRP(name);
        break;
    }

    if (res.answer.length > 0)
      res.aa = true;

    if (res.answer.length === 0
        && res.authority.length === 0) {
      if (this.canonical) {
        res.aa = true;
        res.answer = this.toCNAME(name);
      } else if (this.ns.length > 0) {
        res.authority = this.toNS(name);
        res.additional = this.toNSIP(name);
        if (ds) {
          for (const rr of this.toDS(name))
            res.authority.push(rr);
        }
      }
    }

    for (const rr of this.toGlue())
      res.additional.push(rr);

    return res;
  }

  getJSON(name) {
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
}

/*
 * Expose
 */

module.exports = Resource;
