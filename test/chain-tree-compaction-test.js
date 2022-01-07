'use strict';

const os = require('os');
const path = require('path');
const fs = require('bfile');
const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Miner = require('../lib/mining/miner');
const Chain = require('../lib/blockchain/chain');
const blockstore = require('../lib/blockstore');
const MemWallet = require('./util/memwallet');
const rules = require('../lib/covenants/rules');
const NameState = require('../lib/covenants/namestate');
const Address = require('../lib/primitives/address');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');

const network = Network.get('regtest');
const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

describe('Tree Compacting', function() {
    const oldKeepBlocks = network.block.keepBlocks;
    const oldpruneAfterHeight = network.block.pruneAfterHeight;

    before(async () => {
      // Copy the 1:8 ratio from mainnet
      network.block.keepBlocks = treeInterval * 8;

      // Ensure old blocks are pruned right away
      network.block.pruneAfterHeight = 1;
    });

    after(async () => {
      network.block.keepBlocks = oldKeepBlocks;
      network.block.pruneAfterHeight = oldpruneAfterHeight;
    });

  for (const prune of [true, false]) {
    describe(`Chain: ${prune ? 'Pruning' : 'Archival'}`, function() {
      const prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );
      const treePath = path.join(prefix, 'tree', '0000000001');

      const blocks = blockstore.create({
        prefix,
        network
      });

      const chain = new Chain({
        memory: false,
        prefix,
        blocks,
        network,
        prune
      });

      const miner = new Miner({chain});
      const cpu = miner.cpu;

      const wallet = new MemWallet({network});
      wallet.getNameStatus = async (nameHash) => {
        assert(Buffer.isBuffer(nameHash));
        const height = chain.height + 1;
        return chain.db.getNameStatus(nameHash, height);
      };

      const mempool = [];

      function send(mtx, mempool) {
        mempool.push(mtx.toTX());
      }

      async function mineBlocks(num, mempool = []) {
        const job = await cpu.createJob();
        while (mempool.length) {
          job.pushTX(mempool.pop());
        }
        job.refresh();
        const block = await job.mineAsync();
        const entry = await chain.add(block);
        wallet.addBlock(entry, block.txs);

        for (num--; num > 0; num--) {
          const job = await cpu.createJob();
          const block = await job.mineAsync();
          const entry = await chain.add(block);
          wallet.addBlock(entry, block.txs);
        }
      }
      let name, nameHash;
      const treeRoots = [];

      before(async () => {
        await blocks.ensure();
        await blocks.open();
        await chain.open();
        await miner.open();
      });

      after(async () => {
        await miner.close();
        await chain.close();
        await blocks.close();
        await fs.rimraf(prefix);
      });

      it('should throw if chain is too short to compact', async () => {
        await assert.rejects(
          chain.compactTree(),
          {message: 'Chain is too short to compact tree.'}
        );
      });

      it('should fund wallet', async () => {
        miner.addresses.length = 0;
        miner.addAddress(wallet.getReceive());
        await mineBlocks(100);
      });

      it('should win an auction and register', async () => {
        name = rules.grindName(3, chain.height, network);
        nameHash = rules.hashName(name);
        send(await wallet.sendOpen(name), mempool);
        await mineBlocks(treeInterval + 1, mempool);
        send(await wallet.sendBid(name, 10000, 10000), mempool);
        await mineBlocks(biddingPeriod, mempool);
        send(await wallet.sendReveal(name), mempool);
        await mineBlocks(revealPeriod, mempool);

        // Instead of using a version 0 serialized `Resource` with DNS data,
        // just register a single byte as a counter.
        send(await wallet.sendRegister(name, Buffer.from([0x00])), mempool);
        await mineBlocks(treeInterval, mempool);
      });

      it('should update Urkel Tree 20 times', async () => {
        let count = 0;
        chain.on('tree commit', (rootHash, entry, block) => {
          count++;
          // Keep track of all new tree root hashes.
          treeRoots.push(rootHash);
        });

        for (let i = 1; i <= 20; i++) {
          // Every namestate update, increment the name's 1-byte data resource.
          send(await wallet.sendUpdate(name, Buffer.from([i])), mempool);
          await mineBlocks(treeInterval, mempool);
        }

        assert.strictEqual(count, 20);

        const ns = await chain.db.getNameStateByName(name);
        assert.bufferEqual(ns.data, Buffer.from([20]));
      });

      it('should restore tree state from any historical root', async () => {
        for (let i = 0; i < treeRoots.length; i++) {
          // Restore old tree state using historical root hash.
          await chain.db.tree.inject(treeRoots[i]);

          // Get old namestate from old tree state.
          const raw = await chain.db.tree.get(nameHash);
          const ns = NameState.decode(raw);

          // Counter in the name's data resource should match.
          assert.bufferEqual(ns.data, Buffer.from([i + 1]));
        }
      });

      it('should compact tree', async () => {
        const before = await fs.stat(treePath);
        await chain.compactTree();
        const after = await fs.stat(treePath);

        // Urkel Tree should be smaller now.
        // Urkel Tree files are padded to ensure that Meta nodes are written
        // at predictable offsets so they can be quickly discovered
        // without indexing (Meta nodes point to the current tree root
        // node as well as the PREVIOUS Meta node). This makes it
        // really complicated to estimate exactly what the size of the file
        // should be before and after compacting.
        // The compacting process definitely should have deleted 12 of
        // the 20 recent tree namestate updates so we can make
        // sure that the data savings is at least that size. It should
        // also have deleted the OPEN, REVEAL and original REGISTER,
        // as well as tree updates written during the initial wallet funding.
        // One advantage we have is there is only one name in the tree,
        // so there are no internal nodes. In fact, the tree root node
        // is just our name's leaf node!
        const META_NODE_SIZE = 38;      // See urkel/radix/store.js
        const LEAF_NODE_SIZE = 40;      // See urkel/radix/nodes.js
        const NAMESTATE_DATA_SIZE = 53; // NameState.getSize();

        // First 100 blocks wrote a Meta node every tree interval
        const fundingWallet = (100 / treeInterval) * META_NODE_SIZE;

        const eachUpdate = (
          META_NODE_SIZE +
          LEAF_NODE_SIZE +
          NAMESTATE_DATA_SIZE
        );

        // Auction wrote a Meta node and namestate update every tree interval
        const auction = (
          (treeInterval + 1 + biddingPeriod + revealPeriod + treeInterval) /
          treeInterval
        ) * eachUpdate;

        const minReduction = fundingWallet + auction + (eachUpdate * 12);

        // The margin of error here is the padding.
        assert(before.size - after.size >= minReduction);

        // We also expect the compacted tree to be at least big enough
        // for the last 8 namestate updates. Padding makes precision difficult.
        assert(after.size >= (eachUpdate * 8));
      });

      it('should ONLY restore tree state from most recent roots', async () => {
        for (let i = 0; i < treeRoots.length; i++) {
          if (i < (treeRoots.length - 8)) {
            // Old root node has been deleted, tree state can not be restored.
            await assert.rejects(
              chain.db.tree.inject(treeRoots[i]),
              {message: `Missing node: ${treeRoots[i].toString('hex')}.`}
            );
            continue;
          }

          // Last 8 tree roots are recovered successfully like before compaction.
          await chain.db.tree.inject(treeRoots[i]);
          const raw = await chain.db.tree.get(nameHash);
          const ns = NameState.decode(raw);
          assert.bufferEqual(ns.data, Buffer.from([i + 1]));
        }
      });

      it('should compact tree a second time with no new data', async () => {
        // If user executes rpc compacttree repeatedly,
        // it shouldn't break anything.
        const before = await fs.stat(treePath);
        await chain.compactTree();
        const after = await fs.stat(treePath);

        // Should be no change
        assert.strictEqual(before.size, after.size);
      });

      it('should ONLY restore tree state from most recent roots', async () => {
        // Data recovery conditions are the same after second compacttree.
        for (let i = 0; i < treeRoots.length; i++) {
          if (i < (treeRoots.length - 8)) {
            // Old root node has been deleted, tree state can not be restored.
            await assert.rejects(
              chain.db.tree.inject(treeRoots[i]),
              {message: `Missing node: ${treeRoots[i].toString('hex')}.`}
            );
            continue;
          }

          // Last 8 tree roots are recovered successfully like before compaction.
          await chain.db.tree.inject(treeRoots[i]);
          const raw = await chain.db.tree.get(nameHash);
          const ns = NameState.decode(raw);
          assert.bufferEqual(ns.data, Buffer.from([i + 1]));
        }
      });

      it('should recover txn between tree intervals', async () => {
        // Get current counter value.
        let raw = await chain.db.tree.get(nameHash);
        let ns = NameState.decode(raw);
        let counter = ns.data[0];

        // Increment counter and commit one tree interval.
        send(await wallet.sendUpdate(name, Buffer.from([++counter])), mempool);
        await mineBlocks(treeInterval, mempool);

        // Tree and txn are synced due to tree commitment.
        assert.bufferEqual(chain.db.tree.rootHash(), chain.db.txn.rootHash());

        // Increment counter and confirm, but do not advance to tree interval.
        send(await wallet.sendUpdate(name, Buffer.from([++counter])), mempool);
        await mineBlocks(1, mempool);

        // The txn is updated, but the tree is still in last-committed state
        assert.notBufferEqual(chain.db.tree.rootHash(), chain.db.txn.rootHash());
        raw = await chain.db.txn.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter]));
        raw = await chain.db.tree.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter - 1]));

        // Save
        const txnRootBefore = chain.db.txn.rootHash();
        const treeRootBefore = chain.db.tree.rootHash();

        // Compact
        const before = await fs.stat(treePath);
        await chain.compactTree();
        const after = await fs.stat(treePath);
        assert(before.size > after.size);

        // Check
        assert.bufferEqual(txnRootBefore, chain.db.txn.rootHash());
        assert.bufferEqual(treeRootBefore, chain.db.tree.rootHash());
        assert.notBufferEqual(chain.db.tree.rootHash(), chain.db.txn.rootHash());
        raw = await chain.db.txn.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter]));
        raw = await chain.db.tree.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter - 1]));
      });

      it('should recover if aborted', async () => {
        // Get current counter value.
        let raw = await chain.db.tree.get(nameHash);
        let ns = NameState.decode(raw);
        const counter = ns.data[0];

        // Add 20 tree intervals
        for (let i = counter; i <= counter + 20; i++) {
          send(await wallet.sendUpdate(name, Buffer.from([i])), mempool);
          await mineBlocks(treeInterval, mempool);
        }

        const before = await fs.stat(treePath);

        // Rewind the tree 6 intervals and compact, but do not sync to tip yet.
        const entry = await chain.getEntry(chain.height - 6 * treeInterval);
        await chain.db.compactTree(entry.treeRoot);

        // Confirm tree state has been rewound
        assert.notBufferEqual(chain.db.tree.rootHash(), chain.tip.treeRoot);

        // Oops, we abort before calling chain.syncTree()
        await miner.close();
        await chain.close();
        await blocks.close();

        // Restart -- chainDB used to open tree with what it thought
        // was the latest tree state (saved in levelDB). If the actual
        // tree on disk was still 6 intervals behind, chain.open() would
        // fail with `Missing node` error. The updated logic relies on the
        // tree itself to find its own state (saved in Meta nodes) then
        // chain.syncTree() will catch it up from there to tip.
        await blocks.open();
        await chain.open();
        await miner.open();

        // Tree was compacted
        const after = await fs.stat(treePath);
        assert(before.size > after.size);

        // Tree was re-synced automatically to chain tip on restart
        assert.bufferEqual(chain.db.tree.rootHash(), chain.tip.treeRoot);
        raw = await chain.db.tree.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter + 20]));
      });

      it(`should ${prune ? '' : 'not '}have pruned chain`, async () => {
        // Sanity check. Everything worked on a chain that is indeed pruning.
        // Start at height 2 because pruneAfterHeight == 1
        for (let i = 2; i <= chain.height; i++) {
          const entry = await chain.getEntry(i);
          const block = await chain.getBlock(entry.hash);

          if (prune && i <= chain.height - network.block.keepBlocks)
            assert.strictEqual(block, null);
          else
            assert(block);
        }
      });
    });
  }

  describe('SPV', function() {
    it('should refuse to compact tree via RPC', async () => {
      const prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );

      const node = new SPVNode({
        prefix,
        network: 'regtest',
        memory: false
      });

      await node.ensure();
      await node.open();

      await assert.rejects(
        node.rpc.compactTree([]),
        {message: 'Cannot compact tree in SPV mode.'}
      );

      await node.close();
    });
  });

  describe('Full Node', function() {
    it('should throw if chain is too short to compact on launch', async () => {
      const prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );

      const node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false,
        compactTree: true
      });

      await node.ensure();

      await assert.rejects(
        node.open(),
        {message: 'Chain is too short to compact tree.'}
      );
    });

    it('should throw if chain is too short to compact via RPC', async () => {
      const prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );

      const node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false
      });

      await node.ensure();
      await node.open();

      await assert.rejects(
        node.rpc.compactTree([]),
        {message: 'Chain is too short to compact tree.'}
      );

      await node.close();
    });

    it('should compact tree on launch', async () => {
      const prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );
      const treePath = path.join(prefix, 'regtest', 'tree', '0000000001');

      // Fresh start
      let node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false
      });
      await node.ensure();
      await node.open();
      const fresh = await fs.stat(treePath);

      // Grow
      const waiter = new Promise((resolve) => {
        node.on('connect', (entry) => {
          if (entry.height >= 300)
            resolve();
        });
      });
      await node.rpc.generateToAddress(
        [300, new Address().toString('regtest')]
      );
      await waiter;

      // Tree has grown
      const grown = await fs.stat(treePath);
      assert(fresh.size < grown.size);

      // Relaunch with compaction argument
      await node.close();
      node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false,
        compactTree: true
      });
      await node.open();

      // Tree is compacted
      const compacted = await fs.stat(treePath);
      assert(compacted.size < grown.size);

      // Bonus: since there are no namestate updates in this test,
      // all the nodes committed to the tree during "growth" are identically
      // empty. When we compact, only the original empty node will remain.
      assert.strictEqual(fresh.size, compacted.size);

      // done
      await node.close();
    });
  });
});
