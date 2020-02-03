/*!
 * resource.js - hns resource for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bns = require('bns');
const bio = require('bufio');
const compress = require('./compress');
const key = require('./key');
const records = require('./records');
const {tlsa, smimea, srv, openpgpkey} = bns;
const {Struct} = bio;

const {
  Target,
  Service,
  Location,
  Magnet,
  DS,
  TLS,
  SMIME,
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
  SMIMEARecord,
  SSHFPRecord,
  OPENPGPKEYRecord,
  URIRecord,
  RPRecord,
  NSECRecord,
  types
} = wire;

const {
  Compressor,
  Decompressor
} = compress;

/*
 * Constants
 */

const DUMMY = Buffer.alloc(0);

// A RRSIG NSEC
// const TYPE_MAP_A = Buffer.from('0006400000000003', 'hex');

// AAAA RRSIG NSEC
// const TYPE_MAP_AAAA = Buffer.from('0006000000080003', 'hex');

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
    this.uri = [];
    this.email = [];
    this.text = [];
    this.location = [];
    this.magnet = [];
    this.ds = [];
    this.tls = [];
    this.smime = [];
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

    for (const uri of this.uri)
      c.add(uri);

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

    for (const smime of this.smime)
      smime.compress(c);

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
    const size = this.getSize(c);
    const bw = bio.write(size);
    this.write(bw, c);
    return bw.slice();
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

    for (const uri of this.uri)
      size += 1 + c.size(uri);

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

    for (const smime of this.smime)
      size += 1 + smime.getSize(c);

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

    bw.writeU16BE(cmp | ttl);

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

    for (const uri of this.uri) {
      bw.writeU8(records.types.URI);
      c.writeString(bw, uri);
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

    for (const smime of this.smime) {
      bw.writeU8(records.types.SMIME);
      smime.write(bw, c);
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
    const field = br.readU16BE();
    this.compat = (field & 0x8000) !== 0;
    this.ttl = (field & 0x7fff) << 6;

    if (this.ttl === 0)
      this.ttl = 1 << 6;

    // Read the symbol table.
    const d = Decompressor.read(br);

    let count = 0;

    while (br.left()) {
      if (count === 255)
        throw new Error('Too many records.');

      count += 1;

      const type = br.readU8();

      switch (type) {
        case records.types.INET4:
        case records.types.INET6:
        case records.types.ONION:
        case records.types.ONIONNG: {
          const target = readTarget(type, br);
          this.hosts.push(new Target(type, target));
          break;
        }
        case records.types.NAME: {
          assert(!this.canonical);
          const target = readTarget(type, br);
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
        case records.types.URI: {
          this.uri.push(d.readString(br));
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
        case records.types.SMIME: {
          this.smime.push(SMIME.read(br, d));
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
      if (!util.equal(srv.protocol, 'tcp.'))
        continue;

      if (!util.equal(srv.service, 'smtp.'))
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
    return this.toSRVIP(name, 'tcp.', 'smtp.');
  }

  toSRV(name, protocol, service) {
    const answer = [];

    for (const srv of this.service) {
      let target = null;

      if (srv.target.isName())
        target = srv.target.toDNS();
      else if (srv.target.isINET())
        target = srv.target.toPointer(name);

      if (!target)
        continue;

      if (!util.equal(protocol, srv.protocol))
        continue;

      if (!util.equal(service, srv.service))
        continue;

      const rr = new Record();
      const rd = new SRVRecord();

      rr.name = name;
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

  toSRVIP(name, protocol, service) {
    const additional = [];

    for (const srv of this.service) {
      if (!srv.target.isINET())
        continue;

      if (!util.equal(protocol, srv.protocol))
        continue;

      if (!util.equal(service, srv.service))
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

  toTLSA(name, protocol, port) {
    const answer = [];

    for (const tls of this.tls) {
      const rr = new Record();
      const rd = new TLSARecord();

      if (!util.equal(protocol, tls.protocol))
        continue;

      if (tls.port !== port)
        continue;

      rr.name = name;
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

  toSMIMEA(name, hash) {
    const answer = [];

    for (const smime of this.smime) {
      const rr = new Record();
      const rd = new SMIMEARecord();

      if (!hash.equals(smime.hash))
        continue;

      rr.name = name;
      rr.type = types.SMIMEA;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.usage = smime.usage;
      rd.selector = smime.selector;
      rd.matchingType = smime.matchingType;
      rd.certificate = smime.certificate;

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
      rd.digestType = ssh.digestType;
      rd.fingerprint = ssh.fingerprint;

      answer.push(rr);
    }

    return answer;
  }

  toOPENPGPKEY(name, hash) {
    const answer = [];

    for (const pgp of this.pgp) {
      const rr = new Record();
      const rd = new OPENPGPKEYRecord();

      if (!hash.equals(pgp.hash))
        continue;

      rr.name = name;
      rr.type = types.OPENPGPKEY;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.publicKey = pgp.publicKey;

      answer.push(rr);
    }

    return answer;
  }

  toURI(name) {
    const answer = [];

    for (const uri of this.uri) {
      const rr = new Record();
      const rd = new URIRecord();

      rr.name = name;
      rr.type = types.URI;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.priority = 0;
      rd.weight = 0;
      rd.target = uri;

      answer.push(rr);
    }

    for (const urn of this.magnet) {
      const rr = new Record();
      const rd = new URIRecord();

      rr.name = name;
      rr.type = types.URI;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.priority = 0;
      rd.weight = 0;
      rd.target = urn.toString();

      answer.push(rr);
    }

    for (const addr of this.addr) {
      const rr = new Record();
      const rd = new URIRecord();

      rr.name = name;
      rr.type = types.URI;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.priority = 0;
      rd.weight = 0;
      rd.target = addr.toString();

      answer.push(rr);
    }

    return answer;
  }

  toRP(name) {
    const answer = [];

    for (const email of this.email) {
      if (email.length > 63)
        continue;

      const rr = new Record();
      const rd = new RPRecord();

      rr.name = name;
      rr.type = types.RP;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.mbox = util.fqdn(email);

      if (!util.isName(rd.mbox))
        continue;

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

    rd.txt.push('hns:tor');

    for (const host of this.hosts) {
      if (host.isTor())
        rd.txt.push(host.target);
    }

    return rr;
  }

  toTXT(name) {
    const answer = [];

    for (const txt of this.text) {
      const rr = new Record();
      const rd = new TXTRecord();

      rr.name = name;
      rr.type = types.TXT;
      rr.ttl = this.ttl;
      rr.data = rd;

      rd.txt.push(txt);

      answer.push(rr);
    }

    return answer;
  }

  toGlue(type) {
    assert((type & 0xffff) === type);

    const additional = [];
    const glue = [];

    switch (type) {
      case types.CNAME:
        if (this.canonical && this.canonical.isGlue())
          glue.push(this.canonical);
        break;
      case types.DNAME:
        if (this.delegate && this.delegate.isGlue())
          glue.push(this.delegate);
        break;
      case types.NS:
        for (const ns of this.ns) {
          if (ns.isGlue())
            glue.push(ns);
        }
        break;
      case types.SRV:
      case types.MX:
        for (const srv of this.service) {
          if (type === types.MX) {
            if (!util.equal(srv.protocol, 'tcp.'))
              continue;

            if (!util.equal(srv.service, 'smtp.'))
              continue;
          }

          if (srv.target.isGlue())
            glue.push(srv.target);
        }

        break;
    }

    for (const target of glue) {
      if (target.inet4 !== '0.0.0.0') {
        const rr = new Record();
        const rd = new ARecord();

        rr.name = target.toDNS();
        rr.type = types.A;
        rr.ttl = this.ttl;
        rr.data = rd;

        rd.address = target.inet4;

        additional.push(rr);
      }

      if (target.inet6 !== '::') {
        const rr = new Record();
        const rd = new AAAARecord();

        rr.name = target.toDNS();
        rr.type = types.AAAA;
        rr.ttl = this.ttl;
        rr.data = rd;

        rd.address = target.inet6;

        additional.push(rr);
      }
    }

    return additional;
  }

  toNSEC(name, map) {
    const rr = new Record();
    const rd = new NSECRecord();

    rr.name = name;
    rr.type = types.NSEC;
    rr.ttl = 86400;
    rr.data = rd;
    rd.nextDomain = '.';

    if (map)
      rd.typeBitmap = map;

    return rr;
  }

  toDNS(name, type) {
    assert(util.isFQDN(name));
    assert(typeof type === 'number');

    const res = new Message();
    const labels = util.split(name);

    // Handle reverse pointers.
    if (labels.length === 2) {
      const hash = util.label(name, labels, 0);

      if (Target.isPointer(hash, type)) {
        const ptr = Target.fromPointer(hash);

        if (!ptr.matches(type)) {
          // Needs SOA.
          // TODO: Make reverse pointers TLDs.
          // Empty Proof:
          // XXX Can't push this on yet (SOA check).
          // const map = ptr.isINET4() ? TYPE_MAP_A : TYPE_MAP_AAAA;
          // const nsec = this.toNSEC(name, map);
          // res.authority.push(nsec);
          return res;
        }

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
        key.signZSK(res.answer, rr.type);

        return res;
      }
    }

    // Handle SRV, TLSA, and SMIMEA.
    if (labels.length === 3) {
      switch (type) {
        case types.SRV: {
          const [ok, protocol, service] = decodeSRV(name);
          if (ok) {
            res.answer = this.toSRV(name, protocol, service);
            res.additional = this.toSRVIP(name, protocol, service);
            for (const rr of this.toGlue(types.SRV))
              res.additional.push(rr);
            key.signZSK(res.answer, types.SRV);
          }
          break;
        }
        case types.TLSA: {
          const [ok, protocol, port] = decodeTLSA(name);
          if (ok) {
            res.answer = this.toTLSA(name, protocol, port);
            key.signZSK(res.answer, types.TLSA);
          }
          break;
        }
        case types.SMIMEA: {
          const [ok, hash] = decodeSMIMEA(name);
          if (ok) {
            res.answer = this.toSMIMEA(name, hash);
            key.signZSK(res.answer, types.SMIMEA);
          }
          break;
        }
        case types.OPENPGPKEY: {
          const [ok, hash] = decodeOPENPGPKEY(name);
          if (ok) {
            res.answer = this.toOPENPGPKEY(name, hash);
            key.signZSK(res.answer, types.OPENPGPKEY);
          }
          break;
        }
      }

      if (res.answer.length > 0) {
        res.aa = true;
        return res;
      }
    }

    // Referral.
    if (labels.length > 1) {
      const tld = util.from(name, labels, -1);

      if (this.ns.length > 0) {
        res.authority = this.toNS(tld);

        for (const rr of this.toDS(tld))
          res.authority.push(rr);

        res.additional = this.toNSIP(tld);

        for (const rr of this.toGlue(types.NS))
          res.additional.push(rr);

        if (this.ds.length === 0)
          key.signZSK(res.authority, types.NS);
        else
          key.signZSK(res.authority, types.DS);
      } else if (this.delegate) {
        res.answer = this.toDNAME(name);

        for (const rr of this.toGlue(types.DNAME))
          res.additional.push(rr);

        key.signZSK(res.answer, types.DNAME);
        key.signZSK(res.additional, types.A);
        key.signZSK(res.additional, types.AAAA);
      } else {
        // Needs SOA.
        // Empty Proof:
        // XXX Can't push this on yet (SOA check).
        // const nsec = this.toNSEC(tld);
        // res.authority.push(nsec);
      }

      return res;
    }

    switch (type) {
      case types.A:
        res.answer = this.toA(name);
        key.signZSK(res.answer, types.A);
        if (this.hasTor())
          key.signZSK(res.answer, types.TXT);
        break;
      case types.AAAA:
        res.answer = this.toAAAA(name);
        key.signZSK(res.answer, types.AAAA);
        if (this.hasTor())
          key.signZSK(res.answer, types.TXT);
        break;
      case types.CNAME:
        res.answer = this.toCNAME(name);
        for (const rr of this.toGlue(types.CNAME))
          res.additional.push(rr);
        key.signZSK(res.answer, types.CNAME);
        key.signZSK(res.additional, types.A);
        key.signZSK(res.additional, types.AAAA);
        break;
      case types.DNAME:
        res.answer = this.toDNAME(name);
        for (const rr of this.toGlue(types.DNAME))
          res.additional.push(rr);
        key.signZSK(res.answer, types.DNAME);
        key.signZSK(res.additional, types.A);
        key.signZSK(res.additional, types.AAAA);
        break;
      case types.NS:
        res.authority = this.toNS(name);
        res.additional = this.toNSIP(name);
        for (const rr of this.toGlue(types.NS))
          res.additional.push(rr);
        key.signZSK(res.authority, types.NS);
        break;
      case types.MX:
        res.answer = this.toMX(name);
        res.additional = this.toMXIP(name);
        for (const rr of this.toGlue(types.MX))
          res.additional.push(rr);
        key.signZSK(res.answer, types.MX);
        break;
      case types.TXT:
        res.answer = this.toTXT(name);
        key.signZSK(res.answer, types.TXT);
        break;
      case types.LOC:
        res.answer = this.toLOC(name);
        key.signZSK(res.answer, types.LOC);
        break;
      case types.DS:
        res.answer = this.toDS(name);
        key.signZSK(res.answer, types.DS);
        break;
      case types.SSHFP:
        res.answer = this.toSSHFP(name);
        key.signZSK(res.answer, types.SSHFP);
        break;
      case types.URI:
        res.answer = this.toURI(name);
        key.signZSK(res.answer, types.URI);
        break;
      case types.RP:
        res.answer = this.toRP(name);
        key.signZSK(res.answer, types.RP);
        break;
    }

    if (res.answer.length > 0)
      res.aa = true;

    if (res.answer.length === 0
        && res.authority.length === 0) {
      if (this.canonical) {
        res.aa = true;
        res.answer = this.toCNAME(name);

        for (const rr of this.toGlue(types.CNAME))
          res.additional.push(rr);

        key.signZSK(res.answer, types.CNAME);
        key.signZSK(res.additional, types.A);
        key.signZSK(res.additional, types.AAAA);
      } else if (this.ns.length > 0) {
        res.authority = this.toNS(name);

        for (const rr of this.toDS(name))
          res.authority.push(rr);

        res.additional = this.toNSIP(name);

        for (const rr of this.toGlue(types.NS))
          res.additional.push(rr);

        if (this.ds.length === 0)
          key.signZSK(res.authority, types.NS);
        else
          key.signZSK(res.authority, types.DS);
      } else {
        // Needs SOA.
        // Empty Proof:
        // XXX Can't push this on yet (SOA check).
        // const nsec = this.toNSEC(name);
        // res.authority.push(nsec);
      }
    }

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

    if (this.uri.length > 0) {
      json.uri = [];
      for (const uri of this.uri)
        json.uri.push(uri);
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

    if (this.smime.length > 0) {
      json.smime = [];
      for (const smime of this.smime)
        json.smime.push(smime.toJSON());
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

    if (json.uri != null) {
      assert(Array.isArray(json.uri));
      for (const uri of json.uri) {
        assert(typeof uri === 'string');
        assert(uri.length <= 255);
        this.uri.push(uri);
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

    if (json.smime != null) {
      assert(Array.isArray(json.smime));
      for (const smime of json.smime)
        this.smime.push(SMIME.fromJSON(smime));
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
 * Helpers
 */

function isPointer(name) {
  return Target.isPointer(name, null);
}

function decodeSRV(name) {
  try {
    const {protocol, service} = srv.decodeName(name);
    return [true, `${protocol}.`, `${service}.`];
  } catch (e) {
    return [false, '', ''];
  }
}

function isSRV(name) {
  return decodeSRV(name)[0];
}

function decodeTLSA(name) {
  try {
    const {protocol, port} = tlsa.decodeName(name);
    return [true, `${protocol}.`, port];
  } catch (e) {
    return [false, '', 0];
  }
}

function isTLSA(name) {
  return decodeTLSA(name)[0];
}

function decodeSMIMEA(name) {
  try {
    const {hash} = smimea.decodeName(name);
    return [true, hash];
  } catch (e) {
    return [false, DUMMY];
  }
}

function isSMIMEA(name) {
  return decodeSMIMEA(name)[0];
}

function decodeOPENPGPKEY(name) {
  try {
    const {hash} = openpgpkey.decodeName(name);
    return [true, hash];
  } catch (e) {
    return [false, DUMMY];
  }
}

function isOPENPGPKEY(name) {
  return decodeOPENPGPKEY(name)[0];
}

/*
 * Expose
 */

exports = Resource;
exports.isPointer = isPointer;
exports.isSRV = isSRV;
exports.isTLSA = isTLSA;
exports.isSMIMEA = isSMIMEA;
exports.isOPENPGPKEY = isOPENPGPKEY;

module.exports = exports;
