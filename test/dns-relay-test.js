'use strict';

const assert = require('bsert');
const fs = require('fs');
const {resolve} = require('path');
const {util, wire} = require('bns');
const common = require('../lib/net/common');
const packets = require('../lib/net/packets');
const Parser = require('../lib/net/parser');
const Framer = require('../lib/net/framer');
const Peer = require('../lib/net/peer');
const Pool = require('../lib/net/pool');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const FullNode = require('../lib/node/fullnode');
const {
  DNSRelayService,
  RecursiveDNSRelayBackend,
  RelayRecursiveResolver,
  allocateRelayQueryID,
  isPrivateDNSAddress,
  isPublicDNSAddress,
  validateQuery
} = require('../lib/net/dnsrelay');

const {Message, Question, opcodes, codes, types, classes} = wire;
const status = common.dnsRelayStatus;
const fixtureDir = resolve(
  __dirname,
  '..',
  'fixtures',
  'experimental-dns-relay');

function readFixture(name) {
  const file = resolve(fixtureDir, `${name}.hex`);
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

function requestID(value) {
  const id = Buffer.alloc(8);
  id.writeUInt32LE(value, 0);
  return id;
}

function makeQuery(name = 'www.relaytest.', type = types.A) {
  const req = new Message();
  req.id = 0x1234;
  req.opcode = opcodes.QUERY;
  req.rd = true;
  req.cd = true;
  req.question.push(new Question(name, type));
  req.setEDNS(1232, true);
  return req;
}

function makeResponse(query, code = codes.NOERROR) {
  const req = Message.decode(query);
  const res = new Message();
  res.code = code;
  res.setReply(req);
  res.ra = true;
  return res.compress();
}

function makePacket(id, query) {
  if (!query)
    query = makeQuery().compress();

  return new packets.GetDNSRelayPacket(requestID(id), query);
}

function deferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {promise, resolve, reject};
}

class TestLogger {
  constructor() {
    this.entries = [];
  }

  context() {
    return this;
  }

  debug(...args) {
    this.entries.push(args);
  }

  error(...args) {
    this.entries.push(args);
  }
}

class FakeBackend {
  constructor(handler) {
    this.handler = handler || (query => makeResponse(query));
    this.ready = false;
    this.calls = [];
  }

  async open() {
    this.ready = true;
  }

  async close() {
    this.ready = false;
  }

  isReady() {
    return this.ready;
  }

  resolveRaw(query, options) {
    this.calls.push({query, options});
    return this.handler(query, options);
  }
}

class FakePeer {
  constructor(handshake = true) {
    this.handshake = handshake;
    this.localServices = common.EXPERIMENTAL_DNS_RELAY_SERVICE;
    this.destroyed = false;
    this.sent = [];
  }

  send(packet) {
    this.sent.push(packet);
  }
}

function makeChain(synced = true) {
  return {
    synced,
    height: 10,
    db: {
      async getNameStatus() {
        return {
          registered: true,
          expired: false,
          data: Buffer.from([1])
        };
      }
    }
  };
}

function createService(options) {
  const logger = new TestLogger();
  const backend = options && options.backend
    ? options.backend
    : new FakeBackend();

  const base = {
    enabled: true,
    chain: makeChain(),
    backend,
    logger,
    checkName: tld => tld === 'relaytest'
  };

  return {
    service: new DNSRelayService(Object.assign(base, options)),
    backend,
    logger
  };
}

