/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Address = require('../lib/primitives/address');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MTX = require('../lib/primitives/mtx');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const Output = require('../lib/primitives/output');
const MerkleBlock = require('../lib/primitives/merkleblock');
const common = require('../lib/blockchain/common');
const Opcode = require('../lib/script/opcode');
const opcodes = Script.opcodes;

const ZERO_KEY = Buffer.alloc(33, 0x00);

const csvScript = new Script([
  Opcode.fromInt(1),
  Opcode.fromSymbol('checksequenceverify')
]);

const csvScript2 = new Script([
  Opcode.fromInt(2),
  Opcode.fromSymbol('checksequenceverify')
]);

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true
});

const chain = new Chain({
  memory: true,
  network,
  workers
});

const miner = new Miner({
  chain,
  workers
});

const cpu = miner.cpu;

const wallet = new MemWallet({
  network
});

let tip1 = null;
let tip2 = null;

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

async function mineCSV(fund) {
  const job = await cpu.createJob();
  const spend = new MTX();

  spend.addOutput({
    address: Address.fromHash(csvScript.sha3()),
    value: 10000
  });

  spend.addTX(fund, 0);
  spend.setLocktime(chain.height);

  wallet.sign(spend);

  const [tx, view] = spend.commit();

  job.addTX(tx, view);
  job.refresh();

  return job.mineAsync();
}

chain.on('connect', (entry, block) => {
  wallet.addBlock(entry, block.txs);
});

chain.on('disconnect', (entry, block) => {
  wallet.removeBlock(entry, block.txs);
});

