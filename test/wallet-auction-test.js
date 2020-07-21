/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const {states} = require('../lib/covenants/namestate');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const WalletDB = require('../lib/wallet/walletdb');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const Address = require('../lib/primitives/address');

const network = Network.get('regtest');
const NAME1 = rules.grindName(5, 2, network);
const {
  treeInterval,
  biddingPeriod,
  revealPeriod

} = network.names;

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
  let winner, openAuctionMTX, openAuctionMTX2;

  before(async () => {
    // Open
    await chain.open();
    await miner.open();
    await wdb.open();

    // Set up wallet
    winner = await wdb.create();
    chain.on('connect', async (entry, block) => {
      await wdb.addBlock(entry, block.txs);
    });

    // Generate blocks to roll out name and fund wallet
    let winnerAddr = await winner.createReceive();
    winnerAddr = winnerAddr.getAddress().toString(network);
    for (let i = 0; i < 4; i++) {
      const block = await cpu.mineBlock(null, winnerAddr);
      await chain.add(block);
    }
  });

  after(async () => {
    await wdb.close();
    await miner.close();
    await chain.close();
  });

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
    for (let i = 0; i < treeInterval; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }
  });

  it('should fail to send bid to null address', async () => {
    const mtx = await winner.makeBid(NAME1, 1000, 2000, 0);
    mtx.outputs[0].address = new Address();
    await winner.fill(mtx);
    await winner.finalize(mtx);

    const fn = async () => await winner.sendMTX(mtx);

    await assert.rejects(fn, {message: 'Cannot send to null address.'});
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
    for (let i = 0; i < biddingPeriod + revealPeriod; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }
  });

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

  it('should confirm OPEN transaction', async () => {
    const job = await cpu.createJob();
    job.addTX(openAuctionMTX2.toTX(), openAuctionMTX2.view);
    job.refresh();

    const block = await job.mineAsync();
    assert(await chain.add(block));

    let ns = await chain.db.getNameStateByName(NAME1);
    let state = ns.state(chain.height, network);
    assert.strictEqual(state, states.OPENING);

    for (let i = 0; i < treeInterval + 1; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    ns = await chain.db.getNameStateByName(NAME1);
    state = ns.state(chain.height, network);
    assert.strictEqual(state, states.BIDDING);
  });
});
