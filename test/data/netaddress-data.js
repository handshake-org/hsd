'use strict';

const Network = require('../../lib/protocol/network');
const netaddressVectors = exports;

const main = Network.get('main');
const regtest = Network.get('regtest');

// [passedOptions, expectedValues]
netaddressVectors.options = [
  [null, {
    host: '0.0.0.0',
    port: 0,
    hostname: '0.0.0.0:0',
    isNull: true,
    isIPv6: false,
    isLocal: true,
    isValid: false,
    isRoutable: false
  }],
  [{
    host: '0.0.0.0',
    port: 0
  }, {
    host: '0.0.0.0',
    port: 0,
    hostname: '0.0.0.0:0',
    isNull: true,
    isIPv6: false,
    isLocal: true,
    isValid: false,
    isRoutable: false
  }],
  [{
    host: '2345:0425:2CA1:0000:0000:0567:5673:23b5',
    port: 1000
  }, {
    host: '2345:425:2ca1::567:5673:23b5',
    port: 1000,
    hostname: '[2345:425:2ca1::567:5673:23b5]:1000',
    isIPv6: true,
    isLocal: false,
    isValid: true,
    isRoutable: true
  }],
  [{
    host: '1.1.1.1',
    port: 1,
    services: 1,
    key: Buffer.alloc(33, 1)
  }, {
    hostname:
      'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@1.1.1.1:1',
    key: Buffer.alloc(33, 1),
    services: 1,
    isIPv6: false,
    isLocal: false,
    isValid: true,
    isRoutable: true
  }],
  [{
    host: '2.2.2.2',
    port: 2,
    key: Buffer.alloc(33, 2),
    services: 2
  }, {
    hostname:
      'aibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae@2.2.2.2:2',
    key: Buffer.alloc(33, 2),
    services: 2,
    isIPv6: false,
    isLocal: false,
    isValid: true,
    isRoutable: true
  }], [{
    host: '127.0.0.1',
    port: 1000,
    services: 3
  }, {
    hostname: '127.0.0.1:1000',
    services: 3,
    isIPv6: false,
    isLocal: true,
    isValid: true,
    isRoutable: false
  }], [{
    host: '127.1.1.1',
    port: 1000
  }, {
    hostname: '127.1.1.1:1000',
    isIPv6: false,
    isLocal: true,
    isValid: true,
    isRoutable: false
  }], [{
    host: '::1',
    port: 1000
  }, {
    hostname: '[::1]:1000',
    isIPv6: true,
    isLocal: true,
    isValid: true,
    isRoutable: false
  }], [{
    host: 'fd87:d87e:eb43::1',
    port: 1000
  }, {
    host: 'aaaaaaaaaaaaaaab.onion',
    hostname: 'aaaaaaaaaaaaaaab.onion:1000',
    isIPv6: false,
    isIPV4: false,
    isLocal: false,
    isValid: true,
    isRoutable: true,
    isOnion: true
  }]
];

const goodOptions = {
  host: '0.0.0.0',
  port: 12038
};

// [passedOptions, message]
netaddressVectors.failOptions = [
  [{ port: goodOptions.port }, 'NetAddress requires host string.'],
  [{ host: 1234 }, 'NetAddress requires host string.'],
  [{ host: goodOptions.host }, 'NetAddress requires port number.'],
  [{ host: goodOptions.host, port: '32' },
    'NetAddress requires port number.'],
  [{ host: goodOptions.host, port: -1 }, 'port number is incorrect.'],
  [{ host: goodOptions.host, port: 0xffff + 1 },
    'port number is incorrect.'],
  [{ ...goodOptions, services: '12' }, 'services must be a number.'],
  [{ ...goodOptions, services: {} }, 'services must be a number.'],
  [{ ...goodOptions, key: '12' }, 'key must be a buffer.'],
  [{ ...goodOptions, key: 11 }, 'key must be a buffer.']
];

// [options, expected]
netaddressVectors.fromHost = [
  [
    ['172.104.214.189', 1000, Buffer.alloc(33, 1)],
    {
      host: '172.104.214.189',
      port: 1000,
      key: Buffer.alloc(33, 1),
      hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
        + '@172.104.214.189:1000'
    }
  ],
  [
    ['15.152.162.66', 1001, Buffer.alloc(33, 2)],
    {
      host: '15.152.162.66',
      port: 1001,
      key: Buffer.alloc(33, 2),
      hostname: 'aibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae'
        + '@15.152.162.66:1001'
    }
  ],
  [
    ['2345:0425:2CA1:0000:0000:0567:5673:23b5', 0xffff],
    {
      host: '2345:425:2ca1::567:5673:23b5',
      port: 0xffff,
      key: Buffer.alloc(33, 0),
      hostname: '[2345:425:2ca1::567:5673:23b5]:65535'
    }
  ]
];

