/*!
 * dnsrelay.js - experimental p2p DNS relay service for hsd
 * Copyright (c) 2026, Handshake Developers (MIT License).
 */

'use strict';

const assert = require('bsert');
const IP = require('binet');
const Logger = require('blgr');
const bns = require('bns');
const {STD_EDNS_SIZE} = require('bns/lib/constants');
const RecursiveResolver = require('bns/lib/resolver/recursive');
const bio = require('bufio');
const reserved = require('../covenants/reserved');
const rules = require('../covenants/rules');
const dnsKey = require('../dns/key');
const common = require('./common');
const packets = require('./packets');

const {wire, util} = bns;
const {
  Message,
  Question,
  Record,
  opcodes,
  codes,
  types,
  classes,
  options
} = wire;
const status = common.dnsRelayStatus;
const EMPTY = Buffer.alloc(0);
const DNS_PORT = 53;
const NAT64_PREFIX = Buffer.from('0064ff9b0000000000000000', 'hex');

const ALLOWED_TYPES = new Set([
  types.A,
  types.AAAA,
  types.CNAME,
  types.DNAME,
  types.NS,
  types.SOA,
  types.DS,
  types.DNSKEY,
  types.RRSIG,
  types.NSEC,
  types.NSEC3,
  types.NSEC3PARAM,
  types.TLSA,
  64, // SVCB (not named by bns 0.16.0).
  65, // HTTPS (not named by bns 0.16.0).
  types.TXT,
  types.MX,
  types.SRV,
  types.CAA
]);

class RelayRateBucket {
  constructor(burst, now) {
    this.tokens = burst;
    this.updated = now;
    this.lastRateNotice = -Infinity;
  }

  take(rate, burst, now) {
    const elapsed = Math.max(0, now - this.updated);
    const refill = elapsed * rate / 1000;

    this.tokens = Math.min(burst, this.tokens + refill);
    this.updated = now;

    if (this.tokens < 1)
      return false;

    this.tokens -= 1;
    return true;
  }

  notifyRateLimit(now) {
    if (now - this.lastRateNotice < 1000)
      return false;

    this.lastRateNotice = now;
    return true;
  }
}

/**
 * Recursive resolver used only by the experimental relay.
 *
 * Normal node recursion intentionally retains its existing behavior and cache.
 * This resolver has a separate bounded cache and filters every authority
 * endpoint immediately before network I/O.
 */

class RelayRecursiveResolver extends RecursiveResolver {
  constructor(options) {
    super(options);

    this.stubHost = null;
    this.stubPort = 0;
    this.allowPrivateAuthorities = false;
    this.authorityRate = common.dnsRelay.DEFAULT_AUTHORITY_RATE;
    this.authorityBurst = common.dnsRelay.DEFAULT_AUTHORITY_BURST;
    this.authorityBuckets = new Map();
    this.now = Date.now;

    if (options && options.allowPrivateAuthorities != null) {
      assert(typeof options.allowPrivateAuthorities === 'boolean');
      this.allowPrivateAuthorities = options.allowPrivateAuthorities;
    }

    if (options && options.authorityRate != null) {
      assert((options.authorityRate >>> 0) === options.authorityRate);
      assert(options.authorityRate > 0);
      this.authorityRate = options.authorityRate;
    }

    if (options && options.authorityBurst != null) {
      assert((options.authorityBurst >>> 0) === options.authorityBurst);
      assert(options.authorityBurst > 0);
      this.authorityBurst = options.authorityBurst;
    }

    if (options && options.now != null) {
      assert(typeof options.now === 'function');
      this.now = options.now;
    }
  }

  setStub(host, port, ds) {
    this.stubHost = IP.normalize(host);
    this.stubPort = port;

    return super.setStub(host, port, ds);
  }

  filterServers(servers) {
    assert(Array.isArray(servers));

    const filtered = [];

    for (const server of servers) {
      const endpoint = parseDNSServer(server);

      if (endpoint.host === this.stubHost
          && endpoint.port === this.stubPort) {
        filtered.push(server);
        continue;
      }

      if (endpoint.port === DNS_PORT
          && (isPublicDNSAddress(endpoint.host)
            || (this.allowPrivateAuthorities
              && isPrivateDNSAddress(endpoint.host)))) {
        filtered.push(server);
      }
    }

    if (filtered.length === 0) {
      throw relayError('DNS relay authority is not publicly routable.',
        'ERR_DNS_RELAY_PRIVATE_ADDRESS');
    }

    return filtered;
  }

  async exchange(req, servers) {
    assert(req instanceof Message);
    assert(Array.isArray(servers));
    assert(req.question.length > 0);

    const filtered = this.filterServers(servers);
    const [qs] = req.question;

    if (!util.isName(qs.name))
      throw new Error('Invalid qname.');

    const id = allocateRelayQueryID(this.pending);

    if (id === -1)
      throw new Error('DNS relay resolver request IDs are exhausted.');

    req.id = id;
    req.qr = false;

    const msg = req.encode();
    const tcp = this.useTCP(qs.type, msg.length);
    const query = new RelayResolverQuery(req, filtered, tcp);

    this.log('Querying relay authority (tcp=%s).', tcp);

    const pending = new Promise((resolve, reject) => {
      query.resolve = resolve;
      query.reject = reject;
    });

    this.pending.set(query.id, query);
    query.ref();

    try {
      const {port, host} = this.authorizeAuthority(query.server);
      this.socket.send(msg, 0, msg.length, port, host, tcp);
    } catch (e) {
      if (this.pending.get(query.id) === query)
        this.pending.delete(query.id);
      query.unref();
      throw e;
    }

    return pending;
  }

