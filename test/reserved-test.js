'use strict';

const assert = require('bsert');
const fs = require('bfile');
const reserved = require('../lib/covenants/reserved');

// FOSS and naming projects who preferred addresses.
const EXTRA_VALUE = (16608510 + 10200000) * 1e6;

// 68000000 + 27200000 + 136000000 = 231200000
// 0.046054 coins are burned due to rounding.
const NAME_VALUE = 231199999953946;

describe('Reserved', function() {
  it('should get a top 100 domain', () => {
    const desc = reserved.getByName('twitter');

    // twitter.com gets extra coins as they
    // are one of the top domains in the world.
    assert.deepStrictEqual(desc, {
      name: 'twitter',
      hash: Buffer.from(
        '525ce500322a0f4c91070eb73829b9d96b2e70d964905fa88c8b20ea573029ea',
        'hex'),
      target: 'twitter.com.',
      value: 630133143116,
      root: false
    });
  });

  it('should get a non-top 100 domain', () => {
    const desc = reserved.getByName('craigslist');

    // Craigslist barely missed top 100 status, at rank 102.
    assert.deepStrictEqual(desc, {
      name: 'craigslist',
      hash: Buffer.from(
        '4475619b1fc842831f9af645b268fcd49b20113060f97b9fc49355a69bd0413a',
        'hex'),
      target: 'craigslist.org.',
      value: 503513487,
      root: false
    });
  });

  it('should get a reserved TLD (also top 100)', () => {
    const desc = reserved.getByName('google');

    // .google is considered a top 100 domain as they own google.com.
    assert.deepStrictEqual(desc, {
      name: 'google',
      hash: Buffer.from(
        '6292be73bdfdc4ea12bdf3018c8c553d3022b37601bb2b19153c8804bdf8da15',
        'hex'),
      target: 'google.',
      value: 660214983416,
      root: true
    });
  });

  it('should get a reserved custom name', () => {
    const desc = reserved.getByName('eth');

    // .eth is reserved and passed to the ENS people for safekeeping.
    assert.deepStrictEqual(desc, {
      name: 'eth',
      hash: Buffer.from(
        '4b3cdfda85c576e43c848d43fdf8e901d8d02553fec8ee56289d10b8dc47d997',
        'hex'),
      target: 'eth.ens.domains.',
      value: 136503513487,
      root: false
    });
  });

  it('should get an embargoed name', () => {
    const desc = reserved.getByName('kp');

    // The United States has trade embargoes against North Korea
    // (and other nations). Although HNS is not a system of money,
    // the protocol still avoids giving them any coins in order to
    // avoid creating some kind of international incident.
    //
    //   https://www.state.gov/j/ct/rls/crt/2009/140889.htm
    //   https://en.wikipedia.org/wiki/United_States_embargoes#Countries
    assert.deepStrictEqual(desc, {
      name: 'kp',
      hash: Buffer.from(
        '4707196b22054788dd1f05a16efb1ff54ed2ddbcd338d4bfc650e72e1829f694',
        'hex'),
      target: 'kp.',
      value: 0,
      root: true
    });
  });

  it('should get all names', async () => {
    const map = await fs.readJSON(`${__dirname}/../lib/covenants/names.json`);
    const zeroHash = Buffer.alloc(32, 0x00).toString('hex');
    const [, nameValue, rootValue, topValue] = map[zeroHash];
    const names = [];

    let total = 0;

    for (const hash of Object.keys(map)) {
      const item = map[hash];

      if (hash === zeroHash)
        continue;

      const [name, flags] = item;
      const root = (flags & 1) !== 0;
      const top100 = (flags & 2) !== 0;
      const custom = (flags & 4) !== 0;
      const zero = (flags & 8) !== 0;

      let value = nameValue;

      if (root)
        value += rootValue;

      if (top100)
        value += topValue;

      if (custom)
        value += item[2];

      if (zero)
        value = 0;

      names.push({
        name: name.split('.')[0],
        hash: Buffer.from(hash, 'hex'),
        target: name,
        value,
        root
      });

      total += value;
    }

    for (const item of names) {
      assert.deepStrictEqual(reserved.get(item.hash), item);
      assert(reserved.has(item.hash));

      assert.deepStrictEqual(reserved.getByName(item.name), item);
      assert(reserved.hasByName(item.name));
    }

    assert.strictEqual(total + EXTRA_VALUE, NAME_VALUE);
  });

  it('should iterate over names (entries)', async () => {
    const map = await fs.readJSON(`${__dirname}/../lib/covenants/names.json`);

    let total = 0;

    for (const [hash, item] of reserved) {
      const hex = hash.toString('hex');

      assert(map[hex] != null);

      delete map[hex];

      total += item.value;
    }

    assert.strictEqual(total + EXTRA_VALUE, NAME_VALUE);
    assert.strictEqual(Object.keys(map).length, 1);
  });

  it('should iterate over names (keys)', async () => {
    const map = await fs.readJSON(`${__dirname}/../lib/covenants/names.json`);

    for (const hash of reserved.keys()) {
      const hex = hash.toString('hex');

      assert(map[hex] != null);

      delete map[hex];
    }

    assert.strictEqual(Object.keys(map).length, 1);
  });

  it('should iterate over names (values)', async () => {
    const map = await fs.readJSON(`${__dirname}/../lib/covenants/names.json`);

    let total = 0;

    for (const item of reserved.values()) {
      const hex = item.hash.toString('hex');

      assert(map[hex] != null);

      delete map[hex];

      total += item.value;
    }

    assert.strictEqual(total + EXTRA_VALUE, NAME_VALUE);
    assert.strictEqual(Object.keys(map).length, 1);
  });
});
