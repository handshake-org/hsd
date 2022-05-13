'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const {forEvent} = require('./util/common');

const ports = {
  full: {
    p2p: 14041,
    node: 14042,
    wallet: 14043,
    nsPort: 25449,
    rsPort: 25450
  },
  spv: {
    p2p: 14141,
    node: 14142,
    wallet: 14143,
    nsPort: 25549,
    rsPort: 25550
  }
};

const node = new FullNode({
  network: 'regtest',
  workers: true,
  listen: true,
  bip37: true,
  port: ports.full.p2p,
  httpPort: ports.full.node,
  nsPort: ports.full.nsPort,
  rsPort: ports.full.rsPort,
  maxOutbound: 1,
  seeds: [],
  memory: true,
  plugins: [require('../lib/wallet/plugin')],
  env: {
    'HSD_WALLET_HTTP_PORT': (ports.full.wallet).toString()
  }
});

const spvnode = new SPVNode({
  network: 'regtest',
  workers: true,
  listen: true,
  port: ports.spv.p2p,
  httpPort: ports.spv.node,
  nsPort: ports.spv.nsPort,
  rsPort: ports.spv.rsPort,
  maxOutbound: 1,
  seeds: [],
  nodes: [`127.0.0.1:${ports.full.p2p}`],
  memory: true,
  plugins: [require('../lib/wallet/plugin')],
  env: {
    'HSD_WALLET_HTTP_PORT': (ports.spv.wallet).toString()
  }
});

const chain = node.chain;
const miner = node.miner;
const {wdb: fullwdb} = node.require('walletdb');
const {wdb: spvwdb} = spvnode.require('walletdb');

// Test reorg size must be lower than this.
// This is used to set temporary coinbase maturity,
// so reorged coinbases don't end up in the coin selector
// for Full node wallet.
const REORG_MAX = 15;

let wallet = null;
let spvwallet = null;
let spvaddr = null;
let tip1 = null;
let tip2 = null;

async function mineBlock(tip) {
  const job = await miner.createJob(tip);
  return await job.mineAsync();
}

