/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('fs');
const {resolve} = require('path');
const FullNode = require('../lib/node/fullnode');
const TX = require('../lib/primitives/tx');
const Input = require('../lib/primitives/input');
const Output = require('../lib/primitives/output');
const MemWallet = require('./util/memwallet');
const AirdropProof = require('../lib/primitives/airdropproof');
const Block = require('../lib/primitives/block');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const common = require('../lib/blockchain/common');
const ownership = require('../lib/covenants/ownership');
const VERIFY_NONE = common.flags.VERIFY_NONE;

const node = new FullNode({
  memory: true,
  network: 'regtest'
});

const RESET_TXSTART = node.network.txStart;

// Ease up that mempool
node.mempool.options.minRelay = 0;
node.mempool.options.rejectAbsurdFees = false;
node.miner.options.minWeight = 1000000;

// Use a valid, working airdrop proof
const FAUCET_PROOF_FILE = resolve(__dirname, 'data', 'faucet-proof.base64');
const raw = Buffer.from(fs.readFileSync(FAUCET_PROOF_FILE, 'binary'), 'base64');
const proof = AirdropProof.decode(raw);

// We only need this for the fakeClaim
const wallet = new MemWallet({network: 'regtest'});
node.chain.on('connect', (entry, block) => {
  wallet.addBlock(entry, block.txs);
});
wallet.getNameStatus = async (nameHash) => {
  assert(Buffer.isBuffer(nameHash));
  const height = node.chain.height + 1;
  const state = await node.chain.getNextState();
  const hardened = state.hasHardening();
  return node.chain.db.getNameStatus(nameHash, height, hardened);
};

