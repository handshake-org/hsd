'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const ownership = require('../lib/covenants/ownership');
const rules = require('../lib/covenants/rules');
const {forEvent} = require('./util/common');

const network = Network.get('regtest');
const {
  treeInterval,
  claimPeriod
} = network.names;

const ACTUAL_CLAIM_PERIOD = claimPeriod;

describe('Mempool Invalidation', function() {
  const NAMES = [
    // roots
    'nl',

    // top 100
    'paypal',

    // custom
    'cloudflare',

    // other
    'steamdb'
  ];

  describe('Claim Invalidation (Integration)', function() {
    this.timeout(50000);

    let node, wallet;

    // copy names
    const TEST_CLAIMS = NAMES.slice();

    before(async () => {
      node = new FullNode({
        memory: true,
        network: network.type,
        plugins: [require('../lib/wallet/plugin')]
      });

      await node.ensure();
      await node.open();

      // Ignore claim validation
      ownership.ignore = true;

      const walletPlugin = node.require('walletdb');
      const wdb = walletPlugin.wdb;
      wallet = await wdb.get('primary');

      const addr = await wallet.receiveAddress('default');
      node.miner.addAddress(addr.toString());

      // first interval maturity
      // second interval mine claim
      network.names.claimPeriod = treeInterval * 3;

      // third interval last block should invalidate.
    });

    after(async () => {
      network.names.claimPeriod = ACTUAL_CLAIM_PERIOD;

      await node.close();
    });

    it('should mine an interval', async () => {
      for (let i = 0; i < treeInterval; i++)
        await mineBlock(node);
    });

    it('should mine claims before claimPeriod timeout', async () => {
      const name = TEST_CLAIMS.shift();

      const claim = await wallet.makeFakeClaim(name);
      let block;

      await node.mempool.insertClaim(claim);
      assert.strictEqual(node.mempool.claims.size, 1);

      // retain claim in mempool.
      [block] = await mineBlock(node, { ignoreClaims: true });
      assert.strictEqual(node.mempool.claims.size, 1);
      assert.strictEqual(block.txs[0].outputs.length, 1);

      // Now we can mine it.
      [block] = await mineBlock(node);
      assert.strictEqual(node.mempool.claims.size, 0);
      assert.strictEqual(block.txs[0].outputs.length, 2);
      assert.strictEqual(block.txs[0].outputs[1].covenant.type, rules.types.CLAIM);
    });

    it('should invalidate claim after claimPeriod timeout', async () => {
      const name = TEST_CLAIMS.shift();
      const claim = await wallet.makeFakeClaim(name);

      let block = null;

      // Mempool treats txs in it as if they were mined in the next block,
      // so we need next block to still be valid.
      while (node.chain.tip.height < network.names.claimPeriod - 2)
        await mineBlock(node);

      await node.mempool.insertClaim(claim);
      [block] = await mineBlock(node, { ignoreClaims: true });

      // Should invalidate the claim, because next block can't have claims.
      assert.strictEqual(node.mempool.claims.size, 0);
      assert.strictEqual(block.txs[0].outputs.length, 1);

      // Should fail to insert claim, as they can't be mined.
      let err;
      try {
        err = await node.mempool.insertClaim(claim);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.type, 'VerifyError');
      assert.strictEqual(err.reason, 'invalid-covenant');

      [block] = await mineBlock(node);
      assert.strictEqual(node.mempool.claims.size, 0);
      assert.strictEqual(block.txs[0].outputs.length, 1);
    });
  });

  describe('Claim Invalidation on reorg (Integration)', function() {
    this.timeout(50000);

    let node, wallet;

    // copy names
    const TEST_CLAIMS = NAMES.slice();

    before(async () => {
      node = new FullNode({
        memory: true,
        network: network.type,
        plugins: [require('../lib/wallet/plugin')]
      });

      await node.ensure();
      await node.open();

      // Ignore claim validation
      ownership.ignore = true;

      const walletPlugin = node.require('walletdb');
      const wdb = walletPlugin.wdb;
      wallet = await wdb.get('primary');

      const addr = await wallet.receiveAddress('default');
      node.miner.addAddress(addr.toString());

      // first interval maturity
      // second interval mine claim
      network.names.claimPeriod = treeInterval * 3;

      // third interval last block should invalidate.
    });

    after(async () => {
      network.names.claimPeriod = ACTUAL_CLAIM_PERIOD;

      await node.close();
    });

    it('should mine an interval', async () => {
      for (let i = 0; i < treeInterval; i++)
        await mineBlock(node);
    });

    it('should mine claims before claimPeriod timeout', async () => {
      const name = TEST_CLAIMS.shift();

      const claim = await wallet.makeFakeClaim(name);
      let block;

      await node.mempool.insertClaim(claim);
      assert.strictEqual(node.mempool.claims.size, 1);

      // retain claim in mempool.
      [block] = await mineBlock(node, { ignoreClaims: true });
      assert.strictEqual(node.mempool.claims.size, 1);
      assert.strictEqual(block.txs[0].outputs.length, 1);

      // Now we can mine it.
      [block] = await mineBlock(node);
      assert.strictEqual(node.mempool.claims.size, 0);
      assert.strictEqual(block.txs[0].outputs.length, 2);
      assert.strictEqual(block.txs[0].outputs[1].covenant.type, rules.types.CLAIM);
    });

    it('should invalidate claim after claimPeriod timeout', async () => {
      const name = TEST_CLAIMS.shift();
      const claim = await wallet.makeFakeClaim(name);

      let block, entry;

      // Mempool treats txs in it as if they were mined in the next block,
      // so we need next block to still be valid.
      while (node.chain.tip.height < network.names.claimPeriod - 2)
        await mineBlock(node);

      await node.mempool.insertClaim(claim);
      // here we experience a reorg into the claim period.
      const tip = node.chain.tip;
      const prev = await node.chain.getPrevious(tip);

      [block, entry] = await mineBlock(node, {
        ignoreClaims: true,
        tip: prev,
        blockWait: false
      });

      assert.strictEqual(node.mempool.claims.size, 1);
      assert.strictEqual(block.txs[0].outputs.length, 1);

      // Now reorg.
      [block, entry] = await mineBlock(node, {
        ignoreClaims: true,
        tip: entry
      });

      // Should invalidate the claim, because next block can't have claims.
      assert.strictEqual(node.mempool.claims.size, 0);
      assert.strictEqual(block.txs[0].outputs.length, 1);

      // Should fail to insert claim, as they can't be mined.
      let err;
      try {
        err = await node.mempool.insertClaim(claim);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.type, 'VerifyError');
      assert.strictEqual(err.reason, 'invalid-covenant');

      [block] = await mineBlock(node);
      assert.strictEqual(node.mempool.claims.size, 0);
      assert.strictEqual(block.txs[0].outputs.length, 1);
    });
  });
});

async function mineBlock(node, opts = {}) {
  assert(node);
  const chain = node.chain;
  const miner = node.miner;

  const ignoreClaims = opts.ignoreClaims ?? false;
  const tip = opts.tip || chain.tip;
  const blockWait = opts.blockWait ?? true;

  let forBlock = null;

  if (blockWait)
    forBlock = forEvent(node, 'block', 1, 2000);

  let backupClaims = null;

  if (ignoreClaims) {
    backupClaims = node.mempool.claims;
    node.mempool.claims = new BufferMap();
  }
  const job = await miner.cpu.createJob(tip);

  job.refresh();

  if (ignoreClaims)
    node.mempool.claims = backupClaims;

  const block = await job.mineAsync();
  const entry = await chain.add(block);

  if (blockWait)
    await forBlock;

  return [block, entry];
}
