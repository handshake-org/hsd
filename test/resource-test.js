'use strict';

const assert = require('bsert');
const {wire} = require('bns');
const {Resource} = require('../lib/dns/resource');
const rules = require('../lib/covenants/rules');
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
      records: [{type: 'TXT', txt: ['hello world']}]
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

  // --- New record type round-trip tests ---

  it('should serialize A record', () => {
    const j = {records: [{type: 'A', address: '1.2.3.4'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
    assert.strictEqual(res2.toJSON().records[0].address, '1.2.3.4');
  });

  it('should serialize AAAA record', () => {
    const j = {records: [{type: 'AAAA', address: '::1'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize CNAME record', () => {
    const j = {records: [{type: 'CNAME', target: 'example.com.'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize DNAME record', () => {
    const j = {records: [{type: 'DNAME', target: 'example.com.'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize PTR record', () => {
    const j = {records: [{type: 'PTR', target: 'host.example.com.'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize MX record', () => {
    const j = {records: [{type: 'MX', preference: 10, mx: 'mail.example.com.'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize SRV record', () => {
    const j = {records: [{
      type: 'SRV', priority: 10, weight: 60, port: 5060,
      target: 'sip.example.com.'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize TLSA record', () => {
    const j = {records: [{
      type: 'TLSA', usage: 3, selector: 1,
      matchingType: 1, certificate: 'aabbccdd'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize SSHFP record', () => {
    const j = {records: [{
      type: 'SSHFP', algorithm: 1, digestType: 1, fingerprint: 'aabbccdd'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize CAA record', () => {
    const j = {records: [{
      type: 'CAA', flags: 0, tag: 'issue', value: 'letsencrypt.org'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize SOA record', () => {
    const j = {records: [{
      type: 'SOA', ns: 'ns1.example.com.', mbox: 'admin.example.com.',
      serial: 2021010101, refresh: 3600, retry: 900,
      expire: 604800, minimum: 86400
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize NAPTR record', () => {
    const j = {records: [{
      type: 'NAPTR', order: 100, preference: 10, flags: 'u',
      service: 'E2U+sip', regexp: '!^.*$!sip:info@example.com!',
      replacement: '.'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize SMIMEA record', () => {
    const j = {records: [{
      type: 'SMIMEA', usage: 3, selector: 1,
      matchingType: 1, certificate: 'deadbeef'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize OPENPGPKEY record', () => {
    const j = {records: [{type: 'OPENPGPKEY', publicKey: 'deadbeefcafe'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize URI record', () => {
    const j = {records: [{
      type: 'URI', priority: 10, weight: 1, target: 'https://example.com/'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize LOC record', () => {
    const j = {records: [{
      type: 'LOC', version: 0, size: 18, horizPre: 22, vertPre: 19,
      latitude: 2160199054, longitude: 2147549195, altitude: 10000000
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  it('should serialize RP record', () => {
    const j = {records: [{
      type: 'RP', mbox: 'admin.example.com.', txt: 'txt.example.com.'
    }]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
  });

  // --- RAW record ---

  it('should serialize RAW record', () => {
    const j = {records: [{type: 'RAW', dnsType: 999, data: 'deadbeef'}]};
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());
    assert.strictEqual(res2.toJSON().records[0].dnsType, 999);
    assert.strictEqual(res2.toJSON().records[0].data, 'deadbeef');
  });

  it('should convert RAW record to DNS wire format', () => {
    const res = Resource.fromJSON({
      records: [{type: 'RAW', dnsType: 999, data: 'deadbeef'}]
    });
    const rr = res.records[0].toDNS('example.', 3600);
    assert.strictEqual(rr.type, 999);
    assert.strictEqual(rr.name, 'example.');
    assert.bufferEqual(rr.data.data, Buffer.from('deadbeef', 'hex'));
  });

  // --- LABEL / SLD compression ---

  it('should serialize records with labels', () => {
    const j = {
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'A', name: 'www', address: '5.6.7.8'},
        {type: 'TLSA', name: '_443._tcp', usage: 3, selector: 1,
          matchingType: 1, certificate: 'aabb'}
      ]
    };
    const res1 = Resource.fromJSON(j);
    const res2 = Resource.decode(res1.encode());
    assert.deepStrictEqual(res1.toJSON(), res2.toJSON());

    // Verify the labels survived round-trip.
    assert.strictEqual(res2.records[0].label, '');
    assert.strictEqual(res2.records[1].label, '_443._tcp');
    assert.strictEqual(res2.records[2].label, 'www');
  });

  it('should sort TLD records before labeled records', () => {
    // Input has labeled record first.
    const j = {
      records: [
        {type: 'A', name: 'www', address: '5.6.7.8'},
        {type: 'A', address: '1.2.3.4'}
      ]
    };
    const res = Resource.fromJSON(j);

    // TLD record should be first after sorting.
    assert.strictEqual(res.records[0].label, '');
    assert.strictEqual(res.records[1].label, 'www');
  });

  it('should backwards-compat: old decoder reads TLD records before LABEL', () => {
    // Simulate: resource with TLD A + labeled TLSA.
    const j = {
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'TLSA', name: '_443._tcp', usage: 3, selector: 1,
          matchingType: 1, certificate: 'aabb'}
      ]
    };
    const res = Resource.fromJSON(j);
    const encoded = res.encode();

    // Old decoder (simulated): read until unknown type.
    // The A record is at the TLD level (before any LABEL marker).
    // An old node would read: version(0), type(7=A), A data, type(24=LABEL)→break
    const bio2 = require('bufio');
    const br = bio2.read(encoded);
    const version = br.readU8();
    assert.strictEqual(version, 0);

    const firstType = br.readU8();
    assert.strictEqual(firstType, 7); // hsTypes.A

    // Old node can read the A record data (4 bytes).
    const ip = br.readBytes(4);
    assert.bufferEqual(ip, Buffer.from([1, 2, 3, 4]));

    // Next byte is the LABEL marker (24) — old node doesn't know it, breaks.
    const nextType = br.readU8();
    assert.strictEqual(nextType, 24); // hsTypes.LABEL
  });

  // --- DNS resolution tests ---

  it('should return authoritative A answer when no NS present', () => {
    const res = Resource.fromJSON({
      records: [{type: 'A', address: '93.184.216.34'}]
    });
    const msg = res.toDNS('example.', types.A);

    assert(msg.aa);
    assert(msg.answer.length === 2);
    assert.strictEqual(msg.answer[0].type, types.A);
    assert.strictEqual(msg.answer[0].data.address, '93.184.216.34');
    assert.strictEqual(msg.answer[1].type, types.RRSIG);
  });

  it('should return CNAME for any query type (RFC 1034)', () => {
    const res = Resource.fromJSON({
      records: [{type: 'CNAME', target: 'other.example.com.'}]
    });
    const msg = res.toDNS('alias.', types.A);
    assert(msg.aa);
    assert(msg.answer.length === 2);
    assert.strictEqual(msg.answer[0].type, types.CNAME);
    assert.strictEqual(msg.answer[0].data.target, 'other.example.com.');
  });

  it('should not return A from root zone if NS is present', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'NS', ns: 'ns1.example.com.'},
        {type: 'A', address: '1.2.3.4'}
      ]
    });
    const msg = res.toDNS('example.', types.A);
    assert(!msg.aa);
    assert(msg.answer.length === 0);
  });

  // --- Subdomain resolution via LABEL ---

  it('should resolve subdomain A record via label', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'A', name: 'www', address: '5.6.7.8'}
      ]
    });

    // Query for www.example.
    const msg = res.toDNS('www.example.', types.A);
    assert(msg.aa);
    assert(msg.answer.length === 2);
    assert.strictEqual(msg.answer[0].type, types.A);
    assert.strictEqual(msg.answer[0].name, 'www.example.');
    assert.strictEqual(msg.answer[0].data.address, '5.6.7.8');
  });

  it('should resolve TLSA at _443._tcp subdomain', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'TLSA', name: '_443._tcp', usage: 3, selector: 1,
          matchingType: 1, certificate: 'aabbccdd'}
      ]
    });

    const msg = res.toDNS('_443._tcp.example.', types.TLSA);
    assert(msg.aa);
    assert(msg.answer.length === 2);
    assert.strictEqual(msg.answer[0].type, types.TLSA);
    assert.strictEqual(msg.answer[0].name, '_443._tcp.example.');
  });

  it('should return NSEC for non-existent type at subdomain', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'A', name: 'www', address: '5.6.7.8'}
      ]
    });

    // Query for MX at www.example. — only A exists there.
    const msg = res.toDNS('www.example.', types.MX);
    assert(msg.aa);
    assert(msg.answer.length === 0);

    let nsecRR = null;
    for (const rr of msg.authority) {
      if (rr.type === types.NSEC) {
        nsecRR = rr;
        break;
      }
    }
    assert(nsecRR);

    // NSEC should list A + RRSIG + NSEC for the www label.
    const expected = new wire.NSECRecord();
    expected.setTypes([types.A, types.RRSIG, types.NSEC]);
    assert.bufferEqual(nsecRR.data.typeBitmap, expected.typeBitmap);
  });

  it('should still refer when NS records exist (even with labels)', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'NS', ns: 'ns1.example.com.'},
        {type: 'A', name: 'www', address: '5.6.7.8'}
      ]
    });

    // NS exists so subdomain queries should be referrals.
    const msg = res.toDNS('www.example.', types.A);
    assert(!msg.aa);
    assert(msg.answer.length === 0);
    assert(msg.authority.length > 0);
  });

  // --- Dynamic NSEC bitmap ---

  it('should produce dynamic NSEC bitmap for A record', () => {
    const res = Resource.fromJSON({
      records: [{type: 'A', address: '1.2.3.4'}]
    });
    const msg = res.toDNS('example.', types.MX);
    assert(msg.aa);
    assert(msg.answer.length === 0);

    let nsecRR = null;
    for (const rr of msg.authority) {
      if (rr.type === types.NSEC) {
        nsecRR = rr;
        break;
      }
    }
    assert(nsecRR);

    const expected = new wire.NSECRecord();
    expected.setTypes([types.A, types.RRSIG, types.NSEC]);
    assert.bufferEqual(nsecRR.data.typeBitmap, expected.typeBitmap);
  });

  it('should produce dynamic NSEC bitmap for multiple types', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'MX', preference: 10, mx: 'mail.example.com.'},
        {type: 'TXT', txt: ['hello']}
      ]
    });
    const msg = res.toDNS('example.', types.AAAA);
    assert(msg.aa);
    assert(msg.answer.length === 0);

    let nsecRR = null;
    for (const rr of msg.authority) {
      if (rr.type === types.NSEC) {
        nsecRR = rr;
        break;
      }
    }
    assert(nsecRR);

    const expected = new wire.NSECRecord();
    expected.setTypes([types.A, types.MX, types.TXT, types.RRSIG, types.NSEC]);
    assert.bufferEqual(nsecRR.data.typeBitmap, expected.typeBitmap);
  });

  // --- Size limit ---

  it('should accept resource up to 8192 bytes', () => {
    const records = [];
    for (let i = 0; i < 15; i++) {
      records.push({type: 'TXT', txt: ['a'.repeat(255)]});
    }
    const res = Resource.fromJSON({records});
    const encoded = res.encode();
    assert(encoded.length <= 8192);
    const decoded = Resource.decode(encoded);
    assert.deepStrictEqual(res.toJSON(), decoded.toJSON());
  });

  // --- toZone with labels ---

  it('should generate zone records with correct subdomain names', () => {
    const res = Resource.fromJSON({
      records: [
        {type: 'A', address: '1.2.3.4'},
        {type: 'A', name: 'www', address: '5.6.7.8'},
        {type: 'MX', preference: 10, mx: 'mail.example.'}
      ]
    });
    const zone = res.toZone('example.');

    assert.strictEqual(zone.length, 3);
    // Unlabeled (TLD) records come first due to sorting
    assert.strictEqual(zone[0].name, 'example.');
    assert.strictEqual(zone[0].type, types.A);
    assert.strictEqual(zone[1].name, 'example.');
    assert.strictEqual(zone[1].type, types.MX);
    // Labeled (subdomain) records come after
    assert.strictEqual(zone[2].name, 'www.example.');
    assert.strictEqual(zone[2].type, types.A);
  });
});
