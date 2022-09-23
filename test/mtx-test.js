'use strict';

const assert = require('bsert');
const CoinView = require('../lib/coins/coinview');
const WalletCoinView = require('../lib/wallet/walletcoinview');
const MTX = require('../lib/primitives/mtx');
const Path = require('../lib/wallet/path');

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
});
