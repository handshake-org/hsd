'use strict';

const os = require('os');
const path = require('path');
const fs = require('bfile');
const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
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
const {forEventCondition, forEvent} = require('./util/common');

const network = Network.get('regtest');
const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

const GNAME_SIZE = 10;

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
      const treePath = path.join(prefix, 'tree');
      const treePart1 = path.join(prefix, 'tree', '0000000001');

      // This is the chain we are testing,
      // we are going to compact its tree
      // and try to corrupt its database.
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

      // This second, in-memory chain is our control.
      // Every block we add to the test chain will also
      // be added to the memChain so we can check for consensus
      // failures or other inconsistencies caused by tree compacting.
      const memBlocks = blockstore.create({
        memory: true,
        network
      });
      const memChain = new Chain({
        memory: true,
        blocks: memBlocks,
        network
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
        assert(await memChain.add(block));
        wallet.addBlock(entry, block.txs);

        for (num--; num > 0; num--) {
          const job = await cpu.createJob();
          const block = await job.mineAsync();
          const entry = await chain.add(block);
          assert(await memChain.add(block));
          wallet.addBlock(entry, block.txs);
        }
      }

      let name, nameHash, listener;
      let treeRoots = [];

      const checkTree = async (compacted = false) => {
        for (const [index, hash] of treeRoots.entries()) {
          if (compacted && index < (treeRoots.length - 8)) {
            // Old root node has been deleted, tree state can not be restored.
            await assert.rejects(
              chain.db.tree.inject(hash),
              {message: `Missing node: ${hash.toString('hex')}.`}
            );
            continue;
          }

          // Last 8 tree roots are recovered successfully like before compaction.
          await chain.db.tree.inject(hash);
          const raw = await chain.db.tree.get(nameHash);
          const ns = NameState.decode(raw);
          assert.bufferEqual(ns.data, Buffer.from([index + 1]));
        }
      };

      before(async () => {
        await blocks.ensure();
        await blocks.open();
        await chain.open();
        await miner.open();

        listener = (root) => {
          if (root.equals(consensus.ZERO_HASH))
            return;

          treeRoots.push(root);
        };

        chain.on('tree commit', listener);

        await memBlocks.open();
        await memChain.open();
      });

      after(async () => {
        await miner.close();
        await chain.close();
        await blocks.close();
        await fs.rimraf(prefix);

        chain.removeListener('tree commit', listener);

        await memChain.close();
        await memBlocks.close();
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
        name = rules.grindName(GNAME_SIZE, chain.height, network);
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
        treeRoots = [];

        for (let i = 1; i <= 20; i++) {
          // Every namestate update, increment the name's 1-byte data resource.
          send(await wallet.sendUpdate(name, Buffer.from([i])), mempool);
          await mineBlocks(treeInterval, mempool);
        }

        assert.strictEqual(treeRoots.length, 20);

        const ns = await chain.db.getNameStateByName(name);
        assert.bufferEqual(ns.data, Buffer.from([20]));
      });

      it('should restore tree state from any historical root', async () => {
        await checkTree(false);
      });

      it('should compact tree', async () => {
        const before = await fs.stat(treePart1);
        await chain.compactTree();
        const after = await fs.stat(treePart1);

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
        await checkTree(true);
      });

      it('should compact tree a second time with no new data', async () => {
        // If user executes rpc compacttree repeatedly,
        // it shouldn't break anything.
        const before = await fs.stat(treePart1);
        await chain.compactTree();
        const after = await fs.stat(treePart1);

        // Should be no change
        assert.strictEqual(before.size, after.size);
      });

      it('should ONLY restore tree state from most recent roots', async () => {
        await checkTree(true);
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
        const before = await fs.stat(treePart1);
        await chain.compactTree();
        const after = await fs.stat(treePart1);
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
          send(await wallet.sendUpdate(name, Buffer.from([i + 1])), mempool);
          await mineBlocks(treeInterval, mempool);
        }

        const before = await fs.stat(treePart1);

        // Rewind the tree 6 intervals and compact, but do not sync to tip yet.
        const entry = await chain.getEntry(chain.height - 6 * treeInterval);
        await chain.db.compactTree(entry);

        // Confirm tree state has been rewound
        assert.notBufferEqual(chain.db.tree.rootHash(), chain.tip.treeRoot);

        // Oops, we abort before calling chain.syncTree()
        await miner.close();
        await chain.close();
        await blocks.close();

        // Restart -- chainDB will open tree with what it thinks
        // is the latest tree state (saved in levelDB). Then
        // chain.syncTree() will catch it up from there to tip.
        await blocks.open();
        await chain.open();
        await miner.open();

        // Tree was compacted
        const after = await fs.stat(treePart1);
        assert(before.size > after.size);

        // Tree was re-synced automatically to chain tip on restart
        assert.bufferEqual(chain.db.tree.rootHash(), chain.tip.treeRoot);
        raw = await chain.db.tree.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter + 21]));
      });

      it('should recover from failure during block connect', async () => {
        // Get current counter value.
        let raw = await chain.db.tree.get(nameHash);
        let ns = NameState.decode(raw);
        const counter = ns.data[0];

        // Approach next tree interval so next block will commit.
        const numBlocks = chain.height % treeInterval;
        await mineBlocks(numBlocks);

        // Prepare UPDATE
        const update = await wallet.createUpdate(
          name,
          Buffer.from([counter + 1])
        );

        // Put actual batch-write function aside
        const CHAIN_DB_COMMIT = chain.db.commit;

        // Current tree root before crash
        const treeRoot = chain.db.treeRoot();

        // Implement bug where node crashes before database batch is written.
        // When the next block is connected, it should successfully write
        // new data to the Urkel Tree but fail to write data to blockstore
        // or levelDB indexes.
        chain.db.commit = async () => {
          // Tree root has been updated inside Urkel
          const newRoot1 = chain.db.treeRoot();
          assert(!treeRoot.equals(newRoot1));

          // Reset batch, otherwise assert(!this.current) fails
          chain.db.drop();
          // Node has crashed...
          await chain.close();
        };

        // Update name and attempt to confirm
        send(update, mempool);
        // Will "crash" node before completing operation
        await mineBlocks(1, mempool);
        assert(!chain.opened);

        // Restore proper batch-write function
        chain.db.commit = CHAIN_DB_COMMIT;

        // Restarting chain should recover from crash
        await chain.open();

        // Tree root has been restored from pre-crash state
        const newRoot2 = chain.db.treeRoot();
        assert(treeRoot.equals(newRoot2));

        // Try that update again with healthy chainDB
        send(update, mempool);
        await mineBlocks(1, mempool);

        // Tree has been updated but tree root won't be committed
        // to a block header until the next block.
        assert(!chain.db.tree.rootHash().equals(chain.tip.treeRoot));
        await mineBlocks(1);

        // Everything is in order
        assert.bufferEqual(chain.db.tree.rootHash(), chain.tip.treeRoot);
        raw = await chain.db.tree.get(nameHash);
        ns = NameState.decode(raw);
        assert.bufferEqual(ns.data, Buffer.from([counter + 1]));
      });

      it('should not reconstruct tree (prune)', async () => {
        if (!prune)
          this.skip();

        let error;
        try {
          await chain.reconstructTree();
        } catch (e) {
          error = e;
        }

        assert(error, 'reconstructTree should throw an error in prune mode.');
        assert.strictEqual(error.message,
          'Cannot reconstruct tree in pruned mode.');
      });

      it('should reconstruct tree (archival)', async () => {
        if (prune)
          this.skip();

        await checkTree(true);

        const before = await fs.stat(treePart1);
        await chain.reconstructTree();
        const after = await fs.stat(treePart1);

        assert(before.size < after.size);

        // Should have all roots.
        await checkTree(false);
      });

      it('should recover reconstructing tree (archival)', async () => {
        if (prune)
          this.skip();

        await checkTree(false);

        // let's compact again and reconstruct
        const before = await fs.stat(treePart1);
        await chain.compactTree();
        const after = await fs.stat(treePart1);

        assert(before.size > after.size);

        await checkTree(true);
      });

      it('should fail to reset when compacted', async () => {
        let error = 'Cannot reset when tree is compacted.';

        if (prune)
          error = 'Cannot reset when pruned.';

        await assert.rejects(chain.reset(0), {
          message: error
        });
      });

      it('should remove existing tmp dir', async () => {
        if (prune)
          this.skip();

        const tmpPath = treePath + '~';
        const beforeRecovery = await fs.stat(treePart1);
        await chain.reconstructTree();
        const afterRecovery = await fs.stat(treePart1);
        assert(beforeRecovery.size < afterRecovery.size);

        await fs.copy(treePath, tmpPath);
        // Normally tmp directory lock would have expired.
        await fs.remove(path.join(tmpPath, 'lock'));

        await chain.compactTree();
        const afterCompaction = await fs.stat(treePart1);

        // If we don't remove existing TMP directory
        // afterCompaction would be bigger than afterRecovery.
        assert(afterCompaction.size < afterRecovery.size);
        assert(!await fs.exists(tmpPath));
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

  describe('SPV Node', function() {
    let prefix, node;

    beforeEach(async () => {
      prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );
    });

    afterEach(async () => {
      if (node && node.opened)
        await node.close();

      node = null;

      await fs.rimraf(prefix);
    });

    it('should ignore compact tree option', async () => {
      node = new SPVNode({
        prefix,
        network: 'regtest',
        memory: false,
        compactTreeOnInit: true,
        prune: true // also ignored
      });

      await node.ensure();
      await node.open();
      await node.close();
    });

    it('should refuse to compact/reconstruct tree via RPC', async () => {
      node = new SPVNode({
        prefix,
        network: 'regtest',
        memory: false
      });

      await node.ensure();
      await node.open();

      await assert.rejects(node.rpc.compactTree([]), {
        message: 'Cannot compact tree in SPV mode.'
      });

      await assert.rejects(node.rpc.reconstructTree([]), {
        message: 'Cannot reconstruct tree in SPV mode.'
      });

      await node.close();
    });
  });

  describe('Full Node', function() {
    let prefix, node, treePath;

    beforeEach(async () => {
      prefix = path.join(
        os.tmpdir(),
        `hsd-tree-compacting-test-${Date.now()}`
      );

      treePath = path.join(prefix, 'regtest', 'tree', '0000000001');
    });

    afterEach(async () => {
      if (node && node.opened) {
        try {
          await node.close();
        } catch (e) {
          ;
        }
      }

      node = null;

      await fs.rimraf(prefix);
    });

    it('should throw if compact tree interval is too small', () => {
      const {keepBlocks} = network.block;

      let error;

      try {
        new FullNode({
          prefix,
          network: 'regtest',
          memory: false,
          compactTreeOnInit: true,
          compactTreeInitInterval: network.block.keepBlocks - 1
        });
      } catch (e) {
        error = e;
      }

      assert(error, 'FullNode must throw an error.');
      assert.strictEqual(error.message,
        `compaction interval must not be smaller than ${keepBlocks}.`);
    });

    it('should not throw if compact tree interval is large enough', () => {
      assert.doesNotThrow(() => {
        new FullNode({
          prefix,
          network: 'regtest',
          memory: false,
          compactTreeOnInit: true,
          compactTreeInitInterval: network.block.keepBlocks
        });
      });
    });

    it('should not compact tree if chain is not long enough', async () => {
      const nodeOptions = {
        prefix,
        network: 'regtest',
        memory: false,
        compactTreeOnInit: true,
        compactTreeInitInterval: network.block.keepBlocks
      };

      node = new FullNode(nodeOptions);

      await node.ensure();

      let compacted = false;
      node.chain.compactTree = () => compacted = true;

      await node.open();
      assert.strictEqual(compacted, false);

      const blocks = network.block.keepBlocks - 1;
      const waiter = forEventCondition(node, 'connect', e => e.height >= blocks);

      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
      );

      await waiter;
      await node.close();

      node = new FullNode(nodeOptions);
      node.chain.compactTree = () => compacted = true;

      await node.open();
      assert.strictEqual(compacted, false);
      await node.close();
    });

    it('should compact tree when chain is long enough', async () => {
      this.timeout(2000);
      const compactTimeout = 500;

      const nodeOptions = {
        prefix,
        network: 'regtest',
        memory: false,
        compactTreeOnInit: true,
        compactTreeInitInterval: network.block.keepBlocks
      };

      node = new FullNode(nodeOptions);

      await node.ensure();

      let compacted = false;
      node.chain.compactTree = () => compacted = true;

      await node.open();
      assert.strictEqual(compacted, false);

      const blocks = network.block.keepBlocks + (treeInterval * 10);
      const waiter = forEventCondition(node, 'connect', e => e.height >= blocks);

      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
      );

      await waiter;
      await node.close();

      // keepBlocks..
      node = new FullNode(nodeOptions);

      const waiterStart = forEvent(node, 'tree compact start', 1, compactTimeout);
      const waiterEnd = forEvent(node, 'tree compact end', 1, compactTimeout);
      await node.open();

      const [startEvent, endEvent] = await Promise.all([
        waiterStart,
        waiterEnd
      ]);

      assert.strictEqual(startEvent.length, 1);
      assert.strictEqual(endEvent.length, 1);

      const [rootHash, entry] = endEvent[0].values;
      // We don't have anything in the tree.
      assert.bufferEqual(rootHash, consensus.ZERO_HASH);
      // blocks = keepBlocks + treeInterval * 10;
      // so what we can prune is `blocks - keepBlocks`
      // what's left is `treeInterval * 10`
      // Because we are at the edge, nearest should be
      // (treeInterval * 10) + 1
      //
      // e.g. if blocks was 100, keepBlocks 40 and interval 5:
      // 100 - 40 = 60
      // 60 % 5 = 0
      // So nearest one would be 61.
      const nearest = treeInterval * 10 + 1;
      assert.strictEqual(entry.height, nearest);

      await node.close();
    });

    it('should continue compaction on restart if it did not finish', async () => {
      const {keepBlocks} = network.block;
      const compactInterval = keepBlocks;
      const nodeOptions = {
        prefix,
        network: 'regtest',
        memory: false,
        compactTreeOnInit: true,
        compactTreeInitInterval: compactInterval
      };

      node = new FullNode(nodeOptions);

      await node.ensure();
      let compacted = false;
      const compactWrapper = (node) => {
        const compactTree = node.chain.compactTree.bind(node.chain);

        compacted = false;
        node.chain.compactTree = () => {
          compacted = true;
          return compactTree();
        };
      };

      compactWrapper(node);
      await node.open();
      assert.strictEqual(compacted, false);

      // get enough blocks for the compaction check.
      const blocks = compactInterval + keepBlocks + 1;
      const waiter = forEventCondition(node, 'connect', e => e.height >= blocks);

      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
      );

      await waiter;
      await node.close();

      // Should try compact, because we have enough blocks.
      // but we make sure it fails.
      node = new FullNode(nodeOptions);
      compactWrapper(node);
      node.chain.db.tree.compact = () => {
        throw new Error('STOP');
      };

      let err;
      try {
        await node.open();
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Critical Error: STOP');
      assert.strictEqual(compacted, true);

      try {
        await node.blocks.close();
        await node.chain.close();
        await node.close();
      } catch (e) {
        ;
      }

      // It should retry compaction on restart.
      node = new FullNode(nodeOptions);
      compactWrapper(node);

      await node.open();
      assert.strictEqual(compacted, true);
    });

    it('should recompact tree if tree init interval passed', async () => {
      const {keepBlocks} = network.block;
      const compactInterval = keepBlocks;
      const nodeOptions = {
        prefix,
        network: 'regtest',
        memory: false,
        compactTreeOnInit: true,
        compactTreeInitInterval: compactInterval
      };

      node = new FullNode(nodeOptions);

      await node.ensure();

      let compacted = false;
      const compactWrapper = (node) => {
        const compactTree = node.chain.compactTree.bind(node.chain);

        node.chain.compactTree = () => {
          compacted = true;
          return compactTree();
        };
      };

      compactWrapper(node);
      await node.open();
      assert.strictEqual(compacted, false);

      // get enough blocks for the compaction check.
      let blocks = compactInterval + keepBlocks + 1;
      let waiter = forEventCondition(node, 'connect', e => e.height >= blocks);

      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
      );

      await waiter;
      await node.close();

      // Should compact, because we have enough blocks.
      node = new FullNode(nodeOptions);
      compactWrapper(node);

      await node.open();
      assert.strictEqual(compacted, true);

      // setup interval - 1 blocks for next test.
      blocks = compactInterval + network.names.treeInterval - 1;
      waiter = forEvent(node, 'connect', blocks);
      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
      );
      await waiter;
      await node.close();

      // Should not recompact because interval has not passed.
      compacted = false;
      node = new FullNode(nodeOptions);
      compactWrapper(node);

      await node.open();
      assert.strictEqual(compacted, false);

      waiter = forEvent(node, 'connect');
      // commit 1 to recompact.
      await node.rpc.generateToAddress(
        [1, new Address().toString('regtest')]
      );
      await waiter;
      await node.close();

      // Should recompact because interval has passed
      compacted = false;
      node = new FullNode(nodeOptions);
      compactWrapper(node);

      await node.open();
      assert.strictEqual(compacted, true);
      await node.close();
    });

    it('should compact tree on launch (disk sizes)', async () => {
      this.timeout(4000);
      // Fresh start
      node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false
      });
      await node.ensure();
      await node.open();
      const fresh = await fs.stat(treePath);

      // Grow
      const blocks = 200;
      const waiter = forEventCondition(node, 'connect', (entry) => {
        return entry.height >= blocks;
      }, 2000);

      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
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
        compactTreeOnInit: true,
        compactTreeInitInterval: 100
      });

      const waiterEnd = forEvent(node, 'tree compact end', 1, 1000);
      await node.open();

      const [endEvent] = await waiterEnd;
      const [hash, entry] = endEvent.values;
      assert.bufferEqual(hash, Buffer.alloc(32, 0x00));
      assert.strictEqual(entry.height, 161);

      // Tree is compacted
      const compacted = await fs.stat(treePath);
      assert(compacted.size < grown.size);

      // Because syncTree will read tree roots
      // since compaction (8 tree roots) compacted
      // will be bigger than fresh.
      assert(fresh.size < compacted.size);

      // done
      await node.close();
    });

    it('should compact/reconstruct tree on rpc', async () => {
      this.timeout(4000);

      // Fresh start
      node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false
      });
      await node.ensure();
      await node.open();
      const fresh = await fs.stat(treePath);

      // Grow
      const blocks = 200;
      const waiter = forEventCondition(node, 'connect', (entry) => {
        return entry.height >= blocks;
      }, 2000);

      await node.rpc.generateToAddress(
        [blocks, new Address().toString('regtest')]
      );
      await waiter;

      // Tree has grown
      const grown = await fs.stat(treePath);
      assert(fresh.size < grown.size);

      await node.close();

      // Now use RPC for compaction.
      node = new FullNode({
        prefix,
        network: 'regtest',
        memory: false
      });

      await node.open();

      const compactEnd = forEvent(node, 'tree compact end', 1, 1000);
      await node.rpc.compactTree([]);
      const [endEvent] = await compactEnd;
      const [hash, entry] = endEvent.values;
      assert.bufferEqual(hash, consensus.ZERO_HASH);
      assert.strictEqual(entry.height, 161);

      // Tree is compacted
      const compacted = await fs.stat(treePath);
      assert(compacted.size < grown.size);
      assert(fresh.size < compacted.size);

      // Reconstruct
      const reconstructEnd = forEvent(node, 'tree reconstruct end', 1, 1000);
      await node.rpc.reconstructTree([]);
      await reconstructEnd;

      const reconstructed = await fs.stat(treePath);
      assert(reconstructed.size > compacted.size);

      // This is same as grown, because we did not have any reorgs.
      assert.strictEqual(reconstructed.size, grown.size);

      // done
      await node.close();
    });
  });

  describe('Boundary checks', function() {
    const prefix = path.join(
      os.tmpdir(),
      `hsd-tree-compacting-test-${Date.now()}`
    );

    const blocks = blockstore.create({
      memory: false,
      prefix,
      network
    });
    const chain = new Chain({
      memory: false,
      prefix,
      blocks: blocks,
      network
    });
    const miner = new Miner({chain});
    const cpu = miner.cpu;

    const wallet = new MemWallet({network});
    wallet.getNameStatus = async (nameHash) => {
      assert(Buffer.isBuffer(nameHash));
      const height = chain.height + 1;
      return chain.db.getNameStatus(nameHash, height);
    };

    async function mineBlocks(num, open = false) {
      for (; num > 0; num--) {
        const job = await cpu.createJob();

        // Include an OPEN for some new name in every block.
        // This ensures that every single block results in a different
        // tree and treeRoot without any auctions.
        if (open) {
          const name = rules.grindName(GNAME_SIZE, chain.height - 1, network);
          const tx = await wallet.sendOpen(name);
          job.pushTX(tx.toTX());
          job.refresh();
        }

        const block = await job.mineAsync();
        const entry = await chain.add(block);
        wallet.addBlock(entry, block.txs);
      }
    }

    const treeRoots = [];
    chain.on('tree commit', root => treeRoots.push(root));

    const checkTree = async (expected) => {
      for (let i = treeRoots.length - 1; i >= 0; i--) {
        const root = treeRoots[i];

        if (expected > 0) {
          await chain.db.tree.inject(root);
          expected--;
        } else {
          await assert.rejects(
            chain.db.tree.inject(root),
            {message: `Missing node: ${root.toString('hex')}.`}
          );
        }
      }
    };

    before(async () => {
      await blocks.ensure();
      await blocks.open();
      await chain.open();
    });

    after(async () => {
      await chain.close();
      await blocks.close();
    });

    it('should fund wallet', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
      await mineBlocks(treeInterval * 2);
    });

    it('should generate blocks to treeInterval - 3 and compact', async () => {
      treeRoots.length = 0;
      let num = treeInterval - (chain.height % treeInterval);
      num += treeInterval * 20 - 3;
      await mineBlocks(num, true);
      assert(chain.height % treeInterval === treeInterval - 3);

      // All roots available before compacting
      await checkTree(Infinity);

      await chain.compactTree();
      await checkTree(8);
    });

    it('should generate blocks to treeInterval - 2 and compact', async () => {
      treeRoots.length = 0;
      let num = treeInterval - (chain.height % treeInterval);
      num += treeInterval * 20 - 2;
      await mineBlocks(num, true);
      assert(chain.height % treeInterval === treeInterval - 2);

      // All roots available before compacting
      await checkTree(Infinity);

      await chain.compactTree();
      await checkTree(8);
    });

    it('should generate blocks to treeInterval - 1 and compact', async () => {
      treeRoots.length = 0;
      let num = treeInterval - (chain.height % treeInterval);
      num += treeInterval * 20 - 1;
      await mineBlocks(num, true);
      assert(chain.height % treeInterval === treeInterval - 1);

      // All roots available before compacting
      await checkTree(Infinity);

      await chain.compactTree();
      await checkTree(8);
    });

    it('should generate blocks to treeInterval + 0 and compact', async () => {
      treeRoots.length = 0;
      let num = treeInterval - (chain.height % treeInterval);
      num += treeInterval * 20 + 0;
      await mineBlocks(num, true);
      assert(chain.height % treeInterval === 0);

      // All roots available before compacting
      await checkTree(Infinity);

      await chain.compactTree();
      await checkTree(9);
    });

    it('should generate blocks to treeInterval + 1 and compact', async () => {
      treeRoots.length = 0;
      let num = treeInterval - (chain.height % treeInterval);
      num += treeInterval * 20 + 1;
      await mineBlocks(num, true);
      assert(chain.height % treeInterval === 1);

      // All roots available before compacting
      await checkTree(Infinity);

      await chain.compactTree();
      await checkTree(8);
    });

    it('should generate blocks to treeInterval + 2 and compact', async () => {
      treeRoots.length = 0;
      let num = treeInterval - (chain.height % treeInterval);
      num += treeInterval * 20 + 2;
      await mineBlocks(num, true);
      assert(chain.height % treeInterval === 2);

      // All roots available before compacting
      await checkTree(Infinity);

      await chain.compactTree();
      await checkTree(8);
    });
  });
});
