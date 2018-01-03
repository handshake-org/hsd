/*!
 * network.js - bitcoin networks for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/**
 * @module protocol/networks
 */

const BN = require('bn.js');

const network = exports;

/**
 * Network type list.
 * @memberof module:protocol/networks
 * @const {String[]}
 * @default
 */

network.types = ['main', 'testnet', 'regtest', 'simnet'];

/**
 * Mainnet
 * @static
 * @lends module:protocol/networks
 * @type {Object}
 */

const main = {};

/**
 * Symbolic network type.
 * @const {String}
 * @default
 */

main.type = 'main';

/**
 * Default DNS seeds.
 * @const {String[]}
 * @default
 */

main.seeds = [
  '127.0.0.1'
];

/**
 * Packet magic number.
 * @const {Number}
 * @default
 */

main.magic = 0xebf10ad8;

/**
 * Default network port.
 * @const {Number}
 * @default
 */

main.port = 12038;

/**
 * Checkpoint block list.
 * @const {Object}
 */

main.checkpointMap = {};

/**
 * Last checkpoint height.
 * @const {Number}
 * @default
 */

main.lastCheckpoint = 0;

/**
 * @const {Number}
 * @default
 */

main.halvingInterval = 210000;

/**
 * Genesis block header.
 * @const {Object}
 */

main.genesis = {
  version: 0,
  hash: 'a3e47d49f58df07e0497b7f1c8e28c19bc5963cfa216a1ee48e5b520598d9669',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    '067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff016b99804a',
  witnessRoot:
    '659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f11752b37308b',
  reservedRoot:
    '0000000000000000000000000000000000000000000000000000000000000000',
  time: 1514765688,
  bits: 0x207fffff,
  nonce: Buffer.from('00000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(42),
  height: 0
};

/**
 * The network's genesis block in a hex string.
 * @const {String}
 */

main.genesisBlock = ''
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '00000000067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff01'
  + '6b99804a659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f1175'
  + '2b37308b00000000000000000000000000000000000000000000000000000000'
  + '00000000787d495a00000000ffff7f2000000000000000000000000000000000'
  + '2a00000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000100000000010000000000000000000000000000000000'
  + '000000000000000000000000000000ffffffff013830312f4e6f762f32303137'
  + '2045464620746f204943414e4e3a20446f6e2774205069636b20557020746865'
  + '2043656e736f7227732050656effffffff0100f2052a01000000001400000000'
  + '0000000000000000000000000000000000000000';

/**
 * POW-related constants.
 * @enum {Number}
 * @default
 */

main.pow = {};

/**
 * Default target.
 * @const {BN}
 */

main.pow.limit = new BN(
  '7fffff0000000000000000000000000000000000000000000000000000000000',
  'hex'
);

/**
 * Compact pow limit.
 * @const {Number}
 * @default
 */

main.pow.bits = 0x207fffff;

/**
 * Minimum chainwork for best chain.
 * @const {BN}
 */

main.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);

/**
 * Retarget window in blocks.
 * @const {Number}
 * @default
 */

main.pow.targetWindow = 20;

/**
 * Average block time.
 * @const {Number}
 * @default
 */

main.pow.targetSpacing = 10 * 60 / 4;

/**
 * Desired retarget period in seconds.
 * @const {Number}
 * @default
 */

main.pow.targetTimespan = main.pow.targetWindow * main.pow.targetSpacing;

/**
 * Minimum actual time.
 * @const {Number}
 * @default
 */

main.pow.minActual = ((main.pow.targetTimespan * (100 - 16)) / 100) >>> 0;

/**
 * Maximum actual time.
 * @const {Number}
 * @default
 */

main.pow.maxActual = ((main.pow.targetTimespan * (100 + 32)) / 100) >>> 0;

/**
 * Whether to reset target if a block
 * has not been mined recently.
 * @const {Boolean}
 * @default
 */

main.pow.targetReset = false;

/**
 * Do not allow retargetting.
 * @const {Boolean}
 * @default
 */

main.pow.noRetargeting = false;

