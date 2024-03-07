'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Address = require('../lib/primitives/address');
const HDPublicKey = require('../lib/hd/public');
const NodesContext = require('./util/nodes-context');
const {forEvent, forEventCondition} = require('./util/common');
const {Balance, getWClientBalance, getBalance} = require('./util/balance');

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

const combinations = [
  { SPV: false, STANDALONE: false, name: 'Full/Plugin' },
  { SPV: false, STANDALONE: true, name: 'Full/Standalone' },
  { SPV: true, STANDALONE: false, name: 'SPV/Plugin' }
  // Not supported.
  // { SPV: true, STANDALONE: true, name: 'SPV/Standalone' }
];

const noSPVcombinations = combinations.filter(c => !c.SPV);
const regtest = Network.get('regtest');

describe('Wallet rescan/addBlock', function() {
  for (const {SPV, STANDALONE, name} of noSPVcombinations) {
  describe(`rescan/addBlock gapped addresses (${name} Integration)`, function() {
    this.timeout(5000);
    const TEST_LOOKAHEAD = 20;

    const MAIN = 0;
    const TEST_ADDBLOCK = 1;
    const TEST_RESCAN = 2;

    const WALLET_NAME = 'test';
    const ACCOUNT = 'default';

    const regtest = Network.get('regtest');

    /** @type {NodesContext} */
    let nodes;
    let minerWallet, minerAddress;
    let main, addBlock, rescan;

    before(async () => {
      // Initial node is the one that progresses the network.
      nodes = new NodesContext(regtest, 1);
      // MAIN_WALLET = 0
      nodes.init({
        wallet: true,
        standalone: true,
        memory: true,
        noDNS: true
      });

      // Add the testing node.
      // TEST_ADDBLOCK = 1
      nodes.addNode({
        spv: SPV,
        wallet: true,
        memory: true,
        standalone: STANDALONE,
        noDNS: true
      });

      // Add the rescan test node.
      // TEST_RESCAN = 2
      nodes.addNode({
        spv: SPV,
        wallet: true,
        memory: true,
        standalone: STANDALONE,
        noDNS: true
      });

      await nodes.open();

      const mainWClient = nodes.context(MAIN).wclient;
      minerWallet = nodes.context(MAIN).wclient.wallet('primary');
      minerAddress = (await minerWallet.createAddress('default')).address;

      const mainWallet = await mainWClient.createWallet(WALLET_NAME, {
        lookahead: TEST_LOOKAHEAD
      });
      assert(mainWallet);

      const master = await mainWClient.getMaster(WALLET_NAME);

      const addBlockWClient = nodes.context(TEST_ADDBLOCK).wclient;
      const addBlockWalletResult = await addBlockWClient.createWallet(WALLET_NAME, {
        lookahead: TEST_LOOKAHEAD,
        mnemonic: master.mnemonic.phrase
      });
      assert(addBlockWalletResult);

      const rescanWClient = nodes.context(TEST_RESCAN).wclient;
      const rescanWalletResult = await rescanWClient.createWallet(WALLET_NAME, {
        lookahead: TEST_LOOKAHEAD,
        mnemonic: master.mnemonic.phrase
      });
      assert(rescanWalletResult);

      main = {};
      main.client = mainWClient.wallet(WALLET_NAME);
      await main.client.open();
      main.wdb = nodes.context(MAIN).wdb;

      addBlock = {};
      addBlock.client = addBlockWClient.wallet(WALLET_NAME);
      await addBlock.client.open();
      addBlock.wdb = nodes.context(TEST_ADDBLOCK).wdb;

      rescan = {};
      rescan.client = rescanWClient.wallet(WALLET_NAME);
      await rescan.client.open();
      rescan.wdb = nodes.context(TEST_RESCAN).wdb;

      await nodes.generate(MAIN, 10, minerAddress);
    });

    after(async () => {
      await nodes.close();
      await nodes.destroy();
    });

    // Prepare for the rescan and addBlock tests.
    it('should send gapped txs on each block', async () => {
      const expectedRescanBalance = await getBalance(main.client, ACCOUNT);
      const height = nodes.height(MAIN);
      const blocks = 5;

      // 1 address per block, all of them gapped.
      // Start after first gap, make sure rescan has no clue.
      const all = await generateGappedAddresses(main.client, blocks + 1, regtest);
      await deriveAddresses(main.client, all[all.length - 1].depth);
      const addresses = all.slice(1);
      // give addBlock first address.
      await deriveAddresses(addBlock.client, addresses[0].depth - TEST_LOOKAHEAD);

      const condFn = entry => entry.height === blocks + height;
      const mainWalletBlocks = forEventCondition(main.wdb, 'block connect', condFn);
      const addBlockWalletBlocks = forEventCondition(addBlock.wdb, 'block connect', condFn);
      const rescanWalletBlocks = forEventCondition(rescan.wdb, 'block connect', condFn);

      for (let i = 0; i < blocks; i++) {
        await minerWallet.send({
          outputs: [{
            address: addresses[i].address.toString(regtest),
            value: 1e6
          }]
        });

        await nodes.generate(MAIN, 1, minerAddress);
      }

      await Promise.all([
        mainWalletBlocks,
        addBlockWalletBlocks,
        rescanWalletBlocks
      ]);

      const rescanBalance = await getBalance(rescan.client, ACCOUNT);
      assert.deepStrictEqual(rescanBalance, expectedRescanBalance);
      // before the rescan test.
      await deriveAddresses(rescan.client, addresses[0].depth - TEST_LOOKAHEAD);
    });

    it('should receive gapped txs on each block (addBlock)', async () => {
      const expectedBalance = await getBalance(main.client, ACCOUNT);
      const addBlockBalance = await getBalance(addBlock.client, ACCOUNT);
      assert.deepStrictEqual(addBlockBalance, expectedBalance);

      const mainInfo = await main.client.getAccount(ACCOUNT);
      const addBlockInfo = await addBlock.client.getAccount(ACCOUNT);
      assert.deepStrictEqual(addBlockInfo, mainInfo);
    });

    it('should receive gapped txs on each block (rescan)', async () => {
      const expectedBalance = await getBalance(main.client, ACCOUNT);
      const expectedInfo = await main.client.getAccount(ACCOUNT);

      // give rescan first address.
      await rescan.wdb.rescan(0);

      const rescanBalance = await getBalance(rescan.client, ACCOUNT);
      assert.deepStrictEqual(rescanBalance, expectedBalance);

      const rescanInfo = await rescan.client.getAccount(ACCOUNT);
      assert.deepStrictEqual(rescanInfo, expectedInfo);
    });

    it('should send gapped txs in the same block', async () => {
      const expectedRescanBalance = await getBalance(rescan.client, ACCOUNT);
      const txCount = 5;

      const all = await generateGappedAddresses(main.client, txCount + 1, regtest);
      await deriveAddresses(main.client, all[all.length - 1].depth);
      const addresses = all.slice(1);

      // give addBlock first address.
      await deriveAddresses(addBlock.client, addresses[0].depth - TEST_LOOKAHEAD);

      const mainWalletBlocks = forEvent(main.wdb, 'block connect');
      const addBlockWalletBlocks = forEvent(addBlock.wdb, 'block connect');
      const rescanWalletBlocks = forEvent(rescan.wdb, 'block connect');

      for (const {address} of addresses) {
        await minerWallet.send({
          outputs: [{
            address: address.toString(regtest),
            value: 1e6
          }]
        });
      }

      await nodes.generate(MAIN, 1, minerAddress);

      await Promise.all([
        mainWalletBlocks,
        addBlockWalletBlocks,
        rescanWalletBlocks
      ]);

      const rescanBalance = await getBalance(rescan.client, ACCOUNT);
      assert.deepStrictEqual(rescanBalance, expectedRescanBalance);

      await deriveAddresses(rescan.client, addresses[0].depth - TEST_LOOKAHEAD);
    });

    it.skip('should receive gapped txs in the same block (addBlock)', async () => {
      const expectedBalance = await getBalance(main.client, ACCOUNT);
      const addBlockBalance = await getBalance(addBlock.client, ACCOUNT);
      assert.deepStrictEqual(addBlockBalance, expectedBalance);

      const mainInfo = await main.client.getAccount(ACCOUNT);
      const addBlockInfo = await addBlock.client.getAccount(ACCOUNT);
      assert.deepStrictEqual(addBlockInfo, mainInfo);
    });

    it('should receive gapped txs in the same block (rescan)', async () => {
      const expectedBalance = await getBalance(main.client, ACCOUNT);
      const expectedInfo = await main.client.getAccount(ACCOUNT);

      await rescan.wdb.rescan(0);

      const rescanBalance = await getBalance(rescan.client, ACCOUNT);
      assert.deepStrictEqual(rescanBalance, expectedBalance);

      const rescanInfo = await rescan.client.getAccount(ACCOUNT);
      assert.deepStrictEqual(rescanInfo, expectedInfo);
    });

    it('should send gapped outputs in the same tx', async () => {
      const expectedRescanBalance = await getBalance(rescan.client, ACCOUNT);
      const outCount = 5;

      const all = await generateGappedAddresses(main.client, outCount + 1, regtest);
      await deriveAddresses(main.client, all[all.length - 1].depth);
      const addresses = all.slice(1);

      // give addBlock first address.
      await deriveAddresses(addBlock.client, addresses[0].depth - TEST_LOOKAHEAD);

      const mainWalletBlocks = forEvent(main.wdb, 'block connect');
      const addBlockWalletBlocks = forEvent(addBlock.wdb, 'block connect');
      const rescanWalletBlocks = forEvent(rescan.wdb, 'block connect');

      const outputs = addresses.map(({address}) => ({
        address: address.toString(regtest),
        value: 1e6
      }));

      await minerWallet.send({outputs});
      await nodes.generate(MAIN, 1, minerAddress);

      await Promise.all([
        mainWalletBlocks,
        addBlockWalletBlocks,
        rescanWalletBlocks
      ]);

      const rescanBalance = await getBalance(rescan.client, ACCOUNT);
      assert.deepStrictEqual(rescanBalance, expectedRescanBalance);

      await deriveAddresses(rescan.client, addresses[0].depth - TEST_LOOKAHEAD);
    });

    it.skip('should receive gapped outputs in the same tx (addBlock)', async () => {
      const expectedBalance = await getBalance(main.client, ACCOUNT);
      const addBlockBalance = await getBalance(addBlock.client, ACCOUNT);
      assert.deepStrictEqual(addBlockBalance, expectedBalance);

      const mainInfo = await main.client.getAccount(ACCOUNT);
      const addBlockInfo = await addBlock.client.getAccount(ACCOUNT);
      assert.deepStrictEqual(addBlockInfo, mainInfo);
    });

    it('should receive gapped outputs in the same tx (rescan)', async () => {
      const expectedBalance = await getBalance(main.client, ACCOUNT);
      const expectedInfo = await main.client.getAccount(ACCOUNT);

      await rescan.wdb.rescan(0);

      const rescanBalance = await getBalance(rescan.client, ACCOUNT);
      assert.deepStrictEqual(rescanBalance, expectedBalance);

      const rescanInfo = await rescan.client.getAccount(ACCOUNT);
      assert.deepStrictEqual(rescanInfo, expectedInfo);
    });
  });
  }

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
    let testWallet, testAddress;

    before(async () => {
      nodes = new NodesContext(regtest, 1);

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

      testWallet = wnodeCtx.wclient.wallet('primary');
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

      wnodeCtx.init();

      const eventsToWait = [];
      // For spv we don't wait for sync done, as it will do the full rescan
      // and reset the SPVNode as well. It does not depend on the accumulated
      // blocks.
      if (SPV) {
        // This will happen right away, as scan will just call reset
        eventsToWait.push(forEvent(wnodeCtx.wdb, 'sync done'));
        // This is what matters for the rescan.
        eventsToWait.push(forEventCondition(wnodeCtx.wdb, 'block connect', (entry) => {
          return entry.height === nodes.height(MINER);
        }));
          // Make sure node gets resets.
        eventsToWait.push(forEvent(wnodeCtx.node, 'reset'));
      } else {
        eventsToWait.push(forEvent(wnodeCtx.wdb, 'sync done'));
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
      const eventsToWait = [];

      if (SPV) {
        // This will happen right away, as scan will just call reset
        eventsToWait.push(forEvent(wnodeCtx.wdb, 'sync done'));

        // This is what matters for the rescan.
        eventsToWait.push(forEventCondition(wnodeCtx.wdb, 'block connect', (entry) => {
          return entry.height === nodes.height(MINER);
        }));

        // Make sure node gets resets.
        eventsToWait.push(forEvent(wnodeCtx.node, 'reset'));
        eventsToWait.push(forEvent(wnodeCtx.wdb, 'unconfirmed'));
      } else {
        eventsToWait.push(forEvent(wnodeCtx.wdb, 'sync done'));
        eventsToWait.push(forEvent(wnodeCtx.wdb, 'unconfirmed'));
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

    it('should rescan/resync after wallet was off and received gapped txs in the same block', async () => {
      if (SPV)
        this.skip();

      const txCount = 5;
      await wnodeCtx.open();
      const startingBalance = await getBalance(testWallet, 'default');
      const all = await generateGappedAddresses(testWallet, txCount, regtest);
      await wnodeCtx.close();

      await noWnodeCtx.open();

      for (const {address} of all) {
        await minerWallet.send({
          outputs: [{
            address: address.toString(regtest),
            value: 1e6
          }]
        });
      }

      const waitHeight = nodes.height(MINER) + 1;
      const nodeSync = forEventCondition(noWnodeCtx.node, 'connect', (entry) => {
        return entry.height === waitHeight;
      });

      await nodes.generate(MINER, 1, minerAddress);

      await nodeSync;
      await noWnodeCtx.close();

      wnodeCtx.init();

      const syncDone = forEvent(wnodeCtx.wdb, 'sync done');
      await wnodeCtx.open();
      await syncDone;
      assert.strictEqual(wnodeCtx.wdb.height, nodes.height(MINER));

      const balance = await getBalance(testWallet, 'default');
      const diff = balance.diff(startingBalance);
      assert.deepStrictEqual(diff, new Balance({
        tx: txCount,
        coin: txCount,
        confirmed: 1e6 * txCount,
        unconfirmed: 1e6 * txCount
      }));

      await wnodeCtx.close();
    });

    it('should rescan/resync after wallet was off and received gapped coins in the same tx', async () => {
      if (SPV)
        this.skip();

      const outCount = 5;
      await wnodeCtx.open();
      const startingBalance = await getBalance(testWallet, 'default');
      const all = await generateGappedAddresses(testWallet, outCount, regtest);
      await wnodeCtx.close();

      await noWnodeCtx.open();

      const outputs = all.map(({address}) => ({
        address: address.toString(regtest),
        value: 1e6
      }));

      await minerWallet.send({outputs});

      const waitHeight = nodes.height(MINER) + 1;
      const nodeSync = forEventCondition(noWnodeCtx.node, 'connect', (entry) => {
        return entry.height === waitHeight;
      });

      await nodes.generate(MINER, 1, minerAddress);

      await nodeSync;
      await noWnodeCtx.close();

      wnodeCtx.init();

      const syncDone = forEvent(wnodeCtx.wdb, 'sync done');
      await wnodeCtx.open();
      await syncDone;
      assert.strictEqual(wnodeCtx.wdb.height, nodes.height(MINER));

      const balance = await getBalance(testWallet, 'default');
      const diff = balance.diff(startingBalance);
      assert.deepStrictEqual(diff, new Balance({
        tx: 1,
        coin: outCount,
        confirmed: 1e6 * outCount,
        unconfirmed: 1e6 * outCount
      }));

      await wnodeCtx.close();
    });
  });
  }

  for (const {STANDALONE, name} of noSPVcombinations) {
  describe(`Deadlock (${name} Integration)`, function() {
    this.timeout(10000);
    const nodes = new NodesContext(regtest, 1);
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
      }, 5000);

      const wdbBlocks = forEventCondition(wdb, 'block connect', (entry) => {
        return entry.height === BLOCKS;
      }, 5000);

      await minerCtx.mineBlocks(BLOCKS, address);
      await Promise.all([
        chainBlocks,
        wdbBlocks
      ]);
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

      // abort should also report reason as an error.
      const errorEvents = forEvent(wdb, 'error', 1);

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

      const errors = await errorEvents;
      assert.strictEqual(errors.length, 1);
      const errEv = errors[0].values[0];
      assert(errEv);
      assert.strictEqual(errEv.message, 'Cannot rescan an alternate chain.');

      await mineBlocks;
    });
  });
  }
});

