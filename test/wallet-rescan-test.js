/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-implicit-coercion: "off" */

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
  revealPeriod
} = network.names;

describe('Wallet Rescan with TRANSFER', function() {
  describe('Only sends OPEN', function() {
    // Bob runs a full node with wallet plugin
    const node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [require('../lib/wallet/plugin')]
    });
    node.on('error', (err) => {
      assert(false, err);
    });

    const {wdb} = node.require('walletdb');
    let bob, bobAddr;

    // Alice is some other wallet on the network
    const alice = new MemWallet({ network });
    const aliceAddr = alice.getAddress();

    // Connect MemWallet to chain as minimally as possible
    node.chain.on('connect', (entry, block) => {
      alice.addBlock(entry, block.txs);
    });
    alice.getNameStatus = async (nameHash) => {
      assert(Buffer.isBuffer(nameHash));
      const height = node.chain.height + 1;
      const state = await node.chain.getNextState();
      const hardened = state.hasHardening();
      return node.chain.db.getNameStatus(nameHash, height, hardened);
    };

    const NAME = rules.grindName(4, 4, network);

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
    before(async () => {
      await node.open();
      bob = await wdb.create();
      bobAddr = await bob.receiveAddress();
    });

    after(async () => {
      await node.close();
    });

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
      await bob.sendOpen(NAME, true);
      const openBlocks = await mineBlocks(1);
      // Coinbase plus open
      assert.strictEqual(openBlocks[0].txs.length, 2);

      // Advance to bidding phase
      await mineBlocks(treeInterval);
      await forValue(alice, 'height', node.chain.height);

      // Alice sends only bid
      const aliceBid = await alice.createBid(NAME, 20000, 20000);
      await node.mempool.addTX(aliceBid.toTX());
      const bidBlocks = await mineBlocks(1);
      assert.strictEqual(bidBlocks[0].txs.length, 2);

      // Advance to reveal phase
      await mineBlocks(biddingPeriod);
      const aliceReveal = await alice.createReveal(NAME);
      await node.mempool.addTX(aliceReveal.toTX());
      const revealBlocks = await mineBlocks(1);
      assert.strictEqual(revealBlocks[0].txs.length, 2);

      // Close auction
      await mineBlocks(revealPeriod);

      // Alice registers
      const aliceRegister = await alice.createRegister(
        NAME,
        Resource.fromJSON({records:[]})
      );
      await node.mempool.addTX(aliceRegister.toTX());

      const registerBlocks = await mineBlocks(1);
      assert.strictEqual(registerBlocks[0].txs.length, 2);
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
      const aliceTransfer = await alice.createTransfer(NAME, aliceAddr);
      await node.mempool.addTX(aliceTransfer.toTX());
      const transferBlocks = await mineBlocks(1);
      assert.strictEqual(transferBlocks[0].txs.length, 2);

      // Bob detects the TRANSFER even though it doesn't involve him at all
      const ns = await bob.getNameStateByName(NAME);
      assert(ns);
      assert.strictEqual(ns.transfer, node.chain.height);

      // Bob's wallet has indexed the TRANSFER
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
  });

  describe('Bids, loses, shallow rescan', function() {
    // Bob runs a full node with wallet plugin
    const node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [require('../lib/wallet/plugin')]
    });
    node.on('error', (err) => {
      assert(false, err);
    });

    const {wdb} = node.require('walletdb');
    let bob, bobAddr;

    // Alice is some other wallet on the network
    const alice = new MemWallet({ network });
    const aliceAddr = alice.getAddress();

    // Connect MemWallet to chain as minimally as possible
    node.chain.on('connect', (entry, block) => {
      alice.addBlock(entry, block.txs);
    });
    alice.getNameStatus = async (nameHash) => {
      assert(Buffer.isBuffer(nameHash));
      const height = node.chain.height + 1;
      const state = await node.chain.getNextState();
      const hardened = state.hasHardening();
      return node.chain.db.getNameStatus(nameHash, height, hardened);
    };

    const NAME = rules.grindName(4, 4, network);

    // Block that confirmed the bids
    let bidBlockHash;

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

    before(async () => {
      await node.open();
      bob = await wdb.create();
      bobAddr = await bob.receiveAddress();
    });

    after(async () => {
      await node.close();
    });

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
      const aliceOpen = await alice.createOpen(NAME);
      await node.mempool.addTX(aliceOpen.toTX());
      const openBlocks = await mineBlocks(1);
      // Coinbase plus open
      assert.strictEqual(openBlocks[0].txs.length, 2);

      // Advance to bidding phase
      await mineBlocks(treeInterval);
      await forValue(alice, 'height', node.chain.height);

      // Poor Bob, all he does is send one (losing) bid but his wallet will
      // watch all the other activity including TRANSFERS for this name
      await bob.sendBid(NAME, 10000, 10000);

      // Alice sends winning bid
      const aliceBid = await alice.createBid(NAME, 20000, 20000);
      await node.mempool.addTX(aliceBid.toTX());
      const bidBlocks = await mineBlocks(1);
      assert.strictEqual(bidBlocks[0].txs.length, 3);

      bidBlockHash = bidBlocks[0].hash();

      // Advance to reveal phase
      await mineBlocks(biddingPeriod);
      await bob.sendReveal(NAME);
      const aliceReveal = await alice.createReveal(NAME);
      await node.mempool.addTX(aliceReveal.toTX());
      const revealBlocks = await mineBlocks(1);
      assert.strictEqual(revealBlocks[0].txs.length, 3);

      // Close auction
      await mineBlocks(revealPeriod);

      // Alice registers
      const aliceRegister = await alice.createRegister(
        NAME,
        Resource.fromJSON({records:[]})
      );
      await node.mempool.addTX(aliceRegister.toTX());

      const registerBlocks = await mineBlocks(1);
      assert.strictEqual(registerBlocks[0].txs.length, 2);
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
      const aliceTransfer = await alice.createTransfer(NAME, aliceAddr);
      await node.mempool.addTX(aliceTransfer.toTX());
      const transferBlocks = await mineBlocks(1);
      assert.strictEqual(transferBlocks[0].txs.length, 2);

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
  });
});
