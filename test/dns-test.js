'use strict';

const assert = require('bsert');
const {hashName} = require('../lib/covenants/rules');
const NameState = require('../lib/covenants/namestate');
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
  revealPeriod,
  safeRoot
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
            // force ten minute block intervals
            node.network.time.offset += 60 * 10;
            const block = await miner.miner.mineBlock();
            await miner.chain.add(block);
          }
          await forValue(node.chain, 'height', miner.chain.height);
        }

        let name, nameHash, serial;
        const string = 'Campaign of chaos';
        const resource = Resource.fromJSON({
          records: [{type: 'TXT', txt: [string]}]
        });
        const maxTipAge = network.block.maxTipAge;

        before(async () => {
          network.block.maxTipAge = 12 * 60 * 60;
          await miner.open();
          await miner.connect();
          await node.open();
          await node.connect();
          node.startSync();

          await forValue(miner.pool.peers.list, 'size', 1);
          await forValue(node.pool.peers.list, 'size', 1);

          name = await miner.rpc.grindName([4]);
          nameHash = hashName(name);

          miner.miner.addresses.length = 0;
          miner.miner.addAddress(wallet.getReceive());
        });

        after(async () => {
          await node.close();
          await miner.close();
          network.block.maxTipAge = maxTipAge;
        });

        it('should refuse to resolve before chain sync', async () => {
          assert.strictEqual(node.chain.getProgress(), 0);
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt EREFUSED ${name}`}
          );
        });

        it('should resolve root SOA before chain sync', async () => {
          const res = await rootResolver.resolveSoa('.');
          // null UNIX timestamp because there is no safe root yet
          assert.strictEqual(res.serial, 1970010100);
        });

        it('should still refuse to resolve after chain sync', async () => {
          // On mainnet, a synced chain would have a safe root,
          // but on regtest we are "synced" after the first block,
          // which is not enough confirmations yet to resolve.
          await mineBlocks(2);
          assert.strictEqual(node.chain.getProgress(), 1);
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt EREFUSED ${name}`}
          );
        });

        it('should not refuse to resolve after safe height', async () => {
          await mineBlocks(node.chain.height % treeInterval);
          await assert.rejects(
            rootResolver.resolveTxt(name),
            {message: `queryTxt ENOTFOUND ${name}`}
          );
        });

        it('should resolve root SOA after safe height', async () => {
          node.ns.resetCache();
          const res = await rootResolver.resolveSoa('.');
          // Block #1 timestamp because the latest tree commitment
          // hasn't been confirmed enough times yet, so we drop back
          // to the previous tree root commitment, which is genesis (#0),
          // but new roots don't appear in headers until the next block.
          const {time} = await miner.chain.getEntryByHeight(1);
          const date = new Date(time * 1000);
          const y = date.getUTCFullYear() * 1e6;
          const m = (date.getUTCMonth() + 1) * 1e4;
          const d = date.getUTCDate() * 1e2;
          const h = date.getUTCHours();
          const expected = y + m + d + h;
          assert.strictEqual(res.serial, expected);
          serial = res.serial;
        });

        it('should update SOA serial when tree interval is safe', async () => {
          const startHeight = node.chain.height;
          let newSerial = serial;
          while (newSerial === serial) {
            await mineBlocks(1);
            node.ns.resetCache();
            const res = await rootResolver.resolveSoa('.');
            newSerial = res.serial;
          }
          const endHeight = node.chain.height;
          assert(endHeight > startHeight);
          assert.strictEqual(
            endHeight % treeInterval,
            safeRoot
          );
        });

        it('should refuse to resolve invalid name', async () => {
          await assert.rejects(
            rootResolver.resolveTxt('com\\\\000'),
            {message: 'queryTxt EREFUSED com\\\\000'}
          );
        });

        it('should not refuse to resolve valid name', async () => {
          await assert.rejects(
            rootResolver.resolveTxt('com\\000'),
            {message: 'queryTxt ENOTFOUND com\\000'}
          );
        });

        it('should fund wallet and win name', async () => {
          await mineBlocks(19);

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

          // Sanity check: name is registered
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

          // Sanity check: name is in tree
          const raw = await miner.chain.db.lookup(commitRoot, nameHash);
          const {data} = NameState.decode(raw);
          assert.bufferEqual(data, resource.encode());
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
