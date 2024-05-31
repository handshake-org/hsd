'use strict';

const assert = require('bsert');
const {NodeClient, WalletClient} = require('../lib/client');
const {ownership} = require('../lib/covenants/ownership');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const {forEvent} = require('./util/common');
const chainCommon = require('../lib/blockchain/common');
const {BufferMap} = require('buffer-map');
const {thresholdStates} = chainCommon;
const {isReserved, isLockedUp, hashName} = require('../lib/covenants/rules');
const {CachedStubResolver, STUB_SERVERS} = require('./util/stub');

const SOFT_FORK_NAME = 'icannlockup';

const network = Network.get('regtest');
const deployments = network.deployments;
const activationThreshold = network.activationThreshold;
const minerWindow = network.minerWindow;

const ACTUAL_START = deployments[SOFT_FORK_NAME].startTime;
const ACTUAL_TIMEOUT = deployments[SOFT_FORK_NAME].timeout;
const ACTUAL_CLAIM_PERIOD = network.names.claimPeriod;
const ACTUAL_RENEWAL_WINDOW = network.names.renewalWindow;

/*
 * Test ICANN LOCKUP activation paths.
 * It includes test for bip9 activation for the
 * `icannlockup` soft fork - when it fails
 * and the names become auctionable as well
 * as the path where it succeeds and auctions
 * become illegal "forever".
 *   Soft-fork in regtest will be setup to activate after 3 windows and one
 * window for DEFINED -> STARTED state.
 * Soft-fork voting will only happen in 2 windows.
 * In regtest this means: 144 + 144 + 144 + 144 (4 window) blocks will be set
 * for claimPeriod end.
 * Soft forking period for: 144 + 144 (2 window) blocks.
 * Steps:
 *  - 144 defined
 *  - 144 + 144 started (Active voting)
 *  - 144 locked in or failed end of claim period.
 *
 * Test will run failure and success paths and make sure both give
 * results soft-fork expects:
 *  - on failure: names can be auctioned.
 *  - on success: root and top10k
 *  unauctionable via mempool and blocks, for those running
 *  the node with updated software.
 */

