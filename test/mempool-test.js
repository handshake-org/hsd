/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const MempoolEntry = require('../lib/mempool/mempoolentry');
const Mempool = require('../lib/mempool/mempool');
const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const ChainEntry = require('../lib/blockchain/chainentry');
const MTX = require('../lib/primitives/mtx');
const Claim = require('../lib/primitives/claim');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const Address = require('../lib/primitives/address');
const Outpoint = require('../lib/primitives/outpoint');
const Input = require('../lib/primitives/input');
const Block = require('../lib/primitives/block');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const CoinView = require('../lib/coins/coinview');
const util = require('../lib/utils/util');
const consensus = require('../lib/protocol/consensus');
const MemWallet = require('./util/memwallet');
const ALL = Script.hashType.ALL;
const common = require('../lib/blockchain/common');
const VERIFY_BODY = common.flags.VERIFY_BODY;
const rules = require('../lib/covenants/rules');
const {types} = rules;
const NameState = require('../lib/covenants/namestate');
const {states} = NameState;
const ownership = require('../lib/covenants/ownership');

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;

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

  describe('Mempool disconnect and reorg handling', function () {
    const workers = new WorkerPool({
      // Must be disabled for `ownership.ignore`.
      enabled: false
    });

    const chain = new Chain({
      memory: true,
      workers,
      network: 'regtest'
    });

    const mempool = new Mempool({
      chain,
      workers,
      memory: true
    });

    const COINBASE_MATURITY = mempool.network.coinbaseMaturity;
    const TREE_INTERVAL = mempool.network.names.treeInterval;
    mempool.network.names.auctionStart = 0;

    before(async () => {
      await mempool.open();
      await chain.open();
      await workers.open();
    });

    after(async () => {
      await workers.close();
      await chain.close();
      await mempool.close();
    });

    // Number of coins available in
    // chaincoins (100k satoshi per coin).
    const N = 100;
    const chaincoins = new MemWallet({
      network: 'regtest'
    });

    chain.on('block', (block, entry) => {
      chaincoins.addBlock(entry, block.txs);
    });

    chain.on('disconnect', (entry, block) => {
      chaincoins.removeBlock(entry, block.txs);
    });

    chaincoins.getNameStatus = async (nameHash) => {
      assert(Buffer.isBuffer(nameHash));
      const height = chain.height + 1;
      const state = await chain.getNextState();
      const hardened = state.hasHardening();
      return chain.db.getNameStatus(nameHash, height, hardened);
    };

    async function getMockBlock(chain, txs = [], cb = true) {
      if (cb) {
        const raddr = KeyRing.generate().getAddress();
        const mtx = new MTX();
        mtx.addInput(new Input());
        mtx.addOutput(raddr, 0);
        mtx.locktime = chain.height + 1;

        txs = [mtx.toTX(), ...txs];
      }

      const view = new CoinView();
      for (const tx of txs) {
        view.addTX(tx, -1);
      }

      const now = Math.floor(Date.now() / 1000);
      const time = chain.tip.time <= now ? chain.tip.time + 1 : now;

      const block = new Block();
      block.txs = txs;
      block.prevBlock = chain.tip.hash;
      block.time = time;
      block.bits = await chain.getTarget(block.time, chain.tip);

      // Ensure mockblocks are unique (required for reorg testing)
      block.merkleRoot = block.createMerkleRoot();
      block.witnessRoot = block.createWitnessRoot();
      block.treeRoot = chain.db.treeRoot();

      return [block, view];
    }

    it('should create coins in chain', async () => {
      const mtx = new MTX();
      mtx.locktime = chain.height + 1;
      mtx.addInput(new Input());

      for (let i = 0; i < N; i++) {
        const addr = chaincoins.createReceive().getAddress();
        mtx.addOutput(addr, 100000);
      }

      const cb = mtx.toTX();
      const [block] = await getMockBlock(chain, [cb], false);
      const entry = await chain.add(block, VERIFY_BODY);

      await mempool._addBlock(entry, block.txs);

      // Add 100 blocks so we don't get
      // premature spend of coinbase.
      for (let i = 0; i < 100; i++) {
        const [block] = await getMockBlock(chain);
        const entry = await chain.add(block, VERIFY_BODY);

        await mempool._addBlock(entry, block.txs);
      }

      chaincoins.addTX(cb);
    });

    it('should insert unconfirmed txs from removed block', async () => {
      await mempool.reset();
      // Mempool is empty
      assert.strictEqual(mempool.map.size, 0);

      // Create 1 TX
      const coin1 = chaincoins.getCoins()[0];
      const addr = wallet.createReceive().getAddress();
      const mtx1 = new MTX();
      mtx1.addCoin(coin1);
      mtx1.addOutput(addr, 90000);
      chaincoins.sign(mtx1);
      const tx1 = mtx1.toTX();
      chaincoins.addTX(tx1);
      wallet.addTX(tx1);

      // Create 1 block (no need to actually add it to chain)
      const [block1] = await getMockBlock(chain, [tx1]);
      const entry1 = await ChainEntry.fromBlock(block1, chain.tip);

      // Unconfirm block into mempool
      await mempool._removeBlock(entry1, block1.txs);

      // Mempool should contain newly unconfirmed TX
      assert(mempool.hasEntry(tx1.hash()));

      // Mempool is NOT empty
      assert.strictEqual(mempool.map.size, 1);

      // Create second TX
      const coin2 = chaincoins.getCoins()[0];
      const mtx2 = new MTX();
      mtx2.addCoin(coin2);
      mtx2.addOutput(addr, 90000);
      chaincoins.sign(mtx2);
      const tx2 = mtx2.toTX();
      chaincoins.addTX(tx2);
      wallet.addTX(tx2);

      // Create 1 block (no need to actually add it to chain)
      const [block2] = await getMockBlock(chain, [tx2]);
      const entry2 = await ChainEntry.fromBlock(block2, chain.tip);

      // Unconfirm block into mempool
      await mempool._removeBlock(entry2, block2.txs);
      await mempool._handleReorg();

      // Mempool should contain both TXs
      assert(mempool.hasEntry(tx2.hash()));
      assert(mempool.hasEntry(tx1.hash()));
      assert.strictEqual(mempool.map.size, 2);

      // Ensure mempool contents are valid in next block
      const [newBlock, newView] = await getMockBlock(chain, [tx1, tx2]);
      const newEntry = await chain.add(newBlock, VERIFY_BODY);
      await mempool._addBlock(newEntry, newBlock.txs, newView);
      assert.strictEqual(mempool.map.size, 0);
    });

    it('should handle reorg: coinbase spends', async () => {
      // Mempool is empty
      await mempool.reset();
      assert.strictEqual(mempool.map.size, 0);

      // Create a fresh coinbase tx
      let cb = new MTX();
      cb.addInput(new Input());
      const addr = chaincoins.createReceive().getAddress();
      cb.addOutput(addr, 100000);
      cb.locktime = chain.height + 1;
      cb = cb.toTX();

      // Add it to block and mempool
      const [block1, view1] = await getMockBlock(chain, [cb], false);
      const entry1 = await chain.add(block1, VERIFY_BODY);
      await mempool._addBlock(entry1, block1.txs, view1);

      // The coinbase output is a valid UTXO in the chain
      assert(await chain.getCoin(cb.hash(), 0));

      // Mempool is empty
      assert.strictEqual(mempool.map.size, 0);

      // Attempt to spend the coinbase early
      let spend = new MTX();
      spend.addTX(cb, 0);
      spend.addOutput(addr, 90000);
      chaincoins.sign(spend);
      spend = spend.toTX();

      // It's too early
      await assert.rejects(async () => {
        await mempool.addTX(spend, -1);
      }, {
        name: 'Error',
        reason: 'bad-txns-premature-spend-of-coinbase'
      });

      // Add more blocks
      let block2;
      let view2;
      let entry2;
      for (let i = 0; i < COINBASE_MATURITY - 1; i++) {
        [block2, view2] = await getMockBlock(chain);
        entry2 = await chain.add(block2, VERIFY_BODY);

        await mempool._addBlock(entry2, block2.txs, view2);
      }

      // Try again
      await mempool.addTX(spend, -1);

      // Coinbase spend is in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(spend.hash()));

      // Confirm coinbase spend in a block
      const [block3, view3] = await getMockBlock(chain, [spend]);
      const entry3 = await chain.add(block3, VERIFY_BODY);
      await mempool._addBlock(entry3, block3.txs, view3);

      // Coinbase spend has been removed from the mempool
      assert.strictEqual(mempool.map.size, 0);
      assert(!mempool.getTX(spend.hash()));

      // Now the block gets disconnected
      await chain.disconnect(entry3);
      await mempool._removeBlock(entry3, block3.txs);
      await mempool._handleReorg();

      // Coinbase spend is back in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(spend.hash()));

      // Now remove one more block from the chain, thus
      // making the spend TX premature
      await chain.disconnect(entry2);
      await mempool._removeBlock(entry2, block2.txs);

      // Coinbase spend is still in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(spend.hash()));

      // This is normally triggered by 'reorganize' event
      await mempool._handleReorg();

      // Premature coinbase spend has been evicted
      assert.strictEqual(mempool.map.size, 0);
      assert(!mempool.getTX(spend.hash()));
    });

    it('should handle reorg: BIP68 sequence locks', async () => {
      // Mempool is empty
      await mempool.reset();
      assert.strictEqual(mempool.map.size, 0);

      // Create a fresh UTXO
      const fundCoin = chaincoins.getCoins()[0];
      let fund = new MTX();
      fund.addCoin(fundCoin);
      const addr = chaincoins.createReceive().getAddress();
      fund.addOutput(addr, 90000);
      chaincoins.sign(fund);
      fund = fund.toTX();
      chaincoins.addTX(fund);

      // Add it to block and mempool
      const [block1, view1] = await getMockBlock(chain, [fund]);
      const entry1 = await chain.add(block1, VERIFY_BODY);
      await mempool._addBlock(entry1, block1.txs, view1);

      // The fund TX output is a valid UTXO in the chain
      const spendCoin = await chain.getCoin(fund.hash(), 0);
      assert(spendCoin);

      // Mempool is empty
      assert.strictEqual(mempool.map.size, 0);

      // Spend the coin with a sequence lock of 0x00000001.
      // This should require the input coin to be 1 block old.
      let spend = new MTX();
      spend.addCoin(spendCoin);
      spend.addOutput(addr, 70000);
      spend.inputs[0].sequence = 1;
      spend.version = 0;
      chaincoins.sign(spend);
      spend = spend.toTX();

      // Valid spend into mempool
      await mempool.addTX(spend);
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(spend.hash()));

      // Confirm spend into block
      const [block2, view2] = await getMockBlock(chain, [spend]);
      const entry2 = await chain.add(block2, VERIFY_BODY);
      await mempool._addBlock(entry2, block2.txs, view2);

      // Spend has been removed from the mempool
      assert.strictEqual(mempool.map.size, 0);
      assert(!mempool.getTX(spend.hash()));

      // Now the block gets disconnected
      await chain.disconnect(entry2);
      await mempool._removeBlock(entry2, block2.txs);
      await mempool._handleReorg();

      // Spend is back in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(spend.hash()));

      // Now remove one more block from the chain,
      // re-inserting the funding TX back into the mempool.
      // This should make the sequence-locked spend invalid
      // because its input coin is no lnger 1 block old.
      await chain.disconnect(entry1);
      await mempool._removeBlock(entry1, block1.txs);

      // Fund TX & spend TX are both still in the mempool
      assert.strictEqual(mempool.map.size, 2);
      assert(mempool.getTX(spend.hash()));
      assert(mempool.getTX(fund.hash()));

      // This is normally triggered by 'reorganize' event
      await mempool._handleReorg();

      // Premature sequence lock spend has been evicted, fund TX remains
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(fund.hash()));
      assert(!mempool.getTX(spend.hash()));

      // Ensure mempool contents are valid in next block
      const [newBlock, newView] = await getMockBlock(chain, [fund]);
      const newEntry = await chain.add(newBlock, VERIFY_BODY);
      await mempool._addBlock(newEntry, newBlock.txs, newView);
      assert.strictEqual(mempool.map.size, 0);
    });

    it('should handle reorg: covenants', async () => {
      // Mempool is empty
      await mempool.reset();
      assert.strictEqual(mempool.map.size, 0);

      // Create a fresh UTXO with an OPEN
      const openCoin = chaincoins.getCoins()[0];
      let open = new MTX();
      open.addCoin(openCoin);
      const addr = chaincoins.createReceive().getAddress();
      open.addOutput(addr, 90000);

      const name = rules.grindName(5, 0, mempool.network);
      const rawName = Buffer.from(name, 'ascii');
      const nameHash = rules.hashName(rawName);
      open.outputs[0].covenant.type = types.OPEN;
      open.outputs[0].covenant.pushHash(nameHash);
      open.outputs[0].covenant.pushU32(0);
      open.outputs[0].covenant.push(rawName);

      chaincoins.sign(open);
      open = open.toTX();

      // Add it to block and mempool
      const [block1, view1] = await getMockBlock(chain, [open]);
      const entry1 = await chain.add(block1, VERIFY_BODY);
      await mempool._addBlock(entry1, block1.txs, view1);

      // The open TX output is a valid UTXO in the chain
      assert(await chain.getCoin(open.hash(), 0));

      // Name is OPEN
      let ns = await chain.db.getNameStateByName(name);
      assert.strictEqual(
        ns.state(chain.height, mempool.network),
        states.OPENING
      );

      // Mempool is empty
      assert.strictEqual(mempool.map.size, 0);

      // Create a BID on the name.
      // We don't need a real blind.
      const bidCoin = chaincoins.getCoins()[1];
      let bid = new MTX();
      bid.addCoin(bidCoin);
      bid.addOutput(addr, 70000);

      bid.outputs[0].covenant.type = types.BID;
      bid.outputs[0].covenant.pushHash(nameHash);
      bid.outputs[0].covenant.pushU32(ns.height);
      bid.outputs[0].covenant.push(rawName);
      bid.outputs[0].covenant.pushHash(Buffer.alloc(32, 0x01));

      chaincoins.sign(bid);
      bid = bid.toTX();

      // It's too early
      await assert.rejects(async () => {
        await mempool.addTX(bid, -1);
      }, {
        name: 'Error',
        reason: 'invalid-covenant'
      });

      // Add more blocks
      let block2;
      let view2;
      let entry2;
      for (let i = 0; i < TREE_INTERVAL; i++) {
        [block2, view2] = await getMockBlock(chain);
        entry2 = await chain.add(block2, VERIFY_BODY);

        await mempool._addBlock(entry2, block2.txs, view2);
      }

      // BIDDING is activated in the next block
      // Bid is allowed in mempool.
      ns = await chain.db.getNameStateByName(name);
      assert.strictEqual(
        ns.state(chain.height + 1, mempool.network),
        states.BIDDING
      );

      // Try again
      await mempool.addTX(bid, -1);

      // Bid is in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(bid.hash()));

      // Confirm bid into block
      const [block3, view3] = await getMockBlock(chain, [bid]);
      const entry3 = await chain.add(block3, VERIFY_BODY);
      await mempool._addBlock(entry3, block3.txs, view3);

      // Bid has been removed from the mempool
      assert.strictEqual(mempool.map.size, 0);
      assert(!mempool.getTX(bid.hash()));

      // Now the block gets disconnected
      await chain.disconnect(entry3);
      await mempool._removeBlock(entry3, block3.txs);
      await mempool._handleReorg();

      // Bid is back in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(bid.hash()));

      // BIDDING re-activates on the next block, so bid is allowed in mempool.
      ns = await chain.db.getNameStateByName(name);
      assert.strictEqual(
        ns.state(chain.height + 1, mempool.network),
        states.BIDDING
      );

      // Now remove one more block from the chain,
      // re-inserting the opening TX back into the mempool.
      // This should make the bid covenant invalid
      // because the name is no longer in the BIDDING phase.
      await chain.disconnect(entry2);
      await mempool._removeBlock(entry2, block2.txs);

      // Bid TX is in the mempool
      assert.strictEqual(mempool.map.size, 1);
      assert(mempool.getTX(bid.hash()));

      // ...but BIDDING does NOT activate on the next block.
      ns = await chain.db.getNameStateByName(name);
      assert.notStrictEqual(
        ns.state(chain.height + 1, mempool.network),
        states.BIDDING
      );

      // This is normally triggered by 'reorganize' event
      await mempool._handleReorg();

      // Premature bid covenant TX has been evicted
      assert.strictEqual(mempool.map.size, 0);
      assert(!mempool.getTX(bid.hash()));
    });

    it('should handle reorg: name claim - DNSSEC timestamp', async () => {
      // Mempool is empty
      await mempool.reset();
      assert.strictEqual(mempool.map.size, 0);

      // Create a fake claim
      const claim = await chaincoins.fakeClaim('cloudflare');

      // It's too early to add this claim.
      // Note: If the regtest genesis block time stamp is ever changed,
      // it's possible it will conflict with the actual timestamps in the
      // RRSIG in the actual DNSSEC proof for cloudflare and break this test.
      await assert.rejects(async () => {
        await mempool.addClaim(claim);
      }, {
        name: 'Error',
        reason: 'bad-claim-time'
      });

      // Fast-forward the next block's timestamp to allow claim.
      const data = claim.getData(mempool.network);
      const [block1] = await getMockBlock(chain);
      block1.time = data.inception + 100;
      let entry1;
      try {
        ownership.ignore = true;
        entry1 = await chain.add(block1, VERIFY_BODY);
      } finally {
        ownership.ignore = false;
      }

      // Now we can add it to the mempool.
      try {
        ownership.ignore = true;
        await mempool.addClaim(claim);
      } finally {
        ownership.ignore = false;
      }
      assert.strictEqual(mempool.claims.size, 1);
      assert(mempool.getClaim(claim.hash()));

      // Confirm the claim in the next block.
      // Note: Claim.toTX() creates a coinbase-shaped TX
      const cb = claim.toTX(mempool.network, chain.tip.height + 1);
      cb.locktime = chain.tip.height + 1;
      const [block2, view2] = await getMockBlock(chain, [cb], false);
      let entry2;
      try {
        ownership.ignore = true;
        entry2 = await chain.add(block2, VERIFY_BODY);
        await mempool._addBlock(entry2, block2.txs, view2);
      } finally {
        ownership.ignore = false;
      }

      // Mempool is empty
      assert.strictEqual(mempool.claims.size, 0);
      assert.strictEqual(mempool.map.size, 0);

      // Now the block gets disconnected
      await chain.disconnect(entry2);
      await mempool._removeBlock(entry2, block2.txs);
      await mempool._handleReorg();

      // Claim is back in the mempool
      assert.strictEqual(mempool.claims.size, 1);
      assert(mempool.getClaim(claim.hash()));

      // Now remove one more block from the chain, making the tip
      // way too old for the claim's inception timestamp.
      await chain.disconnect(entry1);
      await mempool._removeBlock(entry1, block1.txs);

      // Claim is still in the mempool.
      assert.strictEqual(mempool.claims.size, 1);
      assert(mempool.getClaim(claim.hash()));

      // This is normally triggered by 'reorganize' event
      await mempool._handleReorg();

      // Premature claim has been evicted
      assert.strictEqual(mempool.map.size, 0);
      assert.strictEqual(mempool.claims.size, 0);
      assert(!mempool.getClaim(claim.hash()));
    });

    it('should handle reorg: name claim - block commitment', async () => {
      // Mempool is empty
      await mempool.reset();
      assert.strictEqual(mempool.map.size, 0);

      // Create a fake claim - just to get the correct timestamps
      let claim = await chaincoins.fakeClaim('cloudflare');

      // Fast-forward the next block's timestamp to allow claim.
      const data = claim.getData(mempool.network);
      const [block1] = await getMockBlock(chain);
      block1.time = data.inception + 10000;
      try {
        ownership.ignore = true;
        await chain.add(block1, VERIFY_BODY);
      } finally {
        ownership.ignore = false;
      }

      // Add a few more blocks
      let block2;
      let view2;
      let entry2;
      for (let i = 0; i < 10; i++) {
        [block2, view2] = await getMockBlock(chain);
        entry2 = await chain.add(block2, VERIFY_BODY);

        await mempool._addBlock(entry2, block2.txs, view2);
      }

      // Update the claim with a *very recent* block commitment
      // but keep the RRSIG and its timestamps.
      // For reference:
      // createData(address, fee, commitHash, commitHeight, network)
      const newData = ownership.createData(
        {
          version: data.version,
          hash: data.hash
        },
        data.fee,
        chain.tip.hash,
        chain.tip.height,
        mempool.network
      );
      const newProof = claim.getProof();
      ownership.removeData(newProof);
      newProof.addData([newData]);
      claim = Claim.fromProof(newProof);

      // Now we can add it to the mempool.
      try {
        ownership.ignore = true;
        await mempool.addClaim(claim);
      } finally {
        ownership.ignore = false;
      }
      assert.strictEqual(mempool.claims.size, 1);
      assert(mempool.getClaim(claim.hash()));

      // Confirm the claim in the next block.
      // Note: Claim.toTX() creates a coinbase-shaped TX
      const cb = claim.toTX(mempool.network, chain.tip.height + 1);
      cb.locktime = chain.tip.height + 1;
      const [block3, view3] = await getMockBlock(chain, [cb], false);
      let entry3;
      try {
        ownership.ignore = true;
        entry3 = await chain.add(block3, VERIFY_BODY);
        await mempool._addBlock(entry3, block3.txs, view3);
      } finally {
        ownership.ignore = false;
      }

      // Mempool is empty
      assert.strictEqual(mempool.claims.size, 0);
      assert.strictEqual(mempool.map.size, 0);

      // Now the block gets disconnected
      await chain.disconnect(entry3);
      await mempool._removeBlock(entry3, block3.txs);
      await mempool._handleReorg();

      // Claim is back in the mempool
      assert.strictEqual(mempool.claims.size, 1);
      assert(mempool.getClaim(claim.hash()));

      // Now remove one more block from the chain, making the tip
      // too old for the claim's block commitment.
      await chain.disconnect(entry2);
      await mempool._removeBlock(entry2, block2.txs);

      // Claim is still in the mempool.
      assert.strictEqual(mempool.claims.size, 1);
      assert(mempool.getClaim(claim.hash()));

      // This is normally triggered by 'reorganize' event
      await mempool._handleReorg();

      // Premature claim has been evicted
      assert.strictEqual(mempool.map.size, 0);
      assert.strictEqual(mempool.claims.size, 0);
      assert(!mempool.getClaim(claim.hash()));

      // Sanity-check that the claim wasn't removed due to timestamps
      assert(chain.tip.time > data.inception);
      assert(chain.tip.time < data.expiration);
    });
  });

  describe('Mempool eviction', function () {
    // Computed in advance with MempoolEntry.memUsage()
    const txMemUsage = 1728;
    // Should allow 9 transactions in mempool.
    // The 10th transaction will push the mempool size over 100% of the limit.
    // Mempool will then remove two transactions to get under 90% limit.
    const maxSize = txMemUsage * 10 - 1;
    // 1 hour
    const expiryTime = 60 * 60;

    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const chain = new Chain({
      memory: true,
      workers,
      network: 'regtest'
    });

    const mempool = new Mempool({
      chain,
      workers,
      memory: true,
      maxSize,
      expiryTime
    });

    before(async () => {
      await mempool.open();
      await chain.open();
      await workers.open();
    });

    after(async () => {
      await workers.close();
      await chain.close();
      await mempool.close();
    });

    // Number of coins available in
    // chaincoins (100k satoshi per coin).
    const N = 100;
    const chaincoins = new MemWallet();
    const wallet = new MemWallet();

    async function getMockBlock(chain, txs = [], cb = true) {
      if (cb) {
        const raddr = KeyRing.generate().getAddress();
        const mtx = new MTX();
        mtx.addInput(new Input());
        mtx.addOutput(raddr, 0);
        mtx.locktime = chain.height + 1;

        txs = [mtx.toTX(), ...txs];
      }

      const view = new CoinView();
      for (const tx of txs) {
        view.addTX(tx, -1);
      }

      const now = Math.floor(Date.now() / 1000);
      const time = chain.tip.time <= now ? chain.tip.time + 1 : now;

      const block = new Block();
      block.txs = txs;
      block.prevBlock = chain.tip.hash;
      block.time = time;
      block.bits = await chain.getTarget(block.time, chain.tip);

      // Ensure mockblocks are unique (required for reorg testing)
      block.merkleRoot = block.createMerkleRoot();
      block.witnessRoot = block.createWitnessRoot();
      block.treeRoot = chain.db.treeRoot();

      return [block, view];
    }

    it('should create coins in chain', async () => {
      const mtx = new MTX();
      mtx.locktime = chain.height + 1;
      mtx.addInput(new Input());

      for (let i = 0; i < N; i++) {
        const addr = chaincoins.createReceive().getAddress();
        mtx.addOutput(addr, 100000);
      }

      const cb = mtx.toTX();
      const [block] = await getMockBlock(chain, [cb], false);
      const entry = await chain.add(block, VERIFY_BODY);

      await mempool._addBlock(entry, block.txs);

      // Add 100 blocks so we don't get
      // premature spend of coinbase.
      for (let i = 0; i < 100; i++) {
        const [block] = await getMockBlock(chain);
        const entry = await chain.add(block, VERIFY_BODY);

        await mempool._addBlock(entry, block.txs);
      }

      chaincoins.addTX(cb);
    });

    it('should limit mempool size', async () => {
      let expectedSize = 0;

      for (let i = 0; i < N; i++) {
        // Spend a different coin each time to avoid exceeding max ancestors.
        const coin = chaincoins.getCoins()[i];
        const addr = wallet.createReceive().getAddress();

        const mtx = new MTX();
        mtx.addCoin(coin);
        // Increment fee with each TX so oldest TX gets evicted first.
        // Otherwise the new TX might be the one that gets evicted,
        // resulting in a "mempool full" error instead.
        mtx.addOutput(addr, 90000 - (10 * i));
        chaincoins.sign(mtx);
        const tx = mtx.toTX();

        expectedSize += txMemUsage;

        if (expectedSize < maxSize) {
          await mempool.addTX(tx);
        } else {
          assert(i >= 9);
          let evicted = false;
          mempool.once('remove entry', () => {
            evicted = true;
            // We've exceeded the max size by 1 TX
            // Mempool will remove 2 TXs to get below 90% limit.
            expectedSize -= txMemUsage * 2;
          });
          await mempool.addTX(tx);
          assert(evicted);
        }
      }
    });

    it('should evict old transactions', async () => {
      // Clear mempool. Note that TXs in last test were not
      // added to the wallet: we can re-spend those coins.
      await mempool.reset();

      let now = 0;
      const original = util.now;
      try {
        util.now = () => {
          return now;
        };

        // After we cross the expiry threshold, one TX at a time
        // will start to expire, starting with the oldest.
        const sent = [];
        let evicted = 0;
        mempool.on('remove entry', (entry) => {
          const expected = sent.shift();
          assert.bufferEqual(entry.tx.hash(), expected);
          evicted++;
        });

        for (let i = 0; i < N; i++) {
          // Spend a different coin each time to avoid exceeding max ancestors.
          const coin = chaincoins.getCoins()[i];
          const addr = wallet.createReceive().getAddress();

          const mtx = new MTX();
          mtx.addCoin(coin);
          mtx.addOutput(addr, 90000);
          chaincoins.sign(mtx);
          const tx = mtx.toTX();

          sent.push(tx.hash());

          // mempool size is not a factor
          assert(mempool.size  + (txMemUsage * 2) < maxSize);

          await mempool.addTX(tx);

          // Time travel forward ten minutes
          now += 60 * 10;

          // The first 6 TXs are added without incident.
          // After that, a virtual hour will have passed, and
          // each new TX will trigger the eviction of one old TX.
          if (i < 6) {
            assert(mempool.map.size === i + 1);
          } else {
            assert(mempool.map.size === 6);
            assert.strictEqual(evicted, (i + 1) - 6);
          }
        }
      } finally {
        util.now = original;
      }
    });
  });
});
