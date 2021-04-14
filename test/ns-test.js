'use strict';

const assert = require('bsert');
const {wire, util, encoding} = require('bns');
const {RootServer} = require('../lib/dns/server');
const {Resource} = require('../lib/dns/resource');
const NameState = require('../lib/covenants/namestate');
const rules = require('../lib/covenants/rules');
const nsec = require('../lib/dns/nsec.js');
const nameData = require('./data/ns-names.json');
const icannData = require('./data/ns-icann.json');

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

describe('RootServer DNSSEC', function () {
  const ns = new RootServer({
    port: 25349, // regtest
    lookup: (hash) => {
      assert(hash instanceof Buffer);
      const key = hash.toString('hex');
      const data = nameData[key];
      if (!data)
        return null;

      const namestate = new NameState();
      namestate.data = Resource.fromJSON(data).encode();
      return namestate.encode();
    }
  });

  ns.icann = {
    lookup: (name) => {
      name = util.fqdn(name);
      const data = icannData[name];

      if (data)
        return wire.Message.fromJSON(data);

      const res = new wire.Message();
      res.code = wire.codes.NXDOMAIN;
      res.ad = true;
      return res;
    }
  };

  before(async () => {
    await ns.open();
  });

  after(async () => {
    await ns.close();
  });

  const resolve = (qname, qtype) => {
    const req = {
      question: [
        new wire.Question(qname, qtype)
      ]
    };
    return ns.resolve(req);
  };

  it('should refuse invalid names', async () => {
    const qname = 'example\\000';
    const res = await resolve(qname, wire.types.NS);
    assert.strictEqual(res.code, wire.codes.REFUSED);
  });

  it('should prove NXDOMAIN', async () => {
    const qnames = [
      'icecream.',
      'this-domain-name-has-sixty-three-octets-taking-max-label-length.'
    ];

    for(const qname of qnames) {
      const res = await resolve(qname, wire.types.NS);
      assert(res.aa);
      assert.strictEqual(res.code, wire.codes.NXDOMAIN);
      assert.strictEqual(res.answer.length, 0);
      assert.strictEqual(res.additional.length, 0);
      assert(util.hasType(res.authority, wire.types.SOA));

      const nameProof = findCoveringNSEC(res.authority, qname);
      assert(nameProof.found);
    }
  });

  it('should create minimally covering NSEC records', async () => {
    const qname = 'icecream.';
    const res = await resolve(qname, wire.types.NS);

    assert(res.aa);
    assert.strictEqual(res.code, wire.codes.NXDOMAIN);
    assert.strictEqual(res.answer.length, 0);
    assert.strictEqual(res.additional.length, 0);

    const authority = res.authority;
    assert(util.hasType(authority, wire.types.SOA));

    const nameProof = findCoveringNSEC(authority, qname);
    assert(nameProof.found);

    // no other names must be covered by the 'icecream.' proof
    // names like 'icecreal\255a.' are covered but these octets
    // are not allowed in the root zone
    // these are close names to 'icecream.'
    const closeNames = ['icecreal.', 'icecrean.',
      'icecreal0.', 'icecrea-a.', 'icecreama.'];

    for(const name of closeNames) {
      const covering = findCoveringNSEC(authority, name);
      assert(!covering.found);
    }

    const wildcard = nameProof.wildcardNSEC;
    // test it minimally covers wildcard
    // characters like ",#,$,%,&,',),(,* are covered
    // but not allowed in the root zone
    assert(!cover('0.', wildcard.name, wildcard.data.nextDomain));
    assert(!cover('a-m.', wildcard.name, wildcard.data.nextDomain));
    assert(!cover('z.', wildcard.name, wildcard.data.nextDomain));
  });

  it('should prove non-existence of a type in the zone apex', async () => {
    const qname = '.';
    const res = await resolve(qname, wire.types.A);
    assert(res.aa);
    assert.strictEqual(res.code, wire.codes.NOERROR);
    assert.strictEqual(res.answer.length, 0);
    assert.strictEqual(res.additional.length, 0);
    assert(util.hasType(res.authority, wire.types.SOA));

    // check NSEC proof
    const set = util.extractSet(res.authority, qname, wire.types.NSEC);
    assert.strictEqual(set.length, 1);
    const proof = set[0];

    assert.strictEqual(proof.data.typeBitmap, nsec.TYPE_MAP_ROOT);
    assert(cover('.', proof.name, proof.data.nextDomain));
    assert(!cover('0.', proof.name, proof.data.nextDomain));
    assert(!cover('aa.', proof.name, proof.data.nextDomain));
  });

  // Some tests must check both Handshake
  // and ICANN names
  //
  // In the test data:
  // 'proofofconcept.' and 'com.' are signed zones
  // 'nb.' and 'cf.' are unsigned (no DS record)
  // 'schematic.' only contains a TXT record.
  // 'empty-name' has no records.
  it('should be authoritative over DS for names in the root zone', async () => {
    // example:
    // ;; QUESTION
    // ;proofofconcept.  IN    DS
    //
    // 1. Answer must have AA bit.
    // 2. DS record must be in the answers section
    const qnames = ['proofofconcept.', 'com.'];

    for(const qname of qnames) {
      const res = await resolve(qname, wire.types.DS);
      assert(res.aa);
      assert.strictEqual(res.code, wire.codes.NOERROR);
      assert.strictEqual(res.answer.length, 2);
      assert.strictEqual(res.authority.length, 0);
      assert.strictEqual(res.additional.length, 0);
      assert(util.hasType(res.answer, wire.types.DS));
    }
  });

  it('should add DS to referral answers', async () => {
    // ;; QUESTION
    // ;proofofconcept.  IN    A
    //
    // 1. no AA bit
    // 2. DS record in authority section
    const queries = [
      {qname: 'proofofconcept.', qtype: wire.types.A},
      {qname: 'proofofconcept.', qtype: wire.types.NS},
      {qname: 'example.proofofconcept.', qtype: wire.types.AAAA},
      {qname: 'com.', qtype: wire.types.A},
      {qname: 'com.', qtype: wire.types.NS},
      {qname: 'example.com.', qtype: wire.types.AAAA},
      // delegated sub-tree DS must NOT be authoritative
      {qname: 'example.proofofconcept.', qtype: wire.types.DS},
      {qname: 'example.com.', qtype: wire.types.DS}
    ];

    for (const q of queries) {
      const res = await resolve(q.qname, q.qtype);
      assert(!res.aa);
      assert.strictEqual(res.code, wire.codes.NOERROR);
      assert.strictEqual(res.answer.length, 0);

      assert(util.hasType(res.authority, wire.types.DS));
      assert(util.hasType(res.authority, wire.types.NS));
      assert(!util.hasType(res.authority, wire.types.SOA));
    }
  });

  it('should add insecure delegation proof to DS lookups', async () => {
    // example:
    // ;; QUESTION
    // ;nb.  IN    DS
    //
    // 1. Answer must have the AA bit
    // 2. NSEC in authority section
    const qnames = ['nb.', 'cf.'];

    for(const qname of qnames) {
      const res = await resolve(qname, wire.types.DS);
      assert(res.aa);
      assert.strictEqual(res.code, wire.codes.NOERROR);
      assert.strictEqual(res.answer.length, 0);
      assert.strictEqual(res.additional.length, 0);
      assert(util.hasType(res.authority, wire.types.SOA));

      const set = util.extractSet(res.authority, qname, wire.types.NSEC);
      assert.strictEqual(set.length, 1);
      const proof = set[0];
      // NSEC must be exact match
      assert.strictEqual(qname, proof.name);
      assert.strictEqual(proof.data.typeBitmap, nsec.TYPE_MAP_NS);
    }
  });

  it('should add insecure delegation proof to referral answers', async () => {
    // example:
    // ;; QUESTION
    // ;nb.  IN    A
    //
    // 1. Answer must be referral (no AA bit)
    // 2. DS record in authority section
    const queries = [
      {name: 'nb.', type: wire.types.NS},
      {name: 'nb.', type: wire.types.AAAA},
      {name: 'dot.nb.', type: wire.types.A},
      {name: 'cf.', type: wire.types.NS},
      {name: 'cf.', type: wire.types.AAAA},
      {name: 'dot.cf.', type: wire.types.A}
    ];

    for (const q of queries) {
      const res = await resolve(q.name, q.type);
      assert(!res.aa);
      assert.strictEqual(res.code, wire.codes.NOERROR);
      assert.strictEqual(res.answer.length, 0);
      assert(!util.hasType(res.authority, wire.types.SOA));

      // must have NSEC
      const labels = util.split(q.name);
      let tld = util.label(q.name, labels, -1);
      tld = util.fqdn(tld);

      const set = util.extractSet(res.authority, tld, wire.types.NSEC);
      assert.strictEqual(set.length, 1);
      assert.strictEqual(set[0].data.typeBitmap, nsec.TYPE_MAP_NS);
    }
  });

  it('should prove non-existence of a type for non-delegated names', async () => {
    // ;; QUESTION
    // ;schematic.  IN    A
    //
    // the names 'schematic' and 'empty-name'
    // don't have NS records so we are authoritative
    // over all records (root zone only supports TXT)
    // we must add a proof showing which
    // types exist to prove non-existence
    // of the requested type
    const queries = [
      {name: 'schematic.', type: wire.types.A, bitmap: nsec.TYPE_MAP_TXT},
      {name: 'empty-name.', type: wire.types.TXT, bitmap: nsec.TYPE_MAP_EMPTY}
    ];

    for (const query of queries) {
      const res = await resolve(query.name, query.type);
      assert(res.aa);
      assert.strictEqual(res.code, wire.codes.NOERROR);
      assert.strictEqual(res.answer.length, 0);
      assert.strictEqual(res.additional.length, 0);
      assert(util.hasType(res.authority, wire.types.SOA));

      const set = util.extractSet(res.authority, query.name, wire.types.NSEC);
      assert.strictEqual(set.length, 1);
      const proof = set[0];
      assert.strictEqual(proof.data.typeBitmap, query.bitmap);
    }
  });
});

