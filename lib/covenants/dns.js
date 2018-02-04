'use strict';

const bns = require('bns');
const {HSKRecord, HSKQ} = require('./record');

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
  ARecord,
  AAAARecord,
  NSRecord,
  SOARecord,
  CNAMERecord,
  DNAMERecord,
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
    this.resolver.on('error', (e) => this.emit('error', e));
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

    const {name, type} = qs;
    const label = util.split(name);
    const end = label[label.length - 1];

    if (name.substring(end) !== HSKQ)
      return [false, null];

    // Slice off the naked TLD.
    const start = label[label.length - 2];
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
      rr.name = HSKQ;
      rr.type = types.SOA;
      rr.ttl = 900;
      rr.data = rd;
      rd.ns = name.substring(start);
      rd.mbox = HSKQ;
      rd.serial = 0;
      rd.refresh = 1800;
      rd.retry = 900;
      rd.expire = 604800;
      rd.minttl = 86400;
      res.answer.push(rr);
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
