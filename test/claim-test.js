'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Address = require('../lib/primitives/address');
const Claim = require('../lib/primitives/claim');
const FullNode = require('../lib/node/fullnode');
const consensus = require('../lib/protocol/consensus');
const ownership = require('../lib/covenants/ownership');
const reserved = require('../lib/covenants/reserved');
const {Resource} = require('../lib/dns/resource');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');
let wallet, addr, claim, reclaim, rereclaim, finalOwner;

const CLOUDFLARE = reserved.getByName('cloudflare');

// Keep track of expected on-chain total value
let AUDIT = consensus.GENESIS_REWARD;
const REWARD = consensus.BASE_REWARD;

function check() {
  assert.strictEqual(AUDIT, node.chain.db.state.value);
}

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
    AUDIT += REWARD;
  }

  // Don't worry about decreasing block subsidies
  if (node.chain.height >= network.halvingInterval)
    assert(false, 'Too many blocks for this test!');
}

describe('Reserved Name Claims', function() {
  this.timeout(10000);
  before(async () => {
    await node.open();

    wallet = await wdb.create();
    addr = await wallet.receiveAddress();
  });

  after(async () => {
    await node.close();
  });

  // Reset the ownership flag after every test,
  // even if the test fails. This should keep this
  // modification isolated from other tests.
  beforeEach(() => {
    ownership.ignore = true;
  });

  afterEach(() => {
    ownership.ignore = false;
  });

  it('should fund wallet and activate soft fork', async () => {
    await mineBlocks(network.deflationHeight + 1, addr);
    check();
  });

  it('should send initial CLAIM', async () => {
    claim = await wallet.sendFakeClaim('cloudflare');
    check();
    await mineBlocks(1);
    AUDIT += CLOUDFLARE.value;
    check();

    // Miner got a fee from the CLAIM
    const fee = claim.getFee(network);
    const tip = await node.chain.getBlock(node.chain.tip.hash);
    const cbOut = tip.txs[0].outputs[0].value;
    assert.strictEqual(cbOut, REWARD + fee);
  });

  it('should send re-CLAIM', async () => {
    reclaim = await wallet.sendFakeClaim('cloudflare');
    check();
    await mineBlocks(1);
    check();

    // Miner didn't get a fee from the re-CLAIM
    const tip = await node.chain.getBlock(node.chain.tip.hash);
    const cbOut = tip.txs[0].outputs[0].value;
    assert.strictEqual(cbOut, REWARD);

    // Initial claim and re-claim have same value & fee
    // but commit to different blocks
    const initial = claim.getData(network);
    const update = reclaim.getData(network);
    assert.strictEqual(initial.value, update.value);
    assert.strictEqual(initial.fee, update.fee);
    assert.notStrictEqual(initial.commitHeight, update.commitHeight);
    assert.notStrictEqual(initial.commitHash, update.commitHash);
  });

  it('should send re-re-CLAIM', async () => {
    rereclaim = await wallet.sendFakeClaim('cloudflare');
    check();
    await mineBlocks(1);
    check();

    // Miner didn't get a fee from the re-re-CLAIM
    const tip = await node.chain.getBlock(node.chain.tip.hash);
    const cbOut = tip.txs[0].outputs[0].value;
    assert.strictEqual(cbOut, REWARD);

    // Initial claim and re-claim have same value & fee
    // but commit to different blocks
    const initial = reclaim.getData(network);
    const update = rereclaim.getData(network);
    assert.strictEqual(initial.value, update.value);
    assert.strictEqual(initial.fee, update.fee);
    assert.notStrictEqual(initial.commitHeight, update.commitHeight);
    assert.notStrictEqual(initial.commitHash, update.commitHash);

    finalOwner = await node.chain.getCoin(tip.txs[0].hash(), 1);
  });

  it('should check UTXO set', async () => {
    const state = node.chain.db.state;
    assert.strictEqual(state.burned, 0);
    assert.strictEqual(state.value, AUDIT);
    // Genesis block coinbase is spendable
    assert.strictEqual(state.tx, node.chain.height + 1);
    // Only block subsidies and one CLAIM -- why just one
    // even though we sent three claims? Because re-claims
    // do not get counted in ChainState. Their value is
    // also ignored, just like unsepndable `nulldata` outputs.
    assert.strictEqual(state.coin, node.chain.height + 2);
  });

  it('should REGISTER reserved name', async () => {
    const ns = await node.chain.db.getNameStateByName('cloudflare');
    assert(ns);
    assert(!ns.isNull());
    const coin = await node.chain.db.getCoin(ns.owner.hash, ns.owner.index);
    assert(coin);

    await mineBlocks(network.names.lockupPeriod + 1);
    check();

    const resource = Resource.fromJSON({
      records: [{type: 'TXT', txt: ['#CooperationGood']}]
    });
    const register = await wallet.sendUpdate('cloudflare', resource);
    check();
    await mineBlocks(1);
    check();

    // Register definitely spent the third CLAIM output
    assert.bufferEqual(register.inputs[0].prevout.toKey(), finalOwner.toKey());
  });

  it('should check UTXO set again', async () => {
    const state = node.chain.db.state;
    // Claimed names have 0 value, nothing is burned
    assert.strictEqual(state.burned, 0);
  });

  it('should send initial CLAIM to unspendable address', async () => {
    const griefClaim = await wallet.createClaim('nl');

    // Take existing claim made by wallet
    const oldData = ownership.parseData(
      griefClaim.proof,
      griefClaim.target,
      [griefClaim.txt],
      network
    );

    // Replace the output address with nulldata
    const addr = new Address({
      version: 31,
      hash: Buffer.alloc(2)
    });
    const txt = ownership.createData(addr,
                                     oldData.fee,
                                     oldData.commitHash,
                                     oldData.commitHeight,
                                     network);
    griefClaim.proof.addData([txt]);
    const griefProof = Claim.fromProof(griefClaim.proof);

    // Attempt to send the nulldata claim
    await wdb.sendClaim(griefProof);

    // Wait, you mean it's not in the mempool?
    assert.strictEqual(node.mempool.map.size, 0);
    assert.strictEqual(node.mempool.claims.size, 0);
    assert.strictEqual(node.mempool.airdrops.size, 0);

    // Oh right, nulldata claims are non-standard because
    // they can be part of a grief attack. We'll have to insert
    // directly into a block...
    check();
    const job = await node.miner.createJob();
    job.pushClaim(griefProof);
    job.refresh();
    const block = await job.mineAsync();
    await node.chain.add(block);
    AUDIT += REWARD;
    // Only the fee gets generated because the CLAIM output is unspendable
    AUDIT += oldData.fee;
    check();

    const tip = await node.chain.getBlock(node.chain.tip.hash);
    const cbOut = tip.txs[0].outputs[0].value;
    assert.strictEqual(cbOut, REWARD + oldData.fee);
  });

  it('should fail to re-CLAIM after unspendable-address attack', async () => {
    await assert.rejects(
      wallet.sendFakeClaim('nl'),
      {message: 'Coin not found for name owner.'}
    );
  });
});
