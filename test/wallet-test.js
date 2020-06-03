/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-implicit-coercion: "off" */

'use strict';

const assert = require('bsert');
const {WalletClient} = require('hs-client');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const util = require('../lib/utils/util');
const blake2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');
const FullNode = require('../lib/node/fullnode');
const WalletDB = require('../lib/wallet/walletdb');
const WorkerPool = require('../lib/workers/workerpool');
const Address = require('../lib/primitives/address');
const MTX = require('../lib/primitives/mtx');
const ChainEntry = require('../lib/blockchain/chainentry');
const {Resource} = require('../lib/dns/resource');
const Block = require('../lib/primitives/block');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const Input = require('../lib/primitives/input');
const Outpoint = require('../lib/primitives/outpoint');
const Output = require('../lib/primitives/output');
const Script = require('../lib/script/script');
const policy = require('../lib/protocol/policy');
const HDPrivateKey = require('../lib/hd/private');
const Wallet = require('../lib/wallet/wallet');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const {forValue} = require('./util/common');

const KEY1 = 'xprv9s21ZrQH143K3Aj6xQBymM31Zb4BVc7wxqfUhMZrzewdDVCt'
  + 'qUP9iWfcHgJofs25xbaUpCps9GDXj83NiWvQCAkWQhVj5J4CorfnpKX94AZ';

const KEY2 = 'xprv9s21ZrQH143K3mqiSThzPtWAabQ22Pjp3uSNnZ53A5bQ4udp'
  + 'faKekc2m4AChLYH1XDzANhrSdxHYWUeTWjYJwFwWFyHkTMnMeAcW4JyRCZa';

const enabled = true;
const network = Network.get('main');
const workers = new WorkerPool({ enabled });
const wdb = new WalletDB({ network, workers });

let currentWallet = null;
let importedWallet = null;
let importedKey = null;
let doubleSpendWallet = null;
let doubleSpendCoin = null;
let watchWallet = null;

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}

function curBlock(wdb) {
  return fakeBlock(wdb.state.height);
};

function nextBlock(wdb) {
  return fakeBlock(wdb.state.height + 1);
}

function fakeBlock(height) {
  const prev = blake2b.digest(fromU32((height - 1) >>> 0));
  const hash = blake2b.digest(fromU32(height >>> 0));
  const root = blake2b.digest(fromU32((height | 0x80000000) >>> 0));

  return {
    hash: hash,
    prevBlock: prev,
    merkleRoot: root,
    time: 500000000 + (height * (10 * 60)),
    bits: 0,
    nonce: 0,
    height: height,
    version: 0,
    witnessRoot: Buffer.alloc(32),
    treeRoot: Buffer.alloc(32),
    reservedRoot: Buffer.alloc(32),
    extraNonce: Buffer.alloc(24),
    mask: Buffer.alloc(32)
  };
}

function curEntry(wdb) {
  return new ChainEntry(curBlock(wdb));
}

function nextEntry(wdb) {
  const cur = curEntry(wdb);
  const next = new Block(nextBlock(wdb));
  return ChainEntry.fromBlock(next, cur);
}

function dummyInput() {
  const hash = random.randomBytes(32);
  return Input.fromOutpoint(new Outpoint(hash, 0));
}

