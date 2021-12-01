/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const CoinView = require('../lib/coins/coinview');
const WalletCoinView = require('../lib/wallet/walletcoinview');
const MTX = require('../lib/primitives/mtx');
const Address = require('../lib/primitives/address');
const Coin = require('../lib/primitives/coin');
const Path = require('../lib/wallet/path');
const common = require('./util/common');

const mtx1json = require('./data/mtx1.json');
const mtx2json = require('./data/mtx2.json');
const mtx1 = MTX.fromJSON(mtx1json);
const mtx2 = MTX.fromJSON(mtx2json);

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

  it('should clone MTX including view', () => {
    const coin1 = new Coin({
      version: 1,
      value: 1000001,
      hash: Buffer.alloc(32, 0x01),
      index: 1
    });

    const coin1alt = new Coin({
      version: 1,
      value: 9999999,
      hash: Buffer.alloc(32, 0x01),
      index: 1
    });

    const coin2 = new Coin({
      version: 1,
      value: 2000002,
      hash: Buffer.alloc(32, 0x02),
      index: 2
    });

    const addr = new Address({
      version: 0,
      hash: Buffer.alloc(20, 0xdb)
    });

    const value = coin1.value + coin2.value;

    const mtx1 = new MTX();
    mtx1.addCoin(coin1);
    mtx1.addCoin(coin2);
    mtx1.addOutput(addr, value);

    // Verify clone including view
    const mtx2 = mtx1.clone();
    assert.deepStrictEqual(mtx1.toJSON(), mtx2.toJSON());
    assert.strictEqual(mtx1.getInputValue(), mtx2.getInputValue());
    assert.strictEqual(mtx1.view.map.size, 2);
    assert.strictEqual(mtx2.view.map.size, 2);

    // Sanity check: verify deep clone by modifying original data
    mtx1.view.remove(coin1.hash);
    assert.notDeepStrictEqual(mtx1.toJSON(), mtx2.toJSON());
    assert.notDeepStrictEqual(mtx1.getInputValue(), mtx2.getInputValue());
    assert.strictEqual(mtx1.view.map.size, 1);
    assert.strictEqual(mtx2.view.map.size, 2);

    mtx1.view.addCoin(coin1alt);
    assert.notDeepStrictEqual(mtx1.toJSON(), mtx2.toJSON());
    assert.notStrictEqual(mtx1.getInputValue(), mtx2.getInputValue());
    assert.strictEqual(mtx1.view.map.size, 2);
    assert.strictEqual(mtx2.view.map.size, 2);
  });
});
