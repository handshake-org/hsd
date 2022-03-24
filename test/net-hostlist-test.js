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
const {HostEntry} = HostList;

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

  for (const bucket of hosts.fresh)
    naddrs.push(...bucket.values());

  return naddrs;
};

function getUsedEntries(hosts) {
  const naddrs = [];

  for (const bucket of hosts.used)
    naddrs.push(...bucket.toArray());

  return naddrs;
}

function getRandomNetAddr(network = regtest) {
  return NetAddress.fromHostname(getRandomIPv4(), network);
}

function add2bucket(hosts, bucketIndex, entry, fresh = true) {
  if (fresh) {
    assert(bucketIndex < hosts.maxFreshBuckets);
    entry.refCount++;
    hosts.totalFresh++;
    hosts.map.set(entry.key(), entry);
    hosts.fresh[bucketIndex].set(entry.key(), entry);
    return;
  }

  assert(bucketIndex < hosts.maxUsedBuckets);
  assert(entry.refCount === 0);
  entry.used = true;
  hosts.map.set(entry.key(), entry);
  hosts.used[bucketIndex].push(entry);
  hosts.totalUsed++;
};

describe('Net HostList', function() {
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
    const prefix = '/tmp/directory';
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
        prefix
      });

      assert.strictEqual(hostlist.options.filename,
        path.join(prefix, 'hosts.json'));
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

  it('should ban/unban', () => {
    const hosts = new HostList();

    const banIPs = [
      getRandomIPv4(),
      getRandomIPv4(),
      getRandomIPv4()
    ];

    assert.strictEqual(hosts.banned.size, 0);

    {
      for (const ip of banIPs)
        hosts.ban(ip);

      assert.strictEqual(hosts.banned.size, banIPs.length);
    }

    {
      for (const ip of banIPs)
        hosts.unban(ip);

      assert.strictEqual(hosts.banned.size, 0);
    }

    {
      assert.strictEqual(hosts.banned.size, 0);
      for (const ip of banIPs)
        hosts.ban(ip);
      assert.strictEqual(hosts.banned.size, banIPs.length);

      for (const ip of banIPs)
        assert(hosts.isBanned(ip));

      hosts.clearBanned();

      for (const ip of banIPs)
        assert.strictEqual(hosts.isBanned(ip), false);
    }

    // ban time
    {
      assert.strictEqual(hosts.banned.size, 0);

      for (const ip of banIPs)
        hosts.ban(ip);

      // change ban time for the first IP.
      const banExpired = banIPs[0];
      hosts.banned.set(banExpired, util.now() - hosts.options.banTime - 1);

      const [, ...stillBanned] = banIPs;
      for (const ip of stillBanned)
        assert(hosts.isBanned(ip));

      assert.strictEqual(hosts.banned.size, banIPs.length);
      assert.strictEqual(hosts.isBanned(banExpired), false);
      assert.strictEqual(hosts.banned.size, banIPs.length - 1);
    }
  });

  describe('nodes and seeds', function() {
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

    it('should remove node', () => {
      const hosts = new HostList();
      const key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const ips = [getRandomIPv4(), getRandomIPv4(), getRandomIPv4()];
      const nodes = [
        ips[0],
        `${key}@${ips[1]}`,
        `${ips[2]}:1000`,
        `${ips[2]}:2000`
      ];

      for (const node of nodes)
        assert(hosts.addNode(node));

      assert.strictEqual(hosts.nodes.length, nodes.length);

      for (const node of nodes.reverse())
        assert(hosts.removeNode(node));

      assert.strictEqual(hosts.removeNode(nodes[0]), false);
      assert.strictEqual(hosts.nodes.length, 0);
    });
  });

  describe('Local addresses', function() {
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
      // < DEFAULT     = 1 -- non-ipv4 -> ipv4, onion -> ipv6, ...
      // < TEREDO      = 2 -- teredo -> teredo, teredo -> ipv6
      // < IPV6_WEAK   = 3 -- ipv4 -> ipv6 tunnels, ipv6 -> teredo
      // < IPV4        = 4 -- ipv4 -> ipv4, ipv4 -> others
      // < IPV6_STRONG = 5 -- ipv6 -> ipv6
      // < PRIVATE     = 6 -- ONION -> ONION

      const {MANUAL} = HostList.scores;

      // same score (MANUAL), different reachability:
      // remote(src) => [ local(dest)... ] - sorted by reachability scores.
      const reachabilityMap = {
        // unreachable => anything - will be UNREACHABLE = 0.
        [getRandomTEREDO()]: [
          getRandomIPv4(),   // DEFAULT = 1
          getRandomOnion(),  // DEFAULT = 1
          getRandomTEREDO(), // TEREDO = 2
          getRandomIPv6()    // TEREDO = 2
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
  });

  describe('Fresh bucket', function() {
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

      // make sure we don't insert into the same bucket twice. (refcount test)
      let index = 0;
      hosts.freshBucket = function () {
        return this.fresh[index++];
      };

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
        // We use different SRC for the same host, so we don't get the
        // same bucket.
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

    it('should evict entry from fresh bucket', () => {
      const hosts = new HostList();
      const bucket = hosts.fresh[0];

      const src = getRandomNetAddr();
      const entries = [];

      // Sort them young -> old
      for (let i = 0; i < 10; i++) {
        const entry = new HostEntry(getRandomNetAddr(), src);
        entry.addr.time = util.now() - i;
        entry.refCount = 1;
        bucket.set(entry.key(), entry);
        hosts.map.set(entry.key(), entry);
        entries.push(entry);
        hosts.totalFresh++;
      }

      {
        const staleEntry = entries[0];
        const expectedEvicted = entries[entries.length - 1];

        // stales are evicted anyway.
        staleEntry.addr.time = 0;

        // so we evict 2.
        assert.strictEqual(hosts.isStale(staleEntry), true);
        assert.strictEqual(bucket.has(staleEntry.key()), true);
        assert.strictEqual(bucket.has(expectedEvicted.key()), true);
        assert.strictEqual(hosts.map.has(staleEntry.key()), true);
        hosts.evictFresh(bucket);
        assert.strictEqual(bucket.has(staleEntry.key()), false);
        assert.strictEqual(bucket.has(expectedEvicted.key()), false);
        assert.strictEqual(hosts.map.has(staleEntry.key()), false);
      }

      {
        // evict older even if it's stale but is in another bucket as well.?
        const staleEntry = entries[1];
        const expectedEvicted = entries[entries.length - 2];

        staleEntry.attempts = HostList.RETRIES;
        staleEntry.refCount = 2;

        assert.strictEqual(hosts.isStale(staleEntry), true);

        assert.strictEqual(bucket.has(staleEntry.key()), true);
        assert.strictEqual(bucket.has(expectedEvicted.key()), true);
        assert.strictEqual(hosts.map.has(staleEntry.key()), true);
        hosts.evictFresh(bucket);
        assert.strictEqual(bucket.has(staleEntry.key()), false);
        assert.strictEqual(bucket.has(expectedEvicted.key()), false);
        assert.strictEqual(hosts.map.has(staleEntry.key()), true);
      }

      {
        const expectedEvicted = entries[entries.length - 3];
        expectedEvicted.refCount = 2;

        assert.strictEqual(bucket.has(expectedEvicted.key()), true);
        assert.strictEqual(hosts.map.has(expectedEvicted.key()), true);
        hosts.evictFresh(bucket);
        assert.strictEqual(bucket.has(expectedEvicted.key()), false);
        assert.strictEqual(hosts.map.has(expectedEvicted.key()), true);
      }

      assert.strictEqual(bucket.size, 5);
      for (let i = entries.length - 4; i > 1; i--) {
        const entry = entries[i];
        assert.strictEqual(bucket.has(entry.key()), true);
        assert.strictEqual(hosts.map.has(entry.key()), true);
        hosts.evictFresh(bucket);
        assert.strictEqual(bucket.has(entry.key()), false);
        assert.strictEqual(hosts.map.has(entry.key()), false);
      }

      assert.strictEqual(bucket.size, 0);
      hosts.evictFresh(bucket);
      assert.strictEqual(bucket.size, 0);
    });
  });

  describe('Host manipulation (used/fresh)', function() {
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

    it('should remove host', () => {
      const hosts = new HostList();

      const src = getRandomNetAddr();
      const addrs = [
        getRandomNetAddr(),
        getRandomNetAddr(),
        getRandomNetAddr(),
        getRandomNetAddr()
      ];

      const used = addrs.slice(2);

      for (const addr of addrs)
        hosts.add(addr, src);

      for (const addr of used)
        hosts.markAck(addr.hostname, 0);

      assert.strictEqual(hosts.map.size, addrs.length);
      assert.strictEqual(hosts.totalUsed, 2);
      assert.strictEqual(hosts.totalFresh, 2);
      const fresh = getFreshEntries(hosts);
      assert.strictEqual(fresh.length, 2);

      assert.strictEqual(hosts.remove(getRandomIPv6()), null);
      for (const addr of addrs.reverse())
        assert.strictEqual(hosts.remove(addr.hostname), addr);
      assert.strictEqual(hosts.totalUsed, 0);
      assert.strictEqual(hosts.totalFresh, 0);
    });

    it('should mark ack', () => {
      // we don't have the entry
      {
        const hosts = new HostList();
        const addr = getRandomIPv4();
        hosts.markAck(addr);
      }

      // Should update services, lastSuccess, lastAttempt and attempts
      // even if it's already in the used.
      {
        const hosts = new HostList();
        const naddr = getRandomNetAddr();
        const nsrc = getRandomNetAddr();

        naddr.services = 0x01;
        hosts.add(naddr, nsrc);

        const entry = hosts.map.get(naddr.hostname);
        const oldLastAttempt = util.now() - 1000;
        const oldLastSuccess = util.now() - 1000;
        const oldAttempts = 2;

        entry.lastAttempt = oldLastAttempt;
        entry.lastSuccess = oldLastSuccess;
        entry.attempts = oldAttempts;
        entry.used = true;

        hosts.markAck(naddr.hostname, 0x02);

        assert(entry.lastSuccess > oldLastSuccess);
        assert(entry.lastAttempt > oldLastAttempt);
        assert.strictEqual(entry.attempts, 0);
        assert.strictEqual(entry.addr.services, 0x01 | 0x02);
      }

      // Should remove from fresh
      {
        const hosts = new HostList();

        // make sure we have all 8 refs.
        let index = 0;
        hosts.random = () => 0;

        // make sure we always get different bucket.
        hosts.freshBucket = function () {
          return this.fresh[index++];
        };

        const addr = getRandomNetAddr();

        for (let i = 0; i < 8; i++) {
          const src = getRandomNetAddr();
          const addr2 = addr.clone();
          addr2.time = addr.time + i + 1;

          const added = hosts.add(addr2, src);
          assert.strictEqual(added, true);
        }

        assert.strictEqual(hosts.totalFresh, 1);
        assert.strictEqual(hosts.totalUsed, 0);
        assert.strictEqual(getFreshEntries(hosts).length, 8);
        const entry = hosts.map.get(addr.hostname);
        assert.strictEqual(entry.refCount, 8);

        hosts.markAck(addr.hostname);

        assert.strictEqual(getFreshEntries(hosts).length, 0);
        assert.strictEqual(entry.refCount, 0);
        assert.strictEqual(hosts.totalFresh, 0);
        assert.strictEqual(hosts.totalUsed, 1);
        assert.strictEqual(entry.used, true);
      }

      // evict used
      {
        const hosts = new HostList();

        const addr = getRandomNetAddr();
        const src = getRandomNetAddr();

        hosts.add(addr, src);
        const entry = hosts.map.get(addr.hostname);
        const bucket = hosts.usedBucket(entry);

        assert.strictEqual(hosts.totalFresh, 1);
        assert.strictEqual(hosts.totalUsed, 0);

        // add 64 entries to the bucket.
        const entries = [];
        for (let i = 0; i < hosts.maxEntries; i++) {
          const addr = getRandomNetAddr();
          const src = getRandomNetAddr();
          addr.time = util.now() - (i);

          const entry = new HostEntry(addr, src);
          entry.used = true;
          bucket.push(entry);
          entries.push(entry);
        }

        const expectedEvicted = entries[0];
        hosts.markAck(addr.hostname);
        assert.strictEqual(bucket.tail, entry);
        assert.strictEqual(expectedEvicted.used, true);
      }
    });

    it('should check if entry is stale', () => {
      const hosts = new HostList();

      const src = getRandomNetAddr();
      const addrs = [];
      const entries = [];

      for (let i = 0; i < 10; i++) {
        const addr = getRandomNetAddr();
        hosts.add(addr, src);
        const entry = hosts.map.get(addr.hostname);
        entries.push(entry);
        addrs.push(addr);
      }

      const A_DAY = 24 * 60 * 60;

      // address from the future?
      entries[0].addr.time = util.now() + 30 * 60;

      entries[1].addr.time = 0;

      // too old
      entries[2].addr.time = util.now() - HostList.HORIZON_DAYS * A_DAY - 1;

      // many attempts, no success
      entries[3].attempts = HostList.RETRIES;

      // last success got old.
      // and we failed max times.
      entries[4].lastSuccess = util.now() - HostList.MIN_FAIL_DAYS * A_DAY - 1;
      entries[4].attempts = HostList.MAX_FAILURES;

      // last attempt in last minute
      entries[5].lastAttempt = util.now();

      entries[6].lastSuccess = entries[5].lastSuccess;
      entries[7].lastSuccess = entries[5].lastSuccess + A_DAY;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        if (i < 5)
          assert.strictEqual(hosts.isStale(entry), true);
        else
          assert.strictEqual(hosts.isStale(entry), false);
      }
    });

    it('should return array of entries', () => {
      const hosts = new HostList();

      const src = getRandomNetAddr();
      const addrs = [];
      const entries = [];

      for (let i = 0; i < 20; i++) {
        const addr = getRandomNetAddr();
        addrs.push(addr);
        hosts.add(addr, src);
        entries.push(hosts.map.get(addr.hostname));
      }

      // have first 2 entries stale.
      entries[0].addr.time = 0;
      entries[1].addr.time = util.now() + 20 * 60;

      const arr = hosts.toArray();
      const set = new Set(arr);

      assert.strictEqual(arr.length, entries.length - 2);
      assert.strictEqual(set.size, entries.length - 2);

      for (let i = 0; i < 2; i++)
        assert.strictEqual(set.has(addrs[i]), false);

      for (let i = 2; i < entries.length; i++)
        assert.strictEqual(set.has(addrs[i]), true);
    });

    it('should get host', () => {
      {
        // empty
        const hosts = new HostList();
        const host = hosts.getHost();
        assert.strictEqual(host, null);
      }

      {
        // fresh buckets
        const hosts = new HostList();

        const freshEntries = [];

        for (let i = 0; i < 100; i++) {
          const entry = new HostEntry(getRandomNetAddr(), getRandomNetAddr());
          freshEntries.push(entry);
          add2bucket(hosts, 0, entry, true);
        }

        const found = hosts.getHost();
        assert.strictEqual(new Set(freshEntries).has(found), true);
      }

      {
        // used bucket - this is random.
        const hosts = new HostList();
        // put 10 entries in the used.
        const usedEntries = [];

        for (let i = 0; i < 100; i++) {
          const entry = new HostEntry(getRandomNetAddr(), getRandomNetAddr());
          usedEntries.push(entry);
          add2bucket(hosts, 0, usedEntries[i], false);
        }

        const foundEntry = hosts.getHost();
        assert.strictEqual(new Set(usedEntries).has(foundEntry), true);
      }
    });
  });

  describe('populate', function() {
    const DNS_SEED = IP.fromHost('example.com');

    let hosts;
    beforeEach(() => {
      hosts = new HostList();
    });

    it('should populate', async () => {
      let err;
      try {
        // only DNS name is a valid seed.
        await hosts.populate(getRandomIPv4());
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Resolved host passed.');

      hosts.resolve = () => {
        throw new Error('pop error');
      };

      const failedAddrs = await hosts.populate(DNS_SEED);
      assert.strictEqual(failedAddrs.length, 0);

      const addrs = [
        getRandomIPv4(),
        getRandomIPv4(),
        getRandomIPv4()
      ];

      hosts.resolve = () => addrs;
      const resAddrs = await hosts.populate(DNS_SEED);
      assert.strictEqual(resAddrs.length, addrs.length);

      for (const [i, resAddr] of resAddrs.entries())
        assert.strictEqual(resAddr.host, addrs[i]);
    });

    it('should populate seed', async () => {
      const addrs = [
        getRandomIPv4(),
        getRandomIPv4(),
        getRandomIPv4()
      ];

      hosts.resolve = () => addrs;

      await hosts.populateSeed(DNS_SEED);

      assert.strictEqual(hosts.map.size, addrs.length);
      for (const addr of addrs)
        assert(hosts.map.has(`${addr}:${mainnet.port}`));

      const fresh = getFreshEntries(hosts);
      assert.strictEqual(fresh.length, addrs.length);
    });

    it('should populate node', async () => {
      // Populate empty.
      hosts.resolve = () => [];
      await hosts.populateNode(DNS_SEED);

      assert.strictEqual(hosts.nodes.length, 0);
      assert.strictEqual(hosts.map.size, 0);

      const addrs = [
        getRandomIPv4(),
        getRandomIPv4(),
        getRandomIPv4()
      ];

      // we just take first resolved IP as a Node.
      hosts.resolve = () => addrs;
      await hosts.populateNode(DNS_SEED);
      assert.strictEqual(hosts.nodes.length, 1);
      assert.strictEqual(hosts.map.size, 1);

      assert.strictEqual(hosts.nodes[0].host, addrs[0]);
      assert(hosts.map.has(`${addrs[0]}:${mainnet.port}`));
    });

    it('should discover seeds', async () => {
      const seeds = {
        'example.com': [
          getRandomIPv4(),
          getRandomIPv4()
        ],
        'example.org': [
          getRandomIPv4(),
          getRandomIPv4()
        ]
      };

      hosts.resolve = host => seeds[host];

      for (const seed of Object.keys(seeds))
        hosts.addSeed(seed);

      await hosts.discoverSeeds();

      assert.strictEqual(hosts.map.size, 4);

      for (const ips of Object.values(seeds)) {
        for (const ip of ips)
          assert(hosts.map.has(`${ip}:${mainnet.port}`));
      }
    });

    it('should discover nodes', async () => {
      const seeds = {
        'example.com': [
          getRandomIPv4(),
          getRandomIPv4()
        ],
        'example.org': [
          getRandomIPv4(),
          getRandomIPv4()
        ]
      };

      hosts.resolve = host => seeds[host];

      for (const seed of Object.keys(seeds))
        hosts.addNode(seed);

      await hosts.discoverNodes();

      assert.strictEqual(hosts.map.size, 2);

      for (const [i, ips] of Object.values(seeds).entries()) {
        assert(hosts.map.has(`${ips[0]}:${mainnet.port}`));
        assert(hosts.nodes[i].host, ips[0]);
      }
    });
  });

  describe('File', function() {
    let testdir;

    beforeEach(async () => {
      testdir = common.testdir('hostlist');

      await fs.mkdirp(testdir);
    });

    afterEach(async () => {
      await fs.rimraf(testdir);
      testdir = null;
    });

    // Generate 1 entry per bucket from 0 to nFresh or nUsed.
    const genEntries = (hosts, nFresh, nUsed) => {
      const fresh = [];
      const used = [];

      assert(nFresh < hosts.maxFreshBuckets);
      assert(nUsed < hosts.maxUsedBuckets);

      for (let i = 0; i < nFresh; i++) {
        const entry = new HostEntry(getRandomNetAddr(), getRandomNetAddr());
        add2bucket(hosts, i, entry, true);
        fresh.push(entry);
      }

      for (let i = 0; i < nUsed; i++) {
        const entry = new HostEntry(getRandomNetAddr(), getRandomNetAddr());
        add2bucket(hosts, i, entry, false);
        used.push(entry);
      }

      return [fresh, used];
    };

    it('should reserialize JSON', () => {
      const hosts = new HostList({
        // network: regtest
      });

      genEntries(hosts, 10, 10);

      const json = hosts.toJSON();
      const hosts2 = HostList.fromJSON({
        // network: regtest
      }, json);

      assert.deepStrictEqual(hosts2.fresh, hosts.fresh);
      assert.deepStrictEqual(hosts2.used, hosts.used);
      assert.deepStrictEqual(hosts2.map, hosts.map);
      assert.strictEqual(hosts2.map.size, 20);
      assert.strictEqual(getFreshEntries(hosts2).length, 10);
      assert.strictEqual(getUsedEntries(hosts2).length, 10);
    });

    it('should open empty', async () => {
      const hosts = new HostList({
        network: regtest,
        prefix: testdir
      });

      await hosts.open();
      assert.strictEqual(hosts.map.size, 0);
      assert.strictEqual(getFreshEntries(hosts).length, 0);
      assert.strictEqual(getUsedEntries(hosts).length, 0);
      await hosts.close();

      // it does not need flushing.
      assert(!await fs.exists(path.join(testdir, 'hosts.json')));
    });

    it('should create hosts.json', async () => {
      const hosts = new HostList({
        network: regtest,
        prefix: testdir,
        memory: false
      });

      await hosts.open();

      genEntries(hosts, 10, 10);
      hosts.needsFlush = true;
      assert.strictEqual(hosts.map.size, 20);
      assert.strictEqual(getFreshEntries(hosts).length, 10);
      assert.strictEqual(getUsedEntries(hosts).length, 10);
      await hosts.close();

      assert(await fs.exists(path.join(testdir, 'hosts.json')));

      const hosts2 = new HostList({
        network: regtest,
        prefix: testdir,
        memory: false
      });

      await hosts2.open();
      assert.strictEqual(hosts2.map.size, 20);
      assert.strictEqual(getFreshEntries(hosts2).length, 10);
      assert.strictEqual(getUsedEntries(hosts2).length, 10);
      await hosts2.close();
    });
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
