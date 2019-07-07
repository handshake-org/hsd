/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const MempoolEntry = require('../lib/mempool/mempoolentry');
const Mempool = require('../lib/mempool/mempool');
const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const Address = require('../lib/primitives/address');
const Outpoint = require('../lib/primitives/outpoint');
const Block = require('../lib/primitives/block');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const CoinView = require('../lib/coins/coinview');
const util = require('../lib/utils/util');
const consensus = require('../lib/protocol/consensus');
const MemWallet = require('./util/memwallet');
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
  memory: true,
  workers
});

const wallet = new MemWallet();

let cachedTX = null;

function dummyInput(addr, hash) {
  const coin = new Coin();
  coin.height = 0;
  coin.value = 0;
  coin.address = addr;
  coin.hash = hash;
  coin.index = 0;

  const fund = new MTX();
  fund.addCoin(coin);
  fund.addOutput(addr, 70000);

  const [tx, view] = fund.commit();

  const entry = MempoolEntry.fromTX(tx, view, 0);

  mempool.trackEntry(entry, view);

  return Coin.fromTX(fund, 0, -1);
}

async function dummyBlock(txs, coinbase = false) {
  if (coinbase) {
    const cb = new MTX();
    cb.locktime = chain.height + 1;
    txs = [cb, ...txs];
  }

  const view = new CoinView();
  for (const tx of txs) {
    view.addTX(tx, -1);
  }

  const now = util.now();
  const time = chain.tip.time <= now ? chain.tip.time + 1 : now;

  const block = new Block({
    version: 1,
    prevBlock: Buffer.from(chain.tip.hash, 'hex'),
    merkleRoot: random.randomBytes(32),
    witnessRoot: random.randomBytes(32),
    treeRoot: random.randomBytes(32),
    reservedRoot: random.randomBytes(32),
    time: time,
    bits: await chain.getTarget(time, chain.tip),
    nonce: 0,
    extraNonce: Buffer.alloc(consensus.NONCE_SIZE),
    mask: random.randomBytes(32),
    txs: txs
  });

  return [block, view];
}

describe('Mempool', function() {
  this.timeout(5000);

  it('should open mempool', async () => {
    await workers.open();
    await chain.open();
    await mempool.open();
  });

  it('should handle incoming orphans and TXs', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const t1 = new MTX();
    t1.addOutput(wallet.getAddress(), 50000);
    t1.addOutput(wallet.getAddress(), 10000);

    const script = Script.fromPubkeyhash(key.getHash());

    t1.addCoin(dummyInput(addr, ONE_HASH));

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

    tx.addCoin(dummyInput(addr, prevHash));
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

    tx.addCoin(dummyInput(addr, prevHash));
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

    tx.addCoin(dummyInput(addr, prevHash));

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

    tx.addCoin(dummyInput(addr, prevHash));

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

  it('should remove tx after being included in block', async () => {
    const key = KeyRing.generate();
    const addr = key.getAddress();

    const t1 = new MTX();
    {
      t1.addOutput(wallet.getAddress(), 50000);
      t1.addOutput(wallet.getAddress(), 10000);

      const script = Script.fromPubkeyhash(key.getHash());

      t1.addCoin(dummyInput(addr, ONE_HASH));

      const sig = t1.signature(0, script, 70000, key.privateKey, ALL);
      t1.inputs[0].witness = Witness.fromItems([sig, key.publicKey]);
      await mempool.addTX(t1.toTX());
    }

    const t2 = new MTX();
    {
      const key = KeyRing.generate();
      const addr = key.getAddress();

      t2.addOutput(wallet.getAddress(), 50000);
      t2.addOutput(wallet.getAddress(), 10000);

      const script = Script.fromPubkeyhash(key.getHash());

      t2.addCoin(dummyInput(addr, ONE_HASH));

      const sig = t2.signature(0, script, 70000, key.privateKey, ALL);
      t2.inputs[0].witness = Witness.fromItems([sig, key.publicKey]);
      await mempool.addTX(t2.toTX());
    }

    const [block, view] = await dummyBlock([t1], true);

    {
      const entry = await mempool.getEntry(t1.hash());
      assert.equal(entry.txid(), t1.txid());
    }

    await mempool.addBlock(block, block.txs, view);

    {
      const entry = await mempool.getEntry(t1.hash());
      assert.equal(entry, undefined);
    }

    {
      const tx = t2.toTX();
      const entry = await mempool.getEntry(tx.hash());
      assert.equal(entry.txid(), tx.txid());
    }
  });

  it('should destroy mempool', async () => {
    await mempool.close();
    await chain.close();
    await workers.close();
  });
});
