'use strict';

const bns = require('bns');
const {HSKRecord, ICANNS, HSKS} = require('./record');

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
      return [false, null];

    let {name, type} = qs;

    const labels = util.split(name);

    // Acutal root zone.
    if (labels.length === 0)
      return [false, null];

    const end = labels[labels.length - 1];

    if (name.substring(end) === ICANNS) {
      name = name.substring(0, end);
      qs.name = name;
      return [false, null];
    }

    if (name.substring(end) !== HSKS)
      return [false, null];

    // Slice off HSK, to make the resolver think we're the root zone.
    name = name.substring(0, end);
    qs.name = name;
    labels.pop();

    // Slice off the naked TLD.
    const start = labels[labels.length - 1];
    const tld = name.substring(start, end - 1);
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
      return [true, res];
    }

    // Our fake resolution.
    const record = HSKRecord.fromRaw(data);
    const res = record.toDNS(name, type);

    return [true, res];
  }
}

exports.HandshakeServer = HandshakeServer;
exports.HandshakeResolver = HandshakeResolver;
