/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('./util/assert');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const AirdropProof = require('../lib/primitives/airdropproof');

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: false
});

// Sent to:
// {
//   pub: '02a8959cc6491aed3fb96b3b684400311f2779fb092b026a4b170b35c175d48cec',
//   hash: '95cb6129c6b98179866094b2717bfbe27d9c1921',
//   addr: 'hs1qjh9kz2wxhxqhnpnqjje8z7lmuf7ecxfp6kxlly'
// }

// Doxing myself (watch some wiseguy publish this on mainnet):
const rawProof = Buffer.from(''
  + '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'
  + 'mDsDyncYOHhg0KWh6SoTNS3czTVu3uPGxvaM', 'base64');

const rawFaucetProof = Buffer.from(''
  + 'bwAAAAsnph9MVn1r09UQy6vGKBZhGepaRnzZynKv0M6m7tnkq5b5Tjw77gx'
  + 'oQRzEoJdgga3Yd04r8AXVrUV5cjno32n3QwnqKGkYoEfspsU7HB3aX+zOcl'
  + 'NnvJ7y2WS6T7+vWeVaMMi+CzCAlVmLefC/h4EDwN9WjOHEGVvtaFcTLa1XH'
  + '2U/1XaGOmav2ot4KozaGQCm6FqsCF730nogJKbANMiqHdWAS7m5pKbxdEjJ'
  + 'sRhNOrKs3z2Xjvh5ETcLcVY8wsPo9paPbsQ+Y1DwaQHz51FsRsqQidhTnaX'
  + 'yr6L2+NWsLF39yNMXWsCoDMpX1vinZotX4sK7/+khpu7BTwUIdleXY9yTFh'
  + 'uXelO+3APlnCqjPGLjZH1yrFBjEF8KzRO/tB2tk77PeM+E/7S1TbEGc0o47'
  + 'ztSMxoAjkRsPSnmsLQEGVofkKU6pbcW/6QhrITqk3JzWPD0mNjwpOa43pbN'
  + '+TErAAAgBAAU3IMpICLzdoj4PQF5aBqkkHXqaK9oISopAgAAAAAAFNyDKSA'
  + 'i83aI+D0BeWgapJB16miv/gDh9QUA', 'base64');

function createNode() {
  const chain = new Chain({
    memory: true,
    network,
    workers
  });

  const miner = new Miner({
    chain,
    workers
  });

  return {
    chain,
    miner,
    cpu: miner.cpu,
    wallet: () => {
      const wallet = new MemWallet({ network });

      chain.on('connect', (entry, block) => {
        wallet.addBlock(entry, block.txs);
      });

      chain.on('disconnect', (entry, block) => {
        wallet.removeBlock(entry, block.txs);
      });

      return wallet;
    }
  };
}

