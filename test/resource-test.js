'use strict';

const assert = require('bsert');
const {wire} = require('bns');
const {Resource} = require('../lib/dns/resource');
const {types} = wire;

describe('Resource', function() {
  const json = {
    records: [
      {
        type: 'DS',
        keyTag: 57355,
        algorithm: 8, // RSASHA256
        digestType: 2, // SHA256
        digest:
          '95a57c3bab7849dbcddf7c72ada71a88146b141110318ca5be672057e865c3e2'
      },
      {
        type: 'NS',
        ns: 'ns1.hns.'
      },
      {
        type: 'GLUE4',
        ns: 'ns2.hns.',
        address: '127.0.0.1'
      },
      {
        type: 'GLUE4',
        ns: 'ns3.some-other-domain.',
        address: '10.20.30.40'
      },
      {
        type: 'GLUE6',
        ns: 'ns4.hns.',
        address: '::1'
      },
      {
        type: 'SYNTH4',
        address: '127.0.0.2'
      },
      {
        type: 'SYNTH6',
        address: '::2'
      },
      {
        type: 'TXT',
        txt: ['hello world']
      }
    ]
  };

  it('should serialize resource', () => {
    const res1 = Resource.fromJSON(json);
    const res2 = Resource.decode(res1.encode());

    assert.deepStrictEqual(res1.toJSON(), json);
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should synthesize a referral', () => {
    const res = Resource.fromJSON(json);
    const msg = res.toDNS('hns.', types.MX);

    assert(msg.answer.length === 0);
    assert(msg.authority.length === 8);
    // Notice that the glue for `ns3.some-other-domain.` is omitted
    assert(msg.additional.length === 4);

    const [ns1, ns2, ns3, ns4, synth4, synth6, ds, rrsig] = msg.authority;
    const [glue4, glue6, synthA, synthAAAA] = msg.additional;

    assert.strictEqual(ns1.type, types.NS);
    assert.strictEqual(ns1.name, 'hns.');
    assert.strictEqual(ns2.type, types.NS);
    assert.strictEqual(ns2.name, 'hns.');
    assert.strictEqual(ns3.type, types.NS);
    assert.strictEqual(ns3.name, 'hns.');
    assert.strictEqual(ns4.type, types.NS);
    assert.strictEqual(ns4.name, 'hns.');
    assert.strictEqual(synth4.type, types.NS);
    assert.strictEqual(synth4.name, 'hns.');
    assert.strictEqual(synth6.type, types.NS);
    assert.strictEqual(synth6.name, 'hns.');
    assert.strictEqual(ds.type, types.DS);
    assert.strictEqual(ds.name, 'hns.');
    assert.strictEqual(rrsig.type, types.RRSIG);
    assert.strictEqual(rrsig.name, 'hns.');
    assert.strictEqual(glue4.type, types.A);
    assert.strictEqual(glue4.name, 'ns2.hns.');
    assert.strictEqual(glue6.type, types.AAAA);
    assert.strictEqual(glue6.name, 'ns4.hns.');
    assert.strictEqual(synthA.type, types.A);
    assert.strictEqual(synthA.name, '_fs0000g._synth.');
    assert.strictEqual(synthAAAA.type, types.AAAA);
    assert.strictEqual(synthAAAA.name, '_00000000000000000000000008._synth.');

    assert.strictEqual(ns1.data.ns, 'ns1.hns.');
    assert.strictEqual(ns2.data.ns, 'ns2.hns.');
    assert.strictEqual(synth4.data.ns, '_fs0000g._synth.');
    assert.strictEqual(synth6.data.ns, '_00000000000000000000000008._synth.');
    assert.bufferEqual(ds.data.digest, json.records[0].digest);
    assert.strictEqual(glue4.data.address, '127.0.0.1');
    assert.strictEqual(glue6.data.address, '::1');
    assert.strictEqual(synthA.data.address, '127.0.0.2');
    assert.strictEqual(synthAAAA.data.address, '::2');
  });

  it('should synthesize an answer', () => {
    const res = Resource.fromJSON(json);
    const msg = res.toDNS('hns.', types.TXT);

    assert(msg.aa);
    assert(msg.answer.length === 2);

    const [txt, sig] = msg.answer;

    assert.strictEqual(txt.type, types.TXT);
    assert.strictEqual(txt.name, 'hns.');
    assert.strictEqual(sig.type, types.RRSIG);
    assert.strictEqual(sig.name, 'hns.');

    assert.strictEqual(txt.data.txt.length, 1);
    assert.strictEqual(txt.data.txt[0], 'hello world');
  });
});
