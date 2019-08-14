/**
 * auction-alert-test.js - Auction Alert Tests
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const {NodeClient, WalletClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const network = Network.get('regtest');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');

const {
  biddingPeriod,
  revealPeriod,
  treeInterval
} = network.names;

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

const wallet = wclient.wallet('primary');

const {wdb} = node.require('walletdb');

let name, nameHash, primary;
const alerts = [];
describe('Auction Alerts', function() {
  this.timeout(10000);

  before(async () => {
    await node.open();

    wclient.on('connect', async () => {
      await wclient.call('join', wallet.id);
    });

    // set up listeners
    wclient.bind('alert', (wallet, ns, details) => {
      alerts.push([wallet, ns, details]);
    });

    await nclient.open();
    await wclient.open();

    name = rules.grindName(2, 0, Network.get('regtest'));
    nameHash = rules.hashName(name);
    const address = (await wallet.getAccount('default')).receiveAddress;

    // fetch the primary, corresponds with
    // the primary wallet client
    primary = await wdb.get(0);

    // build up an initial wallet balance
    await mineBlocks(4, address);
  });

  after(async () => {
    await wclient.close();
    await nclient.close();
    await node.close();
  });

  it('should emit alert events', async () => {
    await runAuction(name, wallet, nclient);

    const {info} = await nclient.execute('getnameinfo', [name]);
    const height = info.height;

    // Calculate the expected heights to receive alerts.
    // Should receive alerts when the next auction period
    // begins. See logic in NameState.js, in particular
    // NameState.{toStats,state}.
    const expected = [
      { height: height + treeInterval + 1 },
      { height: height + treeInterval + 1 + biddingPeriod },
      { height: height + treeInterval + 1
        + biddingPeriod + revealPeriod }
    ];

    // An entire auction is completed, there should
    // be an alert for OPEN -> BIDDING, BIDDING -> REVEAL
    // and REVEAL -> CLOSED. Ignore the RENEW alert because
    // regtest has a very large renewal period and mining
    // that many blocks would not be useful. It will be
    // checked manually by querying the database.
    assert.equal(expected.length, alerts.length);

    for (const [i, alert] of Object.entries(alerts)) {
      const [, ns, details] = alert;
      assert.equal(ns.name, name);
      assert.equal(ns.height, height);
      assert.equal(expected[i].height, details.height);
    }

    // Assert that the NameState is actually CLOSED.
    const nameinfo = await nclient.execute('getnameinfo', [name]);
    assert.equal(nameinfo.info.state, 'CLOSED');
    const stats = nameinfo.info.stats;
    const final = stats.renewalPeriodEnd;

    // Manually check the wallet for alerts at
    // the renewalPeriodEnd.
    assert(await primary.hasAlerts(final));

    // Query the AlertRecord and assert that it
    // contains the correct name hash and the
    // correct height.
    const alert = await primary.getAlerts(final);
    assert(alert.has(nameHash));
    assert.equal(alert.height, final);
  });

  it('should alter the alerts when there is a reorg', async () => {
    this.skip();
  });

  it('should prune after safe number of confirmations', async () => {
    this.skip();
  });
});

async function runAuction(name, wallet, node) {
  const address = (await wallet.getAccount('default')).receiveAddress;

  await wallet.client.post(`/wallet/${wallet.id}/open`, {
    name: name
  });

  await mineBlocks(treeInterval + 1, address);

  await wallet.client.post(`/wallet/${wallet.id}/bid`, {
    name: name,
    bid: 1000,
    lockup: 2000
  });

  await mineBlocks(biddingPeriod + 1, address);

  await wallet.client.post(`/wallet/${wallet.id}/reveal`, {
    name: name
  });

  await mineBlocks(revealPeriod + 1, address);

  await wallet.client.post(`/wallet/${wallet.id}/update`, {
    name: name,
    data: {text: ['foobar']}
  });

  await mineBlocks(treeInterval + 1, address);
}

// take into account race conditions
async function mineBlocks(count, address) {
  for (let i = 0; i < count; i++) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await common.forValue(obj, 'complete', true);
  }
}