describe('Chain', function() {
  this.timeout(45000);

  before(async () => {
    await chain.open();
    await miner.open();
  });

  after(async () => {
    await miner.close();
    await chain.close();
  });

  it('should add addrs to miner', async () => {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
  });

  it('should mine 200 blocks', async () => {
    for (let i = 0; i < 200; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 200);
  });

  it('should mine competing chains', async () => {
    for (let i = 0; i < 10; i++) {
      const job1 = await cpu.createJob(tip1);
      const job2 = await cpu.createJob(tip2);

      const mtx = await wallet.create({
        outputs: [{
          address: wallet.getAddress(),
          value: 10 * 1e8
        }]
      });

      assert(job1.addTX(mtx.toTX(), mtx.view));
      assert(job2.addTX(mtx.toTX(), mtx.view));

      job1.refresh();
      job2.refresh();

      const blk1 = await job1.mineAsync();
      const blk2 = await job2.mineAsync();

      const hash1 = blk1.hash();
      const hash2 = blk2.hash();

      assert(await chain.add(blk1));
      assert(await chain.add(blk2));

      assert.bufferEqual(chain.tip.hash, hash1);

      tip1 = await chain.getEntry(hash1);
      tip2 = await chain.getEntry(hash2);

      assert(tip1);
      assert(tip2);

      assert(!await chain.isMainChain(tip2));
    }
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 422002210000);
    assert.strictEqual(chain.db.state.coin, 221);
    assert.strictEqual(chain.db.state.tx, 221);
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 420000000000);
  });

  it('should handle a reorg', async () => {
    assert.strictEqual(chain.height, 210);

    const entry = await chain.getEntry(tip2.hash);
    assert(entry);
    assert.strictEqual(chain.height, entry.height);

    const block = await cpu.mineBlock(entry);
    assert(block);

    let forked = false;
    chain.once('reorganize', () => {
      forked = true;
    });

    assert(await chain.add(block));

    assert(forked);
    assert.bufferEqual(chain.tip.hash, block.hash());
    assert(chain.tip.chainwork.gt(tip1.chainwork));
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 424002210000);
    assert.strictEqual(chain.db.state.coin, 222);
    assert.strictEqual(chain.db.state.tx, 222);
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 422000000000);
  });

  it('should check main chain', async () => {
    const result = await chain.isMainChain(tip1);
    assert(!result);
  });

  it('should mine a block after a reorg', async () => {
    const block = await cpu.mineBlock();

    assert(await chain.add(block));

    const hash = block.hash();
    const entry = await chain.getEntry(hash);

    assert(entry);
    assert.bufferEqual(chain.tip.hash, entry.hash);

    const result = await chain.isMainChain(entry);
    assert(result);
  });

  it('should prevent double spend on new chain', async () => {
    const mtx = await wallet.create({
      outputs: [{
        address: wallet.getAddress(),
        value: 10 * consensus.COIN
      }]
    });

    {
      const job = await cpu.createJob();

      assert(job.addTX(mtx.toTX(), mtx.view));
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    }

    {
      const job = await cpu.createJob();

      assert(mtx.outputs.length > 1);
      mtx.outputs.pop();

      assert(job.addTX(mtx.toTX(), mtx.view));
      job.refresh();

      assert.strictEqual(await mineBlock(job),
        'bad-txns-inputs-missingorspent');
    }
  });

  it('should fail to connect coins on an alternate chain', async () => {
    const block = await chain.getBlock(tip1.hash);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 10 * consensus.COIN);

    wallet.sign(mtx);

    const job = await cpu.createJob();
    assert(job.addTX(mtx.toTX(), mtx.view));
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-txns-inputs-missingorspent');
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 428002210000);
    assert.strictEqual(chain.db.state.coin, 225);
    assert.strictEqual(chain.db.state.tx, 225);
  });

  it('should get coin', async () => {
    const mtx = await wallet.send({
      outputs: [
        {
          address: wallet.getAddress(),
          value: 1e8
        },
        {
          address: wallet.getAddress(),
          value: 1e8
        },
        {
          address: wallet.getAddress(),
          value: 1e8
        }
      ]
    });

    const job = await cpu.createJob();
    assert(job.addTX(mtx.toTX(), mtx.view));
    job.refresh();

    const block = await job.mineAsync();
    assert(await chain.add(block));

    const tx = block.txs[1];
    const output = Coin.fromTX(tx, 2, chain.height);

    const coin = await chain.getCoin(tx.hash(), 2);

    assert.bufferEqual(coin.encode(), output.encode());
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 428000000000);
    assert.strictEqual(wallet.receiveDepth, 15);
    assert.strictEqual(wallet.changeDepth, 14);
    assert.strictEqual(wallet.txs, 226);
  });

  it('should get tips and remove chains', async () => {
    {
      const tips = await chain.db.getTips();

      // XXX
      // assert.notStrictEqual(tips.indexOf(chain.tip.hash), -1);
      assert.strictEqual(tips.length, 2);
    }

    await chain.db.removeChains();

    {
      const tips = await chain.db.getTips();

      // XXX
      // assert.notStrictEqual(tips.indexOf(chain.tip.hash), -1);
      assert.strictEqual(tips.length, 1);
    }
  });

  it('should rescan for transactions', async () => {
    let total = 0;

    await chain.scan(0, wallet.filter, async (block, txs) => {
      total += txs.length;
    });

    assert.strictEqual(total, 226);
  });

  it('should test csv', async () => {
    const tx = (await chain.getBlock(chain.height - 100)).txs[0];
    const csvBlock = await mineCSV(tx);

    assert(await chain.add(csvBlock));

    const csv = csvBlock.txs[1];

    const spend = new MTX();

    spend.addOutput({
      address: Address.fromHash(csvScript2.sha3()),
      value: 10000
    });

    spend.addTX(csv, 0);
    spend.inputs[0].witness.set(0, csvScript.encode());
    spend.setSequence(0, 1, false);

    const job = await cpu.createJob();

    assert(job.addTX(spend.toTX(), spend.view));
    job.refresh();

    const block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should fail csv with bad sequence', async () => {
    const csv = (await chain.getBlock(chain.height - 100)).txs[0];
    const spend = new MTX();

    spend.addOutput({
      address: Address.fromHash(csvScript.sha3()),
      value: 1 * 1e8
    });

    spend.addTX(csv, 0);
    spend.setSequence(0, 1, false);

    const job = await cpu.createJob();
    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'mandatory-script-verify-flag-failed');
  });

  it('should mine a block', async () => {
    const block = await cpu.mineBlock();
    assert(block);
    assert(await chain.add(block));
  });

  it('should fail csv lock checks', async () => {
    const tx = (await chain.getBlock(chain.height - 100)).txs[0];
    const csvBlock = await mineCSV(tx);

    assert(await chain.add(csvBlock));

    const csv = csvBlock.txs[1];

    const spend = new MTX();

    spend.addOutput({
      address: Address.fromHash(csvScript2.sha3()),
      value: 1 * 1e8
    });

    spend.addTX(csv, 0);
    spend.inputs[0].witness.set(0, csvScript.encode());
    spend.setSequence(0, 2, false);

    const job = await cpu.createJob();
    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-txns-nonfinal');
  });

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 435999980000);
  });

  it('should fail to connect bad bits', async () => {
    const job = await cpu.createJob();
    job.attempt.bits = 553713663;
    assert.strictEqual(await mineBlock(job), 'bad-diffbits');
  });

  it('should fail to connect bad MTP', async () => {
    const mtp = await chain.getMedianTime(chain.tip);
    const job = await cpu.createJob();
    job.attempt.time = mtp - 1;
    assert.strictEqual(await mineBlock(job), 'time-too-old');
  });

  it('should fail to connect bad time', async () => {
    const job = await cpu.createJob();
    const now = network.now() + 3 * 60 * 60;
    job.attempt.time = now;
    assert.strictEqual(await mineBlock(job), 'time-too-new');
  });

  it('should fail to connect bad locktime', async () => {
    const job = await cpu.createJob();
    const tx = await wallet.send({ locktime: 100000 });
    job.pushTX(tx.toTX());
    job.refresh();
    assert.strictEqual(await mineBlock(job), 'bad-txns-nonfinal');
  });

  it('should fail to connect bad cb height', async () => {
    const job = await cpu.createJob();

    job.attempt.height = 10;
    job.attempt.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-cb-height');
  });

  it('should fail to connect bad witness size', async () => {
    const block = await cpu.mineBlock();
    const tx = block.txs[0];
    const input = tx.inputs[0];
    input.witness.set(0, Buffer.alloc(1001));
    block.refresh(true);
    assert.strictEqual(await addBlock(block), 'bad-txnmrklroot');
  });

  it('should fail to connect bad witness commitment', async () => {
    const flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;
    const block = await cpu.mineBlock();

    block.merkleRoot = Buffer.from(block.merkleRoot);
    block.merkleRoot[0] ^= 1;

    assert.strictEqual(await addBlock(block, flags), 'bad-txnmrklroot');
  });

  it('should mine 2000 blocks', async () => {
    for (let i = 0; i < 2001; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 2219);
  });

  it('should mine a witness tx', async () => {
    const prev = await chain.getBlock(chain.height - 2000);
    const cb = prev.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 1000);

    wallet.sign(mtx);

    const job = await cpu.createJob();
    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    const block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should mine fail to connect too much weight', async () => {
    const start = chain.height - 2000;
    const end = chain.height - 200;
    const job = await cpu.createJob();

    for (let i = start; i <= end; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0];

      const mtx = new MTX();
      mtx.addTX(cb, 0);

      for (let j = 0; j < 15; j++)
        mtx.addOutput(wallet.getAddress(), 1);

      wallet.sign(mtx);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-blk-weight');
  });

  it('should mine fail to connect too much size', async () => {
    const start = chain.height - 2000;
    const end = chain.height - 200;
    const job = await cpu.createJob();

    for (let i = start; i <= end; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0];

      const mtx = new MTX();
      mtx.addTX(cb, 0);

      for (let j = 0; j < 20; j++)
        mtx.addOutput(wallet.getAddress(), 1);

      wallet.sign(mtx);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.strictEqual(await mineBlock(job), 'bad-blk-length');
  });

  it('should mine a big block', async () => {
    const start = chain.height - 2000;
    const end = chain.height - 200;
    const job = await cpu.createJob();
    const prove = [];

    for (let i = start; i <= end - 1; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0];

      const mtx = new MTX();
      mtx.addTX(cb, 0);

      for (let j = 0; j < 14; j++)
        mtx.addOutput(wallet.getAddress(), 1);

      wallet.sign(mtx);

      if (i & 1)
        prove.push(mtx.hash());

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    const block = await job.mineAsync();
    const entry = await chain.add(block);
    assert(entry);

    assert(block.txs.length & 1);

    const merkle = MerkleBlock.fromHashes(block, prove);
    assert(merkle.verify());

    const tree = merkle.getTree();
    assert.strictEqual(tree.matches.length, prove.length);
    assert.strictEqual(tree.map.size, prove.length);

    for (const hash of prove)
      assert(tree.map.has(hash));
  });

  it('should fail to connect bad amount', async () => {
    const job = await cpu.createJob();

    job.attempt.fees += 1;
    job.refresh();
    assert.strictEqual(await mineBlock(job), 'bad-cb-amount');
  });

  it('should fail to connect premature cb spend', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 1);

    wallet.sign(mtx);

    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'bad-txns-premature-spend-of-coinbase');
  });

  it('should fail to connect vout belowout', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 99);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), cb.outputs[0].value + 1);

    wallet.sign(mtx);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'bad-txns-in-belowout');
  });

  it('should fail to connect outtotal toolarge', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 99);
    const cb = block.txs[0];
    const mtx = new MTX();

    mtx.addTX(cb, 0);

    const value = Math.floor(consensus.MAX_MONEY / 2);

    mtx.addOutput(wallet.getAddress(), value);
    mtx.addOutput(wallet.getAddress(), value);
    mtx.addOutput(wallet.getAddress(), value);

    wallet.sign(mtx);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.strictEqual(await mineBlock(job),
      'bad-txns-txouttotal-toolarge');
  });

  it('should mine 111 multisig blocks', async () => {
    const flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;

    const redeem = new Script();
    redeem.pushInt(20);

    for (let i = 0; i < 20; i++)
      redeem.pushData(ZERO_KEY);

    redeem.pushInt(20);
    redeem.pushOp(opcodes.OP_CHECKMULTISIG);

    redeem.compile();

    const addr = Address.fromScripthash(redeem.sha3());

    for (let i = 0; i < 111; i++) {
      const block = await cpu.mineBlock();
      const cb = block.txs[0];
      const val = cb.outputs[0].value;

      cb.outputs[0].value = 0;

      for (let j = 0; j < Math.min(100, val); j++) {
        const output = new Output();
        output.address = addr;
        output.value = 1;

        cb.outputs.push(output);
      }

      block.refresh(true);
      block.merkleRoot = block.createMerkleRoot();
      block.witnessRoot = block.createWitnessRoot();

      assert(await chain.add(block, flags));
    }

    assert.strictEqual(chain.height, 2332);
  });

  it('should fail to connect too many sigops', async () => {
    const start = chain.height - 110;
    const end = chain.height - 100;
    const job = await cpu.createJob();

    for (let i = start; i <= end; i++) {
      const block = await chain.getBlock(i);
      const cb = block.txs[0];

      if (cb.outputs.length === 2)
        continue;

      const mtx = new MTX();

      for (let j = 2; j < cb.outputs.length; j++)
        mtx.addTX(cb, j);

      mtx.addOutput(wallet.getAddress(), 1);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    // TODO:
    // assert.strictEqual(await mineBlock(job), 'bad-blk-sigops');

    assert.strictEqual(await mineBlock(job),
      'mandatory-script-verify-flag-failed');
  });

  describe('Checkpoints', function() {
    before(async () => {
      const CHECKPOINT = chain.tip.height - 5;
      const entry = await chain.getEntry(CHECKPOINT);
      assert(Buffer.isBuffer(entry.hash));
      assert(Number.isInteger(entry.height));

      network.checkpointMap[entry.height] = entry.hash;
      network.lastCheckpoint = entry.height;
    });

    after(async () => {
      network.checkpointMap = {};
      network.lastCheckpoint = 0;
    });

    it('will reject blocks before last checkpoint', async () => {
      const BEFORE_CHECKPOINT = chain.tip.height - 10;
      const entry = await chain.getEntry(BEFORE_CHECKPOINT);
      const block = await cpu.mineBlock(entry);

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.equal(err.type, 'VerifyError');
      assert.equal(err.reason, 'bad-fork-prior-to-checkpoint');
      assert.equal(err.score, 100);
    });

    it('will accept blocks after last checkpoint', async () => {
      const AFTER_CHECKPOINT = chain.tip.height - 4;
      const entry = await chain.getEntry(AFTER_CHECKPOINT);
      const block = await cpu.mineBlock(entry);
      assert(await chain.add(block));
    });
  });
});
