/*!
 * network.js - handshake networks for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint no-implicit-coercion: "off" */

'use strict';

/**
 * @module protocol/networks
 */

const BN = require('bcrypto/lib/bn.js');
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

main.seeds = [];

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
 * Roughly every 3.25 years.
 * @const {Number}
 * @default
 */

main.halvingInterval = 170000;

/**
 * Number of blocks before a coinbase
 * spend can occur (consensus).
 * @const {Number}
 * @default
 */

main.coinbaseMaturity = 100;

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
  '00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex'
);

/**
 * Compact pow limit.
 * @const {Number}
 * @default
 */

main.pow.bits = 0x1d00ffff;

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

main.pow.targetWindow = 144;

/**
 * Average block time.
 * @const {Number}
 * @default
 */

main.pow.targetSpacing = 10 * 60;

/**
 * Average blocks per day.
 * @const {Number}
 * @default
 */

main.pow.blocksPerDay = ((24 * 60 * 60) / main.pow.targetSpacing) >>> 0;

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

main.pow.minActual = (main.pow.targetTimespan / 4) >>> 0;

/**
 * Maximum actual time.
 * @const {Number}
 * @default
 */

main.pow.maxActual = main.pow.targetTimespan * 4;

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
 * Name-related constants.
 * @enum {Number}
 * @default
 */

main.names = {
  /**
   * Height at which the auction system activates.
   * @const {Number}
   */

  auctionStart: 10 * main.pow.blocksPerDay,

  /**
   * Interval at which names are rolled out.
   * @const {Number}
   */

  rolloutInterval: 7 * main.pow.blocksPerDay,

  /**
   * Amount of time a name is locked for after being claimed.
   * @const {Number}
   */

  lockupPeriod: 30 * main.pow.blocksPerDay,

  /**
   * Time period after which names expire.
   * @const {Number}
   */

  renewalWindow: (2 * 365) * main.pow.blocksPerDay,

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
   * nameholders can claim reserved names.
   * @const {Number}
   */

  claimPeriod: (4 * 365) * main.pow.blocksPerDay,

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
   * Interval at which the name tree is updated.
   * @const {Number}
   */

  treeInterval: main.pow.blocksPerDay >>> 2,

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

  pruneAfterHeight: 1000,

  /**
   * Safe number of blocks to keep.
   */

  keepBlocks: 288,

  /**
   * Age used for the time delta to
   * determine whether the chain is synced.
   */

  maxTipAge: 12 * 60 * 60,

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

main.activationThreshold = 1916;

/**
 * Confirmation window for versionbits.
 * @const {Number}
 * @default
 */

main.minerWindow = 2016;

/**
 * Deployments for versionbits.
 * @const {Object}
 * @default
 */

main.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
    required: false,
    force: false
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
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
  main.deployments.hardening,
  main.deployments.rollover,
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
  coinType: 5353
};

/**
 * Address prefix.
 * @const {String}
 */

main.addressPrefix = 'hs';

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
 * Default DNS port.
 * @const {Number}
 * @default
 */

main.nsPort = 5349;

/**
 * Default recursive DNS port.
 * @const {Number}
 * @default
 */

main.rsPort = 5350;

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
 * Default identity key (testing only).
 * @const {Buffer|null}
 * @default
 */

main.identityKey = null;

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

/**
 * DNSSEC ownership prefix.
 * @const {String}
 */

main.claimPrefix = 'hns-claim:';

/*
 * Testnet
 */

const testnet = {};

testnet.type = 'testnet';

testnet.seeds = [];

testnet.magic = 0x09d8647f;

testnet.port = 13038;

testnet.checkpointMap = {};

testnet.lastCheckpoint = 0;

testnet.halvingInterval = 170000;
testnet.coinbaseMaturity = 100;

testnet.genesis = genesis.testnet;
testnet.genesisBlock = genesis.testnetData;

testnet.pow = {};

// Note: BTC limit. Consider switching to
// this once we have a new miner written.
// testnet.pow.limit = new BN(
//   '00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
//   'hex'
// );
// testnet.pow.bits = 0x1d00ffff;

