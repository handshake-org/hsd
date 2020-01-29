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
      memory: false
    });

    this.zone = '.';
    this.nameservers = [];
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
      return this.createSOA(codes.NXDOMAIN);

    await this.refresh();

    let res = null;

    switch (type) {
      case types.A:
        res = this.res4.clone();
        break;
      case types.AAAA:
        res = this.res6.clone();
        break;
    }

    if (res) {
      const ttl = this.getTTL();

      for (const rr of res.records())
        rr.ttl = ttl;

      return res;
    }

    return this.createSOA(codes.SUCCESS);
  }

  getTTL() {
    if (this.lastRefresh === 0)
      return 600;

    const ttl = this.lastRefresh + 10 * 60 * 1000 - Date.now();

    if (ttl <= 0)
      return 1;

    return Math.ceil(ttl / 1000);
  }

  async refresh() {
    if (Date.now() > this.lastRefresh + 10 * 60 * 1000) {
      this.hosts.reset();
      await this.hosts.loadFile();

      this.lastRefresh = Date.now();
      this.res4 = this.createA(types.A);
      this.res6 = this.createA(types.AAAA);
    }
  }

  createA(type) {
    const res = new Message();

    for (const addr of this.hosts.toArray()) {
      if (addr.port !== this.hosts.network.port)
        continue;

      if (addr.hasKey())
        continue;

      if (!addr.isValid())
        continue;

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

      if (res.answer.length === 250)
        break;
    }

    if (res.answer.length === 0)
      return this.createSOA(codes.SUCCESS);

    return res;
  }

  createSOA(code) {
    const res = new Message();
    res.code = code;
    res.authority.push(createSOA(this.zone, '.', '.'));
    return res;
  }

  async open() {
    return super.open(this.port, this.host);
  }
}

/*
 * Helpers
 */

function serial(ms) {
  const date = new Date(ms);
  const y = date.getUTCFullYear() * 1e6;
  const m = (date.getUTCMonth() + 1) * 1e4;
  const d = date.getUTCDate() * 1e2;
  const h = date.getUTCHours();
  return y + m + d + h;
}

function createSOA(name, ns, mbox) {
  const rr = new Record();
  const rd = new SOARecord();

  rr.name = name;
  rr.type = types.SOA;
  rr.ttl = 86400;
  rr.data = rd;
  rd.ns = ns;
  rd.mbox = mbox;
  rd.serial = serial(Date.now());
  rd.refresh = 1800;
  rd.retry = 900;
  rd.expire = 604800;
  rd.minttl = 86400;

  return rr;
}

// eslint-disable-next-line
function createNS(name, ns) {
  const rr = new Record();
  const rd = new NSRecord();
  rr.name = name;
  rr.type = types.NS;
  rr.ttl = 518400;
  rr.data = rd;
  rd.ns = ns;
  return rr;
}

function createA(name, address) {
  const rr = new Record();
  const rd = new ARecord();
  rr.name = name;
  rr.type = types.A;
  rr.ttl = 600;
  rr.data = rd;
  rd.address = address;
  return rr;
}

function createAAAA(name, address) {
  const rr = new Record();
  const rd = new AAAARecord();
  rr.name = name;
  rr.type = types.AAAA;
  rr.ttl = 600;
  rr.data = rd;
  rd.address = address;
  return rr;
}

function createError(code) {
  const err = new Error('Invalid request.');
  err.code = code;
  return err;
}

/*
 * Expose
 */

module.exports = Seeder;
