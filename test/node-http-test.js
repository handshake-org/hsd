/*!
 * test/node-http-test.js - test for wallet http endoints
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('bsert');
const {NodeClient} = require('hs-client');

const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const Mnemonic = require('../lib/hd/mnemonic');
const HDPrivateKey = require('../lib/hd/private');
const common = require('./util/common');
const mnemonics = require('./data/mnemonic-english.json');
// Commonly used test mnemonic
const phrase = mnemonics[0][1];

const network = Network.get('regtest');

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true
});

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

let cbAddress;

const {
  treeInterval
} = network.names;

describe('Node HTTP', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();

    const mnemonic = Mnemonic.fromPhrase(phrase);
    const priv = HDPrivateKey.fromMnemonic(mnemonic);
    const type = network.keyPrefix.coinType;
    const key = priv.derive(44, true).derive(type, true).derive(0, true);
    const xpub = key.toPublic();
    const pubkey = xpub.derive(0).derive(0).publicKey;

    cbAddress = Address.fromPubkey(pubkey).toString(network.type);
  });

  after(async () => {
    await nclient.close();
    await node.close();
  });

  describe('get info', function () {
    it('should set intervals properly at height 0', async () => {
      const info = await nclient.getInfo();
      assert.equal(info.chain.height, 0);
      assert.equal(info.chain.nextTreeRootHeight, treeInterval);
      assert.equal(info.chain.blocksUntilNextTreeRoot, treeInterval);
    });

    it('should test for off by one errors with the intervals', async () => {
      await mineBlocks(treeInterval - 1, cbAddress);

      {
        const info = await nclient.getInfo();
        assert.equal(info.chain.height, treeInterval - 1);
        assert.equal(info.chain.nextTreeRootHeight, treeInterval);
      }

      await mineBlocks(1, cbAddress);

      {
        const info = await nclient.getInfo();
        assert.equal(info.chain.height, treeInterval);
        assert.equal(info.chain.nextTreeRootHeight, info.chain.height + treeInterval);
        assert.equal(info.chain.blocksUntilNextTreeRoot, treeInterval);
      }
    });
  });
});

// take into account race conditions
async function mineBlocks(count, address) {
  for (let i = 0; i < count; i++) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await common.forValue(obj, 'complete', true);
  }
}
