/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('../util/assert');
const Address = require('../../lib/primitives/address');

describe('Address', function() {
  it('should match mainnet p2pkh address', () => {
    const raw = '6d5571fdbca1019cd0f0cd792d1b0bdfa7651c7e';
    const p2pkh = Buffer.from(raw, 'hex');
    const addr = Address.fromPubkeyhash(p2pkh);
    const expect = 'hs1qd42hrldu5yqee58se4uj6xctm7nk28r70e84vx';
    assert.strictEqual(addr.toString('main'), expect);
  });
});
