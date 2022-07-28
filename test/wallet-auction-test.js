'use strict';

const assert = require('bsert');
const BlockStore = require('../lib/blockstore/level');
const Chain = require('../lib/blockchain/chain');
const {states} = require('../lib/covenants/namestate');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const WalletDB = require('../lib/wallet/walletdb');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const Address = require('../lib/primitives/address');
const {Resource} = require('../lib/dns/resource');

const network = Network.get('regtest');
const NAME1 = rules.grindName(10, 2, network);
const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup,
  auctionMaturity,
  renewalWindow
} = network.names;

const workers = new WorkerPool({
  enabled: false,
  size: 2
});

const blocks = new BlockStore({
  memory: true,
  network
});

const chain = new Chain({
  memory: true,
  blocks,
  network,
  workers
});

const miner = new Miner({
  chain,
  workers
});

const cpu = miner.cpu;

const wdb = new WalletDB({
  network: network,
  workers: workers
});

describe('Wallet Auction', function() {
  let winner, openAuctionMTX, openAuctionMTX2;

  before(async () => {
    // Open
    await blocks.open();
    await chain.open();
    await miner.open();
    await wdb.open();

    // Set up wallet
    winner = await wdb.create();
    chain.on('connect', async (entry, block) => {
      await wdb.addBlock(entry, block.txs);
    });

    // Generate blocks to roll out name and fund wallet
    let winnerAddr = await winner.createReceive();
    winnerAddr = winnerAddr.getAddress().toString(network);
    for (let i = 0; i < 4; i++) {
      const block = await cpu.mineBlock(null, winnerAddr);
      await chain.add(block);
    }
  });

  after(async () => {
    await wdb.close();
    await miner.close();
    await chain.close();
    await blocks.close();
  });

  describe('Duplicate OPENs', function() {
    it('should open auction', async () => {
      openAuctionMTX = await winner.createOpen(NAME1, false);
      await winner.sign(openAuctionMTX);
      const tx = openAuctionMTX.toTX();
      await wdb.addTX(tx);
    });

    it('should fail to create duplicate open', async () => {
      let err;
      try {
        await winner.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Already sent an open for: ${NAME1}.`);
    });

    it('should mine 1 block', async () => {
      const job = await cpu.createJob();
      job.addTX(openAuctionMTX.toTX(), openAuctionMTX.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should fail to re-open auction during OPEN phase', async () => {
      let err;
      try {
        await winner.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Name is already opening: ${NAME1}.`);
    });

    it('should mine enough blocks to enter BIDDING phase', async () => {
      for (let i = 0; i < treeInterval; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should fail to send bid to null address', async () => {
      const mtx = await winner.makeBid(NAME1, 1000, 2000, 0);
      mtx.outputs[0].address = new Address();
      await winner.fill(mtx);
      await winner.finalize(mtx);

      const fn = async () => await winner.sendMTX(mtx);

      await assert.rejects(fn, {message: 'Cannot send to null address.'});
    });

    it('should fail to re-open auction during BIDDING phase', async () => {
      let err;
      try {
        await winner.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Name is not available: ${NAME1}.`);
    });

    it('should mine enough blocks to expire auction', async () => {
      for (let i = 0; i < biddingPeriod + revealPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open auction (again)', async () => {
      openAuctionMTX2 = await winner.createOpen(NAME1, false);
      await winner.sign(openAuctionMTX2);
      const tx = openAuctionMTX2.toTX();
      await wdb.addTX(tx);
    });

    it('should fail to create duplicate open (again)', async () => {
      let err;
      try {
        await winner.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Already sent an open for: ${NAME1}.`);
    });

    it('should confirm OPEN transaction', async () => {
      const job = await cpu.createJob();
      job.addTX(openAuctionMTX2.toTX(), openAuctionMTX2.view);
      job.refresh();

      const block = await job.mineAsync();
      assert(await chain.add(block));

      let ns = await chain.db.getNameStateByName(NAME1);
      let state = ns.state(chain.height, network);
      assert.strictEqual(state, states.OPENING);

      for (let i = 0; i < treeInterval + 1; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      ns = await chain.db.getNameStateByName(NAME1);
      state = ns.state(chain.height, network);
      assert.strictEqual(state, states.BIDDING);
    });
  });

  describe('Batch TXs', function() {
    let wallet, receive;
    const hardFee = 12345;

    const name1 = rules.grindName(3, 0, network);
    const name2 = rules.grindName(4, 0, network);
    const name3 = rules.grindName(5, 0, network);
    const name4 = rules.grindName(6, 0, network);

    const res1 = Resource.fromJSON({records: [{type: 'TXT', txt: ['one']}]});
    const res2 = Resource.fromJSON({records: [{type: 'TXT', txt: ['two']}]});
    const res3 = Resource.fromJSON({records: [{type: 'TXT', txt: ['three']}]});
    const res4 = Resource.fromJSON({records: [{type: 'TXT', txt: ['four']}]});

    const mempool = [];
    wdb.send = (tx) => {
      mempool.push(tx);
    };
    wdb.getNameStatus = async (nameHash) => {
      return chain.db.getNameStatus(nameHash, chain.height + 1);
    };

    async function mineBlocks(n) {
      for (let i = 0; i < n; i++) {
        const job = await cpu.createJob(chain.tip, receive);
        while (mempool.length)
          job.pushTX(mempool.pop());
        job.refresh();

        const block = await job.mineAsync();
        const entry = await chain.add(block);
        await wdb.addBlock(entry, block.txs);
      }
    }

    function uniqueAddrs(tx) {
      // All unique addresses
      for (let i = 0; i < tx.outputs.length; i++) {
        const addr = tx.outputs[i].address.toString();
        for (let j = i + 1; j < tx.outputs.length; j++)
          assert.notStrictEqual(tx.outputs[j].address.toString(), addr);
      }
      return true;
    }

    before(async () => {
      // Create wallet
      wallet = await wdb.create();
      receive = await wallet.receiveAddress();

      // Fund wallet
      await mineBlocks(20);

      // Verify funds
      const bal = await wallet.getBalance();
      assert.strictEqual(bal.confirmed, 20 * 2000e6);
    });

    it('should create multiple OPENs with options', async () => {
      const mtx = await wallet.createBatch(
        [
          ['OPEN', name1],
          ['OPEN', name2],
          ['OPEN', name3]
        ],
        {
          hardFee
        }
      );

      assert(uniqueAddrs(mtx));

      assert.strictEqual(mtx.outputs.length, 4);
      let opens = 0;
      for (const output of mtx.outputs) {
        if (output.covenant.type === rules.types.OPEN)
          opens++;
      }
      assert.strictEqual(opens, 3);
      assert.strictEqual(mtx.getFee(mtx.view), hardFee);
    });

    it('should fail if one action is invalid: OPEN reserved', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['OPEN', 'google'],
            ['OPEN', name2],
            ['OPEN', name3]
          ]
        ),
        {message: 'Name is reserved: google.'}
      );
    });

    it('should fail if one action is invalid: OPEN duplicated', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['OPEN', name1],
            ['OPEN', name1],
            ['OPEN', name3]
          ]
        ),
         {message: 'Duplicate name with exclusive action.'}
       );
    });

    it('should fail if one action is invalid: BID early', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['BID', name1, 1, 1],
            ['OPEN', name2],
            ['OPEN', name3]
          ]
        ),
        {message: `Name has not reached the bidding phase yet: ${name1}.`}
      );
    });

    it('should fail if one action is invalid: wrong arguments', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['BID', name1, 21000000],
            ['OPEN', name2],
            ['OPEN', name3]
          ]
        ),
        {message: 'Bad arguments for BID.'}
      );
    });

    it('should fail if one action is invalid: REVEAL before bid', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['REVEAL', name1],
            ['OPEN', name2],
            ['OPEN', name3]
          ]
        ),
        {message: `Auction not found: ${name1}.`}
      );
    });

    describe('Complete auction and diverse-action batches', function() {
      it('3 OPENs', async () => {
        const tx = await wallet.sendBatch(
          [
            ['OPEN', name1],
            ['OPEN', name2],
            ['OPEN', name3]
          ]
        );

        assert(uniqueAddrs(tx));
        await mineBlocks(treeInterval + 1);
      });

      it('4 BIDs', async () => {
        const tx = await wallet.sendBatch(
          [
            ['BID', name1, 10000, 20000],
            ['BID', name1, 10001, 20000], // self-snipe!
            ['BID', name2, 30000, 40000],
            ['BID', name3, 50000, 60000]
          ]
        );

        assert(uniqueAddrs(tx));
        await mineBlocks(biddingPeriod);
      });

      it('2 REVEALs then 1 REVEAL', async () => {
        const tx = await wallet.sendBatch(
          [
            ['REVEAL', name1],
            ['REVEAL', name2]
          ]
        );

        assert(uniqueAddrs(tx));

        // No "could not resolve preferred inputs" error
        // because names are being revealed individually.
        await wallet.sendBatch(
          [
            ['REVEAL', name3]
          ]
        );
        await mineBlocks(revealPeriod);
      });

      it('3 REGISTERs, 1 REDEEM and 1 OPEN', async () => {
        // Complete all 4 bids win and/or lose in one TX
        const batch1 = await wallet.sendBatch(
          [
            ['OPEN', name4],
            ['REDEEM', name1],
            ['UPDATE', name1, res1],
            ['UPDATE', name2, res2],
            ['UPDATE', name3, res3]
          ]
        );

        assert(uniqueAddrs(batch1));

        // Unlinked covenant (OPEN) was listed first but
        // should be sorted last with the change output (NONE).
        assert(!batch1.outputs[4].covenant.isLinked());
        assert(!batch1.outputs[5].covenant.isLinked());
        await mineBlocks(treeInterval + 1);
      });

      it('3 TRANSFERs and 1 BID', async () => {
        // Transfer out of wallet
        const nullAddr = new Address({
          version: 31,
          hash: Buffer.from([1, 2, 3])
        });
        const tx = await wallet.sendBatch(
          [
            ['TRANSFER', name1, nullAddr],
            ['TRANSFER', name2, nullAddr],
            ['TRANSFER', name3, nullAddr],
            ['BID', name4, 70000, 80000]
          ]
        );

        assert(uniqueAddrs(tx));

        // True for regtest but not mainnet,
        // should allow both REVEAL and FINALIZE
        assert(transferLockup > biddingPeriod);
        assert(transferLockup < (biddingPeriod + revealPeriod));
        await mineBlocks(transferLockup);
      });

      it('1 FINALIZE, 1 CANCEL, 1 REVOKE and 1 REVEAL', async () => {
        const tx = await wallet.sendBatch(
          [
            ['FINALIZE', name1],
            ['CANCEL', name2],
            ['REVOKE', name3],
            ['REVEAL', name4]
          ]
        );

        assert(uniqueAddrs(tx));

        // Should allow for both REGISTER and re-open revoked name
        assert(auctionMaturity > revealPeriod);
        assert(auctionMaturity < renewalWindow);
        await mineBlocks(auctionMaturity);
      });

      it('1 revoked name re-OPEN and 1 REGISTER', async () => {
        const batch2 = await wallet.sendBatch(
          [
            ['OPEN', name3], // and the cycle begins again...
            ['UPDATE', name4, res4]
          ]
        );

        assert(uniqueAddrs(batch2));

        // Linked covenant (UPDATE) was listed last but should be sorted first.
        assert.strictEqual(batch2.outputs[0].covenant.type, rules.types.REGISTER);
        await mineBlocks(treeInterval);
      });

      it('should verify expected name properties', async () => {
        const ns1 = await chain.db.getNameStateByName(name1);
        const ns2 = await chain.db.getNameStateByName(name2);
        const ns3 = await chain.db.getNameStateByName(name3);
        const ns4 = await chain.db.getNameStateByName(name4);

        assert.bufferEqual(ns1.data, res1.encode());
        assert.bufferEqual(ns2.data, res2.encode());
        assert.bufferEqual(ns3.data, Buffer.from([])); // revoked name data is cleared
        assert.bufferEqual(ns4.data, res4.encode());

        const coin1 = await wallet.getCoin(ns1.owner.hash, ns1.owner.index);
        assert(!coin1); // name was transferred out of wallet

        const coin2 = await wallet.getCoin(ns2.owner.hash, ns2.owner.index);
        assert(coin2); // cancelled transfer is still in wallet

        const coin3 = await wallet.getCoin(ns3.owner.hash, ns3.owner.index);
        assert(!coin3); // revoked name no longer in wallet

        const coin4 = await wallet.getCoin(ns4.owner.hash, ns4.owner.index);
        assert(coin4); // name was won and registered

        assert(ns1.isClosed(chain.height, network));
        assert(ns2.isClosed(chain.height, network));
        assert(ns3.isOpening(chain.height, network));
        assert(ns4.isClosed(chain.height, network));
      });

      it('should not have receive address gaps', async () => {
        const acct = await wallet.getAccount(0);
        const {receiveDepth} = acct;
        const addrIndexes = Array(receiveDepth - 1).fill(0);

        const txs = await wallet.getHistory();
        const wtxs = await wallet.toDetails(txs);
        for (const wtx of wtxs) {
          for (const output of wtx.outputs)
            if (   output.path
                && output.path.account === 0
                && output.path.branch === 0  // receive
            ) {
              addrIndexes[output.path.index]++;
            }
        }
        // Ensure every receive address was used at least once
        assert(addrIndexes.indexOf(0) === -1);
      });
    });
  });
});
