/* eslint-env mocha */
/* eslint prefer-arrow-callback: 'off' */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
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
  this.timeout(15000);
  let NAME0, NAME1;
  let node, miner, chain;

  const mineBlocks = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const block = await miner.mineBlock();
      await chain.add(block);
    }
    await common.sleep(100);
  };

  beforeEach(async () => {
    assert.equal(network.names.auctionStart, 0);
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
  });

  afterEach(async () => {
    await node.close();
  });

  describe('getNameInfo', () => {
    describe('For names that are available at height 0', () => {
      it('It should return null when there hasn\'t been an auction initiated', async () => {
        const nameInfo = await nclient.get(`/info/name/${NAME0}`);
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
        const nameInfo = await nclient.get(`/info/name/${NAME0}`);
        assert.deepEqual(nameInfo, {
          info: null,
          start: {
            reserved: false,
            start: 0,
            week: 0
          }
        });
        await mineBlocks(10);
        const open = await wclient.execute('sendopen', [NAME0]);
        assert(open);
      });
      it('It should start an auction on the 2nd day', async () => {
        await mineBlocks(40);
        const nameInfo = await nclient.get(`/info/name/${NAME0}`);
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
        const nameInfoBefore = await nclient.get(`/info/name/${NAME0}`);
        assert.equal(nameInfoBefore.info, null);
        await mineBlocks(1);
        const nameInfoAfter = await nclient.get(`/info/name/${NAME0}`);
        assert.equal(nameInfoAfter.info.name, NAME0);
        assert.equal(nameInfoAfter.info.state, 'OPENING');
      });
    });

    describe('For names that are available at height 20', () => {
      it('It should getNameInfo for an opening name', async () => {
        await mineBlocks(20);
        await wclient.execute('sendopen', [NAME1]);
        await mineBlocks(1);
        const nameInfo = await nclient.get(`/info/name/${NAME1}`);
        assert(nameInfo.start.start < 20);
        assert.equal(nameInfo.start.reserved, false);
        assert.equal(nameInfo.info.state, 'OPENING');
      });
    });
  });

  describe('getNameByHash', () => {
    it('It should return null when an auction has not been initiated', async () => {
      const nameHash = rules.hashName(NAME0);
      const name = await nclient.get(`/name/hash/${nameHash.toString('hex')}`);
      assert.equal(name, null);
    });

    describe('When an auction has been initiated', () => {
      it('It should return the name', async () => {
        await mineBlocks(250);
        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1);
        const nameHash = rules.hashName(NAME0);
        const { name } = await nclient.get(`/name/hash/${nameHash.toString('hex')}`);
        assert.equal(name, NAME0);
      });
    });
  });

  describe('getNameResource', () => {
    const records = { compat: false, version: 0, ttl: 172800, ns: ['ns1.example.com.@1.2.3.4'] };
    it('It should return null when an auction has not been initiated', async () => {
      const resource = await nclient.get(`/resource/name/${NAME0}`);
      assert.equal(resource, null);
    });

    describe('When an auction has been initiated', () => {
      it('It should return the resource', async () => {
        await mineBlocks(250);
        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1);
        const { stats: { blocksUntilBidding } } = await wclient.execute('getauctioninfo', [NAME0]);
        await mineBlocks(blocksUntilBidding);
        const sendBid = await wclient.execute('sendbid', [NAME0, 12, 12]);
        assert(sendBid);
        const { stats: { blocksUntilReveal } } = await wclient.execute('getauctioninfo', [NAME0]);
        await mineBlocks(blocksUntilReveal);
        await wclient.execute('sendreveal', [NAME0]);
        const { stats: { blocksUntilClose } } = await wclient.execute('getauctioninfo', [NAME0]);
        await mineBlocks(blocksUntilClose);
        await wclient.execute('sendupdate', [NAME0, records]);
        await mineBlocks(1);
        const resource = await nclient.get(`/resource/name/${NAME0}`);
        assert.deepEqual(resource, records);
      });
    });
  });

  describe('getNameProof', () => {
    it('It should return null when an auction has not been initiated', async () => {
      const proof = await nclient.get(`/proof/name/${NAME0}`);
      assert.equal(proof.proof.type, 'TYPE_DEADEND');
      assert.equal(proof.name, NAME0);
    });

    describe('When an auction has been initiated', () => {
      it('It should return the name\'s proof', async () => {
        await mineBlocks(250);
        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1);
        const { stats: { blocksUntilBidding } } = await wclient.execute('getauctioninfo', [NAME0]);
        await mineBlocks(blocksUntilBidding);
        const sendBid = await wclient.execute('sendbid', [NAME0, 12, 12]);
        assert(sendBid);
        const { stats: { blocksUntilReveal } } = await wclient.execute('getauctioninfo', [NAME0]);
        await mineBlocks(blocksUntilReveal);
        await wclient.execute('sendreveal', [NAME0]);
        const { stats: { blocksUntilClose } } = await wclient.execute('getauctioninfo', [NAME0]);
        await mineBlocks(blocksUntilClose);
        await wclient.execute('sendupdate', [NAME0, { compat: false, version: 0, ttl: 172800, ns: ['ns1.example.com.@1.2.3.4'] }]);
        await mineBlocks(1);
        const proof = await nclient.get(`/proof/name/${NAME0}`);
        assert.equal(proof.proof.type, 'TYPE_EXISTS');
        assert.equal(proof.name, NAME0);
      });
    });
  });
  describe('grindName', () => {
    it('It should grind a name', async () => {
      const size = 10;
      const { name } = await nclient.get('/grind', { size });
      assert(name);
      assert.equal(name.length, size);
      assert(rules.verifyName(name));
    });
  });
});