describe('BIP9 - ICANN lockup (integration)', function() {
  this.timeout(20000);

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

  const CUSTOM = [
    'cloudflare',
    'nlnetlabs',
    'dnscrypt'
  ];

  // Names from 10k alexa.
  const TOP10k = [
    'paypal',
    'steamdb',
    'nvidia',
    'docker'
  ];

  const ROOT = [
    'nl',
    'fr',
    'aw',
    'pl',
    'baidu'
  ];

  // These will get unreserved for because they fall out of 10k.
  const OTHER = [
    'web',
    'ishares',
    'bforbank',
    'raspbian-france'
  ];

  const checkBIP9Info = (info, expected) => {
    expected = expected || {};
    expected.startTime = expected.startTime || deployments[SOFT_FORK_NAME].startTime;
    expected.timeout = expected.timeout || deployments[SOFT_FORK_NAME].timeout;

    assert(info, 'BIP9 info should be returned');
    assert.strictEqual(info.status, expected.status);
    assert.strictEqual(info.bit, deployments[SOFT_FORK_NAME].bit);
    assert.strictEqual(info.startTime, expected.startTime);
    assert.strictEqual(info.timeout, expected.timeout);
  };

  const checkBIP9Statistcs = (stats, expected) => {
    expected = expected || {};

    assert.strictEqual(stats.period, expected.period || minerWindow);
    assert.strictEqual(stats.threshold, expected.threshold || activationThreshold);
    assert.strictEqual(stats.elapsed, expected.elapsed);
    assert.strictEqual(stats.count, expected.count);
    assert.strictEqual(stats.possible, expected.possible);
  };

  describe('Rules', function() {
    const main = Network.get('main');
    const {claimPeriod, alexaLockupPeriod} = main.names;

    const testCases = [];

    for (const name of [...ROOT, ...TOP10k, ...CUSTOM, ...OTHER]) {
      testCases.push({
        name,
        lockup: false,
        reserved: true,
        height: claimPeriod - 1,
        testName: `should not lockup before claim period ends (${name}), `
          + 'and be reserved (ALL)'
      });
    }

    for (const name of [...ROOT, ...TOP10k, ...CUSTOM]) {
      testCases.push({
        name,
        lockup: true,
        reserved: false,
        height: claimPeriod,
        testName: 'should get locked after claim period ends and '
          + `before alexaLockupPeriod ends (ROOT, TOP 10k) (${name})`
      });
    }

    for (const name of [...ROOT, ...TOP10k, ...CUSTOM]) {
      testCases.push({
        name,
        lockup: true,
        reserved: false,
        height: alexaLockupPeriod - 1,
        testName: 'should get locked after claim period ends and '
          + `before alexaLockupPeriod ends (ROOT, TOP 10k) (${name}) (last)`
      });
    }

    for (const name of [...ROOT]) {
      testCases.push({
        name,
        lockup: true,
        reserved: false,
        height: alexaLockupPeriod,
        testName: `should get locked even after alexaLockupPeriod (ROOT) (${name})`
      });
    }

    // after another 4 years all names will become tradeable.
    for (const name of [...TOP10k, ...CUSTOM, ...OTHER]) {
      testCases.push({
        name,
        lockup: false,
        reserved: false,
        height: alexaLockupPeriod,
        testName: `should get unlocked after alexaLockupPeriod (NON-ROOT) (${name})`
      });
    }

    for (const {name, lockup, reserved, height, testName} of testCases) {
      it(testName, () => {
        const hash = hashName(name);

        assert.strictEqual(lockup, isLockedUp(hash, height, main));
        assert.strictEqual(reserved, isReserved(hash, height, main));
      });
    }
  });

  describe('BIP9 - ICANN lockup - failure (integration)', function() {
    this.timeout(20000);

    let node, chain;
    let nodeClient, walletClient;
    let wdb, wallet;

    const FROOT = ROOT.slice();
    const FTOP10k = TOP10k.slice();
    const FCUSTOM = CUSTOM.slice();
    const FOTHER = OTHER.slice();
    const CLAIMED = [];
    const CLAIMED_ROOT = [];
    const CLAIMED_OTHER = [];

    before(async () => {
      node = new FullNode({
        memory: true,
        network: network.type,
        // We don't want wallet to check lockup names for this test.
        walletIcannlockup: false,
        plugins: [require('../lib/wallet/plugin')]
      });

      await node.ensure();
      await node.open();

      chain = node.chain;

      deployments[SOFT_FORK_NAME].startTime = 0;
      deployments[SOFT_FORK_NAME].timeout = 0xffffffff;
      network.names.claimPeriod = minerWindow * 4;
      network.names.renewalWindow = minerWindow * 6;

      // Ignore claim validation
      ownership.ignore = true;

      nodeClient = new NodeClient({
        port: network.rpcPort,
        timeout: 10000
      });

      walletClient = new WalletClient({
        port: network.walletPort,
        timeout: 10000
      });

      const walletPlugin = node.require('walletdb');
      wdb = walletPlugin.wdb;
      wallet = await wdb.get('primary');

      const account = await walletClient.getAccount('primary', 'default');
      const receive = account.receiveAddress;
      node.miner.addAddress(receive);

      await walletClient.execute('selectwallet', ['primary']);
    });

    after(async () => {
      // Enable claim validation
      ownership.ignore = false;

      deployments[SOFT_FORK_NAME].startTime = ACTUAL_START;
      deployments[SOFT_FORK_NAME].timeout = ACTUAL_TIMEOUT;
      network.names.claimPeriod = ACTUAL_CLAIM_PERIOD;
      network.names.renewalWindow = ACTUAL_RENEWAL_WINDOW;

      await node.close();
    });

    it('should get deployment stats', async () => {
      const state = await getICANNLockupState(chain);
      const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);

      assert.strictEqual(state, thresholdStates.DEFINED);
      checkBIP9Info(bip9info, { status: 'defined' });
    });

    it('should start the soft-fork', async () => {
      for (let i = 0; i < minerWindow - 2; i++)
        await mineBlock(node);

      // We are now at the threshold of the window.
      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.DEFINED);
        checkBIP9Info(bip9info, { status: 'defined' });
      }

      // go into new window and change the state to started.
      await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        assert.deepStrictEqual(bip9info.statistics, {
          period: minerWindow,
          threshold: activationThreshold,
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should fail to OPEN for the claimable names', async () => {
      let err;
      try {
        await walletClient.createOpen('primary', {
          name: FROOT[0]
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert(err.message, `Name is reserved: ${FROOT[0]}`);
    });

    it('should be possible to claim for now', async () => {
      const root = FROOT.shift();
      const other = FOTHER.shift();

      const mempoolClaim = forEvent(node.mempool, 'claim', 2, 20000);

      {
        const claim = await wallet.makeFakeClaim(root);
        await wdb.sendClaim(claim);
        CLAIMED.push(root);
        CLAIMED_ROOT.push(root);
      }

      {
        const claim = await wallet.makeFakeClaim(other);
        await wdb.sendClaim(claim);
        CLAIMED.push(other);
        CLAIMED_OTHER.push(other);
      }

      await mempoolClaim;

      assert.strictEqual(node.mempool.claims.size, 2);
    });

    it('should fail first window right away', async () => {
      const maxFailures = minerWindow - activationThreshold;

      for (let i = 0; i < maxFailures; i++)
        await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: maxFailures,
          count: 0,
          possible: true
        });
      }

      await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: maxFailures + 1,
          count: 0,
          possible: false
        });
      }

      // finish the whole window.
      for (let i = 0; i < activationThreshold - 1; i++)
        await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should fail second window by 1 vote', async () => {
      // Because we want this new window to be the last one,
      // here we manipulate the deployment timeout.
      // Because the deployment state in the window gets
      // cached, we can safely modify timeout in the beginning of the
      // window.
      deployments[SOFT_FORK_NAME].timeout = 1;

      for (let i = 0; i < activationThreshold - 1; i++)
        await mineBlock(node, { setICANNLockup: true });

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: activationThreshold - 1,
          count: activationThreshold - 1,
          possible: true
        });
      }

      // mine everything else w/o a vote.
      for (let i = 0; i < minerWindow - activationThreshold; i++) {
        await mineBlock(node);

        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: activationThreshold + i,
          count: activationThreshold - 1,
          possible: true
        });
      }

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: minerWindow - 1,
          count: activationThreshold - 1,
          possible: true
        });
      }

      // After this it should go to the FAILED state.
      await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.FAILED);
        checkBIP9Info(bip9info, { status: 'failed' });

        assert(!bip9info.statistics);
      }
    });

    it('should still allow claims before claimPeriod', async () => {
      // Just go on the edge of the claim period.
      // Leave a room for the next test.
      while (chain.tip.height < network.names.claimPeriod - 4)
        await mineBlock(node);

      const custom = FCUSTOM.shift();
      const top10k = FTOP10k.shift();

      const names = [custom, top10k];

      const mempoolClaim = forEvent(node.mempool, 'claim', names.length, 20000);

      for (const name of names) {
        const claim = await wallet.makeFakeClaim(name);
        await node.mempool.insertClaim(claim);
      }

      await mempoolClaim;
      assert.strictEqual(node.mempool.claims.size, names.length);
      await mineBlock(node);
    });

    it('should fail to claim and invalidate', async () => {
      const root = FROOT.shift();
      const other = FOTHER.shift();

      const rootClaim = await wallet.makeFakeClaim(root);
      const otherClaim = await wallet.makeFakeClaim(other);

      // Should insert one claim in the mempool.
      await node.mempool.insertClaim(rootClaim);
      assert.strictEqual(node.mempool.claims.size, 1);

      await mineBlock(node, { ignoreClaims: true });
      assert.strictEqual(node.mempool.claims.size, 1);

      while (chain.tip.height < network.names.claimPeriod - 1) {
        assert.strictEqual(node.mempool.claims.size, 1);
        await mineBlock(node, { ignoreClaims: true });
      }

      // Claim should get invalidated.
      assert.strictEqual(node.mempool.claims.size, 0);

      let err;

      try {
        await node.mempool.insertClaim(otherClaim);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.type, 'VerifyError');
      assert.strictEqual(err.reason, 'invalid-covenant');

      assert.strictEqual(node.mempool.claims.size, 0);
    });

    it('should open the auction', async () => {
      const root = FROOT.shift();
      const custom = FCUSTOM.shift();
      const top10k = FTOP10k.shift();
      const other = FOTHER.shift();

      const names = [root, custom, top10k, other];

      const opens = forEvent(node.mempool, 'tx', names.length, 20000);

      for (const name of names) {
        const mtx = await wallet.createOpen(name);
        await wallet.sign(mtx);
        const tx = mtx.toTX();
        await wdb.addTX(tx);
        await node.mempool.addTX(tx);
      }

      await opens;

      await mineBlock(node);

      for (const name of names) {
        const ns = await nodeClient.execute('getnameinfo', [name]);
        assert(!ns.start.locked);
        assert.strictEqual(ns.info.state, 'OPENING');
      }

      for (let i = 0; i < network.names.treeInterval + 1; i++)
        await mineBlock(node);

      for (const name of names) {
        const ns = await nodeClient.execute('getnameinfo', [name]);
        assert(!ns.start.locked);
        assert.strictEqual(ns.info.state, 'BIDDING');
      }
    });

    it('should open expired claims', async () => {
      const rootName = CLAIMED_ROOT[0];
      const otherName = CLAIMED_OTHER[0];
      const names = [rootName, otherName];

      const root = await nodeClient.execute('getnameinfo', [rootName]);
      const other = await nodeClient.execute('getnameinfo', [otherName]);
      const commitHeight = root.info.height;
      const expireHeight = commitHeight + network.names.renewalWindow;

      // They were claimed in the same block.
      assert.strictEqual(root.info.height, other.info.height);
      assert.ok(expireHeight > network.names.claimPeriod);

      // let them expire.
      while (chain.tip.height < expireHeight)
        await mineBlock(node);

      for (const name of names) {
        const nameExp = await nodeClient.execute('getnameinfo', [name]);
        assert.strictEqual(nameExp.info, null);
      }

      // Only OTHER open gets added.
      const opens = forEvent(node.mempool, 'tx', names.length, 20000);

      for (const name of names) {
        const mtx = await wallet.createOpen(name);
        await wallet.sign(mtx);
        const tx = await mtx.toTX();
        await wdb.addTX(tx);
        await node.mempool.addTX(tx);
      }

      await opens;
      await mineBlock(node);

      for (const name of names) {
        const afterOpen = await nodeClient.execute('getnameinfo', [name]);
        assert.strictEqual(afterOpen.info.state, 'OPENING');
      }

      await mineNBlocks(network.names.treeInterval + 1, node);

      for (const name of names) {
        const nameAfterInterval = await nodeClient.execute('getnameinfo', [name]);
        assert.strictEqual(nameAfterInterval.info.state, 'BIDDING');
      }
    });
  });

  describe('BIP9 - ICANN lockup - success (integration)', function() {
    this.timeout(20000);

    let node, chain;
    let nodeClient, walletClient;
    let wdb, wallet;

    const FROOT = ROOT.slice();
    const FTOP10k = TOP10k.slice();
    const FCUSTOM = CUSTOM.slice();
    const FOTHER = OTHER.slice();
    const CLAIMED = [];
    const CLAIMED_ROOT = [];
    const CLAIMED_OTHER = [];

    before(async () => {
      node = new FullNode({
        memory: true,
        network: network.type,
        // We don't want wallet to check lockup names for this test.
        walletIcannlockup: false,
        plugins: [require('../lib/wallet/plugin')]
      });

      await node.ensure();
      await node.open();

      chain = node.chain;

      deployments[SOFT_FORK_NAME].startTime = 0;
      deployments[SOFT_FORK_NAME].timeout = 0xffffffff;
      network.names.claimPeriod = minerWindow * 4;
      network.names.renewalWindow = minerWindow * 6;

      // Ignore claim validation
      ownership.ignore = true;

      nodeClient = new NodeClient({
        port: network.rpcPort,
        timeout: 10000
      });

      walletClient = new WalletClient({
        port: network.walletPort,
        timeout: 10000
      });

      const walletPlugin = node.require('walletdb');
      wdb = walletPlugin.wdb;
      wallet = await wdb.get('primary');

      const account = await walletClient.getAccount('primary', 'default');
      const receive = account.receiveAddress;
      node.miner.addAddress(receive);

      await walletClient.execute('selectwallet', ['primary']);
    });

    after(async () => {
      // Enable claim validation
      ownership.ignore = false;

      // Enable claim validation
      // ownership.ignore = false;
      deployments[SOFT_FORK_NAME].startTime = ACTUAL_START;
      deployments[SOFT_FORK_NAME].timeout = ACTUAL_TIMEOUT;
      network.names.claimPeriod = ACTUAL_CLAIM_PERIOD;
      network.names.renewalWindow = ACTUAL_RENEWAL_WINDOW;

      await node.close();
    });

    it('should get deployment stats', async () => {
      const state = await getICANNLockupState(chain);
      const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);

      assert.strictEqual(state, thresholdStates.DEFINED);
      checkBIP9Info(bip9info, { status: 'defined' });
    });

    it('should start the soft-fork', async () => {
      await mineNBlocks(minerWindow - 2, node);

      // We are now at the threshold of the window.
      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.DEFINED);
        checkBIP9Info(bip9info, { status: 'defined' });
      }

      // go into new window and change the state to started.
      await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        assert.deepStrictEqual(bip9info.statistics, {
          period: minerWindow,
          threshold: activationThreshold,
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should fail to OPEN for the claimable names', async () => {
      let err;
      try {
        await walletClient.createOpen('primary', {
          name: FROOT[0]
        });
      } catch (e) {
        err = e;
      }

      assert(err);
      assert(err.message, `Name is reserved: ${FROOT[0]}`);
    });

    it('should be possible to claim for now', async () => {
      const root = FROOT.shift();
      const other = FOTHER.shift();

      const mempoolClaim = forEvent(node.mempool, 'claim', 2, 20000);

      {
        // send ICANN TLD.
        const claim = await wallet.makeFakeClaim(root);
        await wdb.sendClaim(claim);
        CLAIMED.push(root);
        CLAIMED_ROOT.push(root);
      }

      {
        // send OTHER.
        const claim = await wallet.makeFakeClaim(other);
        await wdb.sendClaim(claim);
        CLAIMED.push(other);
        CLAIMED_OTHER.push(other);
      }

      await mempoolClaim;

      assert.strictEqual(node.mempool.claims.size, 2);
    });

    it('should fail first window right away', async () => {
      const maxFailures = minerWindow - activationThreshold;

      await mineNBlocks(maxFailures, node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: maxFailures,
          count: 0,
          possible: true
        });
      }

      await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: maxFailures + 1,
          count: 0,
          possible: false
        });
      }

      // finish the whole window.
      await mineNBlocks(activationThreshold - 1, node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: 0,
          count: 0,
          possible: true
        });
      }
    });

    it('should succeed second window by 1 vote', async () => {
      await mineNBlocks(activationThreshold, node, { setICANNLockup: true });

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: activationThreshold,
          count: activationThreshold,
          possible: true
        });
      }

      // mine everything else w/o a vote.
      for (let i = 0; i < minerWindow - activationThreshold - 1; i++) {
        await mineBlock(node);

        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: activationThreshold + i + 1,
          count: activationThreshold,
          possible: true
        });
      }

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);
        assert.strictEqual(state, thresholdStates.STARTED);
        checkBIP9Info(bip9info, { status: 'started' });

        checkBIP9Statistcs(bip9info.statistics, {
          elapsed: minerWindow - 1,
          count: activationThreshold,
          possible: true
        });
      }

      // After this it should go to the ACTIVE state.
      await mineBlock(node);

      {
        const state = await getICANNLockupState(chain);
        const bip9info = await getBIP9Info(nodeClient, SOFT_FORK_NAME);

        assert.strictEqual(state, thresholdStates.LOCKED_IN);
        checkBIP9Info(bip9info, { status: 'locked_in' });

        assert(!bip9info.statistics);
      }
    });

    it('should still allow claims before claimPeriod', async () => {
      // Just go on the edge of the claim period.
      // Leave a room for the next test.
      while (chain.tip.height < network.names.claimPeriod - 4)
        await mineBlock(node);

      const custom = FCUSTOM.shift();
      const top10k = FTOP10k.shift();

      const names = [custom, top10k];

      const mempoolClaim = forEvent(node.mempool, 'claim', names.length, 20000);

      for (const name of names) {
        const claim = await wallet.makeFakeClaim(name);
        await node.mempool.insertClaim(claim);
      }

      await mempoolClaim;
      assert.strictEqual(node.mempool.claims.size, names.length);
      await mineBlock(node);
    });

    it('should fail to claim and invalidate', async () => {
      const root = FROOT.shift();
      const other = FOTHER.shift();

      const rootClaim = await wallet.makeFakeClaim(root);
      const otherClaim = await wallet.makeFakeClaim(other);

      await node.mempool.insertClaim(rootClaim);
      assert.strictEqual(node.mempool.claims.size, 1);

      await mineBlock(node, { ignoreClaims: true });
      assert.strictEqual(node.mempool.claims.size, 1);

      while (chain.tip.height < network.names.claimPeriod - 1) {
        assert.strictEqual(node.mempool.claims.size, 1);
        await mineBlock(node, { ignoreClaims: true });
      }

      assert.strictEqual(node.chain.tip.height + 1, network.names.claimPeriod);
      // Claim should get invalidated.
      assert.strictEqual(node.mempool.claims.size, 0);

      let err;

      try {
        await node.mempool.insertClaim(otherClaim);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.type, 'VerifyError');
      assert.strictEqual(err.reason, 'invalid-covenant');

      assert.strictEqual(node.mempool.claims.size, 0);
    });

    it('should fail to open the auction for ICANN TLDs', async () => {
      const root = FROOT.shift();
      const custom = FCUSTOM.shift();
      const top10k = FTOP10k.shift();

      const names = [root, custom, top10k];

      for (const name of names) {
        const mtx = await wallet.createOpen(name);
        await wallet.sign(mtx);
        const tx = mtx.toTX();
        await wdb.addTX(tx);

        let err;
        try {
          await node.mempool.addTX(tx);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.type, 'VerifyError');
        assert.strictEqual(err.reason, 'invalid-covenant');
        assert.strictEqual(node.mempool.claims.size, 0);
      }

      await mineBlock(node);

      for (const name of names) {
        const ns = await nodeClient.execute('getnameinfo', [name]);
        assert.strictEqual(ns.start.locked, true);
        assert.strictEqual(ns.info, null);
      }
    });

    it('should open auction for OTHERs', async () => {
      const names = [...FOTHER];

      const opens = forEvent(node.mempool, 'tx', names.length, 20000);

      for (const name of names) {
        const tx = await wallet.sendOpen(name);
        assert(tx);
      }

      await opens;
      await mineBlock(node);

      for (const name of names) {
        const ns = await nodeClient.execute('getnameinfo', [name]);
        assert.strictEqual(ns.start.locked, false);
        assert.strictEqual(ns.info.state, 'OPENING');
      }

      await mineNBlocks(network.names.treeInterval + 1, node);

      for (const name of names) {
        const ns = await nodeClient.execute('getnameinfo', [name]);
        assert(!ns.start.locked);
        assert.strictEqual(ns.info.state, 'BIDDING');
      }
    });

    it('should fail to open expired TLDs, but open for OTHERs', async () => {
      const rootName = CLAIMED_ROOT[0];
      const otherName = CLAIMED_OTHER[0];
      const root = await nodeClient.execute('getnameinfo', [rootName]);
      const other = await nodeClient.execute('getnameinfo', [otherName]);
      const commitHeight = root.info.height;
      const expireHeight = commitHeight + network.names.renewalWindow;

      // They were claimed in the same block.
      assert.strictEqual(root.info.height, other.info.height);
      assert.ok(expireHeight > network.names.claimPeriod);

      // let them expire.
      while (chain.tip.height < expireHeight)
        await mineBlock(node);

      const rootExp0 = await nodeClient.execute('getnameinfo', [rootName]);
      const otherExp = await nodeClient.execute('getnameinfo', [otherName]);
      assert.strictEqual(rootExp0.info, null);
      assert.strictEqual(otherExp.info, null);

      // Only OTHER open gets added.
      const opens = forEvent(node.mempool, 'tx', 1, 20000);

      // Fail for the TLD.
      let err;

      {
        const mtx = await wallet.createOpen(rootName);
        await wallet.sign(mtx);
        const tx = await mtx.toTX();
        await wdb.addTX(tx);

        try {
          await node.mempool.addTX(tx);
        } catch (e) {
          err = e;
        }
      }

      assert(err);
      assert.strictEqual(err.type, 'VerifyError');
      assert.strictEqual(err.reason, 'invalid-covenant');

      {
        // Should not fail for OTHER (as they are auctionable)
        const mtx = await wallet.createOpen(otherName);
        await wallet.sign(mtx);
        const tx = await mtx.toTX();
        await wdb.addTX(tx);
        await node.mempool.addTX(tx);
      }

      await opens;
      await mineBlock(node);

      const rootAfterOpen = await nodeClient.execute('getnameinfo', [rootName]);
      assert.strictEqual(rootAfterOpen.start.locked, true);
      assert.strictEqual(rootAfterOpen.info, null);

      const otherAfterOpen = await nodeClient.execute('getnameinfo', [otherName]);
      assert.strictEqual(otherAfterOpen.info.state, 'OPENING');

      await mineNBlocks(network.names.treeInterval + 1, node);
      const otherAfterInterval = await nodeClient.execute('getnameinfo', [otherName]);
      assert.strictEqual(otherAfterInterval.info.state, 'BIDDING');
    });
  });
});