async function deriveAddresses(walletClient, depth) {
  const accInfo = await walletClient.getAccount('default');
  let currentDepth = accInfo.receiveDepth;

  if (depth <= currentDepth)
    return;

  while (currentDepth !== depth) {
    const addr = await walletClient.createAddress('default');
    currentDepth = addr.index;
  }
}

async function getAddress(walletClient, depth = -1, network = regtest) {
  const accInfo = await walletClient.getAccount('default');
  const {accountKey, lookahead} = accInfo;

  if (depth === -1)
    depth = accInfo.receiveDepth;

  const XPUBKey = HDPublicKey.fromBase58(accountKey, network);
  const key = XPUBKey.derive(0).derive(depth).publicKey;
  const address = Address.fromPubkey(key);

  const gappedDepth = depth + lookahead + 1;
  return {address, depth, gappedDepth};
}

async function generateGappedAddresses(walletClient, count, network = regtest) {
  let depth = -1;

  const addresses = [];

  // generate gapped addresses.
  for (let i = 0; i < count; i++) {
    const addrInfo = await getAddress(walletClient, depth, network);

    addresses.push({
      address: addrInfo.address,
      depth: addrInfo.depth,
      gappedDepth: addrInfo.gappedDepth
    });

    depth = addrInfo.gappedDepth;
  }

  return addresses;
}