describe('Airdrop', (ctx) => {
  ctx.timeout(15000);

  const node = createNode();
  const orig = createNode();
  const comp = createNode();

  const {chain, miner, cpu} = node;

  const wallet = node.wallet();

  let snapshot = null;

  it('should open chain and miner', async () => {
    await chain.open();
    await miner.open();
  });

  it('should add addrs to miner', async () => {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
  });

  it('should mine 20 blocks', async () => {
    for (let i = 0; i < 20; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }
  });

  it('should fail to mine airdrop proof', async () => {
    const proof = AirdropProof.decode(rawProof);
    const key = proof.getKey();
    assert(key);

    // Flipping one bit should break everything.
    key.C1[Math.random() * key.C1.length | 0] ^= 1;

    proof.key = key.encode();

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    await assert.rejects(chain.add(block),
      { reason: 'mandatory-script-verify-flag-failed' });
  });

  it('should mine airdrop proof', async () => {
    const proof = AirdropProof.decode(rawProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    assert(block.txs.length === 1);

    const [cb] = block.txs;

    assert(cb.inputs.length === 2);
    assert(cb.outputs.length === 2);

    const [, input] = cb.inputs;
    const [, output] = cb.outputs;

    assert(input);
    assert(input.prevout.isNull());
    assert(input.witness.length === 1);
    assert(output.value === 4639780756);

    assert(await chain.add(block));
  });

  it('should prevent double spend with bitfield', async () => {
    const proof = AirdropProof.decode(rawProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    await assert.rejects(chain.add(block),
      { reason: 'bad-txns-bits-missingorspent' });
  });

  it('should mine 10 blocks', async () => {
    for (let i = 0; i < 10; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    snapshot = chain.db.state.value;
  });

  it('should open other nodes', async () => {
    await orig.chain.open();
    await orig.miner.open();
    await comp.chain.open();
    await comp.miner.open();
  });

  it('should clone the chain', async () => {
    for (let i = 1; i <= chain.height; i++) {
      const block = await chain.getBlock(i);
      assert(block);
      assert(await orig.chain.add(block));
    }
  });

  it('should mine a competing chain', async () => {
    while (comp.chain.tip.chainwork.lte(chain.tip.chainwork)) {
      const block = await comp.cpu.mineBlock();
      assert(block);
      assert(await comp.chain.add(block));
    }
  });

  it('should reorg the airdrop', async () => {
    let reorgd = false;

    chain.once('reorganize', () => reorgd = true);

    for (let i = 1; i <= comp.chain.height; i++) {
      assert(!reorgd);
      const block = await comp.chain.getBlock(i);
      assert(block);
      assert(await chain.add(block));
    }

    assert(reorgd);
  });

  it('should mine airdrop+faucet proof', async () => {
    const proof = AirdropProof.decode(rawProof);
    const fproof = AirdropProof.decode(rawFaucetProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.addAirdrop(fproof);
    job.refresh();

    const block = await job.mineAsync();

    assert(block.txs.length === 1);

    const [cb] = block.txs;

    assert(cb.inputs.length === 3);
    assert(cb.outputs.length === 3);

    {
      const input = cb.inputs[1];
      const output = cb.outputs[1];

      assert(input);
      assert(input.prevout.isNull());
      assert(input.witness.length === 1);
      assert.strictEqual(output.value, 4639780756);
    }

    {
      const input = cb.inputs[2];
      const output = cb.outputs[2];

      assert(input);
      assert(input.prevout.isNull());
      assert(input.witness.length === 1);
      assert.strictEqual(output.value, 9280561512 - 100e6);
    }

    assert(await chain.add(block));
  });

  it('should reorg back to the correct state', async () => {
    let reorgd = false;

    chain.once('reorganize', () => reorgd = true);

    while (!reorgd) {
      const block = await orig.cpu.mineBlock();
      assert(block);
      assert(await orig.chain.add(block));
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.db.state.value, snapshot + 3000e6);
  });

  it('should prevent double spend with bitfield', async () => {
    const proof = AirdropProof.decode(rawProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    await assert.rejects(chain.add(block),
      { reason: 'bad-txns-bits-missingorspent' });
  });

  it('should prevent mine faucet proof', async () => {
    const proof = AirdropProof.decode(rawFaucetProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should prevent double spend with bitfield', async () => {
    const proof = AirdropProof.decode(rawFaucetProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    await assert.rejects(chain.add(block),
      { reason: 'bad-txns-bits-missingorspent' });
  });

  it('should close and open', async () => {
    await chain.close();
    await chain.open();
  });

  it('should prevent double spend with bitfield', async () => {
    const proof = AirdropProof.decode(rawFaucetProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();

    await assert.rejects(chain.add(block),
      { reason: 'bad-txns-bits-missingorspent' });
  });

  it('should close other nodes', async () => {
    await orig.miner.close();
    await orig.chain.close();
    await comp.miner.close();
    await comp.chain.close();
  });

  it('should cleanup', async () => {
    await miner.close();
    await chain.close();
  });
});
