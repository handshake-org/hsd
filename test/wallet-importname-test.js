/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const {WalletClient} = require('hs-client');

const network = Network.get('regtest');

const ports = {
  p2p: 14331,
  node: 14332,
  wallet: 14333
};
const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')],
  env: {
    'HSD_WALLET_HTTP_PORT': ports.wallet.toString()
  }
});

const wclient = new WalletClient({
  port: ports.wallet
});

const {wdb} = node.require('walletdb');

const name = rules.grindName(5, 1, network);
const nameHash = rules.hashName(name);
const wrongName = rules.grindName(5, 1, network);
const wrongNameHash = rules.hashName(wrongName);

let alice, bob, aliceReceive, bobReceive;
let charlie;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Wallet Import Name', function() {
  before(async () => {
    await node.open();
    await wclient.open();

    alice = await wdb.create();
    bob = await wdb.create();
    charlie = await wdb.create({id: 'charlie'});

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();
  });

  after(async () => {
    await wclient.close();
    await node.close();
  });

  it('should fund both wallets', async () => {
    await mineBlocks(2, aliceReceive);
    await mineBlocks(2, bobReceive);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const aliceBal = await alice.getBalance();
    const bobBal = await bob.getBalance();
    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
    assert(bobBal.confirmed === 2000 * 2 * 1e6);
  });

  it('should open name from Alice\'s wallet', async () => {
    // Alice an Bob are not tracking this name
    const ns1 = await alice.getNameStateByName(name);
    assert(ns1 === null);
    const ns2 = await bob.getNameStateByName(name);
    assert(ns2 === null);

    await alice.sendOpen(name, false);
    await alice.sendOpen(wrongName, false);

    await mineBlocks(network.names.treeInterval);
    await wdb.rescan(0);

    // Alice is now tracking, Bob is not
    const ns3 = await alice.getNameStateByName(name);
    assert(ns3);
    const ns4 = await bob.getNameStateByName(name);
    assert(ns4 === null);
  });

  it('should not re-import an existing name', async () => {
    await assert.rejects(
      alice.importName(name),
      {message: 'Name already exists.'}
    );
  });

  it('should bid on names from Alice\'s wallet', async () => {
    // Sanity check: bids are allowed starting in the NEXT block
    await assert.rejects(
      alice.sendBid(name, 100001, 200001),
      {message: 'Name has not reached the bidding phase yet.'}
    );
    await mineBlocks(1);
    await wdb.rescan(0);

    // Send 1 bid, confirm
    await alice.sendBid(name, 100001, 200001);
    await mineBlocks(1);

    // Send 2 bids in one block, confirm
    await alice.sendBid(name, 100002, 200002);
    await alice.sendBid(name, 100003, 200003);
    await mineBlocks(1);

    // Send 3 bids in one block, confirm
    await alice.sendBid(name, 100004, 200004);
    await alice.sendBid(name, 100005, 200005);
    await alice.sendBid(name, 100006, 200006);
    await mineBlocks(1);

    // One block with some bids for another name
    await alice.sendBid(wrongName, 100007, 200007);
    await alice.sendBid(wrongName, 100008, 200008);
    await mineBlocks(1);

    // Still in the bidding phase with one block left
    const ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isBidding(node.chain.height + 1, network));

    await wdb.rescan(0);

    // Alice is tracking auction, Bob is not
    const aliceBids = await alice.getBidsByName(name);
    assert.strictEqual(aliceBids.length, 6);
    for (const bid of aliceBids)
      assert(bid.own);

    const bobBids = await bob.getBidsByName(name);
    assert.strictEqual(bobBids.length, 0);
  });

  it('should import name into Bob\'s wallet', async () => {
    await bob.importName(name);

    // Bob's wallet still has no name data for this name
    const ns1 = await bob.getNameStateByName(name);
    assert(ns1 === null);

    // The WalletDB knows Alice & Bob are watching this name
    const map1 = await wdb.getNameMap(nameHash);
    assert(map1.wids.has(alice.wid));
    assert(map1.wids.has(bob.wid));

    // Only Alice is watching the other name
    const map2 = await wdb.getNameMap(wrongNameHash);
    assert(map1.wids.has(alice.wid));
    assert(!map2.wids.has(bob.wid));
  });

  it('should not track bids for imported name before OPEN', async () => {
    // Rescan covers bidding phase but does not include OPEN transaction
    await wdb.rescan(6);

    // Alice is tracking auction, Bob is not
    const aliceBids = await alice.getBidsByName(name);
    assert.strictEqual(aliceBids.length, 6);
    for (const bid of aliceBids)
      assert(bid.own);

    const bobBids = await bob.getBidsByName(name);
    assert.strictEqual(bobBids.length, 0);
  });

  it('should start tracking bids after seeing OPEN', async () => {
    await wdb.rescan(0);

    // After a sufficient rescan, Bob now has all auction data
    const ns2 = await bob.getNameStateByName(name);
    assert(ns2);

    // ...even though he hasn't placed a bid yet
    const bobBids = await bob.getBidsByName(name);
    assert.strictEqual(bobBids.length, 6);
    for (const bid of bobBids)
      assert(!bid.own);

    // Sanity check: only the "right" name was imported
    const ns3 = await bob.getNameStateByName(wrongName);
    assert(ns3 === null);
    const ns4 = await alice.getNameStateByName(wrongName);
    assert(ns4);
  });

  describe('rpc importname', function() {
    it('should not have name data in Charlie\'s wallet', async () => {
      const ns1 = await charlie.getNameStateByName(name);
      assert(ns1 === null);
    });

    it('should import name with rescan', async () => {
      await wclient.execute('selectwallet', ['charlie']);
      await wclient.execute('importname', [name, 0]);

      const ns1 = await charlie.getNameStateByName(name);
      assert(ns1);

      const charlieBids = await bob.getBidsByName(name);
      assert.strictEqual(charlieBids.length, 6);
      for (const bid of charlieBids)
        assert(!bid.own);
    });

    it('should not re-import name', async () => {
      await wclient.execute('selectwallet', ['charlie']);

      await assert.rejects(
        wclient.execute('importname', [name, 0]),
        {message: 'Name already exists.'}
      );
    });
  });
});
