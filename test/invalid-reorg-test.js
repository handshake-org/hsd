'use strict';

const assert = require('bsert');
const BlockStore = require('../lib/blockstore/level');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true,
  size: 2
});

describe('Invalid Reorg', function() {
  for (const mode of ['Front', 'Middle', 'Back', 'Final']) {
    describe(mode, function() {
      this.timeout(45000);

      const blocks = new BlockStore({
        memory: true,
        network
      });

      const chain = new Chain({
        memory: true,
        blocks,
        network,
        workers
      });

      const miner = new Miner({
        chain,
        workers
      });

      const cpu = miner.cpu;

      const wallet = new MemWallet({
        network
      });

      chain.on('connect', (entry, block) => {
        wallet.addBlock(entry, block.txs);
      });

      chain.on('disconnect', (entry, block) => {
        wallet.removeBlock(entry, block.txs);
      });

      let tip1 = null;
      let tip2 = null;

      const valid = [];
      const invalid = [];

      before(async () => {
        await blocks.open();
        await chain.open();
        await miner.open();
      });

      after(async () => {
        await miner.close();
        await chain.close();
        await blocks.close();
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
        }
      });

      if (mode === 'Middle' || mode === 'Back') {
        it('should mine competing chains', async () => {
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

            valid.push(hash1);
            valid.push(hash2);

            assert(await chain.add(blk1));
            assert(await chain.add(blk2));

            assert.bufferEqual(chain.tip.hash, hash1);

            tip1 = await chain.getEntry(hash1);
            tip2 = await chain.getEntry(hash2);

            assert(tip1);
            assert(tip2);

            assert(!await chain.isMainChain(tip2));
          }
        });
      }

      if (mode !== 'Final') {
        it('should mine competing invalid block', async () => {
          const job1 = await cpu.createJob();
          const job2 = await cpu.createJob();

          const mtx = await wallet.create({
            outputs: [{
              address: wallet.getAddress(),
              value: 10 * 1e8
            }]
          });

          assert(job1.addTX(mtx.toTX(), mtx.view));
          assert(job2.addTX(mtx.toTX(), mtx.view));

          job2.attempt.fees += 1000;

          job1.refresh();
          job2.refresh();

          const blk1 = await job1.mineAsync();
          const blk2 = await job2.mineAsync();

          const hash1 = blk1.hash();
          const hash2 = blk2.hash();

          valid.push(hash1);
          invalid.push(hash2);

          assert(await chain.add(blk1));
          assert(await chain.add(blk2));

          assert.bufferEqual(chain.tip.hash, hash1);

          tip1 = await chain.getEntry(hash1);
          tip2 = await chain.getEntry(hash2);

          assert(tip1);
          assert(tip2);

          assert(!await chain.isMainChain(tip2));
        });
      }

      if (mode === 'Front' || mode === 'Middle' || mode === 'Final') {
        it('should mine competing chains', async () => {
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

            valid.push(hash1);

            if (mode === 'Final')
              valid.push(hash2);
            else
              invalid.push(hash2);

            assert(await chain.add(blk1));
            assert(await chain.add(blk2));

            assert.bufferEqual(chain.tip.hash, hash1);

            tip1 = await chain.getEntry(hash1);
            tip2 = await chain.getEntry(hash2);

            assert(tip1);
            assert(tip2);

            assert(!await chain.isMainChain(tip2));
          }
        });
      }

      let state = null;

      it('should handle a reorg', async () => {
        assert(chain.tip.hash.equals(tip1.hash));
        assert(!chain.tip.hash.equals(tip2.hash));

        state = chain.db.state.clone();

        const job = await cpu.createJob(tip2);

        if (mode === 'Final') {
          job.attempt.fees += 1000;
          job.refresh();
        }

        const blk = await job.mineAsync();

        let err = null;

        try {
          await chain.add(blk);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.reason, 'bad-cb-amount');
      });

      it('should have correct chain value', () => {
        assert.strictEqual(chain.db.state.value, state.value);
        assert.strictEqual(chain.db.state.coin, state.coin);
        assert.strictEqual(chain.db.state.tx, state.tx);
      });

      it('should check main chain', async () => {
        assert(await chain.isMainChain(tip1));
        assert(chain.tip.hash.equals(tip1.hash));

        for (const hash of valid)
          assert(!chain.invalid.has(hash));

        for (const hash of invalid)
          assert(chain.invalid.has(hash));
      });

      it('should replay main chain', async () => {
        const blocks = [];

        let entry = await chain.getEntry(1);

        do {
          blocks.push(await chain.getBlock(entry.hash));
          entry = await chain.getNext(entry);
        } while (entry);

        const store = new BlockStore({
          memory: true,
          network
        });

        const fresh = new Chain({
          memory: true,
          blocks: store,
          network,
          workers
        });

        await store.open();
        await fresh.open();

        for (const block of blocks)
          assert(await fresh.add(block));

        assert(fresh.tip.hash.equals(chain.tip.hash));

        assert.strictEqual(fresh.db.state.value, chain.db.state.value);
        assert.strictEqual(fresh.db.state.coin, chain.db.state.coin);
        assert.strictEqual(fresh.db.state.tx, chain.db.state.tx);

        await fresh.close();
        await store.close();
      });

      it('should mine a block after a reorg', async () => {
        const block = await cpu.mineBlock();

        assert(await chain.add(block));

        const hash = block.hash();
        const entry = await chain.getEntry(hash);

        assert(entry);
        assert.bufferEqual(chain.tip.hash, entry.hash);

        const result = await chain.isMainChain(entry);
        assert(result);
      });
    });
  }
});
