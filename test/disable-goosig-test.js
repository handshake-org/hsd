/**
 * test/disable-goosig-test.js - Test disabling GooSig
 * Copyright (c) 2020, The Handshake Developers (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('fs');
const {resolve} = require('path');
const random = require('bcrypto/lib/random');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const AirdropProof = require('../lib/primitives/airdropproof');
const BlockTemplate = require('../lib/mining/template');
const Block = require('../lib/primitives/block');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const common = require('../lib/blockchain/common');
const VERIFY_NONE = common.flags.VERIFY_NONE;

const network = Network.get('regtest');
const PROOF_FILE = resolve(__dirname, 'data', 'airdrop-proof.base64');
const raw = Buffer.from(fs.readFileSync(PROOF_FILE, 'binary'), 'base64');
const proof = AirdropProof.decode(raw);

/**
 * Create a new FullNode with GooSig
 * disabled at a specific height.
 * @param {String} type
 * @returns {FullNode|SPVNode}
 */

function createNode(type) {
  if (type === 'spv')
    return new SPVNode({
      memory: true,
      network: 'regtest'
    });

  return new FullNode({
    memory: true,
    network: 'regtest'
  });
}

/**
 * Create a mock block with a
 * known previous blockhash.
 * @param {Buffer} prev
 * @returns {Block}
 */

function mockBlock(prev) {
  assert(Buffer.isBuffer(prev));
  assert(prev.length === 32);

  return new Block({
    version: 0,
    prevBlock: prev,
    merkleRoot: random.randomBytes(32),
    witnessRoot: random.randomBytes(32),
    treeRoot: random.randomBytes(32),
    reservedRoot: random.randomBytes(32),
    time: 0,
    bits: network.pow.bits,
    nonce: 0,
    extraNonce: random.randomBytes(24),
    mask: random.randomBytes(32)
  });
}

describe('Disable GooSig', function() {
  let goosigStop;

  before(() => {
    goosigStop = network.goosigStop;
    network.goosigStop = 10;
  });

  after(() => {
    network.goosigStop = goosigStop;
  });

  describe('Before Disable', () => {
    let node;

    before(async () => {
      node = createNode();
      await node.open();
    });

    after(async () => {
      await node.close();
    });

    it('should accept GooSig based airdrop in mempool', async () => {
      assert(node.chain.height < node.network.goosigStop);
      await node.mempool.addAirdrop(proof);
      assert.strictEqual(node.mempool.airdrops.size, 1);
      assert(node.mempool.has(proof.hash()));
    });

    it('should accept GooSig based airdrop in block', async () => {
      const block = await node.miner.mineBlock();
      assert.strictEqual(block.txs[0].inputs.length, 2);
      assert(await node.chain.add(block));
    });
  });

  describe('After Disable', () => {
    let node;

    before(async () => {
      node = createNode();
      await node.open();
    });

    after(async () => {
      await node.close();
    });

    it('should reject GooSig based airdrop in mempool', async () => {
      while (node.chain.height - 1 < node.network.goosigStop) {
        const block = await node.miner.mineBlock();
        assert(await node.chain.add(block));
      }

      assert.strictEqual(node.chain.height - 1, node.network.goosigStop);

      let err;
      try {
        await node.mempool.addAirdrop(proof);
      } catch (e) {
        err = e;
      }

      assert.equal(err.type, 'VerifyError');
      assert.equal(err.reason, 'bad-goosig-disabled');
      assert.equal(err.score, 0);
    });

    it('should reject GooSig based airdrop in block', async () => {
      const tip = node.chain.tip;
      const version = await node.chain.computeBlockVersion(tip);
      const mtp = await node.chain.getMedianTime(tip);
      const time = Math.max(node.network.now(), mtp + 1);
      const target = await node.chain.getTarget(time, tip);
      const root = node.chain.db.treeRoot();

      const template = new BlockTemplate({
        prevBlock: tip.hash,
        treeRoot: root,
        reservedRoot: consensus.ZERO_HASH,
        height: tip.height + 1,
        version: version,
        time: time,
        bits: target,
        mtp: mtp
      });

      template.addAirdrop(proof);
      template.refresh();

      let block = template.toBlock(), nonce = 0;
      while (!block.verifyPOW()) {
        const proof = template.getProof(nonce++, time, consensus.ZERO_NONCE, consensus.ZERO_HASH);
        block = template.commit(proof);
      }

      let err;
      try {
        await node.chain.add(block);
      } catch (e) {
        err = e;
      }

      assert.equal(err.type, 'VerifyError');
      assert.equal(err.reason, 'bad-goosig-disabled');
      assert.equal(err.score, 100);

      // Block was added to invalid cache to
      // prevent a revalidation attempt.
      assert(node.chain.hasInvalid(block));
    });
  });

  describe('Clear Mempool', () => {
    let node;

    before(async () => {
      node = createNode();
      await node.open();
      await node.mempool.addAirdrop(proof);
    });

    after(async () => {
      await node.close();
    });

    it('should remove GooSig based airdrop', async () => {
      assert.strictEqual(node.mempool.airdrops.size, 1);
      assert(node.mempool.has(proof.hash()));

      while (node.chain.height < node.network.goosigStop) {
        const block = await node.miner.mineBlock();
        assert(await node.chain.add(block));
      }

      assert.strictEqual(node.mempool.has(proof.hash()), false);
      assert.strictEqual(node.mempool.airdrops.size, 0);
    });
  });

  describe('SPV', () => {
    let node;

    before(async () => {
      node = createNode('spv');
      await node.open();
    });

    after(async () => {
      await node.close();
    });

    it('should not send airdrop after', async () => {
      const genesis = await node.chain.getEntryByHeight(0);

      let err = null;
      node.once('error', (error) => {
        err = error;
      });

      let prev = genesis.hash;
      while (node.chain.height < node.network.goosigStop) {
        const block = mockBlock(prev);
        await node.chain.add(block, VERIFY_NONE);
        prev = block.hash();
      }

      await node.sendAirdrop(proof);

      assert(err);
      assert.strictEqual(err.message, 'GooSig disabled.');
    });
  });
});

