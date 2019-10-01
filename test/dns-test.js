/**
 * dns-test.js - DNS Server Testing for hsd
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const StubResolver = require('bns/lib/resolver/stub');
const bcrypto = require('bcrypto');
const dnssec = require('bns/lib/dnssec');
const util = require('bns/lib/util');
const wire = require('bns/lib/wire');
const FullNode = require('../lib/node/fullnode');
const Resource = require('../lib/dns/resource');
const Records = require('../lib/dns/records');
const Network = require('../lib/protocol/network');
const NameState = require('../lib/covenants/namestate');
const rules = require('../lib/covenants/rules');
const {types} = wire;

const json = require('./data/resources-v0.json');

const network = Network.get('regtest');

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  rsNoUnbound: true,
  memory: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const nstub = new StubResolver({
  rd: true,
  cd: true,
  edns: true,
  ednsSize: 4096,
  maxAttempts: 2,
  maxTimeout: 3000,
  dnssec: true,
  servers: [`127.0.0.1:${network.nsPort}`]
});

describe('DNS Servers', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nstub.open();
  });

  after(async () => {
    await node.close();
    await nstub.close();
  });

  describe('Authoritative Resolver', () => {
    // write each resource json to the tree
    for (const [hstype, list] of Object.entries(json)) {
      for (const item of list) {
        // DNS RR type
        const type = types[item.type];

        // assert that the type maps are correct
        const rtype = Records.types[hstype];
        // handshake type -> DNS RR type
        assert.equal(Records.dnsByType[rtype], type);
        // handshake type -> handshake value (string)
        assert.equal(Records.typesByVal[rtype], hstype);

        const resource = Resource.fromJSON(item.resource);

        let name;
        before(async () => {
          // args: size, height, network
          name = rules.grindName(5, 1, network);
          const raw = Buffer.from(name, 'ascii');
          const nameHash = rules.hashName(raw);
          // create a namestate to save the data to
          const ns = new NameState();
          ns.set(raw, 0);
          ns.setData(resource.encode());

          // Create a database transaction, as
          // writing directly to the database is
          // discouraged. Write to the txn and
          // then commit it.
          const txn = node.chain.db.tree.transaction();
          await txn.insert(nameHash, ns.encode());
          await txn.commit();
        });

        it(`should return authenticated ${hstype} record`, async () => {
          // Certain types of queries require the
          // name to be formatted with additional data
          const query = buildQuery(name, resource, type);

          // query the authoritative name server
          let res = await nstub.lookup(query, type);

          // create the dns response locally
          let dns = resource.toDNS(query, type);

          // query for the zone signing key
          const dnskey = await nstub.lookup('.', types.DNSKEY);

          // parse the zone signing key and
          // key signing key out of the response
          const {zsk, ksk} = getSigningKeys(dnskey);

          assert(zsk instanceof wire.Record);
          assert(ksk instanceof wire.Record);

          // validate the signature on the ZSK
          verifyDNSSEC(dnskey, ksk, types.DNSKEY, '.');
          // validate the signature over the rrsets
          verifyDNSSEC(res, zsk, type, query);

          // NOTE: the signatures are not canonical
          // when the native backend is being used
          // because it uses OpenSSL which does not
          // yet use RFC 6979, so nullify the
          // signatures before comparing them
          if (bcrypto.native === 2) {
            dns = nullSig(dns);
            res = nullSig(res);
            assert(dns && res);
          }

          assert.deepEqual(dns.answer, res.answer);
          assert.deepEqual(dns.authority, res.authority);
          assert.deepEqual(dns.additional, res.additional);
        });
      }
    }
  });
});

/**
 * Verify DNSSEC for each name in the
 * response. Only check the answer and
 * authority sections. If all rrsets
 * are signed, the responses will be
 * too large and not fit into udp packets
 */

function verifyDNSSEC(resource, pubkey, qtype, name) {
  // rr types that are not committed to in DNSSEC
  const skip = new Set([
    types.RRSIG
  ]);

  name = util.fqdn(name);

  const {answer, authority} = resource;
  const targets = [answer, authority];

  const records = [];

  for (const target of targets) {
    const toVerify = new Set();
    for (const record of target) {
      records.push(record);

      if (!skip.has(record.type))
        toVerify.add(record.type);
    }

    for (const type of toVerify) {
      const rrsig = target.find((rr) => {
        return rr.type === types.RRSIG
          && rr.data.typeCovered === type;
      });

      if (name !== rrsig.name) {
        const record = records.find((rr) => {
          return rr.name === util.fqdn(name)
            && (rr.type === types.CNAME
            || rr.type === types.DNAME
            || rr.type === types.SRV
            || rr.type === types.NS);
        });

        assert(record);

        switch (qtype) {
          case types.CNAME:
          case types.DNAME:
          case types.SRV:
            name = record.data.target;
            break;
          case types.NS:
            name = record.data.ns;
            break;
          default:
            assert(false, 'rrsig name does not match');
        }
      }

      const rrs = util.extractSet(target, name, type);

      const valid = dnssec.verify(rrsig, pubkey, rrs);
      assert(valid);
    }
  }
}

/**
 * Nullify out any signatures in
 * a DNS response. This is to allow
 * a deep equality check on DNS responses
 * when using a non-deterministic
 * signature scheme.
 */

function nullSig(response) {
  const sections = ['answer', 'authority', 'additional'];
  for (const section of sections) {
    for (const resource of response[section])
      if (resource.data.signature)
        resource.data.signature = null;
  }
  return response;
}

/**
 * Parse the ZSKs and KSKs from
 * a record. Asserts that only
 * one of each type is returned,
 * as that is the currently expected
 * behavior.
 */

function getSigningKeys(record) {
  const ksks = [];
  const zsks = [];
  for (const rr of record.answer) {
    if (rr.type === types.DNSKEY) {
      const {data} = rr.toJSON();
      if (data.keyType === 'ZSK')
        zsks.push(rr);
      else if (data.keyType === 'KSK')
        ksks.push(rr);
    }
  }

  assert.equal(ksks.length, 1);
  assert.equal(zsks.length, 1);

  return {
    zsk: zsks[0],
    ksk: ksks[0]
  };
}

/**
 * Build a name to query for the types
 * that require additional labels.
 */

function buildQuery(name, resource, type) {
  switch (type) {
    case types.SRV: {
      const service = resource.service[0];
      return util.fqdn('_'
        + service.service
        + '_'
        + service.protocol
        + name);
    }
    case types.TLSA: {
      const tls = resource.tls[0];
      return util.fqdn('_'
        + tls.port
        + '._'
        + tls.protocol
        + name);
    }
    case types.SMIMEA: {
      const smime = resource.smime[0];
      return util.fqdn(smime.hash.toString('hex')
        + '.'
        + '_smimecert.'
        + name);
    }
    case types.OPENPGPKEY: {
      const pgp = resource.pgp[0];
      return util.fqdn(pgp.hash.toString('hex')
        + '.'
        + '_openpgpkey.'
        + name);
    }
    default:
      return util.fqdn(name);
  }
}
