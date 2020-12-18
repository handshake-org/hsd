'use strict';

const util = require('../../lib/utils/util');
const assert = require('bsert');

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
      const { validDomains, rejectedDomains } = util.createBatch2(limit, outputMap);
      assert.deepStrictEqual(validDomains.map(element => element.name), [domain1, domain2, domain3, domain4]);
      assert(rejectedDomains.length === 0);
    });

    it('should create a batch with domains that fit in pre-defined limit (ordered by the number of bids per domain descending)', function() {
      const limit = 100;
      const { validDomains, rejectedDomains } = util.createBatch2(limit, outputMap);
      assert.deepStrictEqual(validDomains.map(element => element.name), [domain1]);
      assert.deepStrictEqual(rejectedDomains.map(element => element.name), [domain2, domain3, domain4]);
    });

    it('should create a partial batch with domains that fit in pre-defined limit (ordered by the number of bids per domain descending)', function() {
      const limit = 99;
      const { validDomains, rejectedDomains } = util.createBatch2(limit, outputMap);
      assert.deepStrictEqual(validDomains, [{name: domain1, bidCount: limit}]);
      const expectedRejectedDomains = [{name: domain1, bidCount: outputMap.get(domain1).length - limit},
      {name: domain2, bidCount: outputMap.get(domain2).length},
      {name: domain3, bidCount: outputMap.get(domain3).length},
      {name: domain4, bidCount: outputMap.get(domain4).length}];
      assert.deepStrictEqual(rejectedDomains, expectedRejectedDomains);
    });
  });
});
