'use strict';

const blake2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');
const Block = require('../../lib/primitives/block');
const ChainEntry = require('../../lib/blockchain/chainentry');
const Input = require('../../lib/primitives/input');
const Outpoint = require('../../lib/primitives/outpoint');

const walletUtils = exports;

walletUtils.fakeBlock = (height) => {
  const prev = blake2b.digest(fromU32((height - 1) >>> 0));
  const hash = blake2b.digest(fromU32(height >>> 0));
  const root = blake2b.digest(fromU32((height | 0x80000000) >>> 0));

  return {
    hash: hash,
    prevBlock: prev,
    merkleRoot: root,
    time: 500000000 + (height * (10 * 60)),
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

walletUtils.nextBlock = (wdb) => {
  return walletUtils.fakeBlock(wdb.state.height + 1);
};

walletUtils.curBlock = (wdb) => {
  return walletUtils.fakeBlock(wdb.state.height);
};

walletUtils.nextEntry = (wdb) => {
  const cur = walletUtils.curEntry(wdb);
  const next = new Block(walletUtils.nextBlock(wdb));
  return ChainEntry.fromBlock(next, cur);
};

walletUtils.curEntry = (wdb) => {
  return new ChainEntry(walletUtils.curBlock(wdb));
};

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}
