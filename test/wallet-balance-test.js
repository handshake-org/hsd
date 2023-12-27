'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const FullNode = require('../lib/node/fullnode');
const WalletPlugin = require('../lib/wallet/plugin');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Output = require('../lib/primitives/output');
const {Resource} = require('../lib/dns/resource');
const {types, grindName} = require('../lib/covenants/rules');
const {forEventCondition} = require('./util/common');
const {Balance, assertBalanceEquals} = require('./util/balance');

/**
 * Wallet balance tracking tests.
 *
 * TODO:
 *  - Add CoinView support to chain <-> wallet and update input tests.
 *  - Add coin discovery on unconfirm
 *  - Add spent coin state recovery on unconfirm/confirm for pending txs.
 *  - Add spent coin state recovery on insert/insert(block) and confirm.
 */

const network = Network.get('regtest');
const mnemData = require('./data/mnemonic-english.json');

// make wallets addrs deterministic.
const phrases = mnemData.map(d => Mnemonic.fromPhrase(d[1]));

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

/**
 * @enum {Number}
 */

const DISCOVER_TYPES = {
  NONE: 0,
  BEFORE_CONFIRM: 1,
  BEFORE_UNCONFIRM: 2,
  BEFORE_ERASE: 3,
  BEFORE_BLOCK_CONFIRM: 4,
  BEFORE_BLOCK_UNCONFIRM: 5
};

const {
  NONE,
  BEFORE_CONFIRM,
  BEFORE_UNCONFIRM,
  BEFORE_ERASE,
  BEFORE_BLOCK_CONFIRM,
  BEFORE_BLOCK_UNCONFIRM
} = DISCOVER_TYPES;

const openingPeriod = treeInterval + 2;

// default gen wallets.
const WALLET_N = 5;
const GRIND_NAME_LEN = 10;

// Wallet consts
const DEFAULT_ACCOUNT = 'default';
const ALT_ACCOUNT = 'alt';

// Balances
const INIT_BLOCKS = treeInterval;
const INIT_FUND = 10e6;
const NULL_BALANCE = new Balance({
  tx: 0,
  coin: 0,
  unconfirmed: 0,
  confirmed: 0,
  ulocked: 0,
  clocked: 0
});

const INIT_BALANCE = new Balance({
  tx: 1,
  coin: 1,
  unconfirmed: INIT_FUND,
  confirmed: INIT_FUND,
  ulocked: 0,
  clocked: 0
});

const HARD_FEE = 1e4;
const SEND_AMOUNT = 2e6;
const SEND_AMOUNT_2 = 3e6;

// first is loser if it matters.
const BLIND_AMOUNT_1 = 1e6;
const BID_AMOUNT_1 = BLIND_AMOUNT_1 / 4;
const BLIND_ONLY_1 = BLIND_AMOUNT_1 - BID_AMOUNT_1;

// second is winner.
const BLIND_AMOUNT_2 = 2e6;
const BID_AMOUNT_2 = BLIND_AMOUNT_2 / 4;
const BLIND_ONLY_2 = BLIND_AMOUNT_2 - BID_AMOUNT_2;

// Loser balances for primary
const FINAL_PRICE_1 = 1e5;
const FINAL_PRICE_2 = 2e5; // less then 1e6/4 (2.5e5)

// const BLIND_AMOUNT_3 = 3e6;
// const BID_AMOUNT_3 = BLIND_AMOUNT_3 / 4;
// const BLIND_ONLY_3 = BLIND_AMOUNT_3 - BID_AMOUNT_3;

// Empty resource
const EMPTY_RS = Resource.fromJSON({ records: [] });

/*
 * Wallet helpers
 */

async function getAddrStr(wallet, acct = 0) {
  return (await wallet.receiveAddress(acct)).toString(network);
}

function getAheadAddr(account, ahead, master) {
  const nextIndex = account.receiveDepth + account.lookahead + ahead;
  const receiveKey = account.deriveReceive(nextIndex, master);
  const nextAddr = receiveKey.getAddress();

  return { nextAddr, receiveKey };
}

async function catchUpToAhead(wallet, accountName, ahead) {
  for (let i = 0; i < ahead; i++)
    await wallet.createReceive(accountName);
};

async function resign(wallet, mtx) {
  for (const input of mtx.inputs)
    input.witness.length = 0;

  await wallet.sign(mtx);
};

/*
 * Balance helpers
 */

/**
 * @returns {Promise<Balance>}
 */

async function assertRecalcBalanceEquals(wallet, accountName, expected, message) {
  await wallet.recalculateBalances();
  assertBalanceEquals(wallet, accountName, expected, message);
}

/**
 * @param {Balance} balance
 * @param {Balance} delta
 * @returns {Balance}
 */

function applyDelta(balance, delta) {
  return balance.cloneWithDelta(delta);
}

