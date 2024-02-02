'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const NodesContext = require('./util/nodes-context');
const {forEvent, forEventCondition} = require('./util/common');
const {Balance, getWClientBalance} = require('./util/balance');

// Definitions:
//  Gapped txs/addresses - addresses with lookahead + 1 gap when deriving.
//
// Setup:
//  - Standalone Node (no wallet) responsible for progressing network.
//  - Wallet Node (with wallet) responsible for rescanning.
//  - Wallet SPV Node (with wallet) responsible for rescanning.
//  - Wallet Standalone Node responsible for rescanning.
//  - Wallet SPV Standalone Node responsible for rescanning.
//
// Test cases:
//  - TX deeper depth -> TX shallower depth for derivation (Second tx is discovered first)
//  - TX with outputs -> deeper, deep, shallow - derivation depths.
//    (Outputs are discovered from shallower to deeper)
//  - Replicate both transactions in the same block on rescan.
//  - Replicate both transactions when receiving tip.
//
// If per block derivation lookahead is higher than wallet lookahed
// recovery is impossible. This tests situation where in block
// derivation depth is lower than wallet lookahead.

// TODO: Add the standalone Wallet variation.
// TODO: Add initial rescan test.

const combinations = [
  { SPV: false, STANDALONE: false, name: 'Full/Plugin' },
  { SPV: false, STANDALONE: true, name: 'Full/Standalone' },
  { SPV: true, STANDALONE: false, name: 'SPV/Plugin' }
  // Not supported.
  // { SPV: true, STANDALONE: true, name: 'SPV/Standalone' }
];

const noSPVcombinations = combinations.filter(c => !c.SPV);

