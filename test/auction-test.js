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

describe('Auction', function() {
  this.timeout(45000);

  describe('Vickrey Auction', function() {
    const chain = new Chain({
      memory: true,
      network,
      workers
    });

    const miner = new Miner({
      chain,
      workers
    });

    const wallet = new MemWallet({
      network
    });

    const runnerup = new MemWallet({
      network
    });

    chain.on('connect', (entry, block) => {
      wallet.addBlock(entry, block.txs);
      runnerup.addBlock(entry, block.txs);
    });

    chain.on('disconnect', (entry, block) => {
      wallet.removeBlock(entry, block.txs);
      runnerup.removeBlock(entry, block.txs);
    });

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
      miner.addAddress(runnerup.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await miner.cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a bid', async () => {
      const job = await miner.cpu.createJob();
      const mtx1 = await wallet.createBid('abcd', 1000, 2000);
      const mtx2 = await runnerup.createBid('abcd', 500, 2000);

      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await miner.cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should reveal a bid', async () => {
      const job = await miner.cpu.createJob();
      const mtx1 = await wallet.createReveal('abcd');
      const mtx2 = await runnerup.createReveal('abcd');

      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await miner.cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a name', async () => {
      const job = await miner.cpu.createJob();
      const mtx = await wallet.createRegister('abcd', Buffer.from([1,2,3]));

      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await miner.cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register again and update trie', async () => {
      const job = await miner.cpu.createJob();
      const mtx = await wallet.createUpdate('abcd', Buffer.from([1,2,4]));

      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await miner.cpu.mineBlock();
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
