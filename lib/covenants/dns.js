'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const bns = require('bns');
const bio = require('bufio');
const {HSKResource} = require('./record');
const key = require('./key');

const {
  Cache,
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
    this.cache = new Cache();
    this.hsk = hsk;
    this.ra = false;
  }

  async resolve(req, rinfo) {
    const [qs] = req.question;

    // Our root zone.
    if (qs.name === '.') {
      const res = new Message();

      res.qr = true;
      res.ad = true;
      res.aa = true;

      switch (qs.type) {
        case types.NS:
          res.answer.push(this.toNS());
          res.additional.push(this.toNSIPA());
          res.additional.push(this.toNSIPAAAA());
          break;
        case types.SOA:
          res.answer.push(this.toSOA());
          break;
        case types.DNSKEY:
          res.answer.push(key.pub);
          break;
        default:
          res.authority.push(this.toSOA());
          break;
      }

      if (req.isDNSSEC())
        dnssec.signMessage(res, '.', key.pub, key.priv);

      return res;
    }

    // Slice off the naked TLD.
    const labels = util.split(qs.name);
    const tld = util.from(qs.name, labels, -1);
    const name = util.label(qs.name, labels, -1);
    const data = await this.hsk.getDataByName(name);
    const root = await this.getRoot(req);

    // Send the root back to them.
    const opt = new Option();
    opt.code = options.TRIEROOT;
    opt.option = new TRIEROOTOption();
    opt.option.root = root;

    // Should return root zone SOA record.
    if (!data) {
      const res = new Message();

      res.code = codes.NXDOMAIN;
      res.qr = true;
      res.ad = true;
      res.aa = true;

      res.authority.push(this.toSOA());

      if (req.isEDNS0()) {
        const proof = await this.prove(root, name, 900, null);

        res.additional.push(proof);

        if (req.isDNSSEC()) {
          dnssec.signMessage(res, '.', key.pub, key.priv);
          dnssec.signMessage(res, tld, key.pub, key.priv);
        }

        res.setOption(opt);
      }

      return res;
    }

    // Our resolution.
    const rec = HSKResource.fromRaw(data);
    const res = rec.toDNS(qs.name, qs.type);

    if (req.isEDNS0()) {
      const proof = await this.prove(root, name, rec.ttl, data);

      res.additional.push(proof);

      if (req.isDNSSEC())
        dnssec.signMessage(res, tld, key.pub, key.priv);

      res.setOption(opt);
    }

    return res;
  }

  toSOA() {
    const rr = new Record();
    const rd = new SOARecord();
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
    return rr;
  }

  toNS() {
    const rr = new Record();
    const rd = new NSRecord();
    rr.name = '.';
    rr.type = types.NS;
    rr.ttl = 900;
    rr.data = rd;
    rd.ns = 'localhost.';
    return rr;
  }

  toNSIPA() {
    const rr = new Record();
    const rd = new ARecord();
    rr.name = 'localhost.';
    rr.type = types.A;
    rr.ttl = 900;
    rr.data = rd;
    rd.address = '127.0.0.1';
    return rr;
  }

  toNSIPAAAA() {
    const rr = new Record();
    const rd = new AAAARecord();
    rr.name = 'localhost.';
    rr.type = types.AAAA;
    rr.ttl = 900;
    rr.data = rd;
    rd.address = '::1';
    return rr;
  }

  async prove(root, tld, ttl, data) {
    const [, nodes] = await this.hsk.proveName(root, tld);
    const rr = new Record();
    const rd = new NAMEPROOFRecord();

    rr.name = `${tld}.`;
    rr.type = types.NAMEPROOF;
    rr.ttl = ttl;
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
