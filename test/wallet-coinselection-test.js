'use strict';

const assert = require('bsert');
const {BlockMeta} = require('../lib/wallet/records');
const util = require('../lib/utils/util');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const WalletDB = require('../lib/wallet/walletdb');
const policy = require('../lib/protocol/policy');

// Use main instead of regtest because (deprecated)
// CoinSelector.MAX_FEE was network agnostic
const network = Network.get('main');

function dummyBlock(tipHeight) {
  const height = tipHeight + 1;
  const hash = Buffer.alloc(32);
  hash.writeUInt16BE(height);

  const prevHash = Buffer.alloc(32);
  prevHash.writeUInt16BE(tipHeight);

  const dummyBlock = {
    hash,
    height,
    time: util.now(),
    prevBlock: prevHash
  };

  return dummyBlock;
}

async function fundWallet(wallet, amounts) {
  assert(Array.isArray(amounts));

  const mtx = new MTX();
  const addr = await wallet.receiveAddress();
  for (const amt of amounts) {
    mtx.addOutput(addr, amt);
  }

  const dummy = dummyBlock(wallet.wdb.height);
  await wallet.wdb.addBlock(dummy, [mtx.toTX()]);
}

describe('Wallet Coin Selection', function () {
  describe('Fees', function () {
    const wdb = new WalletDB({network});
    let wallet;

    before(async () => {
      await wdb.open();
      wdb.height = network.txStart + 1;
      wdb.state.height = wdb.height;

      const dummy = dummyBlock(network.txStart + 1);
      const record = BlockMeta.fromEntry(dummy);
      await wdb.setTip(record);
      wallet = wdb.primary;
    });

    after(async () => {
      await wdb.close();
    });

    it('should fund wallet', async () => {
      await fundWallet(wallet, [100e6, 10e6, 1e6, 100000, 10000]);
      const bal = await wallet.getBalance();
      assert.strictEqual(bal.confirmed, 111110000);
    });

    it('should pay default fee rate for small tx', async () => {
      const address = await wallet.receiveAddress();
      const mtx = new MTX();
      mtx.addOutput(address, 5e6);
      await wallet.fund(mtx);
      await wallet.sign(mtx);

      assert.strictEqual(mtx.inputs.length, 1);
      assert.strictEqual(mtx.outputs.length, 2);

      const rate = mtx.getRate();
      const fee = mtx.getFee();

      assert.strictEqual(rate, network.feeRate);
      assert(rate < network.maxFeeRate);
      assert(fee > network.minRelay);
    });

    it('should pay default fee rate for maximum policy weight TX', async () => {
      const address = await wallet.receiveAddress();
      const mtx = new MTX();
      for (let i = 0; i < 3120; i++) {
        mtx.addOutput(address, 500);
      }
      // Add nulldata output to add precise amount of extra weight
      mtx.addOutput(
        {
          version: 31,
          hash: Buffer.alloc(38)
        },
        0
      );
      await wallet.fund(mtx);
      await wallet.sign(mtx);

      // This is as close as we can get to
      // policy.MAX_TX_WEIGHT (400000) using standard wallet
      assert.strictEqual(mtx.getWeight(), 399997);
      assert.strictEqual(mtx.inputs.length, 1);

      const rate = mtx.getRate();
      const fee = mtx.getFee();

      assert.strictEqual(fee, 10e6); // 10 HNS

      assert.strictEqual(rate, network.feeRate);
      assert(rate < network.maxFeeRate);
      assert(fee > network.minRelay);
    });

    it('should fail to pay absurd fee rate for small tx', async () => {
      const address = await wallet.receiveAddress();
      await assert.rejects(
        wallet.send({
          outputs: [{
            address,
            value: 5e6
          }],
          rate: (policy.ABSURD_FEE_FACTOR + 1) * network.minRelay
        }),
        {message: 'Fee exceeds absurd limit.'}
      );
    });

    it('should pay fee just under the absurd limit', async () => {
      const address = await wallet.receiveAddress();
      const tx = await wallet.send({
        outputs: [{
          address,
          value: 5e6
        }],
        rate: 10000 * network.minRelay
      });
      const view = await wallet.getWalletCoinView(tx);
      assert.strictEqual(
        tx.getRate(view),
        policy.ABSURD_FEE_FACTOR * network.minRelay
      );
    });

    it('should fail to pay too-low fee rate for small tx', async () => {
      const address = await wallet.receiveAddress();
      await assert.rejects(
        wallet.send({
          outputs: [{
            address,
            value: 5e6
          }],
          rate: network.minRelay - 1
        }),
        {message: 'Fee is below minimum relay limit.'}
      );
    });

    it('should pay fee at the minimum relay limit', async () => {
      const address = await wallet.receiveAddress();
      const tx = await wallet.send({
        outputs: [{
          address,
          value: 5e6
        }],
        rate: network.minRelay
      });
      const view = await wallet.getWalletCoinView(tx);
      assert.strictEqual(tx.getRate(view), network.minRelay);
    });
  });
});
