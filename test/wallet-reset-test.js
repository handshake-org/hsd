/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const Resource = require('../lib/dns/resource');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')],
  port: 10000,
  httpPort: 20000,
  rsPort: 30000,
  nsPort: 40000
});

const peer = new FullNode({
  memory: true,
  network: 'regtest',
  listen: true
});

const {wdb} = node.require('walletdb');

const name = rules.grindName(5, 1, network);
let alice, aliceReceive, bob, bobReceive;
let balanceAfterRegister;
let walletNamestateAfterRegister;
let nodeNamestateAfterRegister;
let balanceAfterFinalize;
let walletNamestateAfterFinalize;
let nodeNamestateAfterFinalize;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Chain reset with wallet', function() {
  this.timeout(20000);

  before(async () => {
    await peer.open();
    await peer.connect();
    peer.startSync();

    await node.open();
    await node.connect();
    node.startSync();

    alice = await wdb.create();
    const aliceAcct0 = await alice.getAccount(0);
    aliceReceive = await aliceAcct0.receiveAddress();

    bob = await wdb.create();
    const bobAcct0 = await bob.getAccount(0);
    bobReceive = await bobAcct0.receiveAddress();
  });

  after(async () => {
    await node.close();
    await peer.close();
  });

  it('should fund wallet', async () => {
    await mineBlocks(2, aliceReceive);
    await wdb.rescan(0);
  });

  it('should open an auction and proceed to REGISTER', async () => {
    await alice.sendOpen(name, false, {account: 0});
    await mineBlocks(network.names.treeInterval + 2);
    await wdb.rescan(0);

    await alice.sendBid(name, 100000, 200000, {account: 0});
    await mineBlocks(network.names.biddingPeriod);
    await wdb.rescan(0);

    await alice.sendReveal(name, {account: 0});
    await mineBlocks(network.names.revealPeriod);
    await wdb.rescan(0);

    const aliceResource = Resource.Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['ALICE']
        }
      ]
    });

    await alice.sendUpdate(name, aliceResource, {account: 0});
    await mineBlocks(network.names.treeInterval);
    await wdb.rescan(0);
  });

  it('should check balance and namestate', async () => {
    balanceAfterRegister = await alice.getBalance();
    walletNamestateAfterRegister = await alice.getNameStateByName(name);
    nodeNamestateAfterRegister = await node.chain.db.getNameStateByName(name);

    assert.deepStrictEqual(
      walletNamestateAfterRegister,
      nodeNamestateAfterRegister
    );
  });

  it('should reset chain', async () => {
    // Wait for nodes to sync
    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(
      node.chain.tip,
      peer.chain.tip
    );
    await node.chain.reset(1);

    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(
      node.chain.tip,
      peer.chain.tip
    );
  });

  it('should check balance and namestate', async () => {
    const balanceAfterReset = await alice.getBalance();
    const walletNamestateAfterReset = await alice.getNameStateByName(name);
    const nodeNamestateAfterReset = await node.chain.db.getNameStateByName(name);

    assert.deepStrictEqual(
      walletNamestateAfterRegister,
      walletNamestateAfterReset
    );
    assert.deepStrictEqual(
      balanceAfterRegister,
      balanceAfterReset
    );
    assert.deepStrictEqual(
      walletNamestateAfterReset,
      nodeNamestateAfterReset
    );
  });

  it('should TRANSFER and FINALIZE', async () => {
    await alice.sendTransfer(name, bobReceive);
    await mineBlocks(network.names.transferLockup + 1);
    await wdb.rescan(0);

    await alice.sendFinalize(name);
    await mineBlocks(10);
    await wdb.rescan(0);
  });

  it('should check balance and namestate', async () => {
    balanceAfterFinalize = await alice.getBalance();
    walletNamestateAfterFinalize = await alice.getNameStateByName(name);
    nodeNamestateAfterFinalize = await node.chain.db.getNameStateByName(name);

    assert.deepStrictEqual(
      walletNamestateAfterFinalize,
      nodeNamestateAfterFinalize
    );
  });

  it('should reset chain', async () => {
    // Wait for nodes to sync
    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(
      node.chain.tip,
      peer.chain.tip
    );
    await node.chain.reset(1);

    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(
      node.chain.tip,
      peer.chain.tip
    );
  });

  it('should check balance and namestate', async () => {
    const balanceAfterFinalizeAndReset = await alice.getBalance();
    const walletNamestateAfterFinalizeAndReset = await alice.getNameStateByName(name);
    const nodeNamestateAfterFinalizeAndReset = await node.chain.db.getNameStateByName(name);

    assert.deepStrictEqual(
      walletNamestateAfterFinalize,
      walletNamestateAfterFinalizeAndReset
    );
    assert.deepStrictEqual(
      balanceAfterFinalize,
      balanceAfterFinalizeAndReset
    );
    assert.deepStrictEqual(
      walletNamestateAfterFinalizeAndReset,
      nodeNamestateAfterFinalizeAndReset
    );
  });
});
