'use strict';

const assert = require('bsert');
const blake2b = require('bcrypto/lib/blake2b');
const ChainEntry = require('../../lib/blockchain/chainentry');
const MTX = require('../../lib/primitives/mtx');
const {ZERO_HASH} = require('../../lib/protocol/consensus');
const primutils = require('./primitives');
const {coinbaseInput, makeOutput} = primutils;

/** @typedef {import('../../lib/types').Amount} Amount */
/** @typedef {import('../../lib/covenants/rules').types} covenantTypes */
/** @typedef {import('../../lib/primitives/output')} Output */
/** @typedef {import('../../lib/wallet/wallet')} Wallet */

const walletUtils = exports;

const REGTEST_TIME = 1580745078;

walletUtils.fakeBlock = (height, prevSeed = 0, seed = prevSeed) => {
  assert(height >= 0);
  const prev = height === 0 ? ZERO_HASH : blake2b.digest(fromU32(((height - 1) ^ prevSeed) >>> 0));
  const hash = blake2b.digest(fromU32((height ^ seed) >>> 0));
  const root = blake2b.digest(fromU32((height | 0x80000000 ^ seed) >>> 0));

  return {
    hash: hash,
    prevBlock: prev,
    merkleRoot: root,
    time: REGTEST_TIME + (height * (10 * 60)),
    bits: 0,
    nonce: 0,
    height: height,
    version: 0,
    witnessRoot: Buffer.alloc(32),
    treeRoot: Buffer.alloc(32),
    reservedRoot: Buffer.alloc(32),
    extraNonce: Buffer.alloc(24),
    mask: Buffer.alloc(32)
  };
};

walletUtils.nextBlock = (wdb, prevSeed = 0, seed = prevSeed) => {
  return walletUtils.fakeBlock(wdb.state.height + 1, prevSeed, seed);
};

walletUtils.curBlock = (wdb, prevSeed = 0, seed = prevSeed) => {
  return walletUtils.fakeBlock(wdb.state.height, prevSeed, seed);
};

walletUtils.fakeEntry = (height, prevSeed = 0, curSeed = prevSeed) => {
  const cur = walletUtils.fakeBlock(height, prevSeed, curSeed);
  return new ChainEntry(cur);;
};

walletUtils.nextEntry = (wdb, curSeed = 0, nextSeed = curSeed) => {
  const next = walletUtils.nextBlock(wdb, curSeed, nextSeed);
  return new ChainEntry(next);
};

walletUtils.curEntry = (wdb, prevSeed = 0, seed = prevSeed) => {
  return walletUtils.fakeEntry(wdb.state.height, seed);
};

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}

walletUtils.dumpWDB = async (wdb, prefixes) => {
  const data = await wdb.dump();
  const filtered = {};

  for (const [key, value] of Object.entries(data)) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) {
        filtered[key] = value;
        break;
      }
    }
  }

  return filtered;
};

/**
 * @typedef {Object} OutputInfo
 * @property {String} [address]
 * @property {Number} [account=0] - address generation account.
 * @property {Amount} [value]
 * @property {covenantTypes} [covenant]
 * @property {Boolean} [coinbase=false]
 */

/**
 * @param {Wallet} wallet
 * @param {primutils.OutputOptions} outputInfo
 * @param {Object} options
 * @param {Boolean} [options.createAddress=true] - create address if not provided.
 * @returns {Promise<Output>}
 */

async function mkOutput(wallet, outputInfo, options = {}) {
  const info = { ...outputInfo };

  const {
    createAddress = true
  } = options;

  if (!info.address) {
    const account = outputInfo.account || 0;

    if (createAddress) {
      const walletKey = await wallet.createReceive(account);
      info.address = walletKey.getAddress();
    } else {
      info.address = await wallet.receiveAddress(account);
    }
  }

  return makeOutput(info);
}

walletUtils.deterministicId = 0;

/**
 * Create Inbound TX Options
 * @typedef {Object} InboundTXOptions
 * @property {Boolean} [txPerOutput=true]
 * @property {Boolean} [createAddress=true]
 * @property {Boolean} [deterministicInput=false]
 */

/**
 * Create funding MTXs for a wallet.
 * @param {Wallet} wallet
 * @param {OutputInfo[]} outputInfos
 * @param {InboundTXOptions} options
 * @returns {Promise<TX[]>}
 */

walletUtils.createInboundTXs = async function createInboundTXs(wallet, outputInfos, options = {}) {
  assert(Array.isArray(outputInfos));

  const {
    txPerOutput = true,
    createAddress = true
  } = options;

  let hadCoinbase = false;

  const txs = [];

  let mtx = new MTX();

  let getInput = primutils.dummyInput;

  if (options.deterministicInput) {
    getInput = () => {
      const id = walletUtils.deterministicId++;
      return primutils.deterministicInput(id);
    };
  }

  for (const info of outputInfos) {
    if (txPerOutput)
      mtx = new MTX();

    if (info.coinbase && hadCoinbase)
      throw new Error('Coinbase already added.');

    if (info.coinbase && !hadCoinbase) {
      if (!txPerOutput)
        hadCoinbase = true;
      mtx.addInput(coinbaseInput());
    } else if (!hadCoinbase) {
      mtx.addInput(getInput());
    }

    const output = await mkOutput(wallet, info, { createAddress });
    mtx.addOutput(output);

    if (output.covenant.isLinked())
      mtx.addInput(getInput());

    if (txPerOutput)
      txs.push(mtx.toTX());
  }

  if (!txPerOutput)
    txs.push(mtx.toTX());

  return txs;
};

/**
 * Fund wallet options
 * @typedef {Object} FundOptions
 * @property {Boolean} [txPerOutput=true]
 * @property {Boolean} [createAddress=true]
 * @property {Boolean} [blockPerTX=false]
 */

/**
 * @param {Wallet} wallet
 * @param {OutputInfo[]} outputInfos
 * @param {FundOptions} options
 * @returns {Promise<TX[]>}
 */

walletUtils.fundWallet = async function fundWallet(wallet, outputInfos, options = {}) {
  const txs = await walletUtils.createInboundTXs(wallet, outputInfos, options);

  if (!options.blockPerTX) {
    await wallet.wdb.addBlock(walletUtils.nextBlock(wallet.wdb), txs);
    return txs;
  }

  for (const tx of txs) {
    await wallet.wdb.addTX(tx);
    await wallet.wdb.addBlock(walletUtils.nextBlock(wallet.wdb), [tx]);
  }

  return txs;
};