// [options, expected]
netaddressVectors.fromHostname = [
  [['127.0.0.1:100', 'main'], {
    hostname: '127.0.0.1:100',
    host: '127.0.0.1',
    port: 100,
    key: Buffer.alloc(33, 0)
  }],
  [
    [
      'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@127.0.0.1:100',
      'main'
    ], {
      hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
        + '@127.0.0.1:100',
      host: '127.0.0.1',
      port: 100,
      key: Buffer.alloc(33, 1)
    }
  ],
  [['127.0.0.1', 'main'], {
    hostname: `127.0.0.1:${main.port}`,
    host: '127.0.0.1',
    port: main.port,
    key: Buffer.alloc(33, 0)
  }],
  [
    [
      'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@127.0.0.1',
      'main'
    ], {
      hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
        + `@127.0.0.1:${main.brontidePort}`,
      host: '127.0.0.1',
      port: main.brontidePort,
      key: Buffer.alloc(33, 1)
    }
  ],
  [['127.0.0.1', 'regtest'], {
    hostname: `127.0.0.1:${regtest.port}`,
    host: '127.0.0.1',
    port: regtest.port,
    key: Buffer.alloc(33, 0)
  }],
  [
    [
      'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc@127.0.0.1',
      'regtest'
    ], {
      hostname: 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqc'
        + `@127.0.0.1:${regtest.brontidePort}`,
      host: '127.0.0.1',
      port: regtest.brontidePort,
      key: Buffer.alloc(33, 1)
    }
  ]
];

// [args, expected]
netaddressVectors.fromSocket = [
  [[{
    remoteAddress: '2001:4860:a005::68',
    remotePort: 1000
  }, 'main'], {
    hostname: '[2001:4860:a005::68]:1000',
    host: '2001:4860:a005::68',
    port: 1000
  }],
  [[{
    remoteAddress: '74.125.127.100',
    remotePort: 2000
  }, 'main'], {
    hostname: '74.125.127.100:2000',
    host: '74.125.127.100',
    port: 2000
  }]
];

// [addrA, addrB, expectedCompareResults]
netaddressVectors.compare = [
  [['127.0.0.1', 10], ['127.1.1.1', 9], -1],
  [['0.0.0.0', 10], ['1.1.1.1', 9], -1],
  [['0.0.0.1', 10], ['0.0.0.1', 9], 1],
  // IPV4 has two 0xff in the buffer before last 4 bytes.
  // So any IPV6 from ::1 to :ffff:0:0 will be lower than IPV4.
  // And any IPV6 from :ffff:0:0 to :ffff:ffff:ffff will be IPV4.
  [['::1', 1], ['0.0.0.1', 1], -1],
  [['::ffff:ffff', 1], ['0.0.0.1', 1], -1],
  [['::ffff:ffff:ffff', 1], ['0.0.0.1', 1], 1],
  [['::ffff:0:1', 1], ['0.0.0.1', 1], 0],
  [['::ffff:ffff:ffff', 1], ['255.255.255.255', 1], 0],
  // If IPs are same, then we compare ports.
  [['::1', 102], ['::1', 101], 1],
  [['::1', 100], ['::1', 101], -1],
  [['::1', 100], ['::1', 100], 0]
];

// Reachability scores
const rscores = {
  UNREACHABLE: 0,
  DEFAULT: 1,
  TEREDO: 2,
  IPV6_WEAK: 3,
  IPV4: 4,
  IPV6_STRONG: 5,
  PRIVATE: 6
};

// reachability IPs
const rips = {
  ipv4: {
    src: '74.125.127.100',
    dest: '45.79.134.225'
  },
  ipv6: {
    src: 'ffff::1',
    dest: 'ffff::ffff'
  },
  onion: {
    src: 'aaaaaaaaaaaaaaaa.onion',
    dest: 'bbbbbbbbbbbbbbbb.onion'
  },
  teredo: {
    src: '2001::1',
    dest: '2001:ffff::1'
  }
};

netaddressVectors.getReachability = [
  // unroutable, destination does not matter
  ['127.0.0.1', rips.ipv4.dest, rscores.UNREACHABLE],

  // IPv4 dest - DEFAULT
  [rips.ipv4.src, rips.ipv4.dest, rscores.IPV4],
  [rips.ipv6.src, rips.ipv4.dest, rscores.DEFAULT],
  [rips.onion.src, rips.ipv4.dest, rscores.DEFAULT],
  [rips.teredo.src, rips.ipv4.dest, rscores.DEFAULT],

  // IPv6 dest
  [rips.ipv4.src, rips.ipv6.dest, rscores.IPV4],
  ['2002::1', rips.ipv6.dest, rscores.IPV6_WEAK],
  [rips.ipv6.src, rips.ipv6.dest, rscores.IPV6_STRONG],
  [rips.onion.src, rips.ipv6.dest, rscores.DEFAULT],
  [rips.teredo.src, rips.ipv6.dest, rscores.TEREDO],

  // ONION Dest
  [rips.ipv4.src, rips.onion.src, rscores.IPV4],
  [rips.ipv6.src, rips.onion.src, rscores.DEFAULT],
  [rips.onion.src, rips.onion.src, rscores.PRIVATE],
  [rips.teredo.src, rips.onion.src, rscores.DEFAULT],

  // TEREDO Dest
  [rips.ipv4.src, rips.teredo.src, rscores.IPV4],
  [rips.ipv6.src, rips.teredo.src, rscores.IPV6_WEAK],
  [rips.onion.src, rips.teredo.src, rscores.DEFAULT],
  [rips.teredo.src, rips.teredo.src, rscores.TEREDO],

  // UNREACHABLE Dest
  [rips.ipv4.src, '127.0.0.1', rscores.IPV4],
  [rips.ipv6.src, '127.0.0.1', rscores.IPV6_WEAK],
  [rips.onion.src, '127.0.0.1', rscores.PRIVATE],
  [rips.teredo.src, '127.0.0.1', rscores.TEREDO]
];
