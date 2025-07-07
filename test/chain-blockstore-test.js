'use strict';

const assert = require('bsert');
const {BloomFilter} = require('bfilter');
const Network = require('../lib/protocol/network');
const {FileBlockStore, LevelBlockStore} = require('../lib/blockstore');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const {rimraf, testdir} = require('./util/common');
const MemWallet = require('./util/memwallet');

const network = Network.get('regtest');

const blockStoreTypes = {
  'File': async (location) => {
    const store = new FileBlockStore({
      maxFileLength: 1024,
      location
    });

    await store.ensure();
    return store;
  },
  'Level': async (location) => {
    const store = new LevelBlockStore({ location });

    await store.ensure();
    return store;
  },
  'Level-memory': async (location) => {
    const store = new LevelBlockStore({
      memory: true
    });

    return store;
  }
};

describe('Chain Blockstore Integration', function() {
  for (const type of Object.keys(blockStoreTypes)) {
    describe(`Chain ${type} BlockStore Integration`, function() {
      const location = testdir('chain-blockstore');
      const workers = new WorkerPool({
        enabled: true,
        size: 2
      });

      const MINE_BLOCKS = 10;

      let blocks, chain, miner, cpu, wallet;

      before(async () => {
        await rimraf(location);

        blocks = await blockStoreTypes[type](location);

        chain = new Chain({
          prefix: location,
          blocks,
          network,
          workers
        });

        miner = new Miner({ chain, workers });
        cpu = miner.cpu;
        wallet = new MemWallet({ network });

        await blocks.open();
        await chain.open();
        await miner.open();
      });

      after(async () => {
        await miner.close();
        await chain.close();
        await blocks.close();

        await rimraf(location);
      });

      it('should add addrs to miner', async () => {
        miner.addresses.length = 0;
        miner.addAddress(wallet.getReceive());
      });

      it(`should mine ${MINE_BLOCKS} blocks`, async () => {
        for (let i = 0; i < MINE_BLOCKS; i++) {
          const block = await cpu.mineBlock();
          assert(block);
          assert(await chain.add(block));
        }
      });

      it('should rescan', async () => {
        const filter = new BloomFilter();

        const firstBlock = await chain.getHash(1);
        const scanned = new Set();
        await chain.scan(firstBlock, filter, (entry, txs) => {
          scanned.add(entry.height);
        });

        for (let i = 1; i <= MINE_BLOCKS; i++)
          assert.strictEqual(scanned.has(i), true, `Block ${i} was not scanned.`);
        assert.strictEqual(scanned.size, MINE_BLOCKS);
      });

      it('should handle blockstore failing to write', async () => {
        const db = chain.db;

        // backup start method
        const dbStart = db.start;

        db.start = function() {
          dbStart.call(this);

          // old API would have
          // this.blocksBatch.write = () ...
          this.blocksBatch.commitWrites = () => {
            throw new Error('Failed to write.');
          };
        };

        const block = await cpu.mineBlock();
        assert(block);

        let err;
        try {
          await chain.add(block);
        } catch (e) {
          err = e;
        }

        // recover start method.
        db.start = dbStart;

        assert(err);
        assert(err.message, 'Failed to write.');
      });

      it('should reopen the chain', async () => {
        await chain.close();
        await chain.open();
      });

      it('should handle blockstore failing to prune', async () => {
        const db = chain.db;

        // backup start method
        const dbStart = db.start;

        db.start = function() {
          dbStart.call(this);

          this.blocksBatch.commitPrunes = function() {
            throw new Error('Failed to prune.');
          };
        };

        let err;

        try {
          await chain.reset(1);
        } catch (e) {
          err = e;
        }

        // recover start method.
        db.start = dbStart;

        assert(err);
        assert(err.message, 'Failed to prune.');
      });

      it('should reopen the chain', async () => {
        await chain.close();
        await chain.open();
      });
    });
  }

  describe('Chain File BlockStore Integration 2', function() {
    const location = testdir('chain-blockstore-2');
    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const MINE_BLOCKS = 10;

    let blocks, chain, miner, cpu, wallet;

    before(async () => {
      await rimraf(location);

      blocks = await blockStoreTypes['File'](location);

      chain = new Chain({
        prefix: location,
        blocks,
        network,
        workers
      });

      miner = new Miner({ chain, workers });
      cpu = miner.cpu;
      wallet = new MemWallet({ network });

      await blocks.open();
      await chain.open();
      await miner.open();
    });

    after(async () => {
      await miner.close();
      await chain.close();
      await blocks.close();

      await rimraf(location);
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
    });

    it(`should mine ${MINE_BLOCKS} blocks`, async () => {
      for (let i = 0; i < MINE_BLOCKS; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should handle file blockstore failing to prune', async () => {
      const db = chain.db;

      // backup start method
      const dbStart = db.start;

      db.start = function() {
        dbStart.call(this);

        this.blocksBatch.commitPrunes = function() {
          if (this.prunes.length === 0) {
            this.committedPrunes = true;
            return;
          }

          throw new Error('Failed to prune.');
        };
      };

      let err;

      assert.strictEqual(chain.tip.height, MINE_BLOCKS);
      try {
        await chain.reset(1);
      } catch (e) {
        err = e;
      }

      // recover start method.
      db.start = dbStart;

      assert(err);
      assert(err.message, 'Failed to prune.');
    });

    it('should reopen the chain', async () => {
      await chain.close();
      await chain.open();

      // Even though pruning failed, we still reverted one block.
      assert.strictEqual(chain.tip.height, MINE_BLOCKS - 1);
    });
  });
});
