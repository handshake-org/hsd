'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const Covenant = require('../lib/primitives/covenant');
const Coin = require('../lib/primitives/coin');
const Input = require('../lib/primitives/input');
const wcommon = require('../lib/wallet/common');
const WalletDB = require('../lib/wallet/walletdb');
const policy = require('../lib/protocol/policy');
const wutils = require('./util/wallet');
const primutils = require('./util/primitives');
const {randomP2PKAddress} = primutils;
const {DB_VALUE, DB_AGE, DB_ALL, DB_SWEEPDUST} = wcommon.coinSelectionTypes;
const {
  nextBlock,
  curBlock,
  createInboundTXs,
  fundWallet
} = wutils;

/** @typedef {import('../lib/wallet/wallet')} Wallet */
/** @typedef {import('../lib/primitives/tx')} TX */
/** @typedef {import('./util/primitives').CoinOptions} CoinOptions */
/** @typedef {wutils.OutputInfo} OutputInfo */

const UNCONFIRMED_HEIGHT = 0xffffffff;

// Use main instead of regtest because (deprecated)
// CoinSelector.MAX_FEE was network agnostic
const network = Network.get('main');

const DEFAULT_ACCOUNT = 'default';
const ALT_ACCOUNT = 'alt';

describe('Wallet Coin Selection', function() {
  const TX_START_BAK = network.txStart;
  /** @type {WalletDB?} */
  let wdb;
  /** @type {Wallet?} */
  let wallet;

  const beforeFn = async () => {
    network.txStart = 0;
    wdb = new WalletDB({ network });

    await wdb.open();
    await wdb.addBlock(nextBlock(wdb), []);
    wallet = wdb.primary;

    await wallet.createAccount({
      name: ALT_ACCOUNT
    });
  };

  const afterFn = async () => {
    network.txStart = TX_START_BAK;
    await wdb.close();

    wdb = null;
    wallet = null;
  };

  const indexes = [
    'value-asc',
    'value-desc',
    'height-asc',
    'height-desc'
  ];

  for (const indexType of indexes) {
  describe(`Coin Selection Indexes (${indexType})`, function() {
    const TX_OPTIONS = [
      { value: 2e6, address: randomP2PKAddress() },
      // address will be generated using wallet.
      { value: 1e6, covenant: { type: Covenant.types.OPEN } },
      { value: 5e6, covenant: { type: Covenant.types.REDEEM } },
      { value: 2e6 },
      // alt account
      { value: 4e6, account: ALT_ACCOUNT },
      { value: 6e6, account: ALT_ACCOUNT, covenant: { type: Covenant.types.OPEN } },
      { value: 3e6, account: ALT_ACCOUNT, covenant: { type: Covenant.types.REDEEM } },
      // non spendable coins must not get indexed.
      { value: 4e6, covenant: { type: Covenant.types.BID } },
      { value: 5e6, covenant: { type: Covenant.types.REVEAL } },
      { value: 6e6, covenant: { type: Covenant.types.REGISTER } },
      { value: 7e6, covenant: { type: Covenant.types.UPDATE } },
      { value: 8e6, covenant: { type: Covenant.types.RENEW } },
      { value: 9e6, covenant: { type: Covenant.types.TRANSFER } },
      { value: 10e6, covenant: { type: Covenant.types.FINALIZE } },
      { value: 11e6, covenant: { type: Covenant.types.REVOKE } }
    ];

    const ACCT_0_COINS = 3;
    const ACCT_0_FUNDS = 1e6 + 2e6 + 5e6;
    const ACCT_1_COINS = 3;
    const ACCT_1_FUNDS = 3e6 + 4e6 + 6e6;
    const TOTAL_COINS = ACCT_0_COINS + ACCT_1_COINS;
    const TOTAL_FUNDS = ACCT_0_FUNDS + ACCT_1_FUNDS;

    let isSorted, getCredits;
    const sumCredits = credits => credits.reduce((acc, c) => acc + c.coin.value, 0);
    const checkWithLimits = async (credits, wallet, acct) => {
      for (let i = 1; i < credits.length; i++) {
        const creditsLimit = await getCredits(wallet, acct, {
          limit: i
        });
        assert.strictEqual(creditsLimit.length, i);
        assert(isSorted(creditsLimit), 'Credits not sorted.');
        assert.deepStrictEqual(creditsLimit, credits.slice(0, i));
        assert(sumCredits(creditsLimit) === sumCredits(credits.slice(0, i)));
      }
    };

    before(() => {
      switch (indexType) {
        case 'value-asc':
          isSorted = isSortedByValueAsc;
          getCredits = (wallet, acct = 0, opts = {}) => {
            return collectIter(wallet.getAccountCreditIterByValue(acct, opts));
          };
          break;
        case 'value-desc':
          isSorted = isSortedByValueDesc;
          getCredits = (wallet, acct = 0, opts = {}) => {
            return collectIter(wallet.getAccountCreditIterByValue(acct, {
              ...opts,
              reverse: true
            }));
          };
          break;
        case 'height-asc':
          isSorted = isSortedByHeightAsc;
          getCredits = (wallet, acct = 0, opts = {}) => {
            return collectIter(wallet.getAccountCreditIterByHeight(acct, opts));
          };
          break;
        case 'height-desc':
          isSorted = isSortedByHeightDesc;
          getCredits = (wallet, acct = 0, opts = {}) => {
            return collectIter(wallet.getAccountCreditIterByHeight(acct, {
              ...opts,
              reverse: true
            }));
          };
          break;
        default:
          throw new Error('Invalid index type.');
      }
    });

    beforeEach(beforeFn);
    afterEach(afterFn);

    it('should index unconfirmed tx output', async () => {
      const txs = await createInboundTXs(wallet, TX_OPTIONS);

      for (const tx of txs)
        await wallet.wdb.addTX(tx);

      const credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      const credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      const both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, -1);
        assert.strictEqual(credit.spent, false);
      }
    });

    it('should index unconfirmed tx input', async () => {
      const currentBlock = curBlock(wdb);
      await fundWallet(wallet, TX_OPTIONS, {
        blockPerTX: true
      });

      const spendAll = await wallet.createTX({
        hardFee: 0,
        outputs: [{ value: TOTAL_FUNDS, address: randomP2PKAddress() }]
      });

      await wdb.addTX(spendAll.toTX());

      // We still have the coin, even thought it is flagged: .spent = true
      const credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      const credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      const both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert(credit.coin.height > currentBlock.height);
        assert.strictEqual(credit.spent, true);
      }
    });

    it('should index insert (block) tx output', async () => {
      const currentBlock = curBlock(wdb);
      await fundWallet(wallet, TX_OPTIONS, { blockPerTX: true });

      const credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      const credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      const both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert(credit.coin.height > currentBlock.height);
        assert.strictEqual(credit.spent, false);
      }
    });

    it('should index insert (block) tx input', async () => {
      await fundWallet(wallet, TX_OPTIONS, {
        blockPerTX: false
      });
      const currentBlock = curBlock(wdb);

      const spendAll = await wallet.createTX({
        hardFee: 0,
        outputs: [{ value: TOTAL_FUNDS, address: randomP2PKAddress() }]
      });

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, currentBlock.height);
        assert.strictEqual(credit.spent, false);
      }

      await wdb.addBlock(nextBlock(wdb), [spendAll.toTX()]);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 0);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 0);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 0);
    });

    it('should index confirm tx output', async () => {
      const txs = await createInboundTXs(wallet, TX_OPTIONS);
      for (const tx of txs)
        await wdb.addTX(tx);

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, -1);
        assert.strictEqual(credit.spent, false);
      }

      await wdb.addBlock(nextBlock(wdb), txs);
      const currentBlock = curBlock(wdb);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, currentBlock.height);
        assert.strictEqual(credit.spent, false);
      }
    });

    it('should index confirm tx input', async () => {
      const currentBlock = curBlock(wdb);
      await fundWallet(wallet, TX_OPTIONS, {
        blockPerTX: true
      });

      const spendAll = await wallet.createTX({
        hardFee: 0,
        outputs: [{ value: TOTAL_FUNDS, address: randomP2PKAddress() }]
      });
      const spendAllTX = spendAll.toTX();

      await wdb.addTX(spendAllTX);

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert(credit.coin.height > currentBlock.height);
        assert.strictEqual(credit.spent, true);
      }

      await wdb.addBlock(nextBlock(wdb), [spendAllTX]);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 0);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 0);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 0);
    });

    it('should index disconnect tx output', async () => {
      const currentBlock = curBlock(wdb);
      await fundWallet(wallet, TX_OPTIONS, {
        blockPerTX: true
      });

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert(credit.coin.height > currentBlock.height);
        assert.strictEqual(credit.spent, false);
      }

      // disconnect last block.
      await wdb.rollback(currentBlock.height);

      // Only thing that must change is the HEIGHT.
      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, -1);
        assert.strictEqual(credit.spent, false);
      }
    });

    it('should index disconnect tx input', async () => {
      const startingHeight = curBlock(wdb).height;
      await fundWallet(wallet, TX_OPTIONS, { blockPerTX: true });
      const createCoinHeight = curBlock(wdb).height;

      const spendAll = await wallet.createTX({
        hardFee: 0,
        outputs: [{ value: TOTAL_FUNDS, address: randomP2PKAddress() }]
      });

      const spendAllTX = spendAll.toTX();
      await wdb.addBlock(nextBlock(wdb), [spendAllTX]);

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 0);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 0);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 0);

      await wdb.rollback(createCoinHeight);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert(credit.coin.height > startingHeight);
        assert.strictEqual(credit.spent, true);
      }
    });

    it('should index erase tx output', async () => {
      const txs = await createInboundTXs(wallet, TX_OPTIONS);

      for (const tx of txs)
        await wdb.addTX(tx);

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, -1);
        assert.strictEqual(credit.spent, false);
      }

      // double spend original txs.
      const mtx = new MTX();
      for (const tx of txs)
        mtx.addInput(tx.inputs[0]);
      mtx.addOutput(randomP2PKAddress(), 1e6);

      await wdb.addBlock(nextBlock(wdb), [mtx.toTX()]);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 0);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 0);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 0);
    });

    it('should index erase tx input', async () => {
      const txs = await createInboundTXs(wallet, TX_OPTIONS);
      for (const tx of txs)
        await wdb.addTX(tx);

      const spendAll = await wallet.createTX({
        hardFee: 0,
        outputs: [{ value: TOTAL_FUNDS, address: randomP2PKAddress() }]
      });

      await wdb.addTX(spendAll.toTX());

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert.strictEqual(credit.coin.height, -1);
        assert.strictEqual(credit.spent, true);
      }

      // double spend original tx.
      const mtx = new MTX();
      for (const tx of txs)
        mtx.addInput(tx.inputs[0]);
      mtx.addOutput(randomP2PKAddress(), 1e6);

      await wdb.addBlock(nextBlock(wdb), [mtx.toTX()]);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 0);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 0);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 0);
    });

    it('should index erase (block) tx output', async () => {
      const txOptions = [...TX_OPTIONS];
      for (const opt of txOptions)
        opt.coinbase = true;

      const startingHeight = curBlock(wdb).height;
      const txs = await fundWallet(wallet, txOptions, { blockPerTX: true });

      for (const tx of txs)
        assert(tx.isCoinbase());

      let credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, ACCT_0_COINS);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === ACCT_0_FUNDS);

      let credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, ACCT_1_COINS);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === ACCT_1_FUNDS);

      let both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, TOTAL_COINS);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === TOTAL_FUNDS);

      for (const credit of [...credits0, ...credits1, ...both]) {
        assert(credit.coin.height > startingHeight);
        assert.strictEqual(credit.spent, false);
      }

      await wdb.rollback(startingHeight);

      credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 0);

      credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 0);

      both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 0);
    });

    it('should index block and mempool', async () => {
      const txOptionsConfirmed = [
        { value: 4e6 },
        { value: 7e6 },
        { value: 2e6, account: ALT_ACCOUNT },
        { value: 5e6, account: ALT_ACCOUNT }
      ];
      await fundWallet(wallet, txOptionsConfirmed, {
        blockPerTX: false
      });

      const txOptionsUnconfirmed = [
        { value: 8e6 },
        { value: 3e6 },
        { value: 6e6, account: ALT_ACCOUNT },
        { value: 1e6, account: ALT_ACCOUNT }
      ];
      const txs = await createInboundTXs(wallet, txOptionsUnconfirmed, {
        txPerOutput: false
      });
      await wdb.addTX(txs[0]);

      const sum0 = 3e6 + 4e6 + 7e6 + 8e6;
      const sum1 = 1e6 + 2e6 + 5e6 + 6e6;

      const credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 4);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === sum0);

      await checkWithLimits(credits0, wallet);

      const credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 4);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === sum1);

      await checkWithLimits(credits1, wallet, 1);

      const both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 8);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === sum0 + sum1);

      await checkWithLimits(both, wallet, -1);
    });
  });
  }

  /** @type {OutputInfo[]} */
  const PER_BLOCK_COINS = [
    // confirmed per block.
    { value: 2e6 },
    { value: 2e6 },
    { value: 1e6, account: ALT_ACCOUNT },
    { value: 12e6 }, // LOCKED
    { value: 8e6 },
    { value: 10e6, account: ALT_ACCOUNT }, // LOCKED
    { value: 5e6, account: ALT_ACCOUNT }
  ];

  /** @type {OutputInfo[]} */
  const UNCONFIRMED_COINS = [
    // unconfirmed
    { value: 3e6 }, // own
    { value: 6e6 },
    { value: 11e6 }, // LOCKED
    { value: 4e6, account: ALT_ACCOUNT }, // own
    { value: 7e6, account: ALT_ACCOUNT },
    { value: 9e6, account: ALT_ACCOUNT } // LOCKED
  ];

  const LOCK = [9e6, 10e6, 11e6, 12e6];
  const OWN = [
    { account: DEFAULT_ACCOUNT, value: 3e6 },
    { account: ALT_ACCOUNT, value: 4e6 }
  ];

  const ACCT_0_CONFIRMED = 2e6 + 2e6 + 8e6; // 10e6
  const ACCT_0_UNCONFIRMED = 3e6 + 6e6; // 9e6
  const ACCT_0_FOREIGN = 6e6;
  const ACCT_0_FUNDS = ACCT_0_CONFIRMED + ACCT_0_UNCONFIRMED; // 19e6

  const ACCT_1_CONFIRMED = 1e6 + 5e6; // 6e6
  const ACCT_1_UNCONFIRMED = 4e6 + 7e6; // 11e6
  const ACCT_1_FOREIGN = 7e6;
  const ACCT_1_FUNDS = ACCT_1_CONFIRMED + ACCT_1_UNCONFIRMED; // 17e6

  /**
   * @typedef {Object} SelectionTest
   * @property {String} name
   * @property {Object} options
   * @property {Amount} value
   * @property {Amount[]} [existingInputs] - use some coins that are resolved later.
   *                                        Use only unique value Coins.
   * @property {CoinOptions[]} [existingCoins] - Coins that don't belong to the wallet,
   *                                        but are used in the mtx.
   * @property {Amount[]} expectedOrdered
   * @property {Object} [expectedSome] - Some of this must exist in mtx.
   * * This is for AGE unconfirmed, which is not deterministic.
   * @property {Number} expectedSome.count - Number of items that must exist.
   * @property {Amount[]} expectedSome.items
   */

  /** @type {Object<string, SelectionTest[]>} */
  const SELECTION_TESTS = {
    'value': [
      // wallet by value
      {
        name: 'select 1 coin (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: 1e6,
        expectedOrdered: [8e6]
      },
      {
        name: 'select all confirmed coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED,
        expectedOrdered: [8e6, 5e6, 2e6, 2e6, 1e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [8e6, 5e6, 2e6, 2e6, 1e6, 7e6]
      },
      {
        name: 'select all coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        expectedOrdered: [8e6, 5e6, 2e6, 2e6, 1e6, 7e6, 6e6, 4e6, 3e6]
      },
      {
        // test locked filters.
        name: 'throw funding error (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      },

      // default account by value
      {
        name: 'select 1 coin (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 1e6,
        expectedOrdered: [8e6]
      },
      {
        name: 'select all confirmed coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_CONFIRMED,
        expectedOrdered: [8e6, 2e6, 2e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_CONFIRMED + 1e6,
        expectedOrdered: [8e6, 2e6, 2e6, 6e6]
      },
      {
        name: 'select all coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_FUNDS,
        expectedOrdered: [8e6, 2e6, 2e6, 6e6, 3e6]
      },
      {
        // test locked filters.
        name: 'throw funding error (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_0_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_0_FUNDS,
          requiredFunds: ACCT_0_FUNDS + 1e6,
          type: 'FundingError'
        }
      },

      // alt account by value
      {
        name: 'select 1 coin (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 1e6,
        expectedOrdered: [5e6]
      },
      {
        name: 'select all confirmed coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_1_CONFIRMED,
        expectedOrdered: [5e6, 1e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [5e6, 1e6, 7e6]
      },
      {
        name: 'select all coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_1_FUNDS,
        expectedOrdered: [5e6, 1e6, 7e6, 4e6]
      },
      {
        // test locked filters.
        name: 'throw funding error (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_1_FUNDS,
          requiredFunds: ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      }
    ],
    'value + smart': [
      // Test smart option.
      // smart selection (wallet)
      {
        name: 'select all confirmed and an unconfirmed + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [8e6, 5e6, 2e6, 2e6, 1e6, 4e6]
      },
      {
        name: 'select all coins + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN,
        expectedOrdered: [8e6, 5e6, 2e6, 2e6, 1e6, 4e6, 3e6]
      },
      {
        name: 'throw funding error + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          type: 'FundingError'
        }
      },
      // smart selection (default)
      {
        name: 'select all confirmed and an unconfirmed + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_0_CONFIRMED + 1e6,
        expectedOrdered: [8e6, 2e6, 2e6, 3e6]
      },
      {
        name: 'select all coins + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_0_FUNDS - ACCT_0_FOREIGN,
        expectedOrdered: [8e6, 2e6, 2e6, 3e6]
      },
      {
        name: 'throw funding error + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_0_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS - ACCT_0_FOREIGN,
          requiredFunds: ACCT_0_FUNDS,
          type: 'FundingError'
        }
      },
      // smart selection (alt)
      {
        name: 'select all confirmed and an unconfirmed + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [5e6, 1e6, 4e6]
      },
      {
        name: 'select all coins + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_1_FUNDS - ACCT_1_FOREIGN,
        expectedOrdered: [5e6, 1e6, 4e6]
      },
      {
        name: 'throw funding error + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value',
          smart: true
        },
        value: ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_1_FUNDS - ACCT_1_FOREIGN,
          requiredFunds: ACCT_1_FUNDS,
          type: 'FundingError'
        }
      }
    ],
    // Existing coins = views + inputs
    // Existing inputs = inputs (no view, needs extra resolving)
    'value + existing coins and inputs': [
      // existing coins (wallet)
      {
        name: 'select coins + existing coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 8e6, 5e6]
      },
      // existing coins (default)
      {
        name: 'select coins + existing coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 8e6, 2e6]
      },
      // existing coins (alt)
      {
        name: 'select coins + existing coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 5e6, 1e6, 7e6]
      },
      {
        name: 'select coins + existing inputs (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingInputs: [5e6],
        expectedOrdered: [5e6, 8e6]
      },
      // existing coins (default)
      {
        name: 'select coins + existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingInputs: [3e6],
        expectedOrdered: [3e6, 8e6]
      },
      // existing coins (alt)
      {
        name: 'select coins + existing coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingInputs: [4e6],
        expectedOrdered: [4e6, 5e6, 1e6]
      },
      // fail existing inputs (cross account)
      {
        name: 'fail cross account existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'value'
        },
        value: 10e6,
        existingInputs: [5e6], // this belongs to alt account
        error: {
          message: 'Could not resolve preferred inputs.'
        }
      }
    ],
    'age': [
      // wallet by age
      {
        name: 'select 1 coin (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: 1e6,
        expectedOrdered: [2e6]
      },
      {
        name: 'select all confirmed coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED,
        expectedOrdered: [2e6, 2e6, 1e6, 8e6, 5e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [2e6, 2e6, 1e6, 8e6, 5e6],
        expectedSome: {
          count: 1,
          items: [3e6, 6e6, 4e6, 7e6]
        }
      },
      {
        name: 'select all coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        expectedOrdered: [2e6, 2e6, 1e6, 8e6, 5e6],
        expectedSome: {
          count: 4,
          items: [3e6, 6e6, 4e6, 7e6]
        }
      },
      {
        // test locked filters.
        name: 'throw funding error (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      },

      // default account by age
      {
        name: 'select 1 coin (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 1e6,
        expectedOrdered: [2e6]
      },
      {
        name: 'select all confirmed coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_CONFIRMED,
        expectedOrdered: [2e6, 2e6, 8e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_CONFIRMED + 1e6,
        expectedOrdered: [2e6, 2e6, 8e6],
        expectedSome: {
          count: 1,
          items: [3e6, 6e6]
        }
      },
      {
        name: 'select all coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_FUNDS,
        expectedOrdered: [2e6, 2e6, 8e6],
        expectedSome: {
          count: 2,
          items: [3e6, 6e6]
        }
      },
      {
        // test locked filters.
        name: 'throw funding error (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_0_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_0_FUNDS,
          requiredFunds: ACCT_0_FUNDS + 1e6,
          type: 'FundingError'
        }
      },

      // alt account by age
      {
        name: 'select 1 coin (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 1e6,
        expectedOrdered: [1e6]
      },
      {
        name: 'select all confirmed coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_1_CONFIRMED,
        expectedOrdered: [1e6, 5e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [1e6, 5e6],
        expectedSome: {
          count: 1,
          items: [4e6, 7e6]
        }
      },
      {
        name: 'select all coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_1_FUNDS,
        expectedOrdered: [1e6, 5e6],
        expectedSome: {
          count: 2,
          items: [4e6, 7e6]
        }
      },
      {
        // test locked filters.
        name: 'throw funding error (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_1_FUNDS,
          requiredFunds: ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      }
    ],
    'age + smart': [
      // Test smart option.
      // smart selection (wallet)
      {
        name: 'select all confirmed and an unconfirmed + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [2e6, 2e6, 1e6, 8e6, 5e6],
        expectedSome: {
          count: 1,
          items: [3e6, 6e6, 4e6, 7e6]
        }
      },
      {
        name: 'select all coins + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN,
        expectedOrdered: [2e6, 2e6, 1e6, 8e6, 5e6],
        expectedSome: {
          count: 2,
          items: [3e6, 4e6]
        }
      },
      {
        name: 'throw funding error + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          type: 'FundingError'
        }
      },
      // smart selection (default)
      {
        name: 'select all confirmed and an unconfirmed + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_0_CONFIRMED + 1e6,
        expectedOrdered: [2e6, 2e6, 8e6],
        expectedSome: {
          count: 1,
          items: [3e6]
        }
      },
      {
        name: 'select all coins + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_0_FUNDS - ACCT_0_FOREIGN,
        expectedOrdered: [2e6, 2e6, 8e6],
        expectedSome: {
          count: 1,
          items: [3e6]
        }
      },
      {
        name: 'throw funding error + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_0_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS - ACCT_0_FOREIGN,
          requiredFunds: ACCT_0_FUNDS,
          type: 'FundingError'
        }
      },
      // smart selection (alt)
      {
        name: 'select all confirmed and an unconfirmed + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [1e6, 5e6],
        expectedSome: {
          count: 1,
          items: [4e6]
        }
      },
      {
        name: 'select all coins + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_1_FUNDS - ACCT_1_FOREIGN,
        expectedOrdered: [1e6, 5e6],
        expectedSome: {
          count: 1,
          items: [4e6]
        }
      },
      {
        name: 'throw funding error + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age',
          smart: true
        },
        value: ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_1_FUNDS - ACCT_1_FOREIGN,
          requiredFunds: ACCT_1_FUNDS,
          type: 'FundingError'
        }
      }
    ],
    // Existing coins = views + inputs
    // Existing inputs = inputs (no view, needs extra resolving)
    'age + existing inputs': [
      // existing coins (wallet)
      {
        name: 'select coins + existing coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 2e6, 2e6, 1e6, 8e6]
      },
      // existing coins (default)
      {
        name: 'select coins + existing coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 2e6, 2e6, 8e6]
      },
      // existing coins (alt)
      {
        name: 'select coins + existing coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 1e6, 5e6],
        expectedSome: {
          count: 1,
          items: [4e6, 7e6]
        }
      },
      {
        name: 'select coins + existing inputs (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingInputs: [5e6],
        expectedOrdered: [5e6, 2e6, 2e6, 1e6]
      },
      // existing coins (default)
      {
        name: 'select coins + existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingInputs: [3e6],
        expectedOrdered: [3e6, 2e6, 2e6, 8e6]
      },
      // existing coins (alt)
      {
        name: 'select coins + existing coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingInputs: [4e6],
        expectedOrdered: [4e6, 1e6, 5e6]
      },
      // fail existing inputs (cross account)
      {
        name: 'fail cross account existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'age'
        },
        value: 10e6,
        existingInputs: [5e6], // this belongs to alt account
        error: {
          message: 'Could not resolve preferred inputs.'
        }
      }
    ],
    'all': [
      // wallet by all
      {
        name: 'select all coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all'
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 9,
          items: [
            2e6, 2e6, 1e6, 8e6, 5e6,
            3e6, 6e6, 4e6, 7e6
          ]
        }
      },
      {
        name: 'select all coins + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all',
          smart: true
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 7,
          items: [
            2e6, 2e6, 1e6, 8e6, 5e6,
            3e6, 4e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 0 (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all',
          depth: 0
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 9,
          items: [
            2e6, 2e6, 1e6, 8e6, 5e6,
            3e6, 6e6, 4e6, 7e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 1 (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all',
          depth: 1
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 5,
          items: [
            2e6, 2e6, 1e6, 8e6, 5e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 3 (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all',
          depth: 3
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 4,
          items: [
            2e6, 2e6, 1e6, 8e6
          ]
        }
      },

      // wallet by default
      {
        name: 'select all coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 5,
          items: [
            2e6, 2e6, 8e6,
            3e6, 6e6
          ]
        }
      },
      {
        name: 'select all coins + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          smart: true
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 4,
          items: [
            2e6, 2e6, 8e6,
            3e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 0 (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          depth: 0
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 5,
          items: [
            2e6, 2e6, 8e6,
            3e6, 6e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 1 (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          depth: 1
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 3,
          items: [
            2e6, 2e6, 8e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 4 (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          depth: 4
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 2,
          items: [
            2e6, 2e6
          ]
        }
      },

      // wallet by alt
      {
        name: 'select all coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 4,
          items: [
            1e6, 5e6,
            4e6, 7e6
          ]
        }
      },
      {
        name: 'select all coins + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          smart: true
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 3,
          items: [
            1e6, 5e6,
            4e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 0 (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          depth: 0
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 4,
          items: [
            1e6, 5e6,
            4e6, 7e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 1 (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          depth: 1
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 2,
          items: [
            1e6, 5e6
          ]
        }
      },
      {
        name: 'select all coins + depth = 4 (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all',
          depth: 4
        },
        value: 1e6, // should select all regardless.
        expectedOrdered: [],
        expectedSome: {
          count: 1,
          items: [
            1e6
          ]
        }
      }
    ],
    // Existing coins = views + inputs
    // Existing inputs = inputs (no view, needs extra resolving)
    'all + existing inputs': [
      {
        name: 'select all + existing coin (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6],
        expectedSome: {
          count: 9,
          items: [
            2e6, 2e6, 1e6, 8e6, 5e6,
            3e6, 6e6, 4e6, 7e6
          ]
        }
      },
      {
        name: 'select all + existing coin (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6],
        expectedSome: {
          count: 5,
          items: [
            2e6, 2e6, 8e6,
            3e6, 6e6
          ]
        }
      },
      {
        name: 'select all + existing coin (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingCoins: [
          {
            height: -1,
            value: 3e6
          }
        ],
        expectedOrdered: [3e6],
        expectedSome: {
          count: 4,
          items: [
            1e6, 5e6,
            4e6, 7e6
          ]
        }
      },
      {
        name: 'select all + existing input (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingInputs: [8e6],
        expectedOrdered: [8e6],
        expectedSome: {
          count: 8,
          items: [
            2e6, 2e6, 1e6, 5e6,
            3e6, 6e6, 4e6, 7e6
          ]
        }
      },
      {
        name: 'select all + existing input (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingInputs: [8e6],
        expectedOrdered: [8e6],
        expectedSome: {
          count: 4,
          items: [
            2e6, 2e6,
            3e6, 6e6
          ]
        }
      },
      {
        name: 'select all + existing input (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingInputs: [5e6],
        expectedOrdered: [5e6],
        expectedSome: {
          count: 3,
          items: [1e6, 4e6, 7e6]
        }
      },
      {
        name: 'select all + existing input + estimate (wallet)',
        options: {
          account: -1,
          selection: 'all',
          rate: 5e7
        },
        value: 2e6,
        existingInputs: [8e6],
        expectedOrdered: [8e6],
        expectedSome: {
          count: 8,
          items: [
            2e6, 2e6, 1e6, 5e6,
            3e6, 6e6, 4e6, 7e6
          ]
        }
      },
      {
        name: 'fail cross account existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: 'all'
        },
        value: 2e6,
        existingInputs: [5e6], // this belongs to alt account
        error: {
          message: 'Could not resolve preferred inputs.'
        }
      }
    ],
    'sweepdust': [
      // wallet by sweep
      {
        name: 'select 1 coin (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 1e6,
        expectedOrdered: [1e6]
      },
      {
        name: 'select 1 coin, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1
        },
        value: 1e6,
        expectedOrdered: [2e6]
      },
      {
        name: 'select all confirmed coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED,
        expectedOrdered: [1e6, 2e6, 2e6, 5e6, 8e6]
      },
      {
        name: 'select all confirmed coins, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED - 1e6,
        expectedOrdered: [2e6, 2e6, 5e6, 8e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [1e6, 2e6, 2e6, 5e6, 8e6, 3e6]
      },
      {
        name: 'select all confirmed and an unconfirmed, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED - 5e6 + 1e6,
        expectedOrdered: [5e6, 8e6, 3e6]
      },
      {
        name: 'select all coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        expectedOrdered: [1e6, 2e6, 2e6, 5e6, 8e6, 3e6, 4e6, 6e6, 7e6]
      },
      {
        name: 'select all coins, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS - 5e6,
        expectedOrdered: [5e6, 8e6, 3e6, 4e6, 6e6, 7e6]
      },
      {
        // test locked filters.
        name: 'throw funding error (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      },
      {
        // test locked filters.
        name: 'throw funding error, filterall (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 100e6
        },
        value: 1e6,
        error: {
          availableFunds: 0,
          requiredFunds: 1e6,
          type: 'FundingError'
        }
      },

      // default account by value
      {
        name: 'select 1 coin (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 1e6,
        expectedOrdered: [2e6]
      },
      {
        name: 'select 1 coin, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: 2e6,
        expectedOrdered: [8e6]
      },
      {
        name: 'select all confirmed coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_CONFIRMED,
        expectedOrdered: [2e6, 2e6, 8e6]
      },
      {
        name: 'select all confirmed coins, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: 8e6,
        expectedOrdered: [8e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_CONFIRMED + 1e6,
        expectedOrdered: [2e6, 2e6, 8e6, 3e6]
      },
      {
        name: 'select all confirmed and an unconfirmed, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 3e6 + 1
        },
        value: 8e6 + 1e6,
        expectedOrdered: [8e6, 6e6]
      },
      {
        name: 'select all coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_FUNDS,
        expectedOrdered: [2e6, 2e6, 8e6, 3e6, 6e6]
      },
      {
        name: 'select all coins, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 3e6 + 1
        },
        value: 8e6 + 6e6,
        expectedOrdered: [8e6, 6e6]
      },
      {
        // test locked filters.
        name: 'throw funding error (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_0_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_0_FUNDS,
          requiredFunds: ACCT_0_FUNDS + 1e6,
          type: 'FundingError'
        }
      },
      {
        // test locked filters.
        name: 'throw funding error, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: ACCT_0_FUNDS + 1e6 - (4e6),
        error: {
          availableFunds: ACCT_0_FUNDS - 4e6,
          requiredFunds: ACCT_0_FUNDS - 4e6 + 1e6,
          type: 'FundingError'
        }
      },

      // alt account by value
      {
        name: 'select 1 coin (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 1e6,
        expectedOrdered: [1e6]
      },
      {
        name: 'select 1 coin, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1
        },
        value: 1e6,
        expectedOrdered: [5e6]
      },
      {
        name: 'select all confirmed coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_1_CONFIRMED,
        expectedOrdered: [1e6, 5e6]
      },
      {
        name: 'select all confirmed coins, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1
        },
        value: ACCT_1_CONFIRMED - 1e6,
        expectedOrdered: [5e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [1e6, 5e6, 4e6]
      },
      {
        name: 'select all confirmed and an unconfirmed (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 4e6 + 1
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [5e6, 7e6]
      },
      {
        name: 'select all coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_1_FUNDS,
        expectedOrdered: [1e6, 5e6, 4e6, 7e6]
      },
      {
        name: 'select all coins, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 4e6 + 1
        },
        value: ACCT_1_FUNDS - 5e6,
        expectedOrdered: [5e6, 7e6]
      },
      {
        // test locked filters.
        name: 'throw funding error (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_1_FUNDS,
          requiredFunds: ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      },
      {
        // test locked filters.
        name: 'throw funding error (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 4e6 + 1
        },
        value: ACCT_1_FUNDS + 1e6,
        error: {
          availableFunds: ACCT_1_FUNDS - 5e6,
          requiredFunds: ACCT_1_FUNDS + 1e6,
          type: 'FundingError'
        }
      }
    ],
    'sweepdust + smart': [
      // Test smart option.
      // smart selection (wallet)
      {
        name: 'select all confirmed and an unconfirmed + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [1e6, 2e6, 2e6, 5e6, 8e6, 3e6]
      },
      {
        name: 'select all confirmed and an unconfirmed + smart, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 3e6 + 1,
          smart: true
        },
        value: ACCT_0_CONFIRMED + ACCT_1_CONFIRMED + 1e6 - 5e6,
        expectedOrdered: [5e6, 8e6, 4e6]
      },
      {
        name: 'select all coins + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN,
        expectedOrdered: [1e6, 2e6, 2e6, 5e6, 8e6, 3e6, 4e6]
      },
      {
        name: 'select all coins + smart, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 3e6 + 1,
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN - 5e6 - 3e6,
        expectedOrdered: [5e6, 8e6, 4e6]
      },
      {
        name: 'throw funding error + smart (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          type: 'FundingError'
        }
      },
      {
        name: 'throw funding error + smart, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 3e6 + 1,
          smart: true
        },
        value: ACCT_0_FUNDS + ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS + ACCT_1_FUNDS - ACCT_0_FOREIGN - ACCT_1_FOREIGN - 5e6 - 3e6,
          requiredFunds: ACCT_0_FUNDS + ACCT_1_FUNDS,
          type: 'FundingError'
        }
      },
      // smart selection (default)
      {
        name: 'select all confirmed and an unconfirmed + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_0_CONFIRMED + 1e6,
        expectedOrdered: [2e6, 2e6, 8e6, 3e6]
      },
      {
        name: 'select all confirmed and an unconfirmed + smart, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1,
          smart: true
        },
        value: ACCT_0_CONFIRMED + 1e6 - 4e6,
        expectedOrdered: [8e6, 3e6]
      },
      {
        name: 'select all coins + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_0_FUNDS - ACCT_0_FOREIGN,
        expectedOrdered: [2e6, 2e6, 8e6, 3e6]
      },
      {
        name: 'select all coins + smart, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1,
          smart: true
        },
        value: ACCT_0_FUNDS - ACCT_0_FOREIGN - 4e6,
        expectedOrdered: [8e6, 3e6]
      },
      {
        name: 'throw funding error + smart (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_0_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS - ACCT_0_FOREIGN,
          requiredFunds: ACCT_0_FUNDS,
          type: 'FundingError'
        }
      },
      {
        name: 'throw funding error + smart, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1,
          smart: true
        },
        value: ACCT_0_FUNDS,
        error: {
          availableFunds: ACCT_0_FUNDS - ACCT_0_FOREIGN - 4e6,
          requiredFunds: ACCT_0_FUNDS,
          type: 'FundingError'
        }
      },
      // smart selection (alt)
      {
        name: 'select all confirmed and an unconfirmed + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_1_CONFIRMED + 1e6,
        expectedOrdered: [1e6, 5e6, 4e6]
      },
      {
        name: 'select all confirmed and an unconfirmed + smart, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1,
          smart: true
        },
        value: ACCT_1_CONFIRMED + 1e6 - 1e6,
        expectedOrdered: [5e6, 4e6]
      },
      {
        name: 'select all coins + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_1_FUNDS - ACCT_1_FOREIGN,
        expectedOrdered: [1e6, 5e6, 4e6]
      },
      {
        name: 'select all coins + smart, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1,
          smart: true
        },
        value: ACCT_1_FUNDS - ACCT_1_FOREIGN - 1e6,
        expectedOrdered: [5e6, 4e6]
      },
      {
        name: 'throw funding error + smart (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          smart: true
        },
        value: ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_1_FUNDS - ACCT_1_FOREIGN,
          requiredFunds: ACCT_1_FUNDS,
          type: 'FundingError'
        }
      },
      {
        name: 'throw funding error + smart, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1,
          smart: true
        },
        value: ACCT_1_FUNDS,
        error: {
          availableFunds: ACCT_1_FUNDS - ACCT_1_FOREIGN - 1e6,
          requiredFunds: ACCT_1_FUNDS,
          type: 'FundingError'
        }
      }
    ],
    // Existing coins = views + inputs
    // Existing inputs = inputs (no view, needs extra resolving)
    'sweepdust + existing coins and inputs': [
      // existing coins (wallet)
      {
        name: 'select coins + existing coins (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 8e6
          }
        ],
        expectedOrdered: [8e6, 1e6, 2e6]
      },
      {
        name: 'select coins + existing coins, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 8e6
          }
        ],
        expectedOrdered: [8e6, 5e6]
      },
      // existing coins (default)
      {
        name: 'select coins + existing coins (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 7e6
          }
        ],
        expectedOrdered: [7e6, 2e6, 2e6]
      },
      {
        name: 'select coins + existing coins, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 7e6
          }
        ],
        expectedOrdered: [7e6, 8e6]
      },
      // existing coins (alt)
      {
        name: 'select coins + existing coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingCoins: [
          {
            height: -1,
            value: 1e6
          }
        ],
        expectedOrdered: [1e6, 1e6, 5e6, 4e6]
      },
      {
        name: 'select coins + existing inputs (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingInputs: [5e6],
        expectedOrdered: [5e6, 1e6, 2e6, 2e6]
      },
      {
        name: 'select coins + existing inputs, minvalue (wallet)',
        options: {
          account: -1,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: 10e6,
        existingInputs: [5e6],
        expectedOrdered: [5e6, 8e6]
      },
      // existing coins (default)
      {
        name: 'select coins + existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingInputs: [3e6],
        expectedOrdered: [3e6, 2e6, 2e6, 8e6]
      },
      {
        name: 'select coins + existing inputs, minvalue (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 2e6 + 1
        },
        value: 10e6,
        existingInputs: [2e6, 3e6],
        expectedOrdered: [2e6, 3e6, 8e6]
      },
      // existing coins (alt)
      {
        name: 'select coins + existing coins (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingInputs: [4e6],
        expectedOrdered: [4e6, 1e6, 5e6]
      },
      {
        name: 'select coins + existing coins, minvalue (alt)',
        options: {
          account: ALT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST,
          sweepdustMinValue: 1e6 + 1
        },
        value: 9e6,
        existingInputs: [4e6],
        expectedOrdered: [4e6, 5e6]
      },
      // fail existing inputs (cross account)
      {
        name: 'fail cross account existing inputs (default)',
        options: {
          account: DEFAULT_ACCOUNT,
          hardFee: 0,
          selection: DB_SWEEPDUST
        },
        value: 10e6,
        existingInputs: [5e6], // this belongs to alt account
        error: {
          message: 'Could not resolve preferred inputs.'
        }
      }
    ]
  };

  const reselect = (tests, selection) => {
    return tests.map((t) => {
      const options = {
        ...t.options,
        selection
      };

      return {
        ...t,
        options
      };
    });
  };

  // Selection `value` and `dbvalue` are the same.
  SELECTION_TESTS['dbvalue'] = reselect(SELECTION_TESTS['value'], DB_VALUE);
  SELECTION_TESTS['dbvalue + smart'] = reselect(SELECTION_TESTS['value + smart'], DB_VALUE);
  SELECTION_TESTS['dbvalue + existing coins and inputs'] = reselect(
    SELECTION_TESTS['value + existing coins and inputs'], DB_VALUE);

  // Same with `age` and `dbage`.
  SELECTION_TESTS['db-age'] = reselect(SELECTION_TESTS['age'], DB_AGE);
  SELECTION_TESTS['db-age + smart'] = reselect(SELECTION_TESTS['age + smart'], DB_AGE);
  SELECTION_TESTS['db-age + existing inputs'] = reselect(
    SELECTION_TESTS['age + existing inputs'], DB_AGE);

  SELECTION_TESTS['db-all'] = reselect(SELECTION_TESTS['all'], DB_ALL);
  SELECTION_TESTS['db-all + existing inputs'] = reselect(
    SELECTION_TESTS['all + existing inputs'], DB_ALL);

  for (const [name, testCase] of Object.entries(SELECTION_TESTS)) {
  describe(`Wallet Coin Selection by ${name}`, function() {
    // fund wallet.
    const valueByCoin = new BufferMap();
    // This is used for OWN and LOCK descriptions.
    // The values must be unique in the UTXO set.
    const coinByValue = new Map();

    /**
     * Fund the same coin in multiple different ways.
     * @param {OutputInfo} output
     * @returns {OutputInfo[]}
     */

    const fundCoinOptions = (output) => {
      const spendables = [
        Covenant.types.NONE,
        Covenant.types.OPEN,
        Covenant.types.REDEEM
      ];

      const nonSpendables = [
        Covenant.types.BID,
        Covenant.types.REVEAL,
        Covenant.types.REGISTER,
        Covenant.types.UPDATE,
        Covenant.types.RENEW,
        Covenant.types.TRANSFER,
        Covenant.types.FINALIZE,
        Covenant.types.REVOKE
      ];

      const account = output.account || 0;
      const value  = output.value;
      const oneSpendable = spendables[Math.floor(Math.random() * spendables.length)];

      return [{ value, account, covenant: { type: oneSpendable }}]
        .concat(nonSpendables.map(t => ({ value, account, covenant: { type: t }})));
    };

    // NOTE: tests themselves don't modify the wallet state, so before instead
    // of beforeEach should be fine.
    before(async () => {
      await beforeFn();

      valueByCoin.clear();
      coinByValue.clear();

      for (const coinOptions of PER_BLOCK_COINS) {
        const outputInfos = fundCoinOptions(coinOptions);
        const txs = await fundWallet(wallet, outputInfos, {
          txPerOutput: true
        });

        for (const [i, tx] of txs.entries()) {
          if (tx.outputs.length !== 1)
            continue;

          if (tx.output(0).isUnspendable() || tx.output(0).covenant.isNonspendable())
            continue;

          const coin = Coin.fromTX(tx, 0, i + 1);
          valueByCoin.set(coin.toKey(), tx.output(0).value);
          coinByValue.set(tx.output(0).value, coin);
        }
      }

      for (const coinOptions of UNCONFIRMED_COINS) {
        const options = fundCoinOptions(coinOptions);
        const txs = await createInboundTXs(wallet, options);

        for (const tx of txs) {
          await wallet.wdb.addTX(tx);

          if (tx.outputs.length !== 1)
            continue;

          if (tx.output(0).isUnspendable() || tx.output(0).covenant.isNonspendable())
            continue;

          const coin = Coin.fromTX(tx, 0, -1);
          valueByCoin.set(coin.toKey(), tx.output(0).value);
          coinByValue.set(tx.output(0).value, coin);
        }
      }

      for (const value of LOCK) {
        const coin = coinByValue.get(value);
        wallet.lockCoin(coin);
      }

      for (const {account, value} of OWN) {
        const coin = coinByValue.get(value);
        const mtx = new MTX();
        mtx.addOutput(await wallet.receiveAddress(account), value);
        mtx.addCoin(coin);
        await wallet.finalize(mtx);
        await wallet.sign(mtx);
        const tx = mtx.toTX();
        await wdb.addTX(tx);

        valueByCoin.delete(coin.toKey());
        coinByValue.delete(coin.value);

        const ownedCoin = Coin.fromTX(mtx, 0, -1);
        valueByCoin.set(ownedCoin.toKey(), mtx.output(0).value);
        coinByValue.set(mtx.output(0).value, ownedCoin);
      }
    });

    after(afterFn);

    for (const fundingTest of testCase) {
      it(`should ${fundingTest.name}`, async () => {
        const mtx = new MTX();
        mtx.addOutput(randomP2PKAddress(), fundingTest.value);

        if (fundingTest.existingInputs) {
          for (const inputVal of fundingTest.existingInputs) {
            const coin = coinByValue.get(inputVal);
            assert(coin, `Coin not found for value ${inputVal}.`);

            const input = Input.fromCoin(coin);
            mtx.addInput(input);
          }
        }

        if (fundingTest.existingCoins) {
          for (const coinOptions of fundingTest.existingCoins) {
            const coin = primutils.makeCoin(coinOptions);
            valueByCoin.set(coin.toKey(), coin.value);
            mtx.addCoin(coin);
          }
        }

        let err;

        try {
          await wallet.fund(mtx, fundingTest.options);
        } catch (e) {
          err = e;
        }

        if (fundingTest.error) {
          assert(err);
          assert.strictEqual(err.type, fundingTest.error.type);
          assert.strictEqual(err.availableFunds, fundingTest.error.availableFunds);
          assert.strictEqual(err.requiredFunds, fundingTest.error.requiredFunds);

          if (fundingTest.error.message)
            assert.strictEqual(err.message, fundingTest.error.message);
          return;
        }

        assert(!err, err);

        const inputVals = mtx.inputs.map(({prevout}) => valueByCoin.get(prevout.toKey()));

        assert(inputVals.length >= fundingTest.expectedOrdered.length,
          'Not enough inputs selected.');

        assert.deepStrictEqual(
          inputVals.slice(0, fundingTest.expectedOrdered.length),
          fundingTest.expectedOrdered);

        const left = inputVals.slice(fundingTest.expectedOrdered.length);

        if (!fundingTest.expectedSome) {
          assert(left.length === 0, 'Extra inputs selected.');
          return;
        }

        let count = fundingTest.expectedSome.count;
        const items = fundingTest.expectedSome.items.slice();

        for (const value of left) {
          assert(items.includes(value), `Value ${value} not in expected.`);
          assert(count > 0, 'Too many inputs selected.');

          const idx = items.indexOf(value);
          items.splice(idx, 1);
          count--;
        }

        assert(count === 0, 'Not enough inputs selected.');
      });
    }
  });
  }

  describe('Selection types', function() {
    beforeEach(beforeFn);
    afterEach(afterFn);

    it('should select all spendable coins', async () => {
      const spendableCovs = [
        Covenant.types.NONE,
        Covenant.types.OPEN,
        Covenant.types.REDEEM
      ];

      const nonSpendableCovs = [
        Covenant.types.BID,
        Covenant.types.REVEAL,
        Covenant.types.REGISTER,
        Covenant.types.UPDATE,
        Covenant.types.RENEW,
        Covenant.types.TRANSFER,
        Covenant.types.FINALIZE,
        Covenant.types.REVOKE
      ];

      const mkopt = type => ({ value: 1e6, covenant: { type }});
      await fundWallet(wallet, [...nonSpendableCovs, ...spendableCovs].map(mkopt));

      const coins = await wallet.getCoins();
      assert.strictEqual(coins.length, spendableCovs.length + nonSpendableCovs.length);

      const spendables = await collectIter(wallet.getAccountCreditIterByValue(0));
      assert.strictEqual(spendables.length, spendableCovs.length);

      const mtx = new MTX();
      await wallet.fund(mtx, {
        selection: 'all'
      });

      assert.strictEqual(mtx.inputs.length, spendableCovs.length);
    });

    it('should select coin by descending value', async () => {
      const values = [1e6, 4e6, 3e6, 5e6, 2e6];
      await fundWallet(wallet, values.map(value => ({ value })));

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 9e6);

      await wallet.fund(mtx, {
        selection: 'value',
        hardFee: 0
      });

      // 4 + 5
      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 1);
      assert.strictEqual(mtx.outputs[0].value, 9e6);
    });

    it('should select coins by descending age', async () => {
      const values = [1e6, 2e6, 3e6, 4e6, 5e6];

      for (const value of values)
        await fundWallet(wallet, [{ value }]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 9e6);
      await wallet.fund(mtx, {
        selection: 'age',
        hardFee: 0
      });

      // 1 + 2 + 3 + 4 = 10
      assert.strictEqual(mtx.inputs.length, 4);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 9e6);
      assert.strictEqual(mtx.outputs[1].value, 1e6);
    });
  });

  describe('Fees', function() {
    before(beforeFn);
    after(afterFn);

    it('should fund wallet', async () => {
      const vals = [100e6, 10e6, 1e6, 0.1e6, 0.01e6];
      await fundWallet(wallet, vals.map(value => ({ value })));
      const bal = await wallet.getBalance();
      assert.strictEqual(bal.confirmed, 111.11e6);
    });

    it('should pay default fee rate for small tx', async () => {
      const address = await wallet.receiveAddress();
      const mtx = new MTX();
      mtx.addOutput(address, 5e6);
      await wallet.fund(mtx);
      await wallet.sign(mtx);

      assert.strictEqual(mtx.inputs.length, 1);
      assert.strictEqual(mtx.outputs.length, 2);

      const rate = mtx.getRate();
      const fee = mtx.getFee();

      assert.strictEqual(rate, network.feeRate);
      assert(rate < network.maxFeeRate);
      assert(fee > network.minRelay);
    });

    it('should pay default fee rate for maximum policy weight TX', async () => {
      const address = await wallet.receiveAddress();
      const mtx = new MTX();
      for (let i = 0; i < 3120; i++) {
        mtx.addOutput(address, 500);
      }
      // Add nulldata output to add precise amount of extra weight
      mtx.addOutput(
        {
          version: 31,
          hash: Buffer.alloc(38)
        },
        0
      );
      await wallet.fund(mtx);
      await wallet.sign(mtx);

      // This is as close as we can get to
      // policy.MAX_TX_WEIGHT (400000) using standard wallet
      assert.strictEqual(mtx.getWeight(), 399997);
      assert.strictEqual(mtx.inputs.length, 1);

      const rate = mtx.getRate();
      const fee = mtx.getFee();

      assert.strictEqual(fee, 10e6); // 10 HNS

      assert.strictEqual(rate, network.feeRate);
      assert(rate < network.maxFeeRate);
      assert(fee > network.minRelay);
    });

    it('should fail to pay absurd fee rate for small tx', async () => {
      const address = await wallet.receiveAddress();
      let err;

      try {
        await wallet.send({
          outputs: [{
            address,
            value: 5e6
          }],
          rate: (policy.ABSURD_FEE_FACTOR + 1) * network.minRelay
        });
      } catch (e) {
        err = e;
      }

      assert(err, 'Error not thrown.');
      assert.strictEqual(err.message, 'Fee exceeds absurd limit.');
    });

    it('should pay fee just under the absurd limit', async () => {
      const address = await wallet.receiveAddress();
      const tx = await wallet.send({
        outputs: [{
          address,
          value: 5e6
        }],
        rate: 10000 * network.minRelay
      });
      const view = await wallet.getWalletCoinView(tx);
      assert.strictEqual(
        tx.getRate(view),
        policy.ABSURD_FEE_FACTOR * network.minRelay
      );
    });

    it('should fail to pay too-low fee rate for small tx', async () => {
      const address = await wallet.receiveAddress();
      await assert.rejects(
        wallet.send({
          outputs: [{
            address,
            value: 5e6
          }],
          rate: network.minRelay - 1
        }),
        {message: 'Fee is below minimum relay limit.'}
      );
    });

    it('should pay fee at the minimum relay limit', async () => {
      const address = await wallet.receiveAddress();
      const tx = await wallet.send({
        outputs: [{
          address,
          value: 5e6
        }],
        rate: network.minRelay
      });
      const view = await wallet.getWalletCoinView(tx);
      assert.strictEqual(tx.getRate(view), network.minRelay);
    });
  });
});