  /**
   * Retry a relay resolver query with egress policy and rate checks applied
   * immediately before every inherited DNS send path.
   * @param {RelayResolverQuery} query
   * @param {Boolean} rotate
   * @param {Boolean} forceTCP
   * @param {Boolean} isTimeout
   */

  retry(query, rotate, forceTCP, isTimeout) {
    let server = query.server;

    query.unref();

    if (server.tcp) {
      const {port, host} = server;
      this.socket.kill(port, host);
    }

    if (query.attempts >= this.maxAttempts) {
      this.pending.delete(query.id);

      if (query.res)
        query.resolve(query.res);
      else
        query.reject(new Error('Request timed out.'));

      return;
    }

    if (rotate) {
      server = query.nextServer(server.tcp);
      this.log('Switched relay authorities (%d).', query.id);
    }

    if (this.tcp && forceTCP)
      server.tcp = true;

    let req = query.req;

    if (isTimeout && query.attempts === this.maxAttempts - 1) {
      if (this.tcp) {
        server.tcp = true;
        this.log('Last relay attempt over TCP: %d.', query.id);
      } else if (req.edns.enabled && req.edns.size > STD_EDNS_SIZE) {
        req = req.clone();
        req.edns.size = STD_EDNS_SIZE;
        this.log('Last relay attempt with small EDNS: %d.', query.id);
      }
    }

    const msg = req.encode();
    let endpoint;

    try {
      endpoint = this.authorizeAuthority(server);
    } catch (e) {
      if (this.pending.get(query.id) === query)
        this.pending.delete(query.id);
      query.reject(e);
      return;
    }

    const {port, host} = endpoint;
    const {tcp} = server;

    try {
      this.socket.send(msg, 0, msg.length, port, host, tcp);
    } catch (e) {
      if (this.pending.get(query.id) === query)
        this.pending.delete(query.id);
      query.reject(e);
      return;
    }

    this.log('Retrying relay authority (tcp=%s): %d.', tcp, query.id);

    query.ref();
    query.time = Date.now();
    query.attempts += 1;
  }

  /**
   * Recheck and charge one authority endpoint immediately before a send.
   * @param {Object} server
   * @returns {Object}
   */

  authorizeAuthority(server) {
    const endpoint = parseDNSServer(server);

    this.filterServers([endpoint]);

    if (!this.takeAuthority(endpoint.host, endpoint.port)) {
      throw relayError('DNS relay authority rate limit reached.',
        'ERR_DNS_RELAY_AUTHORITY_RATE');
    }

    return endpoint;
  }

  takeAuthority(host, port) {
    if (host === this.stubHost && port === this.stubPort)
      return true;

    let bucket = this.authorityBuckets.get(host);

    if (bucket) {
      this.authorityBuckets.delete(host);
      this.authorityBuckets.set(host, bucket);
    } else {
      if (this.authorityBuckets.size
          >= common.dnsRelay.MAX_AUTHORITY_RATE_BUCKETS) {
        const oldest = this.authorityBuckets.keys().next().value;
        this.authorityBuckets.delete(oldest);
      }

      bucket = new RelayRateBucket(this.authorityBurst, this.now());
      this.authorityBuckets.set(host, bucket);
    }

    return bucket.take(this.authorityRate, this.authorityBurst, this.now());
  }
}

/**
 * Query state compatible with bns DNSResolver retry and response handling.
 * The upstream class is private, so the relay keeps this small local copy in
 * order to allocate collision-free transaction IDs before network I/O.
 */

class RelayResolverQuery {
  constructor(req, servers, tcp) {
    assert(req instanceof Message);
    assert(Array.isArray(servers));
    assert(servers.length > 0);
    assert(typeof tcp === 'boolean');

    this.id = req.id;
    this.req = req;
    this.index = 0;
    this.servers = util.sortRandom(servers);
    this.resolve = null;
    this.reject = null;
    this.attempts = 1;
    this.res = null;
    this.server = null;
    this.time = Date.now();
    this.timer = null;

    this.nextServer(tcp);
  }

  ref() {
    if (this.timer == null)
      this.timer = setInterval(relayQueryKeepalive, 0x7fffffff);
  }

  unref() {
    if (this.timer != null)
      clearInterval(this.timer);

    this.timer = null;
  }

  getServer(index, tcp) {
    assert((index >>> 0) < this.servers.length);
    assert(typeof tcp === 'boolean');

    const server = this.servers[index];
    const endpoint = parseDNSServer(server);

    return {
      host: endpoint.host,
      port: endpoint.port,
      tcp
    };
  }

  nextServer(tcp) {
    assert(this.index < this.servers.length);

    this.index += 1;

    if (this.index === this.servers.length)
      this.index = 0;

    this.server = this.getServer(this.index, tcp);

    return this.server;
  }
}

