/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const {BufferWriter} = require('bufio');
const assert = require('bsert');
const nodejsUtil = require('util');
const random = require('bcrypto/lib/random');

const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const common = require('../test/util/common');
const {types, typesByVal} = require('../lib/covenants/rules');

const tx1 = common.readTX('tx1');
const coin1 = common.readFile('coin1.raw');

describe('Coin', function() {
  it('should serialize and deserialize from JSON', () => {
    const key = KeyRing.generate();
    const networks = ['main', 'testnet', 'regtest', 'simnet'];

    for (const network of networks) {
      const addr = key.getAddress().toString(network);
      const item = random.randomBytes(32);
      const json = {
        version: 0,
        height: 0,
        value: 1e4,
        address: addr,
        coinbase: true,
        covenant: {
          type: types.OPEN,
          action: typesByVal[types.OPEN],
          items: [item.toString('hex')]
        }
      };

      const fromJSON = Coin.fromJSON(json, network);
      const bw = new BufferWriter(fromJSON.getSize());
      fromJSON.write(bw);

      const fromRaw = Coin.fromRaw(bw.render()).getJSON(network);

      for (const [key, want] of Object.entries(json)) {
        const got = fromRaw[key];
        assert.deepEqual(want, got);
      }
    }
  });

  it('should instantiate from tx', () => {
    const [tx] = tx1.getTX();
    const json = require('./data/coin1.json');
    const want = Coin.fromJSON(json);
    const got = Coin.fromTX(tx, 0, -1);

    assert.deepEqual(want.version, got.version);
    assert.deepEqual(want.height, got.height);
    assert.deepEqual(want.value, got.value);
    assert.deepEqual(want.address, got.address);
    assert.deepEqual(want.covenant, got.covenant);
    assert.deepEqual(want.coinbase, got.coinbase);
    assert.deepEqual(want.coinbase, got.coinbase);
  });

  it('should instantiate from raw', () => {
    const json = require('./data/coin1.json');
    const want = Coin.fromJSON(json);
    const got = Coin.fromRaw(coin1);

    assert.deepEqual(want.version, got.version);
    assert.deepEqual(want.height, got.height);
    assert.deepEqual(want.value, got.value);
    assert.deepEqual(want.address, got.address);
    assert.deepEqual(want.covenant, got.covenant);
    assert.deepEqual(want.coinbase, got.coinbase);
    assert.deepEqual(want.coinbase, got.coinbase);
  });

  it('should inspect Coin', () => {
    const coin = new Coin();
    const fmt = nodejsUtil.format(coin);
    assert(typeof fmt === 'string');
    assert(fmt.includes('version'));
    assert(fmt.includes('height'));
    assert(fmt.includes('value'));
    assert(fmt.includes('address'));
    assert(fmt.includes('covenant'));
    assert(fmt.includes('coinbase'));
    assert(fmt.includes('hash'));
    assert(fmt.includes('index'));
  });
});
