/*!
 * network.js - bitcoin networks for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

/**
 * @module protocol/networks
 */

const BN = require('bn.js');
const genesis = require('./genesis.json');

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
 * Reward halving interval.
 * @const {Number}
 * @default
 */

main.halvingInterval = 680000;

/**
 * Genesis block header.
 * @const {Object}
 */

main.genesis = {
  version: 0,
  hash: '4e93e066384da69ea89b17bc57a0990fe1f93933d46a074d387cf7a2cce810d5',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    'db29d1a8dc508eaeaa97478bbbcf4559c01d8c5193613da4e92af6b97f589cfb',
  witnessRoot:
    'd0baafaa70a2716e989ba2730842733e162160330735a3f8a87c8543007837da',
  trieRoot:
    '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314',
  time: 1514765688,
  bits: 0x207fffff,
  nonce: Buffer.from('0000000000000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(42),
  height: 0
};

/**
 * The network's genesis block in a hex string.
 * @const {String}
 */

main.genesisBlock = genesis.main;

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

main.activationThreshold = 1916 * 4;

/**
 * Confirmation window for versionbits.
 * @const {Number}
 * @default
 */

main.minerWindow = 2016 * 4;

/**
 * Deployments for versionbits.
 * @const {Object}
 * @default
 */

main.deployments = {
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
  bech32: 'hs'
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

testnet.halvingInterval = 680000;

testnet.genesis = {
  version: 0,
  hash: '81ad36d363ec47787fdfae110882e5736006afbe3dc44be5832e1683adb7c864',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    'db29d1a8dc508eaeaa97478bbbcf4559c01d8c5193613da4e92af6b97f589cfb',
  witnessRoot:
    'd0baafaa70a2716e989ba2730842733e162160330735a3f8a87c8543007837da',
  trieRoot:
    '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314',
  time: 1514765689,
  bits: 0x207fffff,
  nonce: Buffer.from('0000000000000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(18),
  height: 0
};

testnet.genesisBlock = genesis.testnet;

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

testnet.activationThreshold = 1512 * 4;

testnet.minerWindow = 2016 * 4;

testnet.deployments = {
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
  bech32: 'ts'
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
  hash: '7de1500530cbc0d526c661d63ffea961771242d82dac5ef9f70bb4216b5d6cba',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    'db29d1a8dc508eaeaa97478bbbcf4559c01d8c5193613da4e92af6b97f589cfb',
  witnessRoot:
    'd0baafaa70a2716e989ba2730842733e162160330735a3f8a87c8543007837da',
  trieRoot:
    '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314',
  time: 1514765690,
  bits: 0x207fffff,
  nonce: Buffer.from('0000000000000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(18),
  height: 0
};

regtest.genesisBlock = genesis.regtest;

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

regtest.activationThreshold = 108 * 4;

regtest.minerWindow = 144 * 4;

regtest.deployments = {
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
  bech32: 'rs'
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

simnet.halvingInterval = 680000;

simnet.genesis = {
  version: 0,
  hash: '965b28fdd10e32ff3336c581b94aa7bc0c60eda0ca8f8c5062b4adc4d8c2d057',
  prevBlock: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot:
    'db29d1a8dc508eaeaa97478bbbcf4559c01d8c5193613da4e92af6b97f589cfb',
  witnessRoot:
    'd0baafaa70a2716e989ba2730842733e162160330735a3f8a87c8543007837da',
  trieRoot:
    '03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314',
  time: 1514765691,
  bits: 0x207fffff,
  nonce: Buffer.from('0000000000000000000000000000000000000000', 'hex'),
  solution: new Uint32Array(18),
  height: 0
};

simnet.genesisBlock = genesis.simnet;

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

simnet.activationThreshold = 75 * 4;

simnet.minerWindow = 100 * 4;

simnet.deployments = {
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
  bech32: 'ss'
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
