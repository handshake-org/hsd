/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const Opcode = require('../lib/script/opcode');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const TX = require('../lib/primitives/tx');
const Address = require('../lib/primitives/address');
const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  apiKey: 'foo',
  network: 'regtest',
  bip37: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const chain = node.chain;
const miner = node.miner;
const {wdb} = node.require('walletdb');

let wallet = null;
let tip1 = null;
let tip2 = null;
let cb1 = null;
let cb2 = null;
let tx1 = null;
let tx2 = null;

const csvScript = new Script([
  Opcode.fromInt(1),
  Opcode.fromSymbol('checksequenceverify')
]);

const csvScript2 = new Script([
  Opcode.fromInt(2),
  Opcode.fromSymbol('checksequenceverify')
]);

async function mineBlock(tip, tx) {
  const job = await miner.createJob(tip);

  if (!tx)
    return job.mineAsync();

  const spend = new MTX();

  spend.addTX(tx, 0);

  spend.addOutput(await wallet.receiveAddress(), 25 * consensus.COIN);
  spend.addOutput(await wallet.changeAddress(), 5 * consensus.COIN);

  spend.setLocktime(chain.height);

  await wallet.sign(spend);

  job.addTX(spend.toTX(), spend.view);
  job.refresh();

  return job.mineAsync();
}

async function mineCSV(fund) {
  const job = await miner.createJob();
  const spend = new MTX();

  spend.addOutput({
    address: Address.fromHash(csvScript.sha3()),
    value: 10 * consensus.COIN
  });

  spend.addTX(fund, 0);
  spend.setLocktime(chain.height);

  await wallet.sign(spend);

  const [tx, view] = spend.commit();

  job.addTX(tx, view);
  job.refresh();

  return job.mineAsync();
}

