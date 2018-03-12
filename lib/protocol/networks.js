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
const genesis = require('./genesis');
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
 * Number of blocks before a coinbase
 * spend can occur (consensus).
 * @const {Number}
 * @default
 */

main.coinbaseMaturity = 400;

/**
 * Genesis block header.
 * @const {Object}
 */

main.genesis = genesis.main;

/**
 * The network's genesis block in a hex string.
 * @const {String}
 */

main.genesisBlock = genesis.mainData;

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
 * Average blocks per day.
 * @const {Number}
 * @default
 */

main.pow.blocksPerDay = (24 * 60 * 60) / main.pow.targetSpacing;

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
 * Name-related constants.
 * @enum {Number}
 * @default
 */

main.names = {
  /**
   * Interval at which names are rolled out.
   * @const {Number}
   */

  rolloutInterval: 7 * main.pow.blocksPerDay,

  /**
   * Time period after which names expire.
   * @const {Number}
   */

  renewalWindow: 365 * main.pow.blocksPerDay,

  /**
   * Committed renewal block hashes
   * must be no older than this.
   * @const {Number}
   */

  renewalPeriod: 182 * main.pow.blocksPerDay,

  /**
   * Committed renewal block hashes
   * must be at least this old.
   * @const {Number}
   */

  renewalMaturity: 30 * main.pow.blocksPerDay,

  /**
   * The time window in which the
   * foundation can claim reserved names.
   * @const {Number}
   */

  claimPeriod: (3 * 365) * main.pow.blocksPerDay,

  /**
   * Bidding time period.
   * @const {Number}
   */

  biddingPeriod: 5 * main.pow.blocksPerDay,

  /**
   * Reveal time period.
   * @const {Number}
   */

  revealPeriod: 10 * main.pow.blocksPerDay,

  /**
   * Sum of the bidding and reveal periods.
   * @const {Number}
   */

  totalPeriod: (5 + 10) * main.pow.blocksPerDay,

  /**
   * Interval at which the trie is updated.
   * @const {Number}
   */

  trieInterval: main.pow.blocksPerDay / 4,

  /**
   * Amount of time transfers are locked up for.
   * @const {Number}
   */

  transferLockup: 2 * main.pow.blocksPerDay,

  /**
   * Amount of time before a transfer
   * or revocation is possible.
   * @const {Number}
   */

  revocationDelay: 14 * main.pow.blocksPerDay,

  /**
   * Sum of total period and revocation delay.
   * @const {Number}
   */

  auctionMaturity: (5 + 10 + 14) * main.pow.blocksPerDay,

  /**
   * Whether there is no weekly rollout.
   * @const {Boolean}
   */

  noRollout: false,

  /**
   * Whether there are no names reserved.
   * @const {Boolean}
   */

  noReserved: false
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
testnet.coinbaseMaturity = 400;

testnet.genesis = genesis.testnet;
testnet.genesisBlock = genesis.testnetData;

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
testnet.pow.blocksPerDay = (24 * 60 * 60) / testnet.pow.targetSpacing;
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

testnet.names = {
  rolloutInterval: 7 * testnet.pow.blocksPerDay,
  renewalWindow: 365 * testnet.pow.blocksPerDay,
  renewalPeriod: 182 * testnet.pow.blocksPerDay,
  renewalMaturity: 30 * testnet.pow.blocksPerDay,
  claimPeriod: (3 * 365) * testnet.pow.blocksPerDay,
  biddingPeriod: 5 * testnet.pow.blocksPerDay,
  revealPeriod: 10 * testnet.pow.blocksPerDay,
  totalPeriod: (5 + 10) * testnet.pow.blocksPerDay,
  trieInterval: testnet.pow.blocksPerDay / 4,
  transferLockup: 2 * testnet.pow.blocksPerDay,
  revocationDelay: 14 * testnet.pow.blocksPerDay,
  auctionMaturity: (5 + 10 + 14) * testnet.pow.blocksPerDay,
  noRollout: false,
  noReserved: false
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
regtest.coinbaseMaturity = 25;

regtest.genesis = genesis.regtest;
regtest.genesisBlock = genesis.regtestData;

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
regtest.pow.blocksPerDay = (24 * 60 * 60) / regtest.pow.targetSpacing;
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

regtest.names = {
  rolloutInterval: 7 * regtest.pow.blocksPerDay,
  renewalWindow: 365 * regtest.pow.blocksPerDay,
  renewalPeriod: 182 * regtest.pow.blocksPerDay,
  renewalMaturity: 30 * regtest.pow.blocksPerDay,
  claimPeriod: (3 * 365) * regtest.pow.blocksPerDay,
  biddingPeriod: 5 * regtest.pow.blocksPerDay,
  revealPeriod: 10 * regtest.pow.blocksPerDay,
  totalPeriod: (5 + 10) * regtest.pow.blocksPerDay,
  trieInterval: regtest.pow.blocksPerDay / 4,
  transferLockup: 2 * regtest.pow.blocksPerDay,
  revocationDelay: 14 * regtest.pow.blocksPerDay,
  auctionMaturity: (5 + 10 + 14) * regtest.pow.blocksPerDay,
  noRollout: false,
  noReserved: false
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
simnet.coinbaseMaturity = 25;

simnet.genesis = genesis.simnet;
simnet.genesisBlock = genesis.simnetData;

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
simnet.pow.blocksPerDay = (24 * 60 * 60) / simnet.pow.targetSpacing;
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

simnet.names = {
  rolloutInterval: 7 * simnet.pow.blocksPerDay,
  renewalWindow: 365 * simnet.pow.blocksPerDay,
  renewalPeriod: 182 * simnet.pow.blocksPerDay,
  renewalMaturity: 30 * simnet.pow.blocksPerDay,
  claimPeriod: (3 * 365) * simnet.pow.blocksPerDay,
  biddingPeriod: 5 * simnet.pow.blocksPerDay,
  revealPeriod: 10 * simnet.pow.blocksPerDay,
  totalPeriod: (5 + 10) * simnet.pow.blocksPerDay,
  trieInterval: simnet.pow.blocksPerDay / 4,
  transferLockup: 2 * simnet.pow.blocksPerDay,
  revocationDelay: 14 * simnet.pow.blocksPerDay,
  auctionMaturity: (5 + 10 + 14) * simnet.pow.blocksPerDay,
  noRollout: false,
  noReserved: false
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
