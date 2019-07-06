'use strict';

/* Parts of this software are based on bitcoin/bitcoin:
 *   Copyright (c) 2009-2019, The Bitcoin Core Developers (MIT License).
 *   Copyright (c) 2009-2019, The Bitcoin Developers (MIT License).
 *   https://github.com/bitcoin/bitcoin
 *
 * Resources:
 *   https://github.com/bitcoin/bitcoin/blob/46fc4d1a24c88e797d6080336e3828e45e39c3fd/src/test/netbase_tests.cpp
 */

const assert = require('bsert');
const NetAddress = require('../lib/net/netaddress');
const Network = require('../lib/protocol/network');
const util = require('../lib/utils/util');

const netaddressVectors = require('./data/netaddress-data');

// 16 bytes (ipv6) - 4 (ipv4) byte - 2 ff = 10
const IPV4_PREFIX = Buffer.from(`${'00'.repeat(10)}ffff`, 'hex');

const main = Network.get('main');

describe('NetAddress', function() {
  it('should parse options', () => {
    const {options} = netaddressVectors;

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
    const {failOptions} = netaddressVectors;

    for (const [opts, msg] of failOptions) {
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
    const {fromHost} = netaddressVectors;
    const naddr = new NetAddress();

    for (const [params, expected] of fromHost) {
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
    const {fromHostname} = netaddressVectors;

    for (const [args, expected] of fromHostname) {
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
    const {fromSocket} = netaddressVectors;

    for (const [args, expected] of fromSocket) {
      const addr = NetAddress.fromSocket(...args);

      assert.strictEqual(addr.hostname, expected.hostname);
      assert.strictEqual(addr.host, expected.host);
      assert.strictEqual(addr.port, expected.port);
    }
  });

  it('should compare addresses', () => {
    const {compare} = netaddressVectors;

    for (const [[hosta, porta], [hostb, portb], expected] of compare) {
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
    // see: binet.getReachability for details.
    // tests for the getReachability are covered in binet.
    //
    // Here we only test single case for all.
    const {getReachability} = netaddressVectors;
    for (const [source, destination, reachability] of getReachability) {
      const src = new NetAddress({
        host: source,
        port: 1000
      });

      const dest = new NetAddress({
        host: destination,
        port: 1000
      });

      assert.strictEqual(src.getReachability(dest), reachability,
        `${source}->${destination} - ${reachability}`);
    }
  });

  it('should return the correct group', () => {
    // Local -> !Routable()
    assert.bufferEqual(
      NetAddress.fromHost('127.0.0.1', 13038, null, 'testnet').getGroup(),
      Buffer.from([0xff])
    );

    // RFC1918 -> !Routable()
    assert.bufferEqual(
      NetAddress.fromHost('169.254.1.1', 13038, null, 'testnet').getGroup(),
      Buffer.from([0])
    );

    // IPv4
    assert.bufferEqual(
      NetAddress.fromHost('1.2.3.4', 13038, null, 'testnet').getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC6145
    assert.bufferEqual(
      NetAddress.fromHost(
        '::FFFF:0:102:304',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC6052
    assert.bufferEqual(
      NetAddress.fromHost(
        '64:FF9B::102:304',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC3964
    assert.bufferEqual(
      NetAddress.fromHost(
        '2002:102:304:9999:9999:9999:9999:9999',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC4380
    assert.bufferEqual(
      NetAddress.fromHost(
        '2001:0:9999:9999:9999:9999:FEFD:FCFB',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // Tor
    assert.bufferEqual(
      NetAddress.fromHost(
        'FD87:D87E:EB43:edb1:8e4:3588:e546:35ca',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([3, 239])
    );

    // he.net
    assert.bufferEqual(
      NetAddress.fromHost(
        '2001:470:abcd:9999:9999:9999:9999:9999',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([2, 32, 1, 4, 112, 175])
    );

    // IPv6
    assert.bufferEqual(
      NetAddress.fromHost(
        '2001:2001:9999:9999:9999:9999:9999:9999',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([2, 32, 1, 32, 1])
    );
  });
});
