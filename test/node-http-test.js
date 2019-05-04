/* eslint-env mocha */
/* eslint prefer-arrow-callback: 'off' */

'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const Opcode = require('../lib/script/opcode');
const FullNode = require('../lib/node/fullnode');
const Wallet = require('../lib/wallet/wallet');
const MTX = require('../lib/primitives/mtx');
const TX = require('../lib/primitives/tx');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const network = Network.get('regtest');

const { NodeClient, WalletClient } = require('hs-client');

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

describe('Node http', function() {
  this.timeout(5000);
  let NAME0;
  let node;
  let miner;
  let chain;
  let NAME1;

  const mineBlocks = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const block = await miner.mineBlock();
      await chain.add(block);
    }
  };

  beforeEach(async () => {
    node = new FullNode({
      memory: true,
      apiKey: 'foo',
      network: 'regtest',
      workers: true,
      plugins: [require('../lib/wallet/plugin')]
    });
    miner = node.miner;
    chain = node.chain;
    NAME0 = await rules.grindName(10, 0, network);
    NAME1 = await rules.grindName(10, 20, network);
    await node.open();
    await mineBlocks(network.names.auctionStart);
    assert.equal(network.names.auctionStart, 0);
    await mineBlocks(1);
  });

  afterEach(async () => {
    await node.close();
  });

  describe('getNameInfo', () => {
    describe('For names that are available at height 0', () => {
      it('It should return null when there hasn\'t been an auction initiated', async () => {
        const nameInfo = await nclient.getNameInfo(NAME0);
        assert.deepEqual(nameInfo, {
          info: null,
            start: {
              reserved: false,
              start: 0,
              week: 0
            }
        });
      });
      it('It should start an auction on the first day', async () => {
        await mineBlocks(1);
        const nameInfo = await nclient.getNameInfo(NAME0);
        assert.deepEqual(nameInfo, {
          info: null,
            start: {
              reserved: false,
              start: 0,
              week: 0
            }
        });
        const open = await wclient.execute('sendopen', [NAME0]);
        assert(open);
      });
      it('It should start an auction on the 2nd day', async () => {
        // Question: This test passes non-deterministically. Why?
        // Note: Keeping this test as proof that the behavior of grindName
        // isnt working as one would expect.
        await mineBlocks(175); // Note: This number seems to pass consistently. \o.o/
        const nameInfo = await nclient.getNameInfo(NAME0);
        assert.deepEqual(nameInfo, {
          info: null,
            start: {
              reserved: false,
              start: 0,
              week: 0
            }
        });
        const open = await wclient.execute('sendopen', [NAME0]);
        assert(open);
        const nameInfoBefore = await nclient.getNameInfo(NAME0);
        assert.equal(nameInfoBefore.info, null);
        await mineBlocks(1);
        const nameInfoAfter = await nclient.getNameInfo(NAME0);
        assert.equal(nameInfoAfter.info.name, NAME0);
        assert.equal(nameInfoAfter.info.state, 'OPENING');
      });
    });

    describe('For names that are available at height 20', () => {
      it('It should getNameInfo for an opening name', async () => {
        await mineBlocks(20);
        await wclient.execute('sendopen', [NAME1]);
        await mineBlocks(1);
        const nameInfo = await nclient.getNameInfo(NAME1);
        assert(nameInfo.start.start < 20);
        assert.equal(nameInfo.start.reserved, false);
        assert.equal(nameInfo.info.state, 'OPENING');
      });
    });
  });

  describe('getNameByHash', () => {
    it('It should return null when an auction has not been initiated', async () => {
      const nameHash = rules.hashName(NAME0);
      const name = await nclient.getNameByHash(nameHash.toString('hex'));
      assert.equal(name, null);
    });

    describe('When an auction has been initiated', () => {
      beforeEach(async () => {
        await mineBlocks(250);
        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1);
      });
      it('It should return the name', async () => {
        const nameHash = rules.hashName(NAME0);
        const { name } = await nclient.getNameByHash(nameHash.toString('hex'));
        assert.equal(name, NAME0);
      });
    });
  });
});
