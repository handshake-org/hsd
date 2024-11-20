'use strict';

const assert = require('bsert');
const blake2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');
const ChainEntry = require('../../lib/blockchain/chainentry');
const Input = require('../../lib/primitives/input');
const Outpoint = require('../../lib/primitives/outpoint');
const {ZERO_HASH} = require('../../lib/protocol/consensus');

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

walletUtils.dummyInput = () => {
  const hash = random.randomBytes(32);
  return Input.fromOutpoint(new Outpoint(hash, 0));
};

walletUtils.deterministicInput = (id) => {
  const hash = blake2b.digest(fromU32(id));
  return Input.fromOutpoint(new Outpoint(hash, 0));
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
