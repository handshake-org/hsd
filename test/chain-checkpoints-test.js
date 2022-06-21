'use strict';

const assert = require('bsert');
const fs = require('fs');
const {resolve} = require('path');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const ownership = require('../lib/covenants/ownership');
const Address = require('../lib/primitives/address');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const {Resource} = require('../lib/dns/resource');
const AirdropProof = require('../lib/primitives/airdropproof');

const network = Network.get('regtest');

const AIRDROP_PROOF_FILE = resolve(__dirname, 'data', 'airdrop-proof.base64');
const FAUCET_PROOF_FILE = resolve(__dirname, 'data', 'faucet-proof.base64');
const read = file => Buffer.from(fs.readFileSync(file, 'binary'), 'base64');
const rawProof = read(AIRDROP_PROOF_FILE);
const rawFaucetProof = read(FAUCET_PROOF_FILE);

const blocks = new BlockStore({
  memory: true,
  network
});

// Used to generate a chain with auctions and transactions
const chainGenerator = new Chain({
  blocks,
  memory: true,
  network
});

const miner = new Miner({
  chain: chainGenerator
});
const cpu = miner.cpu;

const wallet = new MemWallet({
  network
});

const GNAME_SIZE = 10;

wallet.getNameStatus = async (nameHash) => {
  assert(Buffer.isBuffer(nameHash));
  const height = chainGenerator.height + 1;
  return chainGenerator.db.getNameStatus(nameHash, height);
};

chainGenerator.on('connect', (entry, block) => {
  wallet.addBlock(entry, block.txs);
});

// Keep track of what happens in each block
// so if sync fails we can figure out why.
const labels = ['genesis'];

async function mineBlock(mtxs, claims, airdrops, label) {
  const job = await cpu.createJob();

  if (mtxs) {
    for (const mtx of mtxs)
      job.pushTX(mtx.toTX());
  }

  if (claims) {
    for (const claim of claims)
      job.pushClaim(claim, network);
  }

  if (airdrops) {
    for (const airdrop of airdrops)
      job.pushAirdrop(airdrop);
  }

  job.refresh();
  const block = await job.mineAsync();
  await chainGenerator.add(block);

  labels.push(label);
  return block;
}

async function mineBlocks(n, label) {
  for (let i = 0; i < n; i++)
    await mineBlock(null, null, null, label);
}

