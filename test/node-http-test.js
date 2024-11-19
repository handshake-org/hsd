'use strict';

const assert = require('bsert');
const bio = require('bufio');
const Address = require('../lib/primitives/address');
const Mnemonic = require('../lib/hd/mnemonic');
const Witness = require('../lib/script/witness');
const Script = require('../lib/script/script');
const HDPrivateKey = require('../lib/hd/private');
const Output = require('../lib/primitives/output');
const Block = require('../lib/primitives/block');
const Coin = require('../lib/primitives/coin');
const MTX = require('../lib/primitives/mtx');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
const NodeContext = require('./util/node-context');
const pkg = require('../lib/pkg');
const mnemonics = require('./data/mnemonic-english.json');
const consensus = require('../lib/protocol/consensus');
const Outpoint = require('../lib/primitives/outpoint');
const ChainEntry = require('../lib/blockchain/chainentry');
const {ZERO_HASH} = consensus;

// Commonly used test mnemonic
const phrase = mnemonics[0][1];

describe('Node HTTP', function() {
  describe('Mempool', function() {
    let nodeCtx, nclient;

    beforeEach(async () => {
      nodeCtx = new NodeContext();

      await nodeCtx.open();
      nclient = nodeCtx.nclient;
    });

    afterEach(async () => {
      await nodeCtx.close();
      nodeCtx = null;
    });

    it('should get mempool rejection filter', async () => {
      const filterInfo = await nclient.getMempoolRejectionFilter({
        verbose: true
      });

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

      const json = await nclient.checkMempoolRejectionFilter(txid);
      assert.equal(json.invalid, true);

      const filterInfo = await nclient.getMempoolRejectionFilter();
      assert.equal(filterInfo.entries, 1);
    });
  });

  describe('Blockheader', function() {
    let nodeCtx, nclient;

    beforeEach(async () => {
      nodeCtx = new NodeContext();
      await nodeCtx.open();
      nclient = nodeCtx.nclient;
    });

    afterEach(async () => {
      await nodeCtx.close();
      nodeCtx = null;
    });

    it('should fetch block header by height', async () => {
      await nclient.execute(
        'generatetoaddress',
        [8, 'rs1q7q3h4chglps004u3yn79z0cp9ed24rfrhvrxnx']
      );

      // fetch corresponding header and block
      const height = 7;
      const header = await nclient.getBlockHeader(height);
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
      const header = await nclient.getBlockHeader(40000);
      assert.equal(header, null);
    });

    it('should have valid header chain', async () => {
      await nclient.execute(
        'generatetoaddress',
        [10, 'rs1q7q3h4chglps004u3yn79z0cp9ed24rfrhvrxnx']
      );

      // starting at the genesis block
      let prevBlock = '0000000000000000000000000000000000000000000000000000000000000000';

      for (let i = 0; i < 10; i++) {
        const header = await nclient.getBlockHeader(i);

        assert.equal(prevBlock, header.prevBlock);
        prevBlock = header.hash;
      }
    });

    it('should fetch block header by hash', async () => {
      const info = await nclient.getInfo();

      const headerByHash = await nclient.getBlockHeader(info.chain.tip);
      const headerByHeight = await nclient.getBlockHeader(info.chain.height);

      assert.deepEqual(headerByHash, headerByHeight);
    });
  });

  describe('Chain info', function() {
    let nodeCtx;

    afterEach(async () => {
      await nodeCtx.close();
      nodeCtx = null;
    });

    it('should get info', async () => {
      nodeCtx = new NodeContext();
      await nodeCtx.open();

      const {node, nclient, network} = nodeCtx;

      const info = await nclient.getInfo();
      assert.strictEqual(info.network, network.type);
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

    it('should get full node chain info', async () => {
      nodeCtx = new NodeContext({
        network: 'regtest'
      });

      await nodeCtx.open();
      const {chain} = await nodeCtx.nclient.getInfo();
      assert.strictEqual(chain.height, 0);
      assert.strictEqual(chain.tip, nodeCtx.network.genesis.hash.toString('hex'));
      assert.strictEqual(chain.treeRoot, Buffer.alloc(32, 0).toString('hex'));
      assert.strictEqual(chain.progress, 0);
      assert.strictEqual(chain.indexers.indexTX, false);
      assert.strictEqual(chain.indexers.indexAddress, false);
      assert.strictEqual(chain.options.spv, false);
      assert.strictEqual(chain.options.prune, false);
      assert.strictEqual(chain.treeCompaction.compacted, false);
      assert.strictEqual(chain.treeCompaction.compactOnInit, false);
      assert.strictEqual(chain.treeCompaction.compactInterval, null);
      assert.strictEqual(chain.treeCompaction.nextCompaction, null);
      assert.strictEqual(chain.treeCompaction.lastCompaction, null);
    });

    it('should get fullnode chain info with indexers', async () => {
      nodeCtx = new NodeContext({
        network: 'regtest',
        indexAddress: true,
        indexTX: true
      });

      await nodeCtx.open();
      const {chain} = await nodeCtx.nclient.getInfo();
      assert.strictEqual(chain.indexers.indexTX, true);
      assert.strictEqual(chain.indexers.indexAddress, true);
    });

    it('should get fullnode chain info with pruning', async () => {
      nodeCtx = new NodeContext({
        network: 'regtest',
        prune: true
      });

      await nodeCtx.open();

      const {chain} = await nodeCtx.nclient.getInfo();
      assert.strictEqual(chain.options.prune, true);
    });

    it('should get fullnode chain info with compact', async () => {
      nodeCtx = new NodeContext({
        network: 'regtest',
        compactTreeOnInit: true,
        compactTreeInitInterval: 20000
      });

      await nodeCtx.open();

      const {chain} = await nodeCtx.nclient.getInfo();
      assert.strictEqual(chain.treeCompaction.compacted, false);
      assert.strictEqual(chain.treeCompaction.compactOnInit, true);
      assert.strictEqual(chain.treeCompaction.compactInterval, 20000);
      assert.strictEqual(chain.treeCompaction.lastCompaction, null);
      // last compaction height + keepBlocks + compaction interval
      // regtest: 0 + 10000 + 20000
      assert.strictEqual(chain.treeCompaction.nextCompaction, 30000);
    });

    it('should get spv node chain info', async () => {
      nodeCtx = new NodeContext({
        network: 'regtest',
        spv: true
      });

      await nodeCtx.open();

      const {chain} = await nodeCtx.nclient.getInfo();
      assert.strictEqual(chain.options.spv, true);
    });

    it('should get next tree update height', async () => {
      const someAddr = 'rs1q7q3h4chglps004u3yn79z0cp9ed24rfrhvrxnx';
      nodeCtx = new NodeContext({
        network: 'regtest'
      });

      await nodeCtx.open();
      const interval = nodeCtx.network.names.treeInterval;

      const nclient = nodeCtx.nclient;
      const node = nodeCtx.node;

      {
        // 0th block will be 0.
        const {chain} = await nclient.getInfo();
        assert.strictEqual(chain.treeRootHeight, 0);
      }

      // blocks from 1 - 4 will be 1.
      // last block commits the tree root.
      for (let i = 0; i < interval - 1; i++) {
        await node.rpc.generateToAddress([1, someAddr]);
        const {chain} = await nclient.getInfo();
        assert.strictEqual(chain.treeRootHeight, 1);
      }

      {
        // block 5 is also 1 and it commits the new root.
        await node.rpc.generateToAddress([1, someAddr]);
        const {chain} = await nclient.getInfo();
        assert.strictEqual(chain.treeRootHeight, 1);
      }

      for (let i = 0; i < interval; i++) {
        await node.rpc.generateToAddress([1, someAddr]);
        const {chain} = await nclient.getInfo();
        assert.strictEqual(chain.treeRootHeight, interval + 1);
      }

      // This block will be part of the new tree batch.
      await node.rpc.generateToAddress([1, someAddr]);
      const {chain} = await nclient.getInfo();
      assert.strictEqual(chain.treeRootHeight, interval * 2 + 1);
    });
  });

  describe('Networking info', function() {
    let nodeCtx = null;

    afterEach(async () => {
      if (nodeCtx)
        await nodeCtx.close();
    });

    it('should not have public address: regtest', async () => {
      nodeCtx = new NodeContext({
        network: 'regtest'
      });

      await nodeCtx.open();
      const {network, nclient} = nodeCtx;

      const {pool} = await nclient.getInfo();

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
      nodeCtx = new NodeContext({
        network: 'regtest',
        listen: true
      });

      await nodeCtx.open();
      const {network, nclient} = nodeCtx;
      const {pool} = await nclient.getInfo();

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
      nodeCtx = new NodeContext({
        network: 'main'
      });

      await nodeCtx.open();
      const {network, nclient} = nodeCtx;

      const {pool} = await nclient.getInfo();

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
      nodeCtx = new NodeContext({
        network: 'main',
        listen: true
      });

      await nodeCtx.open();
      const {network, nclient} = nodeCtx;

      const {pool} = await nclient.getInfo();

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
      const publicHost = '100.200.11.22';
      const publicPort = 11111;
      const publicBrontidePort = 22222;

      nodeCtx = new NodeContext({
        network: 'main',
        listen: true,
        publicHost,
        publicPort,
        publicBrontidePort
      });

      await nodeCtx.open();
      const {network, nclient} = nodeCtx;

      const {pool} = await nclient.getInfo();

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

  describe('Websockets', function() {
    this.timeout(15000);

    describe('Get entry', function() {
      const nodeCtx = new NodeContext({
        wallet: true
      });

      nodeCtx.init();

      const {nclient} = nodeCtx;

      before(async () => {
        await nodeCtx.open();

        const {address} = await nodeCtx.wclient.createAddress('primary', 'default');
        await mineBlocks(nodeCtx, 15, address);
      });

      after(async () => {
        await nodeCtx.close();
      });

      it('should get entry by height', async () => {
        const rawEntry = await nclient.getEntry(0);
        assert(rawEntry && rawEntry.length > 0);

        const entry = ChainEntry.decode(rawEntry);
        assert(entry);
        assert.strictEqual(entry.height, 0);
      });

      it('should get last entry by height', async () => {
        const rawTip = await nclient.getTip();
        assert(rawTip);
        const tip = ChainEntry.decode(rawTip);
        assert(tip);
        assert.strictEqual(tip.height, 15);

        const rawEntry = await nclient.getEntry(tip.height);
        assert(rawEntry && rawEntry.length > 0);
        const entry = ChainEntry.decode(rawEntry);
        assert(entry);
        assert.strictEqual(entry.height, 15);
        assert.bufferEqual(entry.hash, tip.hash);
      });

      it('should get all entries by hash', async () => {
        const tip = ChainEntry.decode(await nclient.getTip());
        assert(tip);

        let entry;
        let hash = tip.hash;
        let height = tip.height;
        do {
          const rawEntry = await nclient.getEntry(hash);
          assert(rawEntry);

          entry = ChainEntry.decode(rawEntry);
          assert.strictEqual(entry.height, height--);

          hash = entry.prevBlock;
        } while (entry.height > 0);
      });
    });

    describe('get hashes and entries', function() {
      const nodeCtx = new NodeContext({
        wallet: true
      });

      nodeCtx.init();

      const {nclient, network} = nodeCtx;
      const genesisBlock = Block.decode(network.genesisBlock);
      let minedHashes;

      before(async () => {
        await nodeCtx.open();

        const {address} = await nodeCtx.wclient.createAddress('primary', 'default');
        minedHashes = await mineBlocks(nodeCtx, 15, address);
      });

      after(async () => {
        await nodeCtx.close();
      });

      it('should get hashes by range', async () => {
        const hashes = await nclient.getHashes(0, 15);
        assert(hashes && hashes.length === 16);

        for (const [index, hash] of hashes.entries()) {
          if (index === 0) {
            assert.bufferEqual(hash, genesisBlock.hash());
            continue;
          }

          assert.bufferEqual(hash, minedHashes[index - 1]);
        }
      });

      it('should get entries by range', async () => {
        const entries = await nclient.getEntries(0, 15);
        assert(entries && entries.length === 16);

        for (const rawEntry of entries) {
          const entry = ChainEntry.decode(rawEntry);
          const gotEntry = await nclient.getEntry(entry.hash);
          assert.bufferEqual(rawEntry, gotEntry);
        }
      });
    });

    describe('tree commit', () => {
      const {types} = rules;

      const nodeCtx = new NodeContext({
        apiKey: 'foo',
        indexTx: true,
        indexAddress: true,
        rejectAbsurdFees: false
      });

      nodeCtx.init();

      const {network, nclient} = nodeCtx;
      const {treeInterval} = network.names;

      let privkey, pubkey;
      let socketData, mempoolData;
      let cbAddress;

      before(async () => {
        await nodeCtx.open();
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

        nodeCtx.mempool.on('tx', (tx) => {
          mempoolData[tx.txid()] = true;
        });
      });

      after(async () => {
        await nodeCtx.close();
      });

      beforeEach(() => {
        socketData = [];
        mempoolData = {};
      });

      it('should mine 1 tree interval', async () => {
        await mineBlocks(nodeCtx, treeInterval, cbAddress);
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

        assert.ok(nodeCtx.chain.height > coin.height + network.coinbaseMaturity);
        mtx.addCoin(coin);

        const addr = Address.fromPubkey(pubkey);
        const script = Script.fromPubkeyhash(addr.hash);

        const sig = mtx.signature(0, script, coin.value, privkey);
        mtx.inputs[0].witness = Witness.fromItems([sig, pubkey]);

        const valid = mtx.verify();
        assert.ok(valid);

        const tx = mtx.toTX();
        await nodeCtx.node.sendTX(tx);

        await common.forValue(mempoolData, tx.txid(), true);

        const pre = await nclient.getInfo();

        const mempool = await nclient.getMempool();
        assert.equal(mempool[0], mtx.txid());

        await mineBlocks(nodeCtx, treeInterval, cbAddress);
        assert.equal(socketData.length, 1);

        const {root, block, entry} = socketData[0];
        assert.bufferEqual(nodeCtx.chain.db.treeRoot(), root);

        const info = await nclient.getInfo();
        assert.notEqual(pre.chain.tip, info.chain.tip);

        assert.equal(info.chain.tip, block.hash);
        assert.equal(info.chain.tip, entry.hash);
      });
    });
  });
});

async function mineBlocks(nodeCtx, count, address) {
  const blockEvents = common.forEvent(
    nodeCtx.nclient.socket.events,
    'block connect',
    count
  );

  const blocks = await nodeCtx.mineBlocks(count, address);
  await blockEvents;
  return blocks.map(block => block.hash().toString('hex'));
}
