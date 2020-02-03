/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const Headers = require('../lib/primitives/headers');
const assert = require('bsert');

describe('Headers', function() {
  it('should match headers size', () => {
    const headers = new Headers();

    assert.strictEqual(headers.getSize(), 236);
  });
});
