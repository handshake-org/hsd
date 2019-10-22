/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const ComposedFees = require('../lib/mempool/composedFees');
const Fees = require('../lib/mempool/fees');
const MempoolEntry = require('../lib/mempool/mempoolentry');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Address = require('../lib/primitives/address');
const MemWallet = require('./util/memwallet');
const Output = require('../lib/primitives/output');
const rules = require('../lib/covenants/rules');
const {types} = rules;

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;
const TWO_HASH = Buffer.alloc(32, 0x00);
TWO_HASH[0] = 0x02;

const domain = 'testdomain';

const lowFee = 0;
const medFee = 100;
const highFee = 1000;

const feeEstimator = new Fees()

const composedFeeEstimator = new ComposedFees()

const wallet = new MemWallet();

function covenantEntry(type, name, hash, addr, fee) {
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

describe.only('Fees', function () {
  this.timeout(5000);

  it('should init fees', async () => {
    feeEstimator.init();
    composedFeeEstimator.init();
  });

  it('should add blocks', async () => {
    const address  = wallet.getAddress();

    const entries = [];
    entries[0] = covenantEntry(types.OPEN, domain, ONE_HASH, address, medFee);
    entries[1] = covenantEntry(types.OPEN, domain, TWO_HASH, address, medFee);

    feeEstimator.processBlock(1, entries, true);

    const estimate = feeEstimator.estimateFee();

    assert(estimate === medFee);
  });

});



