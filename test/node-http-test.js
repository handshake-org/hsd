'use strict';

const assert = require('bsert');
const bio = require('bufio');
const NodeClient = require('../lib/client/node');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const Address = require('../lib/primitives/address');
const Mnemonic = require('../lib/hd/mnemonic');
const Witness = require('../lib/script/witness');
const Script = require('../lib/script/script');
const HDPrivateKey = require('../lib/hd/private');
const Output = require('../lib/primitives/output');
const Coin = require('../lib/primitives/coin');
const MTX = require('../lib/primitives/mtx');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
const mnemonics = require('./data/mnemonic-english.json');
// Commonly used test mnemonic
const phrase = mnemonics[0][1];

describe('Node HTTP', function() {
  describe('Networking info', function() {
    it('should not have public address: regtest', async () => {
      const network = Network.get('regtest');

      const node = new FullNode({
        network: network.type
      });

      const nclient = new NodeClient({
        port: network.rpcPort
      });

      await node.open();
      await node.connect();
      const {pool} = await nclient.getInfo();
      await node.close();

      assert.strictEqual(pool.host, '0.0.0.0');
      assert.strictEqual(pool.port, network.port);
      assert.strictEqual(pool.brontidePort, network.brontidePort);

      const {public: pub} = pool;

      assert.strictEqual(pub.listen, false);
      assert.strictEqual(pub.host, null);
      assert.strictEqual(pub.port, null);
      assert.strictEqual(pub.brontidePort, null);
    });

    it('should not have public address: regtest, listen', async () => {
      const network = Network.get('regtest');

      const node = new FullNode({
        network: network.type,
        listen: true
      });

      const nclient = new NodeClient({
        port: network.rpcPort
      });

      await node.open();
      await node.connect();
      const {pool} = await nclient.getInfo();
      await node.close();

      assert.strictEqual(pool.host, '0.0.0.0');
      assert.strictEqual(pool.port, network.port);
      assert.strictEqual(pool.brontidePort, network.brontidePort);

      const {public: pub} = pool;

      assert.strictEqual(pub.listen, true);
      assert.strictEqual(pub.host, null); // we don't discover from external
      assert.strictEqual(pub.port, null);
      assert.strictEqual(pub.brontidePort, null);
    });

    it('should not have public address: main', async () => {
      const network = Network.get('main');

      const node = new FullNode({
        network: network.type
      });

      const nclient = new NodeClient({
        port: network.rpcPort
      });

      await node.open();
      await node.connect();
      const {pool} = await nclient.getInfo();
      await node.close();

      assert.strictEqual(pool.host, '0.0.0.0');
      assert.strictEqual(pool.port, network.port);
      assert.strictEqual(pool.brontidePort, network.brontidePort);

      const {public: pub} = pool;

      assert.strictEqual(pub.listen, false);
      assert.strictEqual(pub.host, null);
      assert.strictEqual(pub.port, null);
      assert.strictEqual(pub.brontidePort, null);
    });

    it('should not have public address: main, listen', async () => {
      const network = Network.get('main');

      const node = new FullNode({
        network: network.type,
        listen: true
      });

      const nclient = new NodeClient({
        port: network.rpcPort
      });

      await node.open();
      await node.connect();
      const {pool} = await nclient.getInfo();
      await node.close();

      assert.strictEqual(pool.host, '0.0.0.0');
      assert.strictEqual(pool.port, network.port);
      assert.strictEqual(pool.brontidePort, network.brontidePort);

      const {public: pub} = pool;

      assert.strictEqual(pub.listen, true);
      assert.strictEqual(pub.host, null);
      assert.strictEqual(pub.port, null);
      assert.strictEqual(pub.brontidePort, null);
    });

    it('should have public address: main, listen, publicHost', async () => {
      const network = Network.get('main');
      const publicHost = '100.200.11.22';
      const publicPort = 11111;
      const publicBrontidePort = 22222;

      const node = new FullNode({
        network: network.type,
        listen: true,
        publicHost,
        publicPort,
        publicBrontidePort
      });

      const nclient = new NodeClient({
        port: network.rpcPort
      });

      await node.open();
      await node.connect();
      const {pool} = await nclient.getInfo();
      await node.close();

      assert.strictEqual(pool.host, '0.0.0.0');
      assert.strictEqual(pool.port, network.port);
      assert.strictEqual(pool.brontidePort, network.brontidePort);

      const {public: pub} = pool;

      assert.strictEqual(pub.listen, true);
      assert.strictEqual(pub.host, publicHost);
      assert.strictEqual(pub.port, publicPort);
      assert.strictEqual(pub.brontidePort, publicBrontidePort);
    });
  });

  describe('Websockets', function () {
    this.timeout(15000);

    describe('tree commit', () => {
      const network = Network.get('regtest');
      const {types} = rules;

      const node = new FullNode({
        network: 'regtest',
        apiKey: 'foo',
        walletAuth: true,
        memory: true,
        indexTx: true,
        indexAddress: true,
        rejectAbsurdFees: false
      });

      const nclient = new NodeClient({
        port: network.rpcPort,
        apiKey: 'foo'
      });

      const {treeInterval} = network.names;

      let privkey, pubkey;
      let socketData, mempoolData;
      let cbAddress;

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

      before(async () => {
        await node.open();
        await nclient.open();
        await nclient.call('watch chain');

        const mnemonic = Mnemonic.fromPhrase(phrase);
        const priv = HDPrivateKey.fromMnemonic(mnemonic);
        const type = network.keyPrefix.coinType;
        const key = priv.derive(44, true).derive(type, true).derive(0, true);
        const xkey = key.derive(0).derive(0);

        socketData = [];
        mempoolData = {};
        pubkey = xkey.publicKey;
        privkey = xkey.privateKey;

        cbAddress = Address.fromPubkey(pubkey).toString(network.type);

        nclient.bind('tree commit', (root, entry, block) => {
          assert.ok(root);
          assert.ok(block);
          assert.ok(entry);

          socketData.push({root, entry, block});
        });

        node.mempool.on('tx', (tx) => {
          mempoolData[tx.txid()] = true;
        });
      });

      after(async () => {
        await nclient.close();
        await node.close();
      });

      beforeEach(() => {
        socketData = [];
        mempoolData = {};
      });

      it('should mine 1 tree interval', async () => {
        await mineBlocks(treeInterval, cbAddress);
        assert.equal(socketData.length, 1);
      });

      it('should send the correct tree root', async () => {
        const name = await nclient.execute('grindname', [5]);
        const rawName = Buffer.from(name, 'ascii');
        const nameHash = rules.hashName(rawName);

        const u32 = Buffer.alloc(4);
        bio.writeU32(u32, 0, 0);

        const output = new Output({
          address: cbAddress,
          value: 0,
          covenant: {
            type: types.OPEN,
            items: [nameHash, u32, rawName]
          }
        });

        const mtx = new MTX();
        mtx.addOutput(output);

        const coins = await nclient.getCoinsByAddresses([cbAddress]);
        coins.sort((a, b) => a.height - b.height);
        const coin = Coin.fromJSON(coins[0]);

        assert.ok(node.chain.height > coin.height + network.coinbaseMaturity);
        mtx.addCoin(coin);

        const addr = Address.fromPubkey(pubkey);
        const script = Script.fromPubkeyhash(addr.hash);

        const sig = mtx.signature(0, script, coin.value, privkey);
        mtx.inputs[0].witness = Witness.fromItems([sig, pubkey]);

        const valid = mtx.verify();
        assert.ok(valid);

        const tx = mtx.toTX();
        await node.sendTX(tx);

        await common.forValue(mempoolData, tx.txid(), true);

        const pre = await nclient.getInfo();

        const mempool = await nclient.getMempool();
        assert.equal(mempool[0], mtx.txid());

        await mineBlocks(treeInterval, cbAddress);
        assert.equal(socketData.length, 1);

        const {root, block, entry} = socketData[0];
        assert.bufferEqual(node.chain.db.treeRoot(), root);

        const info = await nclient.getInfo();
        assert.notEqual(pre.chain.tip, info.chain.tip);

        assert.equal(info.chain.tip, block.hash);
        assert.equal(info.chain.tip, entry.hash);
      });
    });
  });
});

