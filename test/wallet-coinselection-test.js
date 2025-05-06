'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const Covenant = require('../lib/primitives/covenant');
const WalletDB = require('../lib/wallet/walletdb');
const policy = require('../lib/protocol/policy');
const wutils = require('./util/wallet');
const {nextBlock, curBlock} = wutils;
const primutils = require('./util/primitives');
const {coinbaseInput, dummyInput, randomP2PKAddress} = primutils;

/** @typedef {import('../lib/wallet/wallet')} Wallet */
/** @typedef {import('../lib/covenants/rules').types} covenantTypes */
/** @typedef {import('../lib/primitives/output')} Output */
/** @typedef {import('../lib/primitives/tx')} TX */

// Use main instead of regtest because (deprecated)
// CoinSelector.MAX_FEE was network agnostic
const network = Network.get('main');

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
  describe.only(`Coin Selection Indexes (${indexType})`, function() {
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
            return collectIter(wallet.getAccountCreditIterByHeight(acct, opts));;
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
      const txs = await createInboundTXs(wallet, TX_OPTIONS, false);
      await wallet.wdb.addTX(txs[0]);

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
      await fundWallet(wallet, TX_OPTIONS, false);

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
        assert.strictEqual(credit.coin.height, curBlock(wdb).height);
        assert.strictEqual(credit.spent, true);
      }
    });

    it('should index insert (block) tx output', async () => {
      await fundWallet(wallet, TX_OPTIONS, false);
      const currentBlock = curBlock(wdb);

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
        assert.strictEqual(credit.coin.height, currentBlock.height);
        assert.strictEqual(credit.spent, false);
      }
    });

    it('should index insert (block) tx input', async () => {
      await fundWallet(wallet, TX_OPTIONS, false);
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
      const txs = await createInboundTXs(wallet, TX_OPTIONS, false);
      await wdb.addTX(txs[0]);

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
      await fundWallet(wallet, TX_OPTIONS, false);
      const currentBlock = curBlock(wdb);

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
        assert.strictEqual(credit.coin.height, currentBlock.height);
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
      await fundWallet(wallet, TX_OPTIONS, false);

      const currentBlock = curBlock(wdb);

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

      // disconnect last block.
      await wdb.removeBlock(currentBlock);

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
      await fundWallet(wallet, TX_OPTIONS, false);
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

      await wdb.removeBlock(curBlock(wdb));

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
        assert.strictEqual(credit.coin.height, createCoinHeight);
        assert.strictEqual(credit.spent, true);
      }
    });

    it('should index erase tx output', async () => {
      const txs = await createInboundTXs(wallet, TX_OPTIONS, false);
      await wdb.addTX(txs[0]);

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

      // double spend original tx.
      const mtx = new MTX();
      mtx.addInput(txs[0].inputs[0]);
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
      const txs = await createInboundTXs(wallet, TX_OPTIONS, false);
      await wdb.addTX(txs[0]);

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
      mtx.addInput(txs[0].inputs[0]);
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
      txOptions[0].coinbase = true;
      const txs = await fundWallet(wallet, txOptions, false);
      assert(txs[0].isCoinbase());
      assert.strictEqual(txs.length, 1);

      const currentBlock = curBlock(wdb);

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

      await wdb.removeBlock(currentBlock);

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
      await fundWallet(wallet, txOptionsConfirmed, false);

      const txOptionsUnconfirmed = [
        { value: 8e6 },
        { value: 3e6 },
        { value: 6e6, account: ALT_ACCOUNT },
        { value: 1e6, account: ALT_ACCOUNT }
      ];
      const txs = await createInboundTXs(wallet, txOptionsUnconfirmed, false);
      await wdb.addTX(txs[0]);

      const sum0 = 3e6 + 4e6 + 7e6 + 8e6;
      const sum1 = 1e6 + 2e6 + 5e6 + 6e6;

      const credits0 = await getCredits(wallet);
      assert.strictEqual(credits0.length, 4);
      assert(isSorted(credits0), 'Credits not sorted.');
      assert(sumCredits(credits0) === sum0);

      const credits1 = await getCredits(wallet, 1);
      assert.strictEqual(credits1.length, 4);
      assert(isSorted(credits1), 'Credits not sorted.');
      assert(sumCredits(credits1) === sum1);

      const both = await getCredits(wallet, -1);
      assert.strictEqual(both.length, 8);
      assert(isSorted(both), 'Credits not sorted.');
      assert(sumCredits(both) === sum0 + sum1);
    });
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
      const values = [5e6, 4e6, 3e6, 2e6, 1e6];
      await fundWallet(wallet, values.map(value => ({ value })));

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 9e6);

      await wallet.fund(mtx, {
        selection: 'value',
        hardFee: 0
      });

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
 * @typedef {Object} OutputInfo
 * @property {String} [address]
 * @property {Number} [account=0] - address generation account.
 * @property {Number} [value]
 * @property {covenantTypes} [covenant]
 * @property {Boolean} [coinbase=false]
 */

