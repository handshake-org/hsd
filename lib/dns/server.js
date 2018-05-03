/*!
 * dns.js - dns server for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const bns = require('bns');
const secp256k1 = require('bcrypto/lib/secp256k1');
const blake2b = require('bcrypto/lib/blake2b');
const LRU = require('blru');
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
 * RootCache
 */

class RootCache {
  constructor(size) {
    this.cache = new LRU(size);
  }

  set(name, type, msg) {
    const key = toKey(name, type);
    const raw = msg.compress();

    this.cache.set(key, {
      time: Date.now(),
      raw
    });

    return this;
  }

  get(name, type) {
    const key = toKey(name, type);
    const item = this.cache.get(key);

    if (!item)
      return null;

    if (Date.now() > item.time + 6 * 60 * 60 * 1000)
      return null;

    return Message.fromRaw(item.raw);
  }
}

/**
 * RootServer
 * @extends {DNSServer}
 */

class RootServer extends DNSServer {
  constructor(node, options) {
    super({ inet6: false, tcp: true });

    this.ra = false;
    this.edns = true;
    this.dnssec = true;

    this.network = node.network;
    this.logger = node.logger.context('ns');
    this.db = node.chain.db;
    this.key = node.identityKey;
    this.cache = new RootCache(3000);

    this.addr4 = '127.0.0.1';
    this.addr6 = null;

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

  signSize() {
    return 94;
  }

  sign(msg, host, port) {
    return hsig.sign(msg, this.key, blake2b, secp256k1);
  }

  async lookup(name) {
    const raw = Buffer.from(name.toLowerCase(), 'ascii');
    return this.db.trie.get(blake2b.digest(raw));
  }

  async response(req, rinfo) {
    const [qs] = req.question;

    // Our root zone.
    if (qs.name === '.') {
      const res = new Message();

      res.aa = true;

      switch (qs.type) {
        case types.ANY:
        case types.NS:
          res.answer.push(this.toNS());
          key.signZSK(res.answer, types.NS);

          res.additional.push(this.toA());
          key.signZSK(res.additional, types.A);

          if (this.addr6) {
            res.additional.push(this.toAAAA());
            key.signZSK(res.additional, types.AAAA);
          }

          break;
        case types.SOA:
          res.answer.push(this.toSOA());
          key.signZSK(res.answer, types.SOA);

          res.authority.push(this.toNS());
          key.signZSK(res.authority, types.NS);

          res.additional.push(this.toA());
          key.signZSK(res.additional, types.A);

          if (this.addr6) {
            res.additional.push(this.toAAAA());
            key.signZSK(res.additional, types.AAAA);
          }

          break;
        case types.DNSKEY:
          res.answer.push(key.ksk.deepClone());
          res.answer.push(key.zsk.deepClone());
          key.signKSK(res.answer, types.DNSKEY);
          break;
        case types.DS:
          res.answer.push(key.ds.deepClone());
          key.signZSK(res.answer, types.DS);
          break;
        default:
          res.authority.push(this.toSOA());
          key.signZSK(res.authority, types.SOA);
          break;
      }

      return res;
    }

    // Process the name.
    const labels = util.split(qs.name);
    const name = util.label(qs.name, labels, -1);

    // Lookup the name data.
    const data = await this.lookup(name);

    // Non-existent domain.
    if (!data) {
      const res = new Message();

      res.code = codes.NXDOMAIN;
      res.aa = true;

      // We should also be giving an NSEC proof
      // here, but I don't think it's possible
      // with the current construction.
      //
      // I imagine this would only be possible
      // if NSEC3 begins to support BLAKE2b for
      // name hashing. Even then, it's still
      // not possible for SPV nodes since they
      // can't arbitrarily iterate over the trie.
      res.authority.push(this.toSOA());
      key.signZSK(res.authority, types.SOA);

      return res;
    }

    // Our resolution.
    const resource = Resource.fromRaw(data);
    const res = resource.toDNS(qs.name, qs.type);

    if (res.answer.length === 0
        && res.authority.length === 0) {
      res.authority.push(this.toSOA());
      key.signZSK(res.authority, types.SOA);
    }

    return res;
  }

  async resolve(req, rinfo) {
    const [qs] = req.question;
    const {name, type} = qs;

    // Hit the cache first.
    const cache = this.cache.get(name, type);

    if (cache)
      return cache;

    const res = await this.response(req, rinfo);

    this.cache.set(name, type, res);

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
    rd.address = this.addr4;
    return rr;
  }

  toAAAA() {
    const rr = new Record();
    const rd = new AAAARecord();
    rr.name = '.';
    rr.type = types.AAAA;
    rr.ttl = 518400;
    rr.data = rd;
    rd.address = this.addr6;
    return rr;
  }
}

/**
 * RecursiveServer
 * @extends {DNSServer}
 */

class RecursiveServer extends DNSServer {
  constructor(node, options) {
    super({ inet6: false, tcp: true });

    this.ra = true;
    this.edns = true;
    this.dnssec = true;

    this.network = node.network;
    this.logger = node.logger.context('rs');
    this.cdb = node.chain.cdb;
    this.key = node.identityKey;

    this.resolver = new bns.RecursiveResolver({
      inet6: false,
      tcp: true,
      edns: true,
      dnssec: true
    });

    this.cache = this.resolver.cache;
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
}

/*
 * Helpers
 */

function toKey(name, type) {
  let labels = util.countLabels(name);
  let ref = false;

  switch (labels) {
    case 0:
    case 1:
      ref = false;
      break;
    case 2:
      ref = !Resource.isPointer(name);
      break;
    case 3:
      switch (type) {
        case types.SRV: {
          ref = !Resource.isSRV(name);
          break;
        }
        case types.TLSA: {
          ref = !Resource.isTLSA(name);
          break;
        }
        case types.SMIMEA: {
          ref = !Resource.isSMIMEA(name);
          break;
        }
        default: {
          ref = true;
          break;
        }
      }
      break;
    default:
      ref = true;
      break;
  }

  if (ref)
    labels = 1;

  const label = util.from(name, -labels, name);

  let key = '';
  key += label.toLowerCase();
  key += ';';
  key += type.toString(10);
  key += ';';
  key += ref ? '1' : '0';

  return key;
}

/*
 * Expose
 */

exports.RootServer = RootServer;
exports.RecursiveServer = RecursiveServer;
