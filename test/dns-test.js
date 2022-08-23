'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const MemWallet = require('./util/memwallet');
const {Resource} = require('../lib/dns/resource');
const network = Network.get('regtest');
const {forValue} = require('./util/common');

const {Resolver} = require('dns').promises;

const rootResolver = new Resolver({timeout: 1000});
const recursiveResolver = new Resolver({timeout: 1000});
rootResolver.setServers([`127.0.0.1:${network.nsPort}`]);
recursiveResolver.setServers([`127.0.0.1:${network.rsPort}`]);

const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

describe('DNS Servers', function() {
  for (const spv of [false, true]) {
    describe(spv ? 'SPV Node' : 'Full Node', function() {
      const Node = spv ? SPVNode : FullNode;
      let node;

      describe('Server Configuration', function () {
        afterEach(async () => {
          await node.close();
        });

        it('should open full node with both DNS servers', async () => {
          node = new Node({
            memory: true,
            network: network.type
          });

          await node.open();
          const res1 = await rootResolver.resolveSoa('.');
          assert(res1);
          const res2 = await recursiveResolver.resolveSoa('.');
          assert(res2);
        });

        it('should open full node with neither DNS server', async () => {
          node = new Node({
            memory: true,
            network: network.type,
            noDns: true
          });

          await node.open();
          await assert.rejects(
            rootResolver.resolveSoa('.'),
            {message: 'querySoa ECONNREFUSED .'}
          );
          await assert.rejects(
            recursiveResolver.resolveSoa('.'),
            {message: 'querySoa ECONNREFUSED .'}
          );
        });

        it('should open full node only with root name server', async () => {
          node = new Node({
            memory: true,
            network: network.type,
            noRs: true
          });

          await node.open();
          const res1 = await rootResolver.resolveSoa('.');
          assert(res1);
          await assert.rejects(
            recursiveResolver.resolveSoa('.'),
            {message: 'querySoa ECONNREFUSED .'}
          );
        });
      });

      describe('HNS name resolution', function () {
        // Use a new full node for mining and auction
        // so full/spv test nodes do the same jobs.
        const miner = new FullNode({
          memory: true,
          network: network.type,
          listen: true,
          bip37: true,
          noDns: true
        });

        const wallet = new MemWallet({
          network: network.type
        });

        miner.chain.on('connect', (entry, block) => {
          wallet.addBlock(entry, block.txs);
        });

        const node = new Node({
          memory: true,
          network: network.type,
          only: ['127.0.0.1'],
          port: network.port + 100,
          brontidePort: network.brontidePort + 100,
          httpPort: network.rpcPort + 100
        });

        async function mineBlocks(n) {
          for (; n > 0; n--) {
            const block = await miner.miner.mineBlock();
            await miner.chain.add(block);
          }
          await forValue(node.chain, 'height', miner.chain.height);
        }

        let name;
        const string = 'Campaign of chaos';
        const resource = Resource.fromJSON({
          records: [{type: 'TXT', txt: [string]}]
        });

        before(async () => {
          await miner.open();
          await miner.connect();
          await node.open();
          await node.connect();
          node.startSync();

          await forValue(miner.pool.peers.list, 'size', 1);
          await forValue(node.pool.peers.list, 'size', 1);
        });

        after(async () => {
          await node.close();
          await miner.close();
        });

        it('should fund wallet and win name', async () => {
          miner.miner.addresses.length = 0;
          miner.miner.addAddress(wallet.getReceive());
          await mineBlocks(20);

          name = await miner.rpc.grindName([4]);
          await miner.mempool.addTX((await wallet.sendOpen(name)).toTX());
          await mineBlocks(treeInterval + 1);
          await miner.mempool.addTX((await wallet.sendBid(name, 10000, 10000)).toTX());
          await mineBlocks(biddingPeriod);
          await miner.mempool.addTX((await wallet.sendReveal(name)).toTX());
          await mineBlocks(revealPeriod);
        });

        it('should not resolve before register', async () => {
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt ENOTFOUND ${name}`}
          );
        });

        it('should not resolve immedeately after register', async () => {
          await miner.mempool.addTX(
            (await wallet.sendRegister(name, resource))
            .toTX()
          );
          await mineBlocks(1);

          // Sanity check
          const ns = await miner.chain.db.getNameStateByName(name);
          assert(ns);
          assert.bufferEqual(ns.data, resource.encode());

          node.ns.resetCache();
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt ENOTFOUND ${name}`}
          );
        });

        it('should not resolve immedeately after tree commit', async () => {
          let commitRoot, commitEntry;
          miner.chain.on('tree commit', (root, entry) => {
            commitRoot = root;
            commitEntry = entry;
          });
          const n = treeInterval - (miner.chain.height % treeInterval);
          await mineBlocks(n);

          assert.deepStrictEqual(commitEntry, miner.chain.tip);
          assert.notBufferEqual(commitRoot, miner.chain.tip.treeRoot);

          node.ns.resetCache();
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt ENOTFOUND ${name}`}
          );

          // One more block to commit tree root to block header
          await mineBlocks(1);
          assert.bufferEqual(commitRoot, miner.chain.tip.treeRoot);

          // Still no.
          node.ns.resetCache();
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt ENOTFOUND ${name}`}
          );
        });

        it('should resolve at safe height', async () => {
          await mineBlocks(2);

          assert.strictEqual(
            miner.chain.height % network.names.treeInterval,
            network.names.safeRoot
          );

          node.ns.resetCache();
          const res = await rootResolver.resolveTxt(name);
          assert.strictEqual(res[0][0], string);
        });
      });
    });
  }
});