/*
 * Helpers
 */

// compare two labels lexicographically
function compare(a, b) {
  // 63 octets + 2 octets for length and zero suffix.
  const buf = Buffer.alloc(65 * 2);

  // convert to wire format
  const [off1, lc1] = encoding.writeName(buf, a, 0, null, false);
  const [off2, lc2] = encoding.writeName(buf, b, 65, null, false);
  assert(lc1 === 1 && lc1 === lc2);

  const name1 = buf.slice(1, off1 - 1);
  const name2 = buf.slice(66, off2 - 1);
  return name1.compare(name2);
}

// tests whether sname is between owner and next.
function cover(sname, owner, next) {
  return compare(owner, sname) <= 0 &&
    compare(next, sname) === 1;
}

// finds a covering NSEC record for sname in section
// and an NSEC record for the wildcard.
function findCoveringNSEC(section, sname) {
  const result = {
    found: false,
    nameNSEC: null,
    wildcardNSEC: null
  };

  for (const rr of section) {
    if (rr.type !== wire.types.NSEC)
      continue;

    if (cover(sname, rr.name, rr.data.nextDomain)) {
      result.nameNSEC = rr;
      continue;
    }

    if (cover('*.', rr.name, rr.data.nextDomain))
      result.wildcardNSEC = rr;
  }

  result.found = result.nameNSEC !== null
    && result.wildcardNSEC !== null;

  return result;
}
