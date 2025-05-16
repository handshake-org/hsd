'use strict';

const assert = require('bsert');
const CoinView = require('../lib/coins/coinview');
const WalletCoinView = require('../lib/wallet/walletcoinview');
const MTX = require('../lib/primitives/mtx');
const Path = require('../lib/wallet/path');
const MemWallet = require('./util/memwallet');
const primutils = require('./util/primitives');
const {randomP2PKAddress, makeCoin} = primutils;

const mtx1json = require('./data/mtx1.json');
const mtx2json = require('./data/mtx2.json');
const mtx3json = require('./data/mtx3.json'); // 2-of-3
const mtx4json = require('./data/mtx4.json'); // 3-of-5
const mtx5json = require('./data/mtx5.json'); // 5-of-9
const mtx6json = require('./data/mtx6.json'); // pkh
const mtx1 = MTX.fromJSON(mtx1json);
const mtx2 = MTX.fromJSON(mtx2json);
const mtx3 = MTX.fromJSON(mtx3json);
const mtx4 = MTX.fromJSON(mtx4json);
const mtx5 = MTX.fromJSON(mtx5json);
const mtx6 = MTX.fromJSON(mtx6json);

describe('MTX', function() {
  it('should serialize wallet coin view', () => {
    const json = mtx1.getJSON('regtest');
    const got = json.inputs[0].path;
    const want = {
      name: 'default',
      account: 0,
      change: false,
      derivation: 'm/44\'/5355\'/0\'/0/0'
    };

    assert.deepStrictEqual(got, want);
  });

  it('should deserialize wallet coin view', () => {
    const view = mtx1.view;
    const input = mtx1.inputs[0];
    const got = view.getPathFor(input);
    const want = new Path();
    want.name = 'default';
    want.account = 0;
    want.branch = 0;
    want.index = 0;

    assert.ok(view instanceof WalletCoinView);
    assert.deepStrictEqual(got, want);
  });

  it('should serialize coin view', () => {
    const json = mtx2.getJSON('regtest');
    const got = json.inputs[0].path;
    const want = undefined;

    assert.deepStrictEqual(got, want);
  });

  it('should deserialize coin view', () => {
    const view = mtx2.view;
    const input = mtx2.inputs[0];
    const got = view.getPathFor(input);
    const want = null;

    assert.ok(view instanceof CoinView);
    assert.deepStrictEqual(got, want);
  });

  describe('Estimate Size', function () {
    // From lib/wallet/wallet.js estimateSize(addr)
    // Here we just skip looking up the account properties by address.
    function estimateSizePKH() {
      let size = 0;

      // Varint witness items length.
      size += 1;

      // varint-len [signature]
      size += 1 + 65;
      // varint-len [key]
      size += 1 + 33;

      return size;
    }

    function estimateMultisig(m, n) {
      return () => {
        let size = 0;

        // Varint witness items length.
        size += 1;

        // OP_0
        size += 1;
        // varint-len [signature] ...
        size += (1 + 65) * m;
        // varint-len [redeem]
        // at 8 pubkeys (n) script size requires 3-byte varInt
        size += n > 7 ? 3 : 1;
        // m value
        size += 1;
        // OP_PUSHDATA0 [key] ...
        size += (1 + 33) * n;
        // n value
        size += 1;
        // OP_CHECKMULTISIG
        size += 1;

        return size;
      };
    }

    it('should estimate size accurately: PKH', async () => {
      const estimate = await mtx6.estimateSize(estimateSizePKH);
      const actual = mtx6.toTX().getVirtualSize();
      assert.strictEqual(estimate, actual);
    });

    it('should estimate size accurately: MULTISIG', async () => {
      let estimate = await mtx3.estimateSize(estimateMultisig(2, 3));
      let actual = mtx3.toTX().getVirtualSize();
      assert.strictEqual(estimate, actual);

      // No custom estimator, should fallback to "wild guess" 2-of-3
      estimate = await mtx3.estimateSize();
      actual = mtx3.toTX().getVirtualSize();
      assert.strictEqual(estimate, actual);

      estimate = await mtx4.estimateSize(estimateMultisig(3, 5));
      actual = mtx4.toTX().getVirtualSize();
      assert.strictEqual(estimate, actual);

      estimate = await mtx5.estimateSize(estimateMultisig(5, 9));
      actual = mtx5.toTX().getVirtualSize();
      assert.strictEqual(estimate, actual);
    });
  });

  describe('Fund with in memory coin selectors', function() {
    const createCoins = (values) => {
      return values.map(value => makeCoin({ value }));
    };

    it('should fund with sorted values', async () => {
      const coins = createCoins([1e6, 2e6, 3e6, 4e6, 5e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 7e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 0
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 7e6);
      assert.strictEqual(mtx.outputs[1].value, 2e6);
    });

    it('should fund with random selection', async () => {
      const coins = createCoins([1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 5e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 1e5,
        selection: 'random'
      });

      assert.strictEqual(mtx.inputs.length, 6);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 5e6);
      assert.strictEqual(mtx.getFee(), 1e5);
      assert.strictEqual(mtx.outputs[1].value, 9e5);
    });

    it('should fund with all selection type', async () => {
      const coins = createCoins([1e6, 2e6, 3e6, 4e6, 5e6, 6e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 2e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 0,
        selection: 'all'
      });

      assert.strictEqual(mtx.inputs.length, 6);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 2e6);
      assert.strictEqual(mtx.getFee(), 0);
      assert.strictEqual(mtx.outputs[1].value, 19e6);
    });

    it('should fund with age-based selection', async () => {
      const coins = [
        makeCoin({ value: 2e6, height: 100 }),
        makeCoin({ value: 3e6, height: 200 }),
        makeCoin({ value: 1e6, height: 50 })
      ];

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 1e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 1e5,
        selection: 'age'
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.getFee(), 1e5);
      // Should select the oldest (lowest height) coins first
      assert.strictEqual(mtx.inputs[0].prevout.hash.equals(coins[2].hash), true);
      assert.strictEqual(mtx.inputs[1].prevout.hash.equals(coins[0].hash), true);
    });

    it('should fund with value-based selection', async () => {
      const coins = [
        makeCoin({ value: 1e6 }),
        makeCoin({ value: 5e6 }),
        makeCoin({ value: 2e6 })
      ];

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 4e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 1e5,
        selection: 'value'
      });

      assert.strictEqual(mtx.inputs.length, 1);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.getFee(), 1e5);
      // Should select the highest value coin first
      assert.strictEqual(mtx.inputs[0].prevout.hash.equals(coins[1].hash), true);
    });

    it('should handle subtractFee option', async () => {
      const coins = createCoins([2e6, 3e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 5e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 1e5,
        subtractFee: true
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 1);
      assert.strictEqual(mtx.outputs[0].value, 4.9e6); // 5e6 - 1e5 = 4.9e6
      assert.strictEqual(mtx.getFee(), 1e5);
    });

    it('should handle subtractIndex option', async () => {
      const coins = createCoins([3e6, 3e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 3e6);
      mtx.addOutput(randomP2PKAddress(), 3e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 2e5,
        subtractFee: true,
        subtractIndex: 1
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 3e6);
      assert.strictEqual(mtx.outputs[1].value, 2.8e6); // 3e6 - 2e5 = 2.8e6
      assert.strictEqual(mtx.getFee(), 2e5);
    });

    it('should throw with insufficient funds', async () => {
      const coins = createCoins([1e6, 1e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 5e6);

      let err;
      try {
        await mtx.fund(coins, {
          changeAddress: randomP2PKAddress(),
          hardFee: 0
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message.includes('Not enough funds'), true);
    });

    it('should throw when fee is too high', async () => {
      const coins = createCoins([1e6, 1e6, 1e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 2e6);

      let err;
      try {
        await mtx.fund(coins, {
          changeAddress: randomP2PKAddress(),
          rate: 1e6, // Extremely high fee rate
          maxFee: 1e5 // But with a low maxFee
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message.includes('Fee is too high'), true);
    });

    it('should handle dust change', async () => {
      const coins = createCoins([1e6, 1e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 1.999e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 1e3
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 1);
      assert.strictEqual(mtx.getFee(), 1e3);
      assert.strictEqual(mtx.changeIndex, -1);
    });

    it('should fund with exact amount needed', async () => {
      const coins = createCoins([1e6, 2e6, 3e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 3e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 0
      });

      assert.strictEqual(mtx.inputs.length, 1);
      assert.strictEqual(mtx.outputs.length, 1);
      assert.strictEqual(mtx.outputs[0].value, 3e6);
      assert.strictEqual(mtx.getFee(), 0);
      assert.strictEqual(mtx.changeIndex, -1);
    });

    it('should add coin based on minimum required', async () => {
      const wallet = new MemWallet();
      const coins = [
        makeCoin({ address: wallet.getAddress(), value: 1e5 }),
        makeCoin({ address: wallet.getAddress(), value: 2e5 }),
        makeCoin({ address: wallet.getAddress(), value: 5e5 }),
        makeCoin({ address: wallet.getAddress(), value: 1e6 }),
        makeCoin({ address: wallet.getAddress(), value: 2e6 })
      ];

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 1.5e6);

      await mtx.fund(coins, {
        changeAddress: wallet.getChange(),
        hardFee: 1e4
      });

      // Should select the 2e6 coin (largest value first selection)
      assert.strictEqual(mtx.inputs.length, 1);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 1.5e6);
      assert.strictEqual(mtx.outputs[1].value, 2e6 - 1.5e6 - 1e4);
      assert.bufferEqual(mtx.inputs[0].prevout.hash, coins[4].hash);
    });

    it('should combine multiple coins when necessary', async () => {
      const coins = createCoins([1e5, 2e5, 3e5, 4e5, 5e5]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 1e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 5e4
      });

      // Should need to combine multiple coins to reach 1e6 + 5e4
      assert.ok(mtx.inputs.length > 1);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 1e6);
      assert.strictEqual(mtx.getFee(), 5e4);
    });

    it('should correctly set changeIndex', async () => {
      const coins = createCoins([5e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 2e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        hardFee: 1e5
      });

      assert.strictEqual(mtx.inputs.length, 1);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.changeIndex, 1);
      assert.strictEqual(mtx.outputs[1].value, 2.9e6); // 5e6 - 2e6 - 1e5 = 2.9e6
    });

    it('should handle fee rates properly', async () => {
      const coins = createCoins([1e6, 2e6, 3e6]);

      const mtx = new MTX();
      mtx.addOutput(randomP2PKAddress(), 4e6);

      await mtx.fund(coins, {
        changeAddress: randomP2PKAddress(),
        rate: 5000 // dollarydoos per kb
      });

      // The exact fee will depend on the estimated tx size
      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.ok(mtx.getFee() > 0);
      assert.ok(mtx.getFee() < 1e5); // Reasonable upper bound for test
    });
  });

  describe('Fund preferred & existing', function() {
    const wallet1 = new MemWallet();
    const wallet2 = new MemWallet();

    const coins1 = [
      makeCoin({ address: wallet1.getAddress(), value: 1000000 }),
      makeCoin({ address: wallet1.getAddress(), value: 1000000 }),
      makeCoin({ address: wallet1.getAddress(), value: 1000000 }),
      makeCoin({ address: wallet1.getAddress(), value: 1000000 }),
      makeCoin({ address: wallet1.getAddress(), value: 1000000 })
    ];

    const last1 = coins1[coins1.length - 1];
    const last2 = coins1[coins1.length - 2];

    /**
     * Test matrix
     * fund w/o inputs, just coins
     * fund with preferred inputs - no view && coins
     * fund with preferred inputs - view    && no coins
     * fund with preferred inputs - view    && coins
     * fund with preferred inputs - no view && coins - error
     *
     * fund with existing inputs  - no view && coins
     * fund with existing inputs  - view    && no coins
     * fund with existing inputs  - view    && coins
     * fund with existing inputs  - no view && no coins - error
     *
     * fund with both inputs - no view && coins(1e, 1p)
     * fund with both inputs - view(1e, 1p) && no coins
     * fund with both inputs - view(1e, 1p) && coins(1e, 1p)
     * fund with both inputs (1e, 1p) - no view(1e) && no coins(1e) - error.
     * fund with both inputs (1e, 1p) - no view(1p) && no coins(1p) - error.
     * fund with both inputs (1e, 1p) - no view && no coins - error.
     */

    it('should fund mtx', async () => {
      const mtx = new MTX();

      mtx.addOutput(wallet2.getAddress(), 1500000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange()
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);
    });

    it('should add all preferred coins regardless of value', async () => {
      const mtx = new MTX();

      // 1 preferred is enough.
      mtx.addOutput(wallet2.getAddress(), 1000000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        hardFee: 0,

        // Use all coins as preferred, but one.
        inputs: coins1.slice(0, -1).map(coin => ({
          hash: coin.hash,
          index: coin.index
        }))
      });

      // all of them got used.
      assert.strictEqual(mtx.inputs.length, coins1.length - 1);
      assert.strictEqual(mtx.outputs.length, 2);
      assert.strictEqual(mtx.outputs[0].value, 1000000);
      assert.strictEqual(mtx.outputs[1].value, 3000000);
    });

    it('should fund with preferred inputs - coins', async () => {
      const mtx = new MTX();
      const coin = last1;

      mtx.addOutput(wallet2.getAddress(), 1500000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        inputs: [{
          hash: coin.hash,
          index: coin.index
        }]
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin.index);

      assert(mtx.view.hasEntry({
        hash: coin.hash,
        index: coin.index
      }));
    });

    it('should fund with preferred inputs - view', async () => {
      const mtx = new MTX();
      const coin = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });

      mtx.addOutput(wallet2.getAddress(), 1500000);
      mtx.view.addCoin(coin);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        inputs: [{
          hash: coin.hash,
          index: coin.index
        }]
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin.index);

      assert(mtx.view.hasEntry({
        hash: coin.hash,
        index: coin.index
      }));
    });

    it('should fund with preferred inputs - coins && view', async () => {
      const mtx = new MTX();
      const viewCoin = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const lastCoin = last1;

      mtx.addOutput(wallet2.getAddress(), 1500000);
      mtx.view.addCoin(viewCoin);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        inputs: [{
          hash: viewCoin.hash,
          index: viewCoin.index
        }, {
          hash: last1.hash,
          index: last1.index
        }]
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, viewCoin.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, viewCoin.index);
      assert.bufferEqual(mtx.inputs[1].prevout.hash, lastCoin.hash);
      assert.strictEqual(mtx.inputs[1].prevout.index, lastCoin.index);

      assert(mtx.view.hasEntry({
        hash: viewCoin.hash,
        index: viewCoin.index
      }));

      assert(mtx.view.hasEntry({
        hash: lastCoin.hash,
        index: lastCoin.index
      }));
    });

    it('should not fund with preferred inputs and no coin info', async () => {
      const mtx = new MTX();
      const coin = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });

      mtx.addOutput(wallet2.getAddress(), 1500000);

      let err;

      try {
        await mtx.fund(coins1, {
          changeAddress: wallet1.getChange(),
          inputs: [{
            hash: coin.hash,
            index: coin.index
          }]
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Could not resolve preferred inputs.');
    });

    it('should fund with existing inputs view - coins', async () => {
      const mtx = new MTX();
      const coin = last1;

      mtx.addInput({
        prevout: {
          hash: coin.hash,
          index: coin.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 1500000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange()
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin.index);

      assert(mtx.view.hasEntry({
        hash: coin.hash,
        index: coin.index
      }));
    });

    it('should fund with existing inputs view - view', async () => {
      const mtx = new MTX();
      const coin = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });

      mtx.addInput({
        prevout: {
          hash: coin.hash,
          index: coin.index
        }
      });

      mtx.view.addCoin(coin);

      mtx.addOutput(wallet2.getAddress(), 1500000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange()
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin.index);

      assert(mtx.view.hasEntry({
        hash: coin.hash,
        index: coin.index
      }));
    });

    it('should fund with existing inputs view - coins && view', async () => {
      const mtx = new MTX();
      const viewCoin = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const lastCoin = last1;

      mtx.addInput({
        prevout: {
          hash: viewCoin.hash,
          index: viewCoin.index
        }
      });

      mtx.addInput({
        prevout: {
          hash: last1.hash,
          index: last1.index
        }
      });

      mtx.view.addCoin(viewCoin);

      mtx.addOutput(wallet2.getAddress(), 1500000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange()
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, viewCoin.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, viewCoin.index);
      assert.bufferEqual(mtx.inputs[1].prevout.hash, lastCoin.hash);
      assert.strictEqual(mtx.inputs[1].prevout.index, lastCoin.index);

      assert(mtx.view.hasEntry({
        hash: viewCoin.hash,
        index: viewCoin.index
      }));

      assert(mtx.view.hasEntry({
        hash: lastCoin.hash,
        index: lastCoin.index
      }));
    });

    it('should not fund with existing inputs and no coin info', async () => {
      const mtx = new MTX();
      const coin = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });

      mtx.addInput({
        prevout: {
          hash: coin.hash,
          index: coin.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 1500000);

      let err;

      try {
        await mtx.fund(coins1, {
          changeAddress: wallet1.getChange()
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Could not resolve preferred inputs.');
    });

    it('should fund with preferred & existing inputs - coins', async () => {
      const mtx = new MTX();
      const coin1 = last1;
      const coin2 = last2;

      mtx.addInput({
        prevout: {
          hash: coin1.hash,
          index: coin1.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 1500000);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        inputs: [{
          hash: coin2.hash,
          index: coin2.index
        }]
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin1.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin1.index);
      assert.bufferEqual(mtx.inputs[1].prevout.hash, coin2.hash);
      assert.strictEqual(mtx.inputs[1].prevout.index, coin2.index);

      assert(mtx.view.hasEntry({
        hash: coin1.hash,
        index: coin1.index
      }));

      assert(mtx.view.hasEntry({
        hash: coin2.hash,
        index: coin2.index
      }));
    });

    it('should fund with preferred & existing inputs - view', async () => {
      const mtx = new MTX();
      const coin1 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coin2 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });

      mtx.addInput({
        prevout: {
          hash: coin1.hash,
          index: coin1.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 1500000);
      mtx.view.addCoin(coin1);
      mtx.view.addCoin(coin2);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        inputs: [{
          hash: coin2.hash,
          index: coin2.index
        }]
      });

      assert.strictEqual(mtx.inputs.length, 2);
      assert.strictEqual(mtx.outputs.length, 2);

      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin1.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin1.index);
      assert.bufferEqual(mtx.inputs[1].prevout.hash, coin2.hash);
      assert.strictEqual(mtx.inputs[1].prevout.index, coin2.index);

      assert(mtx.view.hasEntry({
        hash: coin1.hash,
        index: coin1.index
      }));

      assert(mtx.view.hasEntry({
        hash: coin2.hash,
        index: coin2.index
      }));
    });

    it('should fund with preferred & existing inputs', async () => {
      const mtx = new MTX();
      // existing
      const coin1 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast1 = last1;

      // preferred
      const coin2 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast2 = last2;

      mtx.addInput({
        prevout: {
          hash: coin1.hash,
          index: coin1.index
        }
      });
      mtx.addInput({
        prevout: {
          hash: coinLast1.hash,
          index: coinLast1.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 5000000);
      mtx.view.addCoin(coin1);
      mtx.view.addCoin(coin2);

      await mtx.fund(coins1, {
        changeAddress: wallet1.getChange(),
        inputs: [{
          hash: coin2.hash,
          index: coin2.index
        }, {
          hash: coinLast2.hash,
          index: coinLast2.index
        }]
      });

      assert.strictEqual(mtx.inputs.length, 6);
      assert.strictEqual(mtx.outputs.length, 2);

      // first comes existing
      assert.bufferEqual(mtx.inputs[0].prevout.hash, coin1.hash);
      assert.strictEqual(mtx.inputs[0].prevout.index, coin1.index);
      assert.bufferEqual(mtx.inputs[1].prevout.hash, coinLast1.hash);
      assert.strictEqual(mtx.inputs[1].prevout.index, coinLast1.index);

      // then comes preferred
      assert.bufferEqual(mtx.inputs[2].prevout.hash, coin2.hash);
      assert.strictEqual(mtx.inputs[2].prevout.index, coin2.index);
      assert.bufferEqual(mtx.inputs[3].prevout.hash, coinLast2.hash);
      assert.strictEqual(mtx.inputs[3].prevout.index, coinLast2.index);

      assert(mtx.view.hasEntry({
        hash: coin1.hash,
        index: coin1.index
      }));

      assert(mtx.view.hasEntry({
        hash: coin2.hash,
        index: coin2.index
      }));

      assert(mtx.view.hasEntry({
        hash: coinLast1.hash,
        index: coinLast1.index
      }));

      assert(mtx.view.hasEntry({
        hash: coinLast2.hash,
        index: coinLast2.index
      }));
    });

    it('should not fund with missing coin info (both)', async () => {
      const mtx = new MTX();
      // existing
      const coin1 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast1 = last1;

      // preferred
      const coin2 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast2 = last2;

      mtx.addInput({
        prevout: {
          hash: coin1.hash,
          index: coin1.index
        }
      });
      mtx.addInput({
        prevout: {
          hash: coinLast1.hash,
          index: coinLast1.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 5000000);

      let err;
      try {
        await mtx.fund(coins1, {
          changeAddress: wallet1.getChange(),
          inputs: [{
            hash: coin2.hash,
            index: coin2.index
          }, {
            hash: coinLast2.hash,
            index: coinLast2.index
          }]
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      // inputs are resolved first, so it should throw there.
      assert.strictEqual(err.message, 'Could not resolve preferred inputs.');
    });

    it('should not fund with missing coin info(only existing)', async () => {
      const mtx = new MTX();
      // existing
      const coin1 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast1 = last1;

      // preferred
      const coin2 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast2 = last2;

      mtx.addInput({
        prevout: {
          hash: coin1.hash,
          index: coin1.index
        }
      });
      mtx.addInput({
        prevout: {
          hash: coinLast1.hash,
          index: coinLast1.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 5000000);
      mtx.view.addCoin(coin1);

      let err;
      try {
        await mtx.fund(coins1, {
          changeAddress: wallet1.getChange(),
          inputs: [{
            hash: coin2.hash,
            index: coin2.index
          }, {
            hash: coinLast2.hash,
            index: coinLast2.index
          }]
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      // preferred is missing.
      assert.strictEqual(err.message, 'Could not resolve preferred inputs.');
    });

    it('should not fund with missing coin info(only preferred)', async () => {
      const mtx = new MTX();
      // existing
      const coin1 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast1 = last1;

      // preferred
      const coin2 = makeCoin({
        address: wallet1.getAddress(),
        value: 1000000
      });
      const coinLast2 = last2;

      mtx.addInput({
        prevout: {
          hash: coin1.hash,
          index: coin1.index
        }
      });
      mtx.addInput({
        prevout: {
          hash: coinLast1.hash,
          index: coinLast1.index
        }
      });

      mtx.addOutput(wallet2.getAddress(), 5000000);
      mtx.view.addCoin(coin2);

      let err;
      try {
        await mtx.fund(coins1, {
          changeAddress: wallet1.getChange(),
          inputs: [{
            hash: coin2.hash,
            index: coin2.index
          }, {
            hash: coinLast2.hash,
            index: coinLast2.index
          }]
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      // preferred is missing.
      assert.strictEqual(err.message, 'Could not resolve preferred inputs.');
    });
  });
});
