/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('./util/assert');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true
});

function createNode() {
  const chain = new Chain({
    memory: true,
    network,
    workers
  });

  const miner = new Miner({
    chain,
    workers
  });

  return {
    chain,
    miner,
    cpu: miner.cpu,
    wallet: () => {
      const wallet = new MemWallet({ network });

      chain.on('connect', (entry, block) => {
        wallet.addBlock(entry, block.txs);
      });

      chain.on('disconnect', (entry, block) => {
        wallet.removeBlock(entry, block.txs);
      });

      return wallet;
    }
  };
}

describe('Auction', function() {
  this.timeout(15000);

  describe('Vickrey Auction', function() {
    const node = createNode();
    const {chain, miner, cpu} = node;

    const winner = node.wallet();
    const runnerup = node.wallet();

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(winner.getReceive());
      miner.addAddress(runnerup.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a bid', async () => {
      const job = await cpu.createJob();
      const mtx1 = await winner.createBid('abcd', 1000, 2000);
      const mtx2 = await runnerup.createBid('abcd', 500, 2000);

      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should reveal a bid', async () => {
      const job = await cpu.createJob();
      const mtx1 = await winner.createReveal('abcd');
      const mtx2 = await runnerup.createReveal('abcd');

      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a name', async () => {
      const job = await cpu.createJob();
      const mtx = await winner.createRegister('abcd', Buffer.from([1,2,3]));

      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register again and update trie', async () => {
      const job = await cpu.createJob();
      const mtx = await winner.createUpdate('abcd', Buffer.from([1,2,4]));

      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });
});
