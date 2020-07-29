/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

// DO NOT TOUCH THESE TESTS
// They trigger the tree interval reorg bug.

'use strict';

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const ownership = require('../lib/covenants/ownership');

const network = Network.get('regtest');
const {treeInterval} = network.names;
const NAME1 = rules.grindName(10, 20, network);
const NAME2 = rules.grindName(10, 20, network);

const workers = new WorkerPool({
  // Must be disabled for `ownership.ignore`.
  enabled: false
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

      wallet.getNameStatus = async (nameHash) => {
        assert(Buffer.isBuffer(nameHash));
        const height = chain.height + 1;
        const state = await chain.getNextState();
        const hardened = state.hasHardening();
        return chain.db.getNameStatus(nameHash, height, hardened);
      };

      return wallet;
    }
  };
}

describe('Auction Reorg', function() {
  this.timeout(20000);

  describe('Vickrey Auction Reorg', function() {
    const node = createNode();
    const orig = createNode();
    const comp = createNode();

    const {chain, miner, cpu} = node;

    const winner = node.wallet();
    const runnerup = node.wallet();

    let snapshot = null;

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

    it('should open auction', async () => {
      const mtx = await winner.createOpen(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine blocks', async () => {
      for (let i = 0; i < treeInterval; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a bid', async () => {
      const mtx1 = await winner.createBid(NAME1, 1000, 2000);
      const mtx2 = await runnerup.createBid(NAME1, 500, 2000);

      const job = await cpu.createJob();
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
      const mtx1 = await winner.createReveal(NAME1);
      const mtx2 = await runnerup.createReveal(NAME1);

      const job = await cpu.createJob();
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
      const mtx = await winner.createRegister(NAME1, Buffer.from([1,2,3]));

      assert(mtx.outputs.length > 0);

      // Should pay the second highest bid.
      assert.strictEqual(mtx.outputs[0].value, 500);

      const job = await cpu.createJob();
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

    it('should register again and update tree', async () => {
      const mtx = await winner.createUpdate(NAME1, Buffer.from([1,2,4]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should redeem', async () => {
      const mtx = await runnerup.createRedeem(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should renew', async () => {
      const mtx = await winner.createRenewal(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should fail renew', async () => {
      const mtx = await winner.createRenewal(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.reason, 'bad-renewal-premature');
    });

    it('should mine 10 blocks', async () => {
      const left = treeInterval - (chain.height % treeInterval);

      for (let i = 0; i < left; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      assert((chain.height % treeInterval) === 0);

      snapshot = {
        treeRoot: chain.db.txn.rootHash(),
        ns: await chain.db.getNameStateByName(NAME1)
      };
    });

    it('should open other nodes', async () => {
      await orig.chain.open();
      await orig.miner.open();
      await comp.chain.open();
      await comp.miner.open();
    });

    it('should clone the chain', async () => {
      for (let i = 1; i <= chain.height; i++) {
        const block = await chain.getBlock(i);
        assert(block);
        assert(await orig.chain.add(block));
      }
    });

    it('should mine a competing chain', async () => {
      for (let i = 1; i <= chain.height - 4; i++) {
        const block = await chain.getBlock(i);
        assert(block);
        assert(await comp.chain.add(block));
      }

      while (comp.chain.tip.chainwork.lte(chain.tip.chainwork)) {
        const block = await comp.cpu.mineBlock();
        assert(block);
        assert(await comp.chain.add(block));
      }

      assert(((comp.chain.height - 1) % treeInterval) === 0);
    });

    it('should reorg the auction', async () => {
      let reorgd = false;

      chain.once('reorganize', () => reorgd = true);

      // chain.on('disconnect', async () => {
      //   const ns = await chain.db.getNameStateByName(NAME1);
      //   if (ns)
      //     console.log(ns.format(chain.height, network));
      // });

      for (let i = chain.height - 3; i <= comp.chain.height; i++) {
        assert(!reorgd);
        const block = await comp.chain.getBlock(i);
        assert(block);
        assert(await chain.add(block));
      }

      assert(reorgd);

      // const ns = await chain.db.getNameStateByName(NAME1);
      // assert(!ns);
    });

    it('should reorg back to the correct state', async () => {
      let reorgd = false;

      chain.once('reorganize', () => reorgd = true);

      // chain.on('connect', async () => {
      //   const ns = await chain.db.getNameStateByName(NAME1);
      //   if (ns)
      //     console.log(ns.format(chain.height, network));
      // });

      while (!reorgd) {
        const block = await orig.cpu.mineBlock();
        assert(block);
        assert(await orig.chain.add(block));
        assert(await chain.add(block));
      }

      assert(((chain.height - 2) % treeInterval) === 0);
    });

    it('should close other nodes', async () => {
      await orig.miner.close();
      await orig.chain.close();
      await comp.miner.close();
      await comp.chain.close();
    });

    it.skip('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should have the same DB state', async () => {
      const ns = await chain.db.getNameStateByName(NAME1);
      assert(ns);

      assert.deepStrictEqual(ns, snapshot.ns);
      assert.bufferEqual(chain.tip.treeRoot, snapshot.treeRoot);
    });

    it('should mine 3 blocks', async () => {
      for (let i = 0; i < 3; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open auction', async () => {
      const mtx = await winner.createOpen(NAME2);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should have the same DB root', async () => {
      assert((chain.height % network.names.treeInterval) !== 0);
      const root = chain.db.txn.rootHash();
      await chain.close();
      await chain.open();
      assert.bufferEqual(root, chain.db.txn.rootHash());
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });

  describe('Claim Reorg', function() {
    const node = createNode();
    const {chain, miner, cpu} = node;

    const wallet = node.wallet();
    const recip = node.wallet();

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should reject a fraudulent claim', async () => {
      const claim = await wallet.fakeClaim('cloudflare');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.reason, 'mandatory-script-verify-flag-failed');
    });

    it('should open a claim for cloudflare.com', async () => {
      const claim = await wallet.fakeClaim('cloudflare');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should open a TLD claim for .fr', async () => {
      const claim = await wallet.fakeClaim('fr');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should open a TLD claim for .nl', async () => {
      const claim = await wallet.fakeClaim('nl');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should open a TLD claim for .af', async () => {
      const claim = await wallet.fakeClaim('af');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    /*
    it('should open an i18n-ized TLD claim', async () => {
      const claim = await wallet.fakeClaim('xn--ogbpf8fl');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      assert(block.txs.length > 0);
      assert(block.txs[0].outputs.length === 2);
      assert(block.txs[0].outputs[1].value === 0);

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });
    */

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a claimed name', async () => {
      const mtx = await wallet.createRegister('cloudflare', Buffer.from([1,2]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 140 blocks', async () => {
      for (let i = 0; i < 140; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a claimed name', async () => {
      const mtx = await wallet.createRegister('af', Buffer.from([1,2,3]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should transfer strong name', async () => {
      const addr = recip.createReceive().getAddress();
      const mtx = await wallet.createTransfer('af', addr);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should not be able to finalize early', async () => {
      const mtx = await wallet.createFinalize('af');

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.reason, 'bad-finalize-maturity');
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should finalize name', async () => {
      const mtx = await wallet.createFinalize('af');

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });
});
