/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const NetAddress = require('../lib/net/netaddress');

describe('NetAddress', function() {
  it('should return the correct group', () => {
    // Local -> !Routable()
    assert.bufferEqual(
      NetAddress.fromHost('127.0.0.1', 13038, null, 'testnet').getGroup(),
      Buffer.from([0])
    );

    // RFC1918 -> !Routable()
    assert.bufferEqual(
      NetAddress.fromHost('169.254.1.1', 13038, null, 'testnet').getGroup(),
      Buffer.from([0])
    );

    // IPv4
    assert.bufferEqual(
      NetAddress.fromHost('1.2.3.4', 13038, null, 'testnet').getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC6145
    assert.bufferEqual(
      NetAddress.fromHost(
        '::FFFF:0:102:304',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC6052
    assert.bufferEqual(
      NetAddress.fromHost(
        '64:FF9B::102:304',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC3964
    assert.bufferEqual(
      NetAddress.fromHost(
        '2002:102:304:9999:9999:9999:9999:9999',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // RFC4380
    assert.bufferEqual(
      NetAddress.fromHost(
        '2001:0:9999:9999:9999:9999:FEFD:FCFB',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([1, 1, 2])
    );

    // Tor
    assert.bufferEqual(
      NetAddress.fromHost(
        'FD87:D87E:EB43:edb1:8e4:3588:e546:35ca',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([3, 239])
    );

    // he.net
    assert.bufferEqual(
      NetAddress.fromHost(
        '2001:470:abcd:9999:9999:9999:9999:9999',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([2, 32, 1, 4, 112, 175])
    );

    // IPv6
    assert.bufferEqual(
      NetAddress.fromHost(
        '2001:2001:9999:9999:9999:9999:9999:9999',
        13038,
        null,
        'testnet'
      ).getGroup(),
      Buffer.from([2, 32, 1, 32, 1])
    );
  });
});
