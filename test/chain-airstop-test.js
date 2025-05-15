'use strict';

const fs = require('fs');
const { resolve } = require('path');
const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const chainCommon = require('../lib/blockchain/common');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const Network = require('../lib/protocol/network');
const AirdropProof = require('../lib/primitives/airdropproof');
const { thresholdStates } = chainCommon;

const network = Network.get('regtest');

const AIRDROP_PROOF_FILE = resolve(__dirname, 'data', 'airdrop-proof.base64');
const FAUCET_PROOF_FILE = resolve(__dirname, 'data', 'faucet-proof.base64');
const read = file => Buffer.from(fs.readFileSync(file, 'binary'), 'base64');

// Sent to:
// {
//   pub: '02a8959cc6491aed3fb96b3b684400311f2779fb092b026a4b170b35c175d48cec',
//   hash: '95cb6129c6b98179866094b2717bfbe27d9c1921',
//   addr: 'hs1qjh9kz2wxhxqhnpnqjje8z7lmuf7ecxfp6kxlly'
// }

// Same as airdrop-test.js
const rawProof = read(AIRDROP_PROOF_FILE);
const rawFaucetProof = read(FAUCET_PROOF_FILE); // hs1qmjpjjgpz7dmg37paq9uksx4yjp675690dafg3q

const airdropProof = AirdropProof.decode(rawProof);
const faucetproof = AirdropProof.decode(rawFaucetProof);

const SOFT_FORK_NAME = 'airstop';

function createNode() {
  const blocks = new BlockStore({
    memory: true,
    network
  });

  const chain = new Chain({
    memory: true,
    blocks,
    network
  });

  const miner = new Miner({ chain });

  return { chain, blocks, miner };
}

describe('BIP-9 - Airstop (integration)', function () {
  const checkBIP9Info = (info, expected) => {
    expected = expected || {};
    expected.startTime = expected.startTime || network.deployments[SOFT_FORK_NAME].startTime;
    expected.timeout = expected.timeout || network.deployments[SOFT_FORK_NAME].timeout;

    assert(info, 'BIP9 info should be returned');
    assert.strictEqual(info.status, expected.status);
    assert.strictEqual(info.bit, network.deployments[SOFT_FORK_NAME].bit);
    assert.strictEqual(info.startTime, expected.startTime);
    assert.strictEqual(info.timeout, expected.timeout);
  };

  const checkBIP9Statistcs = (stats, expected) => {
    expected = expected || {};

    assert.strictEqual(stats.period, expected.period || network.minerWindow);
    assert.strictEqual(stats.threshold, expected.threshold || network.activationThreshold);
    assert.strictEqual(stats.elapsed, expected.elapsed);
    assert.strictEqual(stats.count, expected.count);
    assert.strictEqual(stats.possible, expected.possible);
  };

  describe('Success (integration)', function () {
    const node = createNode();

    before(async () => {
      network.deployments[SOFT_FORK_NAME].startTime = 0;
      network.deployments[SOFT_FORK_NAME].timeout = 0xffffffff;

      await node.blocks.open();
      await node.chain.open();
      await node.miner.open();
    });

    after(async () => {
      await node.miner.close();
      await node.chain.close();
      await node.blocks.close();
    });

    it('should be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(node, [airdropProof, faucetproof]);
    });

    it('should be in DEFINED state', async () => {
      const state = await getForkDeploymentState(node.chain);
      const bip9info = await getBIP9Info(network, node.chain);

      assert.strictEqual(state, chainCommon.thresholdStates.DEFINED);
      checkBIP9Info(bip9info, { status: 'defined' });
    });

    it('should start the soft-fork', async () => {
      await mineNBlocks(network.minerWindow - 2, node);

      // We are now at the threshold of the window.
      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);
        assert.strictEqual(state, thresholdStates.DEFINED);

        checkBIP9Info(bip9info, { status: 'defined' });
      }

      // go into new window and change the state to started.
      await mineBlock(node);

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(node, [airdropProof, faucetproof]);
    });

    it('should lock in the soft-fork', async () => {
      // Reach the height just before the start of the next window
      await mineNBlocks(network.minerWindow - 1, node, { signalFork: true });

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: network.minerWindow - 1,
          count: network.minerWindow - 1,
          possible: true
        });
      }

      // After this the deployment goes to LOCKED_IN state.
      await mineBlock(node, { signalFork: true });

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);

        assert.strictEqual(state, thresholdStates.LOCKED_IN);
        checkBIP9Info(bip9info, { status: 'locked_in' });

        assert(!bip9info.statistics);
      }
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(node, [airdropProof, faucetproof]);
    });

    it('should activate the soft-fork', async () => {
      // Advance to ACTIVE state.
      await mineNBlocks(network.minerWindow, node);

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);

        assert.strictEqual(state, thresholdStates.ACTIVE);
        checkBIP9Info(bip9info, { status: 'active' });

        assert(!bip9info.statistics);
      }
    });

    it('should not be able to mine airdrop proof anymore', async () => {
      await assert.rejects(
        tryClaimingAirdropProofs(node, [airdropProof]),
        {
          code: 'invalid',
          reason: 'bad-airdrop-disabled'
        }
      );
    });

    it('should still be able to mine faucet proof', async () => {
      await tryClaimingAirdropProofs(node, [faucetproof]);
    });
  });

  describe('Failure (integration)', function () {
    const node = createNode();

    before(async () => {
      await node.blocks.open();
      await node.chain.open();
      await node.miner.open();
    });

    after(async () => {
      await node.miner.close();
      await node.chain.close();
      await node.blocks.close();
    });

    it('should be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(node, [airdropProof, faucetproof]);
    });

    it('should be in DEFINED state', async () => {
      const state = await getForkDeploymentState(node.chain);
      const bip9info = await getBIP9Info(network, node.chain);

      assert.strictEqual(state, chainCommon.thresholdStates.DEFINED);
      checkBIP9Info(bip9info, { status: 'defined' });
    });

    it('should start the soft-fork', async () => {
      await mineNBlocks(network.minerWindow - 2, node);

      // We are now at the threshold of the window.
      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);
        assert.strictEqual(state, thresholdStates.DEFINED);

        checkBIP9Info(bip9info, { status: 'defined' });
      }

      // go into new window and change the state to started.
      await mineBlock(node);

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(node, [airdropProof, faucetproof]);
    });

    it('should fail to lock in the soft-fork', async () => {
      // Reach the height just before the start of the next window
      await mineNBlocks(network.minerWindow - 1, node, { signalFork: false });

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: network.minerWindow - 1,
          count: 0,
          possible: false
        });
      }

      // After this the deployment stays in STARTED state.
      await mineBlock(node, { signalFork: false });

      {
        const state = await getForkDeploymentState(node.chain);
        const bip9info = await getBIP9Info(network, node.chain);

        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(node, [airdropProof, faucetproof]);
    });
  });
});

