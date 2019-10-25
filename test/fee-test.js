/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const ComposedFees = require('../lib/mempool/composedFees');
const Fees = require('../lib/mempool/fees');
const MempoolEntry = require('../lib/mempool/mempoolentry');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const MemWallet = require('./util/memwallet');
const Output = require('../lib/primitives/output');
const rules = require('../lib/covenants/rules');
const random = require('bcrypto/lib/random');
const {types} = rules;

const domain = 'testdomain';

const lowFee = 10;
const medFee = 1000;
const highFee = 10000;

const feeEstimator = new Fees()

const composedFeeEstimator = new ComposedFees()

const wallet = new MemWallet();

const GENERATE_HASH = 'generate';

function covenantEntry(type, name, hash, addr, fee, height) {
  if (hash === GENERATE_HASH)
    hash = random.randomBytes(32);

  const fund = new MTX();
  fund.addCoin(dummyInput(addr, hash, fee));
  fund.addOutput(covenantOutput(type, name, addr));

  const [tx, view] = fund.commit();

  const entry = MempoolEntry.fromTX(tx, view, 0);

  return entry
}

function dummyInput(addr, hash, fee) {
  const coin = new Coin();
  coin.height = 0;
  coin.value = fee;
  coin.address = addr;
  coin.hash = hash;
  coin.index = 0;

  return coin;
}

function covenantOutput(type, name, address) {
  const nameHash = rules.hashName(name);
  const rawName = Buffer.from(name, 'ascii');

  const output = new Output();
  output.address = address;
  output.value = 0;
  output.covenant.type = type;
  output.covenant.pushHash(nameHash);
  output.covenant.pushU32(0);
  output.covenant.push(rawName);

  return output;
}

describe('Fees', function () {
  this.timeout(5000);

  before('should init fees', async () => {
    feeEstimator.init();
    composedFeeEstimator.init();
  });

  it('simple estimator should estimate a fee', async () => {
    const address  = wallet.getAddress();

    const numBlocks = 5;
    const numOpens = 100;
    const blocks = []
    for (let i = 0; i < numBlocks + 2; i++) {
      const entries = []
      blocks[i] = entries
    }

    // set up estimator's mempool with
    // different prices and blocks to process
    for (let i = 0; i < numBlocks; i++) {
      for (let j = 0; j <= numOpens; j++){
        // add low-fee tx to estimator's mempool, but it never gets confirmed.
        const lowTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, lowFee, i);
        feeEstimator.processTX(lowTX, true)

        // add medium-fee tx to estimator's mempool and confirm it in two blocks
        const medTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, medFee, i);
        feeEstimator.processTX(medTX, true)
        medTX.height = medTX.height + 2
        blocks[i + 2].push(medTX)

        // add high-fee tx to estimator's mempool and confirm it in the next block
        const highTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, highFee, i);
        feeEstimator.processTX(highTX, true)
        highTX.height = highTX.height + 1
        blocks[i + 1].push(highTX)
      }
    } 

    // process all the blocks
    for (let i = 0; i < numBlocks; i++) {
      const block = blocks[i];
      feeEstimator.processBlock(i, block, true);
    }

   
    const estimate = feeEstimator.estimateFee();

    assert(estimate > 0);
  });

  it('composed wallet should estimate a fee', async () => {
    const address = wallet.getAddress();

    const numBlocks = 5;
    const numOpens = 100;
    const numUpdates = 100;
    const blocks = []
    for (let i = 0; i < numBlocks + 2; i++) {
      const entries = []
      blocks[i] = entries
    }

    // set up estimator's mempool with
    // different prices and blocks to process
    for (let i = 0; i < numBlocks; i++) {
      for (let j = 0; j <= numOpens; j++) {
        // add low-fee tx to estimator's mempool, but it never gets confirmed.
        const lowOpenTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, 2*lowFee, i);
        composedFeeEstimator.processTX(lowOpenTX, true)
        const lowRegisterTX = covenantEntry(types.REGISTER, domain, GENERATE_HASH, address, lowFee, i);
        composedFeeEstimator.processTX(lowRegisterTX, true)

        // add medium-fee tx to estimator's mempool and confirm it in two blocks
        const medOpenTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, 2*medFee, i);
        composedFeeEstimator.processTX(medOpenTX, true)
        medOpenTX.height = medOpenTX.height + 2
        blocks[i + 2].push(medOpenTX)
        const medRegisterTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, medFee, i);
        composedFeeEstimator.processTX(medRegisterTX, true)
        medRegisterTX.height = medRegisterTX.height + 2
        blocks[i + 2].push(medRegisterTX)


        // add high-fee tx to estimator's mempool and confirm it in the next block
        const highOpenTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, 2*highFee, i);
        composedFeeEstimator.processTX(highOpenTX, true)
        highOpenTX.height = highOpenTX.height + 1
        blocks[i + 1].push(highOpenTX)
        const highRegisterTX = covenantEntry(types.OPEN, domain, GENERATE_HASH, address, highFee, i);
        composedFeeEstimator.processTX(highRegisterTX, true)
        highRegisterTX.height = highRegisterTX.height + 2
        blocks[i + 2].push(highRegisterTX)
      }
    }

    // process all the blocks
    for (let i = 0; i < numBlocks; i++) {
      const block = blocks[i];
      composedFeeEstimator.processBlock(i, block, true);
    }

    const openEstimate = composedFeeEstimator.estimateFee(1, true, types.OPEN);
    const registerEstimate = composedFeeEstimator.estimateFee(1, true, types.REGISTER);

    assert(openEstimate > registerEstimate);
  });



});



