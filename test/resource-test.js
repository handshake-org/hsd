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

  it('should not return TXT from root zone if NS is present', () => {
    const res = Resource.fromJSON(json);
    const msg = res.toDNS('hns.', types.TXT);

    assert(!msg.aa);
    assert(msg.answer.length === 0);
  });

  it('should return TXT from root zone if NS is not present', () => {
    const res = Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['hello world']
        }
      ]
    });
    const msg = res.toDNS('hns.', types.TXT);

    assert(msg.aa);
    assert(msg.answer.length === 2);

    const [txt, sig] = msg.answer;
    assert.strictEqual(txt.type, types.TXT);
    assert.strictEqual(txt.name, 'hns.');
    assert.strictEqual(txt.data.txt.length, 1);
    assert.strictEqual(txt.data.txt[0], 'hello world');
    assert.strictEqual(sig.type, types.RRSIG);
    assert.strictEqual(sig.name, 'hns.');
  });

  it('should return A and AAAA from root zone if NS is not present', () => {
    const res1 = Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['legacy first']
        },
        {
          type: 'A',
          address: '203.0.113.10'
        },
        {
          type: 'AAAA',
          address: '2001:0db8::0010'
        }
      ]
    });

    const res2 = Resource.decode(res1.encode());

    assert.deepStrictEqual(res2.toJSON(), {
      records: [
        {
          type: 'TXT',
          txt: ['legacy first']
        },
        {
          type: 'A',
          address: '203.0.113.10'
        },
        {
          type: 'AAAA',
          address: '2001:db8::10'
        }
      ]
    });

    const msg4 = res2.toDNS('hns.', types.A);
    const msg6 = res2.toDNS('hns.', types.AAAA);

    assert(msg4.aa);
    assert(msg6.aa);
    assert(msg4.answer.length === 2);
    assert(msg6.answer.length === 2);

    const [a, sig4] = msg4.answer;
    const [aaaa, sig6] = msg6.answer;

    assert.strictEqual(a.type, types.A);
    assert.strictEqual(a.name, 'hns.');
    assert.strictEqual(a.data.address, '203.0.113.10');
    assert.strictEqual(sig4.type, types.RRSIG);
    assert.strictEqual(sig4.name, 'hns.');

    assert.strictEqual(aaaa.type, types.AAAA);
    assert.strictEqual(aaaa.name, 'hns.');
    assert.strictEqual(aaaa.data.address, '2001:db8::10');
    assert.strictEqual(sig6.type, types.RRSIG);
    assert.strictEqual(sig6.name, 'hns.');

    const nx = res2.toDNS('hns.', types.MX);
    const proof = nx.authority[0];
    const expect = new wire.NSECRecord();

    expect.setTypes([types.A, types.TXT, types.AAAA, types.RRSIG, types.NSEC]);

    assert(nx.aa);
    assert.strictEqual(nx.answer.length, 0);
    assert.strictEqual(proof.type, types.NSEC);
    assert.bufferEqual(proof.data.typeBitmap, expect.typeBitmap);
  });

  it('should not return A and AAAA from root zone if NS is present', () => {
    const res = Resource.fromJSON({
      records: [
        {
          type: 'NS',
          ns: 'ns1.hns.'
        },
        {
          type: 'A',
          address: '203.0.113.10'
        },
        {
          type: 'AAAA',
          address: '2001:db8::10'
        }
      ]
    });

    const msg4 = res.toDNS('hns.', types.A);
    const msg6 = res.toDNS('hns.', types.AAAA);

    assert(!msg4.aa);
    assert(!msg6.aa);
    assert(msg4.answer.length === 0);
    assert(msg6.answer.length === 0);
    assert(msg4.authority.length > 0);
    assert(msg6.authority.length > 0);
  });

  it('should preserve known records before unknown record types', () => {
    const res1 = Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['legacy first']
        },
        {
          type: 'A',
          address: '203.0.113.10'
        }
      ]
    });

    const raw = res1.encode();
    const legacy = Buffer.from(raw);
    const aTypeOffset = 1 + 1 + 1 + 1 + 'legacy first'.length;

    // Simulate an older decoder that does not know A/AAAA yet.
    assert.strictEqual(legacy[aTypeOffset], 7);
    legacy[aTypeOffset] = 255;

    const res2 = Resource.decode(legacy);

    assert.deepStrictEqual(res2.toJSON(), {
      records: [
        {
          type: 'TXT',
          txt: ['legacy first']
        }
      ]
    });
  });

  it('should synthesize an answer', () => {
    const res = Resource.fromJSON(json);
    const msg = res.toDNS('hns.', types.DS);

    assert(msg.aa);
    assert(msg.answer.length === 2);

    const [ds, sig] = msg.answer;

    assert.strictEqual(ds.type, types.DS);
    assert.strictEqual(ds.name, 'hns.');
    assert.strictEqual(sig.type, types.RRSIG);
    assert.strictEqual(sig.name, 'hns.');

    assert.strictEqual(ds.data.keyTag, 57355);
    assert.bufferEqual(
      ds.data.digest,
      Buffer.from(
        '95a57c3bab7849dbcddf7c72ada71a88146b141110318ca5be672057e865c3e2',
        'hex'
      )
    );
  });
});