/**
 * A narrow raw-query adapter with a relay-only recursive resolver.
 */

class RecursiveDNSRelayBackend {
  /**
   * Create a recursive relay backend.
   * @constructor
   * @param {Object} server
   * @param {Object?} [resolver]
   */

  constructor(server, resolver, options) {
    assert(server && typeof server.finalize === 'function');

    let allowPrivateAuthorities = false;

    if (options && options.allowPrivateAuthorities != null) {
      assert(typeof options.allowPrivateAuthorities === 'boolean');
      allowPrivateAuthorities = options.allowPrivateAuthorities;
    }

    if (resolver == null)
      resolver = createRelayResolver(server, allowPrivateAuthorities);

    assert(resolver && typeof resolver.resolve === 'function');

    this.server = server;
    this.resolver = resolver;
    this.ready = false;
  }

  /**
   * Open the dedicated relay resolver after the local root server is ready.
   * @returns {Promise}
   */

  async open() {
    if (typeof this.resolver.open === 'function')
      await this.resolver.open();

    this.ready = true;
  }

  /**
   * Stop accepting new relay work and close the dedicated resolver.
   * @returns {Promise}
   */

  async close() {
    this.ready = false;

    if (typeof this.resolver.close === 'function')
      await this.resolver.close();
  }

  /**
   * Test backend readiness.
   * @returns {Boolean}
   */

  isReady() {
    return this.ready;
  }

  /**
   * Resolve a raw DNS query through the filtered relay resolver/cache.
   * @param {Buffer} query
   * @param {Object?} [options]
   * @returns {Promise<Buffer>}
   */

  async resolveRaw(query, options) {
    assert(Buffer.isBuffer(query));

    if (!this.ready)
      throw relayError('Recursive resolver is unavailable.',
        'ERR_DNS_RELAY_UNAVAILABLE');

    const req = Message.decode(query);
    const signal = options ? options.signal : null;

    if (signal)
      signal.throwIfAborted();

    let res;

    try {
      res = await this.resolver.resolve(req.question[0]);
    } catch (e) {
      if (signal)
        signal.throwIfAborted();

      if (e && e.code === 'ERR_DNS_RELAY_PRIVATE_ADDRESS') {
        throw relayError('DNS relay authority is not publicly routable.',
          'ERR_DNS_RELAY_REFUSED');
      }

      if (e && e.code === 'ERR_DNS_RELAY_AUTHORITY_RATE') {
        throw relayError('DNS relay authority rate limit reached.',
          'ERR_DNS_RELAY_BUSY');
      }

      /* Match DNSServer's normal wire behavior for recursive failures. */
      res = new Message();
      res.code = codes.SERVFAIL;
    }

    if (signal)
      signal.throwIfAborted();

    if (!(res instanceof Message))
      throw new Error('Recursive resolver returned no DNS message.');

    this.server.finalize(req, res);

    const raw = res.compress();

    if (signal)
      signal.throwIfAborted();

    return raw;
  }
}

/**
 * Experimental DNS relay server with bounded per-peer and global state.
 */

class DNSRelayService {
  /**
   * Create a relay service.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    assert(options && typeof options === 'object');

    this.enabled = false;
    this.opened = false;
    this.chain = null;
    this.rootServer = null;
    this.backend = null;
    this.backendOpened = false;
    this.logger = Logger.global.context('dns-relay');
    this.timeout = common.dnsRelay.DEFAULT_TIMEOUT;
    this.rate = common.dnsRelay.DEFAULT_RATE;
    this.burst = common.dnsRelay.DEFAULT_BURST;
    this.globalRate = common.dnsRelay.DEFAULT_GLOBAL_RATE;
    this.globalBurst = common.dnsRelay.DEFAULT_GLOBAL_BURST;
    this.maxPeerInflight = common.dnsRelay.DEFAULT_PEER_INFLIGHT;
    this.maxGlobalInflight = common.dnsRelay.DEFAULT_GLOBAL_INFLIGHT;
    this.now = Date.now;
    this.checkName = null;

    this.peers = new Map();
    this.globalInflight = 0;
    this.admissionOrphans = 0;
    this.backendOrphans = 0;
    this.drainWaiters = new Set();
    this.metrics = createMetrics();

    this.fromOptions(options);
    this.globalLimiter = new PeerRelayState(this.globalBurst, this.now());
  }

  /**
   * Inject relay options.
   * @param {Object} options
   * @returns {DNSRelayService}
   */

  fromOptions(options) {
    if (options.enabled != null) {
      assert(typeof options.enabled === 'boolean');
      this.enabled = options.enabled;
    }

    if (options.chain != null) {
      assert(typeof options.chain === 'object');
      this.chain = options.chain;
    }

    if (options.rootServer != null) {
      assert(typeof options.rootServer === 'object');
      this.rootServer = options.rootServer;
    }

    if (options.backend != null) {
      assert(typeof options.backend.resolveRaw === 'function');
      this.backend = options.backend;
    }

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger.context('dns-relay');
    }

    if (options.timeout != null) {
      assert((options.timeout >>> 0) === options.timeout);
      assert(options.timeout > 0);
      this.timeout = options.timeout;
    }

    if (options.rate != null) {
      assert((options.rate >>> 0) === options.rate);
      assert(options.rate > 0);
      this.rate = options.rate;
    }

