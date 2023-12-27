'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const NodesContext = require('./util/nodes-context');
const NodeContext = require('./util/node-context');
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

  describe('Deadlock', function() {
    const nodeCtx = new NodeContext({
      memory: true,
      network: 'regtest',
      wallet: true
    });

    let address, node, wdb;

    before(async () => {
      nodeCtx.init();

      node = nodeCtx.node;
      wdb = nodeCtx.wdb;

      await nodeCtx.open();
      address = await wdb.primary.receiveAddress();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should generate 10 blocks', async () => {
      await nodeCtx.mineBlocks(10, address);
    });

    it('should rescan when receiving a block', async () => {
      const preTip = await wdb.getTip();

      await Promise.all([
        node.rpc.generateToAddress([1, address.toString(network)]),
        wdb.rescan(0)
      ]);

      const wdbTip = await wdb.getTip();
      assert.strictEqual(wdbTip.height, preTip.height + 1);
    });

    it('should rescan when receiving a block', async () => {
      const preTip = await wdb.getTip();

      await Promise.all([
        wdb.rescan(0),
        node.rpc.generateToAddress([1, address.toString(network)])
      ]);

      const tip = await wdb.getTip();
      assert.strictEqual(tip.height, preTip.height + 1);
    });
  });
});
