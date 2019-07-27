/*!
 * test/miner-test.js - test for hsd miner
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * Copyright (c) 2019, Sean Kilgarriff (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const FullNode = require('../lib/node/fullnode');
const consensus = require('../lib/protocol/consensus');
const BN = require('bcrypto/lib/bn.js');
const BLAKE2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');

const network = Network.get('regtest');
const { treeInterval } = network.names;

const node = new FullNode({
  memory: true,
  apiKey: 'foo',
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const { wdb } = node.require('walletdb');
const chain = node.chain;
const mempool = node.mempool;
const miner = node.miner;

let wallet, keyring;

describe('Miner Test', function() {
  before(async () => {
    await node.open();
    wallet = await wdb.create({ network });

    // set controlled address on miner
    const walletkey = await wallet.createReceive();
    keyring = walletkey.getJSON(network);
    miner.addresses = [keyring.address];
  });

  after(async () => {
    await node.close();
  });

  it('should start with chain at height 0', () => {
    assert.equal(chain.height, 0);
  });

  it('should create block the miner stored address', async () => {
    const block = await miner.cpu.mineBlock();

    const addresses = [];
    for (const tx of block.txs)
      for (const output of tx.outputs)
        addresses.push(output.address.toString(network));

    assert.equal(addresses.length, 1);
    assert.equal(addresses[0], keyring.address);
  });

  it('should add blocks to the chain', async () => {
    const height = 6;
    for (let i = 0; i < height; i++) {
      const block = await miner.cpu.mineBlock();
      assert.ok(await chain.add(block));
      await sleep(100);
    }
    assert.equal(chain.height, height);
  });

  it('should mine a tx that alters the treeRoot', async () => {
    const root = node.chain.tip.treeRoot;
    const name = rules.grindName(5, chain.height - 1, network);
    const mtx = await wallet.sendOpen(name, true);

    await sleep(100);

    const txid = Buffer.from(mtx.txid(), 'hex');
    assert(mempool.getTX(txid));

    for (let i = 0; i < treeInterval; i++) {
      const block = await miner.cpu.mineBlock();
      assert.ok(await chain.add(block));
      await sleep(100);
    }

    assert.ok(!root.equals(node.chain.tip.treeRoot));
  });

  it('should mine with a mask', async () => {
    const job = await miner.cpu.createJob();

    const [mask] = job.attempt.randomMask();

    job.mask = mask;

    const block = await miner.cpu.mine(job);

    assert.equal(mask, block.mask);

    assert(block.verifyPOW());
  });

  it('should mine a valid share with a mask', async () => {
    const job = await miner.cpu.createJob();

    const shares = [];
    const blocks = [];

    // Network target
    const target = consensus.fromCompact(job.attempt.bits);

    // Set share target to highest possible.
    const shareTarget = Buffer.from(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'hex'
    );

    // Mask value between share target and network target.
    const [mask] = randomMask(shareTarget, target, job.attempt.prevBlock);

    const maskBN = new BN(mask, 16, 'be');
    const targetBN = new BN(target, 16, 'be');
    const shareTargetBN = new BN(shareTarget, 16, 'be');

    // Share Target   = ff... = 1111 1111
    // Network Target = 7f... = 0111 1111
    // Mask           =       = 1... (remaining bits should be random)
    // Assert Share Target > Mask > Network Target
    assert(maskBN.lt(shareTargetBN));
    assert(maskBN.gt(targetBN));
    assert(targetBN.lt(shareTargetBN));

    job.mask = mask;
    job.attempt.target = shareTarget;

    for (;;) {
      const [nonce] = miner.cpu.findNonceRandom(job);

      const proof = job.attempt.getProof(
        nonce,
        job.attempt.time,
        job.extraNonce,
        job.mask
      );

      if (proof.verify(shareTarget)) {
        shares.push(proof);
        if (proof.verify(target.toBuffer('be', 32))) {
          blocks.push(proof);
          break;
        }
      }
    }

    assert(shares.length > 0);
    assert(blocks.length === 1);
  });
});

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

function randomMask(shareTarget, networkTarget, prevBlock) {
  const mask = BN.random(random, networkTarget, shareTarget).toBuffer('be', 32);
  const hash = BLAKE2b.multi(prevBlock, mask);

  return [mask, hash];
}
