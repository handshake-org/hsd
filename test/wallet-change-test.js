/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const {tmpdir} = require('os');
const {randomBytes} = require('bcrypto/lib/random');
const Path = require('path');
const layouts = require('../lib/wallet/layout');
const layout = layouts.wdb;

const uniq = randomBytes(4).toString('hex');
const path = Path.join(tmpdir(), `hsd-test-${uniq}`);

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
const missingChangeAddrs = [];

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

  it('should recreate the missing change address bug', async () => {
    for (let i = 0; i < 20; i++) {
      const acct = await wallet.getAccount(0);
      const key = acct.deriveChange(acct.changeDepth);
      acct.changeDepth += 1;
      const b = wdb.db.batch();
      await wdb.saveAccount(b, acct);
      await b.write();
      missingChangeAddrs.push(key.getAddress());
    }
  });

  it('should have no missing change addresses beyond lookahead', async () => {
    const acct = await wallet.getAccount(0);
    const lookahead = acct.lookahead;

    for (let i = 0; i < missingChangeAddrs.length; i++) {
      const addr = await wallet.hasAddress(missingChangeAddrs[i]);

      if (i < lookahead)
        assert(addr);
      else
        assert(!addr);
    }
  });

  it('should migrate wallet and recover change addresses', async () => {
    // Fake an old db state
    await wdb.db.del(layout.M.encode(0));

    // Run migration script without flag -- throws
    await assert.rejects(
      wdb.migrateChange(),
      {
        message: 'Wallet is corrupted.\n' +
          'Back up wallet and then restart with\n' +
          '`hsd --wallet-migrate=0` or `hs-wallet --migrate=0`\n' +
          '(Full node required)'
      }
    );

    // Add flag
    wdb.options.migrate = 0;

    // Run migration script again
    await wdb.migrateChange();

    // Fixed
    for (const addr of missingChangeAddrs) {
      assert(await wallet.hasAddress(addr));
    }

    // Sanity checks
    for (const addr of changeAddrs) {
      assert(await wallet.hasAddress(addr));
    }
    for (const addr of manualChangeAddrs) {
      assert(await wallet.hasAddress(addr));
    }
  });
});
