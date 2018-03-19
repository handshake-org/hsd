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

main.pow.targetSpacing = 2.5 * 60;

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
   * Foundation key.
   * @const {Buffer}
   */

  // addr: hs1qvd2ejzu6w53n98e277zrj44vz9ljmz9qhjy0z0
  foundation: Buffer.from('6355990b9a7523329f2af7843956ac117f2d88a0', 'hex'),

  /**
   * Foundation hot key.
   * @const {Buffer}
   */

  // addr: hs1qe363az2q6d642kp5z56mvk5kfzr2gaql5dtll0
  claimant: Buffer.from('cc751e8940d3755558341535b65a964886a4741f', 'hex'),

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
   * Foundation key.
   * @const {Buffer}
   */

  foundation: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  ),

  /**
   * Foundation hot key.
   * @const {Buffer}
   */

  claimant: Buffer.from(
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

  pruneAfterHeight: 4000,

  /**
   * Safe number of blocks to keep.
   */

  keepBlocks: 1152,

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

  slowHeight: 0,

  /**
   * Launch date.
   */

  launchDate: 1522540800
};

/**
 * For versionbits.
 * @const {Number}
 * @default
 */

main.activationThreshold = 7664;

/**
 * Confirmation window for versionbits.
 * @const {Number}
 * @default
 */

main.minerWindow = 8064;

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

/*
 * Testnet
 */

const testnet = {};

testnet.type = 'testnet';

testnet.seeds = [];

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
  '07ffff0000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.bits = 0x2007ffff;
testnet.pow.chainwork = new BN(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);
testnet.pow.targetWindow = 17;
testnet.pow.targetSpacing = 2.5 * 60;
testnet.pow.blocksPerDay = (24 * 60 * 60) / testnet.pow.targetSpacing;
testnet.pow.targetTimespan =
  testnet.pow.targetWindow * testnet.pow.targetSpacing;
testnet.pow.minActual = ((testnet.pow.targetTimespan * (100 - 16)) / 100) >>> 0;
testnet.pow.maxActual = ((testnet.pow.targetTimespan * (100 + 32)) / 100) >>> 0;
testnet.pow.targetReset = true;
testnet.pow.noRetargeting = false;

testnet.cuckoo = {
  bits: 30,
  size: 42,
  ease: 50
};

