'use strict';

const assert = require('bsert');
const BlockStore = require('../lib/blockstore/level');
const Chain = require('../lib/blockchain/chain');
const {states} = require('../lib/covenants/namestate');
const consensus = require('../lib/protocol/consensus');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const WalletDB = require('../lib/wallet/walletdb');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const Covenant = require('../lib/primitives/covenant');
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

    it('should fail if no actions are provided', async () => {
      await assert.rejects(
        wallet.sendBatch([]),
        {message: 'Batches require at least one action.'}
      );
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

    it('should fail if one action is invalid: REVEAL before bid', async () => {
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

    it('should fail if one action is invalid: REVEAL all before bid', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['REVEAL']
          ]
        ),
        {message: 'Nothing to do.'}
      );
    });

    it('should fail if one action is invalid: REDEEM all before bid', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['REDEEM']
          ]
        ),
        {message: 'Nothing to do.'}
      );
    });

    it('should fail if one action is invalid: NONE below dust', async () => {
      const addr = Address.fromProgram(0, Buffer.alloc(20, 0x01)).toString('regtest');
      await assert.rejects(
        wallet.sendBatch(
          [
            ['OPEN', name1],
            ['OPEN', name1],
            ['OPEN', name3],
            ['NONE', addr, 1]
          ]
        ),
         {message: 'Output is dust.'}
       );
    });

    it('should fail if one action is invalid: unknown action', async () => {
      await assert.rejects(
        wallet.sendBatch(
          [
            ['OPEN', name1],
            ['OPEN', name1],
            ['OPEN', name3],
            ['open', name4]
          ]
        ),
         {message: 'Unknown action type: open'}
       );
    });

    describe('Complete auction and diverse-action batches', function() {
      const addr = Address.fromProgram(0, Buffer.alloc(20, 0x01)).toString('regtest');
      it('3 OPENs and 1 NONE', async () => {
        const tx = await wallet.sendBatch(
          [
            ['OPEN', name1],
            ['OPEN', name2],
            ['OPEN', name3],
            ['NONE', addr, 10000]
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

      it('REVEAL all', async () => {
        // Don't send this one
        const revealAll = await wallet.createBatch(
          [
            ['REVEAL']
          ]
        );

        assert.strictEqual(revealAll.outputs.length, 5);
        let reveals = 0;
        for (const output of revealAll.outputs) {
          if (output.covenant.type === rules.types.REVEAL)
            reveals++;
        }
        assert.strictEqual(reveals, 4);
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

      it('REDEEM all', async () => {
        // Don't send this one
        const redeemAll = await wallet.createBatch(
          [
            ['REDEEM']
          ]
        );

        assert.strictEqual(redeemAll.outputs.length, 2);
        let redeems = 0;
        for (const output of redeemAll.outputs) {
          if (output.covenant.type === rules.types.REDEEM)
            redeems++;
        }
        assert.strictEqual(redeems, 1);
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

      it('10 NONE with options', async () => {
        const oldBal = await wallet.getBalance();

        const actions = [];
        for (let i = 0; i < 10; i++) {
          const addr = Address.fromProgram(0, Buffer.alloc(20, i + 1));
          actions.push(['NONE', addr, 10000]);
        }

        const batch = await wallet.sendBatch(actions, {hardFee: 1000});

        assert.strictEqual(batch.outputs.length, 11);

        // Mine to some other wallet so reward doesn't affect our balance
        receive = new Address();
        await mineBlocks(1);

        const newBal = await wallet.getBalance();

        assert.strictEqual(oldBal.confirmed - newBal.confirmed, 101000);
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

      it('2 RENEW', async () => {
        await wallet.sendBatch(
          [
            ['RENEW', name2],
            ['RENEW', name4]
          ]
        );

        await mineBlocks(1);
        const ns1 = await chain.db.getNameStateByName(name1);
        const ns2 = await chain.db.getNameStateByName(name2);
        const ns3 = await chain.db.getNameStateByName(name3);
        const ns4 = await chain.db.getNameStateByName(name4);
        assert.strictEqual(ns2.renewal, chain.height);
        assert.strictEqual(ns4.renewal, chain.height);
        // sanity check
        assert.notStrictEqual(ns1.renewal, chain.height);
        assert.notStrictEqual(ns3.renewal, chain.height);
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

    describe('Policy Weight Limits', function () {
      this.timeout(30000);
      let name;

      it('should reset wallet', async () => {
        const newWallet = await wdb.create();
        const address = await newWallet.receiveAddress();
        const bal = await wallet.getBalance();
        const value = Math.floor(bal.confirmed / 5);
        await wallet.send({
          outputs: [
            {address, value},
            {address, value},
            {address, value},
            {address, value}
          ]
        });
        await mineBlocks(1);
        wallet = newWallet;
      });

      it('should OPEN', async () => {
        name = rules.grindName(4, chain.height, network);
        await wallet.sendBatch([['OPEN', name]]);
        await mineBlocks(treeInterval + 1);
      });

      it('should not batch too many BIDs', async () => {
        const batch = [];
        for (let i = 201; i > 0; i--)
          batch.push(['BID', name, i * 1000, i * 1000]);

        await assert.rejects(
          wallet.sendBatch(batch),
          {message: 'Batch output addresses would exceed lookahead.'}
        );
      });

      it('should batch BIDs', async () => {
        let batch = [];
        for (let i = 200; i > 0; i--)
          batch.push(['BID', name, i * 1000, i * 1000]);
        await wallet.sendBatch(batch);
        batch = [];
        for (let i = 200; i > 0; i--)
          batch.push(['BID', name, i * 1001, i * 1001]);
        await wallet.sendBatch(batch);
        batch = [];
        for (let i = 200; i > 0; i--)
          batch.push(['BID', name, i * 1002, i * 1002]);
        await wallet.sendBatch(batch);
        batch = [];
        for (let i = 150; i > 0; i--)
          batch.push(['BID', name, i * 1003, i * 1003]);
        await wallet.sendBatch(batch);

        await mineBlocks(biddingPeriod);
      });

      it('should have too many REVEALs for legacy sendRevealAll', async () => {
        await assert.rejects(
          wallet.sendRevealAll(),
          {message: 'TX exceeds policy weight.'}
        );
      });

      it('should create batch just under weight limit', async () => {
        // Start with the batch we would normally make
        const mtx = await wallet.createBatch([['REVEAL']]);

        // Find a spendable coin
        const coins = await wallet.getCoins();
        let coin;
        for (coin of coins)
          if (coin.value > 10000)
            break;

        // Add the coin as new input
        mtx.addCoin(coin).getSize();

        // Add a phony REVEAL output
        mtx.addOutput(new Output({
          value: coin.value,
          address: Address.fromProgram(0, Buffer.alloc(20, 0x01)),
          covenant: new Covenant({
            type: 4,  // REVEAL
            items: [
              Buffer.alloc(32), // namehash
              Buffer.alloc(4),  // height
              Buffer.alloc(32)  // nonce
            ]
          })
        }));

        // Finish
        await wallet.sign(mtx);

        // Yes, adding one more REVEAL to this batch breaks the limit
        await assert.rejects(
          wallet.sendMTX(mtx),
          {message: 'TX exceeds policy weight.'}
        );
      });

      it('should REVEAL all in several batches', async () => {
        let reveals = 0;
        const mtx1 = await wallet.createBatch([['REVEAL']]);
        assert(mtx1.changeIndex >= 0);
        reveals += mtx1.outputs.length - 1;
        await wdb.addTX(mtx1.toTX());

        const mtx2 = await wallet.createBatch([['REVEAL']]);
        assert(mtx2.changeIndex >= 0);
        reveals += mtx2.outputs.length - 1;
        await wdb.addTX(mtx2.toTX());

        assert.strictEqual(reveals, 750);

        await wallet.sendMTX(mtx1);
        await wallet.sendMTX(mtx2);
        await mineBlocks(revealPeriod);
      });

      it('should have too many REDEEMs for legacy sendRedeemAll', async () => {
        await assert.rejects(
          wallet.sendRedeemAll(),
          {message: 'TX exceeds policy weight.'}
        );
      });

      it('should REDEEM all in several batches', async () => {
        let reveals = 0;
        const mtx1 = await wallet.createBatch([['REDEEM']]);
        assert(mtx1.changeIndex >= 0);
        reveals += mtx1.outputs.length - 1;
        await wdb.addTX(mtx1.toTX());

        const mtx2 = await wallet.createBatch([['REDEEM']]);
        assert(mtx2.changeIndex >= 0);
        reveals += mtx2.outputs.length - 1;
        await wdb.addTX(mtx2.toTX());

        // One of the REVEALs was a winner!
        assert.strictEqual(reveals, 749);

        await wallet.sendMTX(mtx1);
        await wallet.sendMTX(mtx2);
        await mineBlocks(1);
      });
    });

    describe('Consensus Limits', function () {
      this.timeout(30000);

      const names = [];
      let startHeight;

      const oldRenewalWindow = network.names.renewalWindow;
      before(() => {
        network.names.renewalWindow = 160;

        for (let i = 0; i < 800; i++)
          names.push(`name_${i}`);
      });

      after(() => {
        network.names.renewalWindow = oldRenewalWindow;
      });

      it('should not batch too many OPENs', async () => {
        const batch = [];
        for (let i = 0; i < consensus.MAX_BLOCK_OPENS + 1; i++)
          batch.push(['OPEN', names[i]]);

        await assert.rejects(
          wallet.createBatch(batch),
          {message: 'Too many OPENs.'} // Might exceed wallet lookahead also
        );
      });

      it('should send batches of OPENs in sequential blocks', async () => {
        let count = 0;
        for (let i = 1; i <= 8; i++) {
          const batch = [];
          for (let j = 1; j <= 100; j++) {
            batch.push(['OPEN', names[count++]]);
          }
          await wallet.sendBatch(batch);
          await mineBlocks(1);
        }
      });

      it('should send batches of BIDs in sequential blocks', async () => {
        // Send winning and losing bid for each name
        let count = 0;
        for (let i = 1; i <= 8; i++) {
          const batch = [];
          for (let j = 1; j <= 100; j++) {
            batch.push(
              ['BID', names[count], 10000, 10000],
              ['BID', names[count++], 10000, 10000]
            );
          }
          await wallet.sendBatch(batch);
          await mineBlocks(1);
        }
      });

      it('should send all the batches of REVEALs it needs to', async () => {
        await mineBlocks(2); // Advance all names to reveal phase

        let reveals = 0;
        for (;;) {
          try {
            const tx = await wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]);
            reveals += tx.outputs.length - 1; // Don't count change output
          } catch (e) {
            assert.strictEqual(e.message, 'Nothing to do.');
            break;
          }
        }

        assert.strictEqual(reveals, 800 * 2);
      });

      it('should send all the batches of REDEEMs it needs to', async () => {
        await mineBlocks(10); // Finish reveal phase for all names

        let redeems = 0;
        for (;;) {
          try {
            const tx = await wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]);
            redeems += tx.outputs.length - 1; // Don't count change output
          } catch (e) {
            assert.strictEqual(e.message, 'Nothing to do.');
            break;
          }
        }

        assert.strictEqual(redeems, 800); // Half the bids lost, one per name
      });

      it('should send batches of REGISTERs', async () => {
        let count = 0;
        for (let i = 1; i <= 8; i++) {
          const batch = [];
          for (let j = 1; j <= 100; j++) {
            batch.push(['UPDATE', names[count++], new Resource()]);
          }
          await wallet.sendBatch(batch);
          await mineBlocks(1);

          if (!startHeight)
            startHeight = chain.height;
        }

        // Confirm
        for (const name of names) {
          const ns = await wallet.getNameStateByName(name);
          assert(ns.registered);
        }
        // First name was registered first, should be renewed first
        const ns0 = await wallet.getNameStateByName('name_0');
        const ns799 = await wallet.getNameStateByName('name_799');
        assert(ns0.renewal < ns799.renewal);
      });

      it('should not batch too many UPDATEs', async () => {
        const batch = [];
        for (let i = 0; i < consensus.MAX_BLOCK_UPDATES + 1; i++)
          batch.push(['UPDATE', names[i], new Resource()]);

        await assert.rejects(
          wallet.createBatch(batch),
          {message: 'Too many UPDATEs.'} // Might exceed wallet lookahead also
        );
      });

      it('should not RENEW any names too early', async () => {
        await mineBlocks(
          ((network.names.renewalWindow / 8) * 7)
          - (chain.height - startHeight)
          - 1
        );

        await assert.rejects(
          wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]),
          {message: 'Nothing to do.'}
        );
      });

      it('should not batch too many RENEWs', async () => {
        const batch = [];
        for (let i = 0; i < consensus.MAX_BLOCK_RENEWALS + 1; i++)
          batch.push(['RENEW', names[i]]);

        await assert.rejects(
          wallet.createBatch(batch),
          {message: 'Too many RENEWs.'} // Might exceed wallet lookahead also
        );
      });

      it('should send all the batches of RENEWs it needs to', async () => {
        await mineBlocks(8); // All names expiring, none expired yet

        let renewals = 0;
        for (;;) {
          const tx = await wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]);
          await mineBlocks(1);

          if (!renewals) {
            // First name is "most urgent" should've been renewed first
            const ns0 = await wallet.getNameStateByName(names[0]);
            assert.strictEqual(ns0.renewal, chain.height);
          }

          renewals += tx.outputs.length - 1; // Don't count change output
          if (renewals === 800)
            break;
        }
        assert.strictEqual(renewals, 800);
      });

      it('should not batch too many TRANSFERs', async () => {
        const batch = [];
        for (const name of names)
          batch.push(['TRANSFER', name, new Address()]);

        await assert.rejects(
          wallet.createBatch(batch),
          {message: 'Too many UPDATEs.'} // Might exceed wallet lookahead also
        );
      });

      it('should send batches of TRANSFERs', async () => {
        const addr = Address.fromProgram(0, Buffer.alloc(20, 0xd0));
        let count = 0;
        for (let i = 1; i <= 8; i++) {
          const batch = [];
          for (let j = 1; j <= 100; j++) {
            batch.push(['TRANSFER', names[count++], addr]);
          }
          await wallet.sendBatch(batch);
          await mineBlocks(1);
        }
      });

      it('should not FINALIZE any names too early', async () => {
        await mineBlocks(network.names.lockupPeriod - 9);

        await assert.rejects(
          wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]),
          {message: 'Nothing to do.'}
        );
      });

      it('should send all the batches of FINALIZEs it needs to', async () => {
        await mineBlocks(8); // All names ready for finalize

        let finalizes = 0;
        for (;;) {
          const tx = await wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]);
          await mineBlocks(1);

          finalizes += tx.outputs.length - 1; // Don't count change output
          if (finalizes === 800)
            break;
        }
        assert.strictEqual(finalizes, 800);
      });

      it('should have nothing to do', async () => {
        await assert.rejects(
          wallet.sendBatch([['REVEAL'], ['REDEEM'], ['RENEW'], ['FINALIZE']]),
          {message: 'Nothing to do.'}
        );
      });
    });
  });
});
