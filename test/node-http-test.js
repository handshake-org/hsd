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

const wallet = wclient.wallet('primary');

describe('Node http', function() {
  this.timeout(10000);
  const witnessedBlocks = {};
  let NAME0, NAME1;
  let node, mineBlocks, cbAddress;

  beforeEach(async () => {
    assert.equal(network.names.auctionStart, 0);

    node = new FullNode({
      memory: true,
      apiKey: 'foo',
      network: 'regtest',
      workers: true,
      plugins: [require('../lib/wallet/plugin')]
    });

    node.on('connect', (entry, block) => {
      const blockHash = block.hash().toString('hex');
      witnessedBlocks[blockHash] = blockHash;
    });

    mineBlocks = common.constructBlockMiner(node, nclient);
    NAME0 = await rules.grindName(10, 0, network);
    NAME1 = await rules.grindName(10, 20, network);

    await node.open();

    cbAddress = (await wallet.createAddress('default')).address;

    await mineBlocks(network.names.auctionStart, cbAddress);
  });

  afterEach(async () => {
    await node.close();
  });

  describe('getNameInfo', () => {
    describe('For names that are available at height 0', () => {
      it('It should return null when there hasn\'t been an auction initiated', async () => {
        const nameInfo = await nclient.get(`/name/${NAME0}`);
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
        const nameInfo = await nclient.get(`/name/${NAME0}`);
        assert.deepEqual(nameInfo, {
          info: null,
          start: {
            reserved: false,
            start: 0,
            week: 0
          }
        });

        await mineBlocks(10, cbAddress);

        const open = await wclient.execute('sendopen', [NAME0]);
        assert(open);
      });
      it('It should start an auction on the 2nd day', async () => {
        await mineBlocks(40, cbAddress);

        const nameInfo = await nclient.get(`/name/${NAME0}`);
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

        const nameInfoBefore = await nclient.get(`/name/${NAME0}`);
        assert.equal(nameInfoBefore.info, null);
        await mineBlocks(1, cbAddress);

        const nameInfoAfter = await nclient.get(`/name/${NAME0}`);
        assert.equal(nameInfoAfter.info.name, NAME0);
        assert.equal(nameInfoAfter.info.state, 'OPENING');
      });
    });

    describe('For names that are available at height 20', () => {
      it('It should getNameInfo for an opening name', async () => {
        await mineBlocks(20, cbAddress);

        await wclient.execute('sendopen', [NAME1]);
        await mineBlocks(1, cbAddress);

        const nameInfo = await nclient.get(`/name/${NAME1}`);
        assert(nameInfo.start.start < 20);
        assert.equal(nameInfo.start.reserved, false);
        assert.equal(nameInfo.info.state, 'OPENING');
      });
    });
  });

  describe('getNameByHash', () => {
    it('It should return null when an auction has not been initiated', async () => {
      const nameHash = rules.hashName(NAME0);
      const name = await nclient.get(`/resource/hash/${nameHash.toString('hex')}`);
      assert.equal(name, null);
    });

    describe('When an auction has been initiated', () => {
      it('It should return the name', async () => {
        await mineBlocks(10, cbAddress);

        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1, cbAddress);

        const nameHash = rules.hashName(NAME0);
        const { name } = await nclient.get(`/resource/hash/${nameHash.toString('hex')}`);
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
        await mineBlocks(10, cbAddress);

        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1, cbAddress);

        const { stats: { blocksUntilBidding } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilBidding, cbAddress);

        const sendBid = await wclient.execute('sendbid', [NAME0, 12, 12]);
        assert(sendBid);

        const { stats: { blocksUntilReveal } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilReveal, cbAddress);

        await wclient.execute('sendreveal', [NAME0]);
        const { stats: { blocksUntilClose } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilClose, cbAddress);

        await wclient.execute('sendupdate', [NAME0, records]);
        await mineBlocks(1, cbAddress);

        const resource = await nclient.get(`/resource/name/${NAME0}`);
        assert.deepEqual(resource, Object.assign(records, { name: NAME0, version: 0 }));
      });
    });
  });

  describe('getNameProof', () => {
    it('It should return a proof type of TYPE_DEADEND when an auction has not been initiated', async () => {
      const proof = await nclient.get(`/proof/name/${NAME0}`);
      assert.equal(proof.type, 'TYPE_DEADEND');
      assert.equal(proof.name, NAME0);
    });

    describe('When an auction has been initiated', () => {
      it('It should return the name\'s proof', async () => {
        const record = { compat: false, version: 0, ttl: 172800, ns: ['ns1.example.com.@1.2.3.4'] };
        await mineBlocks(10, cbAddress);

        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1, cbAddress);

        const { stats: { blocksUntilBidding } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilBidding, cbAddress);

        const sendBid = await wclient.execute('sendbid', [NAME0, 12, 12]);
        assert(sendBid);
        const { stats: { blocksUntilReveal } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilReveal, cbAddress);

        await wclient.execute('sendreveal', [NAME0]);
        const { stats: { blocksUntilClose } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilClose, cbAddress);

        await wclient.execute('sendupdate', [NAME0, record]);
        await mineBlocks(1, cbAddress);

        const proof = await nclient.get(`/proof/name/${NAME0}`);
        assert.equal(proof.type, 'TYPE_EXISTS');
        assert.equal(proof.name, NAME0);
      });
    });
  });

  describe('getNameProofByHash', () => {
    it('It should return a proof type of TYPE_DEADEND when an auction has not been initiated', async () => {
      const nameHash = rules.hashName(NAME0).toString('hex');
      const proof = await nclient.get(`/proof/hash/${nameHash}`);
      assert.equal(proof.type, 'TYPE_DEADEND');
      assert.equal(proof.name, null);
    });

    describe('When an auction has been initiated', () => {
      it('It should return the name\'s proof', async () => {
        const record = { compat: false, version: 0, ttl: 172800, ns: ['ns1.example.com.@1.2.3.4'] };
        await mineBlocks(10, cbAddress);

        await wclient.execute('sendopen', [NAME0]);
        await mineBlocks(1, cbAddress);

        const { stats: { blocksUntilBidding } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilBidding, cbAddress);

        const sendBid = await wclient.execute('sendbid', [NAME0, 12, 12]);
        assert(sendBid);
        const { stats: { blocksUntilReveal } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilReveal, cbAddress);

        await wclient.execute('sendreveal', [NAME0]);
        const { stats: { blocksUntilClose } } = await wclient.execute('getauctioninfo', [NAME0]);

        await mineBlocks(blocksUntilClose, cbAddress);

        await wclient.execute('sendupdate', [NAME0, record]);
        await mineBlocks(1, cbAddress);

        const nameHash = rules.hashName(NAME0).toString('hex');
        const proof = await nclient.get(`/proof/hash/${nameHash}`);
        assert.equal(proof.type, 'TYPE_EXISTS');
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
