'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const Network = require('../lib/protocol/network');
const {ownership} = require('../lib/covenants/ownership');
const rules = require('../lib/covenants/rules');
const {states} = require('../lib/covenants/namestate');
const {Resource} = require('../lib/dns/resource');
const {forEvent} = require('./util/common');
const {CachedStubResolver, STUB_SERVERS} = require('./util/stub');
const NodeContext = require('./util/node-context');

const network = Network.get('regtest');
const {
  treeInterval,
  claimPeriod,
  renewalWindow
} = network.names;

const ACTUAL_CLAIM_PERIOD = claimPeriod;
const ACTUAL_RENEWAL_WINDOW = renewalWindow;

describe('Mempool Invalidation', function() {
  const originalResolver = ownership.Resolver;
  const originalServers = ownership.servers;

  before(() => {
    ownership.Resolver = CachedStubResolver;
    ownership.servers = STUB_SERVERS;
  });

  after(() => {
    ownership.Resolver = originalResolver;
    ownership.servers = originalServers;
  });

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

  describe('Covenant invalidation (Integration)', function() {
    this.timeout(3000);
    let nodeCtx;
    let node, wallet, wallet2;

    const getNameState = async (name) => {
      const ns = await nodeCtx.chain.db.getNameStateByName(name);

      if (!ns)
        return null;

      return ns.state(nodeCtx.chain.tip.height + 1, network);
    };

    const isExpired = async (name) => {
      const ns = await nodeCtx.chain.db.getNameStateByName(name);

      if (!ns)
        return true;

      return ns.isExpired(nodeCtx.chain.tip.height + 1, network);
    };

    before(async () => {
      network.names.renewalWindow = 200;

      nodeCtx = new NodeContext({
        network: 'regtest',
        memory: true,
        wallet: true
      });

      await nodeCtx.open();

      node = nodeCtx.node;

      const wdb = nodeCtx.wdb;
      wallet = await wdb.get('primary');
      wallet2 = await wdb.create({
        id: 'secondary'
      });

      const addr = await wallet.receiveAddress('default');
      node.miner.addAddress(addr.toString());

      for (let i = 0; i < treeInterval; i++)
        await mineBlock(node);

      const fundTX = forEvent(nodeCtx.mempool, 'tx', 1, 2000);
      const w2addr = (await wallet2.receiveAddress('default')).toString();

      await wallet.send({
        outputs: [{
          address: w2addr,
          value: 10e6
        }, {
          address: w2addr,
          value: 10e6
        }, {
          address: w2addr,
          value: 10e6
        }]
      });

      await fundTX;
      await mineBlock(node);
    });

    after(async () => {
      network.names.renewalWindow = ACTUAL_RENEWAL_WINDOW;
      await nodeCtx.close();
      await nodeCtx.destroy();
    });

    it('should invalidate opens', async () => {
      // This is handled in remove Double Opens on addBlock.
      assert.strictEqual(node.mempool.map.size, 0);

      const name = rules.grindName(10, 0, network);

      const txEvents = forEvent(node.mempool, 'tx', 1, 2000);

      const blkopen = await wallet.createOpen(name);
      await wallet.sign(blkopen);

      const memopen = await wallet2.sendOpen(name);
      await txEvents;

      assert(node.mempool.map.has(memopen.hash()));
      assert.strictEqual(node.mempool.map.size, 1);

      assert.strictEqual(await getNameState(name), null);

      {
        const tx = blkopen.commit();
        await mineBlock(node, {
          empty: true,
          txs: [tx]
        });
      }

      assert.strictEqual(await getNameState(name), states.OPENING);

      assert.strictEqual(node.mempool.map.size, 0);
      const pending = await wallet2.getPending();
      assert.strictEqual(pending.length, 0);
    });

    it('should invalidate bids', async () => {
      assert.strictEqual(node.mempool.map.size, 0);

      const name = rules.grindName(10, 0, network);
      const txEvent = forEvent(node.mempool, 'tx', 1, 2000);
      await wallet.sendOpen(name);
      await txEvent;

      for (let i = 0; i < treeInterval + 1; i++)
        await mineBlock(node);

      assert.strictEqual(await getNameState(name), states.BIDDING);

      const txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      const bid1 = await wallet2.sendBid(name, 1e6, 1e6);
      const bid2 = await wallet.sendBid(name, 1e6, 1e6);
      await txEvents;

      assert.strictEqual(node.mempool.map.size, 2);

      // leave 2 blocks, 1 for bid inclusion another for ending bidding period.
      for (let i = 0; i < network.names.biddingPeriod - 2; i++)
        await mineBlock(node, { empty: true });

      assert.strictEqual(node.mempool.map.size, 2);
      assert.strictEqual(await getNameState(name), states.BIDDING);

      {
        // this one finally ends the bidding period.
        await mineBlock(node, {
          empty: true,
          txs: [[bid1]]
        });
      }

      assert(node.mempool.map.has(bid2.hash()));
      assert.strictEqual(node.mempool.map.size, 1);

      await mineBlock(node, { empty: true });
      assert.strictEqual(node.mempool.map.size, 0);
      assert.strictEqual(await getNameState(name), states.REVEAL);

      await wallet.abandon(bid2.hash());
    });

    it('should invalidate reveals', async () => {
      let txEvents;
      assert.strictEqual(node.mempool.map.size, 0);

      const name = rules.grindName(10, 0, network);

      await wallet.sendOpen(name);

      for (let i = 0; i < treeInterval + 1; i++)
        await mineBlock(node);

      txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      await wallet.sendBid(name, 1e6, 1e6);
      await wallet2.sendBid(name, 1e6, 1e6);
      await txEvents;

      assert.strictEqual(node.mempool.map.size, 2);

      for (let i = 0; i < network.names.biddingPeriod; i++)
        await mineBlock(node);

      assert.strictEqual(node.mempool.map.size, 0);
      assert.strictEqual(await getNameState(name), states.REVEAL);

      txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      const reveal1 = await wallet.sendReveal(name);
      const reveal2 = await wallet2.sendReveal(name);
      await txEvents;

      assert.strictEqual(node.mempool.map.size, 2);
      assert.strictEqual(await getNameState(name), states.REVEAL);

      for (let i = 0; i < network.names.revealPeriod - 1; i++)
        await mineBlock(node, { empty: true });

      // include only one in the last block.
      await mineBlock(node, {
        empty: true,
        txs: [[reveal2]]
      });

      assert.strictEqual(await getNameState(name), states.CLOSED);
      assert.strictEqual(node.mempool.map.size, 0);
      await wallet.abandon(reveal1.hash());
    });

    it('should invalidate reveals with expire', async () => {
      let txEvents;
      assert.strictEqual(node.mempool.map.size, 0);

      const name = rules.grindName(10, 0, network);

      await wallet.sendOpen(name);

      for (let i = 0; i < treeInterval + 1; i++)
        await mineBlock(node);

      txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      await wallet.sendBid(name, 1e6, 1e6);
      await wallet2.sendBid(name, 1e6, 1e6);
      await txEvents;

      assert.strictEqual(node.mempool.map.size, 2);

      for (let i = 0; i < network.names.biddingPeriod; i++)
        await mineBlock(node);

      assert.strictEqual(node.mempool.map.size, 0);
      assert.strictEqual(await getNameState(name), states.REVEAL);

      txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      await wallet.sendReveal(name);
      await wallet2.sendReveal(name);
      await txEvents;

      assert.strictEqual(node.mempool.map.size, 2);
      assert.strictEqual(await getNameState(name), states.REVEAL);

      for (let i = 0; i < network.names.revealPeriod; i++)
        await mineBlock(node, { empty: true });

      assert.strictEqual(await getNameState(name), states.CLOSED);
      assert.strictEqual(node.mempool.map.size, 0);
    });

    it('should invalidate updates when name expires', async () => {
      let txEvents;

      assert.strictEqual(node.mempool.map.size, 0);
      const name = rules.grindName(10, 0, network);

      await wallet.sendOpen(name);

      for (let i = 0; i < treeInterval + 1; i++)
        await mineBlock(node);

      txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      await wallet.sendBid(name, 1e6, 1e6);
      await wallet2.sendBid(name, 1e6, 1e6);
      await txEvents;

      assert.strictEqual(node.mempool.map.size, 2);

      for (let i = 0; i < network.names.biddingPeriod; i++)
        await mineBlock(node);

      assert.strictEqual(node.mempool.map.size, 0);
      assert.strictEqual(await getNameState(name), states.REVEAL);

      txEvents = forEvent(node.mempool, 'tx', 2, 2000);
      await wallet.sendReveal(name);
      await wallet2.sendReveal(name);
      await txEvents;

      for (let i = 0; i < network.names.revealPeriod; i++)
        await mineBlock(node);

      assert.strictEqual(await getNameState(name), states.CLOSED);

      await wallet.sendUpdate(name, Resource.fromJSON({ records: [] }));

      for (let i = 0; i < network.names.renewalWindow - 2; i++)
        await mineBlock(node);

      txEvents = forEvent(node.mempool, 'tx', 1, 2000);
      await wallet.sendRenewal(name);
      await txEvents;
      assert.strictEqual(node.mempool.map.size, 1);

      assert.strictEqual(await getNameState(name), states.CLOSED);
      assert.strictEqual(await isExpired(name), false);

      await mineBlock(node, { empty: true });
      assert.strictEqual(node.mempool.map.size, 1);
      assert.strictEqual(await isExpired(name), false);
      await mineBlock(node, { empty: true });
      assert.strictEqual(await isExpired(name), true);
      assert.strictEqual(node.mempool.map.size, 0);
    });
  });

  describe('Claim Invalidation (Integration)', function() {
    this.timeout(50000);

    let nodeCtx;
    let node, wallet;

    // copy names
    const TEST_CLAIMS = NAMES.slice();

    before(async () => {
      nodeCtx = new NodeContext({
        network: network.type,
        memory: true,
        wallet: true
      });

      await nodeCtx.open();
      node = nodeCtx.node;

      // Ignore claim validation
      ownership.ignore = true;

      const wdb = nodeCtx.wdb;
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

      await nodeCtx.close();
      await nodeCtx.destroy();
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

    let nodeCtx;
    let node, wallet;

    // copy names
    const TEST_CLAIMS = NAMES.slice();

    before(async () => {
      nodeCtx = new NodeContext({
        network: network.type,
        memory: true,
        wallet: true
      });

      await nodeCtx.open();

      // Ignore claim validation
      ownership.ignore = true;

      node = nodeCtx.node;
      const wdb = nodeCtx.wdb;
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

      await nodeCtx.close();
      await nodeCtx.destroy();
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
  const empty = opts.empty ?? false;
  const txs = opts.txs ?? [];

  let forBlock = null;

  if (blockWait)
    forBlock = forEvent(node, 'block', 1, 2000);

  let backupClaims = null;
  let backupTXs = null;

  if (ignoreClaims) {
    backupClaims = node.mempool.claims;
    node.mempool.claims = new BufferMap();
  }

  if (empty) {
    backupTXs = node.mempool.map;
    node.mempool.map = new BufferMap();
  }

  const job = await miner.cpu.createJob(tip);

  for (const [tx, view] of txs)
    job.pushTX(tx, view);

  job.refresh();

  if (ignoreClaims)
    node.mempool.claims = backupClaims;

  if (empty)
    node.mempool.map = backupTXs;

  const block = await job.mineAsync();
  const entry = await chain.add(block);

  if (blockWait)
    await forBlock;

  return [block, entry];
}
