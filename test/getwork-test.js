'use strict';

const assert = require('bsert');
const bio = require('bufio');
const mine = require('../lib/mining/mine');
const FullNode = require('../lib/node/fullnode');
const Headers = require('../lib/primitives/headers');
const consensus = require('../lib/protocol/consensus');
const {forEvent, sleep}  = require('./util/common');

const node = new FullNode({
  memory: true,
  apiKey: 'foo',
  network: 'regtest',
  bip37: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const {chain, miner, rpc} = node;
const {wdb} = node.require('walletdb');

let wallet = null;

describe('Get Work', function() {
  this.timeout(45000);

  it('should open chain and miner', async () => {
    await node.open();
  });

  it('should open walletdb', async () => {
    wallet = await wdb.create();
    miner.addresses.length = 0;
    miner.addAddress(await wallet.receiveAddress());
  });

  it('should mine 10 blocks', async () => {
    const connectEvents = forEvent(chain, 'connect', 10, 10000);
    for (let i = 0; i < 10; i++) {
      const block = await miner.mineBlock();
      assert(block);
      await chain.add(block);
      // lower mtp.
      await sleep(500);
    }

    await connectEvents;
  });

  it('should get and submit work', async () => {
    const json = await rpc.getWork([]);
    const data = Buffer.from(json.data, 'hex');
    const target = Buffer.from(json.target, 'hex');
    const [nonce, result] = mine(data, target, -1 >>> 0);

    assert.strictEqual(result, true);

    bio.writeU32(data, nonce, 0);

    const [ok, reason] = await rpc.submitWork([data.toString('hex')]);

    assert.strictEqual(ok, true);
    assert.strictEqual(reason, 'valid');
  });

  it('should get and submit work (updated time)', async () => {
    const json1 = await rpc.getWork([]);
    const data1 = Buffer.from(json1.data, 'hex');
    const target1 = Buffer.from(json1.target, 'hex');
    const hdr1 = Headers.fromMiner(data1);
    const [nonce, result] = mine(data1, target1, -1 >>> 0);

    assert.strictEqual(result, true);

    await sleep(3000);

    const json2 = await rpc.getWork([]);
    const data2 = Buffer.from(json2.data, 'hex');
    const hdr2 = Headers.fromMiner(data2);

    assert.bufferEqual(hdr1.witnessRoot, hdr2.witnessRoot);
    assert.notStrictEqual(hdr1.time, hdr2.time);

    bio.writeU32(data1, nonce, 0);

    const [ok, reason] = await rpc.submitWork([data1.toString('hex')]);

    assert.strictEqual(ok, true);
    assert.strictEqual(reason, 'valid');

    {
      const [ok, reason] = await rpc.submitWork([data2.toString('hex')]);
      assert.strictEqual(ok, false);
      assert.strictEqual(reason, 'stale');
    }
  });

  it('should get and submit work (updated mempool - first)', async () => {
    const json1 = await rpc.getWork([]);
    const data1 = Buffer.from(json1.data, 'hex');
    const target1 = Buffer.from(json1.target, 'hex');
    const hdr1 = Headers.fromMiner(data1);
    const [nonce, result] = mine(data1, target1, -1 >>> 0);

    assert.strictEqual(result, true);

    rpc.lastActivity -= 11;

    await wallet.send({
      outputs: [
        {
          address: await wallet.receiveAddress(),
          value: 25 * consensus.COIN
        }
      ]
    });

    await sleep(2000);

    const json2 = await rpc.getWork([]);
    const data2 = Buffer.from(json2.data, 'hex');
    const hdr2 = Headers.fromMiner(data2);

    assert(!hdr1.witnessRoot.equals(hdr2.witnessRoot));
    assert(rpc.attempt && rpc.attempt.witnessRoot.equals(hdr2.witnessRoot));

    bio.writeU32(data1, nonce, 0);

    const [ok, reason] = await rpc.submitWork([data1.toString('hex')]);

    assert.strictEqual(reason, 'valid');
    assert.strictEqual(ok, true);

    {
      const [ok, reason] = await rpc.submitWork([data2.toString('hex')]);
      assert.strictEqual(ok, false);
      assert.strictEqual(reason, 'stale');
    }
  });

  it('should get and submit work (updated mempool - second)', async () => {
    const json1 = await rpc.getWork([]);
    const data1 = Buffer.from(json1.data, 'hex');
    const hdr1 = Headers.fromMiner(data1);

    rpc.lastActivity -= 11;

    await wallet.send({
      outputs: [
        {
          address: await wallet.receiveAddress(),
          value: 25 * consensus.COIN
        }
      ]
    });

    await sleep(2000);

    const json2 = await rpc.getWork([]);
    const data2 = Buffer.from(json2.data, 'hex');
    const target2 = Buffer.from(json2.target, 'hex');
    const hdr2 = Headers.fromMiner(data2);

    assert(!hdr1.witnessRoot.equals(hdr2.witnessRoot));
    assert(rpc.attempt && rpc.attempt.witnessRoot.equals(hdr2.witnessRoot));

    const [nonce, result] = mine(data2, target2, -1 >>> 0);

    assert.strictEqual(result, true);

    bio.writeU32(data2, nonce, 0);

    const [ok, reason] = await rpc.submitWork([data2.toString('hex')]);

    assert.strictEqual(reason, 'valid');
    assert.strictEqual(ok, true);

    {
      const [ok, reason] = await rpc.submitWork([data1.toString('hex')]);
      assert.strictEqual(ok, false);
      assert.strictEqual(reason, 'stale');
    }
  });

  it('should check chain', async () => {
    const block = await chain.getBlock(chain.tip.hash);

    assert.strictEqual(block.txs.length, 3);
    assert.strictEqual(chain.tip.height, 14);
    assert.strictEqual(chain.height, 14);
  });

  it('should get fees from template', async () => {
    const json1 = await rpc.getWork([]);
    assert.strictEqual(json1.fee, 0);

    rpc.lastActivity -= 11;

    await wallet.send({
      outputs: [
        {
          address: await wallet.receiveAddress(),
          value: 25 * consensus.COIN
        }
      ],
      hardFee: 12345
    });

    await sleep(2000);

    const json2 = await rpc.getWork([]);
    assert.strictEqual(json2.fee, 12345);

    rpc.lastActivity -= 11;

    await wallet.send({
      outputs: [
        {
          address: await wallet.receiveAddress(),
          value: 10 * consensus.COIN
        }
      ],
      hardFee: 54321
    });

    await sleep(2000);

    const json3 = await rpc.getWork([]);
    assert.strictEqual(json3.fee, 66666);
  });

  it('should cleanup', async () => {
    await node.close();
  });
});
