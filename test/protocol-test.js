/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint indent: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const util = require('../lib/utils/util');
const NetAddress = require('../lib/net/netaddress');
const Framer = require('../lib/net/framer');
const Parser = require('../lib/net/parser');
const packets = require('../lib/net/packets');
const network = Network.get('main');

describe('Protocol', function() {
  const pkg = require('../lib/pkg');
  const agent = `/${pkg.name}:${pkg.version}/`;

  let parser, framer;

  beforeEach(() => {
    parser = new Parser();
    framer = new Framer();
  });

  function packetTest(type, payload, test) {
    it(`should encode/decode ${packets.typesByVal[type]}`, (cb) => {
      parser.once('packet', (packet) => {
        try {
          assert.strictEqual(packet.type, type);
          test(packet);
        } catch (e) {
          cb(e);
          return;
        }
        cb();
      });
      const raw = framer.packet(type, payload.encode());
      parser.feed(raw);
    });
  }

  const v1 = packets.VersionPacket.fromOptions({
    version: 300,
    services: 1,
    time: network.now(),
    remote: new NetAddress(),
    nonce: Buffer.allocUnsafe(8),
    agent: agent,
    height: 0,
    noRelay: false
  });

  packetTest(packets.types.VERSION, v1, (payload) => {
    assert.strictEqual(payload.version, 300);
    assert.strictEqual(payload.agent, agent);
    assert.strictEqual(payload.height, 0);
    assert.strictEqual(payload.noRelay, false);
  });

  const v2 = packets.VersionPacket.fromOptions({
    version: 300,
    services: 1,
    time: network.now(),
    remote: new NetAddress(),
    nonce: Buffer.allocUnsafe(8),
    agent: agent,
    height: 10,
    noRelay: true
  });

  packetTest(packets.types.VERSION, v2, (payload) => {
    assert.strictEqual(payload.version, 300);
    assert.strictEqual(payload.agent, agent);
    assert.strictEqual(payload.height, 10);
    assert.strictEqual(payload.noRelay, true);
  });

  packetTest(packets.types.VERACK, new packets.VerackPacket(), (payload) => {
  });

  const hosts = [
    new NetAddress({
      services: 1,
      host: '127.0.0.1',
      port: 8333,
      time: util.now()
    }),
    new NetAddress({
      services: 1,
      host: '::123:456:789a',
      port: 18333,
      time: util.now()
    })
  ];

  packetTest(packets.types.ADDR, new packets.AddrPacket(hosts), (payload) => {
    assert(Array.isArray(payload.items));
    assert.strictEqual(payload.items.length, 2);

    assert(typeof payload.items[0].time === 'number');
    assert.strictEqual(payload.items[0].services, 1);
    assert.strictEqual(payload.items[0].host, hosts[0].host);
    assert.strictEqual(payload.items[0].port, hosts[0].port);

    assert(typeof payload.items[1].time === 'number');
    assert.strictEqual(payload.items[1].services, 1);
    assert.strictEqual(payload.items[1].host, hosts[1].host);
    assert.strictEqual(payload.items[1].port, hosts[1].port);
  });
});
