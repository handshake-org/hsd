/* eslint-env mocha */

'use strict';

const assert = require('bsert');
const Account = require('../lib/wallet/account');

describe('Account', function() {
  it('staticAddress account should always return same addresses', async function () {
    const account = new Account();
  });
});
