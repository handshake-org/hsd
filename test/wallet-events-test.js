'use strict';

const assert = require('bsert');
const Address = require('../lib/primitives/address');
const FullNode = require('../lib/node/fullnode');
const Wallet = require('../lib/wallet/wallet');
const WalletKey = require('../lib/wallet/walletkey');
const ChainEntry = require('../lib/blockchain/chainentry');
const MemWallet = require('./util/memwallet');
const {forEvent} = require('./util/common');

describe('WalletDB Events', function () {
  const node = new FullNode({
    memory: true,
    network: 'regtest',
    noDNS: true,
    plugins: [require('../lib/wallet/plugin')]
  });

  const { wdb } = node.require('walletdb');
  let wallet;

  async function mineBlocks(n, addr) {
    addr = addr ? addr : new Address().toString('regtest');
    for (let i = 0; i < n; i++) {
      const block = await node.miner.mineBlock(null, addr);
      await node.chain.add(block);
    }
  }

  before(async () => {
    await node.open();
    wallet = await wdb.get('primary');
  });

  after(async () => {
    await node.close();
  });

  it('should emit `open`/`close` and `connect`/`disconnect` events', async () => {
    const closeEvent = forEvent(wdb, 'close');
    const disconnectEvent = forEvent(wdb, 'disconnect');
    await node.close();
    await disconnectEvent;
    await closeEvent;

    const openEvent = forEvent(wdb, 'open');
    const connectEvent = forEvent(wdb, 'connect');
    const syncDone = forEvent(wdb, 'sync done');
    await node.open();
    await openEvent;
    await connectEvent;
    await syncDone;

    wallet = await wdb.get('primary');
  });

  it('should emit `tx` events', async () => {
    const waiter = forEvent(wdb, 'tx');
    const walletReceive = await wallet.receiveAddress();
    await mineBlocks(1, walletReceive);

    const events = await waiter;
    const [w, tx] = events[0].values;

    assert(w);
    assert(w instanceof Wallet);
    assert(w.wid === 0);

    assert(tx);
    assert(tx.outputs[0].address.equals(walletReceive));
    assert(tx.outputs[0].value === 2000 * 1e6);
  });

  it('should emit `address` events', async () => {
    const waiter = forEvent(wdb, 'address');

    const walletReceive = await wallet.receiveAddress();
    await mineBlocks(1, walletReceive);

    const events = await waiter;
    const [w, walletKey] = events[0].values;

    assert(w);
    assert(w instanceof Wallet);
    assert(w.wid === 0);

    assert(walletKey);
    assert(Array.isArray(walletKey) && walletKey.length > 0);
    assert(walletKey[0] instanceof WalletKey);
  });

  describe('should emit `block connect` events', () => {
    it('with a block that includes a wallet tx', async () => {
      const waiter = forEvent(wdb, 'block connect');
      const walletReceive = await wallet.receiveAddress();

      await wallet.send({
        outputs: [
          { address: walletReceive, value: 42 * 1e6 }
        ]
      });

      await mineBlocks(1);

      const events = await waiter;
      const [entry, txs] = events[0].values;

      assert(entry);
      assert(entry instanceof ChainEntry);

      assert(txs);
      assert(Array.isArray(txs) && txs.length === 1);
      const output = txs[0].outputs.find(
        output => output.address.equals(walletReceive) && output.value === 42 * 1e6
      );
      assert(output);
    });

    it('with a block that does not include a wallet tx', async () => {
      // Create a transaction not related to any wallet in wdb
      let otherTx;
      {
        // New wallet
        const otherWallet = new MemWallet({ network: 'regtest' });

        node.chain.on('connect', (entry, block) => {
          otherWallet.addBlock(entry, block.txs);
        });

        // Fund wallet
        const otherReceive = await otherWallet.getReceive();
        await mineBlocks(2, otherReceive);

        // Create tx
        const otherMtx = await otherWallet.create({
          outputs: [
            { address: await otherWallet.getReceive(), value: 42 * 1e6 }
          ]
        });
        await otherWallet.sign(otherMtx);
        otherTx = otherMtx.toTX();
      }

      const waiter = forEvent(wdb, 'block connect');

      await node.sendTX(otherTx);

      await mineBlocks(1);

      const events = await waiter;
      const [entry, txs] = events[0].values;

      assert(entry);
      assert(entry instanceof ChainEntry);

      // txs is empty as none belong to any wallet
      assert(txs);
      assert(Array.isArray(txs) && txs.length === 0);
    });
  });

  describe('should emit `block disconnect` events', () => {
    it('with a block that includes a wallet tx', async () => {
      // Mine a block
      const walletReceive = await wallet.receiveAddress();
      await wallet.send({
        outputs: [
          { address: walletReceive, value: 42 * 1e6 }
        ]
      });
      await mineBlocks(1);

      // Disconnect it
      const waiter = forEvent(wdb, 'block disconnect');

      const entryToDisconnect = node.chain.tip;
      await node.chain.disconnect(entryToDisconnect);

      const events = await waiter;
      const entry = events[0].values[0];

      assert(entry);
      assert(entry instanceof ChainEntry);
      assert(entry.hash = entryToDisconnect.hash);
    });

    it('with a block that does not include a wallet tx', async () => {
      const waiter = forEvent(wdb, 'block disconnect');
      const entryToDisconnect = node.chain.tip;
      await node.chain.disconnect(entryToDisconnect);

      const events = await waiter;
      const entry = events[0].values[0];

      assert(entry);
      assert(entry instanceof ChainEntry);
      assert(entry.hash = entryToDisconnect.hash);
    });
  });
});