describe('Wallet Balance', function() {
  let node, chain, wdb, genWallets = WALLET_N;;

  // wallets
  // alt wallets are clones of allWallets to aid us in lookahead test.
  let primary, walletIndex, allWallets = [], cloneWallets = [];

  /*
   * Contextual helpers
   */

  const prepare = () => {
    node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [WalletPlugin],
      noDNS: true,
      noNS: true
    });

    chain = node.chain;
    wdb = node.require('walletdb').wdb;
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
    walletIndex = 0;
    primary = await wdb.get('primary');

    allWallets = [];
    cloneWallets = [];
    for (let i = 0; i < genWallets; i++) {
      const name = 'wallet' + i;
      const wallet = await wdb.create({ id: name, mnemonic: phrases[i] });
      const clone = await wdb.create({ id: name + '-alt', mnemonic: phrases[i] });
      allWallets.push(wallet);
      cloneWallets.push(clone);
    }
  };

  const fundWallets = async () => {
    await mineBlocks(INIT_BLOCKS);
    const addrs = [];

    for (let i = 0; i < genWallets; i++)
      addrs.push(await getAddrStr(allWallets[i], DEFAULT_ACCOUNT));

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

  const getNextWallet = (index) => {
    const i = index ? index : walletIndex++;

    if (!allWallets[i])
      throw new Error('There are not enough wallets, can not get at index: ' + i);

    return {
      index: i,
      wallet: allWallets[i],
      wid: allWallets[i].id,
      clone: cloneWallets[i],
      cloneWID: cloneWallets[i].id,
      opts: {
        account: DEFAULT_ACCOUNT,
        hardFee: HARD_FEE
      }
    };
  };

  const forWTX = (id, hash) => {
    return forEventCondition(wdb, 'tx', (wallet, tx) => {
      return wallet.id === id && tx.hash().equals(hash);
    });
  };

  /*
   * beforeall and afterall for each describe
   */

  const beforeAll = async () => {
    prepare();

    await node.open();
    await setupWallets();
    await fundWallets();
  };

  const afterAll = async () => {
    await node.close();
    node = null;

    // reduce time of the tests.
    if (walletIndex !== genWallets)
      console.log(`Leftover wallets, used: ${walletIndex} of ${genWallets}.`);

    genWallets = WALLET_N;
  };

  /*
   * Balance testing steps.
   */

  /**
   * @callback BalanceCheckFunction
   * @param {Wallet} wallet
   * @param {Wallet} clone
   * @param {Number} ahead
   * @param {Object} [opts]
   */

  /**
   * @typedef {Object} TestBalances
   * @property {Balance} TestBalances.initialBalance
   * @property {Balance} TestBalances.sentBalance
   * @property {Balance} TestBalances.confirmedBalance
   * @property {Balance} TestBalances.unconfirmedBalance
   * @property {Balance} TestBalances.eraseBalance
   * @property {Balance} TestBalances.blockConfirmedBalance
   * @property {Balance} TestBalances.blockUnconfirmedBalance
   * @property {Balance} [TestBalances.blockFinalConfirmedBalance]
   */

  /**
   * @typedef {Object} CheckFunctions
   * @property {BalanceCheckFunction} CheckFunctions.initCheck
   * @property {BalanceCheckFunction} CheckFunctions.sentCheck
   * @property {BalanceCheckFunction} CheckFunctions.confirmedCheck
   * @property {BalanceCheckFunction} CheckFunctions.unconfirmedCheck
   * @property {BalanceCheckFunction} CheckFunctions.eraseCheck
   * @property {BalanceCheckFunction} CheckFunctions.blockConfirmCheck
   * @property {BalanceCheckFunction} CheckFunctions.blockUnconfirmCheck
   * @property {BalanceCheckFunction} CheckFunctions.blockFinalConfirmCheck
   */

  /**
   * @callback BalanceTestFunction
   * @param {CheckFunctions} checks
   * @param {BalanceCheckFunction} discoverFn
   * @param {DISCOVER_TYPES} discoverAt
   * @param {Object} opts
   */

  /**
   * Supports missing address/discoveries at certain points.
   * @param {BalanceCheckFunction} [setupFn]
   * @param {BalanceCheckFunction} receiveFn
   * @param {Number} ahead
   * @returns {BalanceTestFunction}
   */

  const balanceTest = (setupFn, receiveFn, ahead) => {
    return async (checks, discoverFn, discoverAt, opts = {}) => {
      const {wallet, clone} = getNextWallet();

      if (setupFn)
        await setupFn(wallet, clone, ahead, opts);

      await checks.initCheck(wallet, ahead, opts);

      await receiveFn(wallet, clone, ahead, opts);
      await checks.sentCheck(wallet, ahead, opts);

      if (discoverAt === BEFORE_CONFIRM)
        await discoverFn(wallet, ahead, opts);

      await mineBlocks(1);
      await checks.confirmedCheck(wallet, ahead, opts);

      // now unconfirm
      if (discoverAt === BEFORE_UNCONFIRM)
        await discoverFn(wallet, ahead, opts);

      await wdb.revert(chain.tip.height - 1);
      await checks.unconfirmedCheck(wallet, ahead, opts);

      // now erase
      if (discoverAt === BEFORE_ERASE)
        await discoverFn(wallet, ahead, opts);

      await wallet.zap(-1, 0);
      await checks.eraseCheck(wallet, ahead, opts);

      if (discoverAt === BEFORE_BLOCK_CONFIRM)
        await discoverFn(wallet, ahead, opts);

      // Final look at full picture.
      await wdb.rescan(chain.tip.height - 1);
      await checks.blockConfirmCheck(wallet, ahead, opts);

      if (discoverAt === BEFORE_BLOCK_UNCONFIRM)
        await discoverFn(wallet, ahead, opts);

      // Unconfirm
      await wdb.revert(chain.tip.height - 1);
      await checks.blockUnconfirmCheck(wallet, ahead, opts);

      // Clean up wallet.
      await wdb.rescan(chain.tip.height - 1);
      await checks.blockFinalConfirmCheck(wallet, ahead, opts);
    };
  };

  const BALANCE_CHECK_MAP = {
    initCheck: ['initialBalance', 'Initial'],
    sentCheck: ['sentBalance', 'Sent'],
    confirmedCheck: ['confirmedBalance', 'Confirmed'],
    unconfirmedCheck: ['unconfirmedBalance', 'Unconfirmed'],
    eraseCheck: ['eraseBalance', 'Erase'],
    blockConfirmCheck: ['blockConfirmedBalance', 'Block confirmed'],
    blockUnconfirmCheck: ['blockUnconfirmedBalance', 'Block unconfirmed'],
    blockFinalConfirmCheck: ['blockFinalConfirmedBalance', 'Block final confirmed']
  };

  /**
   * Check also wallet, default and alt account balances.
   * @param {TestBalances} walletBalances
   * @param {TestBalances} [defBalances] - default account
   * @param {TestBalances} [altBalances] - alt account balances
   * @returns {CheckFunctions}
   */

  const checkBalances = (walletBalances, defBalances, altBalances) => {
    const checks = {};

    if (defBalances == null)
      defBalances = walletBalances;

    for (const [key, [balanceName, name]] of Object.entries(BALANCE_CHECK_MAP)) {
      checks[key] = async (wallet) => {
        await assertBalanceEquals(
          wallet,
          DEFAULT_ACCOUNT,
          defBalances[balanceName],
          `${name} balance is incorrect in the account ${DEFAULT_ACCOUNT}.`
        );

        await assertRecalcBalanceEquals(
          wallet,
          DEFAULT_ACCOUNT,
          defBalances[balanceName],
          `${name} balance is incorrect `
            + `after recalculation in the account ${DEFAULT_ACCOUNT}.`
        );

        if (altBalances != null) {
          await assertBalanceEquals(
            wallet,
            ALT_ACCOUNT,
            altBalances[balanceName],
            `${name} balance is incorrect in the account ${ALT_ACCOUNT}.`
          );

          await assertRecalcBalanceEquals(
            wallet,
            ALT_ACCOUNT,
            altBalances[balanceName],
            `${name} balance is incorrect `
            + `after recalculation in the account ${ALT_ACCOUNT}.`
          );
        }

        await assertBalanceEquals(
          wallet,
          -1,
          walletBalances[balanceName],
          `${name} balance is incorrect for the wallet.`
        );

        await assertRecalcBalanceEquals(
          wallet,
          -1,
          walletBalances[balanceName],
          `${name} balance is incorrect `
          + 'after recalculate for the wallet.'
        );
      };
    }

    return checks;
  };

  const combineBalances = (undiscovered, discovered, discoverAt) => {
    if (Array.isArray(undiscovered) && Array.isArray(discovered)) {
      const combined = [];

      for (let i = 0; i < undiscovered.length; i++)
        combined.push(combineBalances(undiscovered[i], discovered[i], discoverAt));

      return combined;
    }

    const balances = { ...undiscovered };

    if (balances.blockFinalConfirmedBalance == null)
      balances.blockFinalConfirmedBalance = balances.blockConfirmedBalance;

    switch (discoverAt) {
      case BEFORE_CONFIRM:
        balances.confirmedBalance = discovered.confirmedBalance;
      case BEFORE_UNCONFIRM:
        balances.unconfirmedBalance = discovered.unconfirmedBalance;
      case BEFORE_ERASE:
      case BEFORE_BLOCK_CONFIRM:
        balances.blockConfirmedBalance = discovered.blockConfirmedBalance;
      case BEFORE_BLOCK_UNCONFIRM:
        balances.blockUnconfirmedBalance = discovered.blockUnconfirmedBalance;
        balances.blockFinalConfirmedBalance = discovered.blockConfirmedBalance;
      case NONE:
      default:
    }

    return balances;
  };

  const defDiscover = async (wallet, ahead) => {
    await catchUpToAhead(wallet, DEFAULT_ACCOUNT, ahead);
  };

  const altDiscover = async (wallet, ahead) => {
    await catchUpToAhead(wallet, ALT_ACCOUNT, ahead);
  };

  const genTests = (options) => {
    const {
      name,
      undiscovered,
      discovered,
      tester,
      discoverer
    } = options;

    const genTestBody = (type) => {
      // three balances including alt are different.
      if (Array.isArray(undiscovered)) {
        return async () => {
          const balances = combineBalances(undiscovered, discovered, type);
          await tester(checkBalances(balances[0], balances[1], balances[2]), discoverer, type);
        };
      }
      return async () => {
        const balances = combineBalances(undiscovered, discovered, type);
        await tester(checkBalances(balances), discoverer, type);
      };
    };

    it(`${name} (no discovery)`, genTestBody(NONE));
    it(`${name}, discover on confirm`, genTestBody(BEFORE_CONFIRM));
    it(`${name}, discover on unconfirm`, genTestBody(BEFORE_UNCONFIRM));
    it(`${name}, discover on erase`, genTestBody(BEFORE_ERASE));
    it(`${name}, discover on block confirm`, genTestBody(BEFORE_CONFIRM));
    it(`${name}, discover on block unconfirm`, genTestBody(BEFORE_ERASE));
  };

  /**
   * One to normal address.
   * One in the future address
   * These functions accumulate:
   *   fees: 1 + 1 + 1?
   *   coins: 2 + 1 + 1?
   *   tx: 1 + 1 + 1?
   *
   * Missing 1 register.
   */

  const INIT_REGISTERED_BALANCE = applyDelta(INIT_BALANCE, {
    tx: 3,
    coin: 3,

    // missing second FINAL_PRICE_2 register.
    confirmed: -(HARD_FEE * 3) - FINAL_PRICE_2,
    unconfirmed: -(HARD_FEE * 3) - FINAL_PRICE_2,

    clocked: FINAL_PRICE_1,
    ulocked: FINAL_PRICE_1
  });

  const setupTwoRegisteredNames = async (wallet, ahead, register = true) => {
    const name1 = grindName(GRIND_NAME_LEN, chain.tip.height, network);
    const name2 = grindName(GRIND_NAME_LEN, chain.tip.height, network);

    const account = await wallet.getAccount(DEFAULT_ACCOUNT);
    const {nextAddr} = getAheadAddr(account, ahead);

    await primary.sendBatch([
      ['OPEN', name1],
      ['OPEN', name2]
    ]);
    await mineBlocks(openingPeriod);

    const txOpts = { hardFee: HARD_FEE };

    // all three bids are there.
    const bidMTX = await wallet.createBatch([
      ['BID', name1, BID_AMOUNT_1, BLIND_AMOUNT_1],
      ['BID', name2, BID_AMOUNT_2, BLIND_AMOUNT_2]
    ], txOpts);

    assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
    assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

    bidMTX.outputs[1].address = nextAddr;
    await resign(wallet, bidMTX);

    // make sure clone knows ahead addrs.
    await defDiscover(wallet, ahead * 2);

    await node.mempool.addTX(bidMTX.toTX());

    await mineBlocks(1);

    assert(FINAL_PRICE_1 <= BID_AMOUNT_1);
    assert(FINAL_PRICE_2 <= BID_AMOUNT_2);

    // primary will lose
    await primary.sendBid(name1, FINAL_PRICE_1, INIT_FUND);
    await primary.sendBid(name2, FINAL_PRICE_2, INIT_FUND);

    await mineBlocks(biddingPeriod - 1);

    await primary.sendReveal(name1);
    await primary.sendReveal(name2);

    await wallet.sendBatch([
      ['REVEAL', name1],
      ['REVEAL', name2]
    ], txOpts);

    await mineBlocks(revealPeriod);

    if (register !== false) {
      await wallet.sendBatch([
        ['UPDATE', name1, EMPTY_RS],
        ['UPDATE', name2, EMPTY_RS]
      ], {
        hardFee: HARD_FEE
      });

      await mineBlocks(1);
    }

    return [name1, name2];
  };

  describe('NONE -> NONE* (normal receive)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    const receive = async (wallet, clone, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const {nextAddr} = getAheadAddr(account, ahead);

      // Send one to the normal address
      // Send another one to the gapped/missed adress
      await primary.send({
        outputs: [{
          address: recvAddr,
          value: SEND_AMOUNT
        }, {
          address: nextAddr,
          value: SEND_AMOUNT_2
        }]
      });
    };

    // account.lookahead + AHEAD
    const AHEAD = 10;
    const testReceive = balanceTest(null, receive, AHEAD);

    // Balances if we did not discover
    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: 1,
      unconfirmed: SEND_AMOUNT
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: SEND_AMOUNT
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.sentBalance;

    // Balances if we discovered from the beginning
    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: SEND_AMOUNT + SEND_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: SEND_AMOUNT + SEND_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.sentBalance;

    genTests({
      name: 'should handle normal receive',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testReceive,
      discoverer: defDiscover
    });
  });

  describe('NONE* -> NONE (spend our credits)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 1;
      return beforeAll();
    });

    after(afterAll);

    let coins, nextAddr, receiveKey;

    const setupTXFromFuture = async (wallet, clone, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const aheadAddr = getAheadAddr(account, ahead, wallet.master);
      nextAddr = aheadAddr.nextAddr;
      receiveKey = aheadAddr.receiveKey;

      // Create transaction that creates two coins:
      //  1. normal coin
      //  2. one gapped/missed coin
      const fundTX = await primary.send({
        sort: false,
        outputs: [{
          address: recvAddr,
          value: SEND_AMOUNT
        }, {
          address: nextAddr,
          value: SEND_AMOUNT + HARD_FEE
        }]
      });

      await mineBlocks(1);

      coins = [
        Coin.fromTX(fundTX, 0, chain.tip.height),
        Coin.fromTX(fundTX, 1, chain.tip.height)
      ];
    };

    const receive = async (wallet) => {
      const outAddr = await primary.receiveAddress();
      const changeAddr = await wallet.changeAddress();

      // spend both coins in one tx.
      const mtx = new MTX();

      mtx.addOutput(new Output({
        address: outAddr,
        value: SEND_AMOUNT * 2
      }));

      // HARD_FEE is paid by gapped/missed coin.
      await mtx.fund(coins, {
        hardFee: HARD_FEE,
        changeAddress: changeAddr
      });

      await wallet.sign(mtx);
      await mtx.signAsync(receiveKey);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const test = balanceTest(setupTXFromFuture, receive, AHEAD);

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
      tx: 1,
      coin: 1,
      confirmed: SEND_AMOUNT,
      unconfirmed: SEND_AMOUNT
    });

    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: -1,
      unconfirmed: -SEND_AMOUNT
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -SEND_AMOUNT
    });

    UNDISCOVERED.unconfirmedBalance = applyDelta(UNDISCOVERED.confirmedBalance, {
      confirmed: SEND_AMOUNT
    });

    UNDISCOVERED.eraseBalance = applyDelta(UNDISCOVERED.unconfirmedBalance, {
      tx: -1,
      coin: 1,
      unconfirmed: SEND_AMOUNT
    });

    UNDISCOVERED.blockConfirmedBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: -1,
      confirmed: -SEND_AMOUNT,
      unconfirmed: -SEND_AMOUNT
    });

    UNDISCOVERED.blockUnconfirmedBalance = applyDelta(UNDISCOVERED.blockConfirmedBalance, {
      confirmed: SEND_AMOUNT
    });

    UNDISCOVERED.blockFinalConfirmedBalance = UNDISCOVERED.blockConfirmedBalance;

    it('should spend normal credit (no discovery)', async () => {
      const balances = UNDISCOVERED;

      await test(
        checkBalances(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it.skip('should spend credit, discover before confirm', async () => {
      // TODO: Implement with coinview update.
      // This will be no different than normal credit spend if
      // we don't receive CoinView from the chain. So skip this until we
      // have that feature.
    });

    // We don't have any details about inputs, so it's not possible to recover them.
    // it('should spend credit, discover before unconfirm', async () => {});
    // it('should spend credit, discover before erase', async () => {});

    it.skip('should spend credit, discover before block confirm', async () => {
      // This will be no different than normal credit spend if
      // we don't receive CoinView from the chain. So skip this until we
      // have that feature.
    });

    // We don't have any details about inputs, so it's not possible to recover them.
    // it('should spend credit, discover on block unconfirm', async () => { });
  });

  describe('NONE* -> NONE* (receive and spend in pending)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    const receive = async (wallet, clone, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const aheadAddr = getAheadAddr(account, ahead, wallet.master);
      const nextAddr = aheadAddr.nextAddr;
      const receiveKey = aheadAddr.receiveKey;

      // Create transaction that creates two coins:
      //  1. normal coin
      //  2. one gapped/missed coin
      const fundTX = await primary.send({
        sort: false,
        outputs: [{
          address: recvAddr,
          value: SEND_AMOUNT
        }, {
          address: nextAddr,
          value: SEND_AMOUNT + HARD_FEE
        }]
      });

      const coins = [
        Coin.fromTX(fundTX, 0, chain.tip.height),
        Coin.fromTX(fundTX, 1, chain.tip.height)
      ];

      const outAddr = await primary.receiveAddress();
      const changeAddr = await wallet.changeAddress();

      // spend both coins in one tx.
      const mtx = new MTX();

      mtx.addOutput(new Output({
        address: outAddr,
        value: SEND_AMOUNT * 2
      }));

      // HARD_FEE is paid by gapped/missed coin.
      await mtx.fund(coins, {
        hardFee: HARD_FEE,
        changeAddress: changeAddr
      });

      await wallet.sign(mtx);
      await mtx.signAsync(receiveKey);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const test = balanceTest(null, receive, AHEAD);

    // Balances.
    const UNDISCOVERED = {};

    // For this test, the balances are same for all the test cases,
    // but for different reasons.
    UNDISCOVERED.initialBalance = INIT_BALANCE;

    // We receive 2 transactions (receiving one and spending one)
    // But we spend discovered output right away.
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 2,
      coin: 0,
      unconfirmed: 0
    });

    // Nothing changes for confirmed either. (Coins are spent in pending)
    UNDISCOVERED.confirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.confirmedBalance;

    // We no longer have two txs.
    UNDISCOVERED.eraseBalance = applyDelta(UNDISCOVERED.unconfirmedBalance, { tx: -2 });
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should spend credit',
      undiscovered: UNDISCOVERED,
      discovered: UNDISCOVERED,
      tester: test,
      discoverer: defDiscover
    });
  });

  describe('NONE -> OPEN', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 1;
      return beforeAll();
    });

    after(afterAll);

    const sendOpen = async (wallet) => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await wallet.sendOpen(name, {
        hardFee: HARD_FEE
      });
    };

    const testOpen = balanceTest(null, sendOpen, 0);

    it('should handle open', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;

      // TODO: Should 0 value outs be counted towards coin and stored in coin set?
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: -HARD_FEE
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE
      });

      // TODO: Should 0 value outs be counted towards coin and stored in coin set?
      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE
      });

      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;
      balances.blockFinalConfirmedBalance = balances.blockConfirmedBalance;

      await testOpen(
        checkBalances(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });
  });

  /*
   * Lock balances
   */

  describe('NONE -> BID* (normal receive)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    const setupBidName = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendNormalBid = async (wallet, clone, ahead) => {
      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const {nextAddr} = getAheadAddr(account, ahead);
      const txOpts = { hardFee: HARD_FEE };

      const bidMTX = await wallet.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);
      bidMTX.outputs[1].address = nextAddr;

      await resign(wallet, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const testBidReceive = balanceTest(setupBidName, sendNormalBid, AHEAD);

    // Balances if second BID was undiscovered.
    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      // We have additional coin because: output -> BID + Change
      // Additional BID is undiscovered.
      coin: 1,
      // Bid we are not aware of is seen as spent.
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    // Balances if second BID was discovered right away.
    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      // Bid we are not aware of is seen as spent.
      unconfirmed: -HARD_FEE,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should receive bid',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testBidReceive,
      discoverer: defDiscover
    });
  });

  describe('NONE -> BID* (foreign bid)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    const setupBidName = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendForeignBid = async (wallet, clone, ahead) => {
      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const recvAddr = await wallet.receiveAddress();
      const {nextAddr} = getAheadAddr(account, ahead);
      const txOpts = { hardFee: HARD_FEE };

      const bidMTX = await primary.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      bidMTX.outputs[0].address = recvAddr;
      bidMTX.outputs[1].address = nextAddr;

      await resign(primary, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const testForeign = balanceTest(setupBidName, sendForeignBid, AHEAD);

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      // only BID
      coin: 1,
      // We did not own this money before
      unconfirmed: BLIND_AMOUNT_1,
      ulocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: BLIND_AMOUNT_1,
      clocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.sentBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.sentBalance;

    genTests({
      name: 'should receive foreign bid',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testForeign,
      discoverer: defDiscover
    });
  });

  describe('NONE -> BID* (cross acct)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name;
    const setupAcctAndBidName = async (wallet) => {
      await wallet.createAccount({
        name: ALT_ACCOUNT
      });

      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendCrossAcct = async (wallet, clone, ahead) => {
      const txOpts = { hardFee: HARD_FEE };
      const altAccount = await wallet.getAccount(ALT_ACCOUNT);

      // not actually next, we test normal recive.
      const addr1 = getAheadAddr(altAccount, -altAccount.lookahead);
      const addr2 = getAheadAddr(altAccount, ahead);

      const bidMTX = await wallet.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      bidMTX.outputs[0].address = addr1.nextAddr;
      // future tx.
      bidMTX.outputs[1].address = addr2.nextAddr;

      await resign(wallet, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const testCrossAcctBalance = balanceTest(setupAcctAndBidName, sendCrossAcct, AHEAD);

    const UNDISCOVERED_WALLET = {};
    const UNDISCOVERED_DEFAULT = {};
    const UNDISCOVERED_ALT = {};

    UNDISCOVERED_WALLET.initialBalance = INIT_BALANCE;
    UNDISCOVERED_DEFAULT.initialBalance = INIT_BALANCE;
    UNDISCOVERED_ALT.initialBalance = NULL_BALANCE;

    // sent from default to alt, default account does not lock
    UNDISCOVERED_DEFAULT.sentBalance = applyDelta(UNDISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      // output -> change output + 2 BIDs to alt
      coin: 0,
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    // alt account balance locks unconfirmed and receives coin.
    UNDISCOVERED_ALT.sentBalance = applyDelta(UNDISCOVERED_ALT.initialBalance, {
      tx: 1,
      // received BID + missed BID.
      coin: 1,
      unconfirmed: BLIND_AMOUNT_1,
      ulocked: BLIND_AMOUNT_1
    });

    // Wallet only spends FEE
    UNDISCOVERED_WALLET.sentBalance = applyDelta(UNDISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // Total coins is: output -> BID output + CHANGE + Undiscovered BID
      coin: 1,
      // for now another bid just out transaction.
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1
    });

    // NOW CONFIRM
    UNDISCOVERED_DEFAULT.confirmedBalance = applyDelta(UNDISCOVERED_DEFAULT.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_ALT.confirmedBalance = applyDelta(UNDISCOVERED_ALT.sentBalance, {
      confirmed: BLIND_AMOUNT_1,
      clocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED_WALLET.confirmedBalance = applyDelta(UNDISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1
    });

    // NOW Unconfirm again
    UNDISCOVERED_DEFAULT.unconfirmedBalance = UNDISCOVERED_DEFAULT.sentBalance;
    UNDISCOVERED_ALT.unconfirmedBalance = UNDISCOVERED_ALT.sentBalance;
    UNDISCOVERED_WALLET.unconfirmedBalance = UNDISCOVERED_WALLET.sentBalance;

    // NOW Erase
    UNDISCOVERED_WALLET.eraseBalance = UNDISCOVERED_WALLET.initialBalance;
    UNDISCOVERED_DEFAULT.eraseBalance = UNDISCOVERED_DEFAULT.initialBalance;
    UNDISCOVERED_ALT.eraseBalance = UNDISCOVERED_ALT.initialBalance;

    UNDISCOVERED_WALLET.blockConfirmedBalance = UNDISCOVERED_WALLET.confirmedBalance;
    UNDISCOVERED_DEFAULT.blockConfirmedBalance = UNDISCOVERED_DEFAULT.confirmedBalance;
    UNDISCOVERED_ALT.blockConfirmedBalance = UNDISCOVERED_ALT.confirmedBalance;

    UNDISCOVERED_WALLET.blockUnconfirmedBalance = UNDISCOVERED_WALLET.unconfirmedBalance;
    UNDISCOVERED_DEFAULT.blockUnconfirmedBalance = UNDISCOVERED_DEFAULT.unconfirmedBalance;
    UNDISCOVERED_ALT.blockUnconfirmedBalance = UNDISCOVERED_ALT.unconfirmedBalance;

    // Now DISCOVERED PART
    const DISCOVERED_WALLET = {};
    const DISCOVERED_DEFAULT = {};
    const DISCOVERED_ALT = {};

    DISCOVERED_WALLET.initialBalance = UNDISCOVERED_WALLET.initialBalance;
    DISCOVERED_DEFAULT.initialBalance = UNDISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_ALT.initialBalance = UNDISCOVERED_ALT.initialBalance;

    // sent from default to alt, default account does not lock
    DISCOVERED_DEFAULT.sentBalance = applyDelta(DISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      coin: 0,
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    // alt account balance locks unconfirmed and receives coin.
    DISCOVERED_ALT.sentBalance = applyDelta(DISCOVERED_ALT.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // Wallet only spends FEE
    DISCOVERED_WALLET.sentBalance = applyDelta(DISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // Total coins is: output -> BID output + BID output + CHANGE
      coin: 2,
      unconfirmed: -HARD_FEE,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // NOW CONFIRM
    DISCOVERED_DEFAULT.confirmedBalance = applyDelta(DISCOVERED_DEFAULT.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    DISCOVERED_ALT.confirmedBalance = applyDelta(DISCOVERED_ALT.sentBalance, {
      confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED_WALLET.confirmedBalance = applyDelta(DISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // NOW Unconfirm again
    DISCOVERED_DEFAULT.unconfirmedBalance = DISCOVERED_DEFAULT.sentBalance;
    DISCOVERED_ALT.unconfirmedBalance = DISCOVERED_ALT.sentBalance;
    DISCOVERED_WALLET.unconfirmedBalance = DISCOVERED_WALLET.sentBalance;

    // NOW Erase
    DISCOVERED_WALLET.eraseBalance = DISCOVERED_WALLET.initialBalance;
    DISCOVERED_DEFAULT.eraseBalance = DISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_ALT.eraseBalance = DISCOVERED_ALT.initialBalance;

    DISCOVERED_WALLET.blockConfirmedBalance = DISCOVERED_WALLET.confirmedBalance;
    DISCOVERED_DEFAULT.blockConfirmedBalance = DISCOVERED_DEFAULT.confirmedBalance;
    DISCOVERED_ALT.blockConfirmedBalance = DISCOVERED_ALT.confirmedBalance;

    DISCOVERED_WALLET.blockUnconfirmedBalance = DISCOVERED_WALLET.unconfirmedBalance;
    DISCOVERED_DEFAULT.blockUnconfirmedBalance = DISCOVERED_DEFAULT.unconfirmedBalance;
    DISCOVERED_ALT.blockUnconfirmedBalance = DISCOVERED_ALT.unconfirmedBalance;

    genTests({
      name: 'should send/receive bid cross acct',
      undiscovered: [UNDISCOVERED_WALLET, UNDISCOVERED_DEFAULT, UNDISCOVERED_ALT],
      discovered: [DISCOVERED_WALLET, DISCOVERED_DEFAULT, DISCOVERED_ALT],
      tester: testCrossAcctBalance,
      discoverer: altDiscover
    });
  });

  describe('BID* -> REVEAL*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name = null;

    const setupBidName = async (wallet, clone, ahead) => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const txOpts = { hardFee: HARD_FEE };

      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const next = getAheadAddr(account, ahead, wallet.master);
      const {nextAddr} = next;

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      const bidMTX = await clone.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);
      bidMTX.outputs[1].address = nextAddr;

      await resign(clone, bidMTX);

      // Make sure we discover everything
      await defDiscover(clone, ahead * 2);

      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
      await mineBlocks(biddingPeriod);
    };

    const sendReveal = async (wallet, clone, ahead) => {
      await clone.sendReveal(name, {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testReveal = balanceTest(setupBidName, sendReveal, AHEAD);

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
      tx: 1,
      // out = BID + Unknown BID + CHANGE
      coin: 1,

      // one bid is unknown
      confirmed: -HARD_FEE - BLIND_AMOUNT_2,
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,

      // one bid is unknown
      clocked: BLIND_AMOUNT_1,
      ulocked: BLIND_AMOUNT_1
    });

    // Now we receive REVEAL - which frees BLIND and only locks bid amount.
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      // extra coin from Change
      coin: 1,
      // We recover BLIND_ONLY from the unknown BID via change.
      unconfirmed: BLIND_ONLY_2 - HARD_FEE,
      ulocked: -BLIND_ONLY_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: BLIND_ONLY_2 - HARD_FEE,
      clocked: -BLIND_ONLY_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;

    // Now we receive REVEAL - which frees BLIND and only locks bid amount.
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: BLIND_AMOUNT_2 - HARD_FEE,
      ulocked: BID_AMOUNT_2 - BLIND_ONLY_1
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: BLIND_AMOUNT_2 - HARD_FEE,
      clocked: BID_AMOUNT_2 - BLIND_ONLY_1
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should send/receive reveal',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testReveal,
      discoverer: defDiscover
    });
  });

  describe('BID* -> REVEAL* (cross acct)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name;

    // This will create BID tx in the first account.
    // two bids belong to the default account.
    const setupRevealName = async (wallet) => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await wallet.createAccount({
        name: ALT_ACCOUNT
      });
      const txOpts = { hardFee: HARD_FEE };

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      await wallet.sendBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);
      await mineBlocks(biddingPeriod);
    };

    // Now we sent two REVEALs to second account (one seen, one missed)
    const sendReveal = async (wallet, clone, ahead) => {
      const altAccount = await wallet.getAccount(ALT_ACCOUNT);
      const recv = getAheadAddr(altAccount, -altAccount.lookahead);
      const next = getAheadAddr(altAccount, ahead);

      const revealMTX = await wallet.createReveal(name, {
        hardFee: HARD_FEE
      });
      assert.strictEqual(revealMTX.outputs[0].covenant.type, types.REVEAL);
      assert.strictEqual(revealMTX.outputs[1].covenant.type, types.REVEAL);
      revealMTX.outputs[0].address = recv.nextAddr;
      revealMTX.outputs[1].address = next.nextAddr;

      await resign(wallet, revealMTX);
      node.mempool.addTX(revealMTX.toTX());
      await forWTX(wallet.id, revealMTX.hash());
    };

    const AHEAD = 10;
    const testCrossActReveal = balanceTest(setupRevealName, sendReveal, AHEAD);

    /*
     * Balances if we never discovered missing.
     */

    const UNDISCOVERED_WALLET = {};
    const UNDISCOVERED_DEFAULT = {};
    const UNDISCOVERED_ALT = {};

    // we start with BID transaction
    UNDISCOVERED_WALLET.initialBalance = applyDelta(INIT_BALANCE, {
      tx: 1,

      // we have two bids at the start.
      coin: 2,

      confirmed: -HARD_FEE,
      unconfirmed: -HARD_FEE,

      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // same as wallet at this stage.
    UNDISCOVERED_DEFAULT.initialBalance = UNDISCOVERED_WALLET.initialBalance;
    // empty at the start.
    UNDISCOVERED_ALT.initialBalance = NULL_BALANCE;

    // After REVEAL Transaction
    UNDISCOVERED_WALLET.sentBalance = applyDelta(UNDISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // extra coin from change.
      // but one reveal becomes missed.
      coin: 0,

      // We only lose reveal amount, diff is going into our change
      unconfirmed: -BID_AMOUNT_2 - HARD_FEE,
      // We also unlock missed bid->reveal,
      // but totally unlock missed one.
      ulocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
    });

    // does not change
    UNDISCOVERED_DEFAULT.sentBalance = applyDelta(UNDISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      // 2 BIDS -> 1 Change + out 2 reveals
      coin: -1,

      unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_ALT.sentBalance = applyDelta(UNDISCOVERED_ALT.initialBalance, {
      tx: 1,
      // we received 1 reveal (another is unknown)
      coin: 1,

      unconfirmed: BID_AMOUNT_1,
      ulocked: BID_AMOUNT_1
    });

    // Now we confirm everything seen above.
    UNDISCOVERED_WALLET.confirmedBalance = applyDelta(UNDISCOVERED_WALLET.sentBalance, {
      confirmed: -BID_AMOUNT_2 - HARD_FEE,
      clocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_DEFAULT.confirmedBalance = applyDelta(UNDISCOVERED_DEFAULT.sentBalance, {
      confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_ALT.confirmedBalance = applyDelta(UNDISCOVERED_ALT.sentBalance, {
      confirmed: BID_AMOUNT_1,
      clocked: BID_AMOUNT_1
    });

    UNDISCOVERED_WALLET.unconfirmedBalance = UNDISCOVERED_WALLET.sentBalance;
    UNDISCOVERED_DEFAULT.unconfirmedBalance = UNDISCOVERED_DEFAULT.sentBalance;
    UNDISCOVERED_ALT.unconfirmedBalance = UNDISCOVERED_ALT.sentBalance;

    // Erase
    UNDISCOVERED_WALLET.eraseBalance = UNDISCOVERED_WALLET.initialBalance;
    UNDISCOVERED_DEFAULT.eraseBalance = UNDISCOVERED_DEFAULT.initialBalance;
    UNDISCOVERED_ALT.eraseBalance = UNDISCOVERED_ALT.initialBalance;

    // Confirm in block
    UNDISCOVERED_WALLET.blockConfirmedBalance = UNDISCOVERED_WALLET.confirmedBalance;
    UNDISCOVERED_DEFAULT.blockConfirmedBalance = UNDISCOVERED_DEFAULT.confirmedBalance;
    UNDISCOVERED_ALT.blockConfirmedBalance = UNDISCOVERED_ALT.confirmedBalance;

    // Unconfirm in block
    UNDISCOVERED_WALLET.blockUnconfirmedBalance = UNDISCOVERED_WALLET.unconfirmedBalance;
    UNDISCOVERED_DEFAULT.blockUnconfirmedBalance = UNDISCOVERED_DEFAULT.unconfirmedBalance;
    UNDISCOVERED_ALT.blockUnconfirmedBalance = UNDISCOVERED_ALT.unconfirmedBalance;

    /*
     * Balances if we had discovered it right away.
     */

    const DISCOVERED_WALLET = {};
    const DISCOVERED_DEFAULT = {};
    const DISCOVERED_ALT = {};

    DISCOVERED_WALLET.initialBalance = UNDISCOVERED_WALLET.initialBalance;;
    // same as wallet at this stage.
    DISCOVERED_DEFAULT.initialBalance = UNDISCOVERED_DEFAULT.initialBalance;
    // empty at the start.
    DISCOVERED_ALT.initialBalance = UNDISCOVERED_ALT.initialBalance;

    // After REVEAL Transaction
    DISCOVERED_WALLET.sentBalance = applyDelta(DISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // extra change introduce by reveal tx.
      coin: 1,

      unconfirmed: -HARD_FEE,
      // unlock blinds, only BID are left locked.
      ulocked: -BLIND_ONLY_1 - BLIND_ONLY_2
    });

    // does not change
    DISCOVERED_DEFAULT.sentBalance = applyDelta(DISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      // 2 BIDS -> 1 Change + out 2 reveals
      coin: -1,

      unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    DISCOVERED_ALT.sentBalance = applyDelta(DISCOVERED_ALT.initialBalance, {
      tx: 1,
      // we received 2 reveal
      coin: 2,

      unconfirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      ulocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    // Now we confirm everything seen above.
    DISCOVERED_WALLET.confirmedBalance = applyDelta(DISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: -BLIND_ONLY_1 - BLIND_ONLY_2
    });

    DISCOVERED_DEFAULT.confirmedBalance = applyDelta(DISCOVERED_DEFAULT.sentBalance, {
      confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    DISCOVERED_ALT.confirmedBalance = applyDelta(DISCOVERED_ALT.sentBalance, {
      confirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      clocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    DISCOVERED_WALLET.unconfirmedBalance = DISCOVERED_WALLET.sentBalance;
    DISCOVERED_DEFAULT.unconfirmedBalance = DISCOVERED_DEFAULT.sentBalance;
    DISCOVERED_ALT.unconfirmedBalance = DISCOVERED_ALT.sentBalance;

    // Erase
    DISCOVERED_WALLET.eraseBalance = DISCOVERED_WALLET.initialBalance;
    DISCOVERED_DEFAULT.eraseBalance = DISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_ALT.eraseBalance = DISCOVERED_ALT.initialBalance;

    // Confirm in block
    DISCOVERED_WALLET.blockConfirmedBalance = DISCOVERED_WALLET.confirmedBalance;
    DISCOVERED_DEFAULT.blockConfirmedBalance = DISCOVERED_DEFAULT.confirmedBalance;
    DISCOVERED_ALT.blockConfirmedBalance = DISCOVERED_ALT.confirmedBalance;

    // Unconfirm in block
    DISCOVERED_WALLET.blockUnconfirmedBalance = DISCOVERED_WALLET.unconfirmedBalance;
    DISCOVERED_DEFAULT.blockUnconfirmedBalance = DISCOVERED_DEFAULT.unconfirmedBalance;
    DISCOVERED_ALT.blockUnconfirmedBalance = DISCOVERED_ALT.unconfirmedBalance;

    genTests({
      name: 'should send/receive reveal',
      undiscovered: [UNDISCOVERED_WALLET, UNDISCOVERED_DEFAULT, UNDISCOVERED_ALT],
      discovered: [DISCOVERED_WALLET, DISCOVERED_DEFAULT, DISCOVERED_ALT],
      tester: testCrossActReveal,
      discoverer: altDiscover
    });
  });

  describe('BID -> REVEAL* (foreign reveal)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name;
    const setupRevealName = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
      await primary.sendBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ]);
      await mineBlocks(biddingPeriod);
    };

    const sendReveal = async (wallet, clone, ahead) => {
      const account = await wallet.getAccount(DEFAULT_ACCOUNT);
      const {nextAddr} = getAheadAddr(account, ahead);
      const recv = await wallet.receiveAddress();

      const mtx = await primary.createReveal(name);
      assert.strictEqual(mtx.outputs[0].covenant.type, types.REVEAL);
      assert.strictEqual(mtx.outputs[1].covenant.type, types.REVEAL);

      mtx.outputs[0].address = recv;
      mtx.outputs[1].address = nextAddr;
      await resign(primary, mtx);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const testForeignReveal = balanceTest(setupRevealName, sendReveal, AHEAD);

    // balances if missing reveal was not discovered.
    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: 1,

      unconfirmed: BID_AMOUNT_1,
      ulocked: BID_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: BID_AMOUNT_1,
      clocked: BID_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    // Balances if everyting was discovered from the begining.
    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,

      unconfirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      ulocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      clocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.sentBalance;

    genTests({
      name: 'should send/receive reveal',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testForeignReveal,
      discoverer: defDiscover
    });
  });

  describe('REVEAL* -> REDEEM*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    /*
     * TODO: Move this tests to the auction tests.
     * - 1 normal -> redeem (loser)
     * - 1 missed -> redeem (loser) - bid chain is missing until reve
     */

    let name1, name2;

    const setupRevealNames = async (wallet, clone, ahead) => {
      name1 = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      name2 = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      const cloneAccount = await clone.getAccount(DEFAULT_ACCOUNT);
      const addr1 = getAheadAddr(cloneAccount, ahead);

      await primary.sendBatch([
        ['OPEN', name1],
        ['OPEN', name2]
      ]);
      await mineBlocks(openingPeriod);

      // primary will win
      await primary.sendBid(name1, INIT_FUND, INIT_FUND);
      await primary.sendBid(name2, INIT_FUND, INIT_FUND);

      const txOpts = { hardFee: HARD_FEE };

      // all three bids are there.
      const bidMTX = await clone.createBatch([
        ['BID', name1, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name2, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      bidMTX.outputs[1].address = addr1.nextAddr;
      await resign(clone, bidMTX);

      // make sure clone knows ahead addrs.
      await defDiscover(clone, ahead * 2);

      await node.mempool.addTX(bidMTX.toTX());
      await mineBlocks(biddingPeriod);

      await primary.sendReveal(name1);
      await primary.sendReveal(name2);

      await clone.sendBatch([
        ['REVEAL', name1],
        ['REVEAL', name2]
      ], txOpts);

      await mineBlocks(revealPeriod + 1);
    };

    const sendRedeems = async (wallet, clone, ahead) => {
      await clone.sendBatch([
        ['REDEEM', name1],
        ['REDEEM', name2]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testRevealRedeems = balanceTest(setupRevealNames, sendRedeems, AHEAD);

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
      // 1 for bid, 1 for reveal.
      tx: 2,

      // (1 coin -> 1 change = 0) + 1 change + 1 reveal
      coin: 2,

      // Does not know about 1 reveal, so it is an out.
      confirmed: -(HARD_FEE * 2) - BID_AMOUNT_2,
      unconfirmed: -(HARD_FEE * 2) - BID_AMOUNT_2,

      // only aware of single reveal.
      clocked: BID_AMOUNT_1,
      ulocked: BID_AMOUNT_1
    });

    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      // redeem tx
      tx: 1,

      coin: 0,

      unconfirmed: -HARD_FEE,
      ulocked: -BID_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: -BID_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;

    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 1,
      unconfirmed: -HARD_FEE + BID_AMOUNT_2,
      ulocked: -BID_AMOUNT_1
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: -HARD_FEE + BID_AMOUNT_2,
      clocked: -BID_AMOUNT_1
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should send/receive reveal->redeem',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testRevealRedeems,
      discoverer: defDiscover
    });
  });

  describe('REVEAL* -> REGISTER*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    /*
     * TODO: Move this tests to the auction tests.
     * - 1 normal -> register (WINNER)
     * - 1 missed -> register (WINNER) - bid chain is missing until reve
     */

    let name1, name2;

    const setupRevealNames = async (wallet, clone, ahead) => {
      const names = await setupTwoRegisteredNames(clone, ahead, false);

      name1 = names[0];
      name2 = names[1];
    };

    const sendRedeems = async (wallet, clone, ahead) => {
      await clone.sendBatch([
        ['UPDATE', name1, EMPTY_RS],
        ['UPDATE', name2, EMPTY_RS]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testRevealRedeems = balanceTest(setupRevealNames, sendRedeems, AHEAD);

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
      // 1 for bid, 1 for reveal.
      tx: 2,

      // (1 coin -> 1 change = 0) + 1 change + 1 reveal
      coin: 2,

      // Does not know about 1 reveal, so it is an out.
      confirmed: -(HARD_FEE * 2) - BID_AMOUNT_2,
      unconfirmed: -(HARD_FEE * 2) - BID_AMOUNT_2,

      // only aware of single reveal.
      clocked: BID_AMOUNT_1,
      ulocked: BID_AMOUNT_1
    });

    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      // register tx
      tx: 1,
      // additional change for REGISTER tx.
      coin: 1,

      // BID_AMOUNT_2 was returned via change
      // only finalPrice2 is not accounted for.
      unconfirmed: -HARD_FEE + BID_AMOUNT_2 - FINAL_PRICE_2,
      ulocked: -BID_AMOUNT_1 + FINAL_PRICE_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -HARD_FEE + BID_AMOUNT_2 - FINAL_PRICE_2,
      clocked: -BID_AMOUNT_1 + FINAL_PRICE_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;

    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: -HARD_FEE + BID_AMOUNT_2,
      ulocked: -BID_AMOUNT_1 + FINAL_PRICE_1 + FINAL_PRICE_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: -HARD_FEE + BID_AMOUNT_2,
      clocked: -BID_AMOUNT_1 + FINAL_PRICE_1 + FINAL_PRICE_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should send/receive reveal->register',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testRevealRedeems,
      discoverer: defDiscover
    });
  });

  /*
   * All updates types have the same accounting outcomes
   */

  const UPDATE_UNDISCOVERED = {};
  UPDATE_UNDISCOVERED.initialBalance = INIT_REGISTERED_BALANCE;
  UPDATE_UNDISCOVERED.sentBalance = applyDelta(UPDATE_UNDISCOVERED.initialBalance, {
    tx: 1,
    unconfirmed: -HARD_FEE
  });

  UPDATE_UNDISCOVERED.confirmedBalance = applyDelta(UPDATE_UNDISCOVERED.sentBalance, {
    confirmed: -HARD_FEE
  });

  UPDATE_UNDISCOVERED.unconfirmedBalance = UPDATE_UNDISCOVERED.sentBalance;
  UPDATE_UNDISCOVERED.eraseBalance = UPDATE_UNDISCOVERED.initialBalance;
  UPDATE_UNDISCOVERED.blockConfirmedBalance = UPDATE_UNDISCOVERED.confirmedBalance;
  UPDATE_UNDISCOVERED.blockUnconfirmedBalance = UPDATE_UNDISCOVERED.unconfirmedBalance;

  const UPDATE_DISCOVERED = {};
  UPDATE_DISCOVERED.initialBalance = UPDATE_UNDISCOVERED.initialBalance;

  UPDATE_DISCOVERED.sentBalance = applyDelta(UPDATE_DISCOVERED.initialBalance, {
    tx: 1,
    // discovers the unknown update
    coin: 1,

    unconfirmed: -HARD_FEE + FINAL_PRICE_2,
    ulocked: FINAL_PRICE_2
  });

  UPDATE_DISCOVERED.confirmedBalance = applyDelta(UPDATE_DISCOVERED.sentBalance, {
    confirmed: -HARD_FEE + FINAL_PRICE_2,
    clocked: FINAL_PRICE_2
  });

  UPDATE_DISCOVERED.unconfirmedBalance = UPDATE_DISCOVERED.sentBalance;
  UPDATE_DISCOVERED.eraseBalance = UPDATE_DISCOVERED.initialBalance;
  UPDATE_DISCOVERED.blockConfirmedBalance = UPDATE_DISCOVERED.confirmedBalance;
  UPDATE_DISCOVERED.blockUnconfirmedBalance = UPDATE_DISCOVERED.unconfirmedBalance;

  describe('REGISTER* -> UPDATE*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name1, name2;

    const setupRegisteredNames = async (wallet, clone, ahead) => {
      const names = await setupTwoRegisteredNames(clone, ahead);

      name1 = names[0];
      name2 = names[1];
    };

    const sendUpdates = async (wallet, clone) => {
      await clone.sendBatch([
        ['UPDATE', name1, EMPTY_RS],
        ['UPDATE', name2, EMPTY_RS]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testSendUpdate = balanceTest(setupRegisteredNames, sendUpdates, AHEAD);

    genTests({
      name: 'should send/receive register->update',
      undiscovered: UPDATE_UNDISCOVERED,
      discovered: UPDATE_DISCOVERED,
      tester: testSendUpdate,
      discoverer: defDiscover
    });
  });

  // NOTE: Revokes are permanently burned coins, should we discount them from
  // balance and UTXO set? (moved to burned balance)
  describe('REGISTER/UPDATE* -> REVOKE*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name1, name2;

    const setupRegisteredNames = async (wallet, clone, ahead) => {
      const names = await setupTwoRegisteredNames(clone, ahead);

      name1 = names[0];
      name2 = names[1];
    };

    const sendRevokes = async (wallet, clone) => {
      await clone.sendBatch([
        ['REVOKE', name1],
        ['REVOKE', name2]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testSendRevokes = balanceTest(setupRegisteredNames, sendRevokes, AHEAD);

    genTests({
      name: 'should send/receive register->revoke',
      undiscovered: UPDATE_UNDISCOVERED,
      discovered: UPDATE_DISCOVERED,
      tester: testSendRevokes,
      discoverer: defDiscover
    });
  });

  describe('REGISTER/UPDATE* -> RENEW*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name1, name2;

    const setupRegisteredNames = async (wallet, clone, ahead) => {
      const names = await setupTwoRegisteredNames(clone, ahead);

      name1 = names[0];
      name2 = names[1];
    };

    const sendRenews = async (wallet, clone) => {
      await mineBlocks(treeInterval);
      await clone.sendBatch([
        ['RENEW', name1],
        ['RENEW', name2]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testSendRenews = balanceTest(setupRegisteredNames, sendRenews, AHEAD);

    genTests({
      name: 'should send/receive register->renew',
      undiscovered: UPDATE_UNDISCOVERED,
      discovered: UPDATE_DISCOVERED,
      tester: testSendRenews,
      discoverer: defDiscover
    });
  });

  describe('REGISTER/UPDATE* -> TRANSFER*', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name1, name2;

    const setupRegisteredNames = async (wallet, clone, ahead) => {
      const names = await setupTwoRegisteredNames(clone, ahead);

      name1 = names[0];
      name2 = names[1];
    };

    const sendTransfers = async (wallet, clone) => {
      await clone.sendBatch([
        ['TRANSFER', name1, await primary.receiveAddress()],
        ['TRANSFER', name2, await primary.receiveAddress()]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testSendTransfer = balanceTest(setupRegisteredNames, sendTransfers, AHEAD);

    genTests({
      name: 'should send/receive register->renew',
      undiscovered: UPDATE_UNDISCOVERED,
      discovered: UPDATE_DISCOVERED,
      tester: testSendTransfer,
      discoverer: defDiscover
    });
  });

  describe('TRANSFER* -> FINALIZE', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name1, name2;

    const setupTransferNames = async (wallet, clone, ahead) => {
      const names = await setupTwoRegisteredNames(clone, ahead);

      name1 = names[0];
      name2 = names[1];

      await clone.sendBatch([
        ['TRANSFER', name1, await primary.receiveAddress()],
        ['TRANSFER', name2, await primary.receiveAddress()]
      ], {
        hardFee: HARD_FEE
      });

      await mineBlocks(transferLockup);
    };

    const sendFinalizes = async (wallet, clone) => {
      await clone.sendBatch([
        ['FINALIZE', name1],
        ['FINALIZE', name2]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testSendFinalizes = balanceTest(setupTransferNames, sendFinalizes, AHEAD);

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_REGISTERED_BALANCE, {
      // we sent TRANSFER
      tx: 1,
      confirmed: -HARD_FEE,
      unconfirmed: -HARD_FEE
    });

    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: -1,
      unconfirmed: -FINAL_PRICE_1 - HARD_FEE,
      ulocked: -FINAL_PRICE_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -FINAL_PRICE_1 - HARD_FEE,
      clocked: -FINAL_PRICE_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = UNDISCOVERED.initialBalance;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: -1,

      // Because we only discover when it's outgoing, it wont affect our balance.
      unconfirmed: -FINAL_PRICE_1 - HARD_FEE,
      ulocked: -FINAL_PRICE_1
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: -FINAL_PRICE_1 - HARD_FEE,
      clocked: -FINAL_PRICE_1
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should send finalize',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testSendFinalizes,
      discoverer: defDiscover
    });
  });

  describe('TRANSFER* -> FINALIZE* (cross acct)', function() {
    this.timeout(5000);
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name1, name2;

    const setupTransferNames = async (wallet, clone, ahead) => {
      await wallet.createAccount({
        name: ALT_ACCOUNT
      });

      const altAccount = await wallet.getAccount(ALT_ACCOUNT);
      const recv = await wallet.receiveAddress(ALT_ACCOUNT);
      const {nextAddr} = getAheadAddr(altAccount, ahead);

      const names = await setupTwoRegisteredNames(clone, ahead);

      name1 = names[0];
      name2 = names[1];

      await clone.sendBatch([
        ['TRANSFER', name1, recv],
        ['TRANSFER', name2, nextAddr]
      ], {
        hardFee: HARD_FEE
      });

      await mineBlocks(transferLockup);
    };

    const sendFinalizes = async (wallet, clone) => {
      await clone.sendBatch([
        ['FINALIZE', name1],
        ['FINALIZE', name2]
      ], {
        hardFee: HARD_FEE
      });
    };

    const AHEAD = 10;
    const testSendFinalizes = balanceTest(setupTransferNames, sendFinalizes, AHEAD);

    const UNDISCOVERED_WALLET = {};
    const UNDISCOVERED_DEFAULT = {};
    const UNDISCOVERED_ALT = {};

    UNDISCOVERED_WALLET.initialBalance = applyDelta(INIT_REGISTERED_BALANCE, {
      // we sent TRANSFER
      tx: 1,
      confirmed: -HARD_FEE,
      unconfirmed: -HARD_FEE
    });

    UNDISCOVERED_DEFAULT.initialBalance = UNDISCOVERED_WALLET.initialBalance;
    UNDISCOVERED_ALT.initialBalance = NULL_BALANCE;

    UNDISCOVERED_WALLET.sentBalance = applyDelta(UNDISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // default sent to alt.
      coin: 0,

      unconfirmed: -HARD_FEE
    });

    UNDISCOVERED_DEFAULT.sentBalance = applyDelta(UNDISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      coin: -1,
      unconfirmed: -FINAL_PRICE_1 - HARD_FEE,
      ulocked: -FINAL_PRICE_1
    });

    UNDISCOVERED_ALT.sentBalance = applyDelta(UNDISCOVERED_ALT.initialBalance, {
      tx: 1,
      coin: 1,

      unconfirmed: FINAL_PRICE_1,
      ulocked: FINAL_PRICE_1
    });

    UNDISCOVERED_WALLET.confirmedBalance = applyDelta(UNDISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE
    });

    UNDISCOVERED_DEFAULT.confirmedBalance = applyDelta(UNDISCOVERED_DEFAULT.sentBalance, {
      confirmed: -FINAL_PRICE_1 - HARD_FEE,
      clocked: -FINAL_PRICE_1
    });

    UNDISCOVERED_ALT.confirmedBalance = applyDelta(UNDISCOVERED_ALT.sentBalance, {
      confirmed: FINAL_PRICE_1,
      clocked: FINAL_PRICE_1
    });

    UNDISCOVERED_WALLET.unconfirmedBalance = UNDISCOVERED_WALLET.sentBalance;
    UNDISCOVERED_WALLET.eraseBalance = UNDISCOVERED_WALLET.initialBalance;
    UNDISCOVERED_WALLET.blockConfirmedBalance = UNDISCOVERED_WALLET.confirmedBalance;
    UNDISCOVERED_WALLET.blockUnconfirmedBalance = UNDISCOVERED_WALLET.unconfirmedBalance;

    UNDISCOVERED_DEFAULT.unconfirmedBalance = UNDISCOVERED_DEFAULT.sentBalance;
    UNDISCOVERED_DEFAULT.eraseBalance = UNDISCOVERED_DEFAULT.initialBalance;
    UNDISCOVERED_DEFAULT.blockConfirmedBalance = UNDISCOVERED_DEFAULT.confirmedBalance;
    UNDISCOVERED_DEFAULT.blockUnconfirmedBalance = UNDISCOVERED_DEFAULT.unconfirmedBalance;

    UNDISCOVERED_ALT.unconfirmedBalance = UNDISCOVERED_ALT.sentBalance;
    UNDISCOVERED_ALT.eraseBalance = UNDISCOVERED_ALT.initialBalance;
    UNDISCOVERED_ALT.blockConfirmedBalance = UNDISCOVERED_ALT.confirmedBalance;
    UNDISCOVERED_ALT.blockUnconfirmedBalance = UNDISCOVERED_ALT.unconfirmedBalance;

    const DISCOVERED_WALLET = {};
    const DISCOVERED_DEFAULT = {};
    const DISCOVERED_ALT = {};

    DISCOVERED_WALLET.initialBalance = UNDISCOVERED_WALLET.initialBalance;
    DISCOVERED_DEFAULT.initialBalance = UNDISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_ALT.initialBalance = UNDISCOVERED_ALT.initialBalance;

    DISCOVERED_WALLET.sentBalance = applyDelta(DISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // we discover receiving finalize
      coin: 1,

      unconfirmed: -HARD_FEE + FINAL_PRICE_2,
      ulocked: FINAL_PRICE_2
    });

    DISCOVERED_DEFAULT.sentBalance = applyDelta(DISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      coin: -1,

      unconfirmed: -FINAL_PRICE_1 - HARD_FEE,
      ulocked: -FINAL_PRICE_1
    });

    DISCOVERED_ALT.sentBalance = applyDelta(DISCOVERED_ALT.initialBalance, {
      tx: 1,
      coin: 2,

      unconfirmed: FINAL_PRICE_1 + FINAL_PRICE_2,
      ulocked: FINAL_PRICE_1 + FINAL_PRICE_2
    });

    DISCOVERED_WALLET.confirmedBalance = applyDelta(DISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE + FINAL_PRICE_2,
      clocked: FINAL_PRICE_2
    });

    DISCOVERED_DEFAULT.confirmedBalance = applyDelta(DISCOVERED_DEFAULT.sentBalance, {
      confirmed: -FINAL_PRICE_1 - HARD_FEE,
      clocked: -FINAL_PRICE_1
    });

    DISCOVERED_ALT.confirmedBalance = applyDelta(DISCOVERED_ALT.sentBalance, {
      confirmed: FINAL_PRICE_1 + FINAL_PRICE_2,
      clocked: FINAL_PRICE_1 + FINAL_PRICE_2
    });

    DISCOVERED_WALLET.unconfirmedBalance = DISCOVERED_WALLET.sentBalance;
    DISCOVERED_WALLET.eraseBalance = DISCOVERED_WALLET.initialBalance;
    DISCOVERED_WALLET.blockConfirmedBalance = DISCOVERED_WALLET.confirmedBalance;
    DISCOVERED_WALLET.blockUnconfirmedBalance = DISCOVERED_WALLET.unconfirmedBalance;

    DISCOVERED_DEFAULT.unconfirmedBalance = DISCOVERED_DEFAULT.sentBalance;
    DISCOVERED_DEFAULT.eraseBalance = DISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_DEFAULT.blockConfirmedBalance = DISCOVERED_DEFAULT.confirmedBalance;
    DISCOVERED_DEFAULT.blockUnconfirmedBalance = DISCOVERED_DEFAULT.unconfirmedBalance;

    DISCOVERED_ALT.unconfirmedBalance = DISCOVERED_ALT.sentBalance;
    DISCOVERED_ALT.eraseBalance = DISCOVERED_ALT.initialBalance;
    DISCOVERED_ALT.blockConfirmedBalance = DISCOVERED_ALT.confirmedBalance;
    DISCOVERED_ALT.blockUnconfirmedBalance = DISCOVERED_ALT.unconfirmedBalance;

    genTests({
      name: 'should send finalize (cross acct)',
      undiscovered: [UNDISCOVERED_WALLET, UNDISCOVERED_DEFAULT, UNDISCOVERED_ALT],
      discovered: [DISCOVERED_WALLET, DISCOVERED_DEFAULT, DISCOVERED_ALT],
      tester: testSendFinalizes,
      discoverer: altDiscover
    });
  });
});