    if (options.burst != null) {
      assert((options.burst >>> 0) === options.burst);
      assert(options.burst > 0);
      this.burst = options.burst;
    }

    if (options.globalRate != null) {
      assert((options.globalRate >>> 0) === options.globalRate);
      assert(options.globalRate > 0);
      this.globalRate = options.globalRate;
    }

    if (options.globalBurst != null) {
      assert((options.globalBurst >>> 0) === options.globalBurst);
      assert(options.globalBurst > 0);
      this.globalBurst = options.globalBurst;
    }

    if (options.maxPeerInflight != null) {
      assert((options.maxPeerInflight >>> 0) === options.maxPeerInflight);
      assert(options.maxPeerInflight > 0);
      this.maxPeerInflight = options.maxPeerInflight;
    }

    if (options.maxGlobalInflight != null) {
      assert((options.maxGlobalInflight >>> 0) === options.maxGlobalInflight);
      assert(options.maxGlobalInflight > 0);
      this.maxGlobalInflight = options.maxGlobalInflight;
    }

    if (options.now != null) {
      assert(typeof options.now === 'function');
      this.now = options.now;
    }

    if (options.checkName != null) {
      assert(typeof options.checkName === 'function');
      this.checkName = options.checkName;
    }

    assert(this.chain, 'DNS relay requires a chain.');

