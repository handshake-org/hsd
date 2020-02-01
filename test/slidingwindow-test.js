/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const rules = require('../lib/covenants/rules');
const SlidingWindow = require('../lib/net/slidingwindow');
const FullNode = require('../lib/node/fullnode');
const packets = require('../lib/net/packets');
const packetTypes = packets.types;

const common = require('../test/util/common');

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

describe('SlidingWindow (Unit)', function() {
  const window = new SlidingWindow({
    window: 10,
    limit: 100
  });

  beforeEach(() => {
    window.start();
  });

  afterEach(() => {
    window.stop();
  });

  it('should process max requests in window', async () => {
    for (let i=0; i < window.limit-1; i++)
      window.increase(1);

    assert.ok(window.allow());
  });

  it('should reject after max requests in window', async () => {
    window.increase(1);
    assert.ok(!window.allow());
  });

  it('should reset after window timeout', async () => {
    let reset = false;

    window.once('reset', () => {
      reset = true;
    });

    await sleep(window.window);
    assert.ok(reset === true);
  });
});

describe('SlidingWindow (Functional)', function() {
  this.timeout(3000);

  it('should rate limit getproof to max-proof-rps', async () => {
    const maxProofRPS = 20;
    const seen = {count: 0};

    const one = new FullNode({
      'memory': true,
      'network': 'regtest',
      'listen': true,
      'max-proof-rps': maxProofRPS,
      'seeds': []
    });

    one.pool.on('peer open', () => {
      seen.count++;
    });

    assert.equal(one.pool.options.maxProofRPS, 20);

    const two = new FullNode({
      'memory': true,
      'network': 'regtest',
      'http-port': 10000,
      'rs-port': 10001,
      'ns-port': 10002,
      'seeds': [],
      'only': ['127.0.0.1'] // one is using default ports.
    });

    two.pool.on('peer open', () => {
      seen.count++;
    });

    await one.open();
    await one.connect();

    await two.open();
    await two.connect();

    await common.forValue(seen, 'count', 2);

    assert.equal(one.pool.peers.size(), 1);
    assert.equal(one.pool.peers.inbound, 1);
    assert.equal(two.pool.peers.size(), 1);
    assert.equal(two.pool.peers.outbound, 1);

    const hash = rules.hashString('handshake');

    let banned = false;
    one.pool.on('ban', () => {
      banned = true;
    });

    let packets = 0;
    one.pool.on('packet', (packet) => {
      if (packet.type === packetTypes.GETPROOF)
        packets++;
    });

    let count = 0;
    let err;
    while (!banned) {
      count++;
      try {
        await two.pool.resolve(hash);
      } catch (e) {
        err = e;
        break;
      }
    }

    assert.equal(err.message, 'Timed out.');
    assert.strictEqual(packets, maxProofRPS);
    assert.strictEqual(count, maxProofRPS);

    await one.close();
    await two.close();
  });

  it('should reset getproof counter on window timeout', async () => {
    const maxProofRPS = 20;
    const seen = {count: 0};

    const one = new FullNode({
      'memory': true,
      'network': 'regtest',
      'listen': true,
      'max-proof-rps': maxProofRPS,
      'seeds': []
    });

    one.pool.on('peer open', () => {
      seen.count++;
    });

    assert.equal(one.pool.options.maxProofRPS, 20);

    const two = new FullNode({
      'memory': true,
      'network': 'regtest',
      'http-port': 10000,
      'rs-port': 10001,
      'ns-port': 10002,
      'seeds': [],
      'only': ['127.0.0.1'] // one is using default ports.
    });

    two.pool.on('peer open', () => {
      seen.count++;
    });

    await one.open();
    await one.connect();

    await two.open();
    await two.connect();

    await common.forValue(seen, 'count', 2);

    assert.equal(one.pool.peers.size(), 1);
    assert.equal(one.pool.peers.inbound, 1);
    assert.equal(two.pool.peers.size(), 1);
    assert.equal(two.pool.peers.outbound, 1);

    const hash = rules.hashString('handshake');

    let packets = 0;
    one.pool.on('packet', (packet) => {
      if (packet.type === packetTypes.GETPROOF)
        packets++;
    });

    let count = 0;
    while (count < 25) {
      count++;
      await two.pool.resolve(hash);
      if (count % 10 === 0)
        await sleep(1000);
    }

    assert.strictEqual(packets, 25);
    assert.strictEqual(count, 25);

    await one.close();
    await two.close();
  });
});
