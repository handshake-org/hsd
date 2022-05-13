'use strict';

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const MerkleBlock = require('../lib/primitives/merkleblock');

const network = Network.get('regtest');
const workers = new WorkerPool({
  // Must be disabled for `ownership.ignore`.
  enabled: false,
  size: 2
});

function addBlock(chain, block, wallet) {
  if (chain.options.spv) {
    const mblock = MerkleBlock.fromBlock(block, wallet.filter);
    return chain.add(mblock);
  }

  return chain.add(block);
}

for (const type of ['full', 'spv']) {
  describe(`Chain reorg test (${type})`, function() {
    this.timeout(0);

    const blocks = new BlockStore({
      memory: true,
      network
    });

    const chain = new Chain({
      memory: true,
      blocks,
      network
    });

    let testBlocks;
    if (type === 'full') {
      testBlocks = new BlockStore({
        memory: true,
        network
      });
    }

    const testChain = new Chain({
      memory: true,
      spv: type === 'spv',
      blocks: testBlocks,
      network
    });

    const miner = new Miner({
      chain,
      workers
    });
    const cpu = miner.cpu;

    const wallet = new MemWallet({
      network
    });

    chain.on('connect', async (entry, block) => {
      wallet.addBlock(entry, block.txs);
    });

    chain.on('disconnect', (entry, block) => {
      wallet.removeBlock(entry, block.txs);
    });

    let fork = null;
    let tip1 = null;
    let tip2 = null;

    before(async () => {
      if (type === 'full')
        await testBlocks.open();
      await blocks.open();
      await chain.open();
      await testChain.open();
      await miner.open();
    });

    after(async () => {
      await miner.close();
      await chain.close();
      await testChain.close();
      await blocks.close();

      if (type === 'full')
        await testBlocks.close();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
        assert(await addBlock(testChain, block, wallet));
      }

      fork = chain.tip;
    });

    it('should mine competing chain', async () => {
      for (let i = 0; i < 10; i++) {
        const job1 = await cpu.createJob(tip1);
        const job2 = await cpu.createJob(tip2);

        const mtx = await wallet.create({
          outputs: [{
            address: wallet.getAddress(),
            value: 10 * 1e8
          }]
        });

        assert(job1.addTX(mtx.toTX(), mtx.view));
        assert(job2.addTX(mtx.toTX(), mtx.view));

        job1.refresh();
        job2.refresh();

        const blk1 = await job1.mineAsync();
        const blk2 = await job2.mineAsync();

        const hash1 = blk1.hash();
        const hash2 = blk2.hash();

        assert(await chain.add(blk1));
        assert(await chain.add(blk2));
        assert(await addBlock(testChain, blk1, wallet));
        assert(await addBlock(testChain, blk2, wallet));

        assert.bufferEqual(chain.tip.hash, hash1);

        tip1 = await chain.getEntry(hash1);
        tip2 = await chain.getEntry(hash2);

        assert(tip1);
        assert(tip2);

        const testTip1 = await testChain.getEntry(hash1);
        const testTip2 = await testChain.getEntry(hash2);

        assert(testTip1);
        assert(testTip2);

        assert(!await chain.isMainChain(tip2));
        assert(await testChain.isMainChain(tip1));
        assert(!await testChain.isMainChain(tip2));
        assert.strictEqual(tip1.height, 11 + i);
      }
    });

    if (type === 'spv') {
      it('should reorg to alternative chain and back (spv)', async () => {
        const reorgs = [];
        let resets = 0;

        const handleReorg = (tip, competitor) => {
          reorgs.push({
            competitor,
            tip
          });
        };
        const handleReset = () => resets++;

        testChain.on('reorganize', handleReorg);
        testChain.on('reset', handleReset);

        // Replay main chain to the SPV node.
        const replayChain = async (fork) => {
          let entry = await chain.getEntry(fork.height + 1);

          while (entry) {
            const blk = await chain.getBlock(entry.hash);
            assert(await addBlock(testChain, blk, wallet));
            entry = await chain.getEntry(entry.height + 1);
          }
        };

        // This will cause reset for SPV and Reorg.
        {
          const job = await cpu.createJob(tip2);
          job.refresh();

          const blk = await job.mineAsync();
          const hash = blk.hash();

          assert(await chain.add(blk));
          assert(await addBlock(testChain, blk, wallet));

          // SPV Node will reset instead of reconnecting.
          // and wait for the network to add blocks.
          tip2 = await chain.getEntry(hash);
          assert(tip2);
          assert.strictEqual(await testChain.getEntry(hash), null);
          assert.bufferEqual(testChain.tip.hash, fork.hash);

          assert(await chain.isMainChain(tip2));
        }

        // sync chain with spv.
        await replayChain(fork);
        assert.bufferEqual(testChain.tip.hash, tip2.hash);

        // Another reorg, BACK TO first chain.

        // For SPV, this chain is lost so new blocks
        // will get added as orphans. So this should not
        // automatically cause reorg/reset until we fulfill
        // missing block entries.
        for (let i = 0; i < 2; i++) {
          const job = await cpu.createJob(tip1);
          job.refresh();

          const blk = await job.mineAsync();
          const hash = blk.hash();

          assert(await chain.add(blk));

          // i = 1 will give use new best chain tip and tip1 will become best.
          tip1 = await chain.getEntry(hash);
          assert(tip1);
          assert.strictEqual(await testChain.getEntry(hash), null);
        }

        // Replay current best chain. This should
        // cause SPV to reset chain to the fork.
        // above reset will catch it and replay again.
        await replayChain(fork);
        assert.bufferEqual(testChain.tip.hash, fork.hash);

        // Now we need to replay blocks once again,
        // because above replay caused it to reorg and reset.
        await replayChain(fork);
        assert.bufferEqual(testChain.tip.hash, tip1.hash);
        assert.strictEqual(reorgs.length, 2);

        // Add alternative tip2 chain as well.
        // This will not cause neither reorg nor reset
        // and will simply add alternative chain. (Used in the next test)

        let entry = await chain.getEntry(tip2.hash);
        for (;;) {
          assert.strictEqual(await testChain.getEntry(entry.hash), null);
          const block = await chain.getBlock(entry.hash);

          if (entry.prevBlock.equals(fork.hash))
            assert(await addBlock(testChain, block, wallet), null);
          else
            assert.strictEqual(await addBlock(testChain, block, wallet), null);

          entry = await chain.getEntry(entry.prevBlock);
          if (entry.hash.equals(fork.hash))
            break;
        }

        assert.bufferEqual(testChain.tip.hash, tip1.hash);
        assert.strictEqual(reorgs.length, 2);
        assert.strictEqual(resets, 2);

        testChain.removeListener('reorganize', handleReorg);
        testChain.removeListener('reset', handleReset);
      });
    }

    if (type === 'full') {
      it('should reorg to alternative chain and back (full)', async () => {
        const reorgs = [];
        const tips = [];
        const reset = [];

        const handleReorg = (tip, competitor) => {
          reorgs.push({
            competitor,
            tip
          });
        };
        const handleTip = tip => tips.push(tip);
        const handleReset = tip => reset.push(tip);

        testChain.on('reorganize', handleReorg);
        testChain.on('tip', handleTip);
        testChain.on('reset', handleReset);

        const firstTip = chain.tip;
        let secondTip = null;
        let firstCompetitor = null;
        let secondCompetitor = null;

        {
          const job = await cpu.createJob(tip2);
          job.refresh();

          const blk = await job.mineAsync();
          const hash = blk.hash();

          assert(await chain.add(blk));
          assert(await addBlock(testChain, blk, wallet));

          tip2 = await chain.getEntry(hash);
          firstCompetitor = tip2;
          secondTip = tip2;
          assert(tip2);
          assert(await testChain.getEntry(hash));

          assert(await chain.isMainChain(tip2));
          assert(await testChain.isMainChain(tip2));
        }

        assert(!await chain.isMainChain(tip1));
        assert(!await testChain.isMainChain(tip1));
        assert(await chain.isMainChain(tip2));
        assert(await testChain.isMainChain(tip2));

        for (let i = 0; i < 2; i++) {
          const job = await cpu.createJob(tip1);
          job.refresh();

          const blk = await job.mineAsync();
          const hash = blk.hash();

          assert(await chain.add(blk));
          assert(await addBlock(testChain, blk, wallet));

          tip1 = await chain.getEntry(hash);
          // last one.
          secondCompetitor = tip1;
          assert(tip1);
          assert(await testChain.getEntry(hash));
        }

        assert(await chain.isMainChain(tip1));
        assert(await testChain.isMainChain(tip1));
        assert(!await chain.isMainChain(tip2));
        assert(!await testChain.isMainChain(tip2));

        testChain.removeListener('reorganize', handleReorg);
        testChain.removeListener('tip', handleTip);
        testChain.removeListener('reset', handleReset);
        // Check reorg events
        assert.strictEqual(reorgs.length, 2, 'it must reorg twice.');
        // First competitor is the tip2.
        assert.bufferEqual(reorgs[0].competitor.hash, firstCompetitor.hash);
        assert.bufferEqual(reorgs[0].tip.hash, firstTip.hash);
        assert.bufferEqual(reorgs[1].competitor.hash, secondCompetitor.hash);
        assert.bufferEqual(reorgs[1].tip.hash, secondTip.hash);
      });
    };

    it('should remove competing chains on reset', async () => {
      // tip1 is the best
      // tip2 is alt (prev test)
      const prevTip = await testChain.getEntry(tip1.prevBlock);
      assert(prevTip);

      {
        const entry1 = await testChain.getEntry(tip1.hash);
        const entry2 = await testChain.getEntry(tip2.hash);

        assert(entry1);
        assert(entry2);
      }

      await testChain.reset(tip1.height - 1);

      {
        const entry1 = await testChain.getEntry(prevTip.hash);
        const entry2 = await testChain.getEntry(tip2.hash);

        assert(entry1);
        assert.strictEqual(entry2, null);
      }

      // sync with the main chain.
      const blk = await chain.getBlock(tip1.hash);
      await addBlock(testChain, blk, wallet);
    });

    it('should fail to connect bad MTP', async () => {
      const mtp = await chain.getMedianTime(chain.tip);
      const job = await cpu.createJob(tip1);
      job.attempt.time = mtp - 1;
      const blk = await job.mineAsync();

      await assert.rejects(async () => {
        await addBlock(testChain, blk, wallet);
      }, {
        code: 'invalid',
        reason: 'time-too-old',
        score: 0,
        malleated: false
      });
    });

    it('should fail to connect blocks too ahead of time', async () => {
      // 2 hours into the future.
      const job = await cpu.createJob(tip1);
      job.attempt.time = network.now() + 1 + 2 * 60 * 60;
      const blk = await job.mineAsync();

      await assert.rejects(async () => {
        await addBlock(testChain, blk, wallet);
      }, {
        code: 'invalid',
        reason: 'time-too-new',
        score: 0,
        malleated: true
      });
    });
  });
}
