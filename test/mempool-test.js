/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('./util/assert');
const random = require('bcrypto/lib/random');
const common = require('../lib/blockchain/common');
const Block = require('../lib/primitives/block');
const MempoolEntry = require('../lib/mempool/mempoolentry');
const Mempool = require('../lib/mempool/mempool');
const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const Address = require('../lib/primitives/address');
const Outpoint = require('../lib/primitives/outpoint');
const Input = require('../lib/primitives/input');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const CoinView = require('../lib/coins/coinview');
const MemWallet = require('./util/memwallet');
const MempoolIndexer = require('../lib/mempool/indexer');

const VERIFY_NONE = common.flags.VERIFY_NONE;
const ALL = Script.hashType.ALL;

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;

const workers = new WorkerPool({
  enabled: true
});

const chain = new Chain({
  memory: true,
  workers
});

const mempool = new Mempool({
  chain,
  workers,
  memory: true
});

const wallet = new MemWallet();

let cachedTX = null;

function dummyInput(mempool, addr, hash, value = 70000) {
  const coin = new Coin();
  coin.height = 0;
  coin.value = 0;
  coin.address = addr;
  coin.hash = hash;
  coin.index = 0;

  const fund = new MTX();
  fund.addCoin(coin);
  fund.addOutput(addr, value);

  const [tx, view] = fund.commit();

  const entry = MempoolEntry.fromTX(tx, view, 0);

  mempool.trackEntry(entry, view);

  return Coin.fromTX(fund, 0, -1);
}

async function getMockBlock(chain, txs = [], cb = true) {
  if (cb) {
    const raddr = KeyRing.generate().getAddress();
    const mtx = new MTX();
    mtx.addInput(new Input());
    mtx.addOutput(raddr, 0);
    mtx.setLocktime(chain.tip.height + 1);

    txs = [mtx.toTX(), ...txs];
  }

  const now = Math.floor(Date.now() / 1000);
  const time = chain.tip.time <= now ? chain.tip.time + 1 : now;

  const block = new Block();
  block.txs = txs;
  block.prevBlock = chain.tip.hash;
  block.time = time;
  block.bits = await chain.getTarget(block.time, chain.tip);

  return block;
}

