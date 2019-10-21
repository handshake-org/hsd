/**
 * records-test.js - Records tests for hsd
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Records = require('../lib/dns/records');
const {Compressor} = require('../lib/dns/compress');

describe('Records V0', function () {
  describe('Serialize and Deserialize', function () {
    it('Addr', () => {
      const check = (record, expect) => {
        const [currency, address] = expect;
        assert.equal(record.currency, currency);
        assert.equal(record.address, address);
      };

      const mocks = [
        ['bitcoin.', 'bc1q3ff2cc63fs6frk8nkyus4n82xxe7l3g37vs3vu'],
        ['bitcoin.', 'tb1qf0vlknfcfrcmh9h298ktgnaxm6lwfrxvh3gc3v'],
        ['bitcoin.', '17A16QmavnUfCW11DAApiJxp7ARnxN5pGX'],
        ['handshake.', 'hs1q5z7yym8xrh4quqg3kw498ngy7hnd4sru5cr8x2'],
        ['handshake.', 'ts1qhvp7est34xekyc3qt9sjhst0dt09r670ruz3wk'],
        ['ethereum.', '0xdac17f958d2ee523a2206206994597c13d831ec7'],
        ['cosmoshub.', 'cosmos1qvn96e22fw02gfd2v6x94n5m8udsmgqvtl6uxxz'],
        ['cosmoshub.', 'cosmospub1qvn96e22fw02gfd2v6x94n5m8udsmgqvtn65mff'],
        ['cosmoshub.', 'cosmosvalcons1qvn96e22fw02gfd2v6x94n5m8udsmgqvts2ftur'],
        ['cosmoshub.', 'cosmosvalconspub1qvn96e22fw02gfd2v6x94n5m8udsmgqvtsrp8a4'],
        ['cosmoshub.', 'cosmosvaloper1qvn96e22fw02gfd2v6x94n5m8udsmgqvtejle82'],
        ['cosmoshub.', 'cosmosvaloperpub1qvn96e22fw02gfd2v6x94n5m8udsmgqvtu04qy5']
      ];

      for (const mock of mocks) {
        const [currency, address] = mock;

        let record = new Records.Addr(currency, address);
        check(record, mock);

        const c = new Compressor();
        record = Records.Addr.decode(record.encode(c));
        check(record, mock);
      }
    });
  });
});