/**
 * @param {Wallet} wallet
 * @param {primutils.OutputOptions} outputInfo
 * @returns {Promise<Output>}
 */

async function mkOutput(wallet, outputInfo) {
  const info = { ...outputInfo };

  if (!info.address)
    info.address = await wallet.receiveAddress(outputInfo.account || 0);

  return primutils.makeOutput(info);
}

/**
 * Create funding MTXs for a wallet.
 * @param {Wallet} wallet
 * @param {OutputInfo[]} outputInfos
 * @param {Boolean} [txPerOutput=true]
 * @returns {Promise<TX[]>}
 */
async function createInboundTXs(wallet, outputInfos, txPerOutput = true) {
  assert(Array.isArray(outputInfos));

  let hadCoinbase = false;

  const txs = [];

  let mtx = new MTX();

  for (const info of outputInfos) {
    if (txPerOutput)
      mtx = new MTX();

    if (info.coinbase && hadCoinbase)
      throw new Error('Coinbase already added.');

    if (info.coinbase && !hadCoinbase) {
      hadCoinbase = true;
      mtx.addInput(coinbaseInput());
    } else if (!hadCoinbase) {
      mtx.addInput(dummyInput());
    }

    const output = await mkOutput(wallet, info);
    mtx.addOutput(output);

    if (output.covenant.isLinked())
      mtx.addInput(dummyInput());

    if (txPerOutput)
      txs.push(mtx.toTX());
  }

  if (!txPerOutput)
    txs.push(mtx.toTX());

  return txs;
}

/**
 * @param {Wallet} wallet
 * @param {OutputInfo[]} outputInfos
 * @param {Boolean} [txPerOutput=true]
 * @returns {Promise<TX[]>}
 */

async function fundWallet(wallet, outputInfos, txPerOutput = true) {
  const txs = await createInboundTXs(wallet, outputInfos, txPerOutput);
  await wallet.wdb.addBlock(nextBlock(wallet.wdb), txs);
  return txs;
}

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
    const isSorted = isSortedValueAsc(credits[i - 1].coin, credits[i].coin);

    if (!isSorted)
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
    const isSorted = sortValue(credits[i].coin, credits[i - 1].coin);

    if (isSorted < 0)
      return false;
  }

  return true;
};

/**
 * @param {Credit[]} credits
 * @returns {Boolean}
 */

function isSortedByHeightAsc(credits) {
  for (let i = 1; i < credits.length; i++) {
    if (credits[i].coin.height > credits[i - 1].coin.height)
      return false;
  }

  return true;
};

/**
 * @param {Credit[]} credits
 * @returns {Boolean}
 */

function isSortedByHeightDesc(credits) {
  for (let i = 1; i < credits.length; i++) {
    if (credits[i].coin.height < credits[i - 1].coin.height)
      return false;
  }

  return true;
};

/**
 * @param {Coin} a
 * @param {Coin} b
 * @returns {Boolean}
 */

function isSortedValueAsc(a, b) {
  if (a.height === -1 && b.height !== -1)
    return false;

  if (a.height !== -1 && b.height === -1)
    return true;

  return (b.value - a.value) > 0;
}

/**
 * @param {Coin} a
 * @param {Coin} b
 * @returns {Number}
 */

function sortValue(a, b) {
  if (a.height === -1 && b.height !== -1)
    return 1;

  if (a.height !== -1 && b.height === -1)
    return -1;

  return b.value - a.value;
}