describe('Mempool', function() {
  this.timeout(5000);

  before(async () => {
    await workers.open();
    await chain.open();
    await mempool.open();
  });

  after(async () => {
    await workers.close();
    await chain.close();
    await mempool.close();
  });

  it('should handle incoming orphans and TXs', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const t1 = new MTX();
    t1.addOutput(wallet.getAddress(), 50000);
    t1.addOutput(wallet.getAddress(), 10000);

    const script = Script.fromPubkeyhash(key.getHash());

    t1.addCoin(dummyInput(mempool, addr, ONE_HASH));

    const sig = t1.signature(0, script, 70000, key.privateKey, ALL);

    t1.inputs[0].witness = Witness.fromItems([sig, key.publicKey]);

    // balance: 51000
    wallet.sign(t1);

    const t2 = new MTX();
    t2.addTX(t1, 0); // 50000
    t2.addOutput(wallet.getAddress(), 20000);
    t2.addOutput(wallet.getAddress(), 20000);

    // balance: 49000
    wallet.sign(t2);

    const t3 = new MTX();
    t3.addTX(t1, 1); // 10000
    t3.addTX(t2, 0); // 20000
    t3.addOutput(wallet.getAddress(), 23000);

    // balance: 47000
    wallet.sign(t3);

    const t4 = new MTX();
    t4.addTX(t2, 1); // 24000
    t4.addTX(t3, 0); // 23000
    t4.addOutput(wallet.getAddress(), 11000);
    t4.addOutput(wallet.getAddress(), 11000);

    // balance: 22000
    wallet.sign(t4);

    const f1 = new MTX();
    f1.addTX(t4, 1); // 11000
    f1.addOutput(new Address(), 9000);

    // balance: 11000
    wallet.sign(f1);

    const fake = new MTX();
    fake.addTX(t1, 1); // 1000 (already redeemed)
    fake.addOutput(wallet.getAddress(), 6000); // 6000 instead of 500

    // Script inputs but do not sign
    wallet.template(fake);

    // Fake signature
    const input = fake.inputs[0];
    input.witness.setData(0, Buffer.alloc(65, 0x00));
    input.witness.compile();
    // balance: 11000

    {
      await mempool.addTX(fake.toTX());
      await mempool.addTX(t4.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 70000);
    }

    {
      await mempool.addTX(t1.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 60000);
    }

    {
      await mempool.addTX(t2.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 50000);
    }

    {
      await mempool.addTX(t3.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 22000);
    }

    {
      await mempool.addTX(f1.toTX());

      const balance = mempool.getBalance();
      assert.strictEqual(balance, 20000);
    }

    const txs = mempool.getHistory();
    assert(txs.some((tx) => {
      return tx.hash().equals(f1.hash());
    }));
  });

  it('should handle locktime', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prev = Script.fromPubkeyhash(key.getHash());
    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(mempool, addr, prevHash));
    tx.setLocktime(200);

    chain.tip.height = 200;

    const sig = tx.signature(0, prev, 70000, key.privateKey, ALL);
    tx.inputs[0].witness = Witness.fromItems([sig, key.publicKey]);

    await mempool.addTX(tx.toTX());
    chain.tip.height = 0;
  });

  it('should handle invalid locktime', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prev = Script.fromPubkeyhash(key.getHash());
    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(mempool, addr, prevHash));
    tx.setLocktime(200);
    chain.tip.height = 200 - 1;

    const sig = tx.signature(0, prev, 70000, key.privateKey, ALL);
    tx.inputs[0].witness = Witness.fromItems([sig, key.publicKey]);

    let err;
    try {
      await mempool.addTX(tx.toTX());
    } catch (e) {
      err = e;
    }

    assert(err);

    chain.tip.height = 0;
  });

  it('should not cache a malleated wtx with mutated sig', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(mempool, addr, prevHash));

    const prevs = Script.fromPubkeyhash(key.getKeyHash());

    const sig = tx.signature(0, prevs, 70000, key.privateKey, ALL);
    sig[sig.length - 1] = 0;

    tx.inputs[0].witness = new Witness([sig, key.publicKey]);

    let err;
    try {
      await mempool.addTX(tx.toTX());
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(!mempool.hasReject(tx.hash()));
  });

  it('should not cache non-malleated tx without sig', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const tx = new MTX();
    tx.addOutput(wallet.getAddress(), 50000);
    tx.addOutput(wallet.getAddress(), 10000);

    const prevHash = random.randomBytes(32);

    tx.addCoin(dummyInput(mempool, addr, prevHash));

    let err;
    try {
      await mempool.addTX(tx.toTX());
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(!mempool.hasReject(tx.hash()));

    cachedTX = tx;
  });

  it('should clear reject cache', async () => {
    const tx = new MTX();
    tx.addOutpoint(new Outpoint());
    tx.addOutput(wallet.getAddress(), 50000);

    assert(!mempool.hasReject(cachedTX.hash()));

    await mempool.addBlock({ height: 1 }, [tx.toTX()], new CoinView());

    assert(!mempool.hasReject(cachedTX.hash()));
  });

  describe('Index', function () {
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
      workers,
      memory: true,
      indexAddress: true
    });

    const indexer = new MempoolIndexer({ mempool });

    before(async () => {
      await mempool.open();
      await chain.open();
      await workers.open();
    });

    after(async () => {
      await mempool.close();
      await chain.close();
      await workers.close();
    });

    // number of coins available in chaincoins. (100k satoshi per coin)
    const N = 100;
    const chaincoins = new MemWallet();
    const wallet = new MemWallet();

    it('should create coins in chain', async () => {
      const mtx = new MTX();
      mtx.addInput(new Input());

      for (let i = 0; i < N; i++) {
        const addr = chaincoins.createReceive().getAddress();
        mtx.addOutput(addr, 100000);
      }

      mtx.setLocktime(1);

      const cb = mtx.toTX();
      const block = await getMockBlock(chain, [cb], false);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs, new CoinView());

      // add a block
      // so we don't get premature spend of coinbase.
      {
        const block = await getMockBlock(chain);
        const entry = await chain.add(block, VERIFY_NONE);

        await mempool._addBlock(entry, block.txs);
      }

      chaincoins.addTX(cb);
    });

    it('should spend txs and coins in the mempool', async () => {
      // verify coins are removed from the coin index
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const mtx1 = new MTX();

      mtx1.addCoin(coin);
      mtx1.addOutput(addr, 90000);

      chaincoins.sign(mtx1);

      const tx1 = mtx1.toTX();

      chaincoins.addTX(tx1, -1);
      wallet.addTX(tx1, -1);

      {
        const missing = await mempool.addTX(tx1);
        assert.strictEqual(missing, null);
      }

      assert(mempool.hasCoin(tx1.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const metas = indexer.getMetaByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(metas.length, 1);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(txs[0].hash(), tx1.hash());
        assert.bufferEqual(coins[0].hash, tx1.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      const mtx2 = new MTX();

      mtx2.addTX(tx1, 0, -1);
      mtx2.addOutput(addr, 80000);

      wallet.sign(mtx2);

      const tx2 = mtx2.toTX();

      {
        const missing = await mempool.addTX(tx2);
        assert.strictEqual(missing, null);
      }

      wallet.addTX(tx2, -1);

      assert(!mempool.hasCoin(tx1.hash(), 0));
      assert(mempool.hasCoin(tx2.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 2);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(coins[0].hash, tx2.hash());
        assert.strictEqual(coins[0].index, 0);
      }
    });

    it('should spend resolved orphans', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const pmtx = new MTX();

      pmtx.addOutput(addr, 90000);
      pmtx.addCoin(coin);

      chaincoins.sign(pmtx);

      const parentTX = pmtx.toTX();

      const cmtx = new MTX();

      cmtx.addTX(pmtx.toTX(), 0, -1);
      cmtx.addOutput(addr, 80000);

      wallet.sign(cmtx);

      const childTX = cmtx.toTX();

      {
        // create orphan
        const missing = await mempool.addTX(childTX);

        // we only have one input missing
        assert.strictEqual(missing.length, 1);
      }

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 0);
        assert.strictEqual(coins.length, 0);
      }

      {
        // orphans are not coins
        const childCoin = mempool.getCoin(childTX.hash(), 0);
        assert.strictEqual(childCoin, null);
      }

      {
        // orphans should be resolved.
        const missing = await mempool.addTX(parentTX);
        assert.strictEqual(missing, null);

        // coins should be available once they are resolved
        const parentCoin = mempool.getCoin(parentTX.hash(), 0);
        assert.strictEqual(parentCoin, null); // we spent this.

        const childCoin = mempool.getCoin(childTX.hash(), 0);
        assert(childCoin);
      }

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 2);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(coins[0].hash, childTX.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      // update coins in wallets
      for (const tx of [parentTX, childTX]) {
        chaincoins.addTX(tx);
        wallet.addTX(tx);
      }
    });

    it('should remove double spend tx from mempool', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();
      const randomAddress = KeyRing.generate().getAddress();

      // we check double spending our mempool tx
      const mtx1 = new MTX();

      mtx1.addCoin(coin);
      mtx1.addOutput(addr, 90000);

      chaincoins.sign(mtx1);

      // this will double spend in block
      const mtx2 = new MTX();

      mtx2.addCoin(coin);
      mtx2.addOutput(randomAddress, 90000);

      chaincoins.sign(mtx2);

      const tx1 = mtx1.toTX();
      const tx2 = mtx2.toTX();

      {
        const missing = await mempool.addTX(tx1);
        assert.strictEqual(missing, null);
      }

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(coins[0].hash, tx1.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      assert(mempool.hasCoin(tx1.hash(), 0));

      const block = await getMockBlock(chain, [tx2]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs, new CoinView());

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 0);
        assert.strictEqual(coins.length, 0);
      }

      assert(!mempool.hasCoin(tx1.hash(), 0));

      chaincoins.addTX(tx2);
    });

    it('should remove confirmed txs from indexer', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const mtx = new MTX();

      mtx.addCoin(coin);
      mtx.addOutput(addr, 90000);

      chaincoins.sign(mtx);

      const tx = mtx.toTX();

      await mempool.addTX(tx);

      assert(mempool.hasCoin(tx.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(coins[0].hash, tx.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      const block = await getMockBlock(chain, [tx]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs, new CoinView());

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 0);
        assert.strictEqual(coins.length, 0);
      }

      assert(!mempool.hasCoin(tx.hash(), 0));

      chaincoins.addTX(tx);
      wallet.addTX(tx);
    });

    it('should add coin from orphan once resolved in a block', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();

      const pmtx = new MTX();

      pmtx.addCoin(coin);
      pmtx.addOutput(addr, 90000);

      chaincoins.sign(pmtx);

      const parentTX = pmtx.toTX();
      const cmtx = new MTX();

      cmtx.addTX(parentTX, 0, -1);
      cmtx.addOutput(addr, 80000);

      wallet.sign(cmtx);

      const childTX = cmtx.toTX();

      {
        const missing = await mempool.addTX(childTX);
        assert.strictEqual(missing.length, 1);
      }

      {
        // verify we don't have coins have not changed.
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 0);
        assert.strictEqual(coins.length, 0);
      }

      const block = await getMockBlock(chain, [parentTX]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs, new CoinView());

      assert(mempool.hasCoin(childTX.hash(), 0));

      {
        // verify resolved orphan is new coin
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(txs[0].hash(), childTX.hash());
        assert.bufferEqual(coins[0].hash, childTX.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      chaincoins.addTX(parentTX);
      wallet.addTX(parentTX);
      wallet.addTX(childTX);
    });

    it('should recover coin form partial double spend', async () => {
      const coins = chaincoins.getCoins();
      const coin1 = coins[0];
      const coin2 = coins[1];
      const addr = wallet.createReceive().getAddress();
      const raddr = KeyRing.generate().getAddress();

      // this will get double spent in a block
      const mtx1 = new MTX();

      mtx1.addCoin(coin1);
      mtx1.addOutput(addr, 90000);

      chaincoins.sign(mtx1);

      const tx1 = mtx1.toTX();

      // this should recover as coin
      const mtx2 = new MTX();

      mtx2.addCoin(coin2);
      mtx2.addOutput(addr, 90000);

      chaincoins.sign(mtx2);

      const tx2 = mtx2.toTX();

      // this will get orphaned because of double spend
      const mtx3 = new MTX();

      mtx3.addTX(tx1, 0, -1);
      mtx3.addTX(tx2, 0, -1);
      mtx3.addOutput(raddr, 170000);

      wallet.sign(mtx3);
      const tx3 = mtx3.toTX();

      // this double spends mtx1
      const mtx4 = new MTX();

      mtx4.addCoin(coin1);
      mtx4.addOutput(raddr, 90000);

      chaincoins.sign(mtx4);

      const tx4 = mtx4.toTX();

      {
        const missing = await mempool.addTX(tx1);
        assert.strictEqual(missing, null);

        assert(mempool.hasCoin(tx1.hash(), 0));
      }

      {
        const missing = await mempool.addTX(tx2);
        assert.strictEqual(missing, null);

        assert(mempool.hasCoin(tx1.hash(), 0));
        assert(mempool.hasCoin(tx2.hash(), 0));
      }

      {
        const missing = await mempool.addTX(tx3);
        assert.strictEqual(missing, null);

        assert(!mempool.hasCoin(tx1.hash(), 0));
        assert(!mempool.hasCoin(tx2.hash(), 0));
        assert(mempool.hasCoin(tx3.hash(), 0));
      }

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 3);
        assert.strictEqual(coins.length, 0);
      }

      const block = await getMockBlock(chain, [tx4]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs, new CoinView());
      assert(!mempool.hasCoin(tx1.hash(), 0));
      assert(mempool.hasCoin(tx2.hash(), 0));
      assert(!mempool.hasCoin(tx3.hash(), 0));
      assert(!mempool.hasCoin(tx4.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(coins[0].hash, tx2.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      {
        // raddr does not have anything left in the mempool
        const txs = indexer.getTXByAddress(raddr);
        const coins = indexer.getCoinsByAddress(raddr);

        assert.strictEqual(txs.length, 0);
        assert.strictEqual(coins.length, 0);
      }

      chaincoins.addBlock(entry, block.txs);
      wallet.addBlock(entry, block.txs);

      chaincoins.addTX(tx2);
      wallet.addTX(tx2);
    });

    it('should make unconfirmed coins available', async () => {
      const coin = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();
      const raddr = KeyRing.generate().getAddress();

      const pmtx = new MTX();

      pmtx.addCoin(coin);
      pmtx.addOutput(addr, 90000);

      chaincoins.sign(pmtx);

      const ptx = pmtx.toTX();

      const cmtx = new MTX();

      cmtx.addTX(ptx, 0, -1);
      cmtx.addOutput(raddr, 80000);

      wallet.sign(cmtx);

      const ctx = cmtx.toTX();

      {
        const missing = await mempool.addTX(ptx);
        assert.strictEqual(missing, null);
      }

      assert(mempool.hasCoin(ptx.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(coins.length, 1);

        assert.bufferEqual(coins[0].hash, ptx.hash());
        assert.strictEqual(coins[0].index, 0);
      }

      {
        const missing = await mempool.addTX(ctx);
        assert.strictEqual(missing, null);
      }

      assert(!mempool.hasCoin(ptx.hash(), 0));
      assert(mempool.hasCoin(ctx.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 2);
        assert.strictEqual(coins.length, 0);
      }

      const block = await getMockBlock(chain, [ptx]);
      const entry = await chain.add(block, VERIFY_NONE);

      await mempool._addBlock(entry, block.txs, new CoinView());

      assert(!mempool.hasCoin(ptx.hash(), 0));
      assert(mempool.hasCoin(ctx.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 1);
        assert.strictEqual(coins.length, 0);
      }

      await chain.disconnect(entry);
      await mempool._removeBlock(entry, block.txs);

      assert(!mempool.hasCoin(ptx.hash(), 0));
      assert(mempool.hasCoin(ctx.hash(), 0));

      {
        const txs = indexer.getTXByAddress(addr);
        const coins = indexer.getCoinsByAddress(addr);

        assert.strictEqual(txs.length, 2);
        assert.strictEqual(coins.length, 0);
      }
    });
  });
});