    return this;
  }

  /**
   * Open the relay backend after the recursive server is initialized.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'DNS relay service is already open.');

    if (this.enabled && this.backend) {
      if (typeof this.backend.open === 'function')
        await this.backend.open();

      this.backendOpened = true;
    }

    this.opened = true;
  }

  /**
   * Cancel all work and close the relay backend adapter.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'DNS relay service is not open.');

    this.opened = false;

    for (const peer of this.peers.keys())
      this.cancelPeer(peer);

    if (this.backendOpened) {
      this.backendOpened = false;

      if (typeof this.backend.close === 'function')
        await this.backend.close();
    }

    if (!await this.waitForDrain())
      this.logger.debug('DNS relay shutdown reached its drain deadline.');
  }

  /**
   * Test whether the backend can accept new work.
   * @returns {Boolean}
   */

  backendReady() {
    if (!this.backend)
      return false;

    if (typeof this.backend.isReady !== 'function')
      return true;

    return this.backend.isReady();
  }

  /**
   * Test whether the capability may be advertised to a new peer.
   * @returns {Boolean}
   */

  isReady() {
    return this.enabled
      && this.opened
      && this.chain.synced
      && this.backendReady()
      && this.globalLoad() < this.maxGlobalInflight;
  }

  /**
   * Return a copy of aggregate counters.
   * @returns {Object}
   */

  getMetrics() {
    return Object.assign({}, this.metrics, {
      inflight: this.globalInflight,
      admissionOrphans: this.admissionOrphans,
      backendOrphans: this.backendOrphans,
      peers: this.peers.size
    });
  }

  /**
   * Count live client jobs plus cancelled async work that is still running.
   * @returns {Number}
   */

  globalLoad() {
    return this.globalInflight
      + this.admissionOrphans
      + this.backendOrphans;
  }

  /**
   * Wait a bounded interval for logically cancelled async work to settle.
   * @returns {Promise<Boolean>}
   */

  waitForDrain() {
    if (this.admissionOrphans === 0 && this.backendOrphans === 0)
      return Promise.resolve(true);

    return new Promise((resolve) => {
      let timer = null;
      let waiter = null;

      const done = (drained) => {
        clearTimeout(timer);
        this.drainWaiters.delete(waiter);
        resolve(drained);
      };

      waiter = () => done(true);
      timer = setTimeout(() => done(false), this.timeout);

      this.drainWaiters.add(waiter);
    });
  }

  /**
   * Wake shutdown waiters after every physical operation has settled.
   */

  notifyDrain() {
    if (this.admissionOrphans !== 0 || this.backendOrphans !== 0)
      return;

    for (const waiter of this.drainWaiters)
      waiter();
  }

  /**
   * Accept and schedule a relay request without holding Peer's packet lock.
   * @param {Object} peer
   * @param {GetDNSRelayPacket} packet
   * @returns {Promise<Boolean>}
   */

  handle(peer, packet) {
    assert(peer && typeof peer === 'object');
    assert(packet instanceof packets.GetDNSRelayPacket);

    if (!peer.handshake
        || !(peer.localServices
          & common.EXPERIMENTAL_DNS_RELAY_SERVICE)) {
      this.metrics.invalid += 1;
      return Promise.resolve(false);
    }

    let state = this.peers.get(peer);

    if (!state) {
      state = new PeerRelayState(this.burst, this.now());
      this.peers.set(peer, state);
    }

    const now = this.now();

    if (!state.take(this.rate, this.burst, now)) {
      this.metrics.rateLimited += 1;

      if (state.notifyRateLimit(now))
        this.sendStatus(peer, packet.requestID, status.BUSY);

      return Promise.resolve(false);
    }

    if (!this.globalLimiter.take(
      this.globalRate,
      this.globalBurst,
      now)) {
      this.metrics.rateLimited += 1;
      this.metrics.globalRateLimited += 1;

      if (this.globalLimiter.notifyRateLimit(now))
        this.sendStatus(peer, packet.requestID, status.BUSY);

      return Promise.resolve(false);
    }

    if (!this.enabled) {
      this.metrics.unsupported += 1;
      this.sendStatus(peer, packet.requestID, status.UNSUPPORTED);
      return Promise.resolve(false);
    }

    if (!this.opened || !this.chain.synced || !this.backendReady()) {
      this.metrics.unavailable += 1;
      this.sendStatus(peer, packet.requestID, status.RESOLVER_UNAVAILABLE);
      return Promise.resolve(false);
    }

    const key = packet.requestID.toString('hex');

    if (state.requests.has(key)) {
      this.metrics.invalid += 1;
      this.sendStatus(peer, packet.requestID, status.INVALID_QUERY);
      return Promise.resolve(false);
    }

    let request;

    try {
      request = validateQuery(packet.query);
    } catch (e) {
      this.metrics.invalid += 1;
      this.sendStatus(peer, packet.requestID, status.INVALID_QUERY);
      return Promise.resolve(false);
    }

    if (state.physicalInflight >= this.maxPeerInflight
        || this.globalLoad() >= this.maxGlobalInflight) {
      this.metrics.busy += 1;
      this.sendStatus(peer, packet.requestID, status.BUSY);
      return Promise.resolve(false);
    }

    const job = new RelayJob(state, peer, packet, key, request, this.now());

    state.requests.set(key, job);
    state.physicalInflight += 1;
    this.globalInflight += 1;

    const pending = this.process(state, job);
    job.promise = pending;

    return pending;
  }

  /**
   * Validate HNS state and perform recursive lookup.
   * @private
   * @param {PeerRelayState} state
   * @param {RelayJob} job
   * @returns {Promise<Boolean>}
   */

  async process(state, job) {
    let admitted;

    job.timer = setTimeout(() => {
      job.timedOut = true;
      job.signal.abort();
    }, this.timeout);

    try {
      admitted = await job.signal.race(this.startAdmission(job));
    } catch (e) {
      if (!this.active(state, job))
        return false;

      if (job.timedOut) {
        this.metrics.timeouts += 1;
        this.finish(state, job, status.TIMEOUT);
        return false;
      }

      this.metrics.unavailable += 1;
      this.finish(state, job, status.RESOLVER_UNAVAILABLE);
      return false;
    }

    if (!this.active(state, job))
      return false;

    if (!admitted) {
      this.metrics.refused += 1;
      this.finish(state, job, status.REFUSED);
      return false;
    }

    this.metrics.accepted += 1;

    try {
      const raw = await job.signal.race(this.startBackend(job));

      if (!this.active(state, job))
        return false;

      if (!Buffer.isBuffer(raw) || raw.length === 0) {
        this.metrics.backendFailures += 1;
        this.finish(state, job, status.INTERNAL_ERROR);
        return false;
      }

      if (raw.length > common.dnsRelay.MAX_RESPONSE_SIZE) {
        this.metrics.oversized += 1;
        this.finish(state, job, status.INTERNAL_ERROR);
        return false;
      }

      this.metrics.success += 1;
      this.finish(state, job, status.OK, raw);
      return true;
    } catch (e) {
      if (!this.active(state, job))
        return false;

      if (job.timedOut) {
        this.metrics.timeouts += 1;
        this.finish(state, job, status.TIMEOUT);
        return false;
      }

      if (e && e.code === 'ERR_DNS_RELAY_UNAVAILABLE') {
        this.metrics.unavailable += 1;
        this.finish(state, job, status.RESOLVER_UNAVAILABLE);
        return false;
      }

      if (e && e.code === 'ERR_DNS_RELAY_REFUSED') {
        this.metrics.refused += 1;
        this.finish(state, job, status.REFUSED);
        return false;
      }

      if (e && e.code === 'ERR_DNS_RELAY_BUSY') {
        this.metrics.busy += 1;

        if (state.notifyRateLimit(this.now()))
          this.finish(state, job, status.BUSY);
        else
          this.release(state, job);

        return false;
      }

      this.metrics.backendFailures += 1;
      this.finish(state, job, status.INTERNAL_ERROR);
      return false;
    }
  }

  /**
   * Test whether a job is still owned by its peer state.
   * @private
   * @param {PeerRelayState} state
   * @param {RelayJob} job
   * @returns {Boolean}
   */

  active(state, job) {
    return state.requests.get(job.key) === job;
  }

  /**
   * Start one physically bounded current-name admission lookup.
   * @private
   * @param {RelayJob} job
   * @returns {Promise<Boolean>}
   */

  startAdmission(job) {
    assert(!job.admissionActive);

    job.admissionActive = true;

    let pending;

    try {
      pending = Promise.resolve(this.isHNSName(job.request.tld));
    } catch (e) {
      pending = Promise.reject(e);
    }

    job.admissionPromise = pending;

    pending.then(() => {
      this.settleAdmission(job);
    }, () => {
      this.settleAdmission(job);
    });

    return pending;
  }

  /**
   * Release admission capacity after the chain lookup actually settles.
   * @private
   * @param {RelayJob} job
   */

  settleAdmission(job) {
    assert(job.admissionActive);

    job.admissionActive = false;
    job.admissionPromise = null;

    if (job.admissionOrphan) {
      assert(this.admissionOrphans > 0);
      this.admissionOrphans -= 1;
      job.admissionOrphan = false;
      this.releasePeerCapacity(job);
      this.notifyDrain();
    }
  }

  /**
   * Start one physically bounded backend operation.
   * @private
   * @param {RelayJob} job
   * @returns {Promise<Buffer>}
   */

  startBackend(job) {
    assert(!job.backendActive);

    job.backendActive = true;

    let pending;

    try {
      pending = Promise.resolve(this.backend.resolveRaw(
        job.packet.query,
        {signal: job.signal}));
    } catch (e) {
      pending = Promise.reject(e);
    }

    job.backendPromise = pending;

    pending.then(() => {
      this.settleBackend(job);
    }, () => {
      this.settleBackend(job);
    });

    return pending;
  }

  /**
   * Release physical backend capacity after the resolver actually settles.
   * @private
   * @param {RelayJob} job
   */

  settleBackend(job) {
    assert(job.backendActive);

    job.backendActive = false;
    job.backendPromise = null;

    if (job.backendOrphan) {
      assert(this.backendOrphans > 0);
      this.backendOrphans -= 1;
      job.backendOrphan = false;
      this.releasePeerCapacity(job);
      this.notifyDrain();
    }
  }

  /**
   * Complete a job and release every bounded resource.
   * @private
   * @param {PeerRelayState} state
   * @param {RelayJob} job
   * @param {Number} code
   * @param {Buffer?} [raw]
   */

  finish(state, job, code, raw) {
    if (!this.release(state, job))
      return;

    this.sendStatus(job.peer, job.packet.requestID, code, raw);

    const elapsed = Math.max(0, this.now() - job.started);
    const size = raw ? raw.length : 0;

    this.logger.debug(
      'DNS relay completed (status=%d, size=%s, latency=%s).',
      code,
      sizeBucket(size),
      latencyBucket(elapsed));
  }

  /**
   * Release a job without sending a response.
   * @private
   * @param {PeerRelayState} state
   * @param {RelayJob} job
   * @returns {Boolean}
   */

  release(state, job) {
    if (!this.active(state, job))
      return false;

    state.requests.delete(job.key);

    if (job.timer != null) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    if (job.admissionActive) {
      assert(!job.admissionOrphan);
      job.admissionOrphan = true;
      this.admissionOrphans += 1;
    }

    if (job.backendActive) {
      assert(!job.backendOrphan);
      job.backendOrphan = true;
      this.backendOrphans += 1;
    }

    if (!job.admissionActive && !job.backendActive)
      this.releasePeerCapacity(job);

    assert(this.globalInflight > 0);
    this.globalInflight -= 1;

    return true;
  }

  /**
   * Release the physical-work slot charged to one peer.
   * @private
   * @param {RelayJob} job
   */

  releasePeerCapacity(job) {
    if (!job.peerCapacity)
      return;

    assert(job.state.physicalInflight > 0);

    job.peerCapacity = false;
    job.state.physicalInflight -= 1;
  }

  /**
   * Cancel all jobs owned by a disconnected peer.
   * @param {Object} peer
   */

  cancelPeer(peer) {
    const state = this.peers.get(peer);

    if (!state)
      return;

    for (const job of state.requests.values()) {
      if (this.release(state, job)) {
        this.metrics.cancelled += 1;
        job.signal.abort();
      }
    }

    this.peers.delete(peer);
  }

  /**
   * Send one bounded transport response.
   * @private
   * @param {Object} peer
   * @param {Buffer} requestID
   * @param {Number} code
   * @param {Buffer?} [raw]
   */

  sendStatus(peer, requestID, code, raw) {
    if (peer.destroyed)
      return;

    if (!raw)
      raw = EMPTY;

    try {
      peer.send(new packets.DNSRelayPacket(requestID, code, raw));
    } catch (e) {
      this.logger.debug('Unable to send DNS relay status (%d).', code);
    }
  }

  /**
   * Check whether a root is active in the current HNS name state.
   * @private
   * @param {String} tld
   * @returns {Promise<Boolean>}
   */

  async isHNSName(tld) {
    const item = reserved.getByName(tld);

    if (item && item.root)
      return false;

    if (this.checkName)
      return Boolean(await this.checkName(tld));

    if (this.rootServer && this.rootServer.blacklist.has(tld))
      return false;

    const hash = rules.hashName(tld);
    const ns = await this.chain.db.getNameStatus(hash, this.chain.height + 1);

    return ns.registered
      && !ns.expired
      && ns.data.length > 0;
  }
}

