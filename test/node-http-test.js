/**
 *
 */

'use strict';

const {NodeClient,WalletClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const common = require('./util/common');
const rules = require('../lib/covenants/rules');

const network = Network.get('regtest');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

const ports = {
  p2p: 14331,
  node: 14332,
  wallet: 14333
};

const node = new FullNode({
  network: network.type,
  apiKey: 'bar',
  walletAuth: true,
  memory: true,
  port: ports.p2p,
  httpPort: ports.node,
  workers: true,
  plugins: [require('../lib/wallet/plugin')],
  env: {
    'HSD_WALLET_HTTP_PORT': ports.wallet.toString()
  }
});

const nclient = new NodeClient({
  port: ports.node,
  apiKey: 'bar'
});

const wclient = new WalletClient({
  port: ports.wallet,
  apiKey: 'bar'
});

const wallet = wclient.wallet('primary');

let coinbase, name;

describe('Node RPC Methods', function() {
  this.timeout(20000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    // mine a bunch of blocks
    const info = await wallet.createAddress('default');
    coinbase = info.address;

    await mineBlocks(10, coinbase);

    name = rules.grindName(3, 1, network);
    await doAuction(name);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

  it('should get zonefile', async () => {
    const res = await nclient.get('/zonefile')
    console.log(res)
  });
});

async function doAuction(name) {
  await wallet.client.post(`/wallet/${wallet.id}/open`, {
    name: name
  });

  await mineBlocks(treeInterval + 1, coinbase);

  await wallet.client.post(`/wallet/${wallet.id}/bid`, {
    name: name,
    bid: 1000,
    lockup: 2000
  });

  await mineBlocks(biddingPeriod + 1, coinbase);

  await wallet.client.post(`/wallet/${wallet.id}/reveal`, {
    name: name
  });

  await mineBlocks(revealPeriod + 1, coinbase);

  await wallet.client.post(`/wallet/${wallet.id}/update`, {
    name: name,
    data: {
      hosts: ['192.168.0.91'],
      ns: [
        'ns1.cloudflare.com@1.2.3.4',
        'ns2.cloudflare.com@1.2.4.4'
      ],
      ttl: 64
    }
  });

  await mineBlocks(treeInterval, coinbase);
}

/**
 * Mine blocks and take into
 * account race conditions
 */

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
