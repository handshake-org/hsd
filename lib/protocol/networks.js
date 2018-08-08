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

main.halvingInterval = 340000;

/**
 * Number of blocks before a coinbase
 * spend can occur (consensus).
 * @const {Number}
 * @default
 */

main.coinbaseMaturity = 200;

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
  '0007ffff00000000000000000000000000000000000000000000000000000000',
  'hex'
);

/**
 * Compact pow limit.
 * @const {Number}
 * @default
 */

main.pow.bits = 0x1f07ffff;

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

main.pow.targetWindow = 17;

/**
 * Average block time.
 * @const {Number}
 * @default
 */

main.pow.targetSpacing = 5 * 60;

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
  perc: 50
};

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
   * Amount of time weak names are locked up for.
   * @const {Number}
   */

  weakLockup: 182 * main.pow.blocksPerDay,

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
 * Genesis block keys.
 * @const {Object}
 */

main.keys = {
  /**
   * Investors key.
   * @const {Buffer}
   */

  // addr: hs1qu4ys87tlaef5zchtcepkknlhucdu6k3etth4yt
  investors: Buffer.from('e54903f97fee534162ebc6436b4ff7e61bcd5a39', 'hex'),

  /**
   * Creators key.
   * @const {Buffer}
   */

  // addr: hs1qd6m5lcql7syvnddqr6luqkuck84lyszznnqt2f
  creators: Buffer.from('6eb74fe01ff408c9b5a01ebfc05b98b1ebf24042', 'hex'),

  /**
   * Airdrop key.
   * @const {Buffer}
   */

  // addr: hs1qy08hv2q0zgkdctmxkjf0fx7lap7624h9ad5h8s
  airdrop: Buffer.from('23cf76280f122cdc2f66b492f49bdfe87da556e5', 'hex')
};

/**
 * Genesis block private keys (testing only).
 * @const {Object}
 */

main.privs = {
  /**
   * Investors key.
   * @const {Buffer}
   */

  investors: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  ),

  /**
   * Creators key.
   * @const {Buffer}
   */

  creators: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  ),

  /**
   * Airdrop key.
   * @const {Buffer}
   */

  airdrop: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  )
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

  pruneAfterHeight: 2000,

  /**
   * Safe number of blocks to keep.
   */

  keepBlocks: 576,

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

main.activationThreshold = 3832;

/**
 * Confirmation window for versionbits.
 * @const {Number}
 * @default
 */

main.minerWindow = 4032;

/**
 * Deployments for versionbits.
 * @const {Object}
 * @default
 */

main.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
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

testnet.magic = 0x7cfa1fbe;

testnet.port = 13038;

testnet.checkpointMap = {};

testnet.lastCheckpoint = 0;

testnet.halvingInterval = 340000;
testnet.coinbaseMaturity = 200;

testnet.genesis = genesis.testnet;
testnet.genesisBlock = genesis.testnetData;

