'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Address = require('../lib/primitives/address');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const BlockStore = require('../lib/blockstore/level');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const {BlockEntry} = require('../lib/mining/template');
const MTX = require('../lib/primitives/mtx');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const Output = require('../lib/primitives/output');
const MerkleBlock = require('../lib/primitives/merkleblock');
const common = require('../lib/blockchain/common');
const opcodes = Script.opcodes;

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true,
  size: 2
});

const blocks = new BlockStore({
  memory: true,
  network
});

const chain = new Chain({
  memory: true,
  blocks,
  network,
  workers
});

const miner = new Miner({
  chain,
  workers
});

const cpu = miner.cpu;

let wallet = new MemWallet({
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

chain.on('connect', (entry, block) => {
  wallet.addBlock(entry, block.txs);
});

chain.on('disconnect', (entry, block) => {
  wallet.removeBlock(entry, block.txs);
});

describe('Chain', function() {
  this.timeout(45000);

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

  it('should have correct wallet balance', async () => {
    assert.strictEqual(wallet.balance, 428000000000);
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

  it('should fail to connect bad witness root', async () => {
    const block = await cpu.mineBlock();
    const tx = block.txs[0];
    const input = tx.inputs[0];
    input.witness.set(0, Buffer.alloc(1001));
    block.refresh(true);
    assert.strictEqual(await addBlock(block), 'bad-witnessroot');
  });

  it('should fail to connect bad tx merkle root', async () => {
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

    assert.strictEqual(chain.height, 2215);
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

  describe('Sigops', function() {
    // Create a script with 100 sigops.
    // The boolean logic at the top makes it ANYONECANSPEND.
    // The following sigops are still counted even though they are not executed.
    // This script is based on the Bitcoin Core test p2p_segwit.py
    const script = new Script();
    script.pushOp(opcodes.OP_1);
    script.pushOp(opcodes.OP_IF);
    script.pushOp(opcodes.OP_1);
    script.pushOp(opcodes.OP_ELSE);
    for (let i = 0; i < 100; i++)
      script.pushOp(opcodes.OP_CHECKSIG);
    script.pushOp(opcodes.OP_ENDIF);
    script.compile();

    // Address from script
    const addr = Address.fromScripthash(script.sha3());

    // Value of each UTXO
    const value = 1;

    // First block to spend from
    let start;

    it('should mine 80 blocks to 100-sigops script hash address', async () => {
      // We are going to modify blocks after mining,
      // just to get UTXO for the next test.
      // These blocks don't have to be strictly 100% valid.
      const flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;

      // Generate 80 blocks where each coinbase transaction
      // has 10 outputs to the 100-sigop address.
      start = chain.height + 1;
      for (let i = 0; i < 80; i++) {
        const block = await cpu.mineBlock();
        const cb = block.txs[0];

        // Clear coinbase outputs
        cb.outputs.length = 0;

        // Add 10 outputs to our sigops address instead
        for (let j = 0; j < 10; j++) {
          const output = new Output();
          output.address = addr;
          output.value = value;
          cb.outputs.push(output);
        }

        block.refresh(true);
        block.merkleRoot = block.createMerkleRoot();
        block.witnessRoot = block.createWitnessRoot();

        assert(await chain.add(block, flags));
      }
    });

    it('should mine 10 blocks to wallet', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock(null, wallet.getReceive());
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should connect a block with maximum sigops', async () => {
      // Mine a block with exactly 80,000 sigops.
      // We do this by spending each of the 10 coinbase outputs from each
      // of those previously generated 80 blocks all in the same new block.
      // Each redeem script for each of those outputs has 100 sigops:
      // 100 sigops * 10 outputs * 80 blocks = 80,000 sigops total
      // The consensus limit MAX_BLOCK_SIGOPS is 80,000
      const job = await cpu.createJob();

      // Reset the sigops counter
      // (Initial value is non-zero to reserve space for coinbase)
      job.attempt.sigops = 0;

      const end = start + 80;
      for (let b = start; b < end; b++) {
        const mtx = new MTX();
        mtx.addOutput(wallet.getReceive(), 10);

        const block = await chain.getBlock(b);
        const cb = block.txs[0];
        assert.strictEqual(cb.outputs.length, 10);

        for (let i = 0; i < 10; i++) {
          mtx.addTX(cb, i);

          // Push redeem script
          mtx.inputs[i].witness.push(script.encode());
        }

        job.pushTX(mtx.toTX(), mtx.view);
      }

      assert.strictEqual(job.attempt.sigops, 80000);
      job.refresh();
      assert.strictEqual(await mineBlock(job), 'OK');
    });

    it('should fail to connect a block with too many sigops', async () => {
      // Remove last block so we can re-use the 100-sigop outputs.
      await chain.disconnect(chain.tip);

      // Mine a block with exactly 80,001 sigops.
      const job = await cpu.createJob();
      job.attempt.sigops = 0;

      const end = start + 80;
      for (let b = start; b < end; b++) {
        const mtx = new MTX();
        mtx.addOutput(wallet.getReceive(), 10);

        const block = await chain.getBlock(b);
        const cb = block.txs[0];
        assert.strictEqual(cb.outputs.length, 10);

        for (let i = 0; i < 10; i++) {
          mtx.addTX(cb, i);

          // Push redeem script
          mtx.inputs[i].witness.push(script.encode());
        }

        job.pushTX(mtx.toTX(), mtx.view);
      }

      assert.strictEqual(job.attempt.sigops, 80000);

      // Add one more sigop
      const lastMTX = await wallet.create({
        value: 1,
        address: new Address()
      });
      job.pushTX(lastMTX.toTX(), lastMTX.view);
      assert.strictEqual(job.attempt.sigops, 80001);

      job.refresh();
      assert.strictEqual(await mineBlock(job), 'bad-blk-sigops');
    });
  });

  describe('Covenant limits', function() {
    before(async () => {
      await chain.reset(0);
      wallet = new MemWallet({ network });

      wallet.getNameStatus = async (nameHash) => {
        assert(Buffer.isBuffer(nameHash));
        const height = chain.height + 1;
        const state = await chain.getNextState();
        const hardened = state.hasHardening();
        return chain.db.getNameStatus(nameHash, height, hardened);
      };
    });

    it('should mine 2000 blocks', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());

      for (let i = 0; i < 2000; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      assert.strictEqual(chain.height, 2000);
    });

    it('should fail to connect too many OPENs', async () => {
      const job1 = await cpu.createJob();

      for (let i = 0; i < consensus.MAX_BLOCK_OPENS + 1; i++) {
        const name = `test_${i}`;
        const open = await wallet.sendOpen(name);
        const item = BlockEntry.fromTX(open.toTX(), open.view, job1.attempt);
        job1.attempt.items.push(item);
      }

      job1.attempt.refresh();

      assert.strictEqual(await mineBlock(job1), 'bad-blk-opens');

      // "zap" memwallet
      for (const {tx} of job1.attempt.items) {
        wallet.removeTX(tx);
      }
    });

    it('should connect max number of OPENs', async () => {
      // We do this 3 times to open enough names for the following tests
      for (let blocks = 0; blocks < 3; blocks++) {
        const job1 = await cpu.createJob();
        for (let txs = 0; txs < consensus.MAX_BLOCK_OPENS; txs++) {
          const name = `test_${blocks}_${txs}`;
          const open = await wallet.sendOpen(name);
          const item = BlockEntry.fromTX(open.toTX(), open.view, job1.attempt);
          job1.attempt.items.push(item);
        }
        job1.attempt.refresh();
        assert.strictEqual(await mineBlock(job1), 'OK');
      }
    });

    it('should win 900 name auctions', async () => {
      for (let i = 0; i < network.names.treeInterval; i++) {
        const block = await cpu.mineBlock();
        assert(await chain.add(block));
      }

      for (let blocks = 0; blocks < 3; blocks++) {
        const job1 = await cpu.createJob();
        for (let txs = 0; txs < consensus.MAX_BLOCK_OPENS; txs++) {
          const name = `test_${blocks}_${txs}`;
          const bid = await wallet.sendBid(name, 1, 1);
          const item = BlockEntry.fromTX(bid.toTX(), bid.view, job1.attempt);
          job1.attempt.items.push(item);
        }
        job1.attempt.refresh();
        assert.strictEqual(await mineBlock(job1), 'OK');
      }

      for (let i = 0; i < network.names.biddingPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(await chain.add(block));
      }

      for (let blocks = 0; blocks < 3; blocks++) {
        const job2 = await cpu.createJob();
        for (let txs = 0; txs < consensus.MAX_BLOCK_OPENS; txs++) {
          const name = `test_${blocks}_${txs}`;
          const reveal = await wallet.sendReveal(name);
          const item = BlockEntry.fromTX(reveal.toTX(), reveal.view, job2.attempt);
          job2.attempt.items.push(item);
        }
        job2.attempt.refresh();
        assert.strictEqual(await mineBlock(job2), 'OK');
      }

      for (let i = 0; i < network.names.revealPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(await chain.add(block));
      }
    });

    it('should fail to connect too many RENEWALs', async () => {
      // As far as block limits are concerned
      // REGISTER counts as a renewal, not an update.

      const job1 = await cpu.createJob();

      let x = 0;
      let i = 0;
      let count = 0;
      while (count < consensus.MAX_BLOCK_RENEWALS + 1) {
        const name = `test_${x}_${i}`;

        // This is definitely a REGISTER (renewal) not an UPDATE
        const ns = await chain.db.getNameStateByName(name);
        assert(!ns.registered);

        const register = await wallet.sendUpdate(name, null);
        const item = BlockEntry.fromTX(register.toTX(), register.view, job1.attempt);
        job1.attempt.items.push(item);

        count++;
        i++;
        if (i >= consensus.MAX_BLOCK_OPENS) {
          i = 0;
          x++;
        }
      }

      job1.attempt.refresh();

      assert.strictEqual(await mineBlock(job1), 'bad-blk-renewals');

      // "zap" memwallet
      for (const {tx} of job1.attempt.items)
        wallet.removeTX(tx);
    });

    it('should connect max number of RENEWALs', async () => {
      const job1 = await cpu.createJob();

      let x = 0;
      let i = 0;
      let count = 0;
      while (count < consensus.MAX_BLOCK_RENEWALS) {
        const name = `test_${x}_${i}`;

        // This is definitely a REGISTER (renewal) not an UPDATE
        const ns = await chain.db.getNameStateByName(name);
        assert(!ns.registered);

        const register = await wallet.sendUpdate(name, null);
        const item = BlockEntry.fromTX(register.toTX(), register.view, job1.attempt);
        job1.attempt.items.push(item);

        count++;
        i++;
        if (i >= consensus.MAX_BLOCK_OPENS) {
          i = 0;
          x++;
        }
      }

      job1.attempt.refresh();

      assert.strictEqual(await mineBlock(job1), 'OK');

      // Register 100 more so we can blow the limit on UPDATES in the next test
      const job2 = await cpu.createJob();

      while (count < consensus.MAX_BLOCK_RENEWALS + 100) {
        const name = `test_${x}_${i}`;

        // This is definitely a REGISTER (renewal) not an UPDATE
        const ns = await chain.db.getNameStateByName(name);
        assert(!ns.registered);

        const register = await wallet.sendUpdate(name, null);
        const item = BlockEntry.fromTX(register.toTX(), register.view, job2.attempt);
        job2.attempt.items.push(item);

        count++;
        i++;
        if (i >= consensus.MAX_BLOCK_OPENS) {
          i = 0;
          x++;
        }
      }

      job2.attempt.refresh();

      assert.strictEqual(await mineBlock(job2), 'OK');
    });

    it('should fail to connect too many UPDATEs', async () => {
      const job1 = await cpu.createJob();

      let x = 0;
      let i = 0;
      let count = 0;
      while (count < consensus.MAX_BLOCK_UPDATES + 1) {
        const name = `test_${x}_${i}`;

        // This is definitely an UPDATE, not a REGISTER
        const ns = await chain.db.getNameStateByName(name);
        assert(ns.registered);

        const update = await wallet.sendUpdate(name, null);
        const item = BlockEntry.fromTX(update.toTX(), update.view, job1.attempt);
        job1.attempt.items.push(item);

        count++;
        i++;
        if (i >= consensus.MAX_BLOCK_OPENS) {
          i = 0;
          x++;
        }
      }

      job1.attempt.refresh();

      assert.strictEqual(await mineBlock(job1), 'bad-blk-updates');

      // "zap" memwallet
      for (const {tx} of job1.attempt.items)
        wallet.removeTX(tx);
    });

    it('should connect max number of UPDATEs', async () => {
      const job1 = await cpu.createJob();

      let x = 0;
      let i = 0;
      let count = 0;
      while (count < consensus.MAX_BLOCK_UPDATES) {
        const name = `test_${x}_${i}`;

        // This is definitely an UPDATE, not a REGISTER
        const ns = await chain.db.getNameStateByName(name);
        assert(ns.registered);

        const update = await wallet.sendUpdate(name, null);
        const item = BlockEntry.fromTX(update.toTX(), update.view, job1.attempt);
        job1.attempt.items.push(item);

        count++;
        i++;
        if (i >= consensus.MAX_BLOCK_OPENS) {
          i = 0;
          x++;
        }
      }

      job1.attempt.refresh();

      assert.strictEqual(await mineBlock(job1), 'OK');
    });

    it('should fail to connect a block with duplicate names', async () => {
      const job1 = await cpu.createJob();

      for (let i = 0; i < 2; i++) {
        const name = 'test_duplicate';
        const open = await wallet.sendOpen(name);
        const item = BlockEntry.fromTX(open.toTX(), open.view, job1.attempt);
        job1.attempt.items.push(item);
      }

      job1.attempt.refresh();

      assert.strictEqual(await mineBlock(job1), 'bad-blk-names');

      // "zap" memwallet
      for (const {tx} of job1.attempt.items) {
        wallet.removeTX(tx);
      }
    });
  });

  describe('Chain width', function() {
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

      // Block is saved as an alternate (not in main chain)
      let competitor = false;
      chain.on('competitor', (block, entry) => {
        competitor = true;
        assert.strictEqual(entry.height, AFTER_CHECKPOINT + 1);
      });

      const entry = await chain.getEntry(AFTER_CHECKPOINT);
      const block = await cpu.mineBlock(entry);
      assert(await chain.add(block));
      assert(competitor);
    });
  });
});
