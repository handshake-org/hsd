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
    // Handshake RootServer cache is keyed exclusively by the TLD when the
    // name has more than one label (normally indicating a referral).
    // If the cache doesn't handle the pseudo-TLD `_synth.` correctly,
    // This SYNTH4 request would return the result of the SYNTH6
    // record from the last `it` block.
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
});
