/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const BN = require('bcrypto/lib/bn.js');

describe('Consensus', function() {
  it('should calculate reward properly', () => {
    let height = 0;
    let total = 0;

    for (;;) {
      const reward = consensus.getReward(height, 170000);
      assert(reward <= consensus.COIN * 2000);
      total += reward;
      if (reward === 0)
        break;
      height++;
    }

    assert.strictEqual(height, 5270000);
    assert.strictEqual(total, 679999997790000);
  });

  it('should verify proof-of-work', () => {
    const bits = 0x1900896c;

    const hash = Buffer.from(
      '0000000000000000348f8ef340a84844aaa09b067141ea6742991ab11b3f2b67',
      'hex'
    );

    assert(consensus.verifyPOW(hash, bits));
  });

  it('should convert bits to target', () => {
    const bits = 0x1900896c;
    const target = consensus.fromCompact(bits);
    const expected = new BN(
      '0000000000000000896c00000000000000000000000000000000000000000000',
      'hex');

    assert.strictEqual(target.toString('hex'), expected.toString('hex'));
  });

  it('should convert target to bits', () => {
    const target = new BN(
      '0000000000000000896c00000000000000000000000000000000000000000000',
      'hex');

    const bits = consensus.toCompact(target);
    const expected = 0x1900896c;

    assert.strictEqual(bits, expected);
  });

  it('should check version bit', () => {
    assert(consensus.hasBit(0x20000001, 0));
    assert(!consensus.hasBit(0x20000000, 0));
    assert(consensus.hasBit(0x10000001, 0));
    assert(consensus.hasBit(0x20000003, 1));
    assert(consensus.hasBit(0x20000003, 0));
  });
});