describe('Wallet', function() {
  this.timeout(5000);

  it('should open walletdb', async () => {
    network.coinbaseMaturity = 1;
    await wdb.open();
  });

  it('should add blocks to wdb to pass txStart', async () => {
    // Because these tests are written for mainnet.
    while (wdb.height < network.txStart) {
      await wdb.addBlock(nextBlock(wdb), []);
    }
  });

  it('should generate new key and address', async () => {
    const wallet = await wdb.create();

    const addr1 = await wallet.receiveAddress();
    assert(addr1);

    const str = addr1.toString(wdb.network);
    const addr2 = Address.fromString(str, wdb.network);

    assert(addr2.equals(addr1));
  });

  it('should create and get wallet', async () => {
    const wallet1 = await wdb.create();
    const wallet2 = await wdb.get(wallet1.id);
    assert(wallet1 === wallet2);
  });

  it('should sign/verify p2pkh tx', async () => {
    const flags = Script.flags.STANDARD_VERIFY_FLAGS;
    const wallet = await wdb.create();

    const waddr = await wallet.receiveAddress();
    const addr = Address.fromString(waddr.toString(wdb.network), wdb.network);

    assert.strictEqual(addr.version, 0);
    assert.strictEqual(addr.version, waddr.version);

    const src = new MTX();
    src.addInput(dummyInput());
    src.addOutput(await wallet.receiveAddress(), 5460 * 2);
    src.addOutput(new Address(), 2 * 5460);

    const mtx = new MTX();
    mtx.addTX(src, 0);
    mtx.addOutput(await wallet.receiveAddress(), 5460);

    await wallet.sign(mtx);

    const [tx, view] = mtx.commit();

    assert(tx.verify(view, flags));
  });

  it('should handle missed txs', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    // Coinbase
    // balance: 51000
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 50000);
    t1.addOutput(await alice.receiveAddress(), 1000);

    const t2 = new MTX();
    t2.addTX(t1, 0); // 50000
    t2.addOutput(await alice.receiveAddress(), 24000);
    t2.addOutput(await alice.receiveAddress(), 24000);

    // Save for later.
    doubleSpendWallet = alice;
    doubleSpendCoin = Coin.fromTX(t1, 0, -1);

    // balance: 49000
    await alice.sign(t2);

    const t3 = new MTX();
    t3.addTX(t1, 1); // 1000
    t3.addTX(t2, 0); // 24000
    t3.addOutput(await alice.receiveAddress(), 23000);

    // balance: 47000
    await alice.sign(t3);

    const t4 = new MTX();
    t4.addTX(t2, 1); // 24000
    t4.addTX(t3, 0); // 23000
    t4.addOutput(await alice.receiveAddress(), 11000);
    t4.addOutput(await alice.receiveAddress(), 11000);

    // balance: 22000
    await alice.sign(t4);

    const f1 = new MTX();
    f1.addTX(t4, 1); // 11000
    f1.addOutput(await bob.receiveAddress(), 10000);

    // balance: 11000
    await alice.sign(f1);

    {
      await wdb.addTX(t4.toTX());

      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 22000);
    }

    {
      await wdb.addTX(t1.toTX());

      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 73000);
    }

    {
      await wdb.addTX(t2.toTX());

      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 71000);
    }

    {
      await wdb.addTX(t3.toTX());

      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 69000);
    }

    {
      await wdb.addTX(f1.toTX());

      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 58000);

      const txs = await alice.getHistory();
      assert(txs.some((wtx) => {
        return wtx.hash.equals(f1.hash());
      }));
    }

    {
      const balance = await bob.getBalance();
      assert.strictEqual(balance.unconfirmed, 10000);

      const txs = await bob.getHistory();
      assert(txs.some((wtx) => {
        return wtx.tx.hash().equals(f1.hash());
      }));
    }

    // Should recover from missed txs on block.
    await wdb.addBlock(nextBlock(wdb), [
      t1.toTX(),
      t2.toTX(),
      t3.toTX(),
      t4.toTX(),
      f1.toTX()
    ]);

    {
      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 11000);
      assert.strictEqual(balance.confirmed, 11000);

      const txs = await alice.getHistory();
      assert(txs.some((wtx) => {
        return wtx.hash.equals(f1.hash());
      }));
    }

    {
      const balance = await bob.getBalance();
      assert.strictEqual(balance.unconfirmed, 10000);
      assert.strictEqual(balance.confirmed, 10000);

      const txs = await bob.getHistory();
      assert(txs.some((wtx) => {
        return wtx.tx.hash().equals(f1.hash());
      }));
    }
  });

  it('should cleanup spenders after double-spend', async () => {
    const wallet = doubleSpendWallet;

    // Reorg and unconfirm all previous txs.
    await wdb.removeBlock(curBlock(wdb));

    {
      const txs = await wallet.getHistory();
      assert.strictEqual(txs.length, 5);

      const total = txs.reduce((t, wtx) => {
        return t + wtx.tx.getOutputValue();
      }, 0);
      assert.strictEqual(total, 154000);
    }

    {
      const balance = await wallet.getBalance();
      assert.strictEqual(balance.unconfirmed, 11000);
      assert.strictEqual(balance.confirmed, 0);
    }

    {
      const tx = new MTX();
      tx.addCoin(doubleSpendCoin);
      tx.addOutput(await wallet.receiveAddress(), 5000);

      await wallet.sign(tx);

      await wdb.addTX(tx.toTX());

      const balance = await wallet.getBalance();
      assert.strictEqual(balance.unconfirmed, 6000);
    }

    {
      const txs = await wallet.getHistory();
      assert.strictEqual(txs.length, 2);

      const total = txs.reduce((t, wtx) => {
        return t + wtx.tx.getOutputValue();
      }, 0);
      assert.strictEqual(total, 56000);
    }
  });

  it('should handle double-spend (not our input)', async () => {
    const wallet = await wdb.create();

    const t1 = new MTX();
    const input = dummyInput();
    t1.addInput(input);
    t1.addOutput(await wallet.receiveAddress(), 50000);
    await wdb.addTX(t1.toTX());
    assert.strictEqual((await wallet.getBalance()).unconfirmed, 50000);

    let conflict = false;
    wallet.on('conflict', () => {
      conflict = true;
    });

    const t2 = new MTX();
    t2.addInput(input);
    t2.addOutput(new Address(), 5000);
    await wdb.addTX(t2.toTX());
    assert(conflict);
    assert.strictEqual((await wallet.getBalance()).unconfirmed, 0);
  });

  it('should handle double-spend (multiple inputs)', async () => {
    const wallet = await wdb.create();
    const address = await wallet.receiveAddress();

    const hash = random.randomBytes(32);
    const input0 = Input.fromOutpoint(new Outpoint(hash, 0));
    const input1 = Input.fromOutpoint(new Outpoint(hash, 1));

    const txa = new MTX();
    txa.addInput(input0);
    txa.addInput(input1);
    txa.addOutput(address, 50000);
    await wdb.addTX(txa.toTX());
    assert.strictEqual((await wallet.getBalance()).unconfirmed, 50000);

    let conflict = false;
    wallet.on('conflict', () => {
      conflict = true;
    });

    const txb = new MTX();
    txb.addInput(input0);
    txb.addInput(input1);
    txb.addOutput(address, 49000);
    await wdb.addTX(txb.toTX());

    assert(conflict);
    assert.strictEqual((await wallet.getBalance()).unconfirmed, 49000);
  });

  it('should handle more missed txs', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 50000);
    t1.addOutput(await alice.receiveAddress(), 1000);

    // balance: 51000

    const t2 = new MTX();
    t2.addTX(t1, 0); // 50000
    t2.addOutput(await alice.receiveAddress(), 24000);
    t2.addOutput(await alice.receiveAddress(), 24000);

    // balance: 49000
    await alice.sign(t2);

    const t3 = new MTX();
    t3.addTX(t1, 1); // 1000
    t3.addTX(t2, 0); // 24000
    t3.addOutput(await alice.receiveAddress(), 23000);

    // balance: 47000
    await alice.sign(t3);

    const t4 = new MTX();
    t4.addTX(t2, 1); // 24000
    t4.addTX(t3, 0); // 23000
    t4.addOutput(await alice.receiveAddress(), 11000);
    t4.addOutput(await alice.receiveAddress(), 11000);

    // balance: 22000
    await alice.sign(t4);

    const f1 = new MTX();
    f1.addTX(t4, 1); // 11000
    f1.addOutput(await bob.receiveAddress(), 10000);

    // balance: 11000
    await alice.sign(f1);

    {
      await wdb.addTX(t4.toTX());
      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 22000);
    }

    {
      await wdb.addTX(t1.toTX());
      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 73000);
    }

    {
      await wdb.addTX(t2.toTX());
      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 71000);
    }

    {
      await wdb.addTX(t3.toTX());
      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 69000);
    }

    {
      await wdb.addTX(f1.toTX());

      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 58000);

      const txs = await alice.getHistory();
      assert(txs.some((wtx) => {
        return wtx.tx.hash().equals(f1.hash());
      }));
    }

    {
      const balance = await bob.getBalance();
      assert.strictEqual(balance.unconfirmed, 10000);

      const txs = await bob.getHistory();
      assert(txs.some((wtx) => {
        return wtx.tx.hash().equals(f1.hash());
      }));
    }

    // Should recover from missed txs on block.
    await wdb.addBlock(nextBlock(wdb), [
      t1.toTX(),
      t2.toTX(),
      t3.toTX(),
      t4.toTX(),
      f1.toTX()
    ]);

    {
      const balance = await alice.getBalance();
      assert.strictEqual(balance.unconfirmed, 11000);
    }

    {
      const balance = await bob.getBalance();
      assert.strictEqual(balance.unconfirmed, 10000);
    }
  });

  it('should fill tx with inputs', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Create new transaction
    const m2 = new MTX();
    m2.addOutput(await bob.receiveAddress(), 5460);

    await alice.fund(m2, {
      rate: 10000,
      round: true
    });

    await alice.sign(m2);

    const [t2, v2] = m2.commit();

    assert(t2.verify(v2));

    assert.strictEqual(t2.getInputValue(v2), 16380);
    assert.strictEqual(t2.getOutputValue(), 6380);
    assert.strictEqual(t2.getFee(v2), 10000);

    // Create new transaction
    const t3 = new MTX();
    t3.addOutput(await bob.receiveAddress(), 15000);

    let err;
    try {
      await alice.fund(t3, {
        rate: 10000,
        round: true
      });
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.requiredFunds, 25000);
  });

  it('should fill tx with inputs with accurate fee', async () => {
    const alice = await wdb.create({
      master: KEY1
    });

    const bob = await wdb.create({
      master: KEY2
    });

    // Coinbase
    const t1 = new MTX();
    t1.addOutpoint(new Outpoint(consensus.ZERO_HASH, 0));
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Create new transaction
    const m2 = new MTX();
    m2.addOutput(await bob.receiveAddress(), 5460);

    await alice.fund(m2, {
      rate: 10000
    });

    await alice.sign(m2);

    const [t2, v2] = m2.commit();

    assert(t2.verify(v2));

    assert.strictEqual(t2.getInputValue(v2), 16380);

    // Should now have a change output:
    assert.strictEqual(t2.getOutputValue(), 13660);

    assert.strictEqual(t2.getFee(v2), 2720);

    assert.strictEqual(t2.getWeight(), 1079);
    assert.strictEqual(t2.getBaseSize(), 194);
    assert.strictEqual(t2.getSize(), 497);
    assert.strictEqual(t2.getVirtualSize(), 270);

    let balance = null;
    bob.once('balance', (b) => {
      balance = b;
    });

    await wdb.addTX(t2);

    // Create new transaction
    const t3 = new MTX();
    t3.addOutput(await bob.receiveAddress(), 15000);

    let err;
    try {
      await alice.fund(t3, {
        rate: 10000
      });
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(balance);
    assert.strictEqual(balance.unconfirmed, 5460);
  });

  it('should sign multiple inputs using different keys', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();
    const carol = await wdb.create();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);

    // Coinbase
    const t2 = new MTX();
    t2.addInput(dummyInput());
    t2.addOutput(await bob.receiveAddress(), 5460);
    t2.addOutput(await bob.receiveAddress(), 5460);
    t2.addOutput(await bob.receiveAddress(), 5460);
    t2.addOutput(await bob.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());
    await wdb.addTX(t2.toTX());

    // Create our tx with an output
    const tx = new MTX();
    tx.addOutput(await carol.receiveAddress(), 5460);

    const coins1 = await alice.getCoins();
    const coins2 = await bob.getCoins();

    // Add our unspent inputs to sign
    tx.addCoin(coins1[0]);
    tx.addCoin(coins1[1]);
    tx.addCoin(coins2[0]);

    // Sign transaction
    assert.strictEqual(await alice.sign(tx), 2);
    assert.strictEqual(await bob.sign(tx), 1);

    // Verify
    assert.strictEqual(tx.verify(), true);

    tx.inputs.length = 0;
    tx.addCoin(coins1[1]);
    tx.addCoin(coins1[2]);
    tx.addCoin(coins2[1]);

    assert.strictEqual(await alice.sign(tx), 2);
    assert.strictEqual(await bob.sign(tx), 1);

    // Verify
    assert.strictEqual(tx.verify(), true);
  });

  it('should verify 2-of-3 p2sh tx', async () => {
    const flags = Script.flags.STANDARD_VERIFY_FLAGS;

    // Create 3 2-of-3 wallets with our pubkeys as "shared keys"
    const options = {
      type: 'multisig',
      m: 2,
      n: 3
    };

    const alice = await wdb.create(options);
    const bob = await wdb.create(options);
    const carol = await wdb.create(options);
    const recipient = await wdb.create();

    await alice.addSharedKey(0, await bob.accountKey(0));
    await alice.addSharedKey(0, await carol.accountKey(0));

    await bob.addSharedKey(0, await alice.accountKey(0));
    await bob.addSharedKey(0, await carol.accountKey(0));

    await carol.addSharedKey(0, await alice.accountKey(0));
    await carol.addSharedKey(0, await bob.accountKey(0));

    // Our p2sh address
    const addr1 = await alice.receiveAddress();

    assert.strictEqual(addr1.version, 0);

    assert((await alice.receiveAddress()).equals(addr1));
    assert((await bob.receiveAddress()).equals(addr1));
    assert((await carol.receiveAddress()).equals(addr1));

    {
      // Add a shared unspent transaction to our wallets
      const fund = new MTX();
      fund.addInput(dummyInput());
      fund.addOutput(addr1, 5460 * 10);

      // Simulate a confirmation
      assert.strictEqual(await alice.receiveDepth(), 1);

      await wdb.addBlock(nextBlock(wdb), [fund.toTX()]);

      assert.strictEqual(await alice.receiveDepth(), 2);
      assert.strictEqual(await alice.changeDepth(), 1);
    }

    const addr2 = await alice.receiveAddress();
    assert(!addr2.equals(addr1));

    assert((await alice.receiveAddress()).equals(addr2));
    assert((await bob.receiveAddress()).equals(addr2));
    assert((await carol.receiveAddress()).equals(addr2));

    // Create a tx requiring 2 signatures
    const send = new MTX();

    send.addOutput(await recipient.receiveAddress(), 5460);

    assert(!send.verify(flags));

    await alice.fund(send, {
      rate: 10000,
      round: true
    });

    await alice.sign(send);

    assert(!send.verify(flags));

    await bob.sign(send);

    const [tx, view] = send.commit();
    assert(tx.verify(view, flags));

    assert.strictEqual(await alice.changeDepth(), 1);

    const change = await alice.changeAddress();

    assert((await alice.changeAddress()).equals(change));
    assert((await bob.changeAddress()).equals(change));
    assert((await carol.changeAddress()).equals(change));

    // Simulate a confirmation
    {
      await wdb.addBlock(nextBlock(wdb), [tx]);

      assert.strictEqual(await alice.receiveDepth(), 2);
      assert.strictEqual(await alice.changeDepth(), 2);

      assert((await alice.receiveAddress()).equals(addr2));
      assert(!(await alice.changeAddress()).equals(change));
    }

    const change2 = await alice.changeAddress();

    assert((await alice.changeAddress()).equals(change2));
    assert((await bob.changeAddress()).equals(change2));
    assert((await carol.changeAddress()).equals(change2));

    const input = tx.inputs[0];
    input.witness.setData(2, Buffer.alloc(65, 0x00));
    input.witness.compile();

    assert(!tx.verify(view, flags));
    assert.strictEqual(tx.getFee(view), 10000);
  });

  it('should fill tx with account 1', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    {
      const account = await alice.createAccount({
        name: 'foo'
      });
      assert.strictEqual(account.name, 'foo');
      assert.strictEqual(account.accountIndex, 1);
    }

    const account = await alice.getAccount('foo');
    assert.strictEqual(account.name, 'foo');
    assert.strictEqual(account.accountIndex, 1);

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(account.receiveAddress(), 5460);
    t1.addOutput(account.receiveAddress(), 5460);
    t1.addOutput(account.receiveAddress(), 5460);
    t1.addOutput(account.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Create new transaction
    const t2 = new MTX();
    t2.addOutput(await bob.receiveAddress(), 5460);

    await alice.fund(t2, {
      rate: 10000,
      round: true
    });

    await alice.sign(t2);

    assert(t2.verify());

    assert.strictEqual(t2.getInputValue(), 16380);
    assert.strictEqual(t2.getOutputValue(), 6380);
    assert.strictEqual(t2.getFee(), 10000);

    // Create new transaction
    const t3 = new MTX();
    t3.addOutput(await bob.receiveAddress(), 15000);

    let err;
    try {
      await alice.fund(t3, {
        rate: 10000,
        round: true
      });
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.requiredFunds, 25000);

    const accounts = await alice.getAccounts();
    assert.deepStrictEqual(accounts, ['default', 'foo']);
  });

  it('should fail to fill tx with account 1', async () => {
    const wallet = await wdb.create();

    {
      const account = await wallet.createAccount({
        name: 'foo'
      });
      assert.strictEqual(account.name, 'foo');
      assert.strictEqual(account.accountIndex, 1);
    }

    const account = await wallet.getAccount('foo');
    assert.strictEqual(account.name, 'foo');
    assert.strictEqual(account.accountIndex, 1);

    assert(!account.receiveAddress().equals(await wallet.receiveAddress()));

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await wallet.receiveAddress(), 5460);
    t1.addOutput(await wallet.receiveAddress(), 5460);
    t1.addOutput(await wallet.receiveAddress(), 5460);
    t1.addOutput(account.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Should fill from `foo` and fail
    const t2 = new MTX();

    t2.addOutput(await wallet.receiveAddress(), 5460);

    let err;
    try {
      await wallet.fund(t2, {
        rate: 10000,
        round: true,
        account: 'foo'
      });
    } catch (e) {
      err = e;
    }

    assert(err);

    // Should fill from whole wallet and succeed
    const t3 = new MTX();
    t3.addOutput(await wallet.receiveAddress(), 5460);

    await wallet.fund(t3, {
      rate: 10000,
      round: true
    });

    // Coinbase
    const t4 = new MTX();
    t4.addInput(dummyInput());
    t4.addOutput(await wallet.receiveAddress('foo'), 5460);
    t4.addOutput(await wallet.receiveAddress('foo'), 5460);
    t4.addOutput(await wallet.receiveAddress('foo'), 5460);

    await wdb.addTX(t4.toTX());

    // Should fill from `foo` and succeed
    const t5 = new MTX();
    t5.addOutput(await wallet.receiveAddress(), 5460);

    await wallet.fund(t5, {
      rate: 10000,
      round: true,
      account: 'foo'
    });

    currentWallet = wallet;
  });

  it('should create two accounts (multiple encryption)', async () => {
    {
      const wallet = await wdb.create({
        id: 'foobar',
        passphrase: 'foo'
      });
      await wallet.destroy();
      wdb.unregister(wallet);
    }

    const wallet = await wdb.get('foobar');
    assert(wallet);

    const options = {
      name: 'foo1'
    };

    const account = await wallet.createAccount(options, 'foo');

    assert(account);

    await wallet.lock();
  });

  it('should fill tx with inputs when encrypted', async () => {
    const wallet = await wdb.create({
      passphrase: 'foo'
    });

    wallet.master.stop();
    wallet.master.key = null;

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await wallet.receiveAddress(), 5460);
    t1.addOutput(await wallet.receiveAddress(), 5460);
    t1.addOutput(await wallet.receiveAddress(), 5460);
    t1.addOutput(await wallet.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Create new transaction
    const t2 = new MTX();
    t2.addOutput(await wallet.receiveAddress(), 5460);

    await wallet.fund(t2, {
      rate: 10000,
      round: true
    });

    // Should fail
    let err;
    try {
      await wallet.sign(t2, 'bar');
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(!t2.verify());

    // Should succeed
    await wallet.sign(t2, 'foo');
    assert(t2.verify());
  });

  it('should fill tx with inputs with subtract fee (1)', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Create new transaction
    const t2 = new MTX();
    t2.addOutput(await bob.receiveAddress(), 21840);

    await alice.fund(t2, {
      rate: 10000,
      round: true,
      subtractFee: true
    });

    await alice.sign(t2);

    assert(t2.verify());

    assert.strictEqual(t2.getInputValue(), 5460 * 4);
    assert.strictEqual(t2.getOutputValue(), 21840 - 10000);
    assert.strictEqual(t2.getFee(), 10000);
  });

  it('should fill tx with inputs with subtract fee (2)', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    const options = {
      subtractFee: true,
      rate: 10000,
      round: true,
      outputs: [{ address: await bob.receiveAddress(), value: 21840 }]
    };

    // Create new transaction
    const t2 = await alice.createTX(options);
    await alice.sign(t2);

    assert(t2.verify());

    assert.strictEqual(t2.getInputValue(), 5460 * 4);
    assert.strictEqual(t2.getOutputValue(), 21840 - 10000);
    assert.strictEqual(t2.getFee(), 10000);
  });

  it('should fill tx with smart coin selection', async () => {
    const alice = await wdb.create();
    const bob = await wdb.create();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);
    t1.addOutput(await alice.receiveAddress(), 5460);

    await wdb.addTX(t1.toTX());

    // Coinbase
    const t2 = new MTX();
    t2.addInput(dummyInput());
    t2.addOutput(await alice.receiveAddress(), 5460);
    t2.addOutput(await alice.receiveAddress(), 5460);
    t2.addOutput(await alice.receiveAddress(), 5460);
    t2.addOutput(await alice.receiveAddress(), 5460);

    await wdb.addBlock(nextBlock(wdb), [t2.toTX()]);

    {
      const coins = await alice.getSmartCoins();
      assert.strictEqual(coins.length, 4);

      for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];
        assert.strictEqual(coin.height, wdb.state.height);
      }
    }

    // Create a change output for ourselves.
    await alice.send({
      subtractFee: true,
      rate: 1000,
      depth: 1,
      outputs: [{ address: await bob.receiveAddress(), value: 1461 }]
    });

    const coins = await alice.getSmartCoins();
    assert.strictEqual(coins.length, 4);

    let total = 0;

    {
      let found = false;

      for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];
        if (coin.height === -1) {
          assert(!found);
          assert(coin.value < 5460);
          found = true;
        } else {
          assert.strictEqual(coin.height, wdb.state.height);
        }
        total += coin.value;
      }

      assert(found);
    }

    // Use smart selection
    const options = {
      subtractFee: true,
      smart: true,
      rate: 10000,
      outputs: [{
        address: await bob.receiveAddress(),
        value: total
      }]
    };

    const t3 = await alice.createTX(options);
    assert.strictEqual(t3.inputs.length, 4);

    {
      let found = false;

      for (let i = 0; i < t3.inputs.length; i++) {
        const coin = t3.view.getCoinFor(t3.inputs[i]);
        if (coin.height === -1) {
          assert(!found);
          assert(coin.value < 5460);
          found = true;
        } else {
          assert.strictEqual(coin.height, wdb.state.height);
        }
      }

      assert(found);
    }

    await alice.sign(t3);

    assert(t3.verify());
  });

  it('should get range of txs', async () => {
    const wallet = currentWallet;
    const txs = await wallet.getRange(null, {
      start: util.now() - 1000
    });
    assert.strictEqual(txs.length, 2);
  });

  it('should get range of txs from account', async () => {
    const wallet = currentWallet;
    const txs = await wallet.getRange('foo', {
      start: util.now() - 1000
    });
    assert.strictEqual(txs.length, 2);
  });

  it('should not get range of txs from non-existent account', async () => {
    const wallet = currentWallet;

    let txs, err;
    try {
      txs = await wallet.getRange('bad', {
        start: 0xdeadbeef - 1000
      });
    } catch (e) {
      err = e;
    }

    assert(!txs);
    assert(err);
    assert.strictEqual(err.message, 'Account not found.');
  });

  it('should get account balance', async () => {
    const wallet = currentWallet;
    const balance = await wallet.getBalance('foo');
    assert.strictEqual(balance.unconfirmed, 21840);
  });

  it('should import privkey', async () => {
    const key = KeyRing.generate();

    const wallet = await wdb.create({
      passphrase: 'test'
    });

    await wallet.importKey('default', key, 'test');

    const wkey = await wallet.getKey(key.getHash());

    assert.bufferEqual(wkey.getHash(), key.getHash());

    // Coinbase
    const t1 = new MTX();
    t1.addOutput(key.getAddress(), 5460);
    t1.addOutput(key.getAddress(), 5460);
    t1.addOutput(key.getAddress(), 5460);
    t1.addOutput(key.getAddress(), 5460);

    t1.addInput(dummyInput());

    await wdb.addTX(t1.toTX());

    const wtx = await wallet.getTX(t1.hash());
    assert(wtx);
    assert.bufferEqual(t1.hash(), wtx.hash);

    const options = {
      rate: 10000,
      round: true,
      outputs: [{
        address: await wallet.receiveAddress(),
        value: 7000
      }]
    };

    // Create new transaction
    const t2 = await wallet.createTX(options);
    await wallet.sign(t2);
    assert(t2.verify());
    assert.bufferEqual(t2.inputs[0].prevout.hash, wtx.hash);

    importedWallet = wallet;
    importedKey = key;
  });

  it('should require account key to create watch only wallet', async () => {
    try {
      watchWallet = await wdb.create({
        watchOnly: true
      });
    } catch (e) {
      assert.strictEqual(
        e.message,
        'Must add HD public keys to watch only wallet.'
      );
    }

    const privateKey = HDPrivateKey.generate();
    const xpub = privateKey.xpubkey('main');
    watchWallet = await wdb.create({
      watchOnly: true,
      accountKey: xpub
    });
  });

  it('should import pubkey', async () => {
    const key = KeyRing.generate();
    const pub = new KeyRing(key.publicKey);

    await watchWallet.importKey('default', pub);

    const path = await watchWallet.getPath(pub.getHash());
    assert.bufferEqual(path.hash, pub.getHash());

    const wkey = await watchWallet.getKey(pub.getHash());
    assert(wkey);
  });

  it('should import address', async () => {
    const key = KeyRing.generate();

    await watchWallet.importAddress('default', key.getAddress());

    const path = await watchWallet.getPath(key.getHash());
    assert(path);
    assert.bufferEqual(path.hash, key.getHash());

    const wkey = await watchWallet.getKey(key.getHash());
    assert(!wkey);
  });

  it('should get details', async () => {
    const wallet = currentWallet;

    const txs = await wallet.getRange('foo', {
      start: util.now() - 1000
    });

    const details = await wallet.toDetails(txs);

    assert(details.some((tx) => {
      return tx.toJSON(wdb.network).outputs[0].path.name === 'foo';
    }));
  });

  it('should rename wallet', async () => {
    const wallet = currentWallet;

    await wallet.rename('test');

    const txs = await wallet.getRange('foo', {
      start: util.now() - 1000
    });

    const details = await wallet.toDetails(txs);

    assert(details.length > 0);
    assert.strictEqual(wallet.id, 'test');
  });

  it('should change passphrase with encrypted imports', async () => {
    const wallet = importedWallet;
    const addr = importedKey.getAddress();

    assert(wallet.master.encrypted);

    let data;
    {
      const path = await wallet.getPath(addr);
      assert(path);
      assert(path.data && path.encrypted);
      data = path.data;
    }

    await wallet.decrypt('test');

    {
      const path = await wallet.getPath(addr);
      assert(path);
      assert(path.data && !path.encrypted);
      assert(await wallet.getKey(addr));
    }

    await wallet.encrypt('foo');

    {
      const path = await wallet.getPath(addr);
      assert(path);
      assert(path.data && path.encrypted);
      assert(!data.equals(path.data));
      assert(!await wallet.getKey(addr));
    }

    await wallet.unlock('foo');

    const key = await wallet.getKey(addr);
    assert(key);
    assert.bufferEqual(key.getHash(), addr.getHash());
  });

  it('should recover from a missed tx', async () => {
    const wdb = new WalletDB({ network, workers });
    await wdb.open();

    const alice = await wdb.create({
      master: KEY1
    });

    const bob = await wdb.create({
      master: KEY1
    });

    const addr = await alice.receiveAddress();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(addr, 50000);

    await wdb.addTX(t1.toTX());

    // Bob misses this tx!
    const t2 = new MTX();
    t2.addTX(t1, 0);
    t2.addOutput(addr, 24000);
    t2.addOutput(addr, 24000);

    await alice.sign(t2);

    await alice.add(t2.toTX());

    assert.notStrictEqual(
      (await alice.getBalance()).unconfirmed,
      (await bob.getBalance()).unconfirmed);

    // Bob sees this one.
    const t3 = new MTX();
    t3.addTX(t2, 0);
    t3.addTX(t2, 1);
    t3.addOutput(addr, 30000);

    await alice.sign(t3);

    assert.strictEqual((await bob.getBalance()).unconfirmed, 50000);

    await wdb.addTX(t3.toTX());

    assert.strictEqual((await alice.getBalance()).unconfirmed, 30000);

    // t1 gets confirmed.
    await wdb.addBlock(nextBlock(wdb), [t1.toTX()]);

    // Bob sees t2 on the chain.
    await wdb.addBlock(nextBlock(wdb), [t2.toTX()]);

    // Bob sees t3 on the chain.
    await wdb.addBlock(nextBlock(wdb), [t3.toTX()]);

    assert.strictEqual((await bob.getBalance()).unconfirmed, 30000);
  });

  it('should recover from a missed tx and double spend', async () => {
    const wdb = new WalletDB({ network, workers });
    await wdb.open();

    const alice = await wdb.create({
      master: KEY1
    });

    const bob = await wdb.create({
      master: KEY1
    });

    const addr = await alice.receiveAddress();

    // Coinbase
    const t1 = new MTX();
    t1.addInput(dummyInput());
    t1.addOutput(addr, 50000);

    await wdb.addTX(t1.toTX());

    // Bob misses this tx!
    const t2a = new MTX();
    t2a.addTX(t1, 0);
    t2a.addOutput(addr, 24000);
    t2a.addOutput(addr, 24000);

    await alice.sign(t2a);

    await alice.add(t2a.toTX());

    assert.notStrictEqual(
      (await alice.getBalance()).unconfirmed,
      (await bob.getBalance()).unconfirmed);

    // Bob doublespends.
    const t2b = new MTX();
    t2b.addTX(t1, 0);
    t2b.addOutput(addr, 10000);
    t2b.addOutput(addr, 10000);

    await bob.sign(t2b);

    await bob.add(t2b.toTX());

    // Bob sees this one.
    const t3 = new MTX();
    t3.addTX(t2a, 0);
    t3.addTX(t2a, 1);
    t3.addOutput(addr, 30000);

    await alice.sign(t3);

    assert.strictEqual((await bob.getBalance()).unconfirmed, 20000);

    await wdb.addTX(t3.toTX());

    assert.strictEqual((await alice.getBalance()).unconfirmed, 30000);

    // t1 gets confirmed.
    await wdb.addBlock(nextBlock(wdb), [t1.toTX()]);

    // Bob sees t2a on the chain.
    await wdb.addBlock(nextBlock(wdb), [t2a.toTX()]);

    // Bob sees t3 on the chain.
    await wdb.addBlock(nextBlock(wdb), [t3.toTX()]);

    assert.strictEqual((await bob.getBalance()).unconfirmed, 30000);
  });

  it('should remove a wallet', async () => {
    await wdb.create({
      id: 'alice100'
    });
    assert(await wdb.get('alice100'));
    await wdb.remove('alice100');
    assert(!await wdb.get('alice100'));
  });

  it('should count pending ancestors', async () => {
    // Create wallet and get one address
    const wallet = await wdb.create();
    const addr1 = await wallet.receiveAddress();

    // Dummy address for outputs
    const recAddr = Address.fromHash(Buffer.alloc(20, 1));

    // Add one single, unconfirmed coin to wallet
    const mtx = new MTX();
    mtx.addInput(dummyInput());
    mtx.addOutput(addr1, 10 * 1e8);
    const tx0 = mtx.toTX();
    await wallet.txdb.add(tx0, null);

    let ancs = null;
    ancs = await wallet.getPendingAncestors(tx0);
    assert.strictEqual(ancs.size, 0);

    // Create one tx
    const tx1 = await wallet.send({
      outputs: [{
        address: recAddr,
        value: 10000
      }]
    });
    ancs = await wallet.getPendingAncestors(tx1);
    assert.strictEqual(ancs.size, 1);

    // Create a second tx
    const tx2 = await wallet.send({
      outputs: [{
        address: recAddr,
        value: 10000
      }]
    });
    ancs = await wallet.getPendingAncestors(tx2);
    assert.strictEqual(ancs.size, 2);

    // Confirm tx0 with dummy block
    const block100 = {
      height: 100,
      hash: Buffer.alloc(32, 0),
      time: Date.now()
    };
    const wtx0 = await wallet.txdb.getTX(tx0.hash());
    await wallet.txdb.confirm(wtx0, block100);

    ancs = await wallet.getPendingAncestors(tx2);
    assert.strictEqual(ancs.size, 1);

    // Confirm tx1 with dummy block
    const block101 = {
      height: 101,
      hash: Buffer.alloc(32, 1),
      time: Date.now()
    };
    const wtx1 = await wallet.txdb.getTX(tx1.hash());
    await wallet.txdb.confirm(wtx1, block101);

    ancs = await wallet.getPendingAncestors(tx2);
    assert.strictEqual(ancs.size, 0);
  });

  it('should not exceed MEMPOOL_MAX_ANCESTORS policy', async () => {
    // Create wallet and get one address
    const wallet = await wdb.create();
    const addr1 = await wallet.receiveAddress();

    // Dummy address for outputs
    const recAddr = Address.fromHash(Buffer.alloc(20, 1));

    // Add one single, unconfirmed coin to wallet
    const mtx1 = new MTX();
    mtx1.addInput(dummyInput());
    mtx1.addOutput(addr1, 10 * 1e8);
    const tx1 = mtx1.toTX();
    await wallet.txdb.add(tx1, null);

    // Spend unconfirmed change outputs up to the limit
    const limit = policy.MEMPOOL_MAX_ANCESTORS;
    for (let i = 0; i < limit - 1; i++) {
      const tx = await wallet.send({
        outputs: [{
          address: recAddr,
          value: 10000
        }]
      });
      assert(await wallet.txdb.hasPending(tx.hash()));
    }

    // At the limit
    const pending = await wallet.getPending();
    assert.strictEqual(pending.length, policy.MEMPOOL_MAX_ANCESTORS);

    // One more unconfirmed change spend would exceed the limit
    assert.rejects(async () => {
      await wallet.send({
        outputs: [{
          address: recAddr,
          value: 10000
        }]
      });
    }, {
      message: 'TX exceeds maximum unconfirmed ancestors.'
    });
  });

  it('should create credit if not found during confirmation', async () => {
    // Create wallet and get one address
    const wallet = await wdb.create();
    const addr1 = await wallet.receiveAddress();

    // Outside the wallet, generate a second private key and address.
    const key2 = HDPrivateKey.generate();
    const ring2 = KeyRing.fromPrivate(key2.privateKey);
    const addr2 = ring2.getAddress();

    // Build TX to both addresses, known and unknown
    const mtx = new MTX();
    mtx.addOutpoint(new Outpoint(Buffer.alloc(32), 0));
    mtx.addOutput(addr1, 1020304);
    mtx.addOutput(addr2, 4030201);
    const tx = mtx.toTX();
    const hash = tx.hash();

    // Add unconfirmed TX to txdb (no block provided)
    await wallet.txdb.add(tx, null);

    // Check
    const bal1 = await wallet.getBalance();
    assert.strictEqual(bal1.tx, 1);
    assert.strictEqual(bal1.coin, 1);
    assert.strictEqual(bal1.confirmed, 0);
    assert.strictEqual(bal1.unconfirmed, 1020304);

    // Import private key into wallet
    assert(!await wallet.hasAddress(addr2));
    await wallet.importKey('default', ring2);
    assert(await wallet.hasAddress(addr2));

    // Confirm TX with newly-added output address
    // Create dummy block
    const block = {
      height: 100,
      hash: Buffer.alloc(32),
      time: Date.now()
    };

    // Get TX from txdb
    const wtx = await wallet.txdb.getTX(hash);

    // Confirm TX with dummy block in txdb
    const details = await wallet.txdb.confirm(wtx, block);
    assert.bufferEqual(details.tx.hash(), hash);

    // Check balance
    const bal2 = await wallet.getBalance();
    assert.strictEqual(bal2.confirmed, bal2.unconfirmed);
    assert.strictEqual(bal2.confirmed, 5050505);
    assert.strictEqual(bal2.coin, 2);
    assert.strictEqual(bal2.tx, 1);

    // Check for unconfirmed transactions
    const pending = await wallet.getPending();
    assert.strictEqual(pending.length, 0);

    // Check history for TX
    const history = await wallet.getHistory();
    const wtxs = await wallet.toDetails(history);
    assert.strictEqual(wtxs.length, 1);
    assert.bufferEqual(wtxs[0].hash, hash);

    // Both old and new credits are not "owned"
    // (created by the wallet spending its own coins)
    for (let i = 0; i < tx.outputs.length; i++) {
      const credit = await wallet.txdb.getCredit(tx.hash(), i);
      assert(!credit.own);
    }
  });

  it('should create owned credit if not found during confirm', async () => {
    // Create wallet and get one address
    const wallet = await wdb.create();
    const addr1 = await wallet.receiveAddress();

    // Outside the wallet, generate a second private key and address.
    const key2 = HDPrivateKey.generate();
    const ring2 = KeyRing.fromPrivate(key2.privateKey);
    const addr2 = ring2.getAddress();

    // Create a confirmed, unspent, wallet-owned credit in txdb
    const mtx1 = new MTX();
    mtx1.addOutpoint(new Outpoint(Buffer.alloc(32), 0));
    mtx1.addOutput(addr1, 1 * 1e8);
    const tx1 = mtx1.toTX();
    await wallet.txdb.add(tx1, null);

    // Create dummy block
    const block1 = {
      height: 99,
      hash: Buffer.alloc(32),
      time: Date.now()
    };
    // Get TX from txdb
    const wtx1 = await wallet.txdb.getTX(tx1.hash());

    // Confirm TX with dummy block in txdb
    await wallet.txdb.confirm(wtx1, block1);

    // Build TX to both addresses, known and unknown
    const mtx2 = new MTX();
    mtx2.addTX(tx1, 0, 99);
    mtx2.addOutput(addr1, 1020304);
    mtx2.addOutput(addr2, 4030201);
    const tx2 = mtx2.toTX();
    const hash = tx2.hash();

    // Add unconfirmed TX to txdb (no block provided)
    await wallet.txdb.add(tx2, null);

    // Check
    const bal1 = await wallet.getBalance();
    assert.strictEqual(bal1.tx, 2);
    assert.strictEqual(bal1.coin, 1);
    assert.strictEqual(bal1.confirmed, 1 * 1e8);
    assert.strictEqual(bal1.unconfirmed, 1020304);

    // Import private key into wallet
    assert(!await wallet.hasAddress(addr2));
    await wallet.importKey('default', ring2);
    assert(await wallet.hasAddress(addr2));

    // Confirm TX with newly-added output address
    // Create dummy block
    const block2 = {
      height: 100,
      hash: Buffer.alloc(32),
      time: Date.now()
    };

    // Get TX from txdb
    const wtx2 = await wallet.txdb.getTX(hash);

    // Confirm TX with dummy block in txdb
    const details = await wallet.txdb.confirm(wtx2, block2);
    assert.bufferEqual(details.tx.hash(), hash);

    // Check balance
    const bal2 = await wallet.getBalance();
    assert.strictEqual(bal2.confirmed, bal2.unconfirmed);
    assert.strictEqual(bal2.confirmed, 5050505);
    assert.strictEqual(bal2.coin, 2);
    assert.strictEqual(bal2.tx, 2);

    // Check for unconfirmed transactions
    const pending = await wallet.getPending();
    assert.strictEqual(pending.length, 0);

    // Both old and new credits are "owned"
    // (created by the wallet spending its own coins)
    for (let i = 0; i < tx2.outputs.length; i++) {
      const credit = await wallet.txdb.getCredit(tx2.hash(), i);
      assert(credit.own);
    }
  });

  it('should throw error with missing outputs', async () => {
    const wallet = new Wallet({});

    let err = null;

    try {
       await wallet.send({outputs: []});
    } catch (e) {
      err = e;
   }

    assert(err);
    assert.equal(err.message, 'At least one output required.');
  });

  it('should cleanup', async () => {
    network.coinbaseMaturity = 2;
    await wdb.close();
  });

  describe('Disable TXs', function() {
    const network = Network.get('regtest');
    const workers = new WorkerPool({ enabled });
    const wdb = new WalletDB({ network, workers });

    before(async () => {
      await wdb.open();
    });

    after(async () => {
      await wdb.close();
    });

    it('should only send a tx after network txStart', async () => {
      // Create wallet and get one address
      const wallet = await wdb.create();
      const addr1 = await wallet.receiveAddress();

      // Dummy address for outputs
      const recAddr = Address.fromHash(Buffer.alloc(20, 1));

      // Add one single, unconfirmed coin to wallet
      const mtx1 = new MTX();
      mtx1.addInput(dummyInput());
      mtx1.addOutput(addr1, 10 * 1e8);
      const tx1 = mtx1.toTX();
      await wallet.txdb.add(tx1, null);

      const ACTUAL_TXSTART = wallet.network.txStart;
      const ACTUAL_HEIGHT = wdb.height;

      try {
        wallet.network.txStart = 6;
        wdb.height = 4;

        await assert.rejects(
          wallet.send({outputs: [{address: recAddr, value: 10000}]}),
          {message: 'Transactions are not allowed on network yet.'}
        );
      } finally {
        wallet.network.txStart = ACTUAL_TXSTART;
        wdb.height = ACTUAL_HEIGHT;
      }

      try {
        // Transactions are allowed in the NEXT block
        wallet.network.txStart = 6;
        wdb.height = 5;

        assert(
          await wallet.send({outputs: [{address: recAddr, value: 10000}]})
        );
      } finally {
        wallet.network.txStart = ACTUAL_TXSTART;
        wdb.height = ACTUAL_HEIGHT;
      }
    });
  });

  describe('Corruption', function() {
    let workers = null;
    let wdb = null;

    beforeEach(async () => {
      workers = new WorkerPool({
        enabled: true,
        size: 2
      });

      wdb = new WalletDB({ workers });
      await workers.open();
      await wdb.open();
    });

    afterEach(async () => {
      await wdb.close();
      await workers.close();
    });

    it('should not write tip with error in txs', async () => {
      const alice = await wdb.create();
      const addr = await alice.receiveAddress();

      const fund = new MTX();
      fund.addInput(dummyInput());
      fund.addOutput(addr, 5460 * 10);

      wdb._addTX = async () => {
        throw new Error('Some assertion.');
      };

      await assert.rejects(async () => {
        await wdb.addBlock(nextBlock(wdb), [fund.toTX()]);
      }, {
        message: 'Some assertion.'
      });

      assert.equal(wdb.height, 0);

      const bal = await alice.getBalance();
      assert.equal(bal.confirmed, 0);
      assert.equal(bal.unconfirmed, 0);
    });

    it('should write tip without error in txs', async () => {
      const alice = await wdb.create();
      const addr = await alice.receiveAddress();

      const fund = new MTX();
      fund.addInput(dummyInput());
      const amount = 5460 * 10;
      fund.addOutput(addr, amount);

      await wdb.addBlock(nextBlock(wdb), [fund.toTX()]);

      assert.equal(wdb.height, 1);

      const bal = await alice.getBalance();
      assert.equal(bal.confirmed, amount);
      assert.equal(bal.unconfirmed, amount);
    });
  });

  describe('TXDB locked balance', function() {
    const network = Network.get('regtest');
    const workers = new WorkerPool({ enabled });
    const wdb = new WalletDB({ network, workers });
    // This test executes a complete auction for this name
    const name = 'satoshi';
    const nameHash = rules.hashName(name);
    // There will be two bids. One from our wallet with a lockup and bid value,
    // the second highest (losing) bid comes from an external wallet.
    const value = 1e6;
    const lockup = 2e6;
    const secondHighest = value - 1;
    // All TXs will have a hard-coded fee to simplify the expected balances,
    // along with counters for OUTGOING (un)confirmed transactions.
    const fee = 10000;
    let uTXCount = 0;
    let cTXCount = 0;
    // Initial wallet funds
    const fund = 10e6;
    // Store height of block confirming the FINALIZE so we can disconnect later.
    let finalizeBlock;
    // Store height of auction OPEN to be used in second bid.
    let start;
    // The main test wallet, and wallet that will receive the FINALIZE.
    let wallet, recip;

    // Hack required to focus test on txdb mechanics.
    // We don't otherwise need WalletDB or Blockchain
    wdb.getRenewalBlock = () => {
      return network.genesis.hash;
    };

    before(async () => {
      await wdb.open();
      wallet = await wdb.create();
      recip = await wdb.create();
      // rollout all names
      wdb.height = 52 * 144 * 7;
    });

    after(async () => {
      await wdb.close();
    });

    it('should fund wallet', async () => {
      const addr = await wallet.receiveAddress();

      // Fund wallet
      const mtx = new MTX();
      mtx.addOutpoint(new Outpoint(Buffer.alloc(32), 0));
      mtx.addOutput(addr, fund);
      const tx = mtx.toTX();

      // Dummy block
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };

      // Add confirmed funding TX to wallet
      await wallet.txdb.add(tx, block);

      // Check
      const bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 1);
      assert.strictEqual(bal.coin, 1);
      assert.strictEqual(bal.confirmed, fund);
      assert.strictEqual(bal.unconfirmed, fund);
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);
    });

    it('should send and confirm OPEN', async () => {
      const open = await wallet.sendOpen(name, false, {hardFee: fee});
      uTXCount++;

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 2);
      assert.strictEqual(bal.coin, 2);
      assert.strictEqual(bal.confirmed, fund);
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);

      // Confirm OPEN
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(open, block);
      start = wdb.height;
      cTXCount++;

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 2);
      assert.strictEqual(bal.coin, 2);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);
    });

    it('should send and confirm BID', async () => {
      // Advance to bidding
      wdb.height += network.names.treeInterval + 1;

      const bid = await wallet.sendBid(name, value, lockup, {hardFee: fee});
      uTXCount++;

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 3);
      assert.strictEqual(bal.coin, 3);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, lockup);
      assert.strictEqual(bal.clocked, 0);

      // Confirm BID
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(bid, block);
      cTXCount++;

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 3);
      assert.strictEqual(bal.coin, 3);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, lockup);
      assert.strictEqual(bal.clocked, lockup);
    });

    it('should send and confirm REVEAL', async () => {
      // Advance to reveal
      wdb.height += network.names.biddingPeriod;

      const reveal = await wallet.sendReveal(name, {hardFee: fee});
      uTXCount++;

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 4);
      assert.strictEqual(bal.coin, 4);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, value);
      assert.strictEqual(bal.clocked, lockup);

      // Confirm BID
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(reveal, block);
      cTXCount++;

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 4);
      assert.strictEqual(bal.coin, 4);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, value);
      assert.strictEqual(bal.clocked, value);
    });

    it('should add external REVEAL to txdb', async () => {
      // The goal is to have a "second-highest" bid
      // so the wallet doesn't win the name for free.
      // We can skip the whole BID/lockup thing for these tests.

      const output = new Output();
      output.value = secondHighest;
      output.covenant.type = types.REVEAL;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(start);
      output.covenant.push(Buffer.from(name, 'ascii'));
      output.covenant.pushHash(Buffer.alloc(32));

      const mtx = new MTX();
      mtx.outputs.push(output);

      // Confirm external REVEAL
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(mtx.toTX(), block);
    });

    it('should send and confirm REGISTER', async () => {
      // Advance to close
      wdb.height += network.names.revealPeriod;

      const resource = Resource.fromJSON({records: []});
      const register = await wallet.sendUpdate(name, resource, {hardFee: fee});
      uTXCount++;

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 5);
      // Wallet coin count doesn't change:
      // REVEAL + fee money -> REGISTER + change
      assert.strictEqual(bal.coin, 4);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, secondHighest);
      assert.strictEqual(bal.clocked, value);

      // Confirm REGISTER
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(register, block);
      cTXCount++;

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 5);
      assert.strictEqual(bal.coin, 4);
      assert.strictEqual(bal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(bal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(bal.ulocked, secondHighest);
      assert.strictEqual(bal.clocked, secondHighest);
    });

    it('should send and confirm TRANSFER', async () => {
      const recipAddr = await recip.receiveAddress();
      const transfer = await wallet.sendTransfer(name, recipAddr, {hardFee: fee});
      uTXCount++;

      // Check
      let senderBal = await wallet.getBalance();
      assert.strictEqual(senderBal.tx, 6);
      assert.strictEqual(senderBal.coin, 4);
      assert.strictEqual(senderBal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(senderBal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(senderBal.ulocked, secondHighest);
      assert.strictEqual(senderBal.clocked, secondHighest);

      let recipBal = await recip.getBalance();
      assert.strictEqual(recipBal.tx, 0);
      assert.strictEqual(recipBal.coin, 0);
      assert.strictEqual(recipBal.confirmed, 0);
      assert.strictEqual(recipBal.unconfirmed, 0);
      assert.strictEqual(recipBal.ulocked, 0);
      assert.strictEqual(recipBal.clocked, 0);

      // Confirm TRANSFER
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(transfer, block);
      cTXCount++;

      // Check
      senderBal = await wallet.getBalance();
      assert.strictEqual(senderBal.tx, 6);
      assert.strictEqual(senderBal.coin, 4);
      assert.strictEqual(senderBal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(senderBal.unconfirmed, fund - (uTXCount * fee));
      assert.strictEqual(senderBal.ulocked, secondHighest);
      assert.strictEqual(senderBal.clocked, secondHighest);

      recipBal = await recip.getBalance();
      assert.strictEqual(recipBal.tx, 0);
      assert.strictEqual(recipBal.coin, 0);
      assert.strictEqual(recipBal.confirmed, 0);
      assert.strictEqual(recipBal.unconfirmed, 0);
      assert.strictEqual(recipBal.ulocked, 0);
      assert.strictEqual(recipBal.clocked, 0);
    });

    it('should send and confirm FINALIZE', async () => {
      // Advance past lockup period
      wdb.height += network.names.transferLockup;

      const finalize = await wallet.sendFinalize(name, {hardFee: fee});
      uTXCount++;

      // Check
      let senderBal = await wallet.getBalance();
      assert.strictEqual(senderBal.tx, 7);
      // One less wallet coin because name UTXO belongs to recip now
      assert.strictEqual(senderBal.coin, 3);
      assert.strictEqual(senderBal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(senderBal.unconfirmed, fund - secondHighest - (uTXCount * fee));
      assert.strictEqual(senderBal.ulocked, 0);
      assert.strictEqual(senderBal.clocked, secondHighest);

      // The name and its locked value now belong to recipient
      let recipBal = await recip.getBalance();
      assert.strictEqual(recipBal.tx, 1);
      assert.strictEqual(recipBal.coin, 1);
      assert.strictEqual(recipBal.confirmed, 0);
      assert.strictEqual(recipBal.unconfirmed, secondHighest);
      assert.strictEqual(recipBal.ulocked, secondHighest);
      assert.strictEqual(recipBal.clocked, 0);

      // Confirm FINALIZE
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(finalize, block);
      await recip.txdb.add(finalize, block);
      finalizeBlock = block.height;
      cTXCount++;

      // Check
      senderBal = await wallet.getBalance();
      assert.strictEqual(senderBal.tx, 7);
      assert.strictEqual(senderBal.coin, 3);
      assert.strictEqual(senderBal.confirmed, fund - secondHighest - (cTXCount * fee));
      assert.strictEqual(senderBal.unconfirmed, fund - secondHighest - (uTXCount * fee));
      assert.strictEqual(senderBal.ulocked, 0);
      assert.strictEqual(senderBal.clocked, 0);

      recipBal = await recip.getBalance();
      assert.strictEqual(recipBal.tx, 1);
      assert.strictEqual(recipBal.coin, 1);
      assert.strictEqual(recipBal.confirmed, secondHighest);
      assert.strictEqual(recipBal.unconfirmed, secondHighest);
      assert.strictEqual(recipBal.ulocked, secondHighest);
      assert.strictEqual(recipBal.clocked, secondHighest);
    });

    it('should disconnect FINALIZE', async () => {
      await wallet.txdb.revert(finalizeBlock);
      await recip.txdb.revert(finalizeBlock);
      cTXCount--;

      // Check
      const senderBal = await wallet.getBalance();
      assert.strictEqual(senderBal.tx, 7);
      assert.strictEqual(senderBal.coin, 3);
      assert.strictEqual(senderBal.confirmed, fund - (cTXCount * fee));
      assert.strictEqual(senderBal.unconfirmed, fund - secondHighest - (uTXCount * fee));
      assert.strictEqual(senderBal.ulocked, 0);
      assert.strictEqual(senderBal.clocked, secondHighest);

      const recipBal = await recip.getBalance();
      assert.strictEqual(recipBal.tx, 1);
      assert.strictEqual(recipBal.coin, 1);
      assert.strictEqual(recipBal.confirmed, 0);
      assert.strictEqual(recipBal.unconfirmed, secondHighest);
      assert.strictEqual(recipBal.ulocked, secondHighest);
      assert.strictEqual(recipBal.clocked, 0);
    });
  });

  describe('TXDB locked balance after simulated rescan', function() {
    const network = Network.get('regtest');
    const workers = new WorkerPool({ enabled });
    const wdb = new WalletDB({ network, workers });
    const name = 'satoshi';
    const value = 1e6;
    const lockup = 2e6;
    const fee = 10000;
    let wallet;

    before(async () => {
      await wdb.open();
      wallet = await wdb.create();
      // rollout all names
      wdb.height = 52 * 144 * 7;
    });

    after(async () => {
      await wdb.close();
    });

    it('should fund wallet', async () => {
      const addr = await wallet.receiveAddress();

      // Fund wallet
      const mtx = new MTX();
      mtx.addOutpoint(new Outpoint(Buffer.alloc(32), 0));
      mtx.addOutput(addr, 10e6);
      const tx = mtx.toTX();

      // Dummy block
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };

      // Add confirmed funding TX to wallet
      await wallet.txdb.add(tx, block);

      // Check
      const bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 1);
      assert.strictEqual(bal.coin, 1);
      assert.strictEqual(bal.confirmed, 10e6);
      assert.strictEqual(bal.unconfirmed, 10e6);
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);
    });

    it('should confirm new OPEN', async () => {
      const open = await wallet.createOpen(name, false, {hardFee: fee});

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 1);
      assert.strictEqual(bal.coin, 1);
      assert.strictEqual(bal.confirmed, 10e6);
      assert.strictEqual(bal.unconfirmed, 10e6);
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);

      // Confirm OPEN
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(open.toTX(), block);

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 2);
      assert.strictEqual(bal.coin, 2);
      assert.strictEqual(bal.confirmed, 10e6 - (1 * fee));
      assert.strictEqual(bal.unconfirmed, 10e6 - (1 * fee));
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);
    });

    it('should confirm new BID', async () => {
      // Advance to bidding
      wdb.height += network.names.treeInterval + 1;

      const bid = await wallet.createBid(name, value, lockup, {hardFee: fee});

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 2);
      assert.strictEqual(bal.coin, 2);
      assert.strictEqual(bal.confirmed, 10e6 - (1 * fee));
      assert.strictEqual(bal.unconfirmed, 10e6 - (1 * fee));
      assert.strictEqual(bal.ulocked, 0);
      assert.strictEqual(bal.clocked, 0);

      // Confirm BID
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(bid.toTX(), block);

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 3);
      assert.strictEqual(bal.coin, 3);
      assert.strictEqual(bal.confirmed, 10e6 - (2 * fee));
      assert.strictEqual(bal.unconfirmed, 10e6 - (2 * fee));
      assert.strictEqual(bal.ulocked, lockup);
      assert.strictEqual(bal.clocked, lockup);
    });

    it('should confirm new REVEAL', async () => {
      // Advance to reveal
      wdb.height += network.names.biddingPeriod;

      const reveal = await wallet.createReveal(name, {hardFee: fee});

      // Check
      let bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 3);
      assert.strictEqual(bal.coin, 3);
      assert.strictEqual(bal.confirmed, 10e6 - (2 * fee));
      assert.strictEqual(bal.unconfirmed, 10e6 - (2 * fee));
      assert.strictEqual(bal.ulocked, lockup);
      assert.strictEqual(bal.clocked, lockup);

      // Confirm BID
      const block = {
        height: wdb.height + 1,
        hash: Buffer.alloc(32),
        time: Date.now()
      };
      await wallet.txdb.add(reveal.toTX(), block);

      // Check
      bal = await wallet.getBalance();
      assert.strictEqual(bal.tx, 4);
      assert.strictEqual(bal.coin, 4);
      assert.strictEqual(bal.confirmed, 10e6 - (3 * fee));
      assert.strictEqual(bal.unconfirmed, 10e6 - (3 * fee));
      assert.strictEqual(bal.ulocked, value);
      assert.strictEqual(bal.clocked, value);
    });
  });

  describe('Node Integration', function() {
    const ports = {p2p: 49331, node: 49332, wallet: 49333};
    let node, chain, miner, wdb = null;

    beforeEach(async () => {
      node = new FullNode({
        memory: true,
        network: 'regtest',
        workers: true,
        workersSize: 2,
        plugins: [require('../lib/wallet/plugin')],
        port: ports.p2p,
        httpPort: ports.node,
        env: {
          'HSD_WALLET_HTTP_PORT': ports.wallet.toString()
        }
      });

      chain = node.chain;
      miner = node.miner;
      wdb = node.require('walletdb').wdb;
      await node.open();
    });

    afterEach(async () => {
      await node.close();
    });

    async function mineBlock(tip) {
      const job = await miner.createJob(tip);
      const block = await job.mineAsync();
      return chain.add(block);
    }

    it('should not stack in-memory block queue (oom)', async () => {
      let height = 0;

      const addBlock = wdb.addBlock.bind(wdb);
      wdb.addBlock = async (entry, txs) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await addBlock(entry, txs);
      };

      async function raceForward() {
        await mineBlock();

        await forValue(node.chain, 'height', height + 1);
        assert.equal(wdb.height, height + 1);

        height += 1;
      }

      for (let i = 0; i < 10; i++)
        await raceForward();
    });

    it('should emit details with correct confirmation', async () => {
      const wclient = new WalletClient({port: ports.wallet});
      await wclient.open();

      const info = await wclient.createWallet('test');
      const wallet = wclient.wallet('test', info.token);
      await wallet.open();

      const acct = await wallet.getAccount('default');
      const waddr = acct.receiveAddress;

      miner.addresses.length = 0;
      miner.addAddress(waddr);

      let txCount = 0;
      let txConfirmedCount = 0;
      let confirmedCount = 0;

      wallet.on('tx', (details) => {
        if (details.confirmations === 1)
          txConfirmedCount += 1;
        else if (details.confirmations === 0)
          txCount += 1;
      });

      wallet.on('confirmed', (details) => {
        assert.equal(details.confirmations, 1);
        confirmedCount += 1;
      });

      for (let i = 0; i < 101; i++)
        await mineBlock();

      await wallet.send({outputs: [{address: waddr, value: 1 * 1e8}]});
      await mineBlock();

      await wclient.close();

      assert.equal(txConfirmedCount, 102);
      assert.equal(txCount, 1);
      assert.equal(confirmedCount, 1);
    });
  });

  describe('Wallet Name Claims', function() {
    // 'it' blocks in this 'describe' create state
    // that later 'it' blocks depend on.
    let wallet, update;
    const network = Network.get('regtest');
    const workers = new WorkerPool({enabled: false});
    const wdb = new WalletDB({network, workers});
    const lockup = 6800503496047;
    const name = 'cloudflare';
    const nameHash = rules.hashString(name);

    before(async () => {
      await wdb.open();
      wallet = await wdb.create();

      for (let i = 0; i < 3; i++) {
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, []);
      }
    });

    after(async () => {
      await wdb.close();
    });

    it('should not have any cloudflare state', async () => {
      const nameinfo = await wallet.getNameState(nameHash);
      assert.deepEqual(nameinfo, null);
    });

    it('should confirm cloudflare CLAIM', async () => {
      // Use a fresh wallet.
      const pre = await wallet.getBalance();
      assert.equal(pre.tx, 0);
      assert.equal(pre.coin, 0);
      assert.equal(pre.unconfirmed, 0);
      assert.equal(pre.confirmed, 0);
      assert.equal(pre.ulocked, 0);
      assert.equal(pre.clocked, 0);

      const claim = await wallet.sendFakeClaim('cloudflare');
      assert(claim);

      const tx = claim.toTX(network, wdb.state.height + 1);
      const entry = nextEntry(wdb);
      await wdb.addBlock(entry, [tx]);

      const ns = await wallet.getNameState(nameHash);
      const json = ns.getJSON(wdb.state.height, network);
      assert.equal(json.name, 'cloudflare');
      assert.equal(json.state, 'LOCKED');

      const post = await wallet.getBalance();
      assert.equal(post.tx, 1);
      assert.equal(post.coin, 1);
      assert.equal(post.unconfirmed, lockup);
      assert.equal(post.confirmed, lockup);
      assert.equal(post.ulocked, lockup);
      assert.equal(post.clocked, lockup);
    });

    it('should advance past lockup period', async () => {
      const ns = await wallet.getNameState(nameHash);
      const json = ns.getJSON(wdb.state.height, network);
      const {blocksUntilClosed} = json.stats;

      for (let i = 0; i < blocksUntilClosed; i++) {
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, []);
      }

      {
        const ns = await wallet.getNameState(nameHash);
        const json = ns.getJSON(wdb.state.height, network);
        assert.equal(json.name, 'cloudflare');
        assert.equal(json.state, 'CLOSED');
      }
    });

    it('should send an update for cloudflare', async () => {
      const pre = await wallet.getBalance();
      assert.equal(pre.tx, 1);
      assert.equal(pre.coin, 1);
      assert.equal(pre.unconfirmed, lockup);
      assert.equal(pre.confirmed, lockup);
      assert.equal(pre.ulocked, lockup);
      assert.equal(pre.clocked, lockup);

      const records = Resource.fromJSON({
        records: [{type: 'NS', ns: 'ns1.easyhandshake.com.'}]
      });

      update = await wallet.sendUpdate('cloudflare', records);
      const entry = nextEntry(wdb);
      await wdb.addBlock(entry, [update]);

      const ns = await wallet.getNameState(nameHash);
      const json = ns.getJSON(wdb.state.height, network);
      assert.equal(json.name, 'cloudflare');

      const resource = Resource.decode(ns.data);
      assert.deepEqual(records.toJSON(), resource.toJSON());

      // The unconfirmed and confirmed values should
      // take into account the transaction fee. Assert
      // against the value of the newly created output.
      const val = update.output(1).value;
      const post = await wallet.getBalance();
      assert.equal(post.tx, 2);
      assert.equal(post.coin, 2);
      assert.equal(post.unconfirmed, val);
      assert.equal(post.confirmed, val);
      assert.equal(post.ulocked, 0);
      assert.equal(post.clocked, 0);
    });

    it('should remove a block and update balances correctly', async () => {
      const val = update.output(1).value;
      const pre = await wallet.getBalance();
      assert.equal(pre.tx, 2);
      assert.equal(pre.coin, 2);
      assert.equal(pre.unconfirmed, val);
      assert.equal(pre.confirmed, val);
      assert.equal(pre.ulocked, 0);
      assert.equal(pre.clocked, 0);

      const cur = curEntry(wdb);
      await wdb.removeBlock(cur);

      const post = await wallet.getBalance();
      assert.equal(post.tx, 2);
      assert.equal(post.coin, 2);
      // The unconfirmed balance includes value in the mempool
      // and the chain itself. The reorg'd tx can be included
      // in another block so the unconfirmed total does not
      // include the tx fee. That value has been effectively
      // spent already.
      assert.equal(post.unconfirmed, val);
      assert.equal(post.confirmed, lockup);
      assert.equal(post.ulocked, 0);
      assert.equal(post.clocked, lockup);
    });

    it('should update balances correctly after abandon', async () => {
      const val = update.output(1).value;
      const pre = await wallet.getBalance();
      assert.equal(pre.tx, 2);
      assert.equal(pre.coin, 2);
      assert.equal(pre.unconfirmed, val);
      assert.equal(pre.confirmed, lockup);
      assert.equal(pre.ulocked, 0);
      assert.equal(pre.clocked, lockup);

      assert(await wallet.txdb.hasTX(update.hash()));
      await wallet.abandon(update.hash());

      // The UPDATE was abandoned and now the wallet
      // reflects only the CLAIM, so these values
      // should match the wallet balance post
      // 'should confirm cloudflare CLAIM'
      const post = await wallet.getBalance();
      assert.equal(post.tx, 1);
      assert.equal(post.coin, 1);
      assert.equal(post.unconfirmed, lockup);
      assert.equal(post.confirmed, lockup);
      assert.equal(post.ulocked, lockup);
      assert.equal(post.clocked, lockup);

      const coins = await wallet.getCoins();
      assert.equal(coins.length, 1);
      const [claim] = coins;
      assert.equal(claim.covenant.isClaim(), true);
    });
  });
});
