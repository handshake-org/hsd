/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const WalletDB = require('../lib/wallet/walletdb');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');

const network = Network.get('regtest');
const NAME1 = rules.grindName(10, 20, network);

const workers = new WorkerPool({
  enabled: false
});

const chain = new Chain({
  memory: true,
  network,
  workers
});

const miner = new Miner({
  chain,
  workers
});

const cpu = miner.cpu;

const wdb = new WalletDB({
  network: network,
  workers: workers
});

describe('Wallet Auction', function() {
  this.timeout(15000);

  let winner;
  const currentCBMaturity = network.coinbaseMaturity;

  before(() => {
    network.coinbaseMaturity = 1;
  });

  after(() => {
    network.coinbaseMaturity = currentCBMaturity;
  });

  it('should open chain, miner and wallet', async () => {
    await chain.open();
    await miner.open();
    await wdb.open();

    winner = await wdb.create();

    chain.on('connect', async (entry, block) => {
      await wdb.addBlock(entry, block.txs);
    });
  });

  it('should add addrs to miner', async () => {
    const addr = await winner.createReceive();
    miner.addresses = [addr.getAddress().toString(network)];
  });

  it('should mine 20 blocks', async () => {
    for (let i = 0; i < 20; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }
  });

  let openAuctionMTX;
  it('should open auction', async () => {
    openAuctionMTX = await winner.createOpen(NAME1, false);
    await winner.sign(openAuctionMTX);
    const tx = openAuctionMTX.toTX();
    await wdb.addTX(tx);
  });

  it('should fail to create duplicate open', async () => {
    let err;
    try {
      await winner.createOpen(NAME1, false);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, `Already sent an open for: ${NAME1}.`);
  });

  it('should mine 1 block', async () => {
    const job = await cpu.createJob();
    job.addTX(openAuctionMTX.toTX(), openAuctionMTX.view);
    job.refresh();

    const block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should fail to re-open auction during OPEN phase', async () => {
    let err;
    try {
      await winner.createOpen(NAME1, false);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, 'Name is already opening.');
  });

  it('should mine enough blocks to enter BIDDING phase', async () => {
    for (
      let i = 0;
      i < network.names.treeInterval;
      i++
    ) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }
  });

  it('should fail to re-open auction during BIDDING phase', async () => {
    let err;
    try {
      await winner.createOpen(NAME1, false);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, 'Name is not available.');
  });

  it('should mine enough blocks to expire auction', async () => {
    for (
      let i = 0;
      i < network.names.biddingPeriod + network.names.revealPeriod;
      i++
    ) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }
  });

  let openAuctionMTX2;
  it('should open auction (again)', async () => {
    openAuctionMTX2 = await winner.createOpen(NAME1, false);
    await winner.sign(openAuctionMTX2);
    const tx = openAuctionMTX2.toTX();
    await wdb.addTX(tx);
  });

  it('should fail to create duplicate open (again)', async () => {
    let err;
    try {
      await winner.createOpen(NAME1, false);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, `Already sent an open for: ${NAME1}.`);
  });

  it('should mine 1 block', async () => {
    const job = await cpu.createJob();
    job.addTX(openAuctionMTX2.toTX(), openAuctionMTX2.view);
    job.refresh();

    const block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should cleanup', async () => {
    await miner.close();
    await chain.close();
  });
});
