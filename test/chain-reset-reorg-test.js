'use strict';

const assert = require('bsert');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const {
  getChainBundle,
  openChainBundle,
  closeChainBundle,
  syncChain,
  chainTreeHasName,
  chainTxnHasName
} = require('./util/chain');

const network = Network.get('regtest');

describe('Chain reorg/reset test', function() {
  let wallet;
  let chainBundle1, chain, mainMiner;
  let chainBundle2, altChain, altMiner;
  let tipHeight = 0;

  const mineBlocksOpens = async (miner, n) => {
    const names = [];

    let tip = miner.chain.tip;

    for (let i = 0; i < n; i++) {
      const job = await miner.cpu.createJob(tip);
      const name = rules.grindName(20, tip.height, network);
      const mtx = await wallet.sendOpen(name);
      assert(job.addTX(mtx.toTX(), mtx.view));
      names.push(name);
      job.refresh();

      const block = await job.mineAsync();
      tip = await miner.chain.add(block);
      assert(tip);
    }

    return names;
  };

  const syncToInterval = async (miner, fromChain, toChain) => {
    const {treeInterval} = network.names;

    if (tipHeight % treeInterval) {
      const leftToInterval = treeInterval - (tipHeight % treeInterval);
      await mineBlocksOpens(miner, leftToInterval);
      await syncChain(fromChain, toChain, tipHeight);
      tipHeight += leftToInterval;
    }
  };

  const beforeHook = async () => {
    tipHeight = 0;

    wallet = new MemWallet({ network });

    chainBundle1 = getChainBundle({
      memory: true,
      workers: true,
      address: wallet.getReceive()
    });

    chainBundle2 = getChainBundle({
      memory: true,
      workers: true,
      address: wallet.getReceive()
    });

    chainBundle1.chain.on('connect', (entry, block) => {
      wallet.addBlock(entry, block.txs);
    });

    chainBundle1.chain.on('disconnect', (entry, block) => {
      wallet.removeBlock(entry, block.txs);
    });

    await openChainBundle(chainBundle1);
    await openChainBundle(chainBundle2);

    chain = chainBundle1.chain;
    mainMiner = chainBundle1.miner;
    altChain = chainBundle2.chain;
    altMiner = chainBundle2.miner;
  };

  const afterHook = async () => {
    await closeChainBundle(chainBundle1);
    await closeChainBundle(chainBundle2);
  };

  describe('Chain reorg', function() {
    this.timeout(10000);
    before(beforeHook);
    after(afterHook);

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await mainMiner.cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
        tipHeight++;
      }

      await syncChain(chain, altChain, 0);
      assert(chain.tip.height, tipHeight);
      assert(altChain.tip.height, tipHeight);
    });

    it('should mine 20 blocks with opens', async () => {
      await mineBlocksOpens(mainMiner, 20);
      await syncChain(chain, altChain, 20);
      tipHeight += 20;
      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);
    });

    it('should reorg 2 blocks and check tree txn (mid interval)', async () => {
      const names0 = await mineBlocksOpens(mainMiner, 1);
      await syncChain(chain, altChain, tipHeight);
      tipHeight++;

      for (const name of names0) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      const root = await chain.db.treeRoot();

      // let's mine 2 on the best first.
      const names1 = await mineBlocksOpens(mainMiner, 2);

      assert.bufferEqual(chain.db.treeRoot(), root);

      for (const name of [...names0, ...names1]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      // mine 3 blocks on alt chain
      const names2 = await mineBlocksOpens(altMiner, 3);
      await syncChain(altChain, chain, tipHeight);
      tipHeight += 3;

      assert.bufferEqual(chain.db.treeRoot(), root);

      for (const name of [...names0, ...names2]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      // these got reorged.
      for (const name of names1) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), false);
      }

      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);

      // This one will commit.
      const names3 = await mineBlocksOpens(mainMiner, 1);
      await syncChain(chain, altChain, tipHeight);
      tipHeight++;

      for (const name of [...names0, ...names2, ...names3]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of names1) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), false);
      }

      assert.notBufferEqual(chain.db.treeRoot(), root);
      // Now txn is empty and its root should be the same as the tree root.
      assert.bufferEqual(chain.db.treeRoot(), chain.db.txn.rootHash());
      assert.bufferEqual(altChain.db.treeRoot(), altChain.db.txn.rootHash());
      assert.bufferEqual(altChain.db.treeRoot(), chain.db.treeRoot());
    });

    it('should reorg 3 blocks and check tree (at interval)', async () => {
      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);

      const root = chain.db.treeRoot();

      // move forward to 48
      const names0 = await mineBlocksOpens(mainMiner, 3);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 3;

      for (const name of names0) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      assert.notBufferEqual(chain.db.txn.rootHash(), root);
      assert.bufferEqual(chain.db.treeRoot(), root);
      assert.strictEqual(chain.tip.height, tipHeight);

      // mine 3 blocks.
      const names1 = await mineBlocksOpens(mainMiner, 3);
      assert.strictEqual(chain.tip.height, tipHeight + 3);

      for (const name of [...names0, ...names1.slice(0, -1)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      assert.strictEqual(await chainTreeHasName(chain, names1[names1.length - 1]), false);
      assert.strictEqual(await chainTxnHasName(chain, names1[names1.length - 1]), true);

      const names2 = await mineBlocksOpens(altMiner, 4);
      await syncChain(altChain, chain, tipHeight);
      tipHeight += 4;

      for (const name of [...names0, ...names2.slice(0, -2)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of [...names2.slice(-2)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of names1) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), false);
      }
    });

    it('should reorg 15 blocks and check tree (multiple intervals)', async () => {
      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);

      // mine 15 blocks.
      const names1 = await mineBlocksOpens(mainMiner, 15);
      assert.strictEqual(chain.tip.height, tipHeight + 15);

      for (const name of [...names1.slice(0, -2)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of [...names1.slice(-2)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      // mine 16 on alt chain.
      const names2 = await mineBlocksOpens(altMiner, 16);
      await syncChain(altChain, chain, tipHeight);
      tipHeight += 16;

      assert.strictEqual(altChain.tip.height, tipHeight);
      assert.strictEqual(chain.tip.height, tipHeight);

      for (const name of [...names2.slice(0, -3)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of [...names2.slice(-3)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of names1) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), false);
      }
    });
  });

  describe('Chain reset', function() {
    this.timeout(10000);
    before(beforeHook);
    after(afterHook);

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await mainMiner.cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
        tipHeight++;
      }

      await syncChain(chain, altChain, 0);
      assert(chain.tip.height, tipHeight);
      assert(altChain.tip.height, tipHeight);
    });

    it('should mine 20 blocks with opens', async () => {
      await mineBlocksOpens(mainMiner, 20);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 20;
      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);
    });

    it('should reset 2 blocks (mid interval)', async () => {
      // move to block forward
      await syncToInterval(mainMiner, chain, altChain);

      const names0 = await mineBlocksOpens(mainMiner, 2);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 2;

      for (const name of names0) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      const root = await chain.db.treeRoot();

      // let's mine 2 on the best first.
      const resetNames = await mineBlocksOpens(mainMiner, 2);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 2;

      assert.bufferEqual(chain.db.treeRoot(), root);

      for (const name of [...names0, ...resetNames]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      await chain.reset(tipHeight - 2);
      for (const name of names0) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of resetNames) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), false);
      }

      await syncChain(altChain, chain, tipHeight - 2);

      for (const name of [...names0, ...resetNames]) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }
    });

    it('should reset 3 blocks (at interval)', async () => {
      await syncToInterval(mainMiner, chain, altChain);

      const names0 = await mineBlocksOpens(mainMiner, 3);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 3;

      for (const name of names0) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      const resetNames = await mineBlocksOpens(mainMiner, 3);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 3;

      for (const name of [...names0, ...resetNames.slice(0, -1)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      const txnName = resetNames[resetNames.length - 1];
      assert.strictEqual(await chainTreeHasName(chain, txnName), false);
      assert.strictEqual(await chainTxnHasName(chain, txnName), true);

      await chain.reset(tipHeight - 3);
      for (const name of names0) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of resetNames) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), false);
      }

      await syncChain(altChain, chain, tipHeight - 3);

      for (const name of [...names0, ...resetNames.slice(0, -1)]) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      assert.strictEqual(await chainTreeHasName(chain, txnName), false);
      assert.strictEqual(await chainTxnHasName(chain, txnName), true);
    });

    it('should mine 18 blocks, reset and resync', async () => {
      await syncToInterval(mainMiner, chain, altChain);

      const names = await mineBlocksOpens(mainMiner, 18);
      await syncChain(chain, altChain, tipHeight);
      tipHeight += 18;

      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);

      const treeNames = names.slice(0, -3);
      const txnNames = names.slice(-3);

      for (const name of treeNames) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of txnNames) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      await chain.reset(tipHeight - 18);
      await syncChain(altChain, chain, tipHeight - 18);

      assert.strictEqual(chain.tip.height, tipHeight);
      assert.strictEqual(altChain.tip.height, tipHeight);

      for (const name of treeNames) {
        assert.strictEqual(await chainTreeHasName(chain, name), true);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }

      for (const name of txnNames) {
        assert.strictEqual(await chainTreeHasName(chain, name), false);
        assert.strictEqual(await chainTxnHasName(chain, name), true);
      }
    });
  });
});
