/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Address = require('../lib/primitives/address');

describe('Address', function() {
  it('should match mainnet p2pkh address', () => {
    const raw = '6d5571fdbca1019cd0f0cd792d1b0bdfa7651c7e';
    const p2pkh = Buffer.from(raw, 'hex');
    const addr = Address.fromPubkeyhash(p2pkh);
    const expect = 'hs1qd42hrldu5yqee58se4uj6xctm7nk28r70e84vx';
    assert.strictEqual(addr.toString('main'), expect);
  });

  it('should check standardness of address', () => {
    const addr = new Address();

    // Standard p2wpkh
    addr.version = 0;
    addr.hash = Buffer.alloc(20);
    assert(!addr.isUnknown());

    // Standard p2wsh
    addr.version = 0;
    addr.hash = Buffer.alloc(32);
    assert(!addr.isUnknown());

    // nullData, any valid length
    for (let i = 2; i <= 40; i++) {
      addr.version = 31;
      addr.hash = Buffer.alloc(i);
      assert(!addr.isUnknown());
    }

    // Non-Standard address
    addr.version = 0;
    addr.hash = Buffer.alloc(19);
    assert(addr.isUnknown());

    addr.version = 0;
    addr.hash = Buffer.alloc(33);
    assert(addr.isUnknown());

    // Undefined version
    addr.version = 1;
    addr.hash = Buffer.alloc(32);
    assert(addr.isUnknown());
  });
});