testnet.pow = {};
testnet.pow.limit = new BN(
  '07ffff0000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.bits = 0x2007ffff;
testnet.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.targetWindow = 17;
testnet.pow.targetSpacing = 5 * 60;
testnet.pow.blocksPerDay = (24 * 60 * 60) / testnet.pow.targetSpacing;
testnet.pow.targetTimespan =
  testnet.pow.targetWindow * testnet.pow.targetSpacing;
testnet.pow.minActual = ((testnet.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
testnet.pow.maxActual = ((testnet.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
testnet.pow.targetReset = true;
testnet.pow.noRetargeting = false;

testnet.cuckoo = {
  // 64x easier than mainnet.
  bits: 24,
  size: 42,
  perc: 50
};

testnet.names = {
  auctionStart: (0.5 * testnet.pow.blocksPerDay) | 0,
  rolloutInterval: (0.5 * testnet.pow.blocksPerDay) | 0,
  renewalWindow: 30 * testnet.pow.blocksPerDay,
  renewalPeriod: 7 * testnet.pow.blocksPerDay,
  renewalMaturity: 1 * testnet.pow.blocksPerDay,
  claimPeriod: 25 * testnet.pow.blocksPerDay,
  biddingPeriod: 1 * testnet.pow.blocksPerDay,
  revealPeriod: 2 * testnet.pow.blocksPerDay,
  treeInterval: testnet.pow.blocksPerDay >>> 2,
  transferLockup: 2 * testnet.pow.blocksPerDay,
  weakLockup: (3 * 60) * testnet.pow.blocksPerDay,
  revocationDelay: 4 * testnet.pow.blocksPerDay,
  auctionMaturity: (1 + 2 + 4) * testnet.pow.blocksPerDay,
  noRollout: false,
  noReserved: false
};

testnet.keys = {
  // pub: 026c7621d18c912d81952a7a261faaeeb4f358f6bba64956596e56411b9d003550
  // addr: ts1qsnwg2ga55kcsycc6z5qrh6wdkpt3eh7grt90uv
  investors: Buffer.from('84dc8523b4a5b102631a15003be9cdb0571cdfc8', 'hex'),

  // pub: 03cb9864c0cf4c657176f52c097a4607f4b1dde877ff10e65fc3ec46ee6ee5bdc5
  // addr: ts1qx9apueaef7hpdx0xlmlu59m4mytdtagkyu6qc4
  creators: Buffer.from('317a1e67b94fae1699e6feffca1775d916d5f516', 'hex'),

  // pub: 0236752496058cc753dc6b1a562631fdd96e88cf2746791f816235eaa3bb9b3569
  // addr: ts1qtjr4ulexeu5gj7xnxvkfl9hljfh8yc5f804nth
  airdrop: Buffer.from('5c875e7f26cf288978d3332c9f96ff926e726289', 'hex')
};

testnet.privs = {
  investors: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  ),
  creators: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  ),
  airdrop: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  )
};

testnet.block = {
  pruneAfterHeight: 2000,
  keepBlocks: 20000,
  maxTipAge: 12 * 60 * 60,
  slowHeight: 0
};

testnet.activationThreshold = 3024;

testnet.minerWindow = 4032;

testnet.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
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

regtest.halvingInterval = 5000;
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
regtest.pow.targetWindow = 17;
regtest.pow.targetSpacing = 5 * 60;
regtest.pow.blocksPerDay = (24 * 60 * 60) / regtest.pow.targetSpacing;
regtest.pow.targetTimespan =
  regtest.pow.targetWindow * regtest.pow.targetSpacing;
regtest.pow.minActual = ((regtest.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
regtest.pow.maxActual = ((regtest.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
regtest.pow.targetReset = true;
regtest.pow.noRetargeting = true;

regtest.cuckoo = {
  bits: 8,
  size: 4,
  perc: 50
};

regtest.names = {
  auctionStart: 0,
  rolloutInterval: 5,
  renewalWindow: 10000,
  renewalPeriod: 5000,
  renewalMaturity: 100,
  claimPeriod: 300000,
  biddingPeriod: 10,
  revealPeriod: 20,
  treeInterval: 10,
  transferLockup: 20,
  weakLockup: 51840,
  revocationDelay: 100,
  auctionMaturity: 10 + 20 + 100,
  noRollout: false,
  noReserved: false
};

regtest.keys = {
  // pub: 03226b2f079568504017685262f14bd1f1aa3981d0b341880857d1581513fca279
  // addr: rs1qp7suu9jc40gmv977wc43rcju8h02kcj22mv23y
  investors: Buffer.from('0fa1ce1658abd1b617de762b11e25c3ddeab624a', 'hex'),

  // pub: 0266e2f391e4856fcb2bd1c69daffb2cdacb68a5e66dbc004ac94d1e5b01162869
  // addr: rs1qgulxzuykwcsrx5pm2slydpgkhln2fyv583ptcl
  creators: Buffer.from('473e617096762033503b543e468516bfe6a49194', 'hex'),

  // pub: 03d7a608869fa125f9c70599dbde632ba971f31cf69e6f71fa406b94e674317967
  // addr: rs1qecflj8cnc4wex7ax6skcsjv084jnqmldg92c46
  airdrop: Buffer.from('ce13f91f13c55d937ba6d42d88498f3d65306fed', 'hex')
};

regtest.privs = {
  investors: Buffer.from(
    'f211b522b5769becc7815a92a4fc7f862587a42ef473923cbd113c2afa3348ec',
    'hex'
  ),
  creators: Buffer.from(
    '6bae0034f873ccebf3797822f6cf60c1cee35d70bc52f6060f7db3d471e5a238',
    'hex'
  ),
  airdrop: Buffer.from(
    '6436fd3bc94e24ae3cbdaf793da1c956f39fabf3559ffaab17d330ee666d8ccd',
    'hex'
  )
};

regtest.block = {
  pruneAfterHeight: 2000,
  keepBlocks: 20000,
  maxTipAge: 0xffffffff,
  slowHeight: 0
};

regtest.activationThreshold = 216;

regtest.minerWindow = 288;

regtest.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
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

simnet.halvingInterval = 340000;
simnet.coinbaseMaturity = 12;

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
simnet.pow.targetWindow = 17;
simnet.pow.targetSpacing = 5 * 60;
simnet.pow.blocksPerDay = (24 * 60 * 60) / simnet.pow.targetSpacing;
simnet.pow.targetTimespan =
  simnet.pow.targetWindow * simnet.pow.targetSpacing;
simnet.pow.minActual = ((simnet.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
simnet.pow.maxActual = ((simnet.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
simnet.pow.targetReset = false;
simnet.pow.noRetargeting = false;

simnet.cuckoo = {
  bits: 16,
  size: 18,
  perc: 50
};

simnet.names = {
  auctionStart: 0,
  rolloutInterval: 3,
  renewalWindow: 5000,
  renewalPeriod: 2500,
  renewalMaturity: 50,
  claimPeriod: 150000,
  biddingPeriod: 50,
  revealPeriod: 100,
  treeInterval: 5,
  transferLockup: 10,
  weakLockup: 51840,
  revocationDelay: 50,
  auctionMaturity: 50 + 100 + 50,
  noRollout: false,
  noReserved: false
};

simnet.keys = {
  // pub: 036b5b171a74df5493968dcdbb94af32742d39d82b848cfae7e4a8f9388b8cf45e
  // addr: ss1qxqwg2pz5watawgawv34m5yrug0yfnge8kxfpyx
  investors: Buffer.from('301c8504547757d723ae646bba107c43c899a327', 'hex'),

  // pub: 0278d5bafe82dfdf2a3837a52c9fa546061574dc9ba14f4d188bdb4af24db514a5
  // addr: ss1qzthklyg80h26nhzva4gtfk9wn2muvrsxe6cp80
  creators: Buffer.from('12ef6f91077dd5a9dc4ced50b4d8ae9ab7c60e06', 'hex'),

  // pub: 0323fcf82fb31fb90cdc02578092b4a02201cbfcf79dbf5a94f404df6341ba2cba
  // addr: ss1q3klj80sws0thgygl6x7y7kz3sjmp9smydgvqg0
  airdrop: Buffer.from('8dbf23be0e83d774111fd1bc4f585184b612c364', 'hex')
};

simnet.privs = {
  investors: Buffer.from(
    '0398fc5b3e8044c2319f1aa96790daecc0c191a04734426612df55e798c63b50',
    'hex'
  ),
  creators: Buffer.from(
    'b344d5c357d4d983f71ba4b37a9e36ff74dccf6e99d9398662e085e87e6628b4',
    'hex'
  ),
  airdrop: Buffer.from(
    'f13bfddeb3b8ad09bc5057e198e18d2d476ef22a56a956ead2abcc458e4d247c',
    'hex'
  )
};

simnet.block = {
  pruneAfterHeight: 2000,
  keepBlocks: 20000,
  maxTipAge: 0xffffffff,
  slowHeight: 0
};

simnet.activationThreshold = 150;

simnet.minerWindow = 200;

simnet.deployments = {
  hardening: {
    name: 'hardening',
    bit: 0,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
  },
  rollover: {
    name: 'rollover',
    bit: 1,
    startTime: 1538697600, // Oct 5th, 2018
    timeout: 1633392000, // Oct 5th, 2021
    threshold: -1,
    window: -1,
    required: false,
    force: true
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
