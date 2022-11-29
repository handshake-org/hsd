'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const WalletPlugin = require('../lib/wallet/plugin');
const {Resource} = require('../lib/dns/resource');
const {types, grindName} = require('../lib/covenants/rules');
const {forEventCondition} = require('./util/common');

const network = Network.get('regtest');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

const openingPeriod = treeInterval + 2;

const GRIND_NAME_LEN = 10;
const hardFee = 1e4;

describe('Wallet Lock Balance', function() {
  let node, chain, wdb;
  // wallets
  let primary;

  const defaultAcc = 'default';
  const altAccount1 = 'alt1';

  let aliceID, alicew;
  let bobID, bobw;
  let carolID, carolw;

  const INIT_BLOCKS = treeInterval;
  const INIT_FUND = 10e6;
  const INIT_BALANCE = {
    tx: 1,
    coin: 1,
    confirmed: INIT_FUND,
    unconfirmed: INIT_FUND,
    ulocked: 0,
    clocked: 0
  };

  const prepare = () => {
    node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [WalletPlugin],
      noDNS: true,
      noNS: true
    });

    chain = node.chain;

    node.once('error', (err) => {
      assert(false, err);
    });

    wdb = node.require('walletdb').wdb;
  };

  const getAddrStr = async (wallet, acct = 0) => {
    return (await wallet.receiveAddress(acct)).toString(network);
  };

  const forWTX = (id, hash) => {
    return forEventCondition(wdb, 'tx', (wallet, tx) => {
      return wallet.id === id && tx.hash().equals(hash);
    });
  };

  const mineBlocks = async (blocks) => {
    const tipHeight = chain.tip.height;
    const forWalletBlock = forEventCondition(wdb, 'block connect', (entry) => {
      return entry.height === tipHeight + 1;
    });
    await node.rpc.generateToAddress([blocks, await getAddrStr(primary)]);
    await forWalletBlock;
  };

  const setupWallets = async () => {
    primary = await wdb.get('primary');

    aliceID = 'alice';
    alicew = await wdb.create({ id: aliceID });
    await alicew.createAccount({ name: altAccount1 });

    bobID = 'bob';
    bobw = await wdb.create({ id: bobID });
    await bobw.createAccount({ name: altAccount1 });

    carolID = 'carol';
    carolw = await wdb.create({ id: carolID });
    await carolw.createAccount({ name: altAccount1 });
  };

  const fundWallets = async () => {
    await mineBlocks(INIT_BLOCKS);
    const addrs = [];

    addrs.push(await getAddrStr(alicew, defaultAcc));
    addrs.push(await getAddrStr(alicew, altAccount1));
    addrs.push(await getAddrStr(bobw, defaultAcc));
    addrs.push(await getAddrStr(bobw, altAccount1));

    await primary.send({
      outputs: addrs.map((addr) => {
        return {
          value: INIT_FUND,
          address: addr
        };
      })
    });
    await mineBlocks(1);
  };

  const beforeAll = async () => {
    prepare();

    await node.open();
    await setupWallets();
    await fundWallets();
  };

  const afterAll = async () => {
    await node.close();
    node = null;
  };

  const assertBalance = (balance, obj) => {
    for (const [key, val] of Object.entries(obj)) {
      assert.strictEqual(balance[key], val, `Incorrect ${key} balance.`);
    }
  };

  const applyDelta = (balance, delta) => {
    const nbalance = { ...balance };

    for (const [key, value] of Object.entries(delta))
      nbalance[key] += value;

    return nbalance;
  };

  const getRegisteredName = async (name, wallet, price, opts) => {
    await primary.sendOpen(name, true);
    await mineBlocks(openingPeriod);

    await wallet.sendBid(name, price, price, opts);
    await primary.sendBid(name, price, price);
    await mineBlocks(biddingPeriod);

    await wallet.sendReveal(name, opts);
    await primary.sendReveal(name);
    await mineBlocks(revealPeriod);

    const resource = Resource.fromJSON({ records: [] });
    await primary.sendRedeem(name);
    await wallet.sendUpdate(name, resource, opts);
    await mineBlocks(1);
  };

  describe('NONE -> BID', function() {
    before(beforeAll);
    after(afterAll);

    it('should handle own bid', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = alicew;
      const account = defaultAcc;
      const opts = { account, hardFee};

      const bidAmount = 1e6 / 4;
      const blindAmount = 1e6;

      const expectedBalances = [];
      expectedBalances.push(INIT_BALANCE);

      // starting balance should be just coinbases.
      assertBalance(await wallet.getBalance(account), expectedBalances[0]);

      // +1 tx, +1 coin (TODO: Update when we remove opens from UTXO set)
      await wallet.sendOpen(name, false, opts);

      expectedBalances.push(applyDelta(expectedBalances[0], {
        // we got new tx (open)
        tx: 1,
        // new coin OPEN (TODO: remove OPENs)
        coin: 1,
        // Only cost us fee.
        unconfirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await mineBlocks(openingPeriod);

      // We just confirmed fee spent in open.
      expectedBalances.push(applyDelta(expectedBalances[1], {
        // fee got confirmed
        confirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      // bidding period.
      await wallet.sendBid(name, bidAmount, blindAmount, opts);

      // bid should have locked BLIND unconfirmed
      expectedBalances.push(applyDelta(expectedBalances[2], {
        // new bid tx.
        tx: 1,
        // new bid coin (does not consume OPEN coin)
        coin: 1,
        // another fee
        unconfirmed: -hardFee,
        // locks blind Amount
        ulocked: blindAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[3]);

      // confirm
      await mineBlocks(1);

      // Now it's confirmed.
      expectedBalances.push(applyDelta(expectedBalances[3], {
        confirmed: -hardFee,
        clocked: blindAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[4]);

      // We go back to unconfirmed state.
      await wdb.revert(node.chain.height - 1);
      assertBalance(await wallet.getBalance(account), expectedBalances[3]);

      // Now we also remove unconfirmed txs.
      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[2]);
    });

    it('should handle foreign out bid', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wid = bobID;
      const wallet = bobw;
      const account = defaultAcc;

      const bidAmount = 1e6 / 4;
      const blindAmount = 1e6;

      const expectedBalances = [];
      // initial balances.
      expectedBalances.push(INIT_BALANCE);

      assertBalance(await wallet.getBalance(account), expectedBalances[0]);

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);

      const altRecv1 = await wallet.receiveAddress(account);
      const bidMTX = await primary.createBid(name, bidAmount, blindAmount);
      assert.strictEqual(bidMTX.outputs.length, 2);
      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      bidMTX.outputs[0].address = altRecv1;

      for (const input of bidMTX.inputs)
        input.witness.length = 0;

      await primary.sign(bidMTX);
      const waitForBidTX = forWTX(wid, bidMTX.hash());
      await wdb.send(bidMTX.toTX());
      await waitForBidTX;

      expectedBalances.push(applyDelta(expectedBalances[0], {
        // we got new bid tx.
        tx: 1,
        // we got bid utxo
        coin: 1,
        // bid blind value is part of our balance
        unconfirmed: blindAmount,
        // it's also locked
        ulocked: blindAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await mineBlocks(1);

      // it got confirmed
      expectedBalances.push(applyDelta(expectedBalances[1], {
        confirmed: blindAmount,
        clocked: blindAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      await wdb.revert(node.chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[0]);
    });
  });

  describe('BID -> REVEAL', function() {
    before(beforeAll);
    after(afterAll);

    it('should handle normal BID -> REVEAL', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = alicew;
      const account = defaultAcc;
      const opts = { account, hardFee };

      const bidAmount = 1e6 / 4;
      const blindAmount = 1e6;

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await wallet.sendBid(name, bidAmount, blindAmount, opts);
      await mineBlocks(biddingPeriod);

      const expectedBalances = [];

      // initial balance, bid and initial fund txs/coins
      expectedBalances.push({
        tx: 2,
        coin: 2,
        confirmed: INIT_FUND - hardFee,
        unconfirmed: INIT_FUND - hardFee,
        clocked: blindAmount,
        ulocked: blindAmount
      });

      assertBalance(await wallet.getBalance(account), expectedBalances[0]);

      await wallet.sendReveal(name, opts);

      // after reveal
      expectedBalances.push(applyDelta(expectedBalances[0], {
        // we got reveal tx
        tx: 1,
        // we consume bid, produce -> freed coin + reveal out
        coin: 1,
        // just the fee.
        unconfirmed: -hardFee,
        // now only bidAmount is locked, we unlock everything else.
        ulocked: -blindAmount + bidAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[1]);
      await mineBlocks(1);

      // add all unconfirmed to the confirmed.
      expectedBalances.push(applyDelta(expectedBalances[1], {
        confirmed: -hardFee,
        clocked: -blindAmount + bidAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      // revert last block
      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      // erase tx.
      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[0]);
    });

    it('should handle cross acct BID -> REVEAL', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = bobw;
      const account = defaultAcc;
      const altAccount = altAccount1;
      const opts = { account, hardFee };

      const bidAmount = 2e6 / 4;
      const blindAmount = 2e6;

      // mine on default account.
      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await wallet.sendBid(name, bidAmount, blindAmount, opts);
      await mineBlocks(biddingPeriod);

      const expectedDefaultBalances = [];
      const expectedAltBalances = [];

      // initial balances.
      expectedDefaultBalances.push({
        tx: 2,
        coin: 2,
        confirmed: INIT_FUND - hardFee,
        unconfirmed: INIT_FUND - hardFee,
        clocked: blindAmount,
        ulocked: blindAmount
      });

      expectedAltBalances.push(INIT_BALANCE);

      assertBalance(await wallet.getBalance(account), expectedDefaultBalances[0]);
      assertBalance(await wallet.getBalance(altAccount), expectedAltBalances[0]);

      const altAddr = await wallet.receiveAddress(altAccount);
      const revealMTX = await wallet.createReveal(name, opts);
      const {outputs} = revealMTX;
      assert.strictEqual(outputs.length, 2);
      assert.strictEqual(outputs[0].covenant.type, types.REVEAL);
      outputs[0].address = altAddr;

      for (const input of revealMTX.inputs)
        input.witness.length = 0;

      await wallet.sign(revealMTX);
      const tx = revealMTX.toTX();
      const txAdded = forWTX(bobID, tx.hash());
      await wdb.send(tx);
      await txAdded;

      // default sent bid to alt acct.
      expectedDefaultBalances.push(applyDelta(expectedDefaultBalances[0], {
        // reveal tx.
        tx: 1,
        // coin does not change:
        // we consume bid ->
        //  + we add freed coins to our balance
        //  + send reveal to other.
        coin: 0,
        // we sent bid to others.
        unconfirmed: -hardFee - bidAmount,
        // we don't have any locked value left
        ulocked: -blindAmount // 0.
      }));

      expectedAltBalances.push(applyDelta(expectedAltBalances[0], {
        // we received reveal tx.
        tx: 1,
        // we received REVEAL coin
        coin: 1,
        // we received REVEAL value
        unconfirmed: bidAmount,
        // these coins are locked until redeem/register
        ulocked: bidAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedDefaultBalances[1]);
      assertBalance(await wallet.getBalance(altAccount), expectedAltBalances[1]);
      await mineBlocks(1);

      // confirmed.
      expectedDefaultBalances.push(applyDelta(expectedDefaultBalances[1], {
        confirmed: -hardFee - bidAmount,
        clocked: -blindAmount
      }));

      expectedAltBalances.push(applyDelta(expectedAltBalances[1], {
        confirmed: bidAmount,
        clocked: bidAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedDefaultBalances[2]);
      assertBalance(await wallet.getBalance(altAccount), expectedAltBalances[2]);

      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedDefaultBalances[1]);
      assertBalance(await wallet.getBalance(altAccount), expectedAltBalances[1]);

      await wallet.zap(account, 0);
      await wallet.zap(altAccount, 0);
      assertBalance(await wallet.getBalance(account), expectedDefaultBalances[0]);
      assertBalance(await wallet.getBalance(altAccount), expectedAltBalances[0]);
    });

    it('should handle external BID -> REVEAL', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = alicew;
      const account = altAccount1;
      const opts = { hardFee };

      const bidAmount = 3e6 / 4;
      const blindAmount = 3e6;

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await primary.sendBid(name, bidAmount, blindAmount, opts);
      await mineBlocks(biddingPeriod);

      const expectedBalances = [];
      expectedBalances.push(INIT_BALANCE);

      assertBalance(await wallet.getBalance(account), expectedBalances[0]);

      const addr = await wallet.receiveAddress(account);
      const revealMTX = await primary.createReveal(name, opts);
      const {outputs} = revealMTX;
      assert.strictEqual(outputs.length, 2);
      assert.strictEqual(outputs[0].covenant.type, types.REVEAL);
      outputs[0].address = addr;

      for (const input of revealMTX.inputs)
        input.witness.length = 0;

      await primary.sign(revealMTX);
      const tx = revealMTX.toTX();
      const txAdded = forWTX(aliceID, tx.hash());
      await wdb.send(tx);
      await txAdded;

      expectedBalances.push(applyDelta(expectedBalances[0], {
        // we got new reveal tx
        tx: 1,
        // we got reveal coin
        coin: 1,
        // we got bidAmount to our balance.
        unconfirmed: bidAmount,
        // and it's locked
        ulocked: bidAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await mineBlocks(1);

      // confirmed.
      expectedBalances.push(applyDelta(expectedBalances[1], {
        confirmed: bidAmount,
        clocked: bidAmount
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[0]);
    });
  });

  describe('REVEAL -> REDEEM/REGISTER', function () {
    before(beforeAll);
    after(afterAll);

    it('should handle normal REVEAL -> REDEEM/REGISTER', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      const winner = alicew;
      const winnerAcct = defaultAcc;
      const winnerOpts = { account: defaultAcc, hardFee };
      const loser = bobw;
      const loserAcct = defaultAcc;
      const loserOpts = { account: loserAcct, hardFee };

      const winnerBidAmount = 2e6 / 4;
      const winnerBlindAmount = 2e6;
      const loserBidAmount = 1e6 / 4;
      const loserBlindAmount = 1e6;

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await loser.sendBid(name, loserBidAmount, loserBlindAmount, loserOpts);
      await winner.sendBid(name, winnerBidAmount, winnerBlindAmount, winnerOpts);
      await mineBlocks(biddingPeriod);
      await loser.sendReveal(name, loserOpts);
      await winner.sendReveal(name, winnerOpts);
      await mineBlocks(revealPeriod);

      const expectedLoserBalances = [];
      const expectedWinnerBalances = [];

      expectedLoserBalances.push({
        tx: 3,
        coin: 3,
        confirmed: INIT_FUND - (hardFee * 2),
        unconfirmed: INIT_FUND - (hardFee * 2),
        clocked: loserBidAmount,
        ulocked: loserBidAmount
      });

      expectedWinnerBalances.push({
        ...expectedLoserBalances[0],
        clocked: winnerBidAmount,
        ulocked: winnerBidAmount
      });

      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[0]);
      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[0]);

      const resource = Resource.fromJSON({ records: [] });
      await winner.sendUpdate(name, resource, winnerOpts);
      await loser.sendRedeem(name, loserOpts);

      expectedLoserBalances.push(applyDelta(expectedLoserBalances[0], {
        // redeem tx.
        tx: 1,
        // fund fees + reveal -> redeem + change
        coin: 0,
        // fees
        unconfirmed: -hardFee,
        // unlock bid
        ulocked: -loserBidAmount // 0
      }));

      expectedWinnerBalances.push(applyDelta(expectedWinnerBalances[0], {
        // register tx.
        tx: 1,
        // consume REVEAL -> REGISTER (losing bid was lower) + leftover
        coin: 1,
        // consume fees.
        unconfirmed: -hardFee,
        // only lock second highest bid
        ulocked: -winnerBidAmount + loserBidAmount
      }));

      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[1]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[1]);
      await mineBlocks(1);

      // confirm above
      expectedLoserBalances.push(applyDelta(expectedLoserBalances[1], {
        confirmed: -hardFee,
        clocked: -loserBidAmount
      }));

      expectedWinnerBalances.push(applyDelta(expectedWinnerBalances[1], {
        confirmed: -hardFee,
        clocked: -winnerBidAmount + loserBidAmount
      }));

      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[2]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[2]);

      await wdb.revert(chain.tip.height - 1);
      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[1]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[1]);

      await loser.zap(loserAcct, 0);
      await winner.zap(winnerAcct, 0);
      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[0]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[0]);
    });

    it('should handle normal REVEAL -> REDEEM/REGISTER (same amount)', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      const winner = alicew;
      const winnerAcct = altAccount1;
      const winnerOpts = { account: winnerAcct, hardFee };
      const loser = bobw;
      const loserAcct = altAccount1;
      const loserOpts = { account: loserAcct, hardFee };

      const winnerBidAmount = 1e6 / 4;
      const winnerBlindAmount = 1e6;
      const loserBidAmount = 1e6 / 4;
      const loserBlindAmount = 1e6;

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await loser.sendBid(name, loserBidAmount, loserBlindAmount, loserOpts);
      await winner.sendBid(name, winnerBidAmount, winnerBlindAmount, winnerOpts);
      await mineBlocks(biddingPeriod);
      await winner.sendReveal(name, winnerOpts);
      // make sure loser is second.
      await loser.sendReveal(name, loserOpts);
      await mineBlocks(revealPeriod);

      const expectedLoserBalances = [];
      const expectedWinnerBalances = [];

      expectedLoserBalances.push({
        tx: 3,
        coin: 3,
        confirmed: INIT_FUND - (hardFee * 2),
        unconfirmed: INIT_FUND - (hardFee * 2),
        clocked: loserBidAmount,
        ulocked: loserBidAmount
      });

      expectedWinnerBalances.push({
        ...expectedLoserBalances[0],
        clocked: winnerBidAmount,
        ulocked: winnerBidAmount
      });

      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[0]);
      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[0]);

      const resource = Resource.fromJSON({ records: [] });
      await winner.sendUpdate(name, resource, winnerOpts);
      await loser.sendRedeem(name, loserOpts);

      expectedLoserBalances.push(applyDelta(expectedLoserBalances[0], {
        // redeem tx.
        tx: 1,
        // fund fees + reveal -> redeem + change
        coin: 0,
        // fees
        unconfirmed: -hardFee,
        // unlock bid
        ulocked: -loserBidAmount // 0
      }));

      expectedWinnerBalances.push(applyDelta(expectedWinnerBalances[0], {
        // register tx.
        tx: 1,
        // consume REVEAL + fundFee -> REGISTER + change.
        // This is different from above, because losing bid is the same as winning.
        coin: 0,
        // consume fees.
        unconfirmed: -hardFee,
        // only lock second highest bid
        ulocked: -winnerBidAmount + loserBidAmount
      }));

      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[1]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[1]);
      await mineBlocks(1);

      // confirm above
      expectedLoserBalances.push(applyDelta(expectedLoserBalances[1], {
        confirmed: -hardFee,
        clocked: -loserBidAmount
      }));

      expectedWinnerBalances.push(applyDelta(expectedWinnerBalances[1], {
        confirmed: -hardFee,
        clocked: -winnerBidAmount + loserBidAmount
      }));

      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[2]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[2]);

      await wdb.revert(chain.tip.height - 1);
      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[1]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[1]);

      await loser.zap(loserAcct, 0);
      await winner.zap(winnerAcct, 0);
      assertBalance(await loser.getBalance(loserAcct), expectedLoserBalances[0]);
      assertBalance(await winner.getBalance(winnerAcct), expectedWinnerBalances[0]);
    });
  });

  describe('REGISTER -> UPDATE/RENEW', function() {
    before(beforeAll);
    after(afterAll);

    const fromRegisterCheck = async (wallet, acct, type) => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const price = 1e6;
      const opts = { account: acct, hardFee };

      await getRegisteredName(name, wallet, price, opts);
      const expectedBalances = [];

      expectedBalances.push({
        tx: 4,
        // REGISTER + change
        coin: 2,
        confirmed: INIT_FUND - (hardFee * 3),
        unconfirmed: INIT_FUND - (hardFee * 3),
        ulocked: price,
        clocked: price
      });

      assertBalance(await wallet.getBalance(acct), expectedBalances[0]);

      switch (type) {
        case 'update': {
          const resource = Resource.fromJSON({ records: [] });
          await wallet.sendUpdate(name, resource, opts);
          break;
        }
        case 'renew': {
          await mineBlocks(treeInterval);
          await wallet.sendRenewal(name, opts);
          break;
        }
        default:
          assert(false, 'unknown test');
      }

      expectedBalances.push(applyDelta(expectedBalances[0], {
        tx: 1,
        unconfirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(acct), expectedBalances[1]);
      await mineBlocks(1);

      expectedBalances.push(applyDelta(expectedBalances[1], {
        confirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(acct), expectedBalances[2]);

      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(acct), expectedBalances[1]);

      await wallet.zap(acct, 0);
      assertBalance(await wallet.getBalance(acct), expectedBalances[0]);
    };

    it('should -> UPDATE', async () => {
      await fromRegisterCheck(alicew, defaultAcc, 'update');
    });

    it('should -> RENEW', async () => {
      await fromRegisterCheck(alicew, altAccount1, 'renew');
    });
  });

  describe('REGISTER/UPDATE -> TRANSFER/REVOKE', function() {
    before(beforeAll);
    after(afterAll);

    const PRICE = 1e6;
    const initRegBalance = {
      tx: 4,
      coin: 2,
      confirmed: INIT_FUND - (hardFee * 3),
      unconfirmed: INIT_FUND - (hardFee * 3),
      ulocked: PRICE,
      clocked: PRICE
    };

    it('should -> REVOKE', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = alicew;
      const account = defaultAcc;
      const opts = { account, hardFee };

      await getRegisteredName(name, wallet, PRICE, opts);

      const expectedBalances = [];

      expectedBalances.push({ ...initRegBalance });

      assertBalance(await wallet.getBalance(account), expectedBalances[0]);

      await wallet.sendRevoke(name, opts);

      // Revoke does not unlock coins nor remove balance, only consumes fee.
      expectedBalances.push(applyDelta(expectedBalances[0], {
        tx: 1,
        unconfirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await mineBlocks(1);

      expectedBalances.push(applyDelta(expectedBalances[1], {
        confirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[0]);
    });

    it('should TRANSFER -> FINALIZE', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = alicew;
      const wallet2 = bobw;
      const account = altAccount1;
      const account2 = defaultAcc;
      const opts = { account, hardFee };
      const w2addr = await wallet2.receiveAddress(account2);

      await getRegisteredName(name, wallet, PRICE, opts);

      const expectedSenderBalances = [];
      const expectedReceiverBalances = [];

      expectedSenderBalances.push({ ...initRegBalance });
      expectedReceiverBalances.push(INIT_BALANCE);

      assertBalance(await wallet.getBalance(account), expectedSenderBalances[0]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[0]);

      await wallet.sendTransfer(name, w2addr, opts);

      expectedSenderBalances.push(applyDelta(expectedSenderBalances[0], {
        tx: 1,
        unconfirmed: -hardFee
      }));

      // Transfer is still within wallet state transition.
      // Finalize is when the UTXO leaves the wallet.
      expectedReceiverBalances.push(applyDelta(expectedReceiverBalances[0], {}));

      assertBalance(await wallet.getBalance(account), expectedSenderBalances[1]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[1]);

      // confirm
      await mineBlocks(1);
      expectedSenderBalances.push(applyDelta(expectedSenderBalances[1], {
        confirmed: -hardFee
      }));
      expectedReceiverBalances.push(applyDelta(expectedReceiverBalances[1], {}));

      assertBalance(await wallet.getBalance(account), expectedSenderBalances[2]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[2]);

      // proceed to finalize
      await mineBlocks(transferLockup);
      await wallet.sendFinalize(name, opts);

      expectedSenderBalances.push(applyDelta(expectedSenderBalances[2], {
        tx: 1,
        coin: -1,
        unconfirmed: -hardFee - PRICE,
        ulocked: -PRICE
      }));

      expectedReceiverBalances.push(applyDelta(expectedReceiverBalances[2], {
        tx: 1,
        coin: 1,
        unconfirmed: PRICE,
        ulocked: PRICE
      }));

      assertBalance(await wallet.getBalance(account), expectedSenderBalances[3]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[3]);

      // confirm finalize.
      await mineBlocks(1);

      expectedSenderBalances.push(applyDelta(expectedSenderBalances[3], {
        confirmed: -hardFee - PRICE,
        clocked: -PRICE
      }));

      expectedReceiverBalances.push(applyDelta(expectedReceiverBalances[3], {
        confirmed: PRICE,
        clocked: PRICE
      }));

      assertBalance(await wallet.getBalance(account), expectedSenderBalances[4]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[4]);

      // Now let's revert.
      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedSenderBalances[3]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[3]);

      await wallet.zap(account, 0);
      await wallet2.zap(account2, 0);
      assertBalance(await wallet.getBalance(account), expectedSenderBalances[2]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[2]);

      // revert transfer
      await wdb.revert(chain.tip.height - 1 - transferLockup - 1);
      assertBalance(await wallet.getBalance(account), expectedSenderBalances[1]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[1]);

      await wallet.zap(account, 0);
      await wallet2.zap(account2, 0);
      assertBalance(await wallet.getBalance(account), expectedSenderBalances[0]);
      assertBalance(await wallet2.getBalance(account2), expectedReceiverBalances[0]);
    });

    it('should TRANSFER -> REVOKE', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = bobw;
      const account = altAccount1;
      const opts = { account, hardFee };
      const w2addr = await carolw.receiveAddress(defaultAcc);

      await getRegisteredName(name, wallet, PRICE, opts);

      const expectedBalances = [];
      expectedBalances.push({ ...initRegBalance });

      assertBalance(await wallet.getBalance(account), expectedBalances[0]);

      await wallet.sendTransfer(name, w2addr, opts);

      expectedBalances.push(applyDelta(expectedBalances[0], {
        tx: 1,
        unconfirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await mineBlocks(1);

      expectedBalances.push(applyDelta(expectedBalances[1], {
        confirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      await wallet.sendRevoke(name, opts);

      // Revoke does not unlock coins nor remove balance, only consumes fee.
      expectedBalances.push(applyDelta(expectedBalances[2], {
        tx: 1,
        unconfirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[3]);

      await mineBlocks(1);

      expectedBalances.push(applyDelta(expectedBalances[3], {
        confirmed: -hardFee
      }));

      assertBalance(await wallet.getBalance(account), expectedBalances[4]);

      // revert
      await wdb.revert(chain.tip.height - 1);
      assertBalance(await wallet.getBalance(account), expectedBalances[3]);

      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[2]);

      await wdb.revert(chain.tip.height - 2);
      assertBalance(await wallet.getBalance(account), expectedBalances[1]);

      await wallet.zap(account, 0);
      assertBalance(await wallet.getBalance(account), expectedBalances[0]);
    });
  });

  /*
   * From here we test cases when addresses are discovered later.
   * It could happen when account gap is lower than an actual gap.
   * Or if someone owning XPUB just sends txs to addresses after gap.
   *
   * Note that, in some cases NONE -> BID, BID -> REVEAL it could be
   * someone sending from the outside of the wallet and not the gap issue. (Above)
   */

  describe('NONE -> BID (Gapped)', function() {
    before(beforeAll);
    after(afterAll);

    // NOTE: If the transaction did not contain anything related to the wallet,
    // it would be totally missed on revert until rescan.
    it.only('should handle missed bid (on confirm)', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = alicew;
      const accountName = defaultAcc;
      const opts = { account: accountName, hardFee };
      let account = await wallet.getAccount(accountName);

      const blindAmount = 1e6;
      const bidAmount = blindAmount / 4;

      const expectedBalances = [];
      expectedBalances.push(INIT_BALANCE);

      assertBalance(await wallet.getBalance(accountName), expectedBalances[0]);
      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      const batchActions = [
        ['BID', name, bidAmount, blindAmount],
        ['BID', name, bidAmount, blindAmount]
      ];

      const bidMTX = await wallet.createBatch(batchActions, opts);
      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);
      const nextIndex = account.receiveDepth + account.lookahead + 1;
      const nextAddr = account.deriveReceive(nextIndex).getAddress();
      bidMTX.outputs[1].address = nextAddr;

      for (const input of bidMTX.inputs)
        input.witness.length = 0;

      await wallet.sign(bidMTX);
      wdb.send(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());

      expectedBalances.push(applyDelta(expectedBalances[0], {
        tx: 1,
        // BID + CHANGE
        coin: 1,
        // unknown bid will actually spend coin from our balance.
        unconfirmed: -hardFee - blindAmount,
        ulocked: blindAmount
      }));

      await wallet.createReceive();
      assertBalance(await wallet.getBalance(accountName), expectedBalances[1]);

      // derive two addresses.
      await account.receiveAddress();
      await account.receiveAddress();
      await mineBlocks(1);

      expectedBalances.push(applyDelta(expectedBalances[1], {
        // we discovered coin
        coin: 1,
        // because we discovered blind, we no longer spend those coins.
        confirmed: -hardFee,
        // add newly discovered coins to unconfirmed as well.
        unconfirmed: blindAmount,
        // we discovered another bid is ours, so we have both locked.
        clocked: blindAmount * 2,
        // add newly discovered bid to ulocked.
        ulocked: blindAmount
      }));

      assertBalance(await wallet.getBalance(accountName), expectedBalances[2]);
    });
  });
});