describe('Node', function() {
  this.timeout(5000);

  it('should open chain and miner', async () => {
    miner.mempool = null;
    await node.open();
  });

  it('should open walletdb', async () => {
    network.coinbaseMaturity = 1;
    wallet = await wdb.create();
    miner.addresses.length = 0;
    miner.addAddress(await wallet.receiveAddress());
  });

  it('should mine a block', async () => {
    const block = await miner.mineBlock();
    assert(block);
    await chain.add(block);
  });

  it('should mine competing chains', async function() {
    this.timeout(20000);
    for (let i = 0; i < 10; i++) {
      const block1 = await mineBlock(tip1, cb1);
      cb1 = block1.txs[0];

      const block2 = await mineBlock(tip2, cb2);
      cb2 = block2.txs[0];

      await chain.add(block1);

      await chain.add(block2);

      assert.bufferEqual(chain.tip.hash, block1.hash());

      tip1 = await chain.getEntry(block1.hash());
      tip2 = await chain.getEntry(block2.hash());

      assert(tip1);
      assert(tip2);

      assert(!await chain.isMainChain(tip2));

      await new Promise(setImmediate);
    }
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 24002210000);
    assert.strictEqual(chain.db.state.coin, 21);
    assert.strictEqual(chain.db.state.tx, 21);
  });

  it('should have correct balance', async () => {
    await new Promise(r => setTimeout(r, 100));

    const balance = await wallet.getBalance();
    assert.strictEqual(balance.unconfirmed, 22000 * consensus.COIN);
    assert.strictEqual(balance.confirmed, 22000 * consensus.COIN);
  });

  it('should handle a reorg', async () => {
    assert.strictEqual(wdb.state.height, chain.height);
    assert.strictEqual(chain.height, 11);

    const entry = await chain.getEntry(tip2.hash);
    assert(entry);
    assert.strictEqual(chain.height, entry.height);

    const block = await miner.mineBlock(entry);
    assert(block);

    let forked = false;
    chain.once('reorganize', () => {
      forked = true;
    });

    await chain.add(block);

    assert(forked);
    assert.bufferEqual(chain.tip.hash, block.hash());
    assert(chain.tip.chainwork.gt(tip1.chainwork));
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 26002210000);
    assert.strictEqual(chain.db.state.coin, 22);
    assert.strictEqual(chain.db.state.tx, 22);
  });

  it('should have correct balance', async () => {
    await new Promise(r => setTimeout(r, 100));

    const balance = await wallet.getBalance();
    assert.strictEqual(balance.unconfirmed, 44000 * consensus.COIN);
    assert.strictEqual(balance.confirmed, 24000 * consensus.COIN);
  });

  it('should check main chain', async () => {
    const result = await chain.isMainChain(tip1);
    assert(!result);
  });

  it('should mine a block after a reorg', async () => {
    const block = await mineBlock(null, cb2);

    await chain.add(block);

    const entry = await chain.getEntry(block.hash());
    assert(entry);
    assert.bufferEqual(chain.tip.hash, entry.hash);

    const result = await chain.isMainChain(entry);
    assert(result);
  });

  it('should prevent double spend on new chain', async () => {
    const block = await mineBlock(null, cb2);
    const tip = chain.tip;

    let err;
    try {
      await chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.reason, 'bad-txns-inputs-missingorspent');
    assert.strictEqual(chain.tip, tip);
  });

  it('should fail to mine block with coins on an alternate chain', async () => {
    const block = await mineBlock(null, cb1);
    const tip = chain.tip;

    let err;
    try {
      await chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.reason, 'bad-txns-inputs-missingorspent');
    assert.strictEqual(chain.tip, tip);
  });

  it('should have correct chain value', () => {
    assert.strictEqual(chain.db.state.value, 28002210000);
    assert.strictEqual(chain.db.state.coin, 24);
    assert.strictEqual(chain.db.state.tx, 24);
  });

  it('should get coin', async () => {
    const block1 = await mineBlock();
    await chain.add(block1);

    const block2 = await mineBlock(null, block1.txs[0]);
    await chain.add(block2);

    const tx = block2.txs[1];
    const output = Coin.fromTX(tx, 1, chain.height);

    const coin = await chain.getCoin(tx.hash(), 1);

    assert.bufferEqual(coin.encode(), output.encode());
  });

  it('should get balance', async () => {
    await new Promise(r => setTimeout(r, 100));

    const balance = await wallet.getBalance();
    assert.strictEqual(balance.unconfirmed, 50000 * consensus.COIN);
    assert.strictEqual(balance.confirmed, 30000 * consensus.COIN);

    assert((await wallet.receiveDepth()) >= 7);
    assert((await wallet.changeDepth()) >= 6);

    assert.strictEqual(wdb.state.height, chain.height);

    const txs = await wallet.getHistory();
    assert.strictEqual(txs.length, 45);
  });

  it('should get tips and remove chains', async () => {
    {
      const tips = await chain.db.getTips();

      // assert.notStrictEqual(tips.indexOf(chain.tip.hash), -1);
      assert.strictEqual(tips.length, 2);
    }

    await chain.db.removeChains();

    {
      const tips = await chain.db.getTips();

      // assert.notStrictEqual(tips.indexOf(chain.tip.hash), -1);
      assert.strictEqual(tips.length, 1);
    }
  });

  it('should rescan for transactions', async () => {
    let total = 0;

    await chain.scan(0, wdb.filter, async (block, txs) => {
      total += txs.length;
    });

    assert.strictEqual(total, 26);
  });

  it('should test csv', async () => {
    const tx = (await chain.getBlock(chain.height)).txs[0];
    const csvBlock = await mineCSV(tx);

    await chain.add(csvBlock);

    const csv = csvBlock.txs[1];

    const spend = new MTX();

    spend.addOutput({
      address: Address.fromScript(csvScript2),
      value: 10 * consensus.COIN
    });

    spend.addTX(csv, 0);
    spend.inputs[0].witness.set(0, csvScript.encode());
    spend.setSequence(0, 1, false);

    const job = await miner.createJob();

    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    const block = await job.mineAsync();

    await chain.add(block);
  });

  it('should fail csv with bad sequence', async () => {
    const csv = (await chain.getBlock(chain.height)).txs[1];
    const spend = new MTX();

    spend.addOutput({
      address: Address.fromScript(csvScript),
      value: 10 * consensus.COIN
    });

    spend.addTX(csv, 0);
    spend.setSequence(0, 1, false);

    const job = await miner.createJob();

    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    const block = await job.mineAsync();

    let err;
    try {
      await chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert(err.reason, 'mandatory-script-verify-flag-failed');
  });

  it('should mine a block', async () => {
    const block = await miner.mineBlock();
    assert(block);
    await chain.add(block);
  });

  it('should fail csv lock checks', async () => {
    const tx = (await chain.getBlock(chain.height)).txs[0];
    const csvBlock = await mineCSV(tx);

    await chain.add(csvBlock);

    const csv = csvBlock.txs[1];

    const spend = new MTX();

    spend.addOutput({
      address: Address.fromScript(csvScript2),
      value: 10 * consensus.COIN
    });

    spend.addTX(csv, 0);
    spend.setSequence(0, 2, false);

    const job = await miner.createJob();

    job.addTX(spend.toTX(), spend.view);
    job.refresh();

    const block = await job.mineAsync();

    let err;
    try {
      await chain.add(block);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.reason, 'bad-txns-nonfinal');
  });

  it('should rescan for transactions', async () => {
    await wdb.rescan(0);
    assert.strictEqual((await wallet.getBalance()).confirmed, 37980000000);
  });

  it('should reset miner mempool', async () => {
    miner.mempool = node.mempool;
  });

  it('should get a block template', async () => {
    const json = await node.rpc.call({
      method: 'getblocktemplate',
      params: [],
      id: '1'
    }, {});

    assert(json.result && typeof json.result === 'object');
    assert(typeof json.result.curtime === 'number');
    assert(typeof json.result.mintime === 'number');
    assert(typeof json.result.maxtime === 'number');
    assert(typeof json.result.expires === 'number');

    assert.deepStrictEqual(json, {
      result: {
        capabilities: ['proposal'],
        mutable: ['time', 'transactions', 'prevblock'],
        version: 0,
        rules: [],
        vbavailable: {},
        vbrequired: 0,
        height: 20,
        previousblockhash: chain.tip.hash.toString('hex'),
        treeroot: network.genesis.treeRoot.toString('hex'),
        reservedroot: consensus.ZERO_HASH.toString('hex'),
        mask: json.result.mask,
        target:
          '7fffff0000000000000000000000000000000000000000000000000000000000',
        bits: '207fffff',
        noncerange: ''
          + '000000000000000000000000000000000000000000000000'
          + 'ffffffffffffffffffffffffffffffffffffffffffffffff',
        curtime: json.result.curtime,
        mintime: json.result.mintime,
        maxtime: json.result.maxtime,
        expires: json.result.expires,
        sigoplimit: 80000,
        sizelimit: 1000000,
        weightlimit: 4000000,
        longpollid: node.chain.tip.hash.toString('hex') + '00000000',
        submitold: false,
        coinbaseaux: { flags: '6d696e656420627920687364' },
        coinbasevalue: 2000000000,
        coinbasetxn: undefined,
        claims: [],
        airdrops: [],
        transactions: []
      },
      error: null,
      id: '1'
    });
  });

  it('should send a block template proposal', async () => {
    const attempt = await node.miner.createBlock();

    attempt.refresh();

    const block = attempt.toBlock();

    const hex = block.toHex();

    const json = await node.rpc.call({
      method: 'getblocktemplate',
      params: [{
        mode: 'proposal',
        data: hex
      }]
    }, {});

    assert(!json.error);
    assert.strictEqual(json.result, null);
  });

  it('should submit a block', async () => {
    const block = await node.miner.mineBlock();
    const hex = block.toHex();

    const json = await node.rpc.call({
      method: 'submitblock',
      params: [hex]
    }, {});

    assert(!json.error);
    assert.strictEqual(json.result, null);
    assert.bufferEqual(node.chain.tip.hash, block.hash());
  });

  it('should validate an address', async () => {
    const addr = new Address();

    const json = await node.rpc.call({
      method: 'validateaddress',
      params: [addr.toString(node.network)]
    }, {});

    assert.deepStrictEqual(json.result, {
      address: addr.toString(node.network),
      isvalid: true,
      isscript: false,
      isspendable: true,
      witness_version: addr.version,
      witness_program: addr.hash.toString('hex')
    });
  });

  it('should add transaction to mempool', async () => {
    const mtx = await wallet.createTX({
      rate: 100000,
      outputs: [{
        value: 100000,
        address: await wallet.receiveAddress()
      }]
    });

    await wallet.sign(mtx);

    assert(mtx.isSigned());

    const tx = mtx.toTX();

    await wdb.addTX(tx);

    const missing = await node.mempool.addTX(tx);
    assert(!missing);

    assert.strictEqual(node.mempool.map.size, 1);

    tx1 = mtx;
  });

  it('should add lesser transaction to mempool', async () => {
    const mtx = await wallet.createTX({
      rate: 1000,
      outputs: [{
        value: 50000,
        address: await wallet.receiveAddress()
      }]
    });

    await wallet.sign(mtx);

    assert(mtx.isSigned());

    const tx = mtx.toTX();

    await wdb.addTX(tx);

    const missing = await node.mempool.addTX(tx);
    assert(!missing);

    assert.strictEqual(node.mempool.map.size, 2);

    tx2 = mtx;
  });

  it('should get a block template', async () => {
    node.rpc.refreshBlock();

    const json = await node.rpc.call({
      method: 'getblocktemplate',
      params: [
        {rules: []}
      ],
      id: '1'
    }, {});

    assert(!json.error);
    assert(json.result);

    const result = json.result;

    let fees = 0;
    let weight = 0;

    for (const item of result.transactions) {
      fees += item.fee;
      weight += item.weight;
    }

    assert.strictEqual(result.transactions.length, 2);
    assert.strictEqual(fees, tx1.getFee() + tx2.getFee());
    assert.strictEqual(weight, tx1.getWeight() + tx2.getWeight());
    // XXX
    // assert.strictEqual(result.transactions[0].hash, tx1.txid());
    // assert.strictEqual(result.transactions[1].hash, tx2.txid());
    assert.strictEqual(result.coinbasevalue, 2000 * consensus.COIN + fees);
  });

  it('should get raw transaction', async () => {
    const json = await node.rpc.call({
      method: 'getrawtransaction',
      params: [tx2.txid()],
      id: '1'
    }, {});

    assert(!json.error);
    const tx = TX.fromHex(json.result);
    assert.strictEqual(tx.txid(), tx2.txid());
  });

  it('should get raw transaction (verbose=true)', async () => {
    const json = await node.rpc.call({
      method: 'getrawtransaction',
      params: [tx2.txid(), true],
      id: '1'
    }, {});

    assert(!json.error);
    const tx = TX.fromHex(json.result.hex);

    assert.equal(json.result.vin.length, tx.inputs.length);
    assert.equal(json.result.vout.length, tx.outputs.length);

    for (const [i, vout] of json.result.vout.entries()) {
      const output = tx.output(i);
      assert.equal(vout.address.version, output.address.version);
      assert.equal(vout.address.string, output.address.toString(node.network));
      assert.equal(vout.address.hash, output.address.hash.toString('hex'));
    }
  });

  it('should prioritise transaction', async () => {
    const json = await node.rpc.call({
      method: 'prioritisetransaction',
      params: [tx2.txid(), 0, 10000000],
      id: '1'
    }, {});

    assert(!json.error);
    assert.strictEqual(json.result, true);
  });

  it('should get a block template', async () => {
    let fees = 0;
    let weight = 0;

    node.rpc.refreshBlock();

    const json = await node.rpc.call({
      method: 'getblocktemplate',
      params: [
        {rules: []}
      ],
      id: '1'
    }, {});

    assert(!json.error);
    assert(json.result);

    const result = json.result;

    for (const item of result.transactions) {
      fees += item.fee;
      weight += item.weight;
    }

    assert.strictEqual(result.transactions.length, 2);
    assert.strictEqual(fees, tx1.getFee() + tx2.getFee());
    assert.strictEqual(weight, tx1.getWeight() + tx2.getWeight());
    // XXX
    // assert.strictEqual(result.transactions[0].hash, tx2.txid());
    // assert.strictEqual(result.transactions[1].hash, tx1.txid());
    assert.strictEqual(result.coinbasevalue, 2000 * consensus.COIN + fees);
  });

  it('should get service names for rpc getnetworkinfo', async () => {
    const json = await node.rpc.call({
      method: 'getnetworkinfo'
    });

    assert.deepEqual(json.result.localservicenames, ['NETWORK', 'BLOOM']);
  });

  it('should cleanup', async () => {
    network.coinbaseMaturity = 2;
    await node.close();
  });
});
