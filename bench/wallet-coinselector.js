/*!
 * bench/wallet-coinselector.js - benchmark wallet coin selections.
 *
 * This can prepare coin set for the wallet and then run different
 * coin selection algorithms on it. The wallet will run on the regtest.
 *
 * Usage:
 *  node bench/wallet-coinselector.js [--prefix=path] [--unspendable=<number>]
 *                                    [--spendable=<number>] [--opens=<number>]
 *                                    [--per-block=<number>] [--cleanup]
 *                                    [--ops-per-type=<number>] [--skip-init]
 *                                    [--output=<file>] [--no-print] [--no-logs]
 *                                    [--skip-sends] [--skip-bids]
 *                                    [--skip-updates] [--skip-renewals]
 *                                    [--skip-transfers]
 *
 * Options:
 *  - `prefix`       The location to store the walletdb. If data exists,
 *                   it will be used for the benchmark. (Default: tmp)
 *  - `opens`        The number of 0 value OPEN coins.
 *                   Default: 1 000.
 *  - `spendable`    The number of SPENDABLE coins.
 *                   Default: 2 000.
 *  - `unspendable`  The number of UNSPENDABLE coins.
 *                   Default: 1 500.
 *  - `per-block`    The number of each coin type per block.
 *                   Default: 300.
 *  - `cleanup`      Remove the walletdb after the benchmark.
 *                   Default: false.
 *  - `ops-per-type` The number of operations per type.
 *                   Default: 200.
 *  - `max-pending`  The maximum number of coins to be spent. Ops will zap
 *                   all pending txs after every `max-pending` operations.
 *                   Default: 50.
 *  - `skip-init`    Skip the initialization of the wallet. This will
 *                   only run the benchmarks on the existing data.
 *                   Default: false.
 *  - `output`       The output file to store the benchmark results.
 *                   Default: null.
 *  - `no-print`     Do not print the benchmark results to the console.
 *                   Default: false.
 *  - `no-logs`      Do not print the logs to the console.
 *                   Default: false.
 */

'use strict';

process.title = 'hsd-coinselector-bench';

const Config = require('bcfg');
const path = require('path');
const os = require('os');
const bfs = require('bfile');
const Covenant = require('../lib/primitives/covenant');
const Network = require('../lib/protocol/network');
const WalletDB = require('../lib/wallet/walletdb');
const NameState = require('../lib/covenants/namestate');
const {Resource} = require('../lib/dns/resource');
const wcommon = require('../lib/wallet/common');
const wutils = require('../test/util/wallet');
const random = require('bcrypto/lib/random');
const primutils = require('../test/util/primitives');
const {DB_VALUE, DB_AGE} = wcommon.coinSelectionTypes;

/** @typedef {import('../lib/covenants/rules').types} covenantTypes */
/** @typedef {import('../lib/wallet/wallet')} Wallet */