describe('Experimental DNS Relay', function() {
  this.timeout(5000);

  describe('wire protocol', function() {
    it('should use the documented private assignments', () => {
      const manifest = JSON.parse(fs.readFileSync(
        resolve(fixtureDir, 'manifest.json'),
        'utf8'));

      assert.strictEqual(
        common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        Number(manifest.temporary_service_bit));
      assert.strictEqual(
        packets.types.EXPERIMENTAL_GET_DNS_RELAY,
        Number(manifest.temporary_request_packet));
      assert.strictEqual(
        packets.types.EXPERIMENTAL_DNS_RELAY,
        Number(manifest.temporary_response_packet));
      assert.deepStrictEqual(common.dnsRelayStatus, manifest.statuses);
      assert.strictEqual(
        common.dnsRelay.MAX_QUERY_SIZE,
        manifest.maximum_query_bytes);
      assert.strictEqual(
        common.dnsRelay.MAX_RESPONSE_SIZE,
        manifest.maximum_response_bytes);
    });

    it('should decode and re-encode valid request fixtures exactly', () => {
      const names = [
        'request-basic',
        'request-max',
        'request-max-qname'
      ];

      for (const name of names) {
        const raw = readFixture(name);
        const packet = packets.GetDNSRelayPacket.decode(raw);

        assert.bufferEqual(packet.encode(), raw);
        assert.bufferEqual(packet.requestID,
          Buffer.from('0807060504030201', 'hex'));
        assert(packet.query.length > 0);
        assert(packet.query.length <= common.dnsRelay.MAX_QUERY_SIZE);
      }
    });

    it('should decode and re-encode valid response fixtures exactly', () => {
      const names = ['response-ok', 'response-error', 'response-max'];

      for (const name of names) {
        const raw = readFixture(name);
        const packet = packets.DNSRelayPacket.decode(raw);

        assert.bufferEqual(packet.encode(), raw);
        assert.bufferEqual(packet.requestID,
          Buffer.from('0807060504030201', 'hex'));
        assert(packet.response.length <= common.dnsRelay.MAX_RESPONSE_SIZE);
      }
    });

    it('should reject malformed request fixtures', () => {
      const names = [
        'malformed-length',
        'trailing-bytes',
        'oversized-request'
      ];

      for (const name of names) {
        assert.throws(() => {
          packets.GetDNSRelayPacket.decode(readFixture(name));
        });
      }
    });

    it('should preserve canonical unassigned response statuses', async () => {
      const raw = readFixture('unknown-status');
      const packet = packets.DNSRelayPacket.decode(raw);

      assert.strictEqual(packet.status, 0xff);
      assert.strictEqual(packet.response.length, 0);
      assert.bufferEqual(packet.encode(), raw);

      const parser = new Parser('regtest');
      const framer = new Framer('regtest');
      const parsed = new Promise((resolve, reject) => {
        parser.once('packet', resolve);
        parser.once('error', reject);
      });

      parser.feed(framer.packet(
        packets.types.EXPERIMENTAL_DNS_RELAY,
        raw));

      const result = await parsed;
      assert(result instanceof packets.DNSRelayPacket);
      assert.strictEqual(result.status, 0xff);
      assert.bufferEqual(result.encode(), raw);
    });

    it('should reject malformed response fixtures', () => {
      const names = [
        'oversized-response',
        'zero-request-id'
      ];

      for (const name of names) {
        assert.throws(() => {
          packets.DNSRelayPacket.decode(readFixture(name));
        });
      }
    });

    it('should reject invalid response body and identifier combinations', () => {
      const id = requestID(1);

      assert.throws(() => {
        new packets.DNSRelayPacket(id, status.OK).encode();
      });

      assert.throws(() => {
        new packets.DNSRelayPacket(
          id,
          status.BUSY,
          Buffer.from([1])).encode();
      });

      assert.throws(() => {
        new packets.DNSRelayPacket(
          id,
          0xff,
          Buffer.from([1])).encode();
      });

      assert.throws(() => {
        new packets.GetDNSRelayPacket(
          Buffer.alloc(8),
          makeQuery().compress()).encode();
      });
    });

    it('should preserve unassigned packets as unknown', () => {
      const raw = Buffer.from('01020304', 'hex');
      const packet = packets.decode(0xf3, raw);

      assert(packet instanceof packets.UnknownPacket);
      assert.strictEqual(packet.rawType, 0xf3);
      assert.bufferEqual(packet.data, raw);
    });

    it('should reject oversized relay frames from the header', () => {
      const cases = [
        [
          packets.types.EXPERIMENTAL_GET_DNS_RELAY,
          common.dnsRelay.MAX_REQUEST_PAYLOAD_SIZE
        ],
        [
          packets.types.EXPERIMENTAL_DNS_RELAY,
          common.dnsRelay.MAX_RESPONSE_PAYLOAD_SIZE
        ]
      ];

      for (const [type, maxSize] of cases) {
        const parser = new Parser('regtest');
        const header = Buffer.alloc(9);
        let error = null;
        let parsed = false;

        header.writeUInt32LE(parser.network.magic, 0);
        header[4] = type;
        header.writeUInt32LE(maxSize + 1, 5);

        parser.parsePayload = () => {
          parsed = true;
        };
        parser.once('error', (err) => {
          error = err;
        });

        parser.feed(Buffer.concat([header, Buffer.alloc(32)]));

        assert(error);
        assert.strictEqual(parsed, false);
        assert.strictEqual(parser.header, null);
        assert.strictEqual(parser.waiting, 9);
        assert.strictEqual(parser.total, 0);
        assert.strictEqual(parser.pending.length, 0);
      }
    });

    it('should accept relay frames at the exact payload limits',
      async () => {
        const cases = [
          [
            packets.types.EXPERIMENTAL_GET_DNS_RELAY,
            readFixture('request-max'),
            packets.GetDNSRelayPacket
          ],
          [
            packets.types.EXPERIMENTAL_DNS_RELAY,
            readFixture('response-max'),
            packets.DNSRelayPacket
          ]
        ];
        const framer = new Framer('regtest');

        for (const [type, raw, Packet] of cases) {
          const parser = new Parser('regtest');
          const result = new Promise((resolve, reject) => {
            parser.once('packet', resolve);
            parser.once('error', reject);
          });

          parser.feed(framer.packet(type, raw));

          const packet = await result;
          assert(packet instanceof Packet);
          assert.bufferEqual(packet.encode(), raw);
        }
      });
  });

  describe('query admission', function() {
    it('should accept browser-relevant HNS DNSSEC queries', () => {
      const allowed = [
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
        64,
        65,
        types.TXT,
        types.MX,
        types.SRV,
        types.CAA
      ];

      for (const type of allowed) {
        const result = validateQuery(makeQuery(undefined, type).compress());
        assert.strictEqual(result.tld, 'relaytest');
        assert.strictEqual(result.question.type, type);
      }
    });

    it('should reject unsafe DNS envelopes', () => {
      const cases = [];

      let req = makeQuery();
      req.qr = true;
      cases.push(req.compress());

      req = makeQuery();
      req.opcode = opcodes.UPDATE;
      cases.push(req.compress());

      req = makeQuery();
      req.rd = false;
      cases.push(req.compress());

      for (const flag of ['aa', 'tc', 'ra', 'z']) {
        req = makeQuery();
        req[flag] = true;
        cases.push(req.compress());
      }

      req = makeQuery();
      req.question.push(new Question('two.relaytest.', types.A));
      cases.push(req.compress());

      req = makeQuery();
      req.question[0].class = classes.CH;
      cases.push(req.compress());

      for (const type of [
        types.ANY,
        types.AXFR,
        types.IXFR,
        types.TKEY,
        types.TSIG
      ]) {
        cases.push(makeQuery(undefined, type).compress());
      }

      req = makeQuery();
      req.unsetEDNS();
      cases.push(req.compress());

      req = makeQuery();
      req.edns.flags = 0;
      cases.push(req.compress());

      req = makeQuery();
      req.edns.version = 1;
      cases.push(req.compress());

      req = makeQuery();
      req.edns.flags |= 1;
      cases.push(req.compress());

      req = makeQuery();
      req.edns.size = 500;
      cases.push(req.compress());

      cases.push(makeQuery('www.localhost.').compress());
      cases.push(Buffer.concat([makeQuery().compress(), Buffer.from([0])]));

      const compressionLoop = Buffer.from(
        '123401000001000000000000c00c00010001',
        'hex');
      cases.push(compressionLoop);

      const query = makeQuery().compress();
      const ecs = Buffer.concat([
        query.subarray(0, -2),
        Buffer.from('00080008000400010000', 'hex')
      ]);
      cases.push(ecs);

      const optSize = 11;
      const ecsOPT = Buffer.from(
        '00002904d00000800000080008000400010000',
        'hex');
      const duplicateOPT = Buffer.concat([
        query.subarray(0, -optSize),
        ecsOPT,
        query.subarray(-optSize)
      ]);
      duplicateOPT.writeUInt16BE(2, 10);
      cases.push(duplicateOPT);

      const nonRootOPT = Buffer.concat([
        query.subarray(0, -optSize),
        Buffer.from('c00c', 'hex'),
        query.subarray(1 - optSize)
      ]);
      cases.push(nonRootOPT);

      for (const raw of cases)
        assert.throws(() => validateQuery(raw));
    });
  });

  describe('recursive backend', function() {
    it('should allocate collision-free relay transaction IDs', async () => {
      const occupied = new Map([[0x1234, true], [0x1235, true]]);
      assert.strictEqual(allocateRelayQueryID(occupied, 0x1234), 0x1236);

      const resolver = new RelayRecursiveResolver();
      const server = {host: '1.1.1.1', port: 53};
      const originalID = util.id;
      const sent = [];

      util.id = () => 0x1234;
      resolver.socket.send = msg => sent.push(Buffer.from(msg));

      try {
        const first = resolver.exchange(makeQuery('one.relaytest.'), [server]);
        const second = resolver.exchange(makeQuery('two.relaytest.'), [server]);

        assert.deepStrictEqual([...resolver.pending.keys()], [0x1234, 0x1235]);
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[0].readUInt16BE(0), 0x1234);
        assert.strictEqual(sent[1].readUInt16BE(0), 0x1235);

        resolver.cancel();
        await Promise.allSettled([first, second]);
        assert.strictEqual(resolver.pending.size, 0);
      } finally {
        util.id = originalID;
        resolver.cancel();
      }
    });

    it('should release a reserved transaction ID when send fails', async () => {
      const resolver = new RelayRecursiveResolver();
      resolver.socket.send = () => {
        throw new Error('send failed');
      };

      await assert.rejects(
        resolver.exchange(makeQuery(), [{host: '1.1.1.1', port: 53}]),
        /send failed/);
      assert.strictEqual(resolver.pending.size, 0);
    });

    it('should bound requests to each external authority address', async () => {
      const resolver = new RelayRecursiveResolver({
        authorityRate: 1,
        authorityBurst: 1
      });
      const server = {host: '1.1.1.1', port: 53};
      resolver.socket.send = () => {};

      const first = resolver.exchange(makeQuery('one.relaytest.'), [server]);
      await assert.rejects(
        resolver.exchange(makeQuery('two.relaytest.'), [server]),
        {code: 'ERR_DNS_RELAY_AUTHORITY_RATE'});
      assert.strictEqual(resolver.pending.size, 1);

      resolver.cancel();
      await Promise.allSettled([first]);
      assert.strictEqual(resolver.pending.size, 0);
    });

    it('should recheck and charge UDP and TCP retry sends', async () => {
      const resolver = new RelayRecursiveResolver({
        authorityRate: 1,
        authorityBurst: 2,
        now: () => 0
      });
      const server = {host: '1.1.1.1', port: 53};
      const sent = [];

      resolver.socket.send = (msg, pos, len, port, host, tcp) => {
        sent.push({msg: Buffer.from(msg), port, host, tcp});
      };

      const pending = resolver.exchange(makeQuery(), [server]);
      const query = resolver.pending.values().next().value;

      assert(query);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].tcp, false);

      resolver.retry(query, false, true, false);

      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[1].tcp, true);

      resolver.retry(query, false, false, false);

      await assert.rejects(pending, {
        code: 'ERR_DNS_RELAY_AUTHORITY_RATE'
      });
      assert.strictEqual(sent.length, 2);
      assert.strictEqual(resolver.pending.size, 0);
    });

    it('should re-filter a rotated authority immediately before retry',
      async () => {
        const resolver = new RelayRecursiveResolver({
          authorityRate: 10,
          authorityBurst: 10
        });
        const sent = [];

        resolver.socket.send = (msg, pos, len, port, host, tcp) => {
          sent.push({port, host, tcp});
        };

        const pending = resolver.exchange(makeQuery(), [
          {host: '1.1.1.1', port: 53}
        ]);
        const query = resolver.pending.values().next().value;

        assert(query);
        query.servers[0] = {host: '127.0.0.1', port: 53};
        resolver.retry(query, true, false, false);

        await assert.rejects(pending, {
          code: 'ERR_DNS_RELAY_PRIVATE_ADDRESS'
        });
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(resolver.pending.size, 0);
      });

    it('should recheck and charge the final small-EDNS retry', async () => {
      const resolver = new RelayRecursiveResolver({
        tcp: false,
        authorityRate: 1,
        authorityBurst: 2,
        now: () => 0
      });
      const server = {host: '1.1.1.1', port: 53};
      const sent = [];
      const req = makeQuery();

      req.edns.size = 4096;

      resolver.socket.send = (msg, pos, len, port, host, tcp) => {
        sent.push({msg: Buffer.from(msg), port, host, tcp});
      };

      const pending = resolver.exchange(req, [server]);
      const query = resolver.pending.values().next().value;

      assert(query);
      query.attempts = resolver.maxAttempts - 1;
      resolver.retry(query, false, false, true);

      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[1].tcp, false);
      assert.strictEqual(Message.decode(sent[1].msg).edns.size, 1280);

      await assert.rejects(
        resolver.exchange(makeQuery('two.relaytest.'), [server]),
        {code: 'ERR_DNS_RELAY_AUTHORITY_RATE'});

      resolver.cancel();
      await Promise.allSettled([pending]);
      assert.strictEqual(resolver.pending.size, 0);
    });

    it('should use a dedicated resolver and RecursiveServer finalization',
      async () => {
        let fail = false;
        let finalized = 0;

        const resolver = {
          async open() {},
          async close() {},
          async resolve() {
            if (fail)
              throw new Error('recursive failure');

            const res = new Message();
            res.code = codes.NXDOMAIN;
            return res;
          }
        };
        const server = {
          finalize(req, res) {
            finalized += 1;
            res.setReply(req);
            res.ra = true;
          }
        };

        const backend = new RecursiveDNSRelayBackend(server, resolver);
        const query = makeQuery().compress();

        await backend.open();

        let raw = await backend.resolveRaw(query);
        let res = Message.decode(raw);

        assert.strictEqual(res.id, 0x1234);
        assert.strictEqual(res.qr, true);
        assert.strictEqual(res.ra, true);
        assert.strictEqual(res.code, codes.NXDOMAIN);

        fail = true;
        raw = await backend.resolveRaw(query);
        res = Message.decode(raw);

        assert.strictEqual(res.code, codes.SERVFAIL);
        assert.strictEqual(finalized, 2);

        await backend.close();
        await assert.rejects(backend.resolveRaw(query), {
          code: 'ERR_DNS_RELAY_UNAVAILABLE'
        });
      });

    it('should request unfiltered DNSSEC material from authorities', async () => {
      const server = {
        stubHost: '127.0.0.1',
        stubPort: 25349,
        finalize() {}
      };
      const backend = new RecursiveDNSRelayBackend(server);
      const resolver = backend.resolver;
      let outgoing = null;

      resolver.exchange = async (req) => {
        outgoing = req;
        const res = new Message();
        res.setReply(req);
        return res;
      };

      await resolver.query(new Question('www.relaytest.', types.A), [
        {host: '127.0.0.1', port: 25349}
      ]);

      assert(outgoing);
      assert.strictEqual(outgoing.cd, true);
      assert.strictEqual(outgoing.isDNSSEC(), true);
    });

    it('should allow only public relay authority endpoints', async () => {
      for (const address of [
        '1.1.1.1',
        '8.8.8.8',
        '2001:4860:4860::8888',
        '2606:4700:4700::1111',
        '64:ff9b::808:808'
      ]) {
        assert.strictEqual(isPublicDNSAddress(address), true, address);
      }

      for (const address of [
        '0.0.0.0',
        '10.0.0.1',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '192.168.0.1',
        '198.18.0.1',
        '224.0.0.1',
        '::',
        '::1',
        '::2',
        '::ffff:127.0.0.1',
        '64:ff9b::a00:1',
        '64:ff9b::a9fe:a9fe',
        'fc00::1',
        'fe80::1',
        'fe00::1',
        '2001::1',
        '2001:2::1',
        '2001:10::1',
        '2001:20::1',
        '2001:db8::1',
        '2002:0808:0808::1',
        '3fff::1',
        'ff02::1'
      ]) {
        assert.strictEqual(isPublicDNSAddress(address), false, address);
      }

      const resolver = new RelayRecursiveResolver();
      resolver.stubHost = '127.0.0.1';
      resolver.stubPort = 5300;

      const stub = {host: '127.0.0.1', port: 5300};
      const privateServer = {host: '192.168.1.1', port: 53};
      const publicServer = {host: '1.1.1.1', port: 53};

      assert.deepStrictEqual(
        resolver.filterServers([stub, privateServer, publicServer]),
        [stub, publicServer]);
      assert.throws(() => resolver.filterServers([privateServer]), {
        code: 'ERR_DNS_RELAY_PRIVATE_ADDRESS'
      });
      assert.throws(() => resolver.filterServers([
        {host: '1.1.1.1', port: 5353}
      ]), {
        code: 'ERR_DNS_RELAY_PRIVATE_ADDRESS'
      });

      const req = new Message();
      req.question.push(new Question('www.relaytest.', types.A));

      await assert.rejects(resolver.exchange(req, [privateServer]), {
        code: 'ERR_DNS_RELAY_PRIVATE_ADDRESS'
      });
    });

    it('should narrowly allow private authorities when explicitly enabled',
      () => {
        for (const address of [
          '10.0.0.1',
          '172.16.0.1',
          '172.31.255.254',
          '192.168.1.1',
          '::ffff:192.168.1.1'
        ]) {
          assert.strictEqual(isPrivateDNSAddress(address), true, address);
        }

        for (const address of [
          '0.0.0.0',
          '100.64.0.1',
          '127.0.0.1',
          '169.254.169.254',
          '172.32.0.1',
          '192.0.2.1',
          '198.18.0.1',
          '224.0.0.1',
          '::',
          '::1',
          'fc00::1',
          'fe80::1',
          '2001:db8::1',
          'ff02::1'
        ]) {
          assert.strictEqual(isPrivateDNSAddress(address), false, address);
        }

        const resolver = new RelayRecursiveResolver({
          allowPrivateAuthorities: true
        });

        resolver.stubHost = '127.0.0.1';
        resolver.stubPort = 5300;

        const stub = {host: '127.0.0.1', port: 5300};
        const privateServer = {host: '172.30.20.53', port: 53};
        const publicServer = {host: '1.1.1.1', port: 53};

        assert.deepStrictEqual(
          resolver.filterServers([
            stub,
            privateServer,
            publicServer
          ]),
          [stub, privateServer, publicServer]);

        assert.throws(() => resolver.filterServers([
          {host: '127.0.0.1', port: 53}
        ]), {
          code: 'ERR_DNS_RELAY_PRIVATE_ADDRESS'
        });

        assert.throws(() => resolver.filterServers([
          {host: '172.30.20.53', port: 5353}
        ]), {
          code: 'ERR_DNS_RELAY_PRIVATE_ADDRESS'
        });

        assert.throws(() => resolver.filterServers([
          {host: '172.30.20.53', port: 0}
        ]), /Invalid DNS relay authority/);
      });

    it('should classify a private relay authority as refused', async () => {
      const resolver = {
        async open() {},
        async close() {},
        async resolve() {
          const err = new Error('private authority');
          err.code = 'ERR_DNS_RELAY_PRIVATE_ADDRESS';
          throw err;
        }
      };
      const server = {
        finalize() {
          assert.fail('Private authority response must not be finalized.');
        }
      };
      const backend = new RecursiveDNSRelayBackend(server, resolver);

      await backend.open();
      await assert.rejects(backend.resolveRaw(makeQuery().compress()), {
        code: 'ERR_DNS_RELAY_REFUSED'
      });
      await backend.close();
    });
  });

  describe('service lifecycle', function() {
    it('should admit only active HNS names with resource data', async () => {
      let nameState = {
        registered: true,
        expired: false,
        data: Buffer.from([1])
      };
      const chain = makeChain();
      chain.db.getNameStatus = async (hash, height) => {
        assert(Buffer.isBuffer(hash));
        assert.strictEqual(hash.length, 32);
        assert.strictEqual(height, chain.height + 1);
        return nameState;
      };

      const {service} = createService({
        chain,
        checkName: null,
        rootServer: {blacklist: new Set(['blocked'])}
      });

      assert.strictEqual(await service.isHNSName('relaytest'), true);
      assert.strictEqual(await service.isHNSName('com'), false);

      const overridden = createService({
        checkName: () => true
      }).service;

      assert.strictEqual(await overridden.isHNSName('com'), false);

      nameState = Object.assign({}, nameState, {expired: true});
      assert.strictEqual(await service.isHNSName('relaytest'), false);

      nameState = Object.assign({}, nameState, {
        expired: false,
        data: Buffer.alloc(0)
      });
      assert.strictEqual(await service.isHNSName('relaytest'), false);
      assert.strictEqual(await service.isHNSName('blocked'), false);
    });

    it('should advertise only when enabled, synced, open, and ready',
      async () => {
        const chain = makeChain(false);
        const backend = new FakeBackend();
        const {service} = createService({chain, backend});

        assert.strictEqual(service.isReady(), false);
        await service.open();
        assert.strictEqual(service.isReady(), false);

        chain.synced = true;
        assert.strictEqual(service.isReady(), true);

        backend.ready = false;
        assert.strictEqual(service.isReady(), false);

        const peer = new FakePeer();
        await service.handle(peer, makePacket(1));
        assert.strictEqual(peer.sent[0].status, status.RESOLVER_UNAVAILABLE);
        assert.strictEqual(service.getMetrics().unavailable, 1);

        await service.close();
      });

    it('should reject disabled and unnegotiated use', async () => {
      const disabled = createService({enabled: false});
      await disabled.service.open();

      const peer = new FakePeer();
      await disabled.service.handle(peer, makePacket(1));
      assert.strictEqual(peer.sent[0].status, status.UNSUPPORTED);
      assert.strictEqual(disabled.backend.calls.length, 0);
      await disabled.service.close();

      const enabled = createService();
      await enabled.service.open();

      const early = new FakePeer(false);
      await enabled.service.handle(early, makePacket(2));
      assert.strictEqual(early.sent.length, 0);
      assert.strictEqual(enabled.backend.calls.length, 0);

      const unadvertised = new FakePeer();
      unadvertised.localServices = common.LOCAL_SERVICES;
      await enabled.service.handle(unadvertised, makePacket(3));
      assert.strictEqual(unadvertised.sent.length, 0);
      assert.strictEqual(enabled.backend.calls.length, 0);
      await enabled.service.close();
    });

    it('should relay raw DNS results without translating DNS rcodes',
      async () => {
        let resultCode = codes.NXDOMAIN;
        const backend = new FakeBackend((query) => {
          return makeResponse(query, resultCode);
        });
        const {service, logger} = createService({backend});
        const peer = new FakePeer();

        await service.open();
        assert.strictEqual(await service.handle(peer, makePacket(1)), true);

        assert.strictEqual(peer.sent.length, 1);
        assert.strictEqual(peer.sent[0].status, status.OK);
        assert.strictEqual(
          Message.decode(peer.sent[0].response).code,
          codes.NXDOMAIN);

        resultCode = codes.SERVFAIL;
        assert.strictEqual(await service.handle(peer, makePacket(2)), true);
        assert.strictEqual(peer.sent[1].status, status.OK);
        assert.strictEqual(
          Message.decode(peer.sent[1].response).code,
          codes.SERVFAIL);
        assert.strictEqual(service.getMetrics().accepted, 2);
        assert.strictEqual(service.getMetrics().success, 2);
        assert.strictEqual(service.getMetrics().inflight, 0);
        assert.strictEqual(
          JSON.stringify(logger.entries).includes('relaytest'),
          false);
        assert.strictEqual(
          JSON.stringify(logger.entries).includes('<=512B'),
          true);
        assert.strictEqual(
          JSON.stringify(logger.entries).includes('<50ms'),
          true);

        await service.close();
      });

    it('should refuse non-current HNS names before recursion', async () => {
      const {service, backend} = createService({checkName: () => false});
      const peer = new FakePeer();

      await service.open();
      assert.strictEqual(await service.handle(peer, makePacket(1)), false);
      assert.strictEqual(peer.sent[0].status, status.REFUSED);
      assert.strictEqual(backend.calls.length, 0);
      assert.strictEqual(service.getMetrics().refused, 1);
      await service.close();
    });

    it('should reject malformed queries before recursion', async () => {
      const {service, backend} = createService();
      const peer = new FakePeer();
      const req = makeQuery();
      req.rd = false;

      await service.open();
      assert.strictEqual(
        await service.handle(peer, makePacket(1, req.compress())),
        false);
      assert.strictEqual(peer.sent[0].status, status.INVALID_QUERY);
      assert.strictEqual(backend.calls.length, 0);
      assert.strictEqual(service.getMetrics().invalid, 1);
      await service.close();
    });

    it('should time out name admission and backend work', async () => {
      const admissionPending = deferred();
      const admission = createService({
        timeout: 20,
        maxGlobalInflight: 1,
        checkName: () => admissionPending.promise
      });
      const admissionPeer = new FakePeer();

      await admission.service.open();
      await admission.service.handle(admissionPeer, makePacket(1));
      assert.strictEqual(admissionPeer.sent[0].status, status.TIMEOUT);
      assert.strictEqual(admission.service.getMetrics().timeouts, 1);
      assert.strictEqual(admission.backend.calls.length, 0);
      assert.strictEqual(
        admission.service.getMetrics().admissionOrphans,
        1);
      assert.strictEqual(
        admission.service.peers.get(admissionPeer).physicalInflight,
        1);
      assert.strictEqual(admission.service.isReady(), false);

      admissionPending.resolve(true);
      await admissionPending.promise;
      await Promise.resolve();

      assert.strictEqual(
        admission.service.getMetrics().admissionOrphans,
        0);
      assert.strictEqual(
        admission.service.peers.get(admissionPeer).physicalInflight,
        0);
      assert.strictEqual(admission.service.isReady(), true);
      await admission.service.close();

      const pending = deferred();
      let signal;
      let rawQuery;
      const backend = new FakeBackend((query, options) => {
        rawQuery = query;
        signal = options.signal;
        return pending.promise;
      });
      const relay = createService({
        backend,
        timeout: 20,
        maxGlobalInflight: 1
      });
      const relayPeer = new FakePeer();

      await relay.service.open();
      await relay.service.handle(relayPeer, makePacket(2));
      assert.strictEqual(relayPeer.sent[0].status, status.TIMEOUT);
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(relay.service.getMetrics().inflight, 0);
      assert.strictEqual(relay.service.getMetrics().backendOrphans, 1);
      assert.strictEqual(
        relay.service.peers.get(relayPeer).physicalInflight,
        1);
      assert.strictEqual(relay.service.isReady(), false);

      pending.resolve(makeResponse(rawQuery));
      await pending.promise;
      await Promise.resolve();

      assert.strictEqual(relay.service.getMetrics().backendOrphans, 0);
      assert.strictEqual(
        relay.service.peers.get(relayPeer).physicalInflight,
        0);
      assert.strictEqual(relay.service.isReady(), true);
      await relay.service.close();
    });

    it('should bound peer and global in-flight work', async () => {
      const pending = deferred();
      const entered = deferred();
      const backend = new FakeBackend((query) => {
        entered.resolve(query);
        return pending.promise;
      });
      const {service} = createService({
        backend,
        maxPeerInflight: 1,
        maxGlobalInflight: 1
      });
      const first = new FakePeer();
      const second = new FakePeer();

      await service.open();

      const live = service.handle(first, makePacket(1));
      const query = await entered.promise;

      assert.strictEqual(service.isReady(), false);
      assert.strictEqual(
        await service.handle(first, makePacket(1)),
        false);
      assert.strictEqual(first.sent[0].status, status.INVALID_QUERY);
      assert.strictEqual(
        await service.handle(first, makePacket(2)),
        false);
      assert.strictEqual(
        await service.handle(second, makePacket(3)),
        false);
      assert.strictEqual(first.sent[1].status, status.BUSY);
      assert.strictEqual(second.sent[0].status, status.BUSY);

      pending.resolve(makeResponse(query));
      assert.strictEqual(await live, true);
      assert.strictEqual(first.sent[2].status, status.OK);
      assert.strictEqual(service.getMetrics().busy, 2);
      assert.strictEqual(service.getMetrics().invalid, 1);
      assert.strictEqual(service.getMetrics().inflight, 0);
      assert.strictEqual(service.isReady(), true);

      await service.close();
    });

    it('should charge timed-out physical work to the peer until settlement',
      async () => {
        const pending = deferred();
        let rawQuery;
        const backend = new FakeBackend((query) => {
          rawQuery = query;
          return pending.promise;
        });
        const {service} = createService({
          backend,
          timeout: 20,
          maxPeerInflight: 1,
          maxGlobalInflight: 2
        });
        const peer = new FakePeer();

        await service.open();

        assert.strictEqual(
          await service.handle(peer, makePacket(1)),
          false);
        assert.strictEqual(peer.sent[0].status, status.TIMEOUT);
        assert.strictEqual(service.getMetrics().backendOrphans, 1);

        assert.strictEqual(
          await service.handle(peer, makePacket(2)),
          false);
        assert.strictEqual(peer.sent[1].status, status.BUSY);
        assert.strictEqual(backend.calls.length, 1);

        pending.resolve(makeResponse(rawQuery));
        await pending.promise;
        await Promise.resolve();

        assert.strictEqual(service.getMetrics().backendOrphans, 0);
        assert.strictEqual(
          await service.handle(peer, makePacket(3)),
          true);
        assert.strictEqual(peer.sent[2].status, status.OK);

        await service.close();
      });

    it('should rate-limit bursts', async () => {
      const {service} = createService({rate: 1, burst: 2});
      const peer = new FakePeer();

      await service.open();
      assert.strictEqual(await service.handle(peer, makePacket(1)), true);
      assert.strictEqual(await service.handle(peer, makePacket(2)), true);
      assert.strictEqual(await service.handle(peer, makePacket(3)), false);
      assert.strictEqual(await service.handle(peer, makePacket(4)), false);
      assert.strictEqual(peer.sent.length, 3);
      assert.strictEqual(peer.sent[2].status, status.BUSY);
      assert.strictEqual(service.getMetrics().rateLimited, 2);
      await service.close();
    });

    it('should enforce a finite rate across peer connections', async () => {
      const {service} = createService({
        rate: 100,
        burst: 100,
        globalRate: 1,
        globalBurst: 2
      });
      const peers = [new FakePeer(), new FakePeer(), new FakePeer()];

      await service.open();
      assert.strictEqual(await service.handle(peers[0], makePacket(1)), true);
      assert.strictEqual(await service.handle(peers[1], makePacket(2)), true);
      assert.strictEqual(await service.handle(peers[2], makePacket(3)), false);
      assert.strictEqual(peers[2].sent.length, 1);
      assert.strictEqual(peers[2].sent[0].status, status.BUSY);
      assert.strictEqual(service.getMetrics().globalRateLimited, 1);
      await service.close();
    });

    it('should suppress repeated authority-rate BUSY notices per peer',
      async () => {
        let now = 1000;
        const backend = new FakeBackend(() => {
          const err = new Error('authority rate');
          err.code = 'ERR_DNS_RELAY_BUSY';
          throw err;
        });
        const {service} = createService({
          backend,
          rate: 100,
          burst: 100,
          now: () => now
        });
        const peer = new FakePeer();

        await service.open();
        assert.strictEqual(await service.handle(peer, makePacket(1)), false);
        assert.strictEqual(await service.handle(peer, makePacket(2)), false);
        assert.strictEqual(peer.sent.length, 1);
        assert.strictEqual(peer.sent[0].status, status.BUSY);

        now += 1000;
        assert.strictEqual(await service.handle(peer, makePacket(3)), false);
        assert.strictEqual(peer.sent.length, 2);
        assert.strictEqual(peer.sent[1].status, status.BUSY);
        assert.strictEqual(service.getMetrics().busy, 3);
        await service.close();
      });

    it('should drain cancelled backend work during close', async () => {
      const pending = deferred();
      const entered = deferred();
      const backend = new FakeBackend((query) => {
        entered.resolve(query);
        return pending.promise;
      });
      const {service} = createService({backend, timeout: 100});
      const peer = new FakePeer();

      await service.open();
      const live = service.handle(peer, makePacket(1));

      const query = await entered.promise;
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });

      await Promise.resolve();
      assert.strictEqual(closed, false);
      assert.strictEqual(service.getMetrics().backendOrphans, 1);

      pending.resolve(makeResponse(query));
      await closing;

      assert.strictEqual(await live, false);
      assert.strictEqual(closed, true);
      assert.strictEqual(service.getMetrics().backendOrphans, 0);
    });

    it('should classify backend failures and oversized responses',
      async () => {
        const backend = new FakeBackend();
        const {service} = createService({backend});
        const peer = new FakePeer();

        await service.open();

        backend.handler = () => {
          const err = new Error('unavailable');
          err.code = 'ERR_DNS_RELAY_UNAVAILABLE';
          throw err;
        };
        await service.handle(peer, makePacket(1));

        backend.handler = () => Buffer.alloc(
          common.dnsRelay.MAX_RESPONSE_SIZE + 1);
        await service.handle(peer, makePacket(2));

        backend.handler = () => {
          throw new Error('failure');
        };
        await service.handle(peer, makePacket(3));

        backend.handler = () => {
          const err = new Error('private authority');
          err.code = 'ERR_DNS_RELAY_REFUSED';
          throw err;
        };
        await service.handle(peer, makePacket(4));

        backend.handler = () => {
          const err = new Error('authority rate');
          err.code = 'ERR_DNS_RELAY_BUSY';
          throw err;
        };
        await service.handle(peer, makePacket(5));

        assert.strictEqual(
          peer.sent[0].status,
          status.RESOLVER_UNAVAILABLE);
        assert.strictEqual(peer.sent[1].status, status.INTERNAL_ERROR);
        assert.strictEqual(peer.sent[2].status, status.INTERNAL_ERROR);
        assert.strictEqual(peer.sent[3].status, status.REFUSED);
        assert.strictEqual(peer.sent[4].status, status.BUSY);
        assert.strictEqual(service.getMetrics().unavailable, 1);
        assert.strictEqual(service.getMetrics().oversized, 1);
        assert.strictEqual(service.getMetrics().backendFailures, 1);
        assert.strictEqual(service.getMetrics().refused, 1);
        assert.strictEqual(service.getMetrics().busy, 1);
        await service.close();
      });

    it('should cancel and release work when a peer disconnects',
      async () => {
        const pending = deferred();
        const entered = deferred();
        let signal;
        let rawQuery;
        const backend = new FakeBackend((query, options) => {
          rawQuery = query;
          signal = options.signal;
          entered.resolve();
          return pending.promise;
        });
        const {service} = createService({
          backend,
          maxGlobalInflight: 1
        });
        const peer = new FakePeer();
        const alternate = new FakePeer();

        await service.open();

        const live = service.handle(peer, makePacket(1));
        await entered.promise;
        const disconnectedState = service.peers.get(peer);

        assert.strictEqual(disconnectedState.physicalInflight, 1);
        service.cancelPeer(peer);

        assert.strictEqual(await live, false);
        assert.strictEqual(signal.aborted, true);
        assert.strictEqual(peer.sent.length, 0);
        assert.strictEqual(service.getMetrics().cancelled, 1);
        assert.strictEqual(service.getMetrics().inflight, 0);
        assert.strictEqual(service.getMetrics().backendOrphans, 1);
        assert.strictEqual(service.getMetrics().peers, 0);
        assert.strictEqual(disconnectedState.physicalInflight, 1);
        assert.strictEqual(service.isReady(), false);

        await service.handle(alternate, makePacket(2));
        assert.strictEqual(alternate.sent[0].status, status.BUSY);

        pending.resolve(makeResponse(rawQuery));
        await pending.promise;
        await Promise.resolve();

        assert.strictEqual(service.getMetrics().backendOrphans, 0);
        assert.strictEqual(disconnectedState.physicalInflight, 0);
        assert.strictEqual(service.isReady(), true);

        await service.close();
      });
  });

  describe('pool integration', function() {
    const blocks = new BlockStore({memory: true});
    const chain = new Chain({blocks, memory: true});

    it('should validate the complete direct DNS relay interface', () => {
      assert.throws(() => new Pool({
        chain,
        dnsRelay: {
          isReady: () => true
        }
      }));

      assert.throws(() => new Pool({
        chain,
        dnsRelay: {
          isReady: () => true,
          handle: () => Promise.resolve(false)
        }
      }));

      const relay = {
        isReady: () => true,
        handle: () => Promise.resolve(false),
        cancelPeer() {}
      };
      const pool = new Pool({chain, dnsRelay: relay});

      assert.strictEqual(pool.dnsRelay, relay);
    });

    it('should advertise capability dynamically in version', () => {
      let ready = false;
      const relay = {
        isReady: () => ready,
        handle: () => Promise.resolve(false),
        cancelPeer() {}
      };
      const pool = new Pool({chain});
      pool.setDNSRelay(relay);

      const peer = new Peer(pool.options);
      peer.options.createNonce = () => requestID(99);
      let version;
      peer.send = (packet) => {
        version = packet;
      };

      peer.sendVersion();
      assert.strictEqual(
        version.services & common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        0);

      ready = true;
      peer.sendVersion();
      assert.strictEqual(
        version.services & common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        common.EXPERIMENTAL_DNS_RELAY_SERVICE);
    });

    it('should not allow static services to bypass readiness', () => {
      const pool = new Pool({
        chain,
        services: common.LOCAL_SERVICES
          | common.EXPERIMENTAL_DNS_RELAY_SERVICE
      });

      assert.strictEqual(
        pool.options.getServices()
          & common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        0);
    });

    it('should detach backend work from packet dispatch', async () => {
      const pending = deferred();
      let called = 0;
      const relay = {
        isReady: () => true,
        handle() {
          called += 1;
          return pending.promise;
        },
        cancelPeer() {}
      };
      const pool = new Pool({chain});
      pool.setDNSRelay(relay);

      let returned = false;
      const dispatched = pool.handleGetDNSRelay(
        new FakePeer(),
        makePacket(1));
      dispatched.then(() => {
        returned = true;
      });

      await Promise.resolve();
      await Promise.resolve();

      assert.strictEqual(called, 1);
      assert.strictEqual(returned, true);
      pending.resolve(false);
      await pending.promise;
    });

    it('should cancel relay work before removing a closed peer',
      async () => {
        const calls = [];
        const relay = {
          isReady: () => true,
          handle: () => Promise.resolve(false),
          cancelPeer(peer) {
            calls.push(['cancel', peer]);
          }
        };
        const pool = new Pool({chain});
        pool.setDNSRelay(relay);
        pool.removePeer = (peer) => {
          calls.push(['remove', peer]);
        };
        pool.nonces.remove = () => {};

        const peer = {
          loader: false,
          blockMap: {size: 0},
          hostname: () => '127.0.0.1:1'
        };

        await pool.handleClose(peer, false);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0][0], 'cancel');
        assert.strictEqual(calls[1][0], 'remove');
      });

    it('should remain disabled by default in FullNode', () => {
      const node = new FullNode({
        memory: true,
        network: 'regtest',
        noDns: true
      });

      assert.strictEqual(node.dnsRelay.enabled, false);
      assert.strictEqual(node.dnsRelay.backend, null);
      assert.strictEqual(
        node.pool.options.getServices()
          & common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        0);
    });

    it('should honor opt-in without advertising before readiness', () => {
      const node = new FullNode({
        memory: true,
        network: 'regtest',
        experimentalDnsRelay: true,
        rsNoUnbound: true
      });

      assert.strictEqual(node.dnsRelay.enabled, true);
      assert(node.dnsRelay.backend instanceof RecursiveDNSRelayBackend);
      assert.strictEqual(
        node.dnsRelay.backend.resolver.allowPrivateAuthorities,
        false);
      assert.strictEqual(node.dnsRelay.isReady(), false);
      assert.strictEqual(
        node.pool.options.getServices()
          & common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        0);
    });

    it('should allow private relay authorities only for explicit regtest',
      () => {
        const node = new FullNode({
          memory: true,
          network: 'regtest',
          experimentalDnsRelay: true,
          experimentalDnsRelayAllowPrivateAuthorities: true,
          rsNoUnbound: true
        });

        assert.strictEqual(node.dnsRelay.enabled, true);
        assert.strictEqual(
          node.dnsRelay.backend.resolver.allowPrivateAuthorities,
          true);
        assert.deepStrictEqual(
          node.dnsRelay.backend.resolver.filterServers([
            {host: '172.30.20.53', port: 53}
          ]),
          [{host: '172.30.20.53', port: 53}]);
      });

    it('should reject unsafe private-authority configurations', () => {
      assert.throws(() => new FullNode({
        memory: true,
        network: 'main',
        noDns: true,
        experimentalDnsRelay: true,
        experimentalDnsRelayAllowPrivateAuthorities: true
      }), /only on regtest/);

      assert.throws(() => new FullNode({
        memory: true,
        network: 'regtest',
        noDns: true,
        experimentalDnsRelayAllowPrivateAuthorities: true
      }), /require experimental DNS relay/);
    });
  });
});
