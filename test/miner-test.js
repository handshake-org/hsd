/* eslint-env mocha */

'use strict';

const assert = require('bsert');

const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const Mempool = require('../lib/mempool/mempool');
const Miner = require('../lib/mining/miner');
const Address = require('../lib/primitives/address');
const MTX = require('../lib/primitives/mtx');
const MemWallet = require('./util/memwallet');
const {BufferSet} = require('buffer-map');

const workers = new WorkerPool({
  enabled: true
});

const chain = new Chain({
  network: 'regtest',
  memory: true,
  workers
});

const mempool = new Mempool({
  chain,
  memory: true,
  workers
});

const miner = new Miner({
  chain,
  mempool,
  workers
});

const wallet = new MemWallet({
  network: 'regtest'
});

// Dummy address to receive
const addr = new Address({
  version: 0,
  hash: Buffer.alloc(20, 0x88)
});

chain.on('connect', async (entry, block, view) => {
  await mempool._addBlock(entry, block.txs, view);
  wallet.addBlock(entry, block.txs);
});

describe('Miner', function() {
  before(async () => {
    await workers.open();
    await chain.open();
    await mempool.open();
    await miner.open();
  });

  after(async () => {
    await miner.close();
    await mempool.close();
    await workers.close();
    await chain.close();
  });

  let walletAddr;
  const txids = new BufferSet();

  it('should generate 20 blocks to wallet address', async () => {
    walletAddr = wallet.createReceive().getAddress();

    for (let i = 1; i <= 20; i++) {
      assert.bufferEqual(chain.tip.hash, mempool.tip);
      const block = await miner.mineBlock(chain.tip, walletAddr);
      await chain.add(block);
      assert.bufferEqual(chain.tip.hash, mempool.tip);
      assert.strictEqual(chain.tip.height, i);
    }
  });

  it('should mine block with 10 ok-fee transactions', async () => {
    const value = 1 * 1e6;
    const fee = 1000;

    for (let i = 0; i < 10; i++) {
      const change = wallet.createChange().getAddress();
      const coin = wallet.getCoins()[i];
      const mtx = new MTX();
      mtx.addCoin(coin);
      mtx.addOutput(addr, value);
      mtx.addOutput(change, coin.value - value - fee);
      wallet.sign(mtx);
      const tx = mtx.toTX();
      wallet.addTX(tx);
      txids.add(tx.hash());

      await mempool.addTX(tx, -1);
    }

    assert.strictEqual(mempool.map.size, 10);

    const block = await miner.mineBlock(chain.tip, addr);
    await chain.add(block);

    // All 10 TXs are in the block, cleared from the mempool
    assert.strictEqual(mempool.map.size, 0);
    assert.strictEqual(block.txs.length, 11);
    for (let i = 1; i < block.txs.length; i++) {
      assert(txids.has(block.txs[i].hash()));
    }
  });

  it('should not include free transactions in block', async () => {
    // Clear
    txids.clear();
    assert.strictEqual(txids.size, 0);

    // Miner does not have any room for free TXs
    miner.options.minWeight = 0;

    const addr = new Address({
      version: 0,
      hash: Buffer.alloc(20, 0x88)
    });

    const value = 1 * 1e6;
    const fee = 0;

    for (let i = 0; i < 10; i++) {
      const change = wallet.createChange().getAddress();
      const coin = wallet.getCoins()[i];
      const mtx = new MTX();
      mtx.addCoin(coin);
      mtx.addOutput(addr, value);
      mtx.addOutput(change, coin.value - value - fee);
      wallet.sign(mtx);
      const tx = mtx.toTX();
      wallet.addTX(tx);
      txids.add(tx.hash());

      await mempool.addTX(tx, -1);
    }

    assert.strictEqual(mempool.map.size, 10);

    const block = await miner.mineBlock(chain.tip, addr);
    await chain.add(block);

    // All 10 TXs are still in mempool, nothing in block except coinbase
    assert.strictEqual(mempool.map.size, 10);
    assert.strictEqual(block.txs.length, 1);
  });

  it('should include free transactions in block with minWeight', async () => {
    // Now the miner has allocated space for free TXs
    miner.options.minWeight = 10000;

    // Transactions are still in mempool from last test
    assert.strictEqual(mempool.map.size, 10);

    const block = await miner.mineBlock(chain.tip, addr);
    await chain.add(block);

    // All 10 TXs are in the block, cleared from the mempool
    assert.strictEqual(mempool.map.size, 0);
    assert.strictEqual(block.txs.length, 11);
    for (let i = 1; i < block.txs.length; i++) {
      assert(txids.has(block.txs[i].hash()));
    }
  });
});