describe('Checkpoints', function() {
  before(async () => {
    ownership.ignore = true;

    await blocks.open();
    await chainGenerator.open();
    await miner.open();
  });

  after(async () => {
    await miner.close();
    await chainGenerator.close();
    await blocks.close();

    ownership.ignore = false;
  });

  it('should add addrs to miner', async () => {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
  });

  it('should mine 200 blocks', async () => {
    await mineBlocks(200, 'generate before tests');

    assert.strictEqual(chainGenerator.height, 200);
  });

  it('should CLAIM and REGISTER a reserved name', async () => {
    const claim = await wallet.fakeClaim('cloudflare');

    await mineBlock(null, [claim], null, 'claim');
    await mineBlocks(network.names.lockupPeriod, 'after claim');

    const register = await wallet.createRegister('cloudflare');

    await mineBlock([register], null, null, 'register reserved');
  });

  it('should send coins to nulldata address', async () => {
    // Unspendable outputs are not saved to UTXO set
    const address = new Address({
      version: 31,
      hash: Buffer.alloc(20)
    });
    const value = 1234567;

    const mtx = await wallet.send({
      outputs: [{address, value}]
    });

    await mineBlock([mtx], null, null, 'nulldata');
  });

  it('should send coins to regular address', async () => {
    const address = wallet.getReceive();
    const value = 23000000;

    const mtx = await wallet.send({
      outputs: [{address, value}]
    });

    await mineBlock([mtx], null, null, 'normal address');
  });

  it('should win names in auction', async () => {
    // Only one bid, 0-value name
    const name1 = rules.grindName(GNAME_SIZE, chainGenerator.height - 5, network);
    // Two bids, name will have a value
    const name2 = rules.grindName(GNAME_SIZE, chainGenerator.height - 5, network);
    // Two bids, but wallet will not REGISTER
    const name3 = rules.grindName(GNAME_SIZE, chainGenerator.height - 5, network);

    const open1 = await wallet.sendOpen(name1);
    const open2 = await wallet.sendOpen(name2);
    const open3 = await wallet.sendOpen(name3);

    await mineBlock([open1, open2, open3], null, null, 'opens');
    await mineBlocks(network.names.treeInterval + 1, 'after opens');

    const bid1 = await wallet.sendBid(name1, 100, 200);
    const bid2 = await wallet.sendBid(name2, 100, 200);
    const bid3 = await wallet.sendBid(name2, 200, 300);
    const bid4 = await wallet.sendBid(name3, 400, 500);
    const bid5 = await wallet.sendBid(name3, 600, 700);

    await mineBlock([bid1, bid2, bid3, bid4, bid5], null, null, 'bids');
    await mineBlocks(network.names.biddingPeriod, 'after bids');

    const reveal1 = await wallet.sendReveal(name1);
    const reveal2 = await wallet.sendReveal(name2);
    const reveal3 = await wallet.sendReveal(name3);

    await mineBlock([reveal1, reveal2, reveal3], null, null, 'reveals');
    await mineBlocks(network.names.revealPeriod, 'after reveals');

    const register1 = await wallet.sendRegister(
      name1,
      Resource.fromJSON({
        records: [
          {
            type: 'TXT',
            txt: ['Not all REGISTER covenants are empty!']
          }
        ]
      })
    );
    const register2 = await wallet.sendRegister(name2);

    await mineBlock([register1, register2], null, null, 'registers');
    await mineBlocks(10, 'after registers');

    // No redeem for one-bid name1
    const redeem2 = await wallet.sendRedeem(name2);
    const redeem3 = await wallet.sendRedeem(name3);
    await mineBlock([redeem2, redeem3], null, null, 'redeems');

    const transfer1 = await wallet.sendTransfer(name1, wallet.getReceive());
    const transfer2 = await wallet.sendTransfer(name2, wallet.getReceive());
    await mineBlock([transfer1, transfer2], null, null, 'transfers');
    await mineBlocks(network.names.lockupPeriod, 'after transfers');

    const finalize1 = await wallet.sendCancel(name1);
    await mineBlock([finalize1], null, null, 'finalize');

    const revoke1 = await wallet.sendRevoke(name1);
    await mineBlock([revoke1], null, null, 'revoke');
  });

  it('should bid in multiple blocks', async () => {
    const name = rules.grindName(GNAME_SIZE, chainGenerator.height - 5, network);

    const open = await wallet.sendOpen(name);

    await mineBlock([open], null, null, 'open multi-block auction');
    await mineBlocks(network.names.treeInterval, 'after open multi');

    let bid;
    bid = await wallet.sendBid(name, 100, 200);
    await mineBlock([bid], null, null, 'bid 1 multi');
    bid = await wallet.sendBid(name, 200, 300);
    await mineBlock([bid], null, null, 'bid 2 multi');
    bid = await wallet.sendBid(name, 400, 500);
    await mineBlock([bid], null, null, 'bid 3 multi');
    bid = await wallet.sendBid(name, 600, 700);
    await mineBlock([bid], null, null, 'bid 4 multi');
    bid = await wallet.sendBid(name, 800, 900);
    await mineBlock([bid], null, null, 'bid 5 multi');

    await mineBlocks(network.names.biddingPeriod - 6, 'after bids multi');

    const reveal = await wallet.sendReveal(name);

    await mineBlock([reveal], null, null, 'reveal multi');
    await mineBlocks(network.names.revealPeriod, 'after reveals multi');

    const register = await wallet.sendRegister(name);

    await mineBlock([register], null, null, 'registers multi');
    await mineBlocks(10, 'after registers multi');
  });

  it('should confirm airdrop and faucet proofs', async () => {
    const proof = AirdropProof.decode(rawProof);
    const fproof = AirdropProof.decode(rawFaucetProof);

    await mineBlock(null, null, [proof, fproof], 'airdrops');
  });

  it('should mine 10 blocks', async () => {
    await mineBlocks(10, 'generate after tests');
  });

  describe('Sync without checkpoints', function() {
    const blocks = new BlockStore({
      memory: true,
      network
    });

    const chain = new Chain({
      blocks,
      memory: true,
      network,
      checkpoints: false
    });

    before(async () => {
      await blocks.open();
      await chain.open();
    });

    after(async () => {
      await chain.close();
      await blocks.close();
    });

    it('should sync chain', async () => {
      for (let i = 1; i <= chainGenerator.height; i++) {
        const hash = await chainGenerator.getHash(i);
        const block = await chainGenerator.getBlock(hash);
        try {
          await chain.add(block);
        } catch (e) {
          throw new Error(
            `Sync failure at height ${i} (${labels[i]}): ${e.message}`
          );
        }
      }

      assert.deepStrictEqual(
        chain.db.state.getJSON(), chainGenerator.db.state.getJSON()
      );
      assert.deepStrictEqual(chain.tip.getJSON(), chainGenerator.tip.getJSON());
      assert.bufferEqual(chain.db.field.field, chainGenerator.db.field.field);
      assert.deepStrictEqual(chain.db.field, chainGenerator.db.field);
    });
  });

  describe('Sync with checkpoints', function() {
    const blocks = new BlockStore({
      memory: true,
      network
    });

    const chain = new Chain({
      blocks,
      memory: true,
      network,
      checkpoints: true
    });

    before(async () => {
      await blocks.open();
      await chain.open();

      const CHECKPOINT = chainGenerator.tip.height - 2;
      const entry = await chainGenerator.getEntry(CHECKPOINT);
      assert(Buffer.isBuffer(entry.hash));
      assert(Number.isInteger(entry.height));

      network.checkpointMap[entry.height] = entry.hash;
      network.lastCheckpoint = entry.height;
    });

    after(async () => {
      await chain.close();
      await blocks.close();

      network.checkpointMap = {};
      network.lastCheckpoint = 0;
    });

    it('should sync chain', async () => {
      for (let i = 1; i <= chainGenerator.height; i++) {
        const hash = await chainGenerator.getHash(i);
        const block = await chainGenerator.getBlock(hash);
        try {
          await chain.add(block);
        } catch (e) {
          throw new Error(
            `Sync failure at height ${i} (${labels[i]}): ${e.message}`
          );
        }
      }

      assert.deepStrictEqual(
        chain.db.state.getJSON(), chainGenerator.db.state.getJSON()
      );
      assert.deepStrictEqual(chain.tip.getJSON(), chainGenerator.tip.getJSON());
      assert.bufferEqual(chain.db.field.field, chainGenerator.db.field.field);
      assert.deepStrictEqual(chain.db.field, chainGenerator.db.field);
    });

    describe('Bypass NameState checks for BIDs under checkpoints', function() {
      let name;
      let invalidBlockEntry;

      before(async () => {
        name = rules.grindName(GNAME_SIZE, chainGenerator.height - 5, network);
      });

      after(async () => {
        network.checkpointMap = {};
        network.lastCheckpoint = 0;
      });

      it('should OPEN new auction', async () => {
        const open = await wallet.sendOpen(name);
        const block = await mineBlock([open], null, null, 'open new auction');

        // Test chain still in sync
        await chain.add(block);
        assert.deepStrictEqual(
          chain.db.state.getJSON(), chainGenerator.db.state.getJSON()
        );
        assert.deepStrictEqual(chain.tip.getJSON(), chainGenerator.tip.getJSON());
        assert.bufferEqual(chain.db.field.field, chainGenerator.db.field.field);
        assert.deepStrictEqual(chain.db.field, chainGenerator.db.field);
      });

      it('should mine an invalid BID in last checkpoint block', async () => {
        // Name has not actually reached the bidding phase yet.
        // We will force the wallet to create an invalid BID.
        const restore = wallet.height;
        wallet.height += network.names.treeInterval + 2;
        const bid = await wallet.sendBid(name, 100, 200);
        wallet.height = restore;

        // This block is invalid!
        const job = await cpu.createJob();
        job.pushTX(bid.toTX());
        job.refresh();
        const invalidBlock = await job.mineAsync();

        // Make this block the LAST CHECKPOINT
        const height = chainGenerator.height + 1;
        network.checkpointMap[height] = invalidBlock.hash();
        network.lastCheckpoint = height;

        // This will not throw even though the block is invalid
        invalidBlockEntry = await chain.add(invalidBlock);

        // Confirm that was the last checkpoint block
        assert.strictEqual(invalidBlockEntry.height, network.lastCheckpoint);
        assert.strictEqual(chain.height, network.lastCheckpoint);
      });

      it('should detect an invalid BID after last checkpoint block', async () => {
        // Name has not actually reached the bidding phase yet.
        // We will force the wallet into creating an invalid BID.
        const restore = wallet.height;
        wallet.height += network.names.treeInterval + 2;
        const bid = await wallet.createBid(name, 300, 400);
        wallet.height = restore;

        // This block is invalid!
        const job = await cpu.createJob(invalidBlockEntry);
        job.pushTX(bid.toTX());
        job.refresh();
        const invalidBlock = await job.mineAsync();

        // Now that we are 1 block past checkpoints we will throw
        await assert.rejects(
          chain.add(invalidBlock),
          {reason: 'bad-bid-state'}
        );
      });
    });
  });
});
