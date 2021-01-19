/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const WalletNode = require('../lib/wallet/node');
const {forValue} = require('./util/common');

describe('Wallet Rescan (plugin)', function() {
  const node = new FullNode({
    memory: true,
    network: 'regtest',
    plugins: [require('../lib/wallet/plugin')]
  });

  const {wdb} = node.require('walletdb');
  let wallet, account, address;

  async function mineBlocks(n, addr) {
    for (let i = 0; i < n; i++) {
      const block = await node.miner.mineBlock(null, addr);
      await node.chain.add(block);
    }
    await forValue(wdb, 'height', node.chain.height);
  }

  before(async () => {
    await node.open();
  });

  after(async () => {
    await node.close();
  });

  it('should generate 100 blocks to wallet address', async () => {
    wallet = await wdb.create();
    account = await wallet.getAccount(0);
    address = await account.receiveAddress();
    await mineBlocks(100, address);
    assert.strictEqual(node.chain.height, 100);
  });

  it('should manually rescan after rollback', async () => {
    const initialBalance = await wallet.getBalance(0);
    assert.strictEqual(initialBalance.confirmed, 100 * 2000 * 1e6);

    await wdb.rollback(0);
    await forValue(wdb, 'height', 0);
    const midBalance = await wallet.getBalance(0);
    assert.strictEqual(midBalance.confirmed, 0);

    await wdb.rescan(0);
    const finalBalance = await wallet.getBalance(0);
    assert.deepStrictEqual(initialBalance, finalBalance);
  });

  it('should rescan after rollback on block connect', async () => {
    // Rollback the wallet
    await wdb.rollback(0);
    await forValue(wdb, 'height', 0);
    const midBalance = await wallet.getBalance(0);
    assert.strictEqual(midBalance.confirmed, 0);

    // Wallet state is way behind chain state
    assert.strictEqual(node.chain.height, 100);
    assert.strictEqual(wdb.state.height, 0);

    // Adding a new block to the chain should trigger a wallet rescan
    // if the wallet state is behind the chain height.
    await mineBlocks(1, address);

    const finalBalance = await wallet.getBalance(0);
    assert.strictEqual(finalBalance.confirmed, 101 * 2000 * 1e6);
  });
});

describe('Wallet Rescan (node)', function() {
  const node = new FullNode({
    memory: true,
    network: 'regtest'
  });

  const walletNode = new WalletNode({
    memory: true,
    network: 'regtest'
  });

  const {wdb} = walletNode;
  let wallet, account, address;

  async function mineBlocks(n, addr) {
    for (let i = 0; i < n; i++) {
      const block = await node.miner.mineBlock(null, addr);
      await node.chain.add(block);
    }
    await forValue(wdb, 'height', node.chain.height);
  }

  before(async () => {
    await node.open();
    await walletNode.open();
  });

  after(async () => {
    await walletNode.close();
    await node.close();
  });

  it('should generate 100 blocks to wallet address', async () => {
    wallet = await wdb.create();
    account = await wallet.getAccount(0);
    address = await account.receiveAddress();
    await mineBlocks(100, address);
    assert.strictEqual(node.chain.height, 100);
  });

  it('should manually rescan after rollback', async () => {
    const initialBalance = await wallet.getBalance(0);
    assert.strictEqual(initialBalance.confirmed, 100 * 2000 * 1e6);

    await wdb.rollback(0);
    await forValue(wdb, 'height', 0);
    const midBalance = await wallet.getBalance(0);
    assert.strictEqual(midBalance.confirmed, 0);

    await wdb.rescan(0);
    const finalBalance = await wallet.getBalance(0);
    assert.deepStrictEqual(initialBalance, finalBalance);
  });

  it('should rescan after rollback on block connect', async () => {
    // Rollback the wallet
    await wdb.rollback(0);
    await forValue(wdb, 'height', 0);
    const midBalance = await wallet.getBalance(0);
    assert.strictEqual(midBalance.confirmed, 0);

    // Wallet state is way behind chain state
    assert.strictEqual(node.chain.height, 100);
    assert.strictEqual(wdb.state.height, 0);

    // Adding a new block to the chain should trigger a wallet rescan
    // if the wallet state is behind the chain height.
    await mineBlocks(1, address);

    const finalBalance = await wallet.getBalance(0);
    assert.strictEqual(finalBalance.confirmed, 101 * 2000 * 1e6);
  });
});