testnet.pow.limit = new BN(
  '0000003000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.bits = 0x1d300000;
testnet.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.targetWindow = 144;
testnet.pow.targetSpacing = 10 * 60;
testnet.pow.blocksPerDay = ((24 * 60 * 60) / testnet.pow.targetSpacing) >>> 0;
testnet.pow.targetTimespan =
  testnet.pow.targetWindow * testnet.pow.targetSpacing;
testnet.pow.minActual = (testnet.pow.targetTimespan / 4) >>> 0;
testnet.pow.maxActual = testnet.pow.targetTimespan * 4;
testnet.pow.targetReset = true;
testnet.pow.noRetargeting = false;

testnet.names = {
  auctionStart: (0.25 * testnet.pow.blocksPerDay) | 0,
  rolloutInterval: (0.25 * testnet.pow.blocksPerDay) | 0,
  lockupPeriod: (0.25 * testnet.pow.blocksPerDay) | 0,
  renewalWindow: 30 * testnet.pow.blocksPerDay,
  renewalPeriod: 7 * testnet.pow.blocksPerDay,
  renewalMaturity: 1 * testnet.pow.blocksPerDay,
  claimPeriod: 90 * testnet.pow.blocksPerDay,
  biddingPeriod: 1 * testnet.pow.blocksPerDay,
  revealPeriod: 2 * testnet.pow.blocksPerDay,
  treeInterval: testnet.pow.blocksPerDay >>> 2,
  transferLockup: 2 * testnet.pow.blocksPerDay,
  revocationDelay: 4 * testnet.pow.blocksPerDay,
  auctionMaturity: (1 + 2 + 4) * testnet.pow.blocksPerDay,
  noRollout: false,
  noReserved: false
};

testnet.block = {
  pruneAfterHeight: 1000,
  keepBlocks: 10000,
  maxTipAge: 12 * 60 * 60,
  slowHeight: 0
};

testnet.activationThreshold = 1512;

testnet.minerWindow = 2016;

testnet.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
    required: false,
    force: false
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
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
  testnet.deployments.hardening,
  testnet.deployments.rollover,
  testnet.deployments.testdummy
];

testnet.keyPrefix = {
  privkey: 0xef,
  xpubkey: 0x043587cf,
  xprivkey: 0x04358394,
  xpubkey58: 'tpub',
  xprivkey58: 'tprv',
  coinType: 5354
};

testnet.addressPrefix = 'ts';

testnet.requireStandard = false;

testnet.rpcPort = 13037;

testnet.walletPort = 13039;

testnet.nsPort = 15349;

testnet.rsPort = 15350;

testnet.minRelay = 1000;

testnet.feeRate = 20000;

testnet.maxFeeRate = 60000;

testnet.identityKey = null;

testnet.selfConnect = false;

testnet.requestMempool = false;

testnet.claimPrefix = 'hns-testnet:';

/*
 * Regtest
 */

const regtest = {};

regtest.type = 'regtest';

regtest.seeds = [
  'aorsxa4ylaacshipyjkfbvzfkh3jhh4yowtoqdt64nzemqtiw2whk@127.0.0.1'
];

regtest.magic = 0xbcf173aa;

regtest.port = 14038;

regtest.checkpointMap = {};
regtest.lastCheckpoint = 0;

regtest.halvingInterval = 2500;
regtest.coinbaseMaturity = 2;

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
regtest.pow.targetWindow = 144;
regtest.pow.targetSpacing = 10 * 60;
regtest.pow.blocksPerDay = ((24 * 60 * 60) / regtest.pow.targetSpacing) >>> 0;
regtest.pow.targetTimespan =
  regtest.pow.targetWindow * regtest.pow.targetSpacing;
regtest.pow.minActual = (regtest.pow.targetTimespan / 4) >>> 0;
regtest.pow.maxActual = regtest.pow.targetTimespan * 4;
regtest.pow.targetReset = true;
regtest.pow.noRetargeting = true;

regtest.names = {
  auctionStart: 0,
  rolloutInterval: 1000,
  lockupPeriod: 2,
  renewalWindow: 200,
  renewalPeriod: 300,
  renewalMaturity: 50,
  claimPeriod: 250000,
  biddingPeriod: 50,
  revealPeriod: 50,
  treeInterval: 50,
  transferLockup: 10,
  revocationDelay: 50,
  auctionMaturity: 50 + 50 + 50,
  noRollout: false,
  noReserved: false
};

regtest.block = {
  pruneAfterHeight: 1000,
  keepBlocks: 10000,
  maxTipAge: 0xffffffff,
  slowHeight: 0
};

regtest.activationThreshold = 108;

