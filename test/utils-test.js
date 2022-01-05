'use strict';

const assert = require('bsert');
const Amount = require('../lib/ui/amount');
const fixed = require('../lib/utils/fixed');
const {COIN} = require('../lib/protocol/consensus');

const toFromVectors = [
  {
    value: 5460, // doos
    units: {
      doo: [5460, '5460'],
      uhns: [5460, '5460'],
      mhns: [5.46, '5.46'],
      hns: [0.00546, '0.00546']
    }
  },
  {
    value: 54678 * 1000000,
    units: {
      doo: [54678 * 1000000, '54678000000'],
      uhns: [54678 * 1000000, '54678000000'],
      mhns: [54678 * 1000, '54678000.0'],
      hns: [54678, '54678.0']
    }
  }
];

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

  it('should convert Amount from units', () => {
    for (const vector of toFromVectors) {
      const units = Object.keys(vector.units);

      for (const unit of units) {
        const numAmount = Amount.from(unit, vector.units[unit][0]);
        const strAmount = Amount.from(unit, vector.units[unit][1]);

        assert.strictEqual(numAmount.toValue(), vector.value,
          `Amount.from(${unit}, ${vector.units[unit][0]}) is not ${vector.value}.`
        );

        assert.strictEqual(strAmount.toValue(), vector.value,
          `Amount.from(${unit}, '${vector.units[unit][1]}') is not ${vector.value}.`
        );
      }
    }
  });

  it('should convert Amount to units', () => {
    for (const vector of toFromVectors) {
      const units = Object.keys(vector.units);
      const amount = Amount.fromValue(vector.value);

      for (const unit of units) {
        const numValue = amount.to(unit, true);
        const strValue = amount.to(unit, false);

        assert.strictEqual(numValue, vector.units[unit][0],
          `Amount(${vector.value}).to(${unit}, true) is not ${vector.units[unit][0]}.`
        );

        assert.strictEqual(strValue, vector.units[unit][1],
          `Amount(${vector.value}).to(${unit}, false) is not '${vector.units[unit][1]}'.`
        );
      }
    }
  });
});