/**
 * Parse and validate the restricted recursive query envelope.
 * @param {Buffer} raw
 * @returns {Object}
 */

function validateQuery(raw) {
  assert(Buffer.isBuffer(raw));

  if (raw.length === 0 || raw.length > common.dnsRelay.MAX_QUERY_SIZE)
    throw new Error('DNS relay query exceeds size limits.');

  validateQuerySections(raw);

  const req = Message.decode(raw);

  if (req.malformed || req.trailing.length !== 0)
    throw new Error('Malformed DNS relay query.');

  if (req.qr || req.opcode !== opcodes.QUERY || req.code !== 0)
    throw new Error('DNS relay query has invalid header flags.');

  if (req.aa || req.tc || req.ra || req.z)
    throw new Error('DNS relay query has response-only header flags.');

  if (!req.rd)
    throw new Error('DNS relay query requires recursion desired.');

  if (req.question.length !== 1)
    throw new Error('DNS relay query must contain one question.');

  if (req.answer.length !== 0
      || req.authority.length !== 0
      || req.additional.length !== 0) {
    throw new Error('DNS relay query contains unexpected records.');
  }

  if (req.tsig || req.sig0)
    throw new Error('Signed DNS relay queries are not accepted.');

  if (!req.isEDNS() || !req.isDNSSEC() || req.edns.version !== 0)
    throw new Error('DNS relay query requires DNSSEC EDNS.');

  if (req.edns.flags !== 0x8000)
    throw new Error('DNS relay query has reserved EDNS flags.');

  if (req.edns.size < 512
      || req.edns.size > common.dnsRelay.MAX_QUERY_SIZE) {
    throw new Error('DNS relay query has invalid EDNS size.');
  }

  for (const option of req.edns.options) {
    if (option.code === options.SUBNET)
      throw new Error('EDNS Client Subnet is not accepted.');
  }

  const [qs] = req.question;

  if (qs.class !== classes.IN)
    throw new Error('DNS relay query class is not IN.');

  if (!ALLOWED_TYPES.has(qs.type))
    throw new Error('DNS relay query type is not accepted.');

  if (!util.isName(qs.name))
    throw new Error('DNS relay query name is invalid.');

  const tld = util.label(qs.name.toLowerCase(), -1);

  if (!rules.verifyName(tld))
    throw new Error('DNS relay root name is not an HNS name.');

  return {message: req, question: qs, tld};
}

