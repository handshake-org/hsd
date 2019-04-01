/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Amount = require('../lib/ui/amount');
const fixed = require('../lib/utils/fixed');
const {COIN} = require('../lib/protocol/consensus');

describe('Utils', function() {
  it('should convert dollarydoos to hns', () => {
    assert.strictEqual(Amount.coin(5460), '0.00546');
    assert.strictEqual(Amount.coin(54678 * 1000000), '54678.0');
    assert.strictEqual(Amount.coin(5460 * 10000000), '54600.0');
  });

  it('should convert hns to dollarydoos', () => {
    assert.strictEqual(Amount.value('0.00546'), 5460);
    assert.strictEqual(Amount.value('54678'), 54678 * 1000000);
    assert.strictEqual(Amount.value('54600'), 5460 * 10000000);
    assert.strictEqual(Amount.value('54600'), 5460 * 10000000);
    assert.strictEqual(Amount.value('54600.00'), 5460 * 10000000);

    assert.doesNotThrow(() => {
      Amount.value('546.000000');
    });

    assert.throws(() => {
      Amount.value('546.0000001');
    });

    assert.doesNotThrow(() => {
      Amount.value('9007199254.740991');
    });

    assert.doesNotThrow(() => {
      Amount.value('09007199254.7409910');
    });

    assert.throws(() => {
      Amount.value('9007199254.740992');
    });

    assert.throws(() => {
      Amount.value('19007199254.740991');
    });

    assert.strictEqual(0.15645647 * COIN, 156456.46999999997);
    assert.strictEqual(parseFloat('0.15645647') * COIN, 156456.46999999997);
    assert.strictEqual(15645647 / COIN, 15.645647);

    assert.strictEqual(fixed.decode('0.15645647', 8), 15645647);
    assert.strictEqual(fixed.encode(15645647, 8), '0.15645647');
    assert.strictEqual(fixed.fromFloat(0.15645647, 8), 15645647);
    assert.strictEqual(fixed.toFloat(15645647, 8), 0.15645647);
  });
});
