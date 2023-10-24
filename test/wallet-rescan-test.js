'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const WalletPlugin = require('../lib/wallet/plugin');
const Network = require('../lib/protocol/network');
const {forEvent} = require('./util/common');

// TODO: Rewrite using util/node from the interactive rescan test.
// TODO: Add the standalone Wallet variation.
// TODO: Add initial rescan test.

describe('Wallet rescan', function() {
  const network = Network.get('regtest');

  let node, wdb;

  const beforeAll = async () => {
    node = new FullNode({
      memory: true,
      network: 'regtest',
      plugins: [WalletPlugin]
    });

    node.on('error', (err) => {
      assert(false, err);
    });

    wdb = node.require('walletdb').wdb;
    const wdbSynced = forEvent(wdb, 'sync done');

    await node.open();
    await wdbSynced;
  };

  const afterAll = async () => {
    await node.close();
    node = null;
    wdb = null;
  };

  describe('Deadlock', function() {
    let address;

    before(async () => {
      await beforeAll();

      address = await wdb.primary.receiveAddress();
    });

    after(afterAll);

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
