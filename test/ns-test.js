'use strict';

const assert = require('bsert');
const {wire} = require('bns');
const {RootServer} = require('../lib/dns/server');

describe('RootServer', function() {
  const ns = new RootServer({
    port: 25349 // regtest
  });

  before(async () => {
    await ns.open();
  });

  after(async () => {
    await ns.close();
  });

  it('should resolve a SYNTH4', async () => {
    const name = '_fs0000g._synth.';
    const req = {
      question: [{name}]
    };

    const res = await ns.resolve(req);
    const answer = res.answer;
    const rec = answer[0];

    assert.strictEqual(rec.name, name);
    assert.strictEqual(rec.type, wire.types.A);
    assert.strictEqual(rec.data.address, '127.0.0.2');
  });

  it('should resolve a SYNTH6', async () => {
    const name = '_00000000000000000000000008._synth.';
    const req = {
      question: [{name}]
    };

    const res = await ns.resolve(req);
    const answer = res.answer;
    const rec = answer[0];

    assert.strictEqual(rec.name, name);
    assert.strictEqual(rec.type, wire.types.AAAA);
    assert.strictEqual(rec.data.address, '::2');
  });

  it('should not cache synth record', async () => {
    // Start fresh
    const cache = ns.cache.cache;
    cache.reset();
    assert.strictEqual(cache.size, 0);

    // Query a record the RootResolver knows even without a database
    let name = '.';
    let req = {
      question: [
        {
          name,
          type: wire.types.NS
        }
      ]
    };
    let res = await ns.resolve(req);

    // Added to cache
    assert.strictEqual(cache.size, 1);

    // Query a SYNTH6 record
    name = '_00000000000000000000000008._synth.';
    req = {
      question: [
        {name}
      ]
    };
    res = await ns.resolve(req);
    let answer = res.answer;
    let rec = answer[0];

    assert.strictEqual(rec.name, name);
    assert.strictEqual(rec.type, wire.types.AAAA);
    assert.strictEqual(rec.data.address, '::2');

    // Nothing was added to the cache
    assert.strictEqual(cache.size, 1);

    // Handshake RootServer cache is keyed exclusively by the TLD when the
    // name has more than one label (normally indicating a referral).
    // If the cache doesn't handle the pseudo-TLD `_synth.` correctly,
    // This SYNTH4 request would return the result of the SYNTH6
    // record from the last request.
    name = '_fs0000g._synth.';
     req = {
      question: [{name}]
    };

    res = await ns.resolve(req);
    answer = res.answer;
    rec = answer[0];

    assert.strictEqual(rec.name, name);
    assert.strictEqual(rec.type, wire.types.A);
    assert.strictEqual(rec.data.address, '127.0.0.2');

    // Nothing was added to the cache
    assert.strictEqual(cache.size, 1);
  });
});
