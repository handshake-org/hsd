/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Miner = require('../lib/mining/miner');
const Network = require('../lib/protocol/network');
const common = require('../lib/blockchain/common');
const thresholdStates = common.thresholdStates;

const network = Network.get('regtest');
const deployments = network.deployments;
const activationThreshold = network.activationThreshold;
const minerWindow = network.minerWindow;

const ACTUAL_START = deployments.hardening.startTime;
const ACTUAL_TIMEOUT = deployments.hardening.timeout;

const chain = new Chain({
  memory: true,
  network
});
const miner = new Miner({
  chain: chain
});

async function addBIP9Blocks(number, setHardeningBit) {
  for (let i = 0; i < number; i++) {
    const entry = await chain.getEntry(chain.tip.hash);
    const job = await miner.cpu.createJob(entry);
    if (setHardeningBit)
      job.attempt.version |= (1 << deployments.hardening.bit);
    else
      job.attempt.version = 0;
    job.refresh();
    const block = await job.mineAsync();
    await chain.add(block);
  }
};

async function getHardeningState() {
  const prev = chain.tip;
  const state = await chain.getState(prev, deployments.hardening);
  return state;
};

async function hasHardening() {
  const state = await chain.getDeployments(chain.tip.time, chain.tip);
  return state.hasHardening();
}

describe('BIP9 activation', function() {
  before(async () => {
    deployments.hardening.startTime = 0;
    deployments.hardening.timeout = 0xffffffff;

    await chain.open();
    await miner.cpu.open();
  });

  after(async () => {
    await chain.close();
    await miner.cpu.close();

    deployments.hardening.startTime = ACTUAL_START;
    deployments.hardening.timeout = ACTUAL_TIMEOUT;
  });

  it('should start as DEFINED', async () => {
    const state = await getHardeningState(chain.tip);
    assert.strictEqual(state, thresholdStates.DEFINED);
    assert(!await hasHardening());
  });

  it('should advance from DEFINED to STARTED', async () => {
    // This is minus two because block 0 counts as the "first" block.
    await addBIP9Blocks(minerWindow - 2, true);
    const state1 = await getHardeningState(chain.tip);
    assert.strictEqual(state1, thresholdStates.DEFINED);
    await addBIP9Blocks(1, true);
    const state2 = await getHardeningState(chain.tip);
    assert.strictEqual(state2, thresholdStates.STARTED);
    assert(!await hasHardening());
  });

  it('should add blocks: does not reach LOCKED_IN', async () => {
    // Not enough miner support signaled.
    await addBIP9Blocks(minerWindow - activationThreshold, true);
    await addBIP9Blocks(activationThreshold - 1, false);
    const state1 = await getHardeningState(chain.tip);
    assert.strictEqual(state1, thresholdStates.STARTED);
    await addBIP9Blocks(1, false);
    const state2 = await getHardeningState(chain.tip);
    assert.strictEqual(state2, thresholdStates.STARTED);
    assert(!await hasHardening());
  });

  it('should add blocks: reaches LOCKED_IN status', async () => {
    // Miner support threshold reached.
    await addBIP9Blocks(minerWindow - activationThreshold, false);
    await addBIP9Blocks(activationThreshold - 1, true);
    const state1 = await getHardeningState(chain.tip);
    assert.strictEqual(state1, thresholdStates.STARTED);
    await addBIP9Blocks(1, true);
    const state2 = await getHardeningState(chain.tip);
    assert.strictEqual(state2, thresholdStates.LOCKED_IN);
    assert(!await hasHardening());
  });

  it('should add blocks: reaches ACTIVE status', async () => {
    // Note that signal bits are unnecessary after lock-in.
    await addBIP9Blocks(minerWindow - 1, false);
    const state1 = await getHardeningState(chain.tip);
    assert.strictEqual(state1, thresholdStates.LOCKED_IN);
    await addBIP9Blocks(1, false);
    const state2 = await getHardeningState(chain.tip);
    assert.strictEqual(state2, thresholdStates.ACTIVE);
    assert(await hasHardening());
  });
});
