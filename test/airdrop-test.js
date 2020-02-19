/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const fs = require('fs');
const {resolve} = require('path');
const assert = require('bsert');
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

const AIRDROP_PROOF_FILE = resolve(__dirname, 'data', 'airdrop-proof.base64');
const FAUCET_PROOF_FILE = resolve(__dirname, 'data', 'faucet-proof.base64');
const read = file => Buffer.from(fs.readFileSync(file, 'binary'), 'base64');

// Sent to:
// {
//   pub: '02a8959cc6491aed3fb96b3b684400311f2779fb092b026a4b170b35c175d48cec',
//   hash: '95cb6129c6b98179866094b2717bfbe27d9c1921',
//   addr: 'hs1qjh9kz2wxhxqhnpnqjje8z7lmuf7ecxfp6kxlly'
// }

// Doxing myself (watch some wiseguy publish this on mainnet):
const rawProof = read(AIRDROP_PROOF_FILE);
const rawFaucetProof = read(FAUCET_PROOF_FILE); // hs1qmjpjjgpz7dmg37paq9uksx4yjp675690dafg3q

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

describe('Airdrop', function() {
  this.timeout(15000);

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
    assert.strictEqual(output.value, 4246894314);
    assert.strictEqual(output.address.toString(),
                       'hs1qlpj3rwvtz83fvk6z0nm2rw57f3cwdczmc2j6a2');

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
      assert.strictEqual(output.value, 4246894314);
    }

    {
      const input = cb.inputs[2];
      const output = cb.outputs[2];

      assert(input);
      assert(input.prevout.isNull());
      assert(input.witness.length === 1);
      assert.strictEqual(output.value, 8493988628 - 100e6);
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

    assert.strictEqual(chain.db.state.value, snapshot + 6000e6);
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

  it('should mine faucet proof', async () => {
    const proof = AirdropProof.decode(rawFaucetProof);

    const job = await cpu.createJob();
    job.addAirdrop(proof);
    job.refresh();

    const block = await job.mineAsync();
    const [tx] = block.txs;

    assert(await chain.add(block));

    assert.strictEqual(tx.outputs.length, 2);
    assert.strictEqual(tx.outputs[0].value, 2100e6);
    assert.strictEqual(tx.outputs[1].value, 8393988628);
    assert.strictEqual(tx.outputs[1].address.toString(),
                       'hs1qmjpjjgpz7dmg37paq9uksx4yjp675690dafg3q');
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