testnet.names = {
  auctionStart: 0,
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

testnet.keys = {
  // pub: 026c7621d18c912d81952a7a261faaeeb4f358f6bba64956596e56411b9d003550
  // addr: ts1qsnwg2ga55kcsycc6z5qrh6wdkpt3eh7grt90uv
  investors: Buffer.from('84dc8523b4a5b102631a15003be9cdb0571cdfc8', 'hex'),

  // pub: 029b856ea1aa7d3969ca46a7a636321a3c6063bcf088f4a233bd789cb233c1475e
  // addr: ts1qstkrgzpu8ctpe0pkvmfyvk2pzxlplydu2wx8yr
  foundation: Buffer.from('82ec34083c3e161cbc3666d246594111be1f91bc', 'hex'),

  // pub: 02ab921dd16d4f64721599560a78829725f5acaaf9b430947fab2df618fda67543
  // addr: ts1qv45audvtv50j2vvetyxnzg5425gnlf7spph379
  claimant: Buffer.from('6569de358b651f253199590d31229555113fa7d0', 'hex'),

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
  foundation: Buffer.from(
    '0000000000000000000000000000000000000000000000000000000000000000',
    'hex'
  ),
  claimant: Buffer.from(
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
  pruneAfterHeight: 4000,
  keepBlocks: 40000,
  maxTipAge: 24 * 60 * 60,
  slowHeight: 0,
  launchDate: 1522540800
};

testnet.activationThreshold = 6048;

testnet.minerWindow = 8064;

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

regtest.halvingInterval = 10000;
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
regtest.pow.targetSpacing = 2.5 * 60;
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
  ease: 50
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
  totalPeriod: 10 + 20,
  trieInterval: 10,
  transferLockup: 20,
  revocationDelay: 100,
  auctionMaturity: 10 + 20 + 100,
  noRollout: false,
  noReserved: true
};

regtest.keys = {
  // pub: 03226b2f079568504017685262f14bd1f1aa3981d0b341880857d1581513fca279
  // addr: rs1qp7suu9jc40gmv977wc43rcju8h02kcj22mv23y
  investors: Buffer.from('0fa1ce1658abd1b617de762b11e25c3ddeab624a', 'hex'),

  // pub: 02f5f14fd89b072a371c877c838607f331c8b94c098700f6a077a1681999420db2
  // addr: rs1q33arfc7wdclp82zyy2fwfe3jahsxscrn5lh8ys
  foundation: Buffer.from('8c7a34e3ce6e3e13a8442292e4e632ede0686073', 'hex'),

  // pub: 023c7d0c98d8877e97b6103f2fcddd3daa21feca765356bde7f755a4383d2006b8
  // addr: rs1qw00l4w8tgjs3gpvvym2c68g7g9a3d0hrv4ecse
  claimant: Buffer.from('73dffab8eb44a114058c26d58d1d1e417b16bee3', 'hex'),

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
  foundation: Buffer.from(
    'c97c6682c5cb8d551f6d2635d367d0860a12fbfbad2bc00c0199d617a1ef7944',
    'hex'
  ),
  claimant: Buffer.from(
    'eda5d9c9c71500d51df3d29bfb2c536badaf4693a04e724886f40d6648309335',
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
  pruneAfterHeight: 4000,
  keepBlocks: 40000,
  maxTipAge: 0xffffffff,
  slowHeight: 0,
  launchDate: 1522540800
};

regtest.activationThreshold = 432;

regtest.minerWindow = 576;

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
simnet.pow.targetWindow = 17;
simnet.pow.targetSpacing = 2.5 * 60;
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
  auctionStart: 0,
  rolloutInterval: 5,
  renewalWindow: 10000,
  renewalPeriod: 5000,
  renewalMaturity: 100,
  claimPeriod: 300000,
  biddingPeriod: 100,
  revealPeriod: 200,
  totalPeriod: 100 + 200,
  trieInterval: 10,
  transferLockup: 20,
  revocationDelay: 100,
  auctionMaturity: 100 + 200 + 100,
  noRollout: false,
  noReserved: false
};

simnet.keys = {
  // pub: 036b5b171a74df5493968dcdbb94af32742d39d82b848cfae7e4a8f9388b8cf45e
  // addr: ss1qxqwg2pz5watawgawv34m5yrug0yfnge8kxfpyx
  investors: Buffer.from('301c8504547757d723ae646bba107c43c899a327', 'hex'),

  // pub: 0380d63496513a7b39790c65d29278af067945e50eddc92842789d9020c7d5dc84
  // addr: ss1qfz95h4c9mpwx62rr4wm36cyqjxgghwlrjq9q97
  foundation: Buffer.from('488b4bd705d85c6d2863abb71d608091908bbbe3', 'hex'),

  // pub: 03e8be330eeac548527e0c5a60751b68bbb5aa28bc6cf44060819c17cd1d8c645f
  // addr: ss1qsynwj4tv6fn52vmd923jqe7g9sg3xznma9pqx2
  claimant: Buffer.from('8126e9556cd26745336d2aa32067c82c11130a7b', 'hex'),

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
  foundation: Buffer.from(
    '693560b70af81d0eb5e550e956a5712df863eaa42b6c24a25692216e0672531c',
    'hex'
  ),
  claimant: Buffer.from(
    '718a37adb53bcb3a32f3078301a924d815ba41c6e61e5b3c015f4da6b1dafa56',
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
  pruneAfterHeight: 4000,
  keepBlocks: 40000,
  maxTipAge: 0xffffffff,
  slowHeight: 0,
  launchDate: 1522540800
};

simnet.activationThreshold = 300;

simnet.minerWindow = 400;

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

/*
 * Expose
 */

network.main = main;
network.testnet = testnet;
network.regtest = regtest;
network.simnet = simnet;
