'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const {Resource} = require('../lib/dns/resource');
const {forValue} = require('./util/common');

const network = Network.get('regtest');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

const GNAME_SIZE = 10;

describe('Wallet rescan with namestate transitions', function() {
  let node, wdb;
  let alice, aliceAddr;
  let bob, bobAddr;

  async function mineBlocks(n, addr) {
    addr = addr ? addr : new Address().toString('regtest');
    const blocks = [];
    for (let i = 0; i < n; i++) {
      const block = await node.miner.mineBlock(null, addr);
      await node.chain.add(block);
      blocks.push(block);
    }

    return blocks;
  }

  async function sendTXs() {
    const aliceTX = await alice.send({
      outputs: [{
        address: aliceAddr,
        value: 20000
      }]
    });
    alice.addTX(aliceTX.toTX());
    await node.mempool.addTX(aliceTX.toTX());
    await bob.send({
      outputs: [{
        address: bobAddr,
        value: 20000
      }]
    });
  }

  const beforeAll = async () => {
    node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [require('../lib/wallet/plugin')]
    });

    node.on('error', (err) => {
      assert(false, err);
    });

    wdb = node.require('walletdb').wdb;

    alice = new MemWallet({ network });
    aliceAddr = alice.getAddress();

    // Connect MemWallet to chain as minimally as possible
    node.chain.on('connect', (entry, block) => {
      alice.addBlock(entry, block.txs);
    });

    alice.getNameStatus = async (nameHash) => {
      assert(Buffer.isBuffer(nameHash));
      const height = node.chain.height + 1;
      return node.chain.db.getNameStatus(nameHash, height);
    };

    await node.open();
    bob = await wdb.create();
    bobAddr = await bob.receiveAddress();
  };

  const afterAll = async () => {
    await node.close();
  };

  describe('Only sends OPEN', function() {
    const NAME = rules.grindName(GNAME_SIZE, 4, network);
    let aliceFinalizeHash;

    before(beforeAll);
    after(afterAll);

    it('should fund wallets', async () => {
      const blocks = 10;
      await mineBlocks(blocks, aliceAddr);
      await mineBlocks(blocks, bobAddr);

      const bobBal  = await bob.getBalance();
      assert.strictEqual(bobBal.confirmed, blocks * 2000 * 1e6);
      assert.strictEqual(alice.balance, blocks * 2000 * 1e6);
    });

    it('should run auction', async () => {
      // Poor Bob, all he does is send an OPEN but his wallet will
      // watch all the other activity including TRANSFERS for this name
      await bob.sendOpen(NAME);
      // Scatter unrelated TXs throughout the test.
      // This will ensure that txdb.removeBlock() removes TXs
      // in the reverse order from when they were added
      await sendTXs();
      const openBlocks = await mineBlocks(1);
      // Coinbase plus open
      assert.strictEqual(openBlocks[0].txs.length, 4);

      // Advance to bidding phase
      await mineBlocks(treeInterval);
      await forValue(alice, 'height', node.chain.height);

      // Alice sends only bid
      await sendTXs();
      const aliceBid = await alice.createBid(NAME, 20000, 20000);
      await node.mempool.addTX(aliceBid.toTX());
      const bidBlocks = await mineBlocks(1);
      assert.strictEqual(bidBlocks[0].txs.length, 4);

      // Advance to reveal phase
      await mineBlocks(biddingPeriod);
      await sendTXs();
      const aliceReveal = await alice.createReveal(NAME);
      await node.mempool.addTX(aliceReveal.toTX());
      const revealBlocks = await mineBlocks(1);
      assert.strictEqual(revealBlocks[0].txs.length, 4);

      // Close auction
      await mineBlocks(revealPeriod);

      // Alice registers
      await sendTXs();
      const aliceRegister = await alice.createRegister(
        NAME,
        Resource.fromJSON({records:[]})
      );
      await node.mempool.addTX(aliceRegister.toTX());

      const registerBlocks = await mineBlocks(1);
      assert.strictEqual(registerBlocks[0].txs.length, 4);
    });

    it('should get namestate', async () => {
      const ns = await bob.getNameStateByName(NAME);
      // Bob has the namestate
      assert(ns);

      // Bob is not the name owner
      const {hash, index} = ns.owner;
      const coin = await bob.getCoin(hash, index);
      assert.strictEqual(coin, null);

      // Name is not in mid-TRANSFER
      assert.strictEqual(ns.transfer, 0);
    });

    it('should process TRANSFER', async () => {
      // Alice transfers the name to her own address
      await sendTXs();
      const aliceTransfer = await alice.createTransfer(NAME, aliceAddr);
      await node.mempool.addTX(aliceTransfer.toTX());
      const transferBlocks = await mineBlocks(1);
      assert.strictEqual(transferBlocks[0].txs.length, 4);

      // Bob detects the TRANSFER even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);

      // Bob's wallet has not indexed the TRANSFER
      const bobTransfer = await bob.getTX(aliceTransfer.hash());
      assert.strictEqual(bobTransfer, null);
    });

    it('should fully rescan', async () => {
      // Complete chain rescan
      await wdb.rescan(0);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);
    });

    it('should process FINALIZE', async () => {
      await mineBlocks(transferLockup);

      // Alice finalizes the name
      await sendTXs();
      const aliceFinalize = await alice.createFinalize(NAME);
      await node.mempool.addTX(aliceFinalize.toTX());
      const finalizeBlocks = await mineBlocks(1);
      assert.strictEqual(finalizeBlocks[0].txs.length, 4);

      aliceFinalizeHash = aliceFinalize.hash();

      // Bob detects the FINALIZE even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.bufferEqual(ns.owner.hash, aliceFinalizeHash);

      // Bob's wallet has not indexed the FINALIZE
      const bobFinalize = await bob.getTX(aliceFinalize.hash());
      assert.strictEqual(bobFinalize, null);
    });

    it('should fully rescan', async () => {
      // Complete chain rescan
      await wdb.rescan(0);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.bufferEqual(ns.owner.hash, aliceFinalizeHash);
    });

    it('should process TRANSFER (again)', async () => {
      // Alice transfers the name to her own address
      await sendTXs();
      const aliceTransfer = await alice.createTransfer(NAME, aliceAddr);
      await node.mempool.addTX(aliceTransfer.toTX());
      const transferBlocks = await mineBlocks(1);
      assert.strictEqual(transferBlocks[0].txs.length, 4);

      // Bob detects the TRANSFER even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);

      // Bob's wallet has not indexed the TRANSFER
      const bobTransfer = await bob.getTX(aliceTransfer.hash());
      assert.strictEqual(bobTransfer, null);
    });

    it('should process REVOKE', async () => {
      // Alice revokes the name
      await sendTXs();
      const aliceRevoke = await alice.createRevoke(NAME);
      await node.mempool.addTX(aliceRevoke.toTX());
      const revokeBlocks = await mineBlocks(1);
      assert.strictEqual(revokeBlocks[0].txs.length, 4);

      // Bob detects the REVOKE even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.revoked, node.chain.height);

      // Bob's wallet has not indexed the REVOKE
      const bobTransfer = await bob.getTX(aliceRevoke.hash());
      assert.strictEqual(bobTransfer, null);
    });

    it('should fully rescan', async () => {
      // Complete chain rescan
      await wdb.rescan(0);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.revoked, node.chain.height);
    });
  });

  describe('Bids, loses, shallow rescan', function() {
    const NAME = rules.grindName(GNAME_SIZE, 4, network);
    let aliceFinalizeHash;
    let bidBlockHash;

    before(beforeAll);
    after(afterAll);

    it('should fund wallets', async () => {
      const blocks = 10;
      await mineBlocks(blocks, aliceAddr);
      await mineBlocks(blocks, bobAddr);

      const bobBal  = await bob.getBalance();
      assert.strictEqual(bobBal.confirmed, blocks * 2000 * 1e6);
      assert.strictEqual(alice.balance, blocks * 2000 * 1e6);
    });

    it('should run auction', async () => {
      // Alice opens
      await sendTXs();
      const aliceOpen = await alice.createOpen(NAME);
      await node.mempool.addTX(aliceOpen.toTX());
      const openBlocks = await mineBlocks(1);
      // Coinbase plus open
      assert.strictEqual(openBlocks[0].txs.length, 4);

      // Advance to bidding phase
      await mineBlocks(treeInterval);
      await forValue(alice, 'height', node.chain.height);

      // Poor Bob, all he does is send one (losing) bid but his wallet will
      // watch all the other activity including TRANSFERS for this name
      await bob.sendBid(NAME, 10000, 10000);

      // Alice sends winning bid
      await sendTXs();
      const aliceBid = await alice.createBid(NAME, 20000, 20000);
      await node.mempool.addTX(aliceBid.toTX());
      const bidBlocks = await mineBlocks(1);
      assert.strictEqual(bidBlocks[0].txs.length, 5);

      bidBlockHash = bidBlocks[0].hash();

      // Advance to reveal phase
      await mineBlocks(biddingPeriod);
      await bob.sendReveal(NAME);
      await sendTXs();
      const aliceReveal = await alice.createReveal(NAME);
      await node.mempool.addTX(aliceReveal.toTX());
      const revealBlocks = await mineBlocks(1);
      assert.strictEqual(revealBlocks[0].txs.length, 5);

      // Close auction
      await mineBlocks(revealPeriod);

      // Alice registers
      await sendTXs();
      const aliceRegister = await alice.createRegister(
        NAME,
        Resource.fromJSON({records:[]})
      );
      await node.mempool.addTX(aliceRegister.toTX());

      const registerBlocks = await mineBlocks(1);
      assert.strictEqual(registerBlocks[0].txs.length, 4);
    });

    it('should get namestate', async () => {
      const ns = await bob.getNameStateByName(NAME);
      // Bob has the namestate
      assert(ns);

      // Bob is not the name owner
      const {hash, index} = ns.owner;
      const coin = await bob.getCoin(hash, index);
      assert.strictEqual(coin, null);

      // Name is not in mid-TRANSFER
      assert.strictEqual(ns.transfer, 0);
    });

    it('should process TRANSFER', async () => {
      // Alice transfers the name to her own address
      await sendTXs();
      const aliceTransfer = await alice.createTransfer(NAME, aliceAddr);
      await node.mempool.addTX(aliceTransfer.toTX());
      const transferBlocks = await mineBlocks(1);
      assert.strictEqual(transferBlocks[0].txs.length, 4);

      // Bob detects the TRANSFER even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);

      // Bob's wallet has indexed the TRANSFER
      const bobTransfer = await bob.getTX(aliceTransfer.hash());
      assert.strictEqual(bobTransfer, null);
    });

    it('should fully rescan', async () => {
      await wdb.rescan(0);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);
    });

    it('should rescan since, but not including, the BIDs', async () => {
      const bidBlock = await node.chain.getEntry(bidBlockHash);
      await wdb.rescan(bidBlock.height);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);
    });

    it('should process FINALIZE', async () => {
      await mineBlocks(transferLockup);

      // Alice finalizes the name
      await sendTXs();
      const aliceFinalize = await alice.createFinalize(NAME);
      await node.mempool.addTX(aliceFinalize.toTX());
      const finalizeBlocks = await mineBlocks(1);
      assert.strictEqual(finalizeBlocks[0].txs.length, 4);

      aliceFinalizeHash = aliceFinalize.hash();

      // Bob detects the FINALIZE even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.bufferEqual(ns.owner.hash, aliceFinalizeHash);

      // Bob's wallet has not indexed the FINALIZE
      const bobFinalize = await bob.getTX(aliceFinalize.hash());
      assert.strictEqual(bobFinalize, null);
    });

    it('should fully rescan', async () => {
      await wdb.rescan(0);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.bufferEqual(ns.owner.hash, aliceFinalizeHash);
    });

    it('should rescan since, but not including, the BIDs', async () => {
      const bidBlock = await node.chain.getEntry(bidBlockHash);
      await wdb.rescan(bidBlock.height);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.bufferEqual(ns.owner.hash, aliceFinalizeHash);
    });

    it('should process TRANSFER (again)', async () => {
      // Alice transfers the name to her own address
      await sendTXs();
      const aliceTransfer = await alice.createTransfer(NAME, aliceAddr);
      await node.mempool.addTX(aliceTransfer.toTX());
      const transferBlocks = await mineBlocks(1);
      assert.strictEqual(transferBlocks[0].txs.length, 4);

      // Bob detects the TRANSFER even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);

      // Bob's wallet has not indexed the TRANSFER
      const bobTransfer = await bob.getTX(aliceTransfer.hash());
      assert.strictEqual(bobTransfer, null);
    });

    it('should process REVOKE', async () => {
      // Alice revokes the name
      await sendTXs();
      const aliceRevoke = await alice.createRevoke(NAME);
      await node.mempool.addTX(aliceRevoke.toTX());
      const revokeBlocks = await mineBlocks(1);
      assert.strictEqual(revokeBlocks[0].txs.length, 4);

      // Bob detects the REVOKE even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.revoked, node.chain.height);

      // Bob's wallet has not indexed the REVOKE
      const bobTransfer = await bob.getTX(aliceRevoke.hash());
      assert.strictEqual(bobTransfer, null);
    });

    it('should fully rescan', async () => {
      await wdb.rescan(0);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.revoked, node.chain.height);
    });

    it('should rescan since, but not including, the BIDs', async () => {
      const bidBlock = await node.chain.getEntry(bidBlockHash);
      await wdb.rescan(bidBlock.height);
      await forValue(wdb, 'height', node.chain.height);

      // No change
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.revoked, node.chain.height);
    });
  });

  describe('Restore from seed', function() {
    let wallet1, wallet2, wallet3;
    let addr1;
    let heightBeforeReveal;

    const name = rules.grindName(4, 4, network);

    before(beforeAll);
    after(afterAll);

    it('should create and fund wallet 1', async () => {
      wallet1 = await wdb.create();
      addr1 = (await wallet1.receiveAddress()).toString(network);
      await node.rpc.generateToAddress([10, addr1]);
    });

    it('should open and bid from wallet 1', async () => {
      await wallet1.sendOpen(name);
      await node.rpc.generateToAddress([treeInterval + 1, addr1]);
      await wallet1.sendBid(name, 1e6, 1e6);
      await node.rpc.generateToAddress([1, addr1]);
    });

    it('should restore wallet 1 from seed into wallet 2', async () => {
      const {mnemonic} = wallet1.master;
      wallet2 = await wdb.create({mnemonic});

      assert.strictEqual(
        wallet1.master.key.xprivkey,
        wallet2.master.key.xprivkey
      );

      // Sanity check
      const bal1 = await wallet1.getBalance();
      assert(bal1.unconfirmed > 0);
      assert(bal1.tx > 0);
      assert((await wallet1.getBids()).length);

      // Wallet 2 has no history
      const bal2 = await wallet2.getBalance();
      assert.strictEqual(bal2.unconfirmed, 0);
      assert.strictEqual(bal2.tx, 0);
      assert(!(await wallet2.getBids()).length);
    });

    it('should rescan wallet 2', async () => {
      await wdb.rescan(0);
      const bal2 = await wallet2.getBalance();
      assert(bal2.unconfirmed > 0);
      assert(bal2.tx > 0);
      assert((await wallet2.getBids()).length);
    });

    it('should bid from wallet 2', async () => {
      await wallet2.sendBid(name, 2e6, 2e6);
      await node.rpc.generateToAddress([1, addr1]);
    });

    it('should not have all blinds in either wallet', async () => {
      const bids1 = await wallet1.getBids();
      assert.strictEqual(bids1.length, 2);
      for (const bid of bids1) {
        if (bid.lockup === 1e6)
          assert(bid.value === 1e6);
        else
          assert(bid.value === -1); // unknown
      }

      const bids2 = await wallet2.getBids();
      assert.strictEqual(bids2.length, 2);
      for (const bid of bids2) {
        if (bid.lockup === 2e6)
          assert(bid.value === 2e6);
        else
          assert(bid.value === -1); // unknown
      }
    });

    it('should reveal from each wallet', async () => {
      await node.rpc.generateToAddress([biddingPeriod, addr1]);

      heightBeforeReveal = node.chain.height;

      // Wallet 1 only knows blind for one of the bids
      const tx1 = await wallet1.sendReveal(name);
      assert.strictEqual(tx1.outputs.length, 2);
      assert.strictEqual(tx1.outputs[0].value, 1e6);
      assert.strictEqual(tx1.outputs[0].covenant.type, rules.types.REVEAL);
      assert.strictEqual(tx1.outputs[1].covenant.type, rules.types.NONE);

      // Confirm
      await node.rpc.generateToAddress([1, addr1]);

      // Wallet 1 knows there's another bid but can't reveal it.
      assert.strictEqual(
        (await wallet1.getBids()).length,
        2
      );
      await assert.rejects(
        wallet1.sendReveal(name),
        {message: `No bids to reveal for name: ${name}.`}
      );

      // Wallet 2 can reveal the second bid
      const tx2 = await wallet2.sendReveal(name);
      assert.strictEqual(tx2.outputs.length, 2);
      assert.strictEqual(tx2.outputs[0].value, 2e6);
      assert.strictEqual(tx2.outputs[0].covenant.type, rules.types.REVEAL);

      // Confirm
      await node.rpc.generateToAddress([1, addr1]);
    });

    it('should have all reveals in both wallets', async () => {
      const reveals1 = await wallet1.getReveals();
      const reveals2 = await wallet2.getReveals();

      assert.strictEqual(reveals1.length, 2);
      assert.strictEqual(reveals2.length, 2);

      for (const reveal of reveals1.concat(reveals2)) {
        assert(reveal.own);
        assert(reveal.value);
      }
    });

    it('should restore wallet 1 from seed into wallet 3', async () => {
      const {mnemonic} = wallet1.master;
      wallet3 = await wdb.create({mnemonic});
    });

    it('should just rescan reveal phase', async () => {
      await wdb.rescan(heightBeforeReveal);

      let bal1 = await wallet1.getBalance();
      let bal3 = await wallet3.getBalance();

      assert.notDeepStrictEqual(bal1, bal3);

      // Complete rescan cleans everything up
      await wdb.rescan(0);

      bal1 = await wallet1.getBalance();
      bal3 = await wallet3.getBalance();

      assert.deepStrictEqual(bal1, bal3);
    });
  });
});