/**
 * Require exactly one question and one root-owner OPT on the original wire.
 * This must run before Message.decode normalizes special additional records.
 * @param {Buffer} raw
 */

function validateQuerySections(raw) {
  if (raw.length < 12)
    throw new Error('DNS relay query header is truncated.');

  if (raw.readUInt16BE(4) !== 1
      || raw.readUInt16BE(6) !== 0
      || raw.readUInt16BE(8) !== 0
      || raw.readUInt16BE(10) !== 1) {
    throw new Error('DNS relay query has invalid section counts.');
  }

  const br = bio.read(raw);

  br.seek(12);
  Question.read(br);

  const rr = Record.read(br);

  if (!rr.isOPT() || !util.equal(rr.name, '.'))
    throw new Error('DNS relay query requires one root-owner OPT record.');

  if (br.left() !== 0)
    throw new Error('DNS relay query contains trailing wire data.');
}

/**
 * Per-peer token bucket and live request map.
 */

class PeerRelayState extends RelayRateBucket {
  constructor(burst, now) {
    super(burst, now);
    this.requests = new Map();
    this.physicalInflight = 0;
  }
}

/**
 * One live backend operation.
 */

class RelayJob {
  constructor(state, peer, packet, key, request, started) {
    this.state = state;
    this.peer = peer;
    this.packet = packet;
    this.key = key;
    this.request = request;
    this.started = started;
    this.signal = new RelaySignal();
    this.timer = null;
    this.promise = null;
    this.timedOut = false;
    this.admissionActive = false;
    this.admissionOrphan = false;
    this.admissionPromise = null;
    this.backendActive = false;
    this.backendOrphan = false;
    this.backendPromise = null;
    this.peerCapacity = true;
  }
}

/**
 * Small cancellation primitive compatible with the supported Node versions.
 */

class RelaySignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }

  throwIfAborted() {
    if (this.aborted)
      throw relayError('DNS relay request was cancelled.',
        'ERR_DNS_RELAY_CANCELLED');
  }

  abort() {
    if (this.aborted)
      return;

    this.aborted = true;

    for (const listener of this.listeners)
      listener();

    this.listeners.clear();
  }

  race(promise) {
    this.throwIfAborted();

    return new Promise((resolve, reject) => {
      const cancelled = () => {
        reject(relayError('DNS relay request was cancelled.',
          'ERR_DNS_RELAY_CANCELLED'));
      };

      this.listeners.add(cancelled);

      Promise.resolve(promise).then((value) => {
        this.listeners.delete(cancelled);
        resolve(value);
      }, (err) => {
        this.listeners.delete(cancelled);
        reject(err);
      });
    });
  }
}

function allocateRelayQueryID(pending, initial) {
  assert(pending instanceof Map);

  if (initial == null)
    initial = util.id();

  assert((initial & 0xffff) === initial);

  for (let offset = 0; offset <= 0xffff; offset++) {
    const id = (initial + offset) & 0xffff;

    if (!pending.has(id))
      return id;
  }

  return -1;
}

function relayQueryKeepalive() {}

function createRelayResolver(server, allowPrivateAuthorities) {
  assert(typeof server.stubHost === 'string');
  assert((server.stubPort & 0xffff) === server.stubPort);
  assert(server.stubPort !== 0);
  assert(typeof allowPrivateAuthorities === 'boolean');

  const resolver = new RelayRecursiveResolver({
    inet6: false,
    tcp: true,
    edns: true,
    dnssec: true,
    minimize: true,
    allowPrivateAuthorities
  });

  // The dedicated relay resolver always requests unfiltered DNSSEC material.
  // Requesters authenticate it locally and never trust this resolver's AD bit.
  resolver.cd = true;

  resolver.setStub(server.stubHost, server.stubPort, dnsKey.ds);

  return resolver;
}

