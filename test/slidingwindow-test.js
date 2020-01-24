/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const base32 = require('bs32');

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
  it('should rate limit getproof to max-proof-rps ', async () => {
    const maxProofRPS = 20;

    const one = new FullNode({
      'memory': true,
      'network': 'regtest',
      'listen': true,
      'max-proof-rps': maxProofRPS,
      'host': '127.0.1.1',
      'http-host': '127.0.1.1',
      'rs-host': '127.0.1.1',
      'ns-host': '127.0.1.1',
      'seeds': []
    });

    assert.equal(one.pool.options.maxProofRPS, 20);

    const key = base32.encode(one.pool.hosts.address.key);

    const two = new FullNode({
      'memory': true,
      'network': 'regtest',
      'host': '127.0.0.2',
      'http-host': '127.0.0.2',
      'rs-host': '127.0.0.2',
      'ns-host': '127.0.0.2',
      'seeds': [],
      'only': [`${key}@127.0.1.1`]
    });

    await one.open();
    await one.connect();

    await two.open();
    await two.connect();

    await common.event(one.pool, 'peer open');

    assert.equal(one.pool.peers.size(), 1);
    assert.equal(one.pool.peers.brontide.inbound, 1);
    assert.equal(two.pool.peers.size(), 1);
    assert.equal(two.pool.peers.brontide.outbound, 1);

    const hash = rules.hashString('handshake');

    let seen = false;
    one.pool.on('ban', () => {
      seen = true;
    });

    let packets = 0;
    one.pool.on('packet', (packet) => {
      if (packet.type === packetTypes.GETPROOF)
        packets++;
    });

    let count = 0;
    while (!seen) {
      count++;
      try {
        await two.pool.resolve(hash) ;
      } catch (e) {
        break;
      }
    }

    assert.strictEqual(packets, maxProofRPS);
    assert.strictEqual(count, maxProofRPS);

    await one.close();
    await two.close();
  });
});
