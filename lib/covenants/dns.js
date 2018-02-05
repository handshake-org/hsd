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
      return [false, null, null];

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

    const cache = this.cache.hit(qs, auth.zone);

    if (cache)
      return [cache, name];

    // Slice off the naked TLD.
    const tld = util.label(name, labels, -2);
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
}

function append_(res, domain, zone) {
  const msg = res.clone();

  for (let i = 0; i < msg.question.length; i++) {
    let qs = msg.question[i];
    if (util.isSubdomain(domain, qs.name)) {
      qs = qs.clone();
      qs.name += `${zone}.`;
      msg.question[i] = qs;
    }
  }

  for (const section of msg.sections()) {
    for (let i = 0; i < section.length; i++) {
      let rr = section[i];
      if (util.isSubdomain(domain, rr.name)) {
        rr = rr.clone();
        rr.name += `${zone}.`;
        section[i] = rr;
      }
    }
  }

  return msg;
}

function append(res, domain, zone) {
  const msg = res.deepClone();

  for (const qs of msg.question) {
    if (util.isSubdomain(domain, qs.name))
      qs.name += `${zone}.`;
  }

  for (const section of msg.sections()) {
    for (const rr of section) {
      if (util.isSubdomain(domain, rr.name))
        rr.name += `${zone}.`;
    }
  }

  return msg;
}

exports.HandshakeServer = HandshakeServer;
exports.HandshakeResolver = HandshakeResolver;