regtest.minerWindow = 144;

regtest.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
    required: false,
    force: false
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
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
  regtest.deployments.hardening,
  regtest.deployments.rollover,
  regtest.deployments.testdummy
];

regtest.keyPrefix = {
  privkey: 0x5a,
  xpubkey: 0xeab4fa05,
  xprivkey: 0xeab404c7,
  xpubkey58: 'rpub',
  xprivkey58: 'rprv',
  coinType: 5355
};

regtest.addressPrefix = 'rs';

regtest.requireStandard = false;

regtest.rpcPort = 14037;

regtest.walletPort = 14039;

regtest.nsPort = 25349;

regtest.rsPort = 25350;

regtest.minRelay = 1000;

regtest.feeRate = 20000;

regtest.maxFeeRate = 60000;

regtest.identityKey = Buffer.from(
  '104932181cfed7584105c728cdc0eb9af1e7ffdc4a00743fd45e5de66cac7668',
  'hex'
);

regtest.selfConnect = true;

regtest.requestMempool = true;

regtest.claimPrefix = 'hns-regtest:';

/*
 * Simnet
 */

const simnet = {};

simnet.type = 'simnet';

simnet.seeds = [
  'aorsxa4ylaacshipyjkfbvzfkh3jhh4yowtoqdt64nzemqtiw2whk@127.0.0.1'
];

simnet.magic = 0x473bd012;

simnet.port = 15038;

simnet.checkpointMap = {};

simnet.lastCheckpoint = 0;

simnet.halvingInterval = 170000;
simnet.coinbaseMaturity = 6;

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
simnet.pow.targetWindow = 144;
simnet.pow.targetSpacing = 10 * 60;
simnet.pow.blocksPerDay = ((24 * 60 * 60) / simnet.pow.targetSpacing) >>> 0;
simnet.pow.targetTimespan =
  simnet.pow.targetWindow * simnet.pow.targetSpacing;
simnet.pow.minActual = (simnet.pow.targetTimespan / 4) >>> 0;
simnet.pow.maxActual = simnet.pow.targetTimespan * 4;
simnet.pow.targetReset = false;
simnet.pow.noRetargeting = false;

simnet.names = {
  auctionStart: 0,
  rolloutInterval: 1,
  lockupPeriod: 1,
  renewalWindow: 2500,
  renewalPeriod: 1250,
  renewalMaturity: 25,
  claimPeriod: 75000,
  biddingPeriod: 25,
  revealPeriod: 50,
  treeInterval: 2,
  transferLockup: 5,
  revocationDelay: 25,
  auctionMaturity: 25 + 50 + 25,
  noRollout: false,
  noReserved: false
};

simnet.block = {
  pruneAfterHeight: 1000,
  keepBlocks: 10000,
  maxTipAge: 0xffffffff,
  slowHeight: 0
};

simnet.activationThreshold = 75;

simnet.minerWindow = 100;

simnet.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
    required: false,
    force: false
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
    required: false,
    force: false
  },
  testdummy: {
    name: 'testdummy',
    bit: 28,
    startTime: 1559347200, // June 1st, 2019
    timeout: 1654041600, // June 1st, 2022
    threshold: -1,
    window: -1,
    required: false,
    force: true
  }
};

simnet.deploys = [
  simnet.deployments.hardening,
  simnet.deployments.rollover,
  simnet.deployments.testdummy
];

simnet.keyPrefix = {
  privkey: 0x64,
  xpubkey: 0x0420bd3a,
  xprivkey: 0x0420b900,
  xpubkey58: 'spub',
  xprivkey58: 'sprv',
  coinType: 5356
};

simnet.addressPrefix = 'ss';

simnet.requireStandard = false;

simnet.rpcPort = 15037;

simnet.walletPort = 15039;

simnet.nsPort = 35349;

simnet.rsPort = 35350;

simnet.minRelay = 1000;

simnet.feeRate = 20000;

simnet.maxFeeRate = 60000;

simnet.identityKey = Buffer.from(
  '104932181cfed7584105c728cdc0eb9af1e7ffdc4a00743fd45e5de66cac7668',
  'hex'
);

simnet.selfConnect = true;

simnet.requestMempool = false;

simnet.claimPrefix = 'hns-simnet:';

/*
 * Expose
 */

network.main = main;
network.testnet = testnet;
network.regtest = regtest;
network.simnet = simnet;
