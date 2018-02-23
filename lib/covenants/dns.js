'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const bns = require('bns');
const bio = require('bufio');
const {HSKResource} = require('./record');
const key = require('./key');

const {
  DNSServer,
  dnssec,
  wire,
  util
} = bns;

const {
  Message,
  Question,
  Record,
  Option,
  ARecord,
  AAAARecord,
  NSRecord,
  SOARecord,
  NAMEPROOFRecord,
  TRIEROOTOption,
  types,
  options,
  codes
} = wire;

/**
 * HandshakeServer
 * @extends EventEmitter
 */

class HandshakeServer extends DNSServer {
  constructor(hsk, options) {
    super(options);
    this.hsk = hsk;
    this.ra = false;
    this.inet4 = '127.0.0.1';
    this.inet6 = null;
  }

  async resolve(req, rinfo) {
    const edns = req.isEDNS0();
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
        // case types.HSKHEADER:
        //   res.answer.push(await this.getTip());
        //   break;
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
    const data = await this.hsk.getDataByName(name);
    const root = await this.getRoot(req);

    // Send the root back to them.
    const opt = new Option();
    opt.code = options.TRIEROOT;
    opt.option = new TRIEROOTOption();
    opt.option.root = root;

    // If they requested a proof directly.
    if (qs.type === types.NAMEPROOF) {
      const proof = await this.prove(root, name, data);
      const res = new Message();

      res.qr = true;
      res.aa = true;

      res.answer.push(proof);

      if (edns) {
        if (ds)
          dnssec.signMessage(res, tld, key.pub, key.priv);

        if (!getRoot(req))
          res.setOption(opt);
      }

      return res;
    }

    // Non-existent domain.
    if (!data) {
      const res = new Message();

      res.code = codes.NXDOMAIN;
      res.qr = true;
      res.aa = true;

      res.authority.push(this.toSOA());

      if (edns) {
        const proof = await this.prove(root, name, null);

        res.additional.push(proof);

        // We should also be giving an NSEC proof
        // here, but I don't think it's possible
        // with the current construction.
        if (ds) {
          dnssec.signMessage(res, '.', key.pub, key.priv);
          dnssec.signMessage(res, tld, key.pub, key.priv);
        }

        if (!getRoot(req))
          res.setOption(opt);
      }

      return res;
    }

    // Our resolution.
    const rec = HSKResource.fromRaw(data);
    const res = rec.toDNS(qs.name, qs.type, ds);

    if (res.answer.length === 0
        && res.authority.length === 0) {
      res.authority.push(this.toSOA());
    }

    if (edns) {
      const proof = await this.prove(root, name, data);

      res.additional.push(proof);

      if (ds)
        dnssec.signMessage(res, tld, key.pub, key.priv);

      if (!getRoot(req))
        res.setOption(opt);
    }

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

  async prove(root, tld, data) {
    const [, nodes] = await this.hsk.proveName(root, tld);
    const rr = new Record();
    const rd = new NAMEPROOFRecord();

    rr.name = util.fqdn(tld);
    rr.type = types.NAMEPROOF;
    rr.ttl = 900; // 15 minutes
    rr.data = rd;

    rd.exists = data ? true : false;
    rd.nodes = nodes;

    if (data)
      rd.data = data;

    return rr;
  }

  async getRoot(req) {
    const opt = getRoot(req);

    if (opt)
      return opt;

    const tip = await this.hsk.getTip();
    assert(tip);

    return Buffer.from(tip.trieRoot, 'hex');
  }
}

function getRoot(req) {
  const edns = req.getEDNS0();

  if (!edns)
    return null;

  const options = edns.data.options;

  for (const opt of options) {
    if (opt.code === wire.options.TRIEROOT)
      return opt.option.root;
  }

  return null;
}

exports.HandshakeServer = HandshakeServer;