(async () => {
  const cfg = new Config('hsd');

  cfg.load({
    argv: true,
    env: true
  });

  const network = Network.get('regtest');
  const tmp = path.join(os.tmpdir(), 'hsd-bench');
  const prefix = cfg.str('prefix', tmp);
  const options = {
    opens: cfg.int('opens', 1_000),
    spendable: cfg.int('spendable', 2_000),
    unspendable: cfg.int('unspendable', 1_500),
    perBlock: cfg.int('per-block', 400),
    cleanup: cfg.bool('cleanup', false),
    opsPerType: cfg.int('ops-per-type', 500),
    maxPending: cfg.int('max-pending', 200),
    skipInit: cfg.bool('skip-init', false),
    noPrint: cfg.bool('no-print', false),
    output: cfg.str('output', null),
    noLogs: cfg.bool('no-logs', false),

    skipSends: cfg.bool('skip-sends', false),
    skipBids: cfg.bool('skip-bids', false),
    skipUpdates: cfg.bool('skip-updates', false),
    skipRenewals: cfg.bool('skip-renewals', false),
    skipTransfers: cfg.bool('skip-transfers', false)
  };

  if (options.maxPending > options.opsPerType)
    throw new Error('max-pending cannot be greater than ops-per-type.');

  options.opens = Math.max(options.opens, options.maxPending);
  options.unspendable = Math.max(options.unspendable, options.maxPending);

  if (!await bfs.exists(prefix))
    await bfs.mkdirp(prefix);

  let consoleLog = console.log.bind(console);
  let stdoutWrite = process.stdout.write.bind(process.stdout);

  if (options.noLogs) {
    consoleLog = () => {};
    stdoutWrite = () => {};
  }

  consoleLog(`WalletDB location: ${prefix}`);

  const wdb = new WalletDB({
    memory: false,
    network,
    prefix
  });

  await wdb.open();
  await wdb.primary.zap(-1, 0);

  if (!options.skipInit) {
    const left = {
      opens: options.opens,
      spendable: options.spendable,
      unspendable: options.unspendable
    };

    consoleLog('Collect existing data.');
    const coins = await wdb.primary.getCoins(0);

    for (const coin of coins) {
      if (coin.covenant.type === Covenant.types.OPEN) {
        left.opens--;
        continue;
      }

      if (coin.covenant.type === Covenant.types.NONE
          || coin.covenant.type === Covenant.types.REDEEM) {
        left.spendable--;
        continue;
      }

      left.unspendable--;
    }

    consoleLog(`Coins: ${coins.length}, Left to mine:
    opens: ${left.opens}
    spendable: ${left.spendable}
    unspendable: ${left.unspendable}`);

    const opens = distributeCoinsPerBlock(left.opens, options.perBlock);
    const spendable = distributeCoinsPerBlock(left.spendable,
                                              options.perBlock);
    const unspendable = distributeCoinsPerBlock(left.unspendable,
                                                options.perBlock);

    const max = Math.max(opens.length, spendable.length, unspendable.length);
    consoleLog(`Blocks to mine: ${max}`);

    for (let i = 0; i < max; i++) {
      const openTXs = await createOpenTXs(wdb.primary, opens[i] || 0);
      const spendTXs = await createSpendTXs(wdb.primary, spendable[i] || 0);
      const unspendTXs = await createUnspendableTXs(wdb.primary,
        unspendable[i] || 0);

      consoleLog(`Block: ${wdb.height + 1}, `
        + `opens: ${openTXs.length}, `
        + `spends: ${spendTXs.length}, `
        + `unspendables: ${unspendTXs.length}`);

      await wdb.addBlock(wutils.nextBlock(wdb),
        [].concat(openTXs, spendTXs, unspendTXs));
    }

    const treeInterval = network.names.treeInterval;
    const biddingPeriod = network.names.biddingPeriod;
    const revealPeriod = network.names.revealPeriod;

    if (max) {
      consoleLog('Progressing to the closed phase...');
      for (let i = 0; i < biddingPeriod + revealPeriod; i++) {
        await wdb.addBlock(wutils.nextBlock(wdb), []);
      }
    }

    // Prepare bidding names
    const existingBiddingNames = await getBiddableNames(wdb.primary);

    consoleLog(`Existing bidding names: ${existingBiddingNames.length}`);
    if (existingBiddingNames.length < options.maxPending) {
      stdoutWrite('Creating bidding names...');
      const biddingNames = Array.from({ length: options.maxPending }, () => {
        return primutils.randomName(30);
      });

      const openInfos = biddingNames.map((name) => {
        return {
          value: 0,
          covenant: {
            type: Covenant.types.OPEN,
            name
          }
        };
      });

      const txs = await wutils.createInboundTXs(wdb.primary, openInfos, {
        txPerOutput: true,
        createAddress: true
      });

      await wdb.addBlock(wutils.nextBlock(wdb), txs);

      for (let i = 0; i < treeInterval + 1; i++) {
        // progress to the bidding phase.
        await wdb.addBlock(wutils.nextBlock(wdb), []);
      }

      stdoutWrite(' Done.\n');
    }

    await wdb.primary.zap(-1, 0);
    consoleLog('Wallet initialized.');
  }

  const wallet = wdb.primary;

  const benchmarks = new BenchmarkResults({
    opens: options.opens,
    spendable: options.spendable,
    unspendable: options.unspendable,
    maxPending: options.maxPending
  });

  const runOperations = async (sendTXFn) => {
    await wallet.zap(-1, 0);

    let pending = 0;
    for (let i = 0; i < options.opsPerType; i++) {
      await sendTXFn(pending);
      pending++;

      if (i % options.maxPending === 0) {
        await wallet.zap(-1, 0);
        pending = 0;
      }
    }

    await wallet.zap(-1, 0);
  };

  // Benchmark normal sends.
  consoleLog(`Running benchmarks...
  ${options.opsPerType} operations per type.
  ${options.maxPending} max pending.`);

  const selections = [
    'random',
    'value',
    DB_VALUE,
    'age',
    DB_AGE
  ];

  for (const selection of selections) {
    if (options.skipSends)
      continue;

    stdoutWrite(`Sending ${selection} selection...`);
    await runOperations(async (pending) => {
      const min = Math.min(options.spendable * 1e5 / options.maxPending,
        1e6);
      const max = Math.min(options.spendable * 1e5 / options.maxPending,
        1000e6);
      const value = random.randomRange(min, max);
      const address = primutils.randomP2PKAddress();
      const before = process.hrtime.bigint();
      await wallet.send({
        selection,
        outputs: [{
          value,
          address
        }]
      });

      const after = process.hrtime.bigint();

      const entry = new BenchmarkEntry('send', selection,
        after - before,pending);

      benchmarks.addResult(entry);
    });

    stdoutWrite(' Done.\n');
  }

  for (const selection of selections) {
    if (options.skipBids)
      continue;
    stdoutWrite(`Bidding ${selection} selection...`);

    const biddingNames = await getBiddableNames(wallet);

    if (biddingNames.length < options.maxPending)
      throw new Error('Not enough bidding names to benchmark.');

    await runOperations(async (pending) => {
      const min = Math.min(options.spendable * 1e5 / options.maxPending,
        1e6);
      const max = Math.min(options.spendable * 1e5 / options.maxPending,
        1000e6);
      const value = random.randomRange(min, max);
      const name = biddingNames[pending];
      const before = process.hrtime.bigint();
      await wallet.sendBid(name, value, value, {
        selection
      });

      const after = process.hrtime.bigint();

      const entry = new BenchmarkEntry('bid', selection,
        after - before, pending);

      benchmarks.addResult(entry);
    });

    stdoutWrite(' Done.\n');
  }

  const namestates = await wallet.getNames();
  const selectedOwned = [];

  for (const ns of namestates) {
    const {hash, index} = ns.owner;
    const coin = await wallet.getCoin(hash, index);

    if (!coin)
      continue;

    if (ns.state(wdb.height, network) === NameState.states.CLOSED) {
      if (ns.isExpired(wdb.height, network))
        continue;

      selectedOwned.push(ns.name.toString('ascii'));
    }

    if (selectedOwned.length >= options.maxPending)
      break;
  }

  if (selectedOwned.length < options.maxPending)
    throw new Error('Not enough owned names to benchmark.');

  const res = Resource.fromString('Resource');
  for (const selection of selections) {
    if (options.skipUpdates)
      continue;
    stdoutWrite(`Updating ${selection} selection...`);

    await runOperations(async (pending) => {
      const before = process.hrtime.bigint();
      await wallet.sendUpdate(selectedOwned[pending], res, { selection });
      const after = process.hrtime.bigint();

      const entry = new BenchmarkEntry('update', selection,
        after - before, pending);
      benchmarks.addResult(entry);
    });

    stdoutWrite(' Done.\n');
  }

  for (const selection of selections) {
    if (options.skipRenewals)
      continue;
    stdoutWrite(`Renewing ${selection} selection...`);

    await runOperations(async (pending) => {
      const before = process.hrtime.bigint();
      await wallet.sendRenewal(selectedOwned[pending], { selection });
      const after = process.hrtime.bigint();

      const entry = new BenchmarkEntry('renew', selection,
        after - before, pending);
      benchmarks.addResult(entry);
    });

    stdoutWrite(' Done.\n');
  }

  // do transfer at the end
  for (const selection of selections) {
    if (options.skipTransfers)
      continue;

    stdoutWrite(`Transfering ${selection} selection...`);

    const addr = primutils.randomP2PKAddress();
    await runOperations(async (pending) => {
      const before = process.hrtime.bigint();
      await wallet.sendTransfer(selectedOwned[pending], addr, { selection });
      const after = process.hrtime.bigint();

      const entry = new BenchmarkEntry('transfer', selection,
        after - before, pending);
      benchmarks.addResult(entry);
    });

    stdoutWrite(' Done.\n');
  }

  benchmarks.calculateStats();

  if (!options.noPrint)
    benchmarks.print();

  if (options.output) {
    const json = benchmarks.toJSON();
    await bfs.writeFile(options.output, JSON.stringify(json, null, 2));
  }

  await wdb.close();

  if (options.cleanup)
    await bfs.rimraf(prefix);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

class BenchmarkEntry {
  /**
   * @param {String} type
   * @param {String} selection
   * @param {BigInt} elapsed
   * @param {Number} pending
   */
  constructor(type, selection, elapsed, pending) {
    /** @type {String} */
    this.type = type;
    /** @type {String} */
    this.selection = selection;
    /** @type {BigInt} */
    this.elapsed = elapsed;
    /** @type {Number} */
    this.pending = pending;
  }

  get key() {
    return `${this.type}-${this.selection}`;
  }
}

/**
 * @typedef {Object} BenchmarkResults
 * @property {String} type
 * @property {String} selection
 * @property {Number} opens
 * @property {Number} spendable
 * @property {Number} unspendable
 * @property {Number} maxPending
 * @property {Number} ops
 * @property {BigInt} min
 * @property {BigInt} max
 * @property {BigInt} median
 * @property {BigInt} percentile95
 * @property {BigInt} avg
 */

class BenchmarkResults {
  constructor(options = {}) {
    this.opens = options.opens || 0;
    this.spendable = options.spendable || 0;
    this.unspendable = options.unspendable || 0;
    this.maxPending = options.maxPending || 0;
    /** @type Map<String, BenchmarkEntry[]> */
    this.benchmarksPerType = new Map();

    /** @type Map<String, BenchmarkResults> */
    this.results = new Map();
  }

  /**
   * @param {BenchmarkEntry} entry
   */

  addResult(entry) {
    const key = entry.key;

    if (!this.benchmarksPerType.has(key))
      this.benchmarksPerType.set(key, []);

    const entries = this.benchmarksPerType.get(key);
    entries.push(entry);
  }

  calculateStats() {
    for (const [key, entries] of this.benchmarksPerType.entries()) {
      const result = {
        type: entries[0].type,
        selection: entries[0].selection,
        opens: this.opens,
        spendable: this.spendable,
        unspendable: this.unspendable,
        maxPending: this.maxPending,
        ops: entries.length,
        min: BigInt(Number.MAX_VALUE),
        max: 0n,
        median: 0n,
        percentile95: 0n,
        avg: 0n
      };

      const sorted = entries.sort((a, b) => Number(a.elapsed - b.elapsed));
      const p95 = Math.floor(sorted.length * 0.95);

      for (let i = 0; i < sorted.length; i++) {
        if (i === p95)
          result.percentile95 = sorted[i].elapsed;

        if (sorted[i].elapsed < result.min)
          result.min = sorted[i].elapsed;

        if (sorted[i].elapsed > result.max)
          result.max = sorted[i].elapsed;

        result.avg += sorted[i].elapsed;
      }

      if (sorted.length > 1 && sorted.length % 2 === 0) {
        const mid1 = sorted[sorted.length / 2 - 1].elapsed;
        const mid2 = sorted[sorted.length / 2].elapsed;
        result.median = (mid1 + mid2) / 2n;
      } else if (sorted.length > 0) {
        result.median = sorted[Math.floor(sorted.length / 2)].elapsed;
      }

      result.avg /= BigInt(sorted.length);

      this.results.set(key, result);
    }
  }

  toResultsArray() {
    const resultTable = [];

    for (const entry of this.results.values()) {
      resultTable.push({
        type: entry.type,
        selection: entry.selection,
        opens: entry.opens,
        spendable: entry.spendable,
        unspendable: entry.unspendable,
        maxPending: entry.maxPending,
        ops: entry.ops,
        minMs: formatElapsedTime(entry.min),
        maxMs: formatElapsedTime(entry.max),
        medianMs: formatElapsedTime(entry.median),
        percentile95ms: formatElapsedTime(entry.percentile95),
        avgMs: formatElapsedTime(entry.avg)
      });
    }

    return resultTable;
  }

  print() {
    if (this.results.size === 0)
      throw new Error('No results to print.');

    console.table(this.toResultsArray());
  }

  toJSON() {
    if (this.results.size === 0)
      throw new Error('No results to print.');

    return {
      data: this.toResultsArray()
    };
  }
}

function distributeCoinsPerBlock(left, perBlock) {
  if (left <= 0)
    return [];

  const full = Math.floor(left / perBlock);
  const rest = left % perBlock;
  const coins = new Array(full).fill(perBlock);

  if (rest > 0)
    coins.push(rest);

  return coins;
}

/**
 * @param {Wallet} wallet
 * @param {Number} opens
 * @returns {Promise<TX[]>}
 */

async function createOpenTXs(wallet, opens) {
  /** @type {wutils.OutputInfo[]} */
  const infos = [];

  for (let i = 0; i < opens; i++) {
    const info = {
      // OPENs are mostly 0 values. It does not need to be this way, but it is.
      value: 0,
      covenant: { type: Covenant.types.OPEN }
    };

    infos.push(info);
  }

  const txs = await wutils.createInboundTXs(wallet, infos, {
    txPerOutput: true,
    createAddress: true
  });

  return txs;
}

/**
 * @param {Wallet} wallet
 * @param {Number} spendable
 * @param {Object} options
 * @param {Number} options.minValue
 * @param {Number} options.maxValue
 * @returns {Promise<TX[]>}
 */

async function createSpendTXs(wallet, spendable, options = {}) {
  /** @type {wutils.OutputInfo[]} */
  const infos = [];
  const spendables = [
    Covenant.types.NONE,
    Covenant.types.REDEEM
  ];

  const {
    minValue = 1e5,
    maxValue = 100e6
  } = options;

  for (let i = 0; i < spendable; i++) {
    const covenant = { type: spendables[i % spendables.length] };
    const value = random.randomRange(minValue, maxValue);
    const info = { value, covenant };

    infos.push(info);
  }

  const txs = await wutils.createInboundTXs(wallet, infos, {
    txPerOutput: true,
    createAddress: true
  });

  return txs;
}

/**
 * @param {Wallet} wallet
 * @param {Number} unspendable
 * @param {Object} options
 * @param {Number} options.minValue
 * @param {Number} options.maxValue
 * @returns {Promise<TX[]>}
 */

async function createUnspendableTXs(wallet, unspendable, options = {}) {
  /** @type {wutils.OutputInfo[]} */
  const infos = [];
  const unspendables = [
    // Covenant.types.REGISTER,
    // Covenant.types.UPDATE,
    // Covenant.types.RENEW,
    Covenant.types.FINALIZE
  ];

  const {
    minValue = 1e5,
    maxValue = 100e6
  } = options;

  for (let i = 0; i < unspendable; i++) {
    const covenant = { type: unspendables[i % unspendables.length] };
    const value = random.randomRange(minValue, maxValue);
    const info = { value, covenant };

    infos.push(info);
  }

  const txs = await wutils.createInboundTXs(wallet, infos, {
    txPerOutput: true,
    createAddress: true
  });

  return txs;
}

/**
 * @param {BigInt} elapsedNanos
 * @returns {Number}
 */

function formatElapsedTime(elapsedNanos) {
  const nsInMs = 1000000n;

  return Number(elapsedNanos) / Number(nsInMs);
}

/**
 * @param {Wallet} wallet
 * @returns {Promise<String[]>}
 */

async function getBiddableNames(wallet) {
  const height = wallet.wdb.height;
  const network = wallet.network;
  const names = await wallet.getNames();
  const biddable = [];

  for (const ns of names) {
    if (ns.state(height, network) === NameState.states.BIDDING) {
      biddable.push(ns.name.toString('ascii'));
    }
  }

  return biddable;
}
