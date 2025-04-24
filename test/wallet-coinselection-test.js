'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const Covenant = require('../lib/primitives/covenant');
const WalletDB = require('../lib/wallet/walletdb');
const policy = require('../lib/protocol/policy');
const wutils = require('./util/wallet');
const {nextBlock} = wutils;
const primutils = require('./util/primitives');
const {coinbaseInput, dummyInput} = primutils;

/** @typedef {import('../lib/wallet/wallet')} Wallet */
/** @typedef {import('../lib/covenants/rules').types} covenantTypes */

// Use main instead of regtest because (deprecated)
// CoinSelector.MAX_FEE was network agnostic
const network = Network.get('main');

describe('Wallet Coin Selection', function () {
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
  };

  const afterFn = async () => {
    network.txStart = TX_START_BAK;
    await wdb.close();

    wdb = null;
    wallet = null;
  };

  describe('Selection types', function () {
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
      mtx.addOutput(primutils.randomP2PKAddress(), 9e6);

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
      mtx.addOutput(primutils.randomP2PKAddress(), 9e6);
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

  describe('Fees', function () {
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
  if (!outputInfo.address)
    outputInfo.address = await wallet.receiveAddress();

  return primutils.makeOutput(outputInfo);
}

/**
 * @param {Wallet} wallet
 * @param {OutputInfo[]} outputInfos
 */

async function fundWallet(wallet, outputInfos) {
  assert(Array.isArray(outputInfos));

  let hadCoinbase = false;

  const txs = [];
  for (const info of outputInfos) {
    const mtx = new MTX();

    if (info.coinbase && hadCoinbase)
      throw new Error('Coinbase already added.');

    if (info.coinbase && !hadCoinbase) {
      hadCoinbase = true;
      mtx.addInput(coinbaseInput());
    } else {
      mtx.addInput(dummyInput());
    }

    const output = await mkOutput(wallet, info);
    mtx.addOutput(output);

    if (output.covenant.isLinked())
      mtx.addInput(dummyInput());

    txs.push(mtx.toTX());
  }

  await wallet.wdb.addBlock(nextBlock(wallet.wdb), txs);
}