/**
 * Attempts to mine and add a block with all provided proofs
 * and then revert the chain to the previous state.
 *
 * Throws errors if chain fails to add the block.
 *
 * @param {object} node
 * @param {Chain} node.chain
 * @param {Miner} node.miner
 * @param {AirdropProof[]} proofs
 * @returns {Promise<boolean>}
 */
async function tryClaimingAirdropProofs(node, proofs) {
  assert.ok(Array.isArray(proofs) && proofs.length > 0);

  const job = await node.miner.createJob();
  for (const proof of proofs) {
    job.addAirdrop(proof);
  }
  job.refresh();

  const block = await job.mineAsync();

  assert(block.txs.length === 1);

  const [cb] = block.txs;

  assert(cb.inputs.length === proofs.length + 1);
  assert(cb.outputs.length === proofs.length + 1);

  const [, input] = cb.inputs;
  assert(input);
  assert(input.prevout.isNull());
  assert(input.witness.length === 1);

  assert(await node.chain.add(block));

  // Block with proof accepted, so
  // Revert chain to remove the block.
  await node.chain.reset(node.chain.height - 1);

  return true;
}

/**
 * Mine N new blocks
 * @param {number} n number of blocks to mine
 * @param {object} node
 * @param {Chain} node.chain
 * @param {Miner} node.miner
 * @param {object} opts
 * @param {boolean} opts.signalFork whether to signal the fork
 */
async function mineNBlocks(n, node, opts = {}) {
  for (let i = 0; i < n; i++)
    await mineBlock(node, opts);
}

/**
 * Mine a new block
 * @param {object} node
 * @param {Chain} node.chain
 * @param {Miner} node.miner
 * @param {object} opts
 * @param {boolean} opts.signalFork whether to signal the fork
 */
async function mineBlock(node, opts = {}) {
  assert(node);
  const chain = node.chain;
  const miner = node.miner;

  const signalFork = opts.signalFork || false;

  const job = await miner.cpu.createJob(chain.tip);

  // opt out of all
  job.attempt.version = 0;

  if (signalFork)
    job.attempt.version |= (1 << network.deployments[SOFT_FORK_NAME].bit);

  job.refresh();

  const block = await job.mineAsync();
  await chain.add(block);

  return block;
}

/**
 * Get deployment state (number)
 * @param {Chain} chain
 * @returns {Promise<number>}
 */
async function getForkDeploymentState(chain) {
  const prev = chain.tip;
  const state = await chain.getState(prev, network.deployments[SOFT_FORK_NAME]);
  return state;
}

/**
 * Get BIP9 info for the fork
 *
 * adapted from lib/node/rpc.js#getSoftforks()
 *
 * @param {Network} network
 * @param {Chain} chain
 */
async function getBIP9Info(network, chain) {
  const tip = chain.tip;
  const deployment = network.deploys.find(d => d.name === SOFT_FORK_NAME);

  const state = await chain.getState(tip, deployment);
  let status;

  switch (state) {
    case chainCommon.thresholdStates.DEFINED:
      status = 'defined';
      break;
    case chainCommon.thresholdStates.STARTED:
      status = 'started';
      break;
    case chainCommon.thresholdStates.LOCKED_IN:
      status = 'locked_in';
      break;
    case chainCommon.thresholdStates.ACTIVE:
      status = 'active';
      break;
    case chainCommon.thresholdStates.FAILED:
      status = 'failed';
      break;
    default:
      assert(false, 'Bad state.');
      break;
  }

  let statistics = undefined;
  if (status === 'started')
    statistics = await chain.getBIP9Stats(tip, deployment);

  return {
    status: status,
    bit: deployment.bit,
    startTime: deployment.startTime,
    timeout: deployment.timeout,
    statistics
  };
}
