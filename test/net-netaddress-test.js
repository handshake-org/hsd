'use strict';

const assert = require('bsert');
const NetAddress = require('../lib/net/netaddress');
const Network = require('../lib/protocol/network');
const util = require('../lib/utils/util')

// 16 bytes (ipv6) - 4 (ipv4) byte - 2 ff = 10
const IPV4_PREFIX = Buffer.from(`${'00'.repeat(10)}ffff`, 'hex');

const main = Network.get('main');
const regtest = Network.get('regtest');

describe('NetAddress', function() {
  it('should parse options', () => {
    const options = [
      [null, {
        host: '0.0.0.0',
        port: 0,
        hostname: '0.0.0.0:0',
        isNull: true,
        isIPv6: false,
        isLocal: true,
        isValid: false,
        isRoutable: false
      }],
      [{
        host: '0.0.0.0',
        port: 0
      }, {
        host: '0.0.0.0',
        port: 0,
        hostname: '0.0.0.0:0',
        isNull: true,
        isIPv6: false,
        isLocal: true,
        isValid: false,
        isRoutable: false
      }],
      [{
        host: '2345:0425:2CA1:0000:0000:0567:5673:23b5',
        port: 1000
      }, {
        host: '2345:425:2ca1::567:5673:23b5',
        port: 1000,
        hostname: '[2345:425:2ca1::567:5673:23b5]:1000',
        isIPv6: true,
        isLocal: false,
        isValid: true,
        isRoutable: true
      }],
      [{
        host: '1.1.1.1',
        port: 1,
        services: 1,
        key: Buffer.alloc(33, 1)
      }, {
        hostname:
          'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@1.1.1.1:1',
        key: Buffer.alloc(33, 1),
        services: 1,
        isIPv6: false,
        isLocal: false,
        isValid: true,
        isRoutable: true
      }],
      [{
        host: '2.2.2.2',
        port: 2,
        key: Buffer.alloc(33, 2),
        services: 2
      }, {
        hostname:
          'aibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae@2.2.2.2:2',
        key: Buffer.alloc(33, 2),
        services: 2,
        isIPv6: false,
        isLocal: false,
        isValid: true,
        isRoutable: true
      }], [{
        host: '127.0.0.1',
        port: 1000,
        services: 3
      }, {
        hostname: '127.0.0.1:1000',
        services: 3,
        isIPv6: false,
        isLocal: true,
        isValid: true,
        isRoutable: false
      }], [{
        host: '127.1.1.1',
        port: 1000
      }, {
        hostname: '127.1.1.1:1000',
        isIPv6: false,
        isLocal: true,
        isValid: true,
        isRoutable: false
      }], [{
        host: '::1',
        port: 1000
      }, {
        hostname: '[::1]:1000',
        isIPv6: true,
        isLocal: true,
        isValid: true,
        isRoutable: false
      }], [{
        host: 'fd87:d87e:eb43::1',
        port: 1000
      }, {
        host: 'aaaaaaaaaaaaaaab.onion',
        hostname: 'aaaaaaaaaaaaaaab.onion:1000',
        isIPv6: false,
        isIPV4: false,
        isLocal: false,
        isValid: true,
        isRoutable: true,
        isOnion: true
      }]
    ];

    for (const [i, [opts, expected]] of options.entries()) {
      const naddr = new NetAddress(opts);

      if (expected.host == null)
        expected.host = opts.host;

      if (expected.port == null)
        expected.port = opts.port;

      assert.strictEqual(naddr.host, expected.host, `Failed #${i}`);
      assert.strictEqual(naddr.port, expected.port, `Failed #${i}`);
      assert.strictEqual(naddr.hostname, expected.hostname, `Failed #${i}`);

      const expectedKey = opts && opts.key;
      assert.strictEqual(naddr.hasKey(), Boolean(expectedKey), `Failed #${i}`);

      if (expectedKey)
        assert.bufferEqual(naddr.key, expectedKey, `Failed #${i}`);

      if (expected.isIPv6 != null) {
        const isIPV4 = expected.isIPV4 != null
          ? expected.isIPV4
          : !expected.isIPv6;

        assert.strictEqual(naddr.isIPv4(), isIPV4, `Failed #${i}`);
        assert.strictEqual(naddr.isIPv6(), expected.isIPv6, `Failed #${i}`);
      }

      if (opts && opts.services != null) {
        assert.strictEqual(true, naddr.hasServices(expected.services),
          `Failed #${i}`);
      }

      assert.strictEqual(naddr.isRoutable(), expected.isRoutable, `Failed #${i}`);
      assert.strictEqual(naddr.isValid(), expected.isValid, `Failed #${i}`);
      assert.strictEqual(naddr.isNull(), Boolean(expected.isNull),
        `Failed #${i}`);
      assert.strictEqual(naddr.isOnion(), Boolean(expected.isOnion),
        `Failed #${i}`);
      assert.strictEqual(true, naddr.equal(naddr), `Failed #${i}`);

      assert.strictEqual(naddr.isLocal(), expected.isLocal, `Failed #${i}`);
    }
  });

  it('should fail parsing options', () => {
    const goodOptions = {
      host: '0.0.0.0',
      port: 12038
    };

    const badOptions = [
      [{ port: goodOptions.port }, 'NetAddress requires host string.'],
      [{ host: 1234 }, 'NetAddress requires host string.'],
      [{ host: goodOptions.host }, 'NetAddress requires port number.'],
      [{ host: goodOptions.host, port: '32' },
        'NetAddress requires port number.'],
      [{ host: goodOptions.host, port: -1 }, 'port number is incorrect.'],
      [{ host: goodOptions.host, port: 0xffff + 1 },
        'port number is incorrect.'],
      [{ ...goodOptions, services: '12' }, 'services must be a number.'],
      [{ ...goodOptions, services: {} }, 'services must be a number.'],
      [{ ...goodOptions, key: '12' }, 'key must be a buffer.'],
      [{ ...goodOptions, key: 11 }, 'key must be a buffer.']
    ];

    for (const [opts, msg] of badOptions) {
      let err;
      try {
        new NetAddress(opts);
      } catch (e) {
        err = e;
      }

      assert(err, 'Expected err');
      assert.strictEqual(err.message, msg);
    }
  });

  it('should check services', async () => {
    const naddr = new NetAddress();

    const serviceList = [];
    for (let i = 0; i < 10; i++)
      serviceList.push(1 << i);

    naddr.services = serviceList[7] | serviceList[8] | serviceList[9];

    for (let i = 7; i < 10; i++)
      assert.strictEqual(true, naddr.hasServices(serviceList[i]));

    for (let i = 0; i < 7; i++)
      assert.strictEqual(false, naddr.hasServices(serviceList[i]));

    assert.strictEqual(true,
      naddr.hasServices(serviceList[7] | serviceList[8]));
    assert.strictEqual(false,
      naddr.hasServices(serviceList[1] | serviceList[8]));
  });

  it('should set null', async () => {
    const oldRaw = Buffer.from('2d4f86e1', 'hex');
    const nullRaw = Buffer.alloc(4, 0);
    const naddr = new NetAddress({
      host: '45.79.134.225',
      port: 1
    });

    assert.strictEqual(false, naddr.isNull());
    assert.bufferEqual(naddr.raw, Buffer.concat([IPV4_PREFIX, oldRaw]));
    assert.strictEqual(naddr.hostname, '45.79.134.225:1');

    naddr.setNull();
    assert.strictEqual(true, naddr.isNull());
    assert.bufferEqual(naddr.raw, Buffer.concat([IPV4_PREFIX, nullRaw]));
    assert.strictEqual(naddr.hostname, '0.0.0.0:1');
  });

  it('should set host', async () => {
    const oldHost = '45.79.134.225';
    const oldRaw = Buffer.from('2d4f86e1', 'hex');
    const newHost = '15.152.112.161';
    const newRaw = Buffer.from('0f9870a1', 'hex');

    const naddr = new NetAddress({
      host: oldHost,
      port: 12038
    });

    assert.strictEqual(naddr.host, oldHost);
    assert.bufferEqual(naddr.raw, Buffer.concat([IPV4_PREFIX, oldRaw]));
    naddr.setHost(newHost);
    assert.strictEqual(naddr.host, newHost);
    assert.bufferEqual(naddr.raw, Buffer.concat([IPV4_PREFIX, newRaw]));
  });

  it('should set port', async () => {
    const naddr = new NetAddress({
      host: '45.79.134.225',
      port: 1000
    });

    const badPorts = [
      -1,
      -0xffff,
      0xffff + 1,
      0xffffff
    ];

    for (const port of badPorts) {
      let err;
      try {
        naddr.setPort(port);
      } catch (e) {
        err = e;
      }

      assert(err, `Error not found for ${port}.`);
    }

    const goodPorts = [
      0,
      0xffff,
      12038,
      44806
    ];

    for (const port of goodPorts) {
      naddr.setPort(port);
      assert.strictEqual(naddr.port, port);
      assert.strictEqual(naddr.hostname, `${naddr.host}:${port}`);
    }
  });

  it('should set/get key', async () => {
    const testKey = Buffer.alloc(33, 1);

    const naddr = new NetAddress({
      host: '0.0.0.0',
      port: 1000
    });

    assert.strictEqual(naddr.getKey(), null);

    naddr.setKey(testKey);
    assert.bufferEqual(naddr.getKey(), testKey);
    assert.strictEqual(naddr.getKey('base32'),
      'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc');
    assert.strictEqual(naddr.getKey('hex'),
      '01'.repeat(33));
    assert.strictEqual(naddr.hostname,
      `${naddr.getKey('base32')}@${naddr.host}:${naddr.port}`);

    naddr.setKey();
    assert.strictEqual(naddr.getKey(), null);
    assert.strictEqual(naddr.getKey('base32'), null);
    assert.strictEqual(naddr.getKey('hex'), null);
    assert.strictEqual(naddr.hostname, `${naddr.host}:${naddr.port}`);

    const badKeys = [
      'badkey',
      Buffer.alloc(32, 0),
      Buffer.alloc(34, 11)
    ];

    for (const key of badKeys) {
      let err;
      try {
        naddr.setKey(key);
      } catch (e) {
        err = e;
      }

      assert(err);
    }
  });

  it('should create from host', () => {
    const vector = [
      [
        ['172.104.214.189', 1000, Buffer.alloc(33, 1)],
        {
          host: '172.104.214.189',
          port: 1000,
          key: Buffer.alloc(33, 1),
          hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
            + '@172.104.214.189:1000'
        }
      ],
      [
        ['15.152.162.66', 1001, Buffer.alloc(33, 2)],
        {
          host: '15.152.162.66',
          port: 1001,
          key: Buffer.alloc(33, 2),
          hostname: 'aibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae'
            + '@15.152.162.66:1001'
        }
      ],
      [
        ['2345:0425:2CA1:0000:0000:0567:5673:23b5', 0xffff],
        {
          host: '2345:425:2ca1::567:5673:23b5',
          port: 0xffff,
          key: Buffer.alloc(33, 0),
          hostname: '[2345:425:2ca1::567:5673:23b5]:65535'
        }
      ]
    ];

    const naddr = new NetAddress();

    for (const [params, expected] of vector) {
      naddr.fromHost(...params);
      const naddr2 = NetAddress.fromHost(...params);

      for (const addr of [naddr, naddr2]) {
        assert.strictEqual(addr.host, expected.host);
        assert.strictEqual(addr.port, expected.port);
        assert.bufferEqual(addr.key, expected.key);
        assert.strictEqual(addr.hostname, expected.hostname);
      }
    }
  });

  it('should create from hostname', () => {
    const vector = [
      [['127.0.0.1:100', 'main'], {
        hostname: '127.0.0.1:100',
        host: '127.0.0.1',
        port: 100,
        key: Buffer.alloc(33, 0)
      }],
      [
        [
          'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@127.0.0.1:100',
          'main'
        ], {
          hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
            + '@127.0.0.1:100',
          host: '127.0.0.1',
          port: 100,
          key: Buffer.alloc(33, 1)
        }
      ],
      [['127.0.0.1', 'main'], {
        hostname: `127.0.0.1:${main.port}`,
        host: '127.0.0.1',
        port: main.port,
        key: Buffer.alloc(33, 0)
      }],
      [
        [
          'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@127.0.0.1',
          'main'
        ], {
          hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
            + `@127.0.0.1:${main.brontidePort}`,
          host: '127.0.0.1',
          port: main.brontidePort,
          key: Buffer.alloc(33, 1)
        }
      ],
      [['127.0.0.1', 'regtest'], {
        hostname: `127.0.0.1:${regtest.port}`,
        host: '127.0.0.1',
        port: regtest.port,
        key: Buffer.alloc(33, 0)
      }],
      [
        [
          'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@127.0.0.1',
          'regtest'
        ], {
          hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
            + `@127.0.0.1:${regtest.brontidePort}`,
          host: '127.0.0.1',
          port: regtest.brontidePort,
          key: Buffer.alloc(33, 1)
        }
      ]
    ];

    for (const [args, expected] of vector) {
      const addr1 = new NetAddress();
      addr1.fromHostname(...args);

      const addr2 = NetAddress.fromHostname(...args);

      for (const addr of [addr1, addr2]) {
        assert.strictEqual(addr.hostname, expected.hostname);
        assert.strictEqual(addr.host, expected.host);
        assert.strictEqual(addr.port, expected.port);
        assert.bufferEqual(addr.key, expected.key);
      }
    }
  });

  it('should create from socket', () => {
    const vector = [
      [[{
        remoteAddress: '2001:4860:a005::68',
        remotePort: 1000
      }, 'main'], {
        hostname: '[2001:4860:a005::68]:1000',
        host: '2001:4860:a005::68',
        port: 1000
      }],
      [[{
        remoteAddress: '74.125.127.100',
        remotePort: 2000
      }, 'main'], {
        hostname: '74.125.127.100:2000',
        host: '74.125.127.100',
        port: 2000
      }]
    ];

    for (const [args, expected] of vector) {
      const addr = NetAddress.fromSocket(...args);

      assert.strictEqual(addr.hostname, expected.hostname);
      assert.strictEqual(addr.host, expected.host);
      assert.strictEqual(addr.port, expected.port);
    }
  });

  it('should compare addresses', () => {
    const vector = [
      [['127.0.0.1', 10], ['127.1.1.1', 9], -1],
      [['0.0.0.0', 10], ['1.1.1.1', 9], -1],
      [['0.0.0.1', 10], ['0.0.0.1', 9], 1],
      // IPV4 has two 0xff in the buffer before last 4 bytes.
      // So any IPV6 from ::1 to :ffff:0:0 will be lower than IPV4.
      // And any IPV6 from :ffff:0:0 to :ffff:ffff:ffff will be IPV4.
      [['::1', 1], ['0.0.0.1', 1], -1],
      [['::ffff:ffff', 1], ['0.0.0.1', 1], -1],
      [['::ffff:ffff:ffff', 1], ['0.0.0.1', 1], 1],
      [['::ffff:0:1', 1], ['0.0.0.1', 1], 0],
      [['::ffff:ffff:ffff', 1], ['255.255.255.255', 1], 0],
      // If IPs are same, then we compare ports.
      [['::1', 102], ['::1', 101], 1],
      [['::1', 100], ['::1', 101], -1],
      [['::1', 100], ['::1', 100], 0]
    ];

    for (const [[hosta, porta], [hostb, portb], expected] of vector) {
      const addrA = new NetAddress({
        host: hosta,
        port: porta
      });

      const addrB = new NetAddress({
        host: hostb,
        port: portb
      });

      assert.strictEqual(addrA.compare(addrB), expected,
        `Failed for ${hosta}:${portb} compare to ${hostb}:${portb}.`);
    }
  });

  it('should serialize/deserialize raw', () => {
    const options = {
      host: '::1',
      port: 1000,
      services: 0xff,
      time: main.now(),
      key: Buffer.alloc(33, 1)
    };

    const check = (addr, incorrectHost) => {
      if (incorrectHost)
        assert.notStrictEqual(addr.host, options.host);
      else
        assert.strictEqual(addr.host, options.host);
      assert.strictEqual(addr.port, options.port);
      assert.strictEqual(addr.time, options.time);
      assert.strictEqual(addr.services, options.services);
      assert.bufferEqual(addr.key, options.key);
    };

    {
      const addr = new NetAddress(options);
      const encoded = addr.encode();
      const decoded = NetAddress.decode(encoded);

      assert.strictEqual(decoded.equal(addr), true);
      assert.strictEqual(decoded.compare(addr), 0);
      assert.bufferEqual(decoded.encode(), encoded);
      check(decoded);
    }

    {
      // Do not decode IP.
      const addr = new NetAddress(options);
      const encoded = addr.encode();
      // time(8) + services(4) + service bits(4)
      encoded[8 + 8] = 1;

      const decoded = NetAddress.decode(encoded);

      assert.strictEqual(decoded.equal(addr), false);
      assert.strictEqual(decoded.compare(addr), -1);
      assert.notBufferEqual(decoded.encode(), encoded);

      check(decoded, true);
    }
  });

  it('should serialize/deserialize JSON', () => {
    const options = {
      host: '::1',
      port: 1000,
      services: 0xff,
      time: main.now(),
      key: Buffer.alloc(33, 1)
    };

    const check = (addr, hex) => {
      assert.strictEqual(addr.host, options.host);
      assert.strictEqual(addr.port, options.port);
      assert.strictEqual(addr.time, options.time);
      assert.strictEqual(addr.services, options.services);

      if (hex)
        assert.strictEqual(addr.key, options.key.toString('hex'));
      else
        assert.bufferEqual(addr.key, options.key);
    };

    const addr = new NetAddress(options);
    const json = addr.getJSON();
    const decoded = NetAddress.fromJSON(json);

    assert.strictEqual(decoded.equal(addr), true);
    assert.strictEqual(decoded.compare(addr), 0);
    assert.bufferEqual(decoded.encode(), addr.encode());
    check(decoded);
    check(json, true);
  });

  it('should inspect/format', () => {
    const options = {
      host: '::1',
      port: 1000,
      services: 0xff,
      time: main.now(),
      key: Buffer.alloc(33, 1)
    };

    const addr = new NetAddress(options);
    const formatted = addr.format();

    assert.strictEqual(formatted.startsWith('<NetAddress'), true);
    assert.strictEqual(formatted.endsWith('>'), true);
    assert.strictEqual(formatted.indexOf(`hostname=${addr.hostname}`) > 0,
      true);
    assert.strictEqual(
      formatted.indexOf(`services=${addr.services.toString(2)}`) > 0,
      true
    );
    assert.strictEqual(formatted.indexOf(`date=${util.date(addr.time)}`) > 0,
      true);
  });

  it('should get reachability score', () => {
    // see: binet.getReachability for details
    const UNREACHABLE = 0;
    const DEFAULT = 1;
    // const TEREDO = 2;
    // const IPV6_WEAK = 3;
    const IPV4 = 4;
    // const IPV6_STRONG = 5;
    // const PRIVATE = 6;

    const ipv4src = '74.125.127.100';
    const ipv4dest = '45.79.134.225';

    const ipv6src = 'ffff::1';
    const ipv6dest = 'ffff::ffff';

    const teredosrc = '2001::1';
    const teredodest = '2001:ffff::1';

    const onionsrc = 'aaaaaaaaaaaaaaaa.onion';
    const oniondest = 'bbbbbbbbbbbbbbbb.onion';

    const unreachable = [
      // Source UNREACHABLE
      ['0.0.0.0', ipv4dest, UNREACHABLE],
      ['127.0.0.1', ipv4dest, UNREACHABLE],
      ['::', ipv4dest, UNREACHABLE],
      ['::1', ipv4dest, UNREACHABLE],
      // broadcast
      ['255.255.255.255', ipv4dest, UNREACHABLE],
      // SHIFTED
      ['::ff:ff00:0:0:0', ipv4dest, UNREACHABLE],
      // RFC3849 - IPv6 Reserved prefix
      ['2001:0db8::', ipv4dest, UNREACHABLE],
      ['2001:db8::1:1', ipv4dest, UNREACHABLE],
      // RFC 1918 - Private Internets
      ['192.168.1.1', ipv4dest, UNREACHABLE],
      ['10.10.10.10', ipv4dest, UNREACHABLE],
      ['172.20.1.1', ipv4dest, UNREACHABLE],
      // RFC 2544 - IPv4 inter-network communications (198.18.0.0/15)
      ['198.18.1.1', ipv4dest, UNREACHABLE],
      ['198.19.255.255', ipv4dest, UNREACHABLE],
      // RFC 3927 - Link local addresses (179.254.0.0/16)
      ['169.254.0.0', ipv4dest, UNREACHABLE],
      ['169.254.255.255', ipv4dest, UNREACHABLE],
      // RFC 4862 - IPv6 Stateless address autoconfiguration
      ['fe80::', ipv4dest, UNREACHABLE],
      ['fe80::1', ipv4dest, UNREACHABLE],
      // RFC 6598 - IANA-Reserved IPv4 Prefix for Shared Address Space
      ['100.64.0.0', ipv4dest, UNREACHABLE],
      ['100.127.255.255', ipv4dest, UNREACHABLE],
      // RFC 5737 - IPv4 Address Blocks Reserved for Documentation
      ['192.0.2.0', ipv4dest, UNREACHABLE],
      ['192.0.2.255', ipv4dest, UNREACHABLE],
      ['198.51.100.0', ipv4dest, UNREACHABLE],
      ['198.51.100.255', ipv4dest, UNREACHABLE],
      ['203.0.113.0', ipv4dest, UNREACHABLE],
      ['203.0.113.255', ipv4dest, UNREACHABLE],
      // RFC 4193 - Unique Local IPv6 Unicast Addresses
      // FC00::/7
      ['fd00::', ipv4dest, UNREACHABLE],
      ['fc00::', ipv4dest, UNREACHABLE],
      ['fcff::', ipv4dest, UNREACHABLE],
      // RFC 4843 - Overlay Routable Cryptographic Hash Identifiers prefix.
      //            ORCHID
      ['2001:0010::', ipv4dest, UNREACHABLE],
      ['2001:0010:ffff::', ipv4dest, UNREACHABLE],
      // RFC 7343 - ORCHIDv2
      ['2001:0020::', ipv4dest, UNREACHABLE],
      ['2001:0020::ffff', ipv4dest, UNREACHABLE]
    ];

    const destIPV4 = [
      // We already made sure above, source is not invalid.
      // only proper outputs left.
      [ipv4src, ipv4dest, IPV4],
      [ipv6src, ipv4dest, DEFAULT],
      [onionsrc, ipv4dest, DEFAULT],
      [teredosrc, ipv4dest, DEFAULT]
    ];

    // const 

    const vector = [
      ...unreachable,
    ];

    for (const [source, destination, reachability] of vector) {
      const src = new NetAddress({
        host: source,
        port: 1000
      });

      const dest = new NetAddress({
        host: destination,
        port: 1000
      });

      assert.strictEqual(src.getReachability(dest), reachability);
    }
  });
});
