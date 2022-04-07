'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const {lookup, resolve} = require('../lib/net/lookup');

const main = Network.get('main');

const notAHost = 'not-a-domain.not-a-domain';

describe('Lookup', function() {
  this.timeout(10000);
  it('should lookup seed', async () => {
    for (const host of main.seeds) {
      const addresses = await lookup(host);
      assert(addresses.length > 0, 'addresses not found.');
    }
  });

  it('should fail lookup', async () => {
    let err;

    try {
      await lookup(notAHost);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, 'No DNS results.');
  });

  it('should lookup seed', async () => {
    for (const host of main.seeds) {
      const addresses = await resolve(host);

      assert(addresses.length > 0, 'addresses not found.');
    }
  });

  it('should fail resolve', async () => {
    let err;

    try {
      await resolve(notAHost);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, `Query error: NXDOMAIN (${notAHost} A).`);

    // TODO: Host that does not have A/AAAA records?
  });
});
