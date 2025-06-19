'use strict';

const fs = require('fs');
const { resolve } = require('path');
const assert = require('bsert');
const chainCommon = require('../lib/blockchain/common');
const Network = require('../lib/protocol/network');
const AirdropProof = require('../lib/primitives/airdropproof');
const NodeContext = require('./util/node-context');
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
const faucetProof = AirdropProof.decode(rawFaucetProof);

const SOFT_FORK_NAME = 'airstop';

const networkDeployments = network.deployments;
const ACTUAL_START = networkDeployments[SOFT_FORK_NAME].startTime;
const ACTUAL_TIMEOUT = networkDeployments[SOFT_FORK_NAME].timeout;

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
    const nodeCtx = new NodeContext();

    before(async () => {
      network.deployments[SOFT_FORK_NAME].startTime = 0;
      network.deployments[SOFT_FORK_NAME].timeout = 0xffffffff;

      await nodeCtx.open();
    });

    after(async () => {
      network.deployments[SOFT_FORK_NAME].startTime = ACTUAL_START;
      network.deployments[SOFT_FORK_NAME].timeout = ACTUAL_TIMEOUT;

      await nodeCtx.close();
    });

    it('should be able to add airdrop & faucet proofs to the mempool', async () => {
      await nodeCtx.mempool.addAirdrop(airdropProof);
      await nodeCtx.mempool.addAirdrop(faucetProof);
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 2);
      nodeCtx.mempool.dropAirdrops();
    });

    it('should be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
    });

    it('should be in DEFINED state', async () => {
      const state = await getForkDeploymentState(nodeCtx.chain);
      const bip9info = await getBIP9Info(nodeCtx);

      assert.strictEqual(state, chainCommon.thresholdStates.DEFINED);
      checkBIP9Info(bip9info, { status: 'defined' });
    });

    it('should start the soft-fork', async () => {
      await mineNBlocks(network.minerWindow - 2, nodeCtx);

      // We are now at the threshold of the window.
      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);
        assert.strictEqual(state, thresholdStates.DEFINED);

        checkBIP9Info(bip9info, { status: 'defined' });
      }

      // go into new window and change the state to started.
      await mineBlock(nodeCtx);

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should still be able to add airdrop & faucet proofs to the mempool', async () => {
      await nodeCtx.mempool.addAirdrop(airdropProof);
      await nodeCtx.mempool.addAirdrop(faucetProof);
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 2);
      nodeCtx.mempool.dropAirdrops();
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
    });

    it('should lock in the soft-fork', async () => {
      // Reach the height just before the start of the next window
      await mineNBlocks(network.minerWindow - 1, nodeCtx, { signalFork: true });

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: network.minerWindow - 1,
          count: network.minerWindow - 1,
          possible: true
        });
      }

      // After this the deployment goes to LOCKED_IN state.
      await mineBlock(nodeCtx, { signalFork: true });

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);

        assert.strictEqual(state, thresholdStates.LOCKED_IN);
        checkBIP9Info(bip9info, { status: 'locked_in' });

        assert(!bip9info.statistics);
      }
    });

    it('should still be able to add airdrop & faucet proofs to the mempool', async () => {
      await nodeCtx.mempool.addAirdrop(airdropProof);
      await nodeCtx.mempool.addAirdrop(faucetProof);
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 2);
      nodeCtx.mempool.dropAirdrops();
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
    });

    it('should activate the soft-fork', async () => {
      // Advance to ACTIVE state.
      await mineNBlocks(network.minerWindow - 1, nodeCtx);

      const blockToAdd = await nodeCtx.miner.mineBlock(nodeCtx.chain.tip);

      await nodeCtx.mempool.addAirdrop(airdropProof);
      await nodeCtx.mempool.addAirdrop(faucetProof);
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 2);

      await nodeCtx.chain.add(blockToAdd);
      // mempool must drop airdrops if next block no longer
      // allows them.
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 0);

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);

        assert.strictEqual(state, thresholdStates.ACTIVE);
        checkBIP9Info(bip9info, { status: 'active' });

        assert(!bip9info.statistics);
      }
    });

    it('should not be able to add airdrops to the mempool', async () => {
      let err;

      try {
        await nodeCtx.mempool.addAirdrop(airdropProof);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.code, 'invalid');
      assert.strictEqual(err.reason, 'bad-airdrop-disabled');
      assert.strictEqual(err.score, 0);

      err = null;

      try {
        await nodeCtx.mempool.addAirdrop(faucetProof);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.code, 'invalid');
      assert.strictEqual(err.reason, 'bad-airdrop-disabled');
      assert.strictEqual(err.score, 0);
    });

    it('should not be able to mine airdrop & faucet proofs anymore', async () => {
      let err;

      try {
        await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.code, 'invalid');
      assert.strictEqual(err.reason, 'bad-airdrop-disabled');
      assert.strictEqual(err.score, 100);

      nodeCtx.mempool.dropAirdrops();

      err = null;

      try {
        await tryClaimingAirdropProofs(nodeCtx, [faucetProof]);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.code, 'invalid');
      assert.strictEqual(err.reason, 'bad-airdrop-disabled');
      assert.strictEqual(err.score, 100);
    });
  });

  describe('Failure (integration)', function () {
    const nodeCtx = new NodeContext();

    before(async () => {
      network.deployments[SOFT_FORK_NAME].startTime = 0;
      network.deployments[SOFT_FORK_NAME].timeout = 0xffffffff;

      await nodeCtx.open();
    });

    after(async () => {
      network.deployments[SOFT_FORK_NAME].startTime = ACTUAL_START;
      network.deployments[SOFT_FORK_NAME].timeout = ACTUAL_TIMEOUT;

      await nodeCtx.close();
    });

    it('should be able to add airdrop & faucet proofs to the mempool', async () => {
      await nodeCtx.mempool.addAirdrop(airdropProof);
      await nodeCtx.mempool.addAirdrop(faucetProof);
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 2);
      nodeCtx.mempool.dropAirdrops();
    });

    it('should be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
    });

    it('should be in DEFINED state', async () => {
      const state = await getForkDeploymentState(nodeCtx.chain);
      const bip9info = await getBIP9Info(nodeCtx);

      assert.strictEqual(state, chainCommon.thresholdStates.DEFINED);
      checkBIP9Info(bip9info, { status: 'defined' });
    });

    it('should start the soft-fork', async () => {
      await mineNBlocks(network.minerWindow - 2, nodeCtx);

      // We are now at the threshold of the window.
      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);
        assert.strictEqual(state, thresholdStates.DEFINED);

        checkBIP9Info(bip9info, { status: 'defined' });
      }

      // go into new window and change the state to started.
      await mineBlock(nodeCtx);

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);
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
      await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
    });

    it('should fail to lock in the soft-fork', async () => {
      // Reach the height just before the start of the next window
      await mineNBlocks(network.minerWindow - 1, nodeCtx, { signalFork: false });

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: network.minerWindow - 1,
          count: 0,
          possible: false
        });
      }

      // After this the deployment stays in STARTED state.
      await mineBlock(nodeCtx, { signalFork: false });

      {
        const state = await getForkDeploymentState(nodeCtx.chain);
        const bip9info = await getBIP9Info(nodeCtx);

        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should still be able to add airdrop & faucet proofs to the mempool', async () => {
      await nodeCtx.mempool.addAirdrop(airdropProof);
      await nodeCtx.mempool.addAirdrop(faucetProof);
      assert.strictEqual(nodeCtx.mempool.airdrops.size, 2);
      nodeCtx.mempool.dropAirdrops();
    });

    it('should still be able to mine airdrop & faucet proofs', async () => {
      await tryClaimingAirdropProofs(nodeCtx, [airdropProof, faucetProof]);
    });
  });
});

