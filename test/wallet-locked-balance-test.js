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

const WALLET_N = 10;
const GRIND_NAME_LEN = 10;
const hardFee = 1e4;

// TODO: Add insert w/ block only tests(no unconfirmed step).
// TODO: Add claim test.
// TODO: (Re)Move and merge wallet-test lock balance checks.
describe('Wallet Balance', function() {
  let node, chain, wdb;
  // wallets
  let primary;

  const DEFAULT_ACCOUNT = 'default';
  const ALT_ACCOUNT = 'alt';

  let allWallets = [];

  const INIT_BLOCKS = treeInterval;
  const INIT_FUND = 10e6;
  const INIT_BALANCE = {
    tx: 1,
    coin: 1,
    unconfirmed: INIT_FUND,
    confirmed: INIT_FUND,
    ulocked: 0,
    clocked: 0
  };
  const BLIND_AMOUNT = 1e6;
  const BID_AMOUNT = BLIND_AMOUNT / 4;

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

    allWallets = [];
    for (let i = 0; i < WALLET_N; i++) {
      const name = 'wallet' + i;
      const wallet = await wdb.create({ id: name });
      await wallet.createAccount({ name: ALT_ACCOUNT });

      allWallets.push(wallet);
    }
  };

  const fundWallets = async () => {
    await mineBlocks(INIT_BLOCKS);
    const addrs = [];

    for (let i = 0; i < WALLET_N; i++) {
      addrs.push(await getAddrStr(allWallets[i], DEFAULT_ACCOUNT));
      addrs.push(await getAddrStr(allWallets[i], ALT_ACCOUNT));
    }

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

  // Helpers
  const getBalanceObj = async (wallet, account) => {
    const balance = await wallet.getBalance(account);
    const {
      tx,
      coin,
      unconfirmed,
      confirmed,
      lockedUnconfirmed,
      lockedConfirmed
    } = balance.getJSON(true);

    return {
      tx,
      coin,
      unconfirmed,
      confirmed,
      clocked: lockedConfirmed,
      ulocked: lockedUnconfirmed
    };
  };

  const assertBalance = async (wallet, account, expected) => {
    const balance = await getBalanceObj(wallet, account);
    assert.deepStrictEqual(balance, expected);
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
      const wallet = allWallets[0];
      const account = DEFAULT_ACCOUNT;
      const opts = { account, hardFee };

      const initialBalance = INIT_BALANCE;
      //
      // starting balance should be just coinbases.
      await assertBalance(wallet, account, initialBalance);

      // +1 tx, +1 coin (TODO: Update when we remove opens from UTXO set)
      await wallet.sendOpen(name, false, opts);

      const afterOpenBalance = applyDelta(initialBalance, {
        // we got new tx (open)
        tx: 1,
        // new coin OPEN (TODO: remove OPENs)
        coin: 1,
        // Only cost us fee.
        unconfirmed: -hardFee
      });

      await assertBalance(wallet, account, afterOpenBalance);

      await mineBlocks(openingPeriod);

      // We just confirmed fee spent in open.
      const afterOpenConfirmedBalance = applyDelta(afterOpenBalance, {
        // fee got confirmed
        confirmed: -hardFee
      });

      await assertBalance(wallet, account, afterOpenConfirmedBalance);

      // bidding period.
      await wallet.sendBid(name, BID_AMOUNT, BLIND_AMOUNT, opts);

      // bid should have locked BLIND unconfirmed
      const afterBidSendBalance = applyDelta(afterOpenConfirmedBalance, {
        // new bid tx.
        tx: 1,
        // new bid coin (does not consume OPEN coin)
        coin: 1,
        // another fee
        unconfirmed: -hardFee,
        // locks blind Amount
        ulocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, account, afterBidSendBalance);

      // confirm
      await mineBlocks(1);

      // Now it's confirmed.
      const afterBidConfirmedBalance = applyDelta(afterBidSendBalance, {
        confirmed: -hardFee,
        clocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, account, afterBidConfirmedBalance);

      // We go back to unconfirmed state.
      await wdb.revert(node.chain.height - 1);
      await assertBalance(wallet, account, afterBidSendBalance);

      // Now we also remove unconfirmed txs.
      await wallet.zap(account, 0);
      await assertBalance(wallet, account, afterOpenConfirmedBalance);
    });

    it('should handle foreign out bid', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[1];
      const wid = wallet.id;
      const account = DEFAULT_ACCOUNT;

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);

      let initialBalance = null;
      let afterBidBalance = null;
      let afterBidConfirmedBalance = null;

      initialBalance = INIT_BALANCE;

      await assertBalance(wallet, account, initialBalance);

      const altRecv1 = await wallet.receiveAddress(account);
      const bidMTX = await primary.createBid(name, BID_AMOUNT, BLIND_AMOUNT);
      assert.strictEqual(bidMTX.outputs.length, 2);
      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      bidMTX.outputs[0].address = altRecv1;

      for (const input of bidMTX.inputs)
        input.witness.length = 0;

      await primary.sign(bidMTX);
      const waitForBidTX = forWTX(wid, bidMTX.hash());
      await wdb.send(bidMTX.toTX());
      await waitForBidTX;

      afterBidBalance = applyDelta(initialBalance, {
        // we got new bid tx.
        tx: 1,
        // we got bid utxo
        coin: 1,
        // bid blind value is part of our balance
        unconfirmed: BLIND_AMOUNT,
        // it's also locked
        ulocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, account, afterBidBalance);

      await mineBlocks(1);

      // it got confirmed
      afterBidConfirmedBalance = applyDelta(afterBidBalance, {
        confirmed: BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, account, afterBidConfirmedBalance);

      await wdb.revert(node.chain.tip.height - 1);
      await assertBalance(wallet, account, afterBidBalance);

      await wallet.zap(account, 0);
      await assertBalance(wallet, account, initialBalance);
    });
  });

  describe('BID -> REVEAL', function() {
    before(beforeAll);
    after(afterAll);

    it('should handle normal BID -> REVEAL', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[0];
      const account = DEFAULT_ACCOUNT;
      const opts = { account, hardFee };

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await wallet.sendBid(name, BID_AMOUNT, BLIND_AMOUNT, opts);
      await mineBlocks(biddingPeriod);

      let initialBalance = null;
      let afterRevealBalance = null;
      let afterRevealConfirmedBalance = null;

      // initial balance, bid and initial fund txs/coins
      initialBalance = {
        tx: 2,
        coin: 2,
        confirmed: INIT_FUND - hardFee,
        unconfirmed: INIT_FUND - hardFee,
        clocked: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      };

      await assertBalance(wallet, account, initialBalance);

      await wallet.sendReveal(name, opts);

      afterRevealBalance = applyDelta(initialBalance, {
        // we got reveal tx
        tx: 1,
        // we consume bid, produce -> freed coin + reveal out
        coin: 1,
        // just the fee.
        unconfirmed: -hardFee,
        // now only bidAmount is locked, we unlock everything else.
        ulocked: -BLIND_AMOUNT + BID_AMOUNT
      });

      await assertBalance(wallet, account, afterRevealBalance);
      await mineBlocks(1);

      // add all unconfirmed to the confirmed.
      afterRevealConfirmedBalance = applyDelta(afterRevealBalance, {
        confirmed: -hardFee,
        clocked: -BLIND_AMOUNT + BID_AMOUNT
      });

      await assertBalance(wallet, account, afterRevealConfirmedBalance);

      // revert last block
      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, account, afterRevealBalance);

      // erase tx.
      await wallet.zap(account, 0);
      await assertBalance(wallet, account, initialBalance);
    });

    it('should handle cross acct BID -> REVEAL', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[1];
      const account = DEFAULT_ACCOUNT;
      const altAccount = ALT_ACCOUNT;
      const opts = { account, hardFee };

      const bidAmount = 2e6 / 4;
      const blindAmount = 2e6;

      // mine on default account.
      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await wallet.sendBid(name, bidAmount, blindAmount, opts);
      await mineBlocks(biddingPeriod);

      let initialBalanceDefault = null;
      let afterRevealBalanceDefault = null;
      let afterRevealConfirmedBalanceDefault = null;

      let initialBalanceAlt = null;
      let afterRevealBalanceAlt = null;
      let afterRevealConfirmedBalanceAlt = null;

      // initial balances.
      initialBalanceDefault = {
        tx: 2,
        coin: 2,
        confirmed: INIT_FUND - hardFee,
        unconfirmed: INIT_FUND - hardFee,
        clocked: blindAmount,
        ulocked: blindAmount
      };

      initialBalanceAlt = INIT_BALANCE;

      await assertBalance(wallet, account, initialBalanceDefault);
      await assertBalance(wallet, altAccount, initialBalanceAlt);

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
      wdb.send(tx);
      await forWTX(wallet.id, tx.hash());

      // default sent bid to alt acct.
      afterRevealBalanceDefault = applyDelta(initialBalanceDefault, {
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
      });

      afterRevealBalanceAlt = applyDelta(initialBalanceAlt, {
        // we received reveal tx.
        tx: 1,
        // we received REVEAL coin
        coin: 1,
        // we received REVEAL value
        unconfirmed: bidAmount,
        // these coins are locked until redeem/register
        ulocked: bidAmount
      });

      await assertBalance(wallet, account, afterRevealBalanceDefault);
      await assertBalance(wallet, altAccount, afterRevealBalanceAlt);
      await mineBlocks(1);

      // confirmed.
      afterRevealConfirmedBalanceDefault = applyDelta(afterRevealBalanceDefault, {
        confirmed: -hardFee - bidAmount,
        clocked: -blindAmount
      });

      afterRevealConfirmedBalanceAlt = applyDelta(afterRevealBalanceAlt, {
        confirmed: bidAmount,
        clocked: bidAmount
      });

      await assertBalance(wallet, account, afterRevealConfirmedBalanceDefault);
      await assertBalance(wallet, altAccount, afterRevealConfirmedBalanceAlt);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, account, afterRevealBalanceDefault);
      await assertBalance(wallet, altAccount, afterRevealBalanceAlt);

      await wallet.zap(account, 0);
      await wallet.zap(altAccount, 0);
      await assertBalance(wallet, account, initialBalanceDefault);
      await assertBalance(wallet, altAccount, initialBalanceAlt);
    });

    it('should handle external BID -> REVEAL', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[2];
      const account = DEFAULT_ACCOUNT;
      const opts = { hardFee };

      await primary.sendOpen(name, true);
      await mineBlocks(openingPeriod);
      await primary.sendBid(name, BID_AMOUNT, BLIND_AMOUNT, opts);
      await mineBlocks(biddingPeriod);

      let initialBalance = null;
      let afterRevealBalance = null;
      let afterRevealConfirmedBalance = null;

      initialBalance = INIT_BALANCE;
      await assertBalance(wallet, account, initialBalance);

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
      const txAdded = forWTX(wallet.id, tx.hash());
      await wdb.send(tx);
      await txAdded;

      afterRevealBalance = applyDelta(initialBalance, {
        // we got new reveal tx
        tx: 1,
        // we got reveal coin
        coin: 1,
        // we got bidAmount to our balance.
        unconfirmed: BID_AMOUNT,
        // and it's locked
        ulocked: BID_AMOUNT
      });

      await assertBalance(wallet, account, afterRevealBalance);

      await mineBlocks(1);

      // confirmed.
      afterRevealConfirmedBalance = applyDelta(afterRevealBalance, {
        confirmed: BID_AMOUNT,
        clocked: BID_AMOUNT
      });

      await assertBalance(wallet, account, afterRevealConfirmedBalance);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, account, afterRevealBalance);

      await wallet.zap(account, 0);
      await assertBalance(wallet, account, initialBalance);
    });
  });

  describe('REVEAL -> REDEEM/REGISTER', function () {
    before(beforeAll);
    after(afterAll);

    it('should handle normal REVEAL -> REDEEM/REGISTER', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      const winner = allWallets[0];
      const winnerAcct = DEFAULT_ACCOUNT;
      const winnerOpts = { account: DEFAULT_ACCOUNT, hardFee };
      const loser = allWallets[1];
      const loserAcct = DEFAULT_ACCOUNT;
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

      let initialLoserBalance = null;
      let afterRedeemLoserBalance = null;
      let afterRedeemLoserConfirmedBalance = null;

      let initialWinnerBalance = null;
      let afterRegisterWinnerBalance = null;
      let afterRegisterWinnerConfirmedBalance = null;

      initialLoserBalance = {
        tx: 3,
        coin: 3,
        confirmed: INIT_FUND - (hardFee * 2),
        unconfirmed: INIT_FUND - (hardFee * 2),
        clocked: loserBidAmount,
        ulocked: loserBidAmount
      };

      initialWinnerBalance = {
        ...initialLoserBalance,
        clocked: winnerBidAmount,
        ulocked: winnerBidAmount
      };

      await assertBalance(winner, winnerAcct, initialWinnerBalance);
      await assertBalance(loser, loserAcct, initialLoserBalance);

      const resource = Resource.fromJSON({ records: [] });
      await winner.sendUpdate(name, resource, winnerOpts);
      await loser.sendRedeem(name, loserOpts);

      afterRedeemLoserBalance = applyDelta(initialLoserBalance, {
        // redeem tx.
        tx: 1,
        // fund fees + reveal -> redeem + change
        coin: 0,
        // fees
        unconfirmed: -hardFee,
        // unlock bid
        ulocked: -loserBidAmount // 0
      });

      afterRegisterWinnerBalance = applyDelta(initialWinnerBalance, {
        // register tx.
        tx: 1,
        // consume REVEAL -> REGISTER (losing bid was lower) + leftover
        coin: 1,
        // consume fees.
        unconfirmed: -hardFee,
        // only lock second highest bid
        ulocked: -winnerBidAmount + loserBidAmount
      });

      await assertBalance(loser, loserAcct, afterRedeemLoserBalance);
      await assertBalance(winner, winnerAcct, afterRegisterWinnerBalance);
      await mineBlocks(1);

      // confirm above
      afterRedeemLoserConfirmedBalance = applyDelta(afterRedeemLoserBalance, {
        confirmed: -hardFee,
        clocked: -loserBidAmount
      });

      afterRegisterWinnerConfirmedBalance = applyDelta(afterRegisterWinnerBalance, {
        confirmed: -hardFee,
        clocked: -winnerBidAmount + loserBidAmount
      });

      await assertBalance(loser, loserAcct, afterRedeemLoserConfirmedBalance);
      await assertBalance(winner, winnerAcct, afterRegisterWinnerConfirmedBalance);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(loser, loserAcct, afterRedeemLoserBalance);
      await assertBalance(winner, winnerAcct, afterRegisterWinnerBalance);

      await loser.zap(loserAcct, 0);
      await winner.zap(winnerAcct, 0);
      await assertBalance(loser, loserAcct, initialLoserBalance);
      await assertBalance(winner, winnerAcct, initialWinnerBalance);
    });

    it('should handle normal REVEAL -> REDEEM/REGISTER (same amount)', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      const winner = allWallets[0];
      const winnerAcct = ALT_ACCOUNT;
      const winnerOpts = { account: winnerAcct, hardFee };
      const loser = allWallets[1];
      const loserAcct = ALT_ACCOUNT;
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

      let initialLoserBalance = null;
      let afterRedeemLoserBalance = null;
      let afterRedeemLoserConfirmedBalance = null;

      let initialWinnerBalance = null;
      let afterRegisterWinnerBalance = null;
      let afterRegisterWinnerConfirmedBalance = null;

      initialLoserBalance = {
        tx: 3,
        coin: 3,
        confirmed: INIT_FUND - (hardFee * 2),
        unconfirmed: INIT_FUND - (hardFee * 2),
        clocked: loserBidAmount,
        ulocked: loserBidAmount
      };

      initialWinnerBalance = {
        ...initialLoserBalance,
        clocked: winnerBidAmount,
        ulocked: winnerBidAmount
      };

      await assertBalance(loser, loserAcct, initialLoserBalance);
      await assertBalance(winner, winnerAcct, initialWinnerBalance);

      const resource = Resource.fromJSON({ records: [] });
      await winner.sendUpdate(name, resource, winnerOpts);
      await loser.sendRedeem(name, loserOpts);

      afterRedeemLoserBalance = applyDelta(initialLoserBalance, {
        // redeem tx.
        tx: 1,
        // fund fees + reveal -> redeem + change
        coin: 0,
        // fees
        unconfirmed: -hardFee,
        // unlock bid
        ulocked: -loserBidAmount // 0
      });

      afterRegisterWinnerBalance = applyDelta(initialWinnerBalance, {
        // register tx.
        tx: 1,
        // consume REVEAL + fundFee -> REGISTER + change.
        // This is different from above, because losing bid is the same as winning.
        coin: 0,
        // consume fees.
        unconfirmed: -hardFee,
        // only lock second highest bid
        ulocked: -winnerBidAmount + loserBidAmount
      });

      await assertBalance(loser, loserAcct, afterRedeemLoserBalance);
      await assertBalance(winner, winnerAcct, afterRegisterWinnerBalance);
      await mineBlocks(1);

      // confirm above
      afterRedeemLoserConfirmedBalance = applyDelta(afterRedeemLoserBalance, {
        confirmed: -hardFee,
        clocked: -loserBidAmount
      });

      afterRegisterWinnerConfirmedBalance = applyDelta(afterRegisterWinnerBalance, {
        confirmed: -hardFee,
        clocked: -winnerBidAmount + loserBidAmount
      });

      await assertBalance(loser, loserAcct, afterRedeemLoserConfirmedBalance);
      await assertBalance(winner, winnerAcct, afterRegisterWinnerConfirmedBalance);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(loser, loserAcct, afterRedeemLoserBalance);
      await assertBalance(winner, winnerAcct, afterRegisterWinnerBalance);

      await loser.zap(loserAcct, 0);
      await winner.zap(winnerAcct, 0);
      await assertBalance(loser, loserAcct, initialLoserBalance);
      await assertBalance(winner, winnerAcct, initialWinnerBalance);
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

      let initialBalance = null;
      let afterActionBalance = null;
      let afterActionConfirmedBalance = null;

      initialBalance = {
        tx: 4,
        // REGISTER + change
        coin: 2,
        confirmed: INIT_FUND - (hardFee * 3),
        unconfirmed: INIT_FUND - (hardFee * 3),
        ulocked: price,
        clocked: price
      };

      await assertBalance(wallet, acct, initialBalance);

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

      afterActionBalance = applyDelta(initialBalance, {
        tx: 1,
        unconfirmed: -hardFee
      });

      await assertBalance(wallet, acct, afterActionBalance);
      await mineBlocks(1);

      afterActionConfirmedBalance = applyDelta(afterActionBalance, {
        confirmed: -hardFee
      });

      await assertBalance(wallet, acct, afterActionConfirmedBalance);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, acct, afterActionBalance);

      await wallet.zap(acct, 0);
      await assertBalance(wallet, acct, initialBalance);
    };

    it('should -> UPDATE', async () => {
      await fromRegisterCheck(allWallets[0], DEFAULT_ACCOUNT, 'update');
    });

    it('should -> RENEW', async () => {
      await fromRegisterCheck(allWallets[1], DEFAULT_ACCOUNT, 'renew');
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
      const wallet = allWallets[0];
      const account = DEFAULT_ACCOUNT;
      const opts = { account, hardFee };

      await getRegisteredName(name, wallet, PRICE, opts);

      let initialBalance = null;
      let afterRevokeBalance = null;
      let afterRevokeConfirmedBalance = null;

      initialBalance = initRegBalance;

      await assertBalance(wallet, account, initialBalance);

      await wallet.sendRevoke(name, opts);

      // Revoke does not unlock coins nor remove balance, only consumes fee.
      afterRevokeBalance = applyDelta(initialBalance, {
        tx: 1,
        unconfirmed: -hardFee
      });

      await assertBalance(wallet, account, afterRevokeBalance);

      await mineBlocks(1);

      afterRevokeConfirmedBalance = applyDelta(afterRevokeBalance, {
        confirmed: -hardFee
      });

      await assertBalance(wallet, account, afterRevokeConfirmedBalance);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, account, afterRevokeBalance);

      await wallet.zap(account, 0);
      await assertBalance(wallet, account, initialBalance);
    });

    it('should TRANSFER -> FINALIZE', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet1 = allWallets[1];
      const wallet2 = allWallets[2];
      const accountw1 = DEFAULT_ACCOUNT;
      const accountw2 = DEFAULT_ACCOUNT;
      const opts = { account: accountw1, hardFee };
      const w2addr = await wallet2.receiveAddress(accountw2);

      await getRegisteredName(name, wallet1, PRICE, opts);

      // sender
      let initBalanceSender = null;
      let afterTransferBalanceSender = null;
      let afterTransferConfirmedBalanceSender = null;
      let afterFinalizeBalanceSender = null;
      let afterFinalizeConfirmedBalanceSender = null;

      // receiver
      let initBalanceRecv = null;
      let afterTransferBalanceRecv = null;
      let afterTransferConfirmedBalanceRecv = null;
      let afterFinalizeBalanceRecv = null;
      let afterFinalizeConfirmedBalanceRecv = null;

      initBalanceSender = initRegBalance;
      initBalanceRecv = INIT_BALANCE;

      await assertBalance(wallet1, accountw1, initBalanceSender);
      await assertBalance(wallet2, accountw2, initBalanceRecv);

      await wallet1.sendTransfer(name, w2addr, opts);

      afterTransferBalanceSender = applyDelta(initBalanceSender, {
        tx: 1,
        unconfirmed: -hardFee
      });

      // Transfer is still within wallet state transition.
      // Finalize is when the UTXO leaves the wallet.
      afterTransferBalanceRecv = applyDelta(initBalanceRecv, {});

      await assertBalance(wallet1, accountw1, afterTransferBalanceSender);
      await assertBalance(wallet2, accountw2, afterTransferBalanceRecv);

      // confirm
      await mineBlocks(1);
      afterTransferConfirmedBalanceSender = applyDelta(afterTransferBalanceSender, {
        confirmed: -hardFee
      });

      afterTransferConfirmedBalanceRecv = applyDelta(afterTransferBalanceRecv, {});

      await assertBalance(wallet1, accountw1, afterTransferConfirmedBalanceSender);
      await assertBalance(wallet2, accountw2, afterTransferConfirmedBalanceRecv);

      // proceed to finalize
      await mineBlocks(transferLockup);
      await wallet1.sendFinalize(name, opts);

      afterFinalizeBalanceSender = applyDelta(afterTransferConfirmedBalanceSender, {
        tx: 1,
        coin: -1,
        unconfirmed: -hardFee - PRICE,
        ulocked: -PRICE
      });

      afterFinalizeBalanceRecv = applyDelta(afterTransferConfirmedBalanceRecv, {
        tx: 1,
        coin: 1,
        unconfirmed: PRICE,
        ulocked: PRICE
      });

      await assertBalance(wallet1, accountw1, afterFinalizeBalanceSender);
      await assertBalance(wallet2, accountw2, afterFinalizeBalanceRecv);

      // confirm finalize.
      await mineBlocks(1);

      afterFinalizeConfirmedBalanceSender = applyDelta(afterFinalizeBalanceSender, {
        confirmed: -hardFee - PRICE,
        clocked: -PRICE
      });

      afterFinalizeConfirmedBalanceRecv = applyDelta(afterFinalizeBalanceRecv, {
        confirmed: PRICE,
        clocked: PRICE
      });

      await assertBalance(wallet1, accountw1, afterFinalizeConfirmedBalanceSender);
      await assertBalance(wallet2, accountw2, afterFinalizeConfirmedBalanceRecv);

      // Now let's revert.
      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet1, accountw1, afterFinalizeBalanceSender);
      await assertBalance(wallet2, accountw2, afterFinalizeBalanceRecv);

      await wallet1.zap(accountw1, 0);
      await wallet2.zap(accountw2, 0);
      await assertBalance(wallet1, accountw1, afterTransferConfirmedBalanceSender);
      await assertBalance(wallet2, accountw2, afterTransferConfirmedBalanceRecv);

      // revert transfer
      await wdb.revert(chain.tip.height - 1 - transferLockup - 1);
      await assertBalance(wallet1, accountw1, afterTransferBalanceSender);
      await assertBalance(wallet2, accountw2, afterTransferBalanceRecv);

      await wallet1.zap(accountw1, 0);
      await wallet2.zap(accountw2, 0);
      await assertBalance(wallet1, accountw1, initBalanceSender);
      await assertBalance(wallet2, accountw2, initBalanceRecv);
    });

    it('should TRANSFER -> REVOKE', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[3];
      const account = DEFAULT_ACCOUNT;
      const opts = { account, hardFee };
      const w2addr = await allWallets[4].receiveAddress(DEFAULT_ACCOUNT);

      await getRegisteredName(name, wallet, PRICE, opts);

      let initialBalance = null;
      let afterTransferBalance = null;
      let afterTransferConfirmedBalance = null;
      let afterRevokeBalance = null;
      let afterRevokeConfirmedBalance = null;

      initialBalance = initRegBalance;

      await assertBalance(wallet, account, initialBalance);

      await wallet.sendTransfer(name, w2addr, opts);

      afterTransferBalance = applyDelta(initialBalance, {
        tx: 1,
        unconfirmed: -hardFee
      });

      await assertBalance(wallet, account, afterTransferBalance);

      // confirm;
      await mineBlocks(1);

      afterTransferConfirmedBalance = applyDelta(afterTransferBalance, {
        confirmed: -hardFee
      });

      await assertBalance(wallet, account, afterTransferConfirmedBalance);

      await wallet.sendRevoke(name, opts);

      // Revoke does not unlock coins nor remove balance, only consumes fee.
      afterRevokeBalance = applyDelta(afterTransferConfirmedBalance, {
        tx: 1,
        unconfirmed: -hardFee
      });

      await assertBalance(wallet, account, afterRevokeBalance);

      await mineBlocks(1);

      afterRevokeConfirmedBalance = applyDelta(afterRevokeBalance, {
        confirmed: -hardFee
      });

      await assertBalance(wallet, account, afterRevokeConfirmedBalance);

      // revert
      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, account, afterRevokeBalance);

      await wallet.zap(account, 0);
      await assertBalance(wallet, account, afterTransferConfirmedBalance);

      await wdb.revert(chain.tip.height - 2);
      await assertBalance(wallet, account, afterTransferBalance);

      await wallet.zap(account, 0);
      await assertBalance(wallet, account, initialBalance);
    });
  });

  /*
   * From here we test cases when addresses are discovered later.
   * It could happen when account gap is lower than an actual gap.
   * It could also happen when two wallets are using same account on
   * different depths.
   *
   * Note that, in some cases NONE -> BID, BID -> REVEAL it could be
   * someone sending from the outside of the wallet and not the gap issue. (Above)
   */

  describe('NONE -> BID (missed)', function() {
    before(beforeAll);
    after(afterAll);

    // NOTE: If the transaction did not contain anything related to the wallet,
    // it would be totally missed on revert until rescan.
    it('should handle missed bid (on confirm)', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[0];
      const accountName = DEFAULT_ACCOUNT;
      const opts = { account: accountName, hardFee };
      const account = await wallet.getAccount(accountName);

      let initialBalance = null;
      let afterBidBalance = null;
      let afterBidConfirmedBalance = null;

      initialBalance = INIT_BALANCE;

      await assertBalance(wallet, accountName, initialBalance);
      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      const batchActions = [
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT],
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT]
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

      afterBidBalance = applyDelta(initialBalance, {
        tx: 1,
        // BID + CHANGE
        coin: 1,
        // unknown bid will actually spend coin from our balance.
        unconfirmed: -hardFee - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      await wallet.createReceive();
      await assertBalance(wallet, accountName, afterBidBalance);

      // derive two addresses.
      await account.receiveAddress();
      await account.receiveAddress();
      await mineBlocks(1);

      afterBidConfirmedBalance = applyDelta(afterBidBalance, {
        // we discovered coin
        coin: 1,
        // because we discovered blind, we no longer spend those coins.
        confirmed: -hardFee,
        // add newly discovered coins to unconfirmed as well.
        unconfirmed: BLIND_AMOUNT,
        // we discovered another bid is ours, so we have both locked.
        clocked: BLIND_AMOUNT * 2,
        // add newly discovered bid to ulocked.
        ulocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, accountName, afterBidConfirmedBalance);

      // after discovery it reverts normally.
      await wdb.revert(chain.tip.height - 1);

      await assertBalance(wallet, accountName, applyDelta(initialBalance, {
        // Now we know about our second bid.
        tx: 1,
        // 2 bids.
        coin: 2,
        // we only spend fee for bidding.
        unconfirmed: -hardFee,
        // we locked both blinds.
        ulocked: BLIND_AMOUNT * 2
      }));

      await wallet.zap(accountName, 0);
      await assertBalance(wallet, accountName, initialBalance);
    });

    it('should handle missed bid (on revert)', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[1];
      const accountName = DEFAULT_ACCOUNT;
      const opts = { account: accountName, hardFee };
      const account = await wallet.getAccount(accountName);
      const ahead = 10;

      // balances
      let initialBalance = null;
      let afterBidBalance = null;
      let afterBidConfirmedBalance = null;

      initialBalance = INIT_BALANCE;

      await assertBalance(wallet, accountName, initialBalance);
      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      const batchActions = [
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT],
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT]
      ];

      const bidMTX = await wallet.createBatch(batchActions, opts);
      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      const nextIndex = account.receiveDepth + account.lookahead + ahead;
      const nextAddr = account.deriveReceive(nextIndex).getAddress();
      bidMTX.outputs[1].address = nextAddr;

      for (const input of bidMTX.inputs)
        input.witness.length = 0;

      await wallet.sign(bidMTX);
      wdb.send(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());

      afterBidBalance = applyDelta(initialBalance, {
        tx: 1,
        // BID + CHANGE
        coin: 1,
        // unknown bid will actually spend coin from our balance.
        unconfirmed: -hardFee - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, accountName, afterBidBalance);

      // confirm the tx.
      await mineBlocks(1);

      afterBidConfirmedBalance = applyDelta(afterBidBalance, {
        confirmed: -hardFee - BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, accountName, afterBidConfirmedBalance);

      for (let i = 0; i < ahead; i++)
        await wallet.createReceive(accountName);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, accountName, afterBidBalance);

      await wallet.zap(accountName, 0);
      await assertBalance(wallet, accountName, initialBalance);
    });

    it('should handle missed bid (on erase)', async () => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const wallet = allWallets[2];
      const accountName = DEFAULT_ACCOUNT;
      const opts = { account: accountName, hardFee };
      const account = await wallet.getAccount(accountName);
      const ahead = 10;

      // balances
      let initialBalance = null;
      let afterBidBalance = null;
      let afterBidConfirmedBalance = null;

      initialBalance = INIT_BALANCE;

      await assertBalance(wallet, accountName, initialBalance);
      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      const batchActions = [
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT],
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT]
      ];

      const bidMTX = await wallet.createBatch(batchActions, opts);
      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      const nextIndex = account.receiveDepth + account.lookahead + ahead;
      const nextAddr = account.deriveReceive(nextIndex).getAddress();
      bidMTX.outputs[1].address = nextAddr;

      for (const input of bidMTX.inputs)
        input.witness.length = 0;

      await wallet.sign(bidMTX);
      wdb.send(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());

      afterBidBalance = applyDelta(initialBalance, {
        tx: 1,
        // BID + CHANGE
        coin: 1,
        // unknown bid will actually spend coin from our balance.
        unconfirmed: -hardFee - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, accountName, afterBidBalance);

      // confirm the tx.
      await mineBlocks(1);

      afterBidConfirmedBalance = applyDelta(afterBidBalance, {
        confirmed: -hardFee - BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      await assertBalance(wallet, accountName, afterBidConfirmedBalance);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, accountName, afterBidBalance);

      for (let i = 0; i < ahead; i++)
        await wallet.createReceive(accountName);

      await wallet.zap(accountName, 0);
      await assertBalance(wallet, accountName, initialBalance);
    });
  });
});