async function mineNBlocks(n, node, opts = {}) {
  for (let i = 0; i < n; i++)
    await mineBlock(node, opts);
}

async function mineBlock(node, opts = {}) {
  assert(node);
  const chain = node.chain;
  const miner = node.miner;

  const setICANNLockup = opts.setICANNLockup || false;
  const ignoreClaims = opts.ignoreClaims || false;

  const forBlock = forEvent(node, 'block', 1, 2000);

  let backupClaims = null;

  if (ignoreClaims) {
    backupClaims = node.mempool.claims;
    node.mempool.claims = new BufferMap();
  }

  const job = await miner.cpu.createJob(chain.tip);

  // opt out of all (esp. `hardening`) as
  // some domains in this test still use RSA-1024
  job.attempt.version = 0;

  if (setICANNLockup)
    job.attempt.version |= (1 << deployments[SOFT_FORK_NAME].bit);

  job.refresh();

  if (ignoreClaims)
    node.mempool.claims = backupClaims;

  const block = await job.mineAsync();
  await chain.add(block);
  await forBlock;

  return block;
}

async function getICANNLockupState(chain) {
  const prev = chain.tip;
  const state =  await chain.getState(prev, deployments.icannlockup);
  return state;
}

async function getBIP9Info(nodeClient, name) {
  const info = await nodeClient.execute('getblockchaininfo');
  return info.softforks[name];
}
