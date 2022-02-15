'use strict';

const assert = require('bsert');
const path = require('path');
const fs = require('bfile');
const Logger = require('blgr');
const IP = require('binet');
const base32 = require('bcrypto/lib/encoding/base32');
const secp256k1 = require('bcrypto/lib/secp256k1');
const random = require('bcrypto/lib/random');
const common = require('./util/common');
const util = require('../lib/utils/util');
const Network = require('../lib/protocol/network');
const NetAddress = require('../lib/net/netaddress');
const HostList = require('../lib/net/hostlist');

const regtest = Network.get('regtest');
const mainnet = Network.get('main');

/*
 * Some configurations for the tests
 */

function getHostsFromLocals(addresses, opts) {
  const hosts = new HostList(opts);

  for (const [addr, score] of addresses)
    hosts.pushLocal(addr, score);

  return hosts;
}

// flat
function getFreshEntries(hosts) {
  const naddrs = [];

  for (const bucket of hosts.fresh) {
    for (const naddr of bucket.values())
      naddrs.push(naddr);
  }

  return naddrs;
};

function getRandomNetAddr(network = regtest) {
  return NetAddress.fromHostname(getRandomIPv4(), network);
}

describe('Net HostList', function() {
  let testdir;

  before(async () => {
    testdir = common.testdir('hostlist');

    assert(await fs.mkdirp(testdir));
  });

  after(async () => {
    await fs.rimraf(testdir);
    testdir = null;
  });

  it('should parse options', () => {
    const network = regtest;
    const logger = Logger.global;
    const resolve = () => {};
    const banTime = 100;
    const seeds = ['127.1.1.1', 'example.com'];
    const nodes = ['127.2.2.2'];
    const host = '127.0.0.1';
    const port = regtest.port;
    const publicHost = getRandomIPv4();
    const publicPort = regtest.port;
    const publicBrontidePort = regtest.brontidePort;
    const identityKey = secp256k1.privateKeyGenerate();
    const pubIdentityKey = secp256k1.publicKeyCreate(identityKey);
    const services = 1001;
    const onion = false;
    const brontideOnly = false;
    const memory = true;
    const prefix = testdir;
    const filename = path.join(prefix, 'custom.json');
    const flushInterval = 2000;

    const options = {
      network,
      logger,
      resolve,
      banTime,
      seeds,
      nodes,
      host,
      port,
      publicHost,
      publicPort,
      publicBrontidePort,
      identityKey,
      services,
      onion,
      brontideOnly,
      memory,
      prefix,
      filename,
      flushInterval
    };

    const hosts = new HostList(options);

    assert.strictEqual(hosts.network, network);

    // Hostlist will use context('hostlist') instead.
    // assert.strictEqual(hostlist.logger, logger);
    assert.strictEqual(hosts.resolve, resolve);
    assert.strictEqual(hosts.options.banTime, banTime);

    // seeds are still stored in options until initAdd.
    assert.deepStrictEqual(hosts.options.seeds, seeds);

    // Nodes are still stored in options until initAdd.
    assert.deepStrictEqual(hosts.options.nodes, nodes);

    // Host:port will become local node after initAdd.
    assert.strictEqual(hosts.options.host, host);
    assert.strictEqual(hosts.options.port, port);

    {
      // public address
      const address = new NetAddress({
        host: publicHost,
        port: publicPort,
        services
      });

      assert.strictEqual(hosts.address.equal(address), true);
      assert.strictEqual(hosts.address.services, services);
    }

    {
      // brontide Address
      const address = new NetAddress({
        host: publicHost,
        port: publicBrontidePort,
        key: pubIdentityKey,
        services
      });

      assert.strictEqual(hosts.brontide.equal(address), true);
      assert.strictEqual(hosts.brontide.services, services);
      assert.bufferEqual(hosts.brontide.getKey(), pubIdentityKey);
    }

    assert.strictEqual(hosts.options.onion, onion);
    assert.strictEqual(hosts.options.brontideOnly, brontideOnly);
    assert.strictEqual(hosts.options.memory, memory);
    assert.strictEqual(hosts.options.prefix, prefix);
    assert.strictEqual(hosts.options.filename, filename);
    assert.strictEqual(hosts.options.flushInterval, flushInterval);

    // Prefix check
    {
      const hostlist = new HostList({
        prefix: testdir
      });

      assert.strictEqual(hostlist.options.filename,
        path.join(testdir, 'hosts.json'));
    }
  });

  it('should init add ips', () => {
    const network = regtest;
    const host = '127.0.0.1';
    const port = regtest.port;
    const publicHost = '1.1.1.1';
    const publicPort = regtest.port;
    const publicBrontidePort = regtest.brontidePort;
    const identityKey = secp256k1.privateKeyGenerate();
    const pubIdentityKey = secp256k1.publicKeyCreate(identityKey);
    const seeds = ['127.1.1.1', 'example.com',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.3.3.3'];
    const nodes = ['127.2.2.2'];

    const hosts = new HostList({
      network,
      host,
      port,
      publicHost,
      publicPort,
      publicBrontidePort,
      identityKey,
      seeds,
      nodes
    });

    const ipGetPublic = IP.getPublic;

    const interfaceIPs = [
      getRandomIPv4(),
      getRandomIPv4()
    ];

    IP.getPublic = () => interfaceIPs;

    hosts.initAdd();
    assert.strictEqual(hosts.added, true);

    // It's behind a check.
    hosts.initAdd();

    IP.getPublic = ipGetPublic;

    {
      // one for brontinde public and one plaintext public
      // two from interfaces
      assert.strictEqual(hosts.local.size, 4);
      const plaintextHost = IP.toHost(publicHost, publicPort);
      const brontideHost = IP.toHost(
        publicHost,
        publicBrontidePort,
        pubIdentityKey
      );

      const interfaceHosts = [
        IP.toHost(interfaceIPs[0], publicPort),
        IP.toHost(interfaceIPs[1], publicPort)
      ];

      {
        assert(hosts.local.has(plaintextHost));
        const local = hosts.local.get(plaintextHost);
        assert.strictEqual(local.score, HostList.scores.MANUAL);
      }

      {
        assert(hosts.local.has(brontideHost));
        const local = hosts.local.get(brontideHost);
        assert.strictEqual(local.score, HostList.scores.MANUAL);
      }

      for (const ihost of interfaceHosts) {
        assert(hosts.local.has(ihost));
        const local = hosts.local.get(ihost);

        assert.strictEqual(local.score, HostList.scores.IF);
      }
    }

    // After initAdd();
    // 127.1.1.1 - becomes normal peer
    // example.com - will become dnsSeed
    assert.strictEqual(hosts.dnsSeeds.length, 1);
    assert.deepStrictEqual(hosts.dnsSeeds[0], IP.fromHost(seeds[1]));

    // Check 127.1.1.1 and 127.3.3.3
    assert(hosts.map.has(`${seeds[0]}:${regtest.port}`));
    assert(hosts.map.has(`127.3.3.3:${regtest.brontidePort}`));

    // Check nodes have been added (127.2.2.2)
    assert(hosts.map.has(`${nodes[0]}:${regtest.port}`));
    assert.strictEqual(hosts.map.size, 3);
  });

  it('should add/set nodes/seeds', () => {
    // we need 3.
    const hosts = [
      getRandomIPv4(),
      getRandomIPv4(),
      getRandomIPv4()
    ];

    const key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const tests = [
      // DNS Nodes
      {
        host: 'example.com',
        hostname: 'example.com',
        expected: {
          addr: null,
          dnsNodes: 1,
          nodes: 0,
          map: 0
        }
      },
      // HSD Node w/o port - plaintext
      {
        host: hosts[0],
        hostname: hosts[0],
        expected: {
          addr: { port: mainnet.port, host: hosts[0] },
          dnsNodes: 0,
          nodes: 1,
          map: 1
        }
      },
      // HSD Node w/o port - brontide
      {
        host: hosts[1],
        hostname: `${key}@${hosts[1]}`,
        expected: {
          addr: { host: hosts[1], port: mainnet.brontidePort },
          dnsNodes: 0,
          nodes: 1,
          map: 1
        }
      },
      // HSD Node with port
      {
        host: hosts[2],
        hostname: `${hosts[2]}:${mainnet.port + 1}`,
        expected: {
          addr: { host: hosts[2], port: mainnet.port + 1 },
          dnsNodes: 0,
          nodes: 1,
          map: 1
        }
      }
    ];

    const allHosts = tests.map(t => t.hostname);
    const sumExpected = tests.reduce((p, c) => {
      p.dnsNodes += c.expected.dnsNodes;
      p.nodes += c.expected.nodes;
      p.map += c.expected.map;
      return p;
    }, {
      dnsNodes: 0,
      nodes: 0,
      map: 0
    });

    for (const test of tests) {
      const hosts = new HostList();
      const {expected} = test;

      const addr = hosts.addNode(test.hostname);

      if (expected.addr == null)
        assert.strictEqual(addr, null);

      if (expected.addr != null) {
        assert.strictEqual(addr.host, expected.addr.host);
        assert.strictEqual(addr.port, expected.addr.port);
      }

      assert.strictEqual(hosts.dnsNodes.length, expected.dnsNodes);
      assert.strictEqual(hosts.nodes.length, expected.nodes);
      assert.strictEqual(hosts.map.size, expected.map);
    }

    // set all nodes
    {
      const hosts = new HostList();
      hosts.setNodes(allHosts);
      assert.strictEqual(hosts.dnsNodes.length, sumExpected.dnsNodes);
      assert.strictEqual(hosts.nodes.length, sumExpected.nodes);
      assert.strictEqual(hosts.map.size, sumExpected.map);
    }

    for (const test of tests) {
      const hosts = new HostList();
      const {expected} = test;

      const addr = hosts.addSeed(test.hostname);

      if (expected.addr == null)
        assert.strictEqual(addr, null);

      if (expected.addr != null) {
        assert.strictEqual(addr.host, expected.addr.host);
        assert.strictEqual(addr.port, expected.addr.port);
      }

      assert.strictEqual(hosts.dnsSeeds.length, expected.dnsNodes);
      assert.strictEqual(hosts.map.size, expected.map);
    }

    {
      const hosts = new HostList();

      hosts.setSeeds(allHosts);
      assert.strictEqual(hosts.dnsSeeds.length, sumExpected.dnsNodes);
      assert.strictEqual(hosts.map.size, sumExpected.map);
    }
  });

  it('should add push/local addresses', () => {
    const services = 1000;
    const hosts = new HostList({ services });

    const unroutable = [
      '127.0.0.1',
      '127.1.1.1',
      '192.168.1.1',
      '10.10.10.10'
    ];

    const routable = [
      getRandomIPv4(),
      getRandomIPv4()
    ];

    assert.strictEqual(hosts.local.size, 0);

    // unroutable local addresses must not get added.
    for (const host of unroutable) {
      const port = regtest.port;
      const score = HostList.scores.NONE;
      const res = hosts.addLocal(host, port, null, score);
      assert.strictEqual(res, false);
    }

    assert.strictEqual(hosts.local.size, 0);

    const SCORE = HostList.scores.MANUAL;
    // these must get added.
    for (const host of routable) {
      const port = regtest.port;
      const res1 = hosts.addLocal(host, port, SCORE);
      assert.strictEqual(res1, true);

      // add brontide versions
      const bport = regtest.brontidePort;
      const res2 = hosts.addLocal(host, bport, SCORE);
      assert.strictEqual(res2, true);
    }

    // one brontide and one plaintext
    assert.strictEqual(hosts.local.size, routable.length * 2);

    const added = hosts.addLocal(routable[0], regtest.port, SCORE);
    assert.strictEqual(added, false);

    for (const laddr of hosts.local.values()) {
      assert.strictEqual(laddr.addr.services, services);
      assert.strictEqual(laddr.score, SCORE);
      assert.strictEqual(laddr.type, SCORE);
    }
  });

  // w/o src it will only take into account the score.
  it('should get local w/o src', () => {
    const services = 1000;
    const port = regtest.port;

    const addrs = [];

    // w/o key
    for (let i = HostList.scores.NONE; i < HostList.scores.MAX - 1; i++) {
      const address = new NetAddress({
        host: getRandomIPv4(),
        port: port,
        services: services
      });
      addrs.push([address, i]);
    }

    // max but with key
    addrs.push([new NetAddress({
      host: getRandomIPv4(),
      port: port,
      services: services,
      key: Buffer.alloc(33, 1)
    }), HostList.scores.MAX]);

    const max = addrs[HostList.scores.MAX - 2];

    const hosts = getHostsFromLocals(addrs);
    const local = hosts.getLocal();

    assert.strictEqual(local, max[0]);
  });

  it('should get local (score)', () => {
    // NOTE: main network ignores everything other than MANUAL type.
    //  - scores.IF - addresses from the network interfaces.
    //  - scores.BIND - Listening IP. (publicHost/publicPort is MANUAL)
    //  - scores.DNS - Domain that needs to be resolved.
    //  - scores.UPNP - UPNP discovered address.

    const scores = HostList.scores;

    // same NET type but different scores:
    const hostsByScore = [
      [getRandomIPv4(), scores.NONE],
      [getRandomIPv4(), scores.IF],
      [getRandomIPv4(), scores.BIND],
      [getRandomIPv4(), scores.DNS],
      [getRandomIPv4(), scores.UPNP],
      [getRandomIPv4(), scores.MANUAL]
    ];

    const naddrsByScore = hostsByScore.map(([h, s]) => {
      return [getRandomNetAddr(), s];
    });

    // testnet/regtest
    for (let type = scores.NONE; type < scores.MAX; type++) {
      const addrs = naddrsByScore.slice(scores.NONE, type + 1);
      const hosts = getHostsFromLocals(addrs, { network: regtest });
      const src = getRandomNetAddr();
      const best = hosts.getLocal(src);
      assert.strictEqual(best, naddrsByScore[type][0]);
    }

    // mainnet
    {
      const hosts = getHostsFromLocals(naddrsByScore, { network: mainnet });
      const src = getRandomNetAddr(mainnet);
      const best = hosts.getLocal(src);
      assert.strictEqual(best, naddrsByScore[scores.MANUAL][0]);
    }

    {
      // everything below MANUAL is skipped on main network.
      const addrs = naddrsByScore.slice(scores.NONE, scores.UPNP);
      const hosts = getHostsFromLocals(addrs, { network: mainnet });
      const src = getRandomNetAddr(mainnet);
      const best = hosts.getLocal(src);
      assert.strictEqual(best, null);
    }
  });

  it('should get local (reachability)', () => {
    // If we have multiple public host/ports (e.g. IPv4 and Ipv6)
    // depending who is connecting to us, we will choose different
    // address to advertise.

    // with src it will take into account the reachability score.
    // See: binet.getReachability
    // TLDR:
    // UNREACHABLE = 0
    // < DEFAULT = 1 - non-ipv4 -> ipv4, onion -> ipv6, ...
    // < TEREDO = 2 - teredo -> teredo, teredo -> ipv6
    // < IPV6_WEAK = 3 - ipv4 -> ipv6 tunnels, ipv6 -> teredo
    // < IPV4 = 4 - ipv4 -> ipv4, ipv4 -> others
    // < IPV6_STRONG = 5 - ipv6 -> ipv6
    // < PRIVATE = 6 - ONION -> ONION

    const {MANUAL} = HostList.scores;

    // same score (MANUAL), different reachability:
    // remote(src) => [ local(dest)... ] - sorted by reachability scores.
    const reachabilityMap = {
      // unreachable => anything - will be UNREACHABLE = 0.
      [getRandomTEREDO()]: [
        getRandomIPv4(),   // DEFAULT = 1
        getRandomOnion(),  // DEFAULT = 1
        getRandomTEREDO(), // TEREDO = 2
        getRandomIPv6()   // TEREDO = 2
      ],
      [getRandomIPv4()]: [
        getRandomIPv4(),   // IPV4 = 4
        getRandomOnion(),  // IPV4 = 4
        getRandomTEREDO(), // IPV4 = 4
        getRandomIPv6()    // IPV4 = 4
      ],
      [getRandomIPv6()]: [
        getRandomOnion(),  // DEFAULT = 1
        getRandomIPv4(),   // DEFAULT = 1
        getRandomTEREDO(), // IPV6_WEAK = 3
        getRandomIPv6()    // IPV6_STRONG = 5
      ],
      [getRandomOnion()]: [
        getRandomIPv4(),   // DEFAULT = 1
        getRandomTEREDO(), // DEFAULT = 1
        getRandomIPv6(),   // DEFAULT = 1
        getRandomOnion()   // PRIVATE = 6
      ]
    };

    for (const [rawSrc, rawDests] of Object.entries(reachabilityMap)) {
      const dests = rawDests.map((dest) => {
        return [NetAddress.fromHostname(dest, mainnet), MANUAL];
      });

      for (let i = 0; i < dests.length; i++) {
        const addrs = dests.slice(0, i + 1);
        const expected = addrs[addrs.length - 1];

        // Because getLocal will choose first with the same score,
        // we make the "best" choice (because of the sorting) at first.
        addrs[addrs.length - 1] = addrs[0];
        addrs[0] = expected;

        const hosts = getHostsFromLocals(addrs);
        const src = NetAddress.fromHostname(rawSrc, mainnet);
        const best = hosts.getLocal(src);

        assert.strictEqual(best, expected[0]);
      }
    }
  });

  it('should not get local (skip brontide)', () => {
    const {MANUAL} = HostList.scores;

    // skip with key
    const src = getRandomIPv4();
    const KEY = base32.encode(Buffer.alloc(33, 1));
    const rawDests = [
      `${KEY}@${getRandomIPv4()}:${mainnet.brontidePort}`,
      `${KEY}@${getRandomIPv4()}:${mainnet.brontidePort}`
    ];

    const dests = rawDests.map((d) => {
      return [NetAddress.fromHostname(d, mainnet), MANUAL];
    });

    const hosts = getHostsFromLocals(dests);
    const best = hosts.getLocal(src);
    assert.strictEqual(best, null);
  });

  it('should mark local', () => {
    const {scores} = HostList;

    const rawDests = [
      [getRandomIPv4(), scores.IF],
      [getRandomIPv4(), scores.BIND]
    ];

    const dests = rawDests.map(([h, s]) => {
      return [NetAddress.fromHostname(h, regtest), s];
    });

    const hosts = getHostsFromLocals(dests, { network: regtest });

    {
      const addr = getRandomNetAddr();
      const marked = hosts.markLocal(addr);

      assert.strictEqual(marked, false);
    }

    {
      // we should get BIND, because BIND > IF
      const addr = getRandomNetAddr();
      const local = hosts.getLocal(addr);
      assert.strictEqual(local, dests[1][0]);
    }

    {
      // with markLocal IF should get the same score (type remains).
      hosts.markLocal(dests[0][0]);
      const addr = getRandomNetAddr();
      const local = hosts.getLocal(addr);
      assert.strictEqual(local, dests[0][0]);
    }
  });

  it('should add fresh address', () => {
    {
      const hosts = new HostList();

      // fresh, w/o src, not in the buckets
      const addr = getRandomNetAddr();

      assert.strictEqual(hosts.totalFresh, 0);
      assert.strictEqual(hosts.needsFlush, false);
      assert.strictEqual(hosts.map.size, 0);
      assert.strictEqual(getFreshEntries(hosts).length, 0);

      hosts.add(addr);

      assert.strictEqual(hosts.totalFresh, 1);
      assert.strictEqual(hosts.needsFlush, true);
      assert.strictEqual(hosts.map.size, 1);

      const freshEntries = getFreshEntries(hosts);
      assert.strictEqual(freshEntries.length, 1);

      const entry = freshEntries[0];
      assert.strictEqual(entry.addr, addr, 'Entry addr is not correct.');
      assert.strictEqual(entry.src, hosts.address, 'Entry src is not correct.');
    }

    {
      const hosts = new HostList();
      const addr = getRandomNetAddr();
      const src = getRandomNetAddr();

      hosts.add(addr, src);
      const freshEntries = getFreshEntries(hosts);
      assert.strictEqual(freshEntries.length, 1);

      const entry = freshEntries[0];
      assert.strictEqual(entry.addr, addr, 'Entry addr is not correct.');
      assert.strictEqual(entry.src, src, 'Entry src is not correct.');
      assert.strictEqual(entry.refCount, 1);
      assert.strictEqual(hosts.map.size, 1);
    }
  });

  it('should add address (limits)', () => {
    // Full Bucket?
    {
      const hosts = new HostList();
      const addr = getRandomNetAddr();
      const src = getRandomNetAddr();

      let evicted = false;

      // always return first bucket for this test.
      hosts.freshBucket = function() {
        return this.fresh[0];
      };

      hosts.evictFresh = function() {
        evicted = true;
      };

      // Fill first bucket.
      for (let i = 0; i < hosts.maxEntries; i++) {
        const addr = getRandomNetAddr();
        const added = hosts.add(addr, src);
        assert.strictEqual(added, true);
        assert.strictEqual(evicted, false);
      }

      const added = hosts.add(addr, src);
      assert.strictEqual(added, true);
      assert.strictEqual(evicted, true);
    }

    // Don't insert if entry is in a bucket.
    {
      const hosts = new HostList();
      const addr = getRandomNetAddr();
      const src = getRandomNetAddr();
      const entry = new HostList.HostEntry(addr, src);

      // insert entry in every bucket for this test.
      for (const bucket of hosts.fresh)
        bucket.set(entry.key(), entry);

      const added = hosts.add(addr, src);
      assert.strictEqual(added, false);
    }
  });

  it('should add seen address', () => {
    const hosts = new HostList();

    // get addr clone that can be added (Online requirements)
    const cloneAddr = (addr) => {
      const addr2 = addr.clone();
      // just make sure this is < 3 * 60 * 60 (Online requirements
      // with & without penalty)
      addr2.time = util.now() + 60 * 60;
      return addr2;
    };

    const addr = getRandomNetAddr();
    const src = getRandomNetAddr();
    addr.services = 0x01;
    const added = hosts.add(addr, src);
    assert.strictEqual(added, true);
    assert.strictEqual(hosts.needsFlush, true);
    hosts.needsFlush = false;

    const entries = getFreshEntries(hosts);
    const entry = entries[0];
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entry.addr.services, 0x01);

    // don't update - no new info (service will always get updated.)
    {
      const addr2 = addr.clone();
      addr2.services = 0x02;
      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);

      const entries = getFreshEntries(hosts);
      const entry = entries[0];
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entry.addr.services, 0x03);
      assert.strictEqual(hosts.needsFlush, false);
    }

    // update refCount. (we only have 1 refCount, increase up to 8)
    {
      const srcs = [];
      for (let i = 0; i < 7; i++)
        srcs.push(getRandomNetAddr());

      const factors = [];
      const _random = hosts.random;
      const random = function (factor) {
        factors.push(factor);
        return 0;
      };
      hosts.random = random;

      const addr2 = cloneAddr(addr);

      // when we have 1 ref, so probability of adding second one
      // is 50% (1/2).
      // then we have 2 refs, probability of adding will be 25% (1/4).
      // ... until we have 8 refs. (last one being 1/128)
      // Because we are reusing src, we will get same bucket
      // so it will only get added once.
      let added = 0;
      for (let i = 0; i < 7; i++) {
        const res = hosts.add(addr2, srcs[i]);

        // our custom random method always returns 0.
        assert.strictEqual(res, true);
        added++;
      }

      // make sure factors are calculated properly.
      assert.strictEqual(factors.length, 7);

      for (let i = 0; i < 7; i++)
        assert.strictEqual(factors[i], 1 << (i + 1));

      // at this point address should be in another bucket as well.
      assert.strictEqual(added, 7);
      assert.strictEqual(entry.refCount, 8);
      const entries = getFreshEntries(hosts);
      assert.strictEqual(entries.length, 8);
      assert.strictEqual(hosts.needsFlush, true);
      hosts.needsFlush = false;
      hosts.random = _random;
    }

    // should fail with max ref
    {
      const _refCount = entry.refCount;
      entry.refCount = HostList.MAX_REFS;
      const addr2 = cloneAddr(addr);
      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      entry.refCount = _refCount;
      assert.strictEqual(hosts.needsFlush, false);
    }

    // should fail if it's used
    {
      entry.used = true;
      const addr2 = cloneAddr(addr);
      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      assert.strictEqual(hosts.needsFlush, false);
      entry.used = false;
    }
  });

  it('should add address (update time)', () => {
    const getHosts = (time) => {
      const hosts = new HostList();
      const addr = getRandomNetAddr();
      const src = getRandomNetAddr();

      if (time)
        addr.time = time;

      const added = hosts.add(addr, src);
      assert.strictEqual(added, true);
      assert.strictEqual(hosts.needsFlush, true);
      hosts.needsFlush = false;

      const entries = getFreshEntries(hosts);
      assert.strictEqual(entries.length, 1);
      const entry = hosts.map.get(addr.hostname);

      // make sure we stop after updating time.
      entries[0].used = true;

      return [hosts, entry, addr, src];
    };

    // Update time - Online?
    {
      // a week ago
      const [hosts, entry, addr, src] = getHosts(util.now() - 7 * 24 * 60 * 60);
      const addr2 = addr.clone();

      // a day ago (interval is a day,
      // so we update if a day and 2 hrs have passed).
      addr2.time = util.now() - 24 * 60 * 60;

      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      assert.strictEqual(entry.addr.time, addr2.time);
      assert.strictEqual(hosts.needsFlush, true);
    }

    {
      // a day ago
      const [hosts, entry, addr, src] = getHosts(util.now() - 24 * 60 * 60);

      const addr2 = addr.clone();

      // now (interval becomes an hour, so instead we update if 3 hrs passed.
      addr2.time = util.now();

      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      assert.strictEqual(entry.addr.time, addr2.time);
      assert.strictEqual(hosts.needsFlush, true);
    }

    // Don't update
    {
      // a week ago
      const weekAgo = util.now() - 7 * 24 * 60 * 60;
      const sixDaysAgo = util.now() - 6 * 24 * 60 * 60 + 1; // and a second

      const [hosts, entry, addr, src] = getHosts(weekAgo);

      const addr2 = addr.clone();
      // 6 days ago (exactly 24 hrs after) because 2 hrs is penalty,
      // we don't update.
      addr2.time = sixDaysAgo;

      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      assert.strictEqual(entry.addr.time, weekAgo);
      assert.strictEqual(hosts.needsFlush, false);
    }

    // Update, because we are the ones inserting.
    {
      // a week ago
      const weekAgo = util.now() - 7 * 24 * 60 * 60;
      const sixDaysAgo = util.now() - 6 * 24 * 60 * 60 + 1; // and a second

      const [hosts, entry, addr] = getHosts(weekAgo);

      const addr2 = addr.clone();
      // 6 days ago (exactly 24 hrs after) because 2 hrs is penalty,
      // we don't update.
      addr2.time = sixDaysAgo;

      const added = hosts.add(addr2);
      assert.strictEqual(added, false);
      assert.strictEqual(entry.addr.time, sixDaysAgo);
      assert.strictEqual(hosts.needsFlush, true);
    }

    // Online - but still not updating (less than 3 hrs)
    {
      // now vs 3 hrs ago (exactly)
      const now = util.now();
      const threeHoursAgo = now - 3 * 60 * 60;

      const [hosts, entry, addr, src] = getHosts(threeHoursAgo);

      const addr2 = addr.clone();
      addr2.time = now;

      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      assert.strictEqual(entry.addr.time, threeHoursAgo);
      assert.strictEqual(hosts.needsFlush, false);
    }

    {
      // now vs 3 hrs and a second ago
      const now = util.now();
      const threeHoursAgo = now - 1 - 3 * 60 * 60;

      const [hosts, entry, addr, src] = getHosts(threeHoursAgo);

      const addr2 = addr.clone();
      addr2.time = now;

      const added = hosts.add(addr2, src);
      assert.strictEqual(added, false);
      assert.strictEqual(entry.addr.time, now);
      assert.strictEqual(hosts.needsFlush, true);
    }
  });

  it('should mark attempt', () => {
    const hosts = new HostList();

    // if we don't have the entry.
    {
      const addr = getRandomIPv4();
      hosts.markAttempt(addr);
    }

    const src = getRandomNetAddr();
    const addr = getRandomNetAddr();

    hosts.add(addr, src);

    const entry = hosts.map.get(addr.hostname);
    assert.strictEqual(entry.attempts, 0);
    assert.strictEqual(entry.lastAttempt, 0);

    hosts.markAttempt(addr.hostname);
    assert.strictEqual(entry.attempts, 1);
    assert(entry.lastAttempt > util.now() - 10);
  });

  it('should mark success', () => {
    const hosts = new HostList();

    // we don't have entry.
    {
      const addr = getRandomIPv4();
      hosts.markSuccess(addr);
    }

    // Don't update time, it's recent.
    {
      const src = getRandomNetAddr();
      const addr = getRandomNetAddr();
      const oldTime = util.now() - 10 * 60; // last connection 11 minutes ago.
      addr.time = oldTime;

      hosts.add(addr, src);
      hosts.markSuccess(addr.hostname);

      const entry = hosts.map.get(addr.hostname);
      assert.strictEqual(entry.addr.time, oldTime);
    }

    // we update time.
    const src = getRandomNetAddr();
    const addr = getRandomNetAddr();
    const oldTime = util.now() - 21 * 60; // last connection 21 minutes ago.
    addr.time = oldTime;

    hosts.add(addr, src);
    hosts.markSuccess(addr.hostname);

    const entry = hosts.map.get(addr.hostname);
    assert(entry.addr.time > oldTime);
  });
});

