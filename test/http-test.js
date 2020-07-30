/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const consensus = require('../lib/protocol/consensus');
const Address = require('../lib/primitives/address');
const Outpoint = require('../lib/primitives/outpoint');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const FullNode = require('../lib/node/fullnode');
const pkg = require('../lib/pkg');
const Network = require('../lib/protocol/network');
const network = Network.get('regtest');
const {ZERO_HASH} = consensus;

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const {NodeClient, WalletClient} = require('hs-client');

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

let wallet = null;

const {wdb} = node.require('walletdb');

let addr = null;
let hash = null;

describe('HTTP', function() {
  this.timeout(20000);

  it('should open node', async () => {
    await node.open();
    await nclient.open();
    await wclient.open();
  });

  it('should create wallet', async () => {
    const info = await wclient.createWallet('test');
    assert.strictEqual(info.id, 'test');
    wallet = wclient.wallet('test', info.token);
    await wallet.open();
  });

  it('should get info', async () => {
    const info = await nclient.getInfo();
    assert.strictEqual(info.network, node.network.type);
    assert.strictEqual(info.version, pkg.version);
    assert(info.pool);
    assert.strictEqual(info.pool.agent, node.pool.options.agent);
    assert(info.chain);
    assert.strictEqual(info.chain.height, 0);
    assert.strictEqual(info.chain.treeRoot, ZERO_HASH.toString('hex'));
    // state comes from genesis block
    assert.strictEqual(info.chain.state.tx, 1);
    assert.strictEqual(info.chain.state.coin, 1);
    assert.strictEqual(info.chain.state.burned, 0);
  });

  it('should get wallet info', async () => {
    const info = await wallet.getInfo();
    assert.strictEqual(info.id, 'test');
    const acct = await wallet.getAccount('default');
    const str = acct.receiveAddress;
    assert(typeof str === 'string');
    addr = Address.fromString(str, node.network);
  });

  it('should fill with funds', async () => {
    const mtx = new MTX();
    mtx.addOutpoint(new Outpoint(consensus.ZERO_HASH, 0));
    mtx.addOutput(addr, 50460);
    mtx.addOutput(addr, 50460);
    mtx.addOutput(addr, 50460);
    mtx.addOutput(addr, 50460);

    const tx = mtx.toTX();

    let balance = null;
    wallet.once('balance', (b) => {
      balance = b;
    });

    let receive = null;
    wallet.once('address', (r) => {
      receive = r[0];
    });

    let details = null;
    wallet.once('tx', (d) => {
      details = d;
    });

    await wdb.addTX(tx);
    await new Promise(r => setTimeout(r, 300));

    assert(receive);
    assert.strictEqual(receive.name, 'default');
    assert.strictEqual(receive.branch, 0);
    assert(balance);
    assert.strictEqual(balance.confirmed, 0);
    assert.strictEqual(balance.unconfirmed, 201840);
    assert(details);
    assert.strictEqual(details.hash, tx.txid());
  });

  it('should get balance', async () => {
    const balance = await wallet.getBalance();
    assert.strictEqual(balance.confirmed, 0);
    assert.strictEqual(balance.unconfirmed, 201840);
  });

  it('should send a tx', async () => {
    const options = {
      rate: 10000,
      outputs: [{
        value: 10000,
        address: addr.toString(node.network)
      }]
    };

    const tx = await wallet.send(options);

    assert(tx);
    assert.strictEqual(tx.inputs.length, 1);
    assert.strictEqual(tx.outputs.length, 2);

    let value = 0;
    value += tx.outputs[0].value;
    value += tx.outputs[1].value;

    assert.strictEqual(value, 49060);

    hash = tx.hash;
  });

  it('should get a tx', async () => {
    const tx = await wallet.getTX(hash);
    assert(tx);
    assert.strictEqual(tx.hash, hash);
  });

  it('should generate new api key', async () => {
    const old = wallet.token.toString('hex');
    const result = await wallet.retoken(null);
    assert.strictEqual(result.token.length, 64);
    assert.notStrictEqual(result.token, old);
  });

  it('should get balance', async () => {
    const balance = await wallet.getBalance();
    assert.strictEqual(balance.unconfirmed, 200440);
  });

  it('should execute an rpc call', async () => {
    const info = await nclient.execute('getblockchaininfo', []);
    assert.strictEqual(info.blocks, 0);
  });

  it('should execute an rpc call with bool parameter', async () => {
    const info = await nclient.execute('getrawmempool', [true]);
    assert.deepStrictEqual(info, {});
  });

  it('should create account', async () => {
    const info = await wallet.createAccount('foo1');
    assert(info);
    assert(info.initialized);
    assert.strictEqual(info.name, 'foo1');
    assert.strictEqual(info.accountIndex, 1);
    assert.strictEqual(info.m, 1);
    assert.strictEqual(info.n, 1);
  });

  it('should create account', async () => {
    const info = await wallet.createAccount('foo2', {
      type: 'multisig',
      m: 1,
      n: 2
    });
    assert(info);
    assert(!info.initialized);
    assert.strictEqual(info.name, 'foo2');
    assert.strictEqual(info.accountIndex, 2);
    assert.strictEqual(info.m, 1);
    assert.strictEqual(info.n, 2);
  });

  it('should get a block template', async () => {
    const json = await nclient.execute('getblocktemplate', []);
    assert.deepStrictEqual(json, {
      capabilities: ['proposal'],
      mutable: ['time', 'transactions', 'prevblock'],
      version: 0,
      rules: [],
      vbavailable: {},
      vbrequired: 0,
      height: 1,
      previousblockhash: network.genesis.hash.toString('hex'),
      treeroot: network.genesis.treeRoot.toString('hex'),
      reservedroot: consensus.ZERO_HASH.toString('hex'),
      mask: json.mask,
      target:
        '7fffff0000000000000000000000000000000000000000000000000000000000',
      bits: '207fffff',
      noncerange: ''
        + '000000000000000000000000000000000000000000000000'
        + 'ffffffffffffffffffffffffffffffffffffffffffffffff',
      curtime: json.curtime,
      mintime: 1580745081,
      maxtime: json.maxtime,
      expires: json.expires,
      sigoplimit: 80000,
      sizelimit: 1000000,
      weightlimit: 4000000,
      longpollid: node.chain.tip.hash.toString('hex') + '00000000',
      submitold: false,
      coinbaseaux: { flags: '6d696e656420627920687364' },
      coinbasevalue: 2000000000,
      claims: [],
      airdrops: [],
      transactions: []
    });
  });

  it('should send a block template proposal', async () => {
    const attempt = await node.miner.createBlock();
    const block = attempt.toBlock();
    const hex = block.toHex();
    const json = await nclient.execute('getblocktemplate', [{
      mode: 'proposal',
      data: hex
    }]);
    assert.strictEqual(json, null);
  });

  it('should validate an address', async () => {
    const json = await nclient.execute('validateaddress', [
      addr.toString(node.network)
    ]);
    assert.deepStrictEqual(json, {
      isvalid: true,
      isscript: false,
      isspendable: true,
      address: addr.toString(node.network),
      witness_program: addr.hash.toString('hex'),
      witness_version: addr.version
    });
  });

  it('should not validate invalid address', async () => {
    const json = await nclient.execute('validateaddress', [
      addr.toString('main')
    ]);
    assert.deepStrictEqual(json, {
      isvalid: false
    });
  });

  it('should validate a p2wsh address', async () => {
    const pubkeys = [];
    for (let i = 0; i < 2; i++) {
      const result = await wallet.createAddress('default');
      pubkeys.push(Buffer.from(result.publicKey, 'hex'));
    }

    const script = Script.fromMultisig(2, 2, pubkeys);
    const address = Address.fromScript(script);

    const json = await nclient.execute('validateaddress', [
      address.toString(node.network)
    ]);

    assert.deepStrictEqual(json, {
      address: address.toString(node.network),
      isscript: true,
      isspendable: true,
      isvalid: true,
      witness_version: address.version,
      witness_program: address.hash.toString('hex')
    });
  });

  it('should validate a null address', async () => {
    const data = Buffer.from('foobar', 'ascii');
    const nullAddr = Address.fromNulldata(data);

    const json = await nclient.execute('validateaddress', [
      nullAddr.toString(node.network)
    ]);

    assert.deepStrictEqual(json, {
      address: nullAddr.toString(node.network),
      isscript: false,
      isspendable: false,
      isvalid: true,
      witness_version: nullAddr.version,
      witness_program: nullAddr.hash.toString('hex')
    });
  });

  it('should get mempool rejection filter', async () => {
    const filterInfo = await nclient.get('/mempool/invalid', { verbose: true });

    assert.ok('items' in filterInfo);
    assert.ok('filter' in filterInfo);
    assert.ok('size' in filterInfo);
    assert.ok('entries' in filterInfo);
    assert.ok('n' in filterInfo);
    assert.ok('limit' in filterInfo);
    assert.ok('tweak' in filterInfo);

    assert.equal(filterInfo.entries, 0);
  });

  it('should add an entry to the mempool rejection filter', async () => {
    const mtx = new MTX();
    mtx.addOutpoint(new Outpoint(consensus.ZERO_HASH, 0));

    const raw = mtx.toHex();
    const txid = await nclient.execute('sendrawtransaction', [raw]);

    const json = await nclient.get(`/mempool/invalid/${txid}`);
    assert.equal(json.invalid, true);

    const filterInfo = await nclient.get('/mempool/invalid');
    assert.equal(filterInfo.entries, 1);
  });

  it('should generate 10 blocks from RPC call', async () => {
    const blocks = await nclient.execute('generatetoaddress', [10, addr.toString(network)]);
    assert.strictEqual(blocks.length, 10);
  });

  // depends on the previous test to generate blocks
  it('should fetch block header by height', async () => {
    // fetch corresponding header and block
    const height = 7;
    const header = await nclient.get(`/header/${height}`);
    assert.equal(header.height, height);

    const properties = [
      'hash', 'version', 'prevBlock',
      'merkleRoot', 'time', 'bits',
      'nonce', 'height', 'chainwork'
    ];

    for (const property of properties)
      assert(property in header);

    const block = await nclient.getBlock(height);

    assert.equal(block.hash, header.hash);
    assert.equal(block.height, header.height);
    assert.equal(block.version, header.version);
    assert.equal(block.prevBlock, header.prevBlock);
    assert.equal(block.merkleRoot, header.merkleRoot);
    assert.equal(block.time, header.time);
    assert.equal(block.bits, header.bits);
    assert.equal(block.nonce, header.nonce);
  });

  it('should fetch null for block header that does not exist', async () => {
    // many blocks in the future
    const header = await nclient.get(`/header/${40000}`);
    assert.equal(header, null);
  });

  it('should have valid header chain', async () => {
    // starting at the genesis block
    let prevBlock = '0000000000000000000000000000000000000000000000000000000000000000';
    for (let i = 0; i < 10; i++) {
      const header = await nclient.get(`/header/${i}`);

      assert.equal(prevBlock, header.prevBlock);
      prevBlock = header.hash;
    }
  });

  it('should fetch block header by hash', async () => {
    const info = await nclient.getInfo();

    const headerByHash = await nclient.get(`/header/${info.chain.tip}`);
    const headerByHeight = await nclient.get(`/header/${info.chain.height}`);

    assert.deepEqual(headerByHash, headerByHeight);
  });

  it('should cleanup', async () => {
    await wallet.close();
    await wclient.close();
    await nclient.close();
    await node.close();
  });
});
