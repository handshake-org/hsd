'use strict';

const assert = require('bsert');
const {wire} = require('bns');
const {RootServer} = require('../lib/dns/server');
const {Resource} = require('../lib/dns/resource');
const NameState = require('../lib/covenants/namestate');
const rules = require('../lib/covenants/rules');

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

describe('RootServer Blacklist', function() {
  const ns = new RootServer({
    port: 25349, // regtest
    lookup: (hash) => {
      // Normally an Urkel Tree goes here.
      // Blacklisted names should never get this far.
      if (hash.equals(rules.hashName('bit')))
        throw new Error('Blacklisted name!');

      // For this test all other names have the same record
      const namestate = new NameState();
      namestate.data = Resource.fromJSON({
        records: [
          {
            type: 'NS',
            ns: 'ns1.handshake.'
          }
        ]
      }).encode();
      return namestate.encode();
    }
  });

  before(async () => {
    await ns.open();
  });

  after(async () => {
    await ns.close();
  });

  it('should look up non-blacklisted name', async () => {
    const name = 'icecream.';
    const req = {
      question: [{
        name,
        type: wire.types.NS
      }]
    };

    const res = await ns.resolve(req);
    const authority = res.authority;
    const rec = authority[0];

    assert.strictEqual(rec.name, name);
    assert.strictEqual(rec.type, wire.types.NS);
    assert.strictEqual(rec.data.ns, 'ns1.handshake.');
  });

  it('should not look up blacklisted name', async () => {
    const name = 'bit.';
    const req = {
      question: [{
        name,
        type: wire.types.NS
      }]
    };

    const res = await ns.resolve(req);
    assert.strictEqual(res.code, wire.codes.NXDOMAIN);
    assert.strictEqual(res.answer.length, 0);
  });
});

describe('RootServer Plugins', function() {
  const ns = new RootServer({
    port: 25349, // regtest
    lookup: (hash) => {
      // Normally an Urkel Tree goes here.
      // Blacklisted names should never get this far.
      if (hash.equals(rules.hashName('bit')))
        throw new Error('Blacklisted name!');

      // For this test all other names have the same record
      const namestate = new NameState();
      namestate.data = Resource.fromJSON({
        records: [
          {
            type: 'NS',
            ns: 'ns1.handshake.'
          }
        ]
      }).encode();
      return namestate.encode();
    }
  });

  before(async () => {
    // Plugin inserts middleware before server is opened
    ns.middle = (tld, req) => {
      const [qs] = req.question;
      const name = qs.name.toLowerCase();
      const type = qs.type;

      if (tld === 'bit.') {
        // This plugin runs an imaginary Namecoin full node.
        // It looks up records and returns an authoritative answer.
        // This makes it look like the complete record including
        // the subdomain is in the HNS root zone.
        const res = new wire.Message();
        res.aa = true;

        // This plugin only returns A records,
        // and all Namecoin names have the same IP address.
        if (type !== wire.types.A)
          return null;

        const rr = new wire.Record();
        const rd = new wire.ARecord();
        rr.name = name;
        rr.type = wire.types.A;
        rr.ttl = 518400;
        rr.data = rd;
        rd.address = '4.8.15.16';

        res.answer.push(rr);
        ns.signRRSet(res.answer, wire.types.A);

        return res;
      }

      // Plugin doesn't care about this name
      return null;
    };

    await ns.open();
  });

  after(async () => {
    await ns.close();
  });

  it('should hijack lookup for blacklisted name', async () => {
    const name = 'decentralize.bit.';
    const req = {
      question: [{
        name,
        type: wire.types.A
      }]
    };

    const res = await ns.resolve(req);
    assert.strictEqual(res.authority.length, 0);
    assert.strictEqual(res.answer.length, 2);

    const rec = res.answer[0];
    assert.strictEqual(rec.name, name);
    assert.strictEqual(rec.type, wire.types.A);
    assert.strictEqual(rec.data.address, '4.8.15.16');

    const sig = res.answer[1];
    assert.strictEqual(sig.name, name);
    assert.strictEqual(sig.type, wire.types.RRSIG);
  });
});