/*
 * Helpers
 */

function getRandomIPv4() {
  const prefix = Buffer.from('00000000000000000000ffff', 'hex');
  const number = random.randomBytes(4);
  const ipv4 = Buffer.concat([prefix, number]);

  if (IP.getNetwork(ipv4) === IP.networks.INET4)
    return IP.toString(ipv4);

  return getRandomIPv4();
}

function getRandomTEREDO() {
  const prefix = Buffer.from('20010000', 'hex');
  const number = random.randomBytes(12);
  const raw = Buffer.concat([prefix, number]);

  if (IP.getNetwork(raw) === IP.networks.TEREDO)
    return IP.toString(raw);

  return getRandomTEREDO();
}

function getRandomIPv6() {
  const raw = random.randomBytes(16);

  if (IP.isRFC3964(raw) || IP.isRFC6052(raw) || IP.isRFC6145(raw))
    return getRandomIPv6();

  if (IP.getNetwork(raw) === IP.networks.INET6)
    return IP.toString(raw);

  return getRandomIPv6();
}

function getRandomOnion() {
  const prefix = Buffer.from('fd87d87eeb43', 'hex');
  const number = random.randomBytes(10);
  const raw = Buffer.concat([prefix, number]);

  if (IP.getNetwork(raw) === IP.networks.ONION)
    return IP.toString(raw);

  return getRandomOnion();
}