describe('Disable TXs', function() {
  this.timeout(20000);

  let utxo, lastTX;

  before(async () => {
    node.network.txStart = 5;
    await node.open();

    // Start with one block for the fakeClaim
    const block = await node.miner.mineBlock();
    assert(await node.chain.add(block));
  });

  after(async () => {
    await node.close();
    node.network.txStart = RESET_TXSTART;
  });

  it('should reject tx from mempool before txStart', async () => {
    const tx = new TX({
      inputs: [new Input()],
      outputs: [new Output()]
    });
    tx.inputs[0].prevout.hash = Buffer.alloc(32, 0x01);

    await assert.rejects(node.mempool.addTX(tx),
      {reason: 'no-tx-allowed-yet'});
  });

  it('should reject claim from mempool before txStart', async () => {
    const claim = await wallet.fakeClaim('cloudflare');

    try {
      ownership.ignore = true;
      await assert.rejects(node.mempool.addClaim(claim),
        {reason: 'no-tx-allowed-yet'});
    } finally {
      ownership.ignore = false;
    }
  });

  it('should reject airdrop from mempool before txStart', async () => {
    await assert.rejects(node.mempool.addAirdrop(proof),
      {reason: 'no-tx-allowed-yet'});
  });

  it('should reject block with >1 coinbase output before txStart', async () => {
    const tx1 = new TX({
      inputs: [new Input()],
      outputs: [new Output(), new Output()]
    });
    tx1.locktime = node.chain.height + 1;

    const block = new Block();
    block.txs.push(tx1);
    block.prevBlock = node.chain.tip.hash;
    block.time = node.chain.tip.time + 1;
    block.bits = await node.chain.getTarget(block.time, node.chain.tip);

    await assert.rejects(node.chain.add(block, VERIFY_NONE),
      {reason: 'no-tx-allowed-yet'});
    assert(node.chain.hasInvalid(block));
  });

  it('should reject non-empty block before txStart', async () => {
    const tx1 = new TX({
      inputs: [new Input()],
      outputs: [new Output()]
    });
    tx1.locktime = node.chain.height + 1;

    const tx2 = new TX({
      inputs: [new Input()],
      outputs: [new Output()]
    });

    const block = new Block();
    block.txs.push(tx1);
    block.txs.push(tx2);
    block.prevBlock = node.chain.tip.hash;
    block.time = node.chain.tip.time + 2;
    block.bits = await node.chain.getTarget(block.time, node.chain.tip);

    await assert.rejects(node.chain.add(block, VERIFY_NONE),
      {reason: 'no-tx-allowed-yet'});
    assert(node.chain.hasInvalid(block));
  });

  it('should accept empty block before txStart', async () => {
    // Create an address that takes literally nothing to spend
    const addr = Address.fromScript(new Script());

    const tx1 = new TX({
      inputs: [new Input()],
      outputs: [new Output()]
    });
    tx1.outputs[0].address = addr;
    tx1.locktime = node.chain.height + 1;

    const block = new Block();
    block.txs.push(tx1);
    block.prevBlock = node.chain.tip.hash;
    block.time = node.chain.tip.time + 3;
    block.bits = await node.chain.getTarget(block.time, node.chain.tip);

    assert(await node.chain.add(block, VERIFY_NONE));

    // Spend this output later
    utxo = block.txs[0].hash();
  });

  it('should add blocks until one block before txStart', async() => {
    for (let i = node.chain.height; i < node.network.txStart - 1; i++) {
      const block = await node.miner.mineBlock();
      assert(await node.chain.add(block));
    }
    // The NEXT block is the txStart height
    assert.strictEqual(node.chain.height + 1, node.network.txStart);
  });

  it('should allow tx in mempool one block before txStart', async () => {
    lastTX = new TX({
      inputs: [new Input()],
      outputs: [new Output()]
    });
    lastTX.inputs[0].prevout.hash = utxo;
    lastTX.inputs[0].prevout.index = 0;
    lastTX.inputs[0].witness.items[0] = Buffer.from([1, 1]);  // true
    lastTX.inputs[0].witness.items[1] = Buffer.alloc(0);      // empty script

    await node.mempool.addTX(lastTX);
    assert.strictEqual(node.mempool.map.size, 1);
    assert(node.mempool.has(lastTX.hash()));
    assert.strictEqual(node.chain.height + 1, node.network.txStart);
  });

  it('should allow claim in mempool one block before txStart', async () => {
    const claim = await wallet.fakeClaim('cloudflare');

    try {
      ownership.ignore = true;
      await node.mempool.addClaim(claim);
    } finally {
      ownership.ignore = false;
    }
    assert.strictEqual(node.mempool.claims.size, 1);
    assert(node.mempool.hasClaim(claim.hash()));
    assert.strictEqual(node.chain.height + 1, node.network.txStart);
  });

  it('should allow airdrop in mempool one block before txStart', async () => {
    await node.mempool.addAirdrop(proof);
    assert.strictEqual(node.mempool.airdrops.size, 1);
    assert(node.mempool.hasAirdrop(proof.hash()));
    assert.strictEqual(node.chain.height + 1, node.network.txStart);
  });

  it('should accept a block full of goodies at txStart', async() => {
    const block = await node.miner.mineBlock();
    try {
      ownership.ignore = true;
      assert(await node.chain.add(block));
    } finally {
      ownership.ignore = false;
    }

    // This is the first block where transactions are allowed.
    assert.strictEqual(node.chain.height, node.network.txStart);

    // The first output is the coinbase reward. The second output
    // is the claim, and the third output is the airdrop redemption.
    assert.strictEqual(block.txs.length, 2);
    assert.bufferEqual(block.txs[1].hash(), lastTX.hash());
    assert.strictEqual(block.txs[0].outputs.length, 3);
    assert(block.txs[0].outputs[0].covenant.isNone());
    assert(block.txs[0].outputs[1].covenant.isClaim());
    assert(block.txs[0].outputs[2].covenant.isNone());
    assert.strictEqual(block.txs[0].outputs[2].value, proof.getValue() - proof.fee);
  });
});