/**
 * Collect iterator items.
 * @template T
 * @param {AsyncGenerator<T>} iter
 * @returns {Promise<T[]>}
 */

async function collectIter(iter) {
  const items = [];

  for await (const item of iter)
    items.push(item);

  return items;
}

/**
 * @param {Credit[]} credits
 * @returns {Boolean}
 */

function isSortedByValueAsc(credits) {
  for (let i = 1; i < credits.length; i++) {
    const prev = credits[i - 1].coin;
    const cur = credits[i].coin;

    if (prev.height === -1 && cur.height !== -1)
      return false;

    if (prev.height !== -1 && cur.height === -1)
      continue;

    if (prev.value > cur.value)
      return false;
  }

  return true;
}

/**
 * @param {Credit[]} credits
 * @returns {Boolean}
 */

function isSortedByValueDesc(credits) {
  for (let i = 1; i < credits.length; i++) {
    const prev = credits[i - 1].coin;
    const cur = credits[i].coin;

    if (prev.height === -1 && cur.height !== -1)
      return false;

    if (prev.height !== -1 && cur.height === -1)
      continue;

    if (prev.value < cur.value)
      return false;
  }

  return true;
}

/**
 * @param {Credit[]} credits
 * @returns {Boolean}
 */

function isSortedByHeightAsc(credits) {
  for (let i = 1; i < credits.length; i++) {
    let prevHeight = credits[i - 1].coin.height;
    let curHeight = credits[i].coin.height;

    if (prevHeight === -1)
      prevHeight = UNCONFIRMED_HEIGHT;

    if (curHeight === -1)
      curHeight = UNCONFIRMED_HEIGHT;

    if (prevHeight > curHeight)
      return false;
  }

  return true;
}

/**
 * @param {Credit[]} credits
 * @returns {Boolean}
 */

function isSortedByHeightDesc(credits) {
  for (let i = 1; i < credits.length; i++) {
    let prevHeight = credits[i - 1].coin.height;
    let curHeight = credits[i].coin.height;

    if (prevHeight === -1)
      prevHeight = UNCONFIRMED_HEIGHT;

    if (curHeight === -1)
      curHeight = UNCONFIRMED_HEIGHT;

    if (prevHeight < curHeight)
      return false;
  }

  return true;
}
