'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const {Resource} = require('../lib/dns/resource');
const FullNode = require('../lib/node/fullnode');
const plugin = require('../lib/wallet/plugin');
const Coin = require('../lib/primitives/coin');
const Address = require('../lib/primitives/address');
const MTX = require('../lib/primitives/mtx');
const {forEvent} = require('./util/common');

const network = Network.get('regtest');
const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

describe('Mempool Covenant Reorg', function () {
  const node = new FullNode({
    network: 'regtest'
  });
  node.use(plugin);

  let wallet, name;

  before(async () => {
    const wdb = node.require('walletdb').wdb;
    const syncDone = forEvent(wdb, 'sync done');
    await node.open();

    wallet = node.get('walletdb').wdb.primary;

    await syncDone;
  });

  after(async () => {
    await node.close();
  });

  let counter = 0;
  function makeResource() {
    return Resource.fromJSON({
      records: [{type: 'TXT', txt: [`${counter++}`]}]
    });
  }

  it('should fund wallet and win name', async () => {
    await node.rpc.generate([10]);
    name = await node.rpc.grindName([3]);
    await wallet.sendOpen(name, true);
    await node.rpc.generate([treeInterval + 1]);
    await wallet.sendBid(name, 10000, 20000);
    await node.rpc.generate([biddingPeriod]);
    await wallet.sendReveal(name);
    await node.rpc.generate([revealPeriod]);
    await node.rpc.generate([1]);
    await wallet.sendUpdate(name, makeResource());
    await node.rpc.generate([1]);

    const check = await node.rpc.getNameResource([name]);
    assert.deepStrictEqual(
      check,
      {records: [{type: 'TXT', txt: ['0']}]}
    );
  });

  it('should generate UPDATE chain', async () => {
    for (let i = 0; i < 10; i++) {
      await wallet.sendUpdate(name, makeResource());
      await node.rpc.generate([1]);
    }

    const check = await node.rpc.getNameResource([name]);
    assert.deepStrictEqual(
      check,
      {records: [{type: 'TXT', txt: ['10']}]}
    );
  });

  it('should shallow reorg chain', async () => {
    // Initial state
    const res1 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res1.records[0].txt[0], '10');

    // Mempool is empty
    assert.strictEqual(node.mempool.map.size, 0);

    // Do not reorg beyond tree interval
    assert(node.chain.height % treeInterval === 3);

    // Reorganize
    const waiter = new Promise((resolve) => {
      node.once('reorganize', () => {
        resolve();
      });
    });

    const depth = 3;
    let entry = await node.chain.getEntryByHeight(node.chain.height - depth);
    for (let i = 0; i <= depth; i++) {
      const block = await node.miner.cpu.mineBlock(entry);
      entry = await node.chain.add(block);
    }
    await waiter;

    // State after reorg
    const res2 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res2.records[0].txt[0], '7');

    // Mempool is NOT empty, "next" tx is waiting
    assert.strictEqual(node.mempool.map.size, 1);
    const tx = Array.from(node.mempool.map.values())[0].tx;
    const res3 = Resource.decode(tx.outputs[0].covenant.items[2]);
    assert.strictEqual(res3.records[0].txt[0], '8');

    // This next block would be invalid in our own chain
    // if mempool was corrupted with the wrong tx from the reorg.
    await node.rpc.generate([1]);

    // State after new block
    const res4 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res4.records[0].txt[0], '8');
  });

  it('should deep reorg chain', async () => {
    // Initial state
    const res1 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res1.records[0].txt[0], '8');

    // Mempool is empty
    assert.strictEqual(node.mempool.map.size, 0);

    // Reorganize beyond tree interval
    const waiter = new Promise((resolve) => {
      node.once('reorganize', () => {
        resolve();
      });
    });

    const depth = 5;
    let entry = await node.chain.getEntryByHeight(node.chain.height - depth);
    // Intentionally forking from historical tree interval requires dirty hack
    const {treeRoot} = await node.chain.getEntryByHeight(node.chain.height - depth + 1);
    await node.chain.db.tree.inject(treeRoot);
    for (let i = 0; i <= depth; i++) {
      const block = await node.miner.cpu.mineBlock(entry);
      entry = await node.chain.add(block);
    }
    await waiter;

    // State after reorg
    const res2 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res2.records[0].txt[0], '7');

    // Mempool is NOT empty, "next" tx is waiting
    assert.strictEqual(node.mempool.map.size, 1);
    const tx = Array.from(node.mempool.map.values())[0].tx;
    const res3 = Resource.decode(tx.outputs[0].covenant.items[2]);
    assert.strictEqual(res3.records[0].txt[0], '8');

    // This next block would be invalid in our own chain
    // if mempool was corrupted with the wrong tx from the reorg.
    await node.rpc.generate([1]);

    // State after new block
    const res4 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res4.records[0].txt[0], '8');
  });

  it('should not remove child with no name covenants', async () => {
    // Clear
    await wallet.zap(0, 0);

    // Find the change output of last UPDATE
    const {owner} = await node.chain.db.getNameStateByName(name);
    const {height, tx} = await wallet.getTX(owner.hash);
    assert.strictEqual(tx.outputs[0].covenant.type, 7); // UPDATE
    assert.strictEqual(tx.outputs[1].covenant.type, 0); // NONE

    // We will send 2 TXs, wait for both to enter mempool
    const waiter = new Promise((resolve) => {
      let count = 0;

      node.mempool.on('tx', () => {
        if (++count === 2)
          resolve();
      });
    });

    // Spend the change without covenant
    const coin = Coin.fromTX(tx, 1, height);
    const addr = new Address({
      version: 0,
      hash: Buffer.alloc(20, 0xfe)
    });
    const childNone = new MTX();
    childNone.addCoin(coin);
    childNone.addOutput(addr, coin.value - 10000);
    await wallet.sendMTX(childNone);

    // Also send another UPDATE
    const childUpdate = await wallet.sendUpdate(name, makeResource());

    // Both should be in mempool
    await waiter;
    assert.strictEqual(node.mempool.map.size, 2);
    assert(node.mempool.getTX(childNone.hash()));
    assert(node.mempool.getTX(childUpdate.hash()));

    // Reorg, from some other miner with an empty mempool
    node.miner.mempool = null;
    const depth = 1;
    let entry = await node.chain.getEntryByHeight(node.chain.height - depth);
    for (let i = 0; i <= depth; i++) {
      const block = await node.miner.cpu.mineBlock(entry);
      entry = await node.chain.add(block);
    }

    // State after reorg
    const res1 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res1.records[0].txt[0], '7');
    assert.strictEqual(node.mempool.map.size, 2);

    // The last confirmed name update is now back in mempool
    assert(node.mempool.getTX(tx.hash()));
    // The new change-spend is fine even though it's parent is also in mempool
    assert(node.mempool.getTX(childNone.hash()));
    // The new update TX is completely gone
    assert(!node.mempool.getTX(childUpdate.hash()));

    // Everything should be valid in next block
    node.miner.mempool = node.mempool;
    await node.rpc.generate([1]);
    assert.strictEqual(node.mempool.map.size, 0);
    // State after new block
    const res2 = await node.rpc.getNameResource([name]);
    assert.strictEqual(res2.records[0].txt[0], '8');
  });
});
