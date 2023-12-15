'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const NodeContext = require('./util/node-context');

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

// TODO: Rewrite using util/node from the interactive rescan test.
// TODO: Add the standalone Wallet variation.
// TODO: Add initial rescan test.

describe('Wallet rescan', function() {
  const network = Network.get('regtest');

  describe('Deadlock', function() {
    const nodeCtx = new NodeContext({
      memory: true,
      network: 'regtest',
      wallet: true
    });

    let address, node, wdb;

    before(async () => {
      node = nodeCtx.node;
      wdb = nodeCtx.wdb;

      await nodeCtx.open();
      address = await wdb.primary.receiveAddress();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should generate 10 blocks', async () => {
      await node.rpc.generateToAddress([10, address.toString(network)]);
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
