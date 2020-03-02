/*!
 * seeder.js - dns seed server for hsd
 * Copyright (c) 2020, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const IP = require('binet');
const bns = require('bns');
const HostList = require('../net/hostlist');

const {
  DNSServer,
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
 * Seeder
 */

class Seeder extends DNSServer {
  constructor(options) {
    assert(options != null);

    super({ inet6: false, tcp: false });

    this.ra = false;
    this.edns = true;
    this.dnssec = false;

    this.hosts = new HostList({
      network: options.network,
      prefix: options.prefix,
      filename: options.filename,
      memory: false
    });

    this.zone = '.';
    this.ns = '.';
    this.ip = null;
    this.host = '127.0.0.1';
    this.port = 53;
    this.lastRefresh = 0;
    this.res4 = new Message();
    this.res6 = new Message();

    this.initOptions(options);
  }

  initOptions(options) {
    assert(options != null);

    this.parseOptions(options);

    if (options.zone != null)
      this.zone = util.fqdn(options.zone);

    if (options.ns != null)
      this.ns = util.fqdn(options.ns);

    if (options.ip != null)
      this.ip = IP.normalize(options.ip);

    if (options.host != null)
      this.host = IP.normalize(options.host);

    if (options.port != null) {
      assert((options.port & 0xffff) === options.port);
      assert(options.port !== 0);
      this.port = options.port;
    }

    return this;
  }

  async resolve(req, rinfo) {
    const [qs] = req.question;
    const {name, type} = qs;

    if (!util.isSubdomain(this.zone, name))
      throw createError(codes.NOTZONE);

    if (!util.equal(name, this.zone))
      return this.createEmpty(codes.NXDOMAIN);

    await this.refresh();

    switch (type) {
      case types.ANY:
      case types.A:
        return this.res4.clone();
      case types.AAAA:
        return this.res6.clone();
      case types.NS:
        return this.createNS();
      case types.SOA:
        return this.createSOA();
    }

    return this.createEmpty(codes.SUCCESS);
  }

  async refresh() {
    if (Date.now() > this.lastRefresh + 10 * 60 * 1000) {
      this.hosts.reset();

      try {
        await this.hosts.loadFile();
      } catch (e) {
        return;
      }

      this.lastRefresh = Date.now();
      this.res4 = this.createA(types.A);
      this.res6 = this.createA(types.AAAA);
    }
  }

  createA(type) {
    const res = new Message();
    const items = [];

    for (const entry of this.hosts.map.values()) {
      const {addr} = entry;

      if (this.hosts.isStale(entry))
        continue;

      if (!entry.lastSuccess)
        continue;

      if (addr.port !== this.hosts.network.port)
        continue;

      if (addr.hasKey())
        continue;

      if (!addr.isValid())
        continue;

      items.push(entry);
    }

    items.sort((a, b) => {
      return b.lastSuccess - a.lastSuccess;
    });

    for (const entry of items) {
      const {addr} = entry;

      switch (type) {
        case types.A:
          if (!addr.isIPv4())
            continue;
          res.answer.push(createA(this.zone, addr.host));
          break;
        case types.AAAA:
          if (!addr.isIPv6())
            continue;
          res.answer.push(createAAAA(this.zone, addr.host));
          break;
      }

      if (res.answer.length === 50)
        break;
    }

    if (res.answer.length === 0)
      return this.createEmpty(codes.SUCCESS);

    return res;
  }

  createNS() {
    const res = new Message();

    res.answer.push(createNS(this.zone, this.ns));

    if (this.ip) {
      const rr = IP.isIPv6String(this.ip)
        ? createAAAA(this.ns, this.ip)
        : createA(this.ns, this.ip);

      res.additional.push(rr);
    }

    return res;
  }

  createSOA() {
    const res = new Message();
    res.answer.push(createSOA(this.zone, this.ns, this.zone));
    return res;
  }

  createEmpty(code) {
    const res = new Message();
    res.code = code;
    res.authority.push(createSOA(this.zone, this.ns, this.zone));
    return res;
  }

  async open() {
    return super.open(this.port, this.host);
  }
}

/*
 * Helpers
 */

function createSOA(name, ns, mbox) {
  const rr = new Record();
  const rd = new SOARecord();

  rr.name = name;
  rr.type = types.SOA;
  rr.ttl = 86400;
  rr.data = rd;
  rd.ns = ns;
  rd.mbox = mbox;
  rd.serial = Math.floor(Date.now() / 1000);
  rd.refresh = 604800;
  rd.retry = 86400;
  rd.expire = 2592000;
  rd.minttl = 604800;

  return rr;
}

function createNS(name, ns) {
  const rr = new Record();
  const rd = new NSRecord();
  rr.name = name;
  rr.type = types.NS;
  rr.ttl = 40000;
  rr.data = rd;
  rd.ns = ns;
  return rr;
}

function createA(name, address) {
  const rr = new Record();
  const rd = new ARecord();
  rr.name = name;
  rr.type = types.A;
  rr.ttl = 3600;
  rr.data = rd;
  rd.address = address;
  return rr;
}

function createAAAA(name, address) {
  const rr = new Record();
  const rd = new AAAARecord();
  rr.name = name;
  rr.type = types.AAAA;
  rr.ttl = 3600;
  rr.data = rd;
  rd.address = address;
  return rr;
}

function createError(code) {
  const err = new Error('Invalid request.');
  err.type = 'DNSError';
  err.errno = code;
  return err;
}

/*
 * Expose
 */

module.exports = Seeder;
