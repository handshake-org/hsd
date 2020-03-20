/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const Resource = require('../lib/dns/resource');
const {WalletClient} = require('hs-client');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

// Prevent mempool from sending duplicate TXs back to the walletDB and txdb.
// This will prevent a race condition when we need to remove spent (but
// unconfirmed) outputs from the wallet so they can be reused in other tests.
node.mempool.emit = () => {};

const wclient = new WalletClient({
  port: network.walletPort
});

const {wdb} = node.require('walletdb');

const name = rules.grindName(5, 1, network);
let wallet, alice, bob, aliceReceive, bobReceive;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Multiple accounts participating in same auction', function() {
  before(async () => {
    await node.open();
    await wclient.open();

    wallet = await wdb.create();

    // We'll use an account number for alice and a string for bob
    // to ensure that both types work as options.
    alice = await wallet.getAccount(0);
    bob = await wallet.createAccount({name: 'bob'});

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();
  });

  after(async () => {
    await wclient.close();
    await node.close();
  });

  it('should fund both accounts', async () => {
    await mineBlocks(2, aliceReceive);
    await mineBlocks(2, bobReceive);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const aliceBal = await wallet.getBalance(0);
    const bobBal = await wallet.getBalance('bob');
    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
    assert(bobBal.confirmed === 2000 * 2 * 1e6);
  });

  it('should open an auction and proceed to REVEAL phase', async () => {
    await wallet.sendOpen(name, false, {account: 0});
    await mineBlocks(network.names.treeInterval + 2);
    let ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isBidding(node.chain.height, network));

    await wdb.rescan(0);

    await wallet.sendBid(name, 100000, 200000, {account: 0});
    await wallet.sendBid(name, 50000, 200000, {account: 'bob'});
    await mineBlocks(network.names.biddingPeriod);
    ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isReveal(node.chain.height, network));

    await wdb.rescan(0);

    const walletBids = await wallet.getBidsByName(name);
    assert.strictEqual(walletBids.length, 2);

    for (const bid of walletBids)
      assert(bid.own);

    assert.strictEqual(node.mempool.map.size, 0);
  });

  describe('REVEAL', function() {
    it('should send one REVEAL per account', async () => {
      const tx1 = await wallet.sendReveal(name, {account: 0});
      assert(tx1);

      const tx2 = await wallet.sendReveal(name, {account: 'bob'});
      assert(tx2);

      // Reset for next test
      await wallet.abandon(tx1.hash());
      await wallet.abandon(tx2.hash());

      assert.strictEqual(node.mempool.map.size, 2);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send one REVEAL for all accounts in one tx', async () => {
      const tx = await wallet.sendRevealAll();
      assert(tx);

      // Reset for next test
      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await mineBlocks(1);
      assert.strictEqual(node.mempool.map.size, 0);
    });
  });

  describe('UPDATE', function() {
    const aliceResource = Resource.Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['ALICE']
        }
      ]});
    const bobResource = Resource.Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['BOB']
        }
      ]});

    it('should advance auction to REGISTER phase', async () => {
      await mineBlocks(network.names.revealPeriod);
      const ns = await node.chain.db.getNameStateByName(name);
      assert(ns.isClosed(node.chain.height, network));

      await wdb.rescan(0);

      // Alice is the winner
      const {hash, index} = ns.owner;
      assert(await wallet.txdb.hasCoinByAccount(0, hash, index));

      // ...not Bob (sanity check)
      assert(!await wallet.txdb.hasCoinByAccount(1, hash, index));
    });

    it('should reject REGISTER given wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendUpdate(name, bobResource, {account: 'bob'});
      }, {
        name: 'Error',
        message: `Account does not own: "${name}".`
      });
    });

    it('should send REGISTER given correct account', async () => {
      const tx = await wallet.sendUpdate(name, aliceResource, {account: 0});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send REGISTER from correct account automatically', async () => {
      const tx = await wallet.sendUpdate(name, aliceResource);
      assert(tx);

      await mineBlocks(1);
    });
  });

  describe('REDEEM', function() {
    it('should reject REDEEM given wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendRedeem(name, {account: 0});
      }, {
        name: 'Error',
        message: 'No reveals to redeem.'
      });
    });

    it('should send REDEEM from correct account', async () => {
      const tx = await wallet.sendRedeem(name, {account: 'bob'});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send REDEEM from correct account automatically', async () => {
      const tx = await wallet.sendRedeem(name);
      assert(tx);

      await mineBlocks(1);
    });
  });

  describe('RENEW', function() {
    it('should advance chain to allow renewal', async () => {
      await mineBlocks(network.names.treeInterval);
      await wdb.rescan(0);
    });

    it('should reject RENEW from wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendRenewal(name, {account: 'bob'});
      }, {
        name: 'Error',
        message: `Account does not own: "${name}".`
      });
    });

    it('should send RENEW from correct account', async () => {
      const tx = await wallet.sendRenewal(name, {account: 0});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send RENEW from correct account automatically', async () => {
      const tx = await wallet.sendRenewal(name);
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });
  });

  describe('TRANSFER', function() {
    // Alice will transfer to Bob
    let toAddr;

    before(async () => {
      toAddr = await bob.receiveAddress();
    });

    it('should reject TRANSFER from wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendTransfer(name, toAddr, {account: 'bob'});
      }, {
        name: 'Error',
        message: `Account does not own: "${name}".`
      });
    });

    it('should send TRANSFER from correct account', async () => {
      const tx = await wallet.sendTransfer(name, toAddr, {account: 0});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send TRANSFER from correct account automatically', async () => {
      const tx = await wallet.sendTransfer(name, toAddr);
      assert(tx);

      await mineBlocks(1);
    });
  });

  describe('FINALIZE', function() {
    it('should advance chain until FINALIZE is allowed', async () => {
      await mineBlocks(network.names.transferLockup);
      const ns = await node.chain.db.getNameStateByName(name);
      assert(ns.isClosed(node.chain.height, network));

      await wdb.rescan(0);
    });

    it('should reject FINALIZE from wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendFinalize(name, {account: 'bob'});
      }, {
        name: 'Error',
        message: `Account does not own: "${name}".`
      });
    });

    it('should send FINALIZE from correct account', async () => {
      const tx = await wallet.sendFinalize(name, {account: 0});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send FINALIZE from correct account automatically', async () => {
      const tx = await wallet.sendFinalize(name);
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });
  });

  describe('CANCEL', function() {
    it('should reject CANCEL from wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendCancel(name, {account: 'bob'});
      }, {
        name: 'Error',
        message: `Account does not own: "${name}".`
      });
    });

    it('should send CANCEL from correct account', async () => {
      const tx = await wallet.sendCancel(name, {account: 0});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send CANCEL from correct account automatically', async () => {
      const tx = await wallet.sendCancel(name);
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });
  });

  describe('REVOKE', function() {
    it('should reject REVOKE from wrong account', async () => {
      await assert.rejects(async () => {
        await wallet.sendRevoke(name, {account: 'bob'});
      }, {
        name: 'Error',
        message: `Account does not own: "${name}".`
      });
    });

    it('should send REVOKE from correct account', async () => {
      const tx = await wallet.sendRevoke(name, {account: 0});
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should send REVOKE from correct account automatically', async () => {
      const tx = await wallet.sendRevoke(name);
      assert(tx);

      await wallet.abandon(tx.hash());

      assert.strictEqual(node.mempool.map.size, 1);
      await node.mempool.reset();
      assert.strictEqual(node.mempool.map.size, 0);
    });
  });
});
