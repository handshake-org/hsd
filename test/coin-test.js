/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const Coin = require('../lib/primitives/coin');
const assert = require('bsert');
const common = require('../test/util/common');
const KeyRing = require('../lib/primitives/keyring');
const random = require('bcrypto/lib/random');
const rules = require('../lib/covenants/rules');
const {types, typesByVal} = rules;
const {BufferWriter} = require('bufio');

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

      const coin = Coin.fromJSON(json, network);
      const bw = new BufferWriter(coin.getSize());
      coin.write(bw);

      const coin2 = Coin.fromRaw(bw.render());
      const json2 = coin2.getJSON(network);

      for (const [key, value] of Object.entries(json)) {
        assert.deepEqual(value, json2[key]);
      }
    }
  });
});