describe('Wallet rescan', function() {
  const network = Network.get('regtest');

  for (const {SPV, STANDALONE, name} of combinations) {
  describe(`Initial sync/rescan (${name} Integration)`, function() {
    // Test wallet plugin/standalone is disabled and re-enabled after some time:
    //   1. Normal received blocks.
    //   2. Reorged after wallet was closed.
    // NOTE: Node is not closed, only wallet.

    const MINER = 0;
    const WALLET = 1;
    const WALLET_NO_WALLET = 2;

    /** @type {NodesContext} */
    let nodes;
    let wnodeCtx, noWnodeCtx;
    let minerWallet, minerAddress;
    let testAddress;

    before(async () => {
      nodes = new NodesContext(network, 1);

      // MINER = 0
      nodes.init({
        wallet: true,
        noDNS: true,
        bip37: true
      });

      // WALLET = 1
      wnodeCtx = nodes.addNode({
        noDNS: true,
        wallet: true,

        standalone: STANDALONE,
        spv: SPV,

        // We need to store on disk in order to test
        // recovery on restart
        memory: false
      });

      // WALLET_NO_WALLET = 2
      // Wallet node that uses same chain above one
      // just does not start wallet.
      noWnodeCtx = nodes.addNode({
        noDNS: true,
        wallet: false,
        prefix: wnodeCtx.prefix,
        memory: false,
        spv: SPV
      });

      // only open two at a time.
      await nodes.open(MINER);
      await nodes.open(WALLET);

      minerWallet = nodes.context(MINER).wclient.wallet('primary');
      minerAddress = (await minerWallet.createAddress('default')).address;

      const testWallet = wnodeCtx.wclient.wallet('primary');
      testAddress = (await testWallet.createAddress('default')).address;

      await nodes.close(WALLET);
    });

    after(async () => {
      await nodes.close();
      await nodes.destroy();
    });

    afterEach(async () => {
      await nodes.close(WALLET);
      await nodes.close(WALLET_NO_WALLET);
    });

    it('should fund and spend to wallet', async () => {
      await wnodeCtx.open();

      const txEvent = forEvent(wnodeCtx.wdb, 'tx');

      // fund wallet.
      await nodes.generate(MINER, 9, minerAddress);

      // Send TX to the test wallet.
      await minerWallet.send({
        outputs: [{
          address: testAddress,
          value: 1e6
        }]
      });

      await nodes.generate(MINER, 1, minerAddress);
      await txEvent;

      const balance = await getWClientBalance(wnodeCtx.wclient, 'primary', 'default');
      assert.deepStrictEqual(balance, new Balance({
        coin: 1,
        tx: 1,
        confirmed: 1e6,
        unconfirmed: 1e6
      }));
    });

    it('should rescan/resync after wallet was off', async () => {
      // replace wallet node with new one w/o wallet.
      await noWnodeCtx.open();

      await nodes.generate(MINER, 10, minerAddress);

      // Mine in the last block that we will be reorging.
      await minerWallet.send({
        outputs: [{
          address: testAddress,
          value: 2e6
        }]
      });

      const waitHeight = nodes.height(MINER) + 1;
      const nodeSync = forEventCondition(noWnodeCtx.node, 'connect', (entry) => {
        return entry.height === waitHeight;
      });

      await nodes.generate(MINER, 1, minerAddress);
      await nodeSync;

      // Disable wallet
      await noWnodeCtx.close();

      // sync node.
      let eventsToWait;

      wnodeCtx.init();

      // For spv we don't wait for sync done, as it will do the full rescan
      // and reset the SPVNode as well. It does not depend on the accumulated
      // blocks.
      if (SPV) {
        eventsToWait = [
          // This will happen right away, as scan will just call reset
          forEvent(wnodeCtx.wdb, 'sync done'),
          // This is what matters for the rescan.
          forEventCondition(wnodeCtx.wdb, 'block connect', (entry) => {
            return entry.height === nodes.height(MINER);
          }),
          // Make sure node gets resets.
          forEvent(wnodeCtx.node, 'reset')
        ];
      } else {
        eventsToWait = [
          forEvent(wnodeCtx.wdb, 'sync done')
        ];
      }

      await wnodeCtx.open();
      await Promise.all(eventsToWait);
      assert.strictEqual(wnodeCtx.wdb.height, nodes.height(MINER));

      const balance = await getWClientBalance(wnodeCtx.wclient, 'primary', 'default');
      assert.deepStrictEqual(balance, new Balance({
        coin: 2,
        tx: 2,
        confirmed: 1e6 + 2e6,
        unconfirmed: 1e6 + 2e6
      }));

      await wnodeCtx.close();
    });

    it('should rescan/resync after wallet was off and node reorged', async () => {
      const minerCtx = nodes.context(MINER);

      await noWnodeCtx.open();

      // Reorg the network
      const tip = minerCtx.chain.tip;
      const block = await minerCtx.chain.getBlock(tip.hash);

      // Last block contained our tx from previous test. (integration)
      assert.strictEqual(block.txs.length, 2);

      const reorgEvent = forEvent(minerCtx.node, 'reorganize');
      const forkTip = await minerCtx.chain.getPrevious(tip);

      // REORG
      await nodes.generate(MINER, 2, minerAddress, forkTip);
      // Reset mempool/Get rid of tx after reorg.
      await nodes.context(MINER).mempool.reset();
      await nodes.generate(MINER, 2, minerAddress);
      await reorgEvent;

      // Send another tx, with different output.
      await minerWallet.send({
        outputs: [{
          address: testAddress,
          value: 3e6
        }]
      });

      const waitHeight = nodes.height(MINER) + 1;
      const nodeSync = forEventCondition(noWnodeCtx.node, 'connect', (entry) => {
        return entry.height === waitHeight;
      });

      await nodes.generate(MINER, 1, minerAddress);
      await nodeSync;

      await noWnodeCtx.close();

      wnodeCtx.init();

      // initial sync
      let eventsToWait;
      if (SPV) {
        eventsToWait = [
          // This will happen right away, as scan will just call reset
          forEvent(wnodeCtx.wdb, 'sync done'),
          // This is what matters for the rescan.
          forEventCondition(wnodeCtx.wdb, 'block connect', (entry) => {
            return entry.height === nodes.height(MINER);
          }),
          // Make sure node gets resets.
          forEvent(wnodeCtx.node, 'reset'),
          forEvent(wnodeCtx.wdb, 'unconfirmed')
        ];
      } else {
        eventsToWait = [
          forEvent(wnodeCtx.wdb, 'sync done'),
          forEvent(wnodeCtx.wdb, 'unconfirmed')
        ];
      }
      await wnodeCtx.open();
      await Promise.all(eventsToWait);

      assert.strictEqual(wnodeCtx.height, nodes.height(MINER));
      assert.strictEqual(wnodeCtx.wdb.state.height, wnodeCtx.height);

      const balance = await getWClientBalance(wnodeCtx.wclient, 'primary', 'default');

      // previous transaction should get unconfirmed.
      assert.deepStrictEqual(balance, new Balance({
        coin: 3,
        tx: 3,
        confirmed: 1e6 + 3e6,
        unconfirmed: 1e6 + 2e6 + 3e6
      }));

      await wnodeCtx.close();
    });
  });
  }

  for (const {STANDALONE, name} of noSPVcombinations) {
  describe(`Deadlock (${name} Integration)`, function() {
    this.timeout(10000);
    const nodes = new NodesContext(network, 1);
    let minerCtx;
    let nodeCtx, address, node, wdb;

    before(async () => {
      nodes.init({
        memory: false,
        wallet: false
      });

      nodes.addNode({
        memory: false,
        wallet: true,
        standalone: STANDALONE
      });

      await nodes.open();

      minerCtx = nodes.context(0);
      nodeCtx = nodes.context(1);
      node = nodeCtx.node;
      wdb = nodeCtx.wdb;

      address = await wdb.primary.receiveAddress();
    });

    after(async () => {
      await nodes.close();
    });

    it('should generate 20 blocks', async () => {
      const BLOCKS = 20;
      const chainBlocks = forEventCondition(node.chain, 'connect', (entry) => {
        return entry.height === BLOCKS;
      });

      const wdbBlocks = forEventCondition(wdb, 'block connect', (entry) => {
        return entry.height === BLOCKS;
      });

      await minerCtx.mineBlocks(BLOCKS, address);
      await chainBlocks;
      await wdbBlocks;
    });

    it('should rescan when receiving a block', async () => {
      const preTip = await wdb.getTip();
      const blocks = forEventCondition(node.chain, 'connect', (entry) => {
        return entry.height === preTip.height + 5;
      });
      const wdbBlocks = forEventCondition(wdb, 'block connect', (entry) => {
        return entry.height === preTip.height + 5;
      });

      await Promise.all([
        minerCtx.mineBlocks(5, address),
        wdb.rescan(0)
      ]);

      await blocks;
      await wdbBlocks;

      const wdbTip = await wdb.getTip();
      assert.strictEqual(wdbTip.height, preTip.height + 5);
    });

    it('should rescan when receiving blocks', async () => {
      const preTip = await wdb.getTip();
      const minerHeight = minerCtx.height;
      const BLOCKS = 50;

      const blocks = forEventCondition(node.chain, 'connect', (entry) => {
        return entry.height === minerHeight + BLOCKS;
      });

      const wdbBlocks = forEventCondition(wdb, 'block connect', (entry) => {
        return entry.height === minerHeight + BLOCKS;
      });

      const promises = [
        minerCtx.mineBlocks(BLOCKS, address)
      ];

      await forEvent(node.chain, 'connect');
      promises.push(wdb.rescan(0));
      await Promise.all(promises);

      await blocks;
      await wdbBlocks;

      const tip = await wdb.getTip();

      assert.strictEqual(tip.height, preTip.height + BLOCKS);
    });

    it('should rescan when chain is reorging', async () => {
      const minerHeight = minerCtx.height;
      const BLOCKS = 50;
      const reorgHeight = minerHeight - 10;
      const newHeight = minerHeight + 40;

      const blocks = forEventCondition(node.chain, 'connect', (entry) => {
        return entry.height === newHeight;
      }, 10000);

      const walletBlocks = forEventCondition(wdb, 'block connect', (entry) => {
        return entry.height === newHeight;
      }, 10000);

      const reorgEntry = await minerCtx.chain.getEntry(reorgHeight);

      const promises = [
        minerCtx.mineBlocks(BLOCKS, address, reorgEntry)
      ];

      // We start rescan only after first disconnect is detected to ensure
      // wallet guard is set.
      await forEvent(node.chain, 'disconnect');
      promises.push(wdb.rescan(0));
      await Promise.all(promises);

      await blocks;
      await walletBlocks;

      const tip = await wdb.getTip();
      assert.strictEqual(tip.height, newHeight);
    });

    // Rescanning alternate chain.
    it('should rescan when chain is reorging (alternate chain)', async () => {
      const minerHeight = minerCtx.height;
      const BLOCKS = 50;
      const reorgHeight = minerHeight - 20;

      const reorgEntry = await minerCtx.chain.getEntry(reorgHeight);
      const mineBlocks = minerCtx.mineBlocks(BLOCKS, address, reorgEntry);

      // We start rescan only after first disconnect is detected to ensure
      // wallet guard is set.
      await forEvent(node.chain, 'disconnect');
      let err;
      try {
        // Because we are rescanning within the rescan blocks,
        // these blocks will end up in alternate chain, resulting
        // in error.
        await wdb.rescan(minerHeight - 5);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'Cannot rescan an alternate chain.');

      await mineBlocks;
    });
  });
  }
});