/**
 * Cuckoo-related constants.
 * @enum {Number}
 * @default
 */

main.cuckoo = {
  bits: 30, // 4GB
  size: 42,
  ease: 50
};

/**
 * Block constants.
 * @enum {Number}
 * @default
 */

main.block = {
  /**
   * Safe height to start pruning.
   */

  pruneAfterHeight: 1000 * 4,

  /**
   * Safe number of blocks to keep.
   */

  keepBlocks: 288 * 4,

  /**
   * Age used for the time delta to
   * determine whether the chain is synced.
   */

  maxTipAge: 24 * 60 * 60,

  /**
   * Height at which block processing is
   * slow enough that we can output
   * logs without spamming.
   */

  slowHeight: 0
};

/**
 * For versionbits.
 * @const {Number}
 * @default
 */

main.activationThreshold = 1916; // 95% of 2016

/**
 * Confirmation window for versionbits.
 * @const {Number}
 * @default
 */

main.minerWindow = 2016; // nPowTargetTimespan / nPowTargetSpacing

/**
 * Deployments for versionbits.
 * @const {Object}
 * @default
 */

main.deployments = {
  csv: {
    name: 'csv',
    bit: 0,
    startTime: 1462060800, // May 1st, 2016
    timeout: 1493596800, // May 1st, 2017
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  segwit: {
    name: 'segwit',
    bit: 1,
    startTime: 1479168000, // November 15th, 2016.
    timeout: 1510704000, // November 15th, 2017.
    threshold: -1,
    window: -1,
    required: true,
    force: false
  },
  segsignal: {
    name: 'segsignal',
    bit: 4,
    startTime: 1496275200, // June 1st, 2017.
    timeout: 1510704000, // November 15th, 2017.
    threshold: 269, // 80%
    window: 336, // ~2.33 days
    required: false,
    force: false
  },
  testdummy: {
    name: 'testdummy',
    bit: 28,
    startTime: 1199145601, // January 1, 2008
    timeout: 1230767999, // December 31, 2008
    threshold: -1,
    window: -1,
    required: false,
    force: true
  }
};

/**
 * Deployments for versionbits (array form, sorted).
 * @const {Array}
 * @default
 */

main.deploys = [
  main.deployments.csv,
  main.deployments.segwit,
  main.deployments.segsignal,
  main.deployments.testdummy
];

/**
 * Key prefixes.
 * @enum {Number}
 * @default
 */

main.keyPrefix = {
  privkey: 0x80,
  xpubkey: 0x0488b21e,
  xprivkey: 0x0488ade4,
  xpubkey58: 'xpub',
  xprivkey58: 'xprv',
  coinType: 0
};

/**
 * {@link Address} prefixes.
 * @enum {Number}
 */

main.addressPrefix = {
  bech32: 'ck'
};

/**
 * Default value for whether the mempool
 * accepts non-standard transactions.
 * @const {Boolean}
 * @default
 */

main.requireStandard = true;

/**
 * Default http port.
 * @const {Number}
 * @default
 */

main.rpcPort = 12037;

/**
 * Default wallet port.
 * @const {Number}
 * @default
 */

main.walletPort = 12039;

/**
 * Default min relay rate.
 * @const {Rate}
 * @default
 */

main.minRelay = 1000;

/**
 * Default normal relay rate.
 * @const {Rate}
 * @default
 */

main.feeRate = 100000;

/**
 * Maximum normal relay rate.
 * @const {Rate}
 * @default
 */

main.maxFeeRate = 400000;

/**
 * Whether to allow self-connection.
 * @const {Boolean}
 */

main.selfConnect = false;

/**
 * Whether to request mempool on sync.
 * @const {Boolean}
 */

main.requestMempool = false;

/*
 * Testnet
 */

const testnet = {};

testnet.type = 'testnet';

testnet.seeds = [
  '127.0.0.1'
];

testnet.magic = 0x8efa1fbe;

testnet.port = 13038;

testnet.checkpointMap = {};

testnet.lastCheckpoint = 0;

testnet.halvingInterval = 210000;

testnet.genesis = {
  version: 0,
  hash: '693544a39967d46449b94722a47623821bee27b56cf1bf8864ceb79c71de4057',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    '067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff016b99804a',
  witnessRoot:
    '659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f11752b37308b',
  reservedRoot:
    '0000000000000000000000000000000000000000000000000000000000000000',
  time: 1514765689,
  bits: 0x207fffff,
  nonce: Buffer.from('00000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(18),
  height: 0
};

testnet.genesisBlock = ''
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '00000000067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff01'
  + '6b99804a659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f1175'
  + '2b37308b00000000000000000000000000000000000000000000000000000000'
  + '00000000797d495a00000000ffff7f2000000000000000000000000000000000'
  + '1200000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000100000000010000000000000000000000000000000000'
  + '000000000000000000000000000000ffffffff013830312f4e6f762f32303137'
  + '2045464620746f204943414e4e3a20446f6e2774205069636b20557020746865'
  + '2043656e736f7227732050656effffffff0100f2052a01000000001400000000'
  + '0000000000000000000000000000000000000000';

testnet.pow = {};
testnet.pow.limit = new BN(
  '7fffff0000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.bits = 0x207fffff;
testnet.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.targetWindow = 20;
testnet.pow.targetSpacing = 10 * 60 / 4;
testnet.pow.targetTimespan =
  testnet.pow.targetWindow * testnet.pow.targetSpacing;
testnet.pow.minActual = ((testnet.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
testnet.pow.maxActual = ((testnet.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
testnet.pow.targetReset = true;
testnet.pow.noRetargeting = false;


testnet.cuckoo = {
  bits: 16,
  size: 18,
  ease: 50
};

testnet.block = {
  pruneAfterHeight: 1000 * 4,
  keepBlocks: 10000 * 4,
  maxTipAge: 24 * 60 * 60,
  slowHeight: 0
};

testnet.activationThreshold = 1512; // 75% for testchains

testnet.minerWindow = 2016; // nPowTargetTimespan / nPowTargetSpacing

testnet.deployments = {
  csv: {
    name: 'csv',
    bit: 0,
    startTime: 1456790400, // March 1st, 2016
    timeout: 1493596800, // May 1st, 2017
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  segwit: {
    name: 'segwit',
    bit: 1,
    startTime: 1462060800, // May 1st 2016
    timeout: 1493596800, // May 1st 2017
    threshold: -1,
    window: -1,
    required: true,
    force: false
  },
  segsignal: {
    name: 'segsignal',
    bit: 4,
    startTime: 0xffffffff,
    timeout: 0xffffffff,
    threshold: 269,
    window: 336,
    required: false,
    force: false
  },
  testdummy: {
    name: 'testdummy',
    bit: 28,
    startTime: 1199145601, // January 1, 2008
    timeout: 1230767999, // December 31, 2008
    threshold: -1,
    window: -1,
    required: false,
    force: true
  }
};

testnet.deploys = [
  testnet.deployments.csv,
  testnet.deployments.segwit,
  testnet.deployments.segsignal,
  testnet.deployments.testdummy
];

testnet.keyPrefix = {
  privkey: 0xef,
  xpubkey: 0x043587cf,
  xprivkey: 0x04358394,
  xpubkey58: 'tpub',
  xprivkey58: 'tprv',
  coinType: 1
};

testnet.addressPrefix = {
  bech32: 'tk'
};

testnet.requireStandard = false;

testnet.rpcPort = 13037;

testnet.walletPort = 13039;

testnet.minRelay = 1000;

testnet.feeRate = 20000;

testnet.maxFeeRate = 60000;

testnet.selfConnect = true;

testnet.requestMempool = false;

/*
 * Regtest
 */

const regtest = {};

regtest.type = 'regtest';

regtest.seeds = [
  '127.0.0.1'
];

regtest.magic = 0xbcf173aa;

regtest.port = 14038;

regtest.checkpointMap = {};
regtest.lastCheckpoint = 0;

regtest.halvingInterval = 150;

regtest.genesis = {
  version: 0,
  hash: 'ee60b0763fa33331238a7bd83c07fed3c7c04b8e28e47170efa287b9569b33eb',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    '067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff016b99804a',
  witnessRoot:
    '659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f11752b37308b',
  reservedRoot:
    '0000000000000000000000000000000000000000000000000000000000000000',
  time: 1514765690,
  bits: 0x207fffff,
  nonce: Buffer.from('00000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(18),
  height: 0
};

regtest.genesisBlock = ''
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '00000000067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff01'
  + '6b99804a659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f1175'
  + '2b37308b00000000000000000000000000000000000000000000000000000000'
  + '000000007a7d495a00000000ffff7f2000000000000000000000000000000000'
  + '1200000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000100000000010000000000000000000000000000000000'
  + '000000000000000000000000000000ffffffff013830312f4e6f762f32303137'
  + '2045464620746f204943414e4e3a20446f6e2774205069636b20557020746865'
  + '2043656e736f7227732050656effffffff0100f2052a01000000001400000000'
  + '0000000000000000000000000000000000000000';

regtest.pow = {};
regtest.pow.limit = new BN(
  '7fffff0000000000000000000000000000000000000000000000000000000000',
  'hex'
);
regtest.pow.bits = 0x207fffff;
regtest.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);
regtest.pow.targetWindow = 20;
regtest.pow.targetSpacing = 10 * 60 / 4;
regtest.pow.targetTimespan =
  regtest.pow.targetWindow * regtest.pow.targetSpacing;
regtest.pow.minActual = ((regtest.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
regtest.pow.maxActual = ((regtest.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
regtest.pow.targetReset = true;
regtest.pow.noRetargeting = true;

regtest.cuckoo = {
  bits: 16,
  size: 18,
  ease: 50
};

regtest.block = {
  pruneAfterHeight: 1000 * 4,
  keepBlocks: 10000 * 4,
  maxTipAge: 0xffffffff,
  slowHeight: 0
};

regtest.activationThreshold = 108; // 75% for testchains

regtest.minerWindow = 144; // Faster than normal for regtest

regtest.deployments = {
  csv: {
    name: 'csv',
    bit: 0,
    startTime: 0,
    timeout: 0xffffffff,
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  segwit: {
    name: 'segwit',
    bit: 1,
    startTime: 0,
    timeout: 0xffffffff,
    threshold: -1,
    window: -1,
    required: true,
    force: false
  },
  segsignal: {
    name: 'segsignal',
    bit: 4,
    startTime: 0xffffffff,
    timeout: 0xffffffff,
    threshold: 269,
    window: 336,
    required: false,
    force: false
  },
  testdummy: {
    name: 'testdummy',
    bit: 28,
    startTime: 0,
    timeout: 0xffffffff,
    threshold: -1,
    window: -1,
    required: false,
    force: true
  }
};

regtest.deploys = [
  regtest.deployments.csv,
  regtest.deployments.segwit,
  regtest.deployments.segsignal,
  regtest.deployments.testdummy
];

regtest.keyPrefix = {
  privkey: 0x5a,
  xpubkey: 0xeab4fa05,
  xprivkey: 0xeab404c7,
  xpubkey58: 'rpub',
  xprivkey58: 'rprv',
  coinType: 1
};

regtest.addressPrefix = {
  bech32: 'rk'
};

regtest.requireStandard = false;

regtest.rpcPort = 14037;

regtest.walletPort = 14039;

regtest.minRelay = 1000;

regtest.feeRate = 20000;

regtest.maxFeeRate = 60000;

regtest.selfConnect = true;

regtest.requestMempool = true;

/*
 * Simnet
 */

const simnet = {};

simnet.type = 'simnet';

simnet.seeds = [
  '127.0.0.1'
];

simnet.magic = 0x473bd012;

simnet.port = 15038;

simnet.checkpointMap = {};

simnet.lastCheckpoint = 0;

simnet.halvingInterval = 210000;

simnet.genesis = {
  version: 0,
  hash: '00413221587d858f1fd5a685eda2f8fe961c4deac123975168e2e87e09481b5c',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    '067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff016b99804a',
  witnessRoot:
    '659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f11752b37308b',
  reservedRoot:
    '0000000000000000000000000000000000000000000000000000000000000000',
  time: 1514765691,
  bits: 0x207fffff,
  nonce: Buffer.from('00000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(18),
  height: 0
};

simnet.genesisBlock = ''
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '00000000067e2e3cb67fa51283decb2cf9af563efbd0ba50e01c556f13a6ff01'
  + '6b99804a659a9858a63f65be28c44122f4b20683e951ccb78c8455f0744f1175'
  + '2b37308b00000000000000000000000000000000000000000000000000000000'
  + '000000007b7d495a00000000ffff7f2000000000000000000000000000000000'
  + '1200000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000100000000010000000000000000000000000000000000'
  + '000000000000000000000000000000ffffffff013830312f4e6f762f32303137'
  + '2045464620746f204943414e4e3a20446f6e2774205069636b20557020746865'
  + '2043656e736f7227732050656effffffff0100f2052a01000000001400000000'
  + '0000000000000000000000000000000000000000';

simnet.pow = {};
simnet.pow.limit = new BN(
  '7fffff0000000000000000000000000000000000000000000000000000000000',
  'hex'
);
simnet.pow.bits = 0x207fffff;
simnet.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);
simnet.pow.targetWindow = 20;
simnet.pow.targetSpacing = 10 * 60 / 4;
simnet.pow.targetTimespan =
  simnet.pow.targetWindow * simnet.pow.targetSpacing;
simnet.pow.minActual = ((simnet.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
simnet.pow.maxActual = ((simnet.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
simnet.pow.targetReset = true;
simnet.pow.noRetargeting = false;

simnet.cuckoo = {
  bits: 16,
  size: 18,
  ease: 50
};

simnet.block = {
  pruneAfterHeight: 1000 * 4,
  keepBlocks: 10000 * 4,
  maxTipAge: 0xffffffff,
  slowHeight: 0
};

simnet.activationThreshold = 75; // 75% for testchains

simnet.minerWindow = 100; // nPowTargetTimespan / nPowTargetSpacing

simnet.deployments = {
  csv: {
    name: 'csv',
    bit: 0,
    startTime: 0, // March 1st, 2016
    timeout: 0xffffffff, // May 1st, 2017
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  segwit: {
    name: 'segwit',
    bit: 1,
    startTime: 0, // May 1st 2016
    timeout: 0xffffffff, // May 1st 2017
    threshold: -1,
    window: -1,
    required: true,
    force: false
  },
  segsignal: {
    name: 'segsignal',
    bit: 4,
    startTime: 0xffffffff,
    timeout: 0xffffffff,
    threshold: 269,
    window: 336,
    required: false,
    force: false
  },
  testdummy: {
    name: 'testdummy',
    bit: 28,
    startTime: 1199145601, // January 1, 2008
    timeout: 1230767999, // December 31, 2008
    threshold: -1,
    window: -1,
    required: false,
    force: true
  }
};

simnet.deploys = [
  simnet.deployments.csv,
  simnet.deployments.segwit,
  simnet.deployments.segsignal,
  simnet.deployments.testdummy
];

simnet.keyPrefix = {
  privkey: 0x64,
  xpubkey: 0x0420bd3a,
  xprivkey: 0x0420b900,
  xpubkey58: 'spub',
  xprivkey58: 'sprv',
  coinType: 115
};

simnet.addressPrefix = {
  bech32: 'sk'
};

simnet.requireStandard = false;

simnet.rpcPort = 15037;

simnet.walletPort = 15039;

simnet.minRelay = 1000;

simnet.feeRate = 20000;

simnet.maxFeeRate = 60000;

simnet.selfConnect = true;

simnet.requestMempool = false;

/*
 * Expose
 */

network.main = main;
network.testnet = testnet;
network.regtest = regtest;
network.simnet = simnet;
