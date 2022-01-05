'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const {rimraf, testdir} = require('./util/common');

const path = testdir('walletchange');

const node = new FullNode({
  prefix: path,
  memory: false,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');

let wallet, recAddr;
const changeAddrs = [];
const manualChangeAddrs = [];

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Derive and save change addresses', function() {
  before(async () => {
    await node.ensure();
    await node.open();

    wallet = await wdb.create();
    recAddr = await wallet.receiveAddress();
  });

  after(async () => {
    await node.close();
    await rimraf(path);
  });

  it('should fund account', async () => {
    await mineBlocks(2, recAddr);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const aliceBal = await wallet.getBalance(0);
    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
  });

  it('should send 20 transactions', async () => {
    for (let i = 0; i < 20; i++) {
      const tx = await wallet.send({outputs: [{
        address: Address.fromHash(Buffer.alloc(32, 1)),
        value: 10000
      }]});

      for (const output of tx.outputs) {
        if (output.value !== 10000)
          changeAddrs.push(output.address);
      }
    }
  });

  it('should have incremented changeDepth by 20', async () => {
    const info = await wallet.getAccount(0);
    assert.strictEqual(info.changeDepth, 21);
    assert.strictEqual(changeAddrs.length, 20);
  });

  it('should have all change addresses saved', async () => {
    for (const addr of changeAddrs) {
      assert(await wallet.hasAddress(addr));
    }
  });

  it('should manually generate 20 change addresses', async () => {
    for (let i = 0; i < 20; i++) {
      const addr = await wallet.createChange();
      manualChangeAddrs.push(addr.getAddress());
    }
  });

  it('should have incremented changeDepth by 20', async () => {
    const info = await wallet.getAccount(0);
    assert.strictEqual(info.changeDepth, 41);
    assert.strictEqual(manualChangeAddrs.length, 20);
  });

  it('should have all change addresses saved', async () => {
    for (const addr of manualChangeAddrs) {
      assert(await wallet.hasAddress(addr));
    }
  });
});
