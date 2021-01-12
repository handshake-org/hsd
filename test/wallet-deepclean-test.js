/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const Resource = require('../lib/dns/resource');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');

const nullBalance = {
  account: -1,
  tx: 0,
  coin: 0,
  unconfirmed: 0,
  confirmed: 0,
  lockedUnconfirmed: 0,
  lockedConfirmed: 0
};

let alice, aliceReceive, aliceAcct0;
let aliceAcct0Info, aliceNames, aliceBalance, aliceHistory;
let bob, bobReceive, bobAcct0;
let bobAcct0Info, bobNames, bobBalance, bobHistory;

const aliceBlinds = [];
const bobBlinds = [];

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Wallet Deep Clean', function() {
  this.timeout(20000);

  before(async () => {
    await node.open();
    await node.connect();
    node.startSync();

    alice = await wdb.create();
    aliceAcct0 = await alice.getAccount(0);
    aliceReceive = await aliceAcct0.receiveAddress();

    bob = await wdb.create();
    bobAcct0 = await bob.getAccount(0);
    bobReceive = await bobAcct0.receiveAddress();
  });

  after(async () => {
    await node.close();
  });

  it('should fund wallets', async () => {
    // Also mines enough blocks to roll out all names
    await mineBlocks(30, aliceReceive);
    await mineBlocks(30, bobReceive);
  });

  it('should open 10 auctions and REGISTER names', async () => {
    for (let i = 0; i < 10; i++) {
      const w = i < 5 ? alice : bob;
      const name = i < 5 ? `alice${i}` : `bob${i}`;
      const array = i < 5 ? aliceBlinds : bobBlinds;

      await w.sendOpen(name, false, {account: 0});
      await mineBlocks(network.names.treeInterval + 2);

      // Send two bids so there is a winner/loser and name gets a value
      const bid1 = await w.sendBid(name, 100000 + i, 200000 + i, {account: 0});
      const bid2 = await w.sendBid(name, 100000 - i, 200000 - i, {account: 0});
      saveBlindValue(bid1, array);
      saveBlindValue(bid2, array);
      await mineBlocks(network.names.biddingPeriod);

      await w.sendReveal(name, {account: 0});
      await mineBlocks(network.names.revealPeriod);

      const res = Resource.Resource.fromJSON({
        records: [
          {
            type: 'TXT',
            txt: [name]
          }
        ]
      });

      await w.sendUpdate(name, res, {account: 0});
      await w.sendRedeem(name, {account: 0});
      await mineBlocks(network.names.treeInterval);
    }
  });

  it('should TRANSFER and FINALIZE some names', async () => {
    const bobReceiveName = await bobAcct0.receiveAddress();
    await alice.sendTransfer('alice0', bobReceiveName);
    await mineBlocks(network.names.transferLockup + 1);

    await alice.sendFinalize('alice0');
    await mineBlocks(10);

    const aliceReceiveName = await aliceAcct0.receiveAddress();
    await bob.sendTransfer('bob9', aliceReceiveName);
    await mineBlocks(network.names.transferLockup + 1);

    await bob.sendFinalize('bob9');
    await mineBlocks(10);
  });

  it('should send 20 normal transactions', async () => {
    for (let i = 0; i < 20; i++) {
      const send = i < 5 ? alice : bob;
      const rec = i < 5 ? bobAcct0 : aliceAcct0;
      const address = rec.receiveAddress();
      const value = 1212 + (i * 10);

      await send.send({
        outputs: [
          {
            address,
            value
          }
        ]
      });
      await mineBlocks(1);
    }
  });

  it('should save wallet data', async () => {
    aliceBalance = await alice.getBalance();
    aliceNames = await alice.getNames();
    aliceHistory = await alice.getHistory();
    aliceAcct0Info = await alice.getAccount(0);

    bobBalance = await bob.getBalance();
    bobNames = await bob.getNames();
    bobHistory = await bob.getHistory();
    bobAcct0Info = await bob.getAccount(0);
  });

  it('should DEEP CLEAN', async () => {
    await wdb.deepClean();
  });

  it('should have erased wallet data', async () => {
    const aliceBalance2 = await alice.getBalance();
    const aliceNames2 = await alice.getNames();
    const aliceHistory2 = await alice.getHistory();
    const aliceAcct0Info2 = await alice.getAccount(0);

    const bobBalance2 = await bob.getBalance();
    const bobNames2 = await bob.getNames();
    const bobHistory2 = await bob.getHistory();
    const bobAcct0Info2 = await bob.getAccount(0);

    // Account metadata is fine
    assert.deepStrictEqual(aliceAcct0Info, aliceAcct0Info2);
    assert.deepStrictEqual(bobAcct0Info, bobAcct0Info2);

    // Blind values are fine
    for (const blind of aliceBlinds) {
      assert(await alice.getBlind(blind));
    }
    for (const blind of bobBlinds) {
      assert(await bob.getBlind(blind));
    }

    // Everything else is wiped
    assert.deepStrictEqual(aliceBalance2.getJSON(), nullBalance);
    assert.deepStrictEqual(bobBalance2.getJSON(), nullBalance);
    compareNames(aliceNames2, []);
    compareHistories(aliceHistory2, []);
    compareNames(bobNames2, []);
    compareHistories(bobHistory2, []);
  });

  it('should rescan wallets', async () => {
    await wdb.rescan(0);
  });

  it('should have recovered wallet data', async () => {
    const aliceBalance2 = await alice.getBalance();
    const aliceNames2 = await alice.getNames();
    const aliceHistory2 = await alice.getHistory();
    const aliceAcct0Info2 = await alice.getAccount(0);

    const bobBalance2 = await bob.getBalance();
    const bobNames2 = await bob.getNames();
    const bobHistory2 = await bob.getHistory();
    const bobAcct0Info2 = await bob.getAccount(0);

    assert.deepStrictEqual(aliceBalance, aliceBalance2);
    assert.deepStrictEqual(aliceAcct0Info, aliceAcct0Info2);
    compareNames(aliceNames, aliceNames2);
    compareHistories(aliceHistory, aliceHistory2);

    assert.deepStrictEqual(bobBalance, bobBalance2);
    assert.deepStrictEqual(bobAcct0Info, bobAcct0Info2);
    compareNames(bobNames, bobNames2);
    compareHistories(bobHistory, bobHistory2);
  });
});

function compareHistories(a, b) {
  for (let i = 0; i < a.length; i ++) {
    const objA = a[i];
    const objB = b[i];

    for (const prop of Object.keys(objA)) {
      // Wall-clock time that TX was inserted, ignore after rescan
      if (prop === 'mtime')
        continue;

      assert.deepStrictEqual(objA[prop], objB[prop]);
    }
  }
}

function compareNames(a, b) {
  for (let i = 0; i < a.length; i ++) {
    const objA = a[i];
    const objB = b[i];

    for (const prop of Object.keys(objA)) {
      // Highest bid and current data are not transmitted in the FINALIZE
      // so they are unknown to the wallet until the chain is rescanned.
      if (prop === 'highest' || prop === 'data')
        continue;

      assert.deepStrictEqual(objA[prop], objB[prop]);
    }
  }
}

function saveBlindValue(tx, array) {
  for (const output of tx.outputs) {
    const cov = output.covenant;
    if (!cov.isBid())
      continue;

    array.push(cov.getHash(3));
  }
}
