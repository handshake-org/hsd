/**
 * address-test.js - HNS Address Tests
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const Address = require('../lib/primitives/address');
const consensus = require('../lib/protocol/consensus');
const {
  MAX_WITNESS_PROGRAM_VERSION,
  MAX_WITNESS_PROGRAM_SIZE
} = consensus;

describe('Address', function() {
  it('should match mainnet p2pkh address', () => {
    const raw = '6d5571fdbca1019cd0f0cd792d1b0bdfa7651c7e';
    const p2pkh = Buffer.from(raw, 'hex');
    const addr = Address.fromPubkeyhash(p2pkh);
    const expect = 'hs1qd42hrldu5yqee58se4uj6xctm7nk28r70e84vx';
    assert.strictEqual(addr.toString('main'), expect);
  });

  it('should serialize and deserialize', () => {
    const data = random.randomBytes(20);
    const addr = Address.fromPubkeyhash(data);
    const decoded = Address.decode(addr.encode());
    assert(addr.equals(decoded));
    assert.deepEqual(addr.toString(), decoded.toString());
  });

  it('should allow for valid versions', () => {
    const data = random.randomBytes(32);

    for (let i = 0; i <= MAX_WITNESS_PROGRAM_VERSION; i++) {
      const addr = Address.fromHash(data, i);
      assert.equal(addr.version, i);
      assert.bufferEqual(addr.hash, data);
    }
  });

  it('should throw for invalid versions', () => {
    const data = random.randomBytes(32);
    const version = MAX_WITNESS_PROGRAM_VERSION + 1;

    // Too large.
    assert.throws(() => Address.fromHash(data, version));
    // Too small.
    assert.throws(() => Address.fromHash(data, -1));
  });

  it('should throw for invalid data sizes', () => {
    const large = MAX_WITNESS_PROGRAM_SIZE + 1;
    const small = MAX_WITNESS_PROGRAM_SIZE - 1;
    let data = random.randomBytes(large);

    // Too large
    assert.throws(() => Address.fromHash(data, 0));
    // Too small
    data = random.randomBytes(small);
    assert.throws(() => Address.fromHash(small, 0));
  });
});
