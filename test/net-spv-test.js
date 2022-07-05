'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const ChainEntry = require('../lib/blockchain/chainentry');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const rules = require('../lib/covenants/rules');
const NameState = require('../lib/covenants/namestate');
const {Resource} = require('../lib/dns/resource');
const {types: packetTypes} = require('../lib/net/packets');
const {types: urkelTypes} = require('urkel').Proof;
const {forValue} = require('./util/common');

const network = Network.get('regtest');
const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;
const SAFE_ROOT = 12;

describe('SPV', function() {
  describe('Name Resource Lookup', function() {
    const full = new FullNode({
      network: 'regtest',
      listen: true,
      bip37: true,
      noDns: true,
      plugins: [require('../lib/wallet/plugin')]
    });

    const spv = new SPVNode({
      network: 'regtest',
      only: '127.0.0.1',
      port: 10000,
      brontidePort: 20000,
      httpPort: 30000
    });

    const {wdb} = full.require('walletdb');
    let wallet, addr;
    const name = 'sad';
    const nameHash = rules.hashName(name);

    before(async () => {
      await full.open();
      await spv.open();
      wallet = await wdb.get('primary');
    });

    after(async () => {
      await spv.close();
      await full.close();
    });

    async function mineBlocks(n) {
      for (; n > 0; n--) {
        const block = await full.miner.mineBlock(null, addr);
        await full.chain.add(block);
      }
    }

    // Create a chain of block headers and add directly to SPV node.
    // Change the tree root in the headers to something random
    // at every expected treeInterval + 1. This simulates the SPV node
    // experiencing a chain split away from the full node, and it will try to
    // request name proofs with tree roots the full node will not recognize.
    // The full node state remains unaffected.
    async function mineSPVFork(n, tip) {
      let treeRoot = tip.treeRoot;
      for (; n > 0; n--) {
        const job = await full.miner.createJob(tip, addr);
        if (job.attempt.height % treeInterval === 1) {
          treeRoot = random.randomBytes(32);
        }
        job.attempt.treeRoot = treeRoot;;
        const block = await full.miner.cpu.mineAsync(job);
        await spv.chain.add(block);
        tip = ChainEntry.fromBlock(block);
      }
    }

    it('should connect nodes', async () => {
      const waiter = new Promise((res, rej) => {
        full.pool.on('connection', () => res());
      });
      await full.connect();
      await spv.connect();
      await spv.startSync();
      await waiter;
      assert.strictEqual(spv.pool.peers.outbound, 1);
      assert.strictEqual(full.pool.peers.inbound, 1);
    });

    it('should generate blocks', async () => {
      addr = await wallet.receiveAddress(0);
      await mineBlocks(10);
      await forValue(spv.chain, 'height', 10);
      assert.strictEqual(full.chain.height, spv.chain.height);
    });

    it('should get proof of nonexistence from empty tree', async () => {
      const waiter = new Promise((res, rej) => {
        spv.pool.once('packet', (packet) => {
          if (packet.type === packetTypes.PROOF)
            res(packet.proof.type);
        });
      });

      const ns = await spv.pool.resolve(Buffer.alloc(32, 0xab));
      assert.strictEqual(ns, null);
      const proofType = await waiter;
      assert.strictEqual(proofType, urkelTypes.TYPE_DEADEND);
    });

    it('should run auction and register name', async () => {
      await wallet.sendOpen(name, false);
      await mineBlocks(treeInterval + 1);
      await wallet.sendBid(name, 10000, 10000);
      await mineBlocks(biddingPeriod);
      await wallet.sendReveal(name);
      await mineBlocks(revealPeriod);
      await wallet.sendUpdate(
        name,
        Resource.fromJSON(
          {
            records: [
              {type: 'NS', ns: 'one.'}
            ]
          }
        )
      );
      await mineBlocks(treeInterval + SAFE_ROOT);
    });

    it('should get proof of nonexistence from filled tree', async () => {
      const waiter = new Promise((res, rej) => {
        spv.pool.once('packet', (packet) => {
          if (packet.type === packetTypes.PROOF)
            res(packet.proof.type);
        });
      });

      const ns = await spv.pool.resolve(Buffer.alloc(32, 0xab));
      assert.strictEqual(ns, null);
      const proofType = await waiter;
      assert.strictEqual(proofType, urkelTypes.TYPE_COLLISION);
    });

    it('should get proof of existence with data', async () => {
      const waiter = new Promise((res, rej) => {
        spv.pool.once('packet', (packet) => {
          if (packet.type === packetTypes.PROOF)
            res(packet.proof.type);
        });
      });

      const raw = await spv.pool.resolve(nameHash);
      const ns = NameState.decode(raw);
      const res = Resource.decode(ns.data);
      assert.strictEqual(res.records[0].ns, 'one.');
      const proofType = await waiter;
      assert.strictEqual(proofType, urkelTypes.TYPE_EXISTS);
    });

    it('should update name data', async () => {
      await wallet.sendUpdate(
        name,
        Resource.fromJSON(
          {
            records: [
              {type: 'NS', ns: 'two.'}
            ]
          }
        )
      );
      await mineBlocks(treeInterval + SAFE_ROOT);
    });

    it('should get updated data', async () => {
      const waiter = new Promise((res, rej) => {
        spv.pool.once('packet', (packet) => {
          if (packet.type === packetTypes.PROOF)
            res(packet.proof.type);
        });
      });

      const raw = await spv.pool.resolve(nameHash);
      const ns = NameState.decode(raw);
      const res = Resource.decode(ns.data);
      assert.strictEqual(res.records[0].ns, 'two.');
      const proofType = await waiter;
      assert.strictEqual(proofType, urkelTypes.TYPE_EXISTS);
    });

    it('should get historical data', async () => {
      // Send the SPV node back in time
      const height = full.chain.height - treeInterval - SAFE_ROOT;
      const entry = await full.chain.getEntry(height);
      await spv.chain.invalidate(entry.hash);

      assert(full.chain.height > spv.chain.height);

      // Get old data
      const waiter1 = new Promise((res, rej) => {
        spv.pool.once('packet', (packet) => {
          if (packet.type === packetTypes.PROOF)
            res(packet.proof.type);
        });
      });

      const raw = await spv.pool.resolve(nameHash);
      const ns = NameState.decode(raw);
      const res = Resource.decode(ns.data);
      assert.strictEqual(res.records[0].ns, 'one.');
      const proofType = await waiter1;
      assert.strictEqual(proofType, urkelTypes.TYPE_EXISTS);

      await spv.chain.removeInvalid(entry.hash);
      await forValue(spv.chain, 'height', full.chain.height);
      assert.strictEqual(full.chain.height, spv.chain.height);
    });

    it('should resync multiple times', async () => {
      const resetHeight = 1;
      const fullNodeHeight = full.chain.height;

      // Rescan once
      await spv.chain.reset(resetHeight);
      await forValue(spv.chain, 'height', fullNodeHeight);
      assert(spv.chain.height === fullNodeHeight);

      // Rescan again
      await spv.chain.reset(resetHeight);
      await forValue(spv.chain, 'height', fullNodeHeight);
      assert(spv.chain.height === fullNodeHeight);
    });

    it('should request name data with unknown tree root', async () => {
      // SPV node teleports to a parallel dimension
      await mineSPVFork(100, full.chain.tip);

      // Get the SPV node peer from the full node's perspective
      const peer = full.pool.peers.head();
      let err;
      peer.on('error', e => err = e);

      // SPV node tries to make request and gets disconnected instantly
      await assert.rejects(
        spv.pool.resolve(nameHash),
        {
          message: 'Peer removed.'
        }
      );

      // This is the error thrown by the full node trying to serve the proof.
      assert(err);
      assert.strictEqual(err.code, 'ERR_MISSING_NODE');

      // :-(
      assert.strictEqual(spv.pool.peers.outbound, 0);
      assert.strictEqual(full.pool.peers.inbound, 0);
    });
  });
});