describe('SPV Node Sync', function() {
  this.timeout(10000);
  // back up
  const coinbaseMaturity = node.network.coinbaseMaturity;

  before(async () => {
    await node.open();
    await spvnode.open();
    await node.connect();
    await spvnode.connect();
    spvnode.startSync();
    node.network.coinbaseMaturity = REORG_MAX + 1;
  });

  after(async () => {
    await node.close();
    await spvnode.close();
    node.network.coinbaseMaturity = coinbaseMaturity;
  });

  it('should check SPV is synced to fullnode', async () => {
    assert.deepStrictEqual(node.chain.tip, spvnode.chain.tip);
  });

  it('should open miner and wallets', async () => {
    wallet = await fullwdb.create();
    miner.addresses.length = 0;
    miner.addAddress(await wallet.receiveAddress());

    spvwallet = await spvwdb.create();
    spvaddr = await spvwallet.receiveAddress();
  });

  it('should mine 90 blocks', async () => {
    for (let i = 0; i < 90; i++) {
      const block = await miner.mineBlock();
      assert(block);

      const spvBlockEvent = forEvent(spvnode, 'block');

      await chain.add(block);

      // Check SPV & Full nodes are in sync
      await spvBlockEvent;

      assert.deepStrictEqual(node.chain.tip, spvnode.chain.tip);
    }
    // Full node wallet needs to catch up to miner
    await fullwdb.rescan(0);
  });

  it('should mine competing chains of 10 blocks', async function () {
    for (let i = 0; i < 10; i++) {
      const block1 = await mineBlock(tip1);
      const block2 = await mineBlock(tip2);

      const spvBlockEvent = forEvent(spvnode, 'block');
      await chain.add(block1);
      await chain.add(block2);

      assert.bufferEqual(chain.tip.hash, block1.hash());

      tip1 = await chain.getEntry(block1.hash());
      tip2 = await chain.getEntry(block2.hash());

      assert(tip1);
      assert(tip2);

      assert(!await chain.isMainChain(tip2));

      // Check SPV & Full nodes are in sync after every block
      await spvBlockEvent;

      assert.deepStrictEqual(node.chain.tip, spvnode.chain.tip);
    }
  });

  it('should send a tx from chain 1 to SPV node', async () => {
    const balanceEvent = forEvent(spvwallet, 'balance');
    await wallet.send({
      outputs: [{
        value: 1012345678,
        address: spvaddr
      }]
    });

    await balanceEvent;
    const balance = await spvwallet.getBalance();
    assert.strictEqual(balance.unconfirmed, 1012345678);
  });

  it('should mine a block and confirm a tx', async () => {
    const blockEvent = forEvent(spvnode, 'block');
    const balanceEvent = forEvent(spvwallet, 'balance');

    const block = await miner.mineBlock();
    assert(block);
    await chain.add(block);

    // Check SPV & Full nodes are in sync
    await blockEvent;
    assert.deepStrictEqual(node.chain.tip, spvnode.chain.tip);

    // Check SPV wallet balance
    await balanceEvent;
    const balance = await spvwallet.getBalance();
    assert.strictEqual(balance.confirmed, 1012345678);
  });

  it('should handle a reorg', async () => {
    assert.strictEqual(chain.height, 101);

    // Main chain is ahead by 1 block now, catch the alt chain up
    const entry = await chain.getEntry(tip2.hash);
    const block1 = await miner.mineBlock(entry);
    await chain.add(block1);
    const entry1 = await chain.getEntry(block1.hash());
    assert(entry1);

    // Tie game!
    assert.strictEqual(chain.height, entry1.height);

    // Now reorg main chain by adding a block to alt chain
    const block2 = await miner.mineBlock(entry1);
    assert(block2);

    const spvReorgedEvent = forEvent(spvnode, 'reorganize');
    const spvResetEvent = forEvent(spvnode, 'reset');
    let spvBlockEvents;

    let forked = false;
    let tipHash, competitorHash, forkHash;

    chain.once('reorganize', (tip, competitor, fork) => {
      // We will need to wait for competitor.height - fork.height blocks.
      spvBlockEvents = forEvent(
        spvnode,
        'block',
        competitor.height - fork.height
      );

      tipHash = tip.hash;
      competitorHash = competitor.hash;
      forkHash = fork.hash;

      forked = true;
    });

    await chain.add(block2);

    assert(forked);
    assert.bufferEqual(chain.tip.hash, block2.hash());
    assert(chain.tip.chainwork.gt(tip1.chainwork));

    // Wait for all events.
    // And collect event responses for later checks.
    const [reorgs, resets, blocks] = await Promise.all([
      spvReorgedEvent,
      spvResetEvent,
      spvBlockEvents
    ]);

    {
      // We only had 1 reorganize event, make sure
      // tip, competitor, fork of the reorg match with
      // chain reorganize event. Checking SPV is doing
      // the exact same reorg.
      const [tip, competitor, fork] = reorgs[0].values;
      assert.bufferEqual(tip.hash, tipHash);
      assert.bufferEqual(competitor.hash, competitorHash);
      assert.bufferEqual(fork.hash, forkHash);
    }

    {
      // Make sure SPV reset to the FORK point.
      const [resetToEntry] = resets[0].values;
      assert.bufferEqual(resetToEntry.hash, forkHash);
    }

    {
      // We receive competitorHash.height - fork.height block events.
      // Make sure last block event is the same as full node chain.tip.
      const lastBlockHash = blocks.pop().values[0].hash();
      assert.bufferEqual(lastBlockHash, node.chain.tip.hash);
    }

    assert.deepStrictEqual(node.chain.tip, spvnode.chain.tip);
  });

  it('should mine a block after a reorg', async () => {
    const blockEvent = forEvent(spvnode, 'block');
    const block = await miner.mineBlock(node.chain.tip);
    await chain.add(block);

    // Check SPV & Full nodes are in sync
    await blockEvent;

    assert.deepStrictEqual(node.chain.tip, spvnode.chain.tip);

    const entry = await chain.getEntry(block.hash());
    assert(entry);
    assert.bufferEqual(chain.tip.hash, entry.hash);

    const result = await chain.isMainChain(entry);
    assert(result);
  });

  it('should unconfirm tx after reorg', async () => {
    const balance = await spvwallet.getBalance();
    assert.strictEqual(balance.unconfirmed, 1012345678);
  });
});
