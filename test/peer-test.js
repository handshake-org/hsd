/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const common = require('../lib/net/common');
const Peer = require('../lib/net/peer');
const Network = require('../lib/protocol/network');
const network = Network.regtest;

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

describe('Peer (Unit)', function() {
  const peer = new Peer({
    'network': network,
    logger: new Logger({
      level: 'debug',
      file: false,
      console: false
    }),
  });

  beforeEach(() => {
    peer.banScore = 0;
    peer.dosScore = 0;
  });

  it('should increase ban score', async () => {
    peer.increaseBan(10)
    assert.strictEqual(peer.banScore, 10);

    peer.increaseBan(10)
    assert.strictEqual(peer.banScore, 20);
  });

  it('should increase dos score', async () => {
    peer.increaseDos(10, Date.now());
    assert.strictEqual(peer.dosScore, 10);

    peer.increaseDos(10, Date.now());
    assert.strictEqual(peer.dosScore, 20);

    peer.increaseDos(10, Date.now());
    assert.strictEqual(peer.dosScore, 30);
  });

  it('should increase dos score with decay', async () => {
    peer.increaseDos(30, Date.now());
    assert.strictEqual(peer.dosScore, 30);

    await sleep(1000);
    // (30 * 0.98) + 10

    peer.increaseDos(10, Date.now());
    assert.strictEqual(peer.dosScore, 39);
  });

  it('should reset dos score after decay', async () => {
    peer.increaseDos(10, Date.now());
    assert.strictEqual(peer.dosScore, 10);

    // override reset time to 1s
    const dosResetTime = common.DOS_RESET_TIME;
    common.DOS_RESET_TIME = 1;

    await sleep(1000);

    peer.increaseDos(10, Date.now());
    assert.strictEqual(peer.dosScore, 10);

    common.DOS_RESET_TIME = dosResetTime;
  });
});
