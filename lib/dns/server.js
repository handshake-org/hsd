/*!
 * dns.js - dns server for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const bns = require('bns');
const Resource = require('./resource');
const key = require('./key');

const {
  DNSServer,
  dnssec,
  wire,
  util
} = bns;

const {
  Message,
  Record,
  ARecord,
  AAAARecord,
  NSRecord,
  SOARecord,
  types,
  codes
} = wire;

/**
 * RootServer
 * @extends {EventEmitter}
 */

class RootServer extends DNSServer {
  constructor(hsk, options) {
    super(options);
    this.hsk = hsk;
    this.ra = false;
    this.inet4 = '127.0.0.1';
    this.inet6 = null;
  }

  async resolve(req, rinfo) {
    const ds = req.isDNSSEC();
    const [qs] = req.question;

    // Our root zone.
    if (qs.name === '.') {
      const res = new Message();

      res.qr = true;
      res.aa = true;

      switch (qs.type) {
        case types.ANY:
        case types.NS:
          res.answer.push(this.toNS());
          res.additional.push(this.toA());
          if (this.inet6)
            res.additional.push(this.toAAAA());
          break;
        case types.SOA:
          res.answer.push(this.toSOA());
          res.authority.push(this.toNS());
          res.additional.push(this.toA());
          if (this.inet6)
            res.additional.push(this.toAAAA());
          break;
        case types.DNSKEY:
          res.answer.push(key.pub);
          break;
      }

      if (res.answer.length === 0
          && res.authority.length === 0) {
        res.authority.push(this.toSOA());
      }

      if (ds)
        dnssec.signMessage(res, '.', key.pub, key.priv);

      return res;
    }

    // Process the name.
    const labels = util.split(qs.name);
    const tld = util.from(qs.name, labels, -1);
    const name = util.label(qs.name, labels, -1);

    // Lookup the name data.
    const data = await this.hsk.getDataByName(name, -1);

    // Non-existent domain.
    if (!data) {
      const res = new Message();

      res.code = codes.NXDOMAIN;
      res.qr = true;
      res.aa = true;

      res.authority.push(this.toSOA());

      // We should also be giving an NSEC proof
      // here, but I don't think it's possible
      // with the current construction.
      if (ds) {
        dnssec.signMessage(res, '.', key.pub, key.priv);
        dnssec.signMessage(res, tld, key.pub, key.priv);
      }

      return res;
    }

    // Our resolution.
    const rec = Resource.fromRaw(data);
    const res = rec.toDNS(qs.name, qs.type, ds);

    if (res.answer.length === 0
        && res.authority.length === 0) {
      res.authority.push(this.toSOA());
    }

    if (ds)
      dnssec.signMessage(res, tld, key.pub, key.priv);

    return res;
  }

  serial() {
    const date = new Date();
    const y = date.getUTCFullYear() * 1e6;
    const m = (date.getUTCMonth() + 1) * 1e4;
    const d = date.getUTCDate() * 1e2;
    const h = date.getUTCHours();
    return y + m + d + h;
  }

  toSOA() {
    const rr = new Record();
    const rd = new SOARecord();

    rr.name = '.';
    rr.type = types.SOA;
    rr.ttl = 86400;
    rr.data = rd;
    rd.ns = '.';
    rd.mbox = '.';
    rd.serial = this.serial();
    rd.refresh = 1800;
    rd.retry = 900;
    rd.expire = 604800;
    rd.minttl = 86400;

    return rr;
  }

  toNS() {
    const rr = new Record();
    const rd = new NSRecord();
    rr.name = '.';
    rr.type = types.NS;
    rr.ttl = 518400;
    rr.data = rd;
    rd.ns = '.';
    return rr;
  }

  toA() {
    const rr = new Record();
    const rd = new ARecord();
    rr.name = '.';
    rr.type = types.A;
    rr.ttl = 518400;
    rr.data = rd;
    rd.address = this.inet4;
    return rr;
  }

  toAAAA() {
    const rr = new Record();
    const rd = new AAAARecord();
    rr.name = '.';
    rr.type = types.AAAA;
    rr.ttl = 518400;
    rr.data = rd;
    rd.address = this.inet6;
    return rr;
  }
}

/*
 * Expose
 */

exports.RootServer = RootServer;
