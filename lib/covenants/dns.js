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
      return [false, null, null];

    // Handshake root zone.
    const zone = util.label(name, labels, -1);

    if (zone !== HSK)
      return [false, null, null];

    // Slice off HSK, so as not
    // to confuse the resolver.
    // i.e. Don't make it hit
    // us repeatedly.
    name = name.substring(0, labels.pop());

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
      return [true, res, name];
    }

    // Our fake resolution.
    const record = HSKRecord.fromRaw(data);
    const res = record.toDNS(name, type);

    return [true, res, name];
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
      append(res, domain, zone);
    }

    return res;
  }
}

function append(res, domain, zone) {
  for (const qs of res.question) {
    if (util.isSubdomain(domain, qs.name))
      qs.name += `${zone}.`;
  }

  _append(res.answer, domain, zone);
  _append(res.authority, domain, zone);
  _append(res.additional, domain, zone);
}

function _append(rrs, domain, zone) {
  for (const rr of rrs) {
    if (util.isSubdomain(domain, rr.name))
      rr.name += `${zone}.`;
  }
}

exports.HandshakeServer = HandshakeServer;
exports.HandshakeResolver = HandshakeResolver;
