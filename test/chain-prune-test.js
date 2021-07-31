/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const Chain = require('../lib/blockchain/chain');

const network = Network.get('regtest');

describe('Chain Prune', function() {
  describe('Prune options', function() {
    const chainOptions = {
      memory: true,
      network
    };

    it('should not allow retroactive prune', async () => {
      const chain = new Chain(chainOptions);

      await chain.open();
      await chain.close();

      // Retroactively enable prune.
      await assert.rejects(async () => {
        chain.options.prune = true;
        await chain.open();
      }, {
        message: 'Cannot retroactively prune.'
      });
      await chain.close();
    });

    it('should not allow retroactive unprune', async () => {
      const chain = new Chain({
        ...chainOptions,
        prune: true
      });

      await chain.open();
      await chain.close();

      await assert.rejects(async () => {
        chain.options.prune = false;
        await chain.open();
      }, {
        message: 'Cannot retroactively unprune.'
      });
      await chain.close();
    });
  });

  describe('Prune', function() {
    const PRUNE_AFTER_HEIGHT = network.block.pruneAfterHeight;
    const KEEP_BLOCKS = network.block.keepBlocks;

    const TEST_PRUNE_AFTER_HEIGHT = 10;
    const TEST_KEEP_BLOCKS = 10;
    const TEST_PRUNED_BLOCKS = 10;

    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const chainoptions = {
      memory: true,
      network,
      workers
    };

    let chain, miner, cpu;
    before(async () => {
      await workers.open();
    });

    after(async () => {
      await workers.close();
    });

    beforeEach(async () => {
      network.block.pruneAfterHeight = TEST_PRUNE_AFTER_HEIGHT;
      network.block.keepBlocks = TEST_KEEP_BLOCKS;

      chain = new Chain(chainoptions);
      miner = new Miner({ chain });
      cpu = miner.cpu;

      await miner.open();
    });

    afterEach(async () => {
      network.block.pruneAfterHeight = PRUNE_AFTER_HEIGHT;
      network.block.keepBlocks = KEEP_BLOCKS;

      if (chain.opened)
        await chain.close();

      await miner.close();
    });

    it('should prune blocks', async () => {
      chain.options.prune = true;

      await chain.open();

      const hashes = [];

      let genBlocks = TEST_PRUNE_AFTER_HEIGHT;
      genBlocks += TEST_PRUNED_BLOCKS;
      genBlocks += TEST_KEEP_BLOCKS;

      // 10 behind height check + 10 pruned + 10 keep blocks
      for (let i = 0; i < genBlocks; i++) {
        const block = await cpu.mineBlock();
        hashes.push(block.hash());
        assert(block);
        assert(await chain.add(block));
      }

      let i = 0;

      // behind height check
      let to = TEST_PRUNE_AFTER_HEIGHT;
      for (; i < 10; i++) {
        const block = await chain.getBlock(hashes[i]);
        assert(block, 'could not get block before height check.');
      }

      // pruned blocks - nulls
      to += TEST_PRUNED_BLOCKS;
      for (; i < to; i++) {
        const block = await chain.getBlock(hashes[i]);
        assert.strictEqual(block, null, `block ${i} was not pruned.`);
      }

      // keep blocks
      to += TEST_KEEP_BLOCKS;
      for (; i < to; i++) {
        const block = await chain.getBlock(hashes[i]);
        assert(block, `block ${i} was pruned.`);
      }
    });
  });
});
