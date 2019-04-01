'use strict';

const assert = require('bsert');
const reserved = require('../lib/covenants/reserved');

describe('Reserved', function() {
  it('should get a domain', () => {
    const desc = reserved.getByName('twitter');

    assert.deepStrictEqual(desc, {
      name: 'twitter',
      hash: Buffer.from(
        '525ce500322a0f4c91070eb73829b9d96b2e70d964905fa88c8b20ea573029ea',
        'hex'),
      target: 'twitter.com.',
      value: 566471548,
      root: false
    });
  });

  it('should get a reserved TLD', () => {
    const desc = reserved.getByName('google');

    assert.deepStrictEqual(desc, {
      name: 'google',
      hash: Buffer.from(
        '6292be73bdfdc4ea12bdf3018c8c553d3022b37601bb2b19153c8804bdf8da15',
        'hex'),
      target: 'google.',
      value: 34053011272,
      root: true
    });
  });

  it('should get a reserved custom name', () => {
    const desc = reserved.getByName('eth');

    assert.deepStrictEqual(desc, {
      name: 'eth',
      hash: Buffer.from(
        '4b3cdfda85c576e43c848d43fdf8e901d8d02553fec8ee56289d10b8dc47d997',
        'hex'),
      target: 'eth.ens.domains.',
      value: 10200566471548,
      root: false
    });
  });
});
