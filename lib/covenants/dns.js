'use strict';

const assert = require('assert');
const bns = require('bns');
const {HSKRecord, ICANN, HSK} = require('./record');

const {
  DNSServer,
  RecursiveResolver,
  wire,
  util
} = bns;

const {
  Message,
  Record,
  SOARecord,
  TXTRecord,
  types
} = wire;

/**
 * HandshakeServer
 * @extends EventEmitter
 */

class HandshakeServer extends DNSServer {
  constructor(hsk, options) {
    super(options);
    this.resolver = new HandshakeResolver(hsk, options);
    this.resolver.on('log', (...a) => this.emit('log', ...a));
    this.resolver.on('error', e => this.emit('error', e));
    this.ra = true;
  }
}

/**
 * HandshakeResolver
 * @extends DNSResolver
 */

class HandshakeResolver extends RecursiveResolver {
  constructor(hsk, options) {
    super(options);
    this.hsk = hsk;
  }

  async hook(qs, auth) {
    if (auth.zone !== '.')
      return [null, null];

    let {name, type} = qs;

    assert(util.isFQDN(name));

    const labels = util.split(name);

    // Acutal root zone.
    if (labels.length === 0)
      return [null, null];

    // Handshake root zone.
    const zone = util.label(name, labels, -1);

    if (zone !== HSK)
      return [null, null];

    // Slice off HSK, so as not
    // to confuse the resolver.
    // i.e. Don't make it hit
    // us repeatedly.
    name = name.substring(0, labels.pop());

    const cache = this.cache.hit(qs, auth.zone);

    if (cache)
      return [cache, name];

    // Slice off the naked TLD.
    const tld = util.label(name, labels, -1);
    const data = await this.hsk.getDataByName(tld);

    // Should return root zone SOA record.
    if (!data) {
      const res = new Message();
      const rr = new Record();
      const rd = new SOARecord();
      res.qr = true;
      res.ad = true;
      res.aa = true;
      rr.name = '.';
      rr.type = types.SOA;
      rr.ttl = 900;
      rr.data = rd;
      rd.ns = 'localhost.';
      rd.mbox = 'mail.localhost.';
      rd.serial = 0;
      rd.refresh = 1800;
      rd.retry = 900;
      rd.expire = 604800;
      rd.minttl = 86400;
      res.authority.push(rr);
      res.authority.push(await this.prove(tld, rr.ttl, null));
      this.cache.insert(qs, auth.zone, res, true);
      return [res, name];
    }

    // Our fake resolution.
    const rec = HSKRecord.fromRaw(data);
    const res = rec.toDNS(name, type);

    if (res.aa)
      res.answer.push(await this.prove(tld, rec.ttl, data));

    this.cache.insert(qs, auth.zone, res, true);

    return [res, name];
  }

  async prove(tld, ttl, data) {
    const [hash, nodes] = await this.hsk.getProof(tld);
    const rr = new Record();
    const rd = new TXTRecord();

    rr.name = `${tld}.${HSK}.`;
    rr.type = types.TXT;
    rr.ttl = ttl;
    rr.data = rd;

    const txt = [];

    txt.push(hash.toString('base64'));

    for (const node of nodes)
      txt.push(node.toString('base64'));

    if (data)
      txt.push(data.toString('base64'));
    else
      txt.push('');

    const b64 = txt.join(':');

    rd.txt.push('hsk:proof');

    for (let i = 0; i < b64.length; i += 255) {
      const chunk = b64.slice(i, i + 255);
      rd.txt.push(chunk);
    }

    return rr;
  }

  async resolve(qs, ns) {
    const name = qs.name;
    const labels = util.split(name);
    const zone = util.label(name, labels, -1);

    if (zone === ICANN) {
      qs = qs.clone();
      qs.name = util.to(name, labels, -1);
    }

    const res = await super.resolve(qs, ns);

    if (zone === HSK || zone === ICANN) {
      const domain = util.to(name, labels, -1);
      return convert(res, domain, zone);
    }

    return res;
  }
}

function append(name, domain, zone) {
  if (util.isSubdomain(domain, name))
    name += `${zone}.`;
  return name;
}

function convert(res, domain, zone) {
  const msg = res;

  for (const qs of msg.question)
    qs.name = append(qs.name, domain, zone);

  for (const section of msg.sections()) {
    for (const rr of section) {
      const x = rr.data;

      rr.name = append(rr.name, domain, zone);

      // DNSSEC standard
      switch (rr.type) {
        case types.NS:
          x.ns = append(x.ns, domain, zone);
          break;
        case types.MD:
          // x.md = append(x.md, domain, zone);
          break;
        case types.MF:
          // x.mf = append(x.mf, domain, zone);
          break;
        case types.CNAME:
          x.target = append(x.target, domain, zone);
          break;
        case types.SOA:
          // x.ns = append(x.ns, domain, zone);
          // x.mbox = append(x.mbox, domain, zone);
          break;
        case types.MB:
          // x.mb = append(x.mb, domain, zone);
          break;
        case types.MG:
          // x.mg = append(x.mg, domain, zone);
          break;
        case types.MR:
          // x.mr = append(x.mr, domain, zone);
          break;
        case types.PTR:
          // x.ptr = append(x.ptr, domain, zone);
          break;
        case types.MINFO:
          // x.rmail = append(x.rmail, domain, zone);
          // x.email = append(x.email, domain, zone);
          break;
        case types.MX:
          // x.mx = append(x.mx, domain, zone);
          break;
        case types.RP:
          // x.mbox = append(x.mbox, domain, zone);
          // x.txt = append(x.txt, domain, zone);
          break;
        case types.AFSDB:
          // x.hostname = append(x.hostname, domain, zone);
          break;
        case types.SIG:
        case types.RRSIG:
          // x.signerName = append(x.signerName, domain, zone);
          break;
        case types.PX:
          // x.map822 = append(x.map822, domain, zone);
          // x.mapx400 = append(x.mapx400, domain, zone);
          break;
        case types.NAPTR:
          // x.replacement = append(x.replacement, domain, zone);
          break;
        case types.KX:
          // x.exchanger = append(x.exchanger, domain, zone);
          break;
        case types.SRV:
          // x.target = append(x.target, domain, zone);
          break;
        case types.DNAME:
          x.target = append(x.target, domain, zone);
          break;
      }
    }
  }

  return msg;
}

exports.HandshakeServer = HandshakeServer;
exports.HandshakeResolver = HandshakeResolver;