/**
 * Attempts to mine and add a block with all provided proofs
 * and then revert the chain to the previous state.
 *
 * Throws errors if chain fails to add the block.
 *
 * @param {NodeContext} nodeCtx
 * @param {AirdropProof[]} proofs
 * @returns {Promise}
 */
async function tryClaimingAirdropProofs(nodeCtx, proofs) {
  assert.ok(Array.isArray(proofs) && proofs.length > 0);

  // We don't want mempool to safeguard miner.
  const bakAirstop = nodeCtx.mempool.nextState.hasAirstop;
  nodeCtx.mempool.nextState.hasAirstop = false;

  for (const proof of proofs)
    await nodeCtx.mempool.addAirdrop(proof);

  nodeCtx.mempool.nextState.hasAirstop = bakAirstop;

  assert.strictEqual(nodeCtx.mempool.airdrops.size, proofs.length);

  const [block] = await nodeCtx.mineBlocks(1);
  assert(block.txs[0].inputs.length === 3);
  assert(block.txs[0].outputs.length === 3);
  assert.strictEqual(nodeCtx.mempool.airdrops.size, 0);

  // NOTE: reset WONT re-add proofs to the mempool.
  await nodeCtx.chain.reset(nodeCtx.height - 1);
}

/**
 * Mine N new blocks
 * @param {number} n number of blocks to mine
 * @param {NodeContext} node
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
 * @param {NodeContext} node
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
 * @param {NodeContext} nodeCtx
 */
async function getBIP9Info(nodeCtx) {
  const info = await nodeCtx.nrpc('getblockchaininfo');
  return info.softforks[SOFT_FORK_NAME];
}
