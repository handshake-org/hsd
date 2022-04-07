'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const Address = require('../lib/primitives/address');
const Network = require('../lib/protocol/network');
const Opcode = require('../lib/script/opcode');

const network = Network.get('regtest');

const blocks = new BlockStore({
  memory: true,
  network
});

const chain = new Chain({
  blocks,
  memory: true,
  network
});

const miner = new Miner({
  chain
});
const cpu = miner.cpu;

const wallet = new MemWallet({
  network
});

async function addBlock(block, flags) {
  let entry;

  try {
    entry = await chain.add(block, flags);
  } catch (e) {
    assert.strictEqual(e.type, 'VerifyError');
    return e.reason;
  }

  if (!entry)
    return 'bad-prevblk';

  return 'OK';
}

async function mineBlock(job, flags) {
  const block = await job.mineAsync();
  return addBlock(block, flags);
}

describe('Chain Timelocks', function() {
  before(async () => {
    await blocks.open();
    await chain.open();
    await miner.open();
  });

  after(async () => {
    await miner.close();
    await chain.close();
    await blocks.close();
  });

  describe('Relative (CSV)', function() {
    let timeOffset;

    // make sure we recover proper regtest Network.
    before(() => {
      timeOffset = network.time.offset;
    });

    after(() => {
      network.time.offset = timeOffset;
    });

    // Relative timelock by height
    const csvHeightScript = new Script([
      Opcode.fromInt(2),
      Opcode.fromSymbol('checksequenceverify')
    ]);
    const csvHeightAddr = Address.fromScripthash(csvHeightScript.sha3());

    // Relative timelock by time
    const seconds = 60 * 60; // 1 hour
    let locktime = seconds;
    locktime >>>= consensus.SEQUENCE_GRANULARITY;  // 512-second units
    locktime &= consensus.SEQUENCE_MASK;           // 0x0000ffff
    locktime |= consensus.SEQUENCE_TYPE_FLAG;      // time, not height
    const csvTimeScript = new Script([
      Opcode.fromInt(locktime),
      Opcode.fromSymbol('checksequenceverify')
    ]);
    const csvTimeAddr = Address.fromScripthash(csvTimeScript.sha3());

    it('should fund MemWallet', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());

      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        const entry = await chain.add(block);
        wallet.addBlock(entry, block.txs);
      }
    });

    it('should test csv by height', async () => {
      // Fund an output locked by CSV-by-height script
      const fund = await wallet.send({
        outputs: [
          {address: csvHeightAddr, value: 10000}
        ]
      });
      const job = await cpu.createJob();
      assert(job.addTX(fund.toTX(), fund.view));
      job.refresh();
      const block1 = await job.mineAsync();
      assert(await chain.add(block1));

      // Create a TX that spends the relative-timelocked output.
      const spend = new MTX();
      spend.addTX(fund, 0);
      spend.addOutput(wallet.getReceive(), 9000);
      spend.inputs[0].witness.push(csvHeightScript.encode());

      // Sequence has not been set (default is 0xffffffff)
      // Result: TX is "final" and allowed in block but script evaluates to false.
      const noSeqJob = await cpu.createJob();
      noSeqJob.pushTX(spend.toTX(), spend.view);
      noSeqJob.refresh();
      assert.strictEqual(
        await mineBlock(noSeqJob),
        'mandatory-script-verify-flag-failed'
      );

      // Sequence is too early
      // Result: TX is invalid in block even before script is evaluated.
      spend.setSequence(0, 2, false);
      const badSeqJob = await cpu.createJob();
      badSeqJob.pushTX(spend.toTX(), spend.view);
      badSeqJob.refresh();
      assert.strictEqual(
        await mineBlock(badSeqJob),
        'bad-txns-nonfinal'
      );

      // Add one more block to chain
      const block2 = await cpu.mineBlock();
      assert(block2);
      assert(await chain.add(block2));

      // Now sequence is valid and script evaluates to true.
      const goodJob = await cpu.createJob();
      goodJob.pushTX(spend.toTX(), spend.view);
      goodJob.refresh();
      assert.strictEqual(
        await mineBlock(goodJob),
        'OK'
      );
    });

    it('should test csv by time', async () => {
      // Fund an output locked by CSV-by-time script
      const fund = await wallet.send({
        outputs: [
          {address: csvTimeAddr, value: 10000}
        ]
      });
      const job = await cpu.createJob();
      assert(job.addTX(fund.toTX(), fund.view));
      job.refresh();
      const block1 = await job.mineAsync();
      assert(await chain.add(block1));

      // Create a TX that spends the relative-timelocked output.
      const spend = new MTX();
      spend.addTX(fund, 0);
      spend.addOutput(await wallet.getReceive(), 9000);
      spend.inputs[0].witness.push(csvTimeScript.encode());

      // Sequence has not been set (default is 0xffffffff)
      // Result: TX is "final" and allowed in block but script evaluates to false.
      const noSeqJob = await cpu.createJob();
      noSeqJob.pushTX(spend.toTX(), spend.view);
      noSeqJob.refresh();
      assert.strictEqual(
        await mineBlock(noSeqJob),
        'mandatory-script-verify-flag-failed'
      );

      // Sequence is too early
      // Result: TX is invalid in block even before script is evaluated.
      spend.setSequence(0, seconds, true);
      const badSeqJob = await cpu.createJob();
      badSeqJob.pushTX(spend.toTX(), spend.view);
      badSeqJob.refresh();
      assert.strictEqual(
        await mineBlock(badSeqJob),
        'bad-txns-nonfinal'
      );

      // Advance the clock and add 11 blocks to chain so MTP catches up.
      network.time.offset = 2 * 60 * 60; // 2 hours
      for (let i = 0; i < consensus.MEDIAN_TIMESPAN; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      // Now sequence is valid and script evaluates to true.
      const goodJob = await cpu.createJob();
      goodJob.pushTX(spend.toTX(), spend.view);
      goodJob.refresh();
      assert.strictEqual(
        await mineBlock(goodJob),
        'OK'
      );
    });
  });
});