function parseDNSServer(server) {
  let host;
  let port = DNS_PORT;

  if (typeof server === 'string') {
    host = server;
  } else {
    if (!server || typeof server !== 'object')
      throw new Error('Invalid DNS relay authority.');

    host = server.address || server.host;
    port = server.port == null ? DNS_PORT : server.port;
  }

  if (typeof host !== 'string'
      || (port & 0xffff) !== port
      || port === 0) {
    throw new Error('Invalid DNS relay authority.');
  }

  return {
    host: IP.normalize(host),
    port
  };
}

function isPublicDNSAddress(host) {
  let raw;

  try {
    raw = IP.toBuffer(host);
  } catch (e) {
    return false;
  }

  if (IP.isIPv4(raw))
    return isPublicIPv4(raw[12], raw[13], raw[14]);

  if (raw.subarray(0, NAT64_PREFIX.length).equals(NAT64_PREFIX)) {
    return isPublicIPv4(raw[12], raw[13], raw[14]);
  }

  const first = raw.readUInt16BE(0);
  const second = raw.readUInt16BE(2);
  const third = raw.readUInt16BE(4);

  if ((first & 0xe000) !== 0x2000)
    return false;

  if (first === 0x2001 && second === 0x0000)
    return false;

  if (first === 0x2001 && second === 0x0002 && third === 0)
    return false;

  if (first === 0x2001 && (second & 0xfff0) === 0x0010)
    return false;

  if (first === 0x2001 && (second & 0xfff0) === 0x0020)
    return false;

  if (first === 0x2001 && second === 0x0db8)
    return false;

  if (first === 0x2002)
    return false;

  if ((first & 0xfff0) === 0x3ff0)
    return false;

  return true;
}

/**
 * Test whether an endpoint is explicitly private IPv4 unicast address space.
 *
 * This deliberately excludes loopback, link-local, carrier-grade NAT,
 * benchmarking/documentation ranges, multicast, and unspecified addresses.
 * It exists only for the separately gated regtest integration option.
 * @param {String} host
 * @returns {Boolean}
 */

function isPrivateDNSAddress(host) {
  let raw;

  try {
    raw = IP.toBuffer(host);
  } catch (e) {
    return false;
  }

  if (IP.isIPv4(raw)) {
    const a = raw[12];
    const b = raw[13];

    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }

  // The relay-only resolver is intentionally IPv4-only (inet6 is disabled).
  // Do not admit an IPv6 authority that this backend cannot contact.
  return false;
}

function isPublicIPv4(a, b, c) {
  if (a === 0 || a === 10 || a === 127 || a >= 224)
    return false;

  if (a === 100 && b >= 64 && b <= 127)
    return false;

  if (a === 169 && b === 254)
    return false;

  if (a === 172 && b >= 16 && b <= 31)
    return false;

  if (a === 192 && b === 0 && c === 0)
    return false;

  if (a === 192 && b === 0 && c === 2)
    return false;

  if (a === 192 && b === 88 && c === 99)
    return false;

  if (a === 192 && b === 168)
    return false;

  if (a === 198 && (b === 18 || b === 19))
    return false;

  if (a === 198 && b === 51 && c === 100)
    return false;

  if (a === 203 && b === 0 && c === 113)
    return false;

  return true;
}

function createMetrics() {
  return {
    accepted: 0,
    invalid: 0,
    refused: 0,
    unsupported: 0,
    unavailable: 0,
    rateLimited: 0,
    globalRateLimited: 0,
    busy: 0,
    timeouts: 0,
    backendFailures: 0,
    success: 0,
    oversized: 0,
    cancelled: 0
  };
}

function relayError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sizeBucket(size) {
  if (size === 0)
    return 'none';

  if (size <= 512)
    return '<=512B';

  if (size <= 1232)
    return '<=1232B';

  if (size <= 4096)
    return '<=4KiB';

  if (size <= 16384)
    return '<=16KiB';

  return '>16KiB';
}

function latencyBucket(elapsed) {
  if (elapsed < 50)
    return '<50ms';

  if (elapsed < 100)
    return '<100ms';

  if (elapsed < 250)
    return '<250ms';

  if (elapsed < 500)
    return '<500ms';

  if (elapsed < 1000)
    return '<1s';

  if (elapsed < 3000)
    return '<3s';

  return '>=3s';
}

exports.DNSRelayService = DNSRelayService;
exports.RecursiveDNSRelayBackend = RecursiveDNSRelayBackend;
exports.RelayRecursiveResolver = RelayRecursiveResolver;
exports.RelaySignal = RelaySignal;
exports.validateQuery = validateQuery;
exports.ALLOWED_TYPES = ALLOWED_TYPES;
exports.allocateRelayQueryID = allocateRelayQueryID;
exports.isPublicDNSAddress = isPublicDNSAddress;
exports.isPrivateDNSAddress = isPrivateDNSAddress;
