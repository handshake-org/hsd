'use strict';

const assert = require('bsert');

const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Mempool = require('../lib/mempool/mempool');
const Miner = require('../lib/mining/miner');
const Address = require('../lib/primitives/address');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const MemWallet = require('./util/memwallet');
const {BufferSet} = require('buffer-map');

const workers = new WorkerPool({
  enabled: true,
  size: 2
});

const blocks = new BlockStore({
  network: 'regtest',
  memory: true
});

const chain = new Chain({
  network: 'regtest',
  blocks: blocks,
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
  this.timeout(10000);

  before(async () => {
    await workers.open();
    await blocks.open();
    await chain.open();
    await mempool.open();
    await miner.open();
  });

  after(async () => {
    await miner.close();
    await mempool.close();
    await chain.close();
    await blocks.close();
    await workers.close();
  });

  let walletAddr;
  const txids = new BufferSet();
  let coin, parentTX;

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

   it('should not include free transaction in a block', async () => {
    // Miner does not have any room for free TXs
    miner.options.minWeight = 0;

    const value = 1 * 1e6;
    const fee = 0;

    // Get a change address
    const change = wallet.createChange().getAddress();
    const mtx = new MTX();
    coin = wallet.getCoins()[0];
    mtx.addCoin(coin);
    mtx.addOutput(addr, value);
    mtx.addOutput(change, coin.value - value - fee); // no fee
    wallet.sign(mtx);
    parentTX = mtx.toTX();

    await mempool.addTX(parentTX, -1);
    assert.strictEqual(mempool.map.size, 1);

    const block = await miner.mineBlock(chain.tip, addr);
    await chain.add(block);

    // TX is still in mempool, nothing in block except coinbase
    assert.strictEqual(mempool.map.size, 1);
    assert.strictEqual(block.txs.length, 1);
  });

  it('should fail to double spend the coin - duplicate tx in mempool', async () => {
    const value = 1 * 1e6;
    const fee = 1000;
    const mtx = new MTX();

    const change = wallet.createChange().getAddress();
    mtx.addCoin(coin);
    mtx.addOutput(addr, value);
    mtx.addOutput(change, coin.value - value - fee);
    wallet.sign(mtx);
    const tx = mtx.toTX();

    assert.rejects(
      async () => await mempool.addTX(tx, -1),
      {
        code: 'duplicate',
        reason: 'bad-txns-inputs-spent'
      }
    );
    // orignal tx is still in mempool
    assert.strictEqual(mempool.map.size, 1);
  });

  it('should include child transaction if child pays enough fee (CPFP)', async () => {
    const fee = 1000;

    // Fee should be enough for both the first transation and second transaction
    assert(fee > 140 + 108);

    const mtx = new MTX();
    const change = wallet.createChange().getAddress();
    const coin = Coin.fromTX(parentTX, 1, -1);

    mtx.addCoin(coin);
    mtx.addOutput(change, coin.value - fee);
    wallet.sign(mtx);
    const tx = mtx.toTX();
    await mempool.addTX(tx, -1);
    // Both transactions in mempool
    assert.strictEqual(mempool.map.size, 2);

    const block = await miner.mineBlock(chain.tip, addr);
    await chain.add(block);

    // Both transactions should get mined into the block
    assert.strictEqual(mempool.map.size, 0);
    assert.strictEqual(block.txs.length, 3);
  });
});
