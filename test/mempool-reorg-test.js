'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const {Resource} = require('../lib/dns/resource');
const FullNode = require('../lib/node/fullnode');
const plugin = require('../lib/wallet/plugin');

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
    await node.open();
    wallet = node.get('walletdb').wdb.primary;
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

  async function getConfirmedResource() {
    const res = await node.rpc.getNameResource([name]);
    return res.records[0].txt[0];
  }

  function getMempoolResource() {
    if (!node.mempool.map.size)
      return null;

    assert.strictEqual(node.mempool.map.size, 1);
    const {tx} = node.mempool.map.toValues()[0];
    const res = Resource.decode(tx.outputs[0].covenant.items[2]);
    return res.records[0].txt[0];
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

    assert.strictEqual(await getConfirmedResource(), '0');
  });

  it('should generate UPDATE chain', async () => {
    for (let i = 0; i < 10; i++) {
      await wallet.sendUpdate(
        name,
        makeResource(),
        {selection: 'age'} // avoid spending coinbase early
      );
      await node.rpc.generate([1]);
    }
  });

  it('should shallow reorg chain', async () => {
    // Initial state
    assert.strictEqual(await getConfirmedResource(), '10');

    // Mempool is empty
    assert.strictEqual(getMempoolResource(), null);

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
    assert.strictEqual(await getConfirmedResource(), '7');

    // Mempool is NOT empty, "next" tx is waiting
    assert.strictEqual(getMempoolResource(), '8');

    // This next block would be invalid in our own chain
    // if mempool was corrupted with the wrong tx from the reorg.
    await node.rpc.generate([1]);

    // State after new block
    assert.strictEqual(await getConfirmedResource(), '8');

    // Mempool is again NOT empty, "next NEXT" tx is waiting
    assert.strictEqual(getMempoolResource(), '9');

    // One more
    await node.rpc.generate([1]);
    assert.strictEqual(await getConfirmedResource(), '9');
    assert.strictEqual(getMempoolResource(), '10');

    // Finally
    await node.rpc.generate([1]);
    assert.strictEqual(await getConfirmedResource(), '10');
    assert.strictEqual(getMempoolResource(), null);
  });

  it('should deep reorg chain', async () => {
    // Initial state
    assert.strictEqual(await getConfirmedResource(), '10');

    // Mempool is empty
    assert.strictEqual(getMempoolResource(), null);

    // Reorganize beyond tree interval
    const waiter = new Promise((resolve) => {
      node.once('reorganize', () => {
        resolve();
      });
    });

    const depth = 12;
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
    assert.strictEqual(await getConfirmedResource(), '2');
    assert.strictEqual(getMempoolResource(), '3');

    // Confirm entire update chain one by one
    await node.rpc.generate([8]);
    assert.strictEqual(await getConfirmedResource(), '10');
    assert.strictEqual(getMempoolResource(), null);
  });
});
