'use strict';

const util = require('../../lib/utils/util');
const assert = require('bsert');
const { italics } = require('bns/lib/roothints');

describe('util', function() {
  describe('createBatch', function() {
    const outputMap = new Map();
    const domain1 = 'alpha';
    const domain2 = 'beta';
    const domain3 = 'gamma';
    const domain4 = 'omega';

    before(function() {
      outputMap.set(domain1, [... Array(100).keys()]);
      outputMap.set(domain2, [... Array(50).keys()]);
      outputMap.set(domain3, [... Array(25).keys()]);
      outputMap.set(domain4, [... Array(12).keys()]);
    });

    it('should create a batch with all domains only if the output count is below permitted limit', function() {
      const limit = 200;
      const { validDomains, rejectedDomains } = util.createBatch(limit, outputMap);
      assert.deepStrictEqual(validDomains, [domain1, domain2, domain3, domain4]);
      assert(rejectedDomains.length === 0);
    });

    it('should create a batch with domains that fit in pre-defined limit (ordered by the number of bids per domain descending)', function() {
      const limit = 100;
      const { validDomains, rejectedDomains } = util.createBatch(limit, outputMap);
      assert.deepStrictEqual(validDomains, [domain1]);
      assert.deepStrictEqual(rejectedDomains, [domain2, domain3, domain4]);
    });

    it('should skip not-fittind domain and create a batch with domains that fit in pre-defined limit (ordered by the number of bids per domain descending)', function() {
      const limit = 99;
      const { validDomains, rejectedDomains } = util.createBatch(limit, outputMap);
      assert.deepStrictEqual(validDomains, [domain2, domain3, domain4]);
      assert.deepStrictEqual(rejectedDomains, [domain1]);
    });
  });
});
