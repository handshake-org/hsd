'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Network = require('../lib/protocol/network');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');

/** @typedef {import('../lib/wallet/wallet')} Wallet */

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: network.type,
  plugins: [require('../lib/wallet/plugin')]
});

const { wdb } = node.require('walletdb');

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString(network);
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Wallet Import Nonce', function () {
  /** @type {Wallet} */
  let walletA;

  /** @type {Wallet} */
  let walletB;

  const NAME = rules.grindName(10, 1, network);
  const NAMEHASH = rules.hashName(NAME);
  const BIDS = [
    { value: 1e6, lockup: 2e6, addr: undefined }, // sendbid
    { value: 2e6, lockup: 4e6, addr: undefined }, // -|sendbatch
    { value: 4e6, lockup: 8e6, addr: undefined }  // -|sendbatch
  ];

  before(async () => {
    await node.ensure();
    await node.open();

    // Both wallets have the same seed
    walletA = await wdb.create();
    walletB = await wdb.create({ mnemonic: walletA.master.mnemonic });
    assert.bufferEqual(walletA.master.writeKey(), walletB.master.writeKey());
  });

  after(async () => {
    await node.close();
  });

  it('should fund wallet', async () => {
    await mineBlocks(2, await walletA.receiveAddress());
  });

  it('should open an auction and advance to bidding period', async () => {
    await walletA.sendOpen(NAME);
    await mineBlocks(network.names.treeInterval + 1);
  });

  it('should bid with sendbid', async () => {
    const bid = BIDS[0];

    const bidTx = await walletA.sendBid(NAME, bid.value, bid.lockup);

    // Save address for importnonce later
    bid.addr = bidTx.outputs[0].address;
  });

  it('should bid with sendbatch', async () => {
    const batch = [
      ['BID', NAME, BIDS[1].value, BIDS[1].lockup],
      ['BID', NAME, BIDS[2].value, BIDS[2].lockup]
    ];

    const bidTx = await walletA.sendBatch(batch);

    // Save address for importnonce later
    for (const output of bidTx.outputs) {
      if (!output.covenant.isBid())
        continue;

      const index = BIDS.findIndex(bid => bid.lockup === output.value);
      BIDS[index].addr = output.address;
    }
  });

  it('should verify bids were placed', async () => {
    await mineBlocks(1);
    const bidsA = await walletA.getBidsByName(NAME);
    assert.strictEqual(bidsA.length, BIDS.length);
  });

  it('should not be known by other wallet', async () => {
    const bidsB = await walletB.getBidsByName(NAME);
    assert.strictEqual(bidsB.length, BIDS.length);

    for (const bid of bidsB)
      assert.strictEqual(bid.value, -1);
  });

  it('should be imported by other wallet', async () => {
    for (const bid of BIDS)
      await walletB.generateBlinds(NAMEHASH, bid.addr, bid.value);

    const bidsB = await walletB.getBidsByName(NAME);
    assert.strictEqual(bidsB.length, BIDS.length);

    // Ensure bids have correct true bid values
    for (const bid of bidsB) {
      const index = BIDS.findIndex(x => x.lockup === bid.lockup);
      assert.strictEqual(BIDS[index].value, bid.value);
    }
  });

  it('should reaveal all bids from other wallet', async () => {
    await mineBlocks(network.names.biddingPeriod);

    const revealTx = await walletB.sendRevealAll();
    const revealOutputs = revealTx.outputs.filter(out => out.covenant.isReveal());
    assert.strictEqual(revealOutputs.length, BIDS.length);
  });
});
