/*!
 * dns.js - dns server for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const bns = require('bns');
const secp256k1 = require('bcrypto/lib/secp256k1');
const blake2b = require('bcrypto/lib/blake2b');
const Resource = require('./resource');
const key = require('./key');

const {
  DNSServer,
  dnssec,
  hsig,
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
 * @extends {DNSServer}
 */

class RootServer extends DNSServer {
  constructor(node, options) {
    super({ inet6: false });

    this.network = node.network;
    this.logger = node.logger.context('ns');
    this.db = node.chain.db;
    this.key = node.identityKey;

    this.ra = false;

    this.inet4 = '127.0.0.1';
    this.inet6 = null;

    this.initNode();
  }

  initNode() {
    this.on('error', (err) => {
      this.logger.error(err);
    });

    this.on('query', (req, res) => {
      this.logMessage('DNS Request:', req);
      this.logMessage('DNS Response:', res);
    });

    return this;
  }

  logMessage(prefix, msg) {
    const logs = msg.toString().trim().split('\n');

    this.logger.spam(prefix);

    for (const log of logs)
      this.logger.spam(log);
  }

  sign(msg, host, port) {
    return hsig.sign(msg, this.key, blake2b, secp256k1);
  }

  async lookup(name) {
    const raw = Buffer.from(name.toLowerCase(), 'ascii');
    return this.db.trie.get(blake2b.digest(raw));
  }

  async resolve(req, rinfo) {
    const ds = req.isDNSSEC();
    const [qs] = req.question;

    // Our root zone.
    if (qs.name === '.') {
      const res = new Message();

      res.qr = true;
      res.aa = true;
      res.ad = ds;

      switch (qs.type) {
        case types.ANY:
        case types.NS:
          res.answer.push(this.toNS());
          res.additional.push(this.toA());
          if (this.inet6)
            res.additional.push(this.toAAAA());
          if (ds)
            dnssec.signMessage(res, '.', key.zsk, key.priv);
          break;
        case types.SOA:
          res.answer.push(this.toSOA());
          res.authority.push(this.toNS());
          res.additional.push(this.toA());
          if (this.inet6)
            res.additional.push(this.toAAAA());
          if (ds)
            dnssec.signMessage(res, '.', key.zsk, key.priv);
          break;
        case types.DNSKEY:
          res.answer.push(key.ksk);
          res.answer.push(key.zsk);
          if (ds)
            dnssec.signMessage(res, '.', key.ksk, key.priv);
          break;
        default:
          res.authority.push(this.toSOA());
          if (ds)
            dnssec.signMessage(res, '.', key.zsk, key.priv);
          break;
      }

      return res;
    }

    // Process the name.
    const labels = util.split(qs.name);
    const tld = util.from(qs.name, labels, -1);
    const name = util.label(qs.name, labels, -1);

    // Lookup the name data.
    const data = await this.lookup(name);

    // Non-existent domain.
    if (!data) {
      const res = new Message();

      res.code = codes.NXDOMAIN;
      res.qr = true;
      res.aa = true;
      res.ad = ds;

      res.authority.push(this.toSOA());

      // We should also be giving an NSEC proof
      // here, but I don't think it's possible
      // with the current construction.
      if (ds)
        dnssec.signMessage(res, '.', key.zsk, key.priv);

      return res;
    }

    // Our resolution.
    const resource = Resource.fromRaw(data);
    const res = resource.toDNS(qs.name, qs.type, ds);

    if (res.answer.length === 0
        && res.authority.length === 0) {
      res.authority.push(this.toSOA());
    }

    if (ds) {
      dnssec.signMessage(res, tld, key.zsk, key.priv);
      dnssec.signMessage(res, '.', key.zsk, key.priv);
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
}

/**
 * RecursiveServer
 * @extends {DNSServer}
 */

class RecursiveServer extends DNSServer {
  constructor(node, options) {
    super({ inet6: false });

    this.network = node.network;
    this.logger = node.logger.context('rs');
    this.cdb = node.chain.cdb;
    this.key = node.identityKey;

    this.ra = true;

    this.resolver = new bns.RecursiveResolver({
      inet6: false,
      edns: true,
      dnssec: true
    });

    this.hints = this.resolver.hints;
    this.hints.clear();
    this.hints.ns.push('hints.local.');
    this.hints.inet4.set('hints.local.', '127.0.0.1');
    this.hints.anchors.push(key.ds);
    this.hints.port = this.network.nsPort;

    this.initNode();
  }

  initNode() {
    this.resolver.on('log', (...args) => {
      this.logger.debug(...args);
    });

    this.on('error', (err) => {
      this.logger.error(err);
    });

    this.on('query', (req, res) => {
      this.logMessage('DNS Request:', req);
      this.logMessage('DNS Response:', res);
    });

    return this;
  }

  logMessage(prefix, msg) {
    const logs = msg.toString().trim().split('\n');

    this.logger.spam(prefix);

    for (const log of logs)
      this.logger.spam(log);
  }

  sign(msg, host, port) {
    return hsig.sign(msg, this.key, blake2b, secp256k1);
  }

  async resolve(req, rinfo) {
    const [qs] = req.question;
    const res = await this.resolver.resolve(qs);
    return dnssec.filterMessage(res, qs.type);
  }
}

/*
 * Expose
 */

exports.RootServer = RootServer;
exports.RecursiveServer = RecursiveServer;
