'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const Network = require('../lib/protocol/network');
const consensus = require('../lib/protocol/consensus');
const MemWallet = require('./util/memwallet');
const TX = require('../lib/primitives/tx');
const {NodeClient} = require('hs-client');

const TIMEOUT = 15000;
const API_KEY = 'foo';
const NETWORK = 'regtest';

const ports = {
  p2p: 49331,
  node: 49332,
  wallet: 49333
};

const nodeOptions = {
  network: NETWORK,
  apiKey: API_KEY,
  walletAuth: true,
  memory: true,
  workers: true,
  workersSize: 2,
  port: ports.p2p,
  httpPort: ports.node
};

const clientOptions = {
  port: ports.node,
  apiKey: API_KEY,
  timeout: TIMEOUT
};

const errs = {
  MISC_ERROR: -1
};

describe('RPC', function() {
  this.timeout(15000);

  describe('getblock', function () {
    const node = new FullNode(nodeOptions);
    const nclient = new NodeClient(clientOptions);

    before(async () => {
      await node.open();
      await nclient.open();
    });

    after(async () => {
      await nclient.close();
      await node.close();
    });

    it('should rpc getblock', async () => {
      const {chain} = await nclient.getInfo();
      const info = await nclient.execute('getblock', [chain.tip]);

      const properties = [
        'hash', 'confirmations', 'strippedsize',
        'size', 'weight', 'height', 'version',
        'versionHex', 'merkleroot', 'witnessroot',
        'treeroot', 'reservedroot', 'mask',
        'coinbase', 'tx', 'time', 'mediantime',
        'nonce', 'bits', 'difficulty', 'chainwork',
        'nTx', 'previousblockhash', 'nextblockhash'
      ];

      for (const property of properties)
        assert(property in info);

      assert.deepEqual(chain.height, info.height);
      assert.deepEqual(chain.tip, info.hash);
      assert.deepEqual(chain.treeRoot, info.treeroot);
    });

    it('should return correct height', async () => {
      const address = 'rs1qjjpnmnrzfvxgqlqf5j48j50jmq9pyqjz0a7ytz';

      // Mine two blocks.
      await nclient.execute('generatetoaddress', [2, address]);

      const {chain} = await nclient.getInfo();
      const info = await nclient.execute('getblock', [chain.tip]);

      // Assert the heights match.
      assert.deepEqual(chain.height, info.height);
    });

    it('should return confirmations (main chain)', async () => {
      const {chain} = await nclient.getInfo();

      const {genesis} = node.network;
      const hash = genesis.hash.toString('hex');

      const info = await nclient.execute('getblock', [hash]);
      assert.deepEqual(chain.height, info.confirmations - 1);
    });

    it('should return confirmations (post reorg)', async () => {
      // Get the current chain state
      const {chain} = await nclient.getInfo();

      // Get the chain entry associated with
      // the genesis block.
      const {genesis} = node.network;
      let entry = await node.chain.getEntry(genesis.hash);

      // Reorg from the genesis block.
      for (let i = 0; i < chain.height + 1; i++) {
        const block = await node.miner.mineBlock(entry);
        await node.chain.add(block);
        entry = await node.chain.getEntry(block.hash());
      }

      // Call getblock using the previous tip
      const info = await nclient.execute('getblock', [chain.tip]);
      assert.deepEqual(info.confirmations, -1);
    });

    it('should return confirmations (alternate)', async () => {
      // Get a previous blockheight
      const height = node.chain.height - 2;
      assert(height > 0);

      // Get the entry and mine on it.
      const entry = await node.chain.getEntryByHeight(height);

      const block = await node.miner.mineBlock(entry);
      assert(await node.chain.add(block));

      const hash = block.hash().toString('hex');
      const info = await nclient.execute('getblock', [hash]);
      assert.deepEqual(info.confirmations, -1);
    });

    it('should validateresource (valid)', async () => {
      const records = [
        [{type: 'NS', ns: 'ns1.handshake.org.'}],
        [{type: 'DS', keyTag: 0xffff, algorithm: 0xff, digestType: 0xff, digest: '00'.repeat(32)}],
        [{type: 'TXT', txt: ['i like turtles', 'then who phone']}],
        [{type: 'GLUE4', ns: 'ns1.nam.ek.', address: '192.168.0.1'}],
        [{type: 'GLUE6', ns: 'ns2.nam.ek.', address: '::'}],
        [{type: 'SYNTH4', address: '192.168.0.1'}],
        [{type: 'SYNTH6', address: '::'}]
      ];

      for (const record of records) {
        const data = {records: record};
        const info = await nclient.execute('validateresource', [data]);
        assert.deepEqual(info, data);
      }
    });

    it('should validateresource (invalid)', async () => {
      const records = [
        [
          // No trailing dot
          [{type: 'NS', ns: 'ns1.handshake.org'}],
          'Invalid NS record. ns must be a valid name.'
        ],
        [
          [{type: 'DS', keyTag: 0xffffff}],
          'Invalid DS record. KeyTag must be a uint16.'
        ],
        [
          [{type: 'DS', keyTag: 0xffff, algorithm: 0xffff}],
          'Invalid DS record. Algorithm must be a uint8.'
        ],
        [
          [{type: 'DS', keyTag: 0xffff, algorithm: 0xff, digestType: 0xffff}],
          'Invalid DS record. DigestType must be a uint8.'
        ],
        [
          [{type: 'DS', keyTag: 0xffff, algorithm: 0xff, digestType: 0xff, digest: Buffer.alloc(0)}],
          'Invalid DS record. Digest must be a String.'
        ],
        [
          [{type: 'DS', keyTag: 0xffff, algorithm: 0xff, digestType: 0xff, digest: '00'.repeat(256)}],
          'Invalid DS record. Digest is too large.'
        ],
        [
          [{type: 'TXT', txt: 'foobar'}],
          'Invalid TXT record. txt must be an Array.'
        ],
        [
          [{type: 'TXT', txt: [{}]}],
          'Invalid TXT record. Entries in txt Array must be type String.'
        ],
        [
          [{type: 'TXT', txt: ['0'.repeat(256)]}],
          'Invalid TXT record. Entries in txt Array must be <= 255 in length.'
        ],
        [
          [{type: 'GLUE4', ns: 'ns1.nam.ek', address: '192.168.0.1'}],
          'Invalid GLUE4 record. ns must be a valid name.'
        ],
        [
          [{type: 'GLUE4', ns: 'ns1.nam.ek.', address: '::'}],
          'Invalid GLUE4 record. Address must be a valid IPv4 address.'
        ],
        [
          [{type: 'GLUE6', ns: 'ns1.nam.ek', address: '::'}],
          'Invalid GLUE6 record. ns must be a valid name.'
        ],
        [
          [{type: 'GLUE6', ns: 'ns1.nam.ek.', address: '0.0.0.0'}],
          'Invalid GLUE6 record. Address must be a valid IPv6 address.'
        ],
        [
          [{type: 'SYNTH4', address: '::'}],
          'Invalid SYNTH4 record. Address must be a valid IPv4 address.'
        ],
        [
          [{type: 'SYNTH6', address: '127.0.0.1'}],
          'Invalid SYNTH6 record. Address must be a valid IPv6 address.'
        ]
      ];

      for (const [record, reason] of records) {
        try {
          const data = {records: record};
          await nclient.execute('validateresource', [data]);
          assert.fail();
        } catch (e) {
          assert.equal(e.message, reason);
        }
      }
    });
  });

  describe('pruneblockchain', function() {
    const network = Network.get(NETWORK);
    const PRUNE_AFTER_HEIGHT = network.block.pruneAfterHeight;
    const KEEP_BLOCKS = network.KEEP_BLOCKS;

    const TEST_KEEP_BLOCKS = 10;
    const TEST_PRUNED_BLOCKS = 10;
    const TEST_PRUNE_AFTER_HEIGHT = 10;

    let nclient, node;

    before(() => {
      network.block.pruneAfterHeight = TEST_PRUNE_AFTER_HEIGHT;
      network.block.keepBlocks = TEST_KEEP_BLOCKS;
    });

    after(() => {
      network.block.pruneAfterHeight = PRUNE_AFTER_HEIGHT;
      network.block.keepBlocks = KEEP_BLOCKS;
    });

    afterEach(async () => {
      if (nclient && nclient.opened)
        await nclient.close();

      if (node && node.opened)
        await node.close();
    });

    it('should fail with wrong arguments', async () => {
      node = new FullNode(nodeOptions);
      nclient = new NodeClient(clientOptions);

      await node.open();

      await assert.rejects(async () => {
        await nclient.execute('pruneblockchain', [1]);
      }, {
        code: errs.MISC_ERROR,
        type: 'RPCError',
        message: 'pruneblockchain'
      });

      await node.close();
    });

    it('should not work for spvnode', async () => {
      node = new SPVNode(nodeOptions);
      nclient = new NodeClient(clientOptions);

      await node.open();

      await assert.rejects(async () => {
        await nclient.execute('pruneblockchain');
      }, {
        type: 'RPCError',
        message: 'Cannot prune chain in SPV mode.',
        code: errs.MISC_ERROR
      });

      await node.close();
    });

    it('should fail for pruned node', async () => {
      node = new FullNode({
        ...nodeOptions,
        prune: true
      });

      await node.open();

      await assert.rejects(async () => {
        await nclient.execute('pruneblockchain');
      }, {
        type: 'RPCError',
        code: errs.MISC_ERROR,
        message: 'Chain is already pruned.'
      });

      await node.close();
    });

    it('should fail for short chain', async () => {
      node = new FullNode(nodeOptions);

      await node.open();

      await assert.rejects(async () => {
        await nclient.execute('pruneblockchain');
      }, {
        type: 'RPCError',
        code: errs.MISC_ERROR,
        message: 'Chain is too short for pruning.'
      });

      await node.close();
    });

    it('should prune chain', async () => {
      // default - prune: false
      node = new FullNode(nodeOptions);
      nclient = new NodeClient(clientOptions);

      await node.open();

      const addr = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';
      node.miner.addAddress(addr);

      let genBlocks = TEST_PRUNE_AFTER_HEIGHT;
      genBlocks += TEST_PRUNED_BLOCKS;
      genBlocks += TEST_KEEP_BLOCKS;

      // generate 30 blocks.
      // similar to chain-rpc-test
      const blocks = await nclient.execute('generate', [genBlocks]);

      // make sure we have all the blocks.
      for (let i = 0; i < genBlocks; i++) {
        const block = await nclient.execute('getblock', [blocks[i]]);
        assert(block);
      }

      // now prune..
      await nclient.execute('pruneblockchain');

      let i = 0;

      // behind height check
      let to = TEST_PRUNE_AFTER_HEIGHT;
      for (; i < to; i++) {
        const block = await nclient.execute('getblock', [blocks[i]]);
        assert(block, 'could not get block before height check.');
      }

      // pruned blocks.
      to += TEST_PRUNED_BLOCKS;
      for (; i < to; i++) {
        await assert.rejects(async () => {
          await nclient.execute('getblock', [blocks[i]]);
        }, {
          type: 'RPCError',
          code: errs.MISC_ERROR,
          message: 'Block not available (pruned data)'
        });
      }

      // keep blocks
      to += TEST_KEEP_BLOCKS;
      for (; i < to; i++) {
        const block = await nclient.execute('getblock', [blocks[i]]);
        assert(block, `block ${i} was pruned.`);
      }

      await node.close();
    });
  });

  describe('mining', function() {
    const node = new FullNode(nodeOptions);
    const nclient = new NodeClient(clientOptions);

    const wallet = new MemWallet({
      network: NETWORK
    });

    let mtx1, mtx2;

    before(async () => {
      await node.open();
      await nclient.open();
    });

    after(async () => {
      await nclient.close();
      await node.close();
    });

    it('should submit a block', async () => {
      const block = await node.miner.mineBlock();
      const hex = block.toHex();

      const result = await nclient.execute('submitblock', [hex]);

      assert.strictEqual(result, null);
      assert.bufferEqual(node.chain.tip.hash, block.hash());
    });

    it('should add transactions to mempool', async () => {
      // Fund MemWallet
      node.miner.addresses.length = 0;
      node.miner.addAddress(wallet.getReceive());
      for (let i = 0; i < 10; i++) {
        const block = await node.miner.mineBlock();
        const entry = await node.chain.add(block);
        wallet.addBlock(entry, block.txs);
      }

      // High fee
      mtx1 = await wallet.send({
        rate: 100000,
        outputs: [{
          value: 100000,
          address: wallet.getReceive()
        }]
      });
      await node.mempool.addTX(mtx1.toTX());

      // Low fee
      mtx2 = await wallet.send({
        rate: 10000,
        outputs: [{
          value: 100000,
          address: wallet.getReceive()
        }]
      });
      await node.mempool.addTX(mtx2.toTX());

      assert.strictEqual(node.mempool.map.size, 2);
    });

    it('should get a block template', async () => {
      node.rpc.refreshBlock();

      const result = await nclient.execute(
        'getblocktemplate',
         [{rules: []}]
      );

      let fees = 0;
      let weight = 0;

      for (const item of result.transactions) {
        fees += item.fee;
        weight += item.weight;
      }

      assert.strictEqual(result.transactions.length, 2);
      assert.strictEqual(fees, mtx1.getFee() + mtx2.getFee());
      assert.strictEqual(weight, mtx1.getWeight() + mtx2.getWeight());
      assert.strictEqual(result.transactions[0].txid, mtx1.txid());
      assert.strictEqual(result.transactions[1].txid, mtx2.txid());
      assert.strictEqual(result.coinbasevalue, 2000 * consensus.COIN + fees);
    });

    it('should prioritise transaction', async () => {
      const result = await nclient.execute(
        'prioritisetransaction',
        [mtx2.txid(), 0, 10000000]
      );

      assert.strictEqual(result, true);
    });

    it('should get a block template', async () => {
      let fees = 0;
      let weight = 0;

      node.rpc.refreshBlock();

      const result = await nclient.execute(
        'getblocktemplate',
         [{rules: []}]
      );

      for (const item of result.transactions) {
        fees += item.fee;
        weight += item.weight;
      }

      assert.strictEqual(result.transactions.length, 2);
      assert.strictEqual(fees, mtx1.getFee() + mtx2.getFee());
      assert.strictEqual(weight, mtx1.getWeight() + mtx2.getWeight());
      // TX order is swapped from last test due to priortization
      assert.strictEqual(result.transactions[1].txid, mtx1.txid());
      assert.strictEqual(result.transactions[0].txid, mtx2.txid());
      assert.strictEqual(result.coinbasevalue, 2000 * consensus.COIN + fees);
    });

    it('should mine a block', async () => {
      const block = await node.miner.mineBlock();
      assert(block);
      await node.chain.add(block);
    });
  });

  describe('transactions', function() {
    const node = new FullNode({...nodeOptions, indexTx: true});
    const nclient = new NodeClient(clientOptions);

    const wallet = new MemWallet({
      network: NETWORK
    });

    let tx1;

    before(async () => {
      await node.open();
      await nclient.open();
    });

    after(async () => {
      await nclient.close();
      await node.close();
    });

    it('should confirm a transaction in a block', async () => {
      // Fund MemWallet
      node.miner.addresses.length = 0;
      node.miner.addAddress(wallet.getReceive());
      for (let i = 0; i < 10; i++) {
        const block = await node.miner.mineBlock();
        const entry = await node.chain.add(block);
        wallet.addBlock(entry, block.txs);
      }

      const mtx1 = await wallet.send({
        rate: 100000,
        outputs: [{
          value: 100000,
          address: wallet.getReceive()
        }]
      });
      tx1 = mtx1.toTX();
      await node.mempool.addTX(tx1);

      assert.strictEqual(node.mempool.map.size, 1);

      const block = await node.miner.mineBlock();
      assert(block);
      assert.strictEqual(block.txs.length, 2);
      await node.chain.add(block);
    });

    it('should get raw transaction', async () => {
      const result = await nclient.execute(
        'getrawtransaction',
        [tx1.txid()]
      );

      const tx = TX.fromHex(result);
      assert.strictEqual(tx.txid(), tx1.txid());
    });

    it('should get raw transaction (verbose=true)', async () => {
      const result = await nclient.execute(
        'getrawtransaction',
        [tx1.txid(), true]
      );

      const tx = TX.fromHex(result.hex);

      assert.equal(result.vin.length, tx.inputs.length);
      assert.equal(result.vout.length, tx.outputs.length);

      for (const [i, vout] of result.vout.entries()) {
        const output = tx.output(i);
        assert.equal(vout.address.version, output.address.version);
        assert.equal(vout.address.string, output.address.toString(node.network));
        assert.equal(vout.address.hash, output.address.hash.toString('hex'));
      }
    });
  });

  describe('networking', function() {
    const node = new FullNode({...nodeOptions, bip37: true});
    const nclient = new NodeClient(clientOptions);

    before(async () => {
      await node.open();
      await nclient.open();
    });

    after(async () => {
      await nclient.close();
      await node.close();
    });

    it('should get service names for rpc getnetworkinfo', async () => {
      const result = await nclient.execute('getnetworkinfo', []);

      assert.deepEqual(result.localservicenames, ['NETWORK', 'BLOOM']);
    });
  });

  describe('utility', function() {
    const node = new FullNode({...nodeOptions});
    const nclient = new NodeClient(clientOptions);

    before(async () => {
      await node.open();
      await nclient.open();
    });

    after(async () => {
      await nclient.close();
      await node.close();
    });

    it('should decode resource', async () => {
      // .p resource at mainnet height 118700
      const result = await nclient.execute(
        'decoderesource',
        [
          '0002036e733101700022858d9e01c00200c625080220d96' +
          '65e9952988fc27b1d4098491b37d83a3b6fb2cdf5fc9787' +
          'd4dda67f1408ed001383080220ae8ea2f2800727f9ad3b6' +
          'd7c802dac2a0790bdc8ea717bf5f6dc21f83fb8cc4e'
        ]
      );

      assert.deepEqual(
        result,
        {
          records: [
            {
              type: 'GLUE4',
              ns: 'ns1.p.',
              address: '34.133.141.158'
            },
            {
              type: 'NS',
              ns: 'ns1.p.'
            },
            {
              type: 'DS',
              keyTag: 50725,
              algorithm: 8,
              digestType: 2,
              digest: 'd9665e9952988fc27b1d4098491b37d83a3b6fb2cdf5fc9787d4dda67f1408ed'
            },
            {
              type: 'DS',
              keyTag: 4995,
              algorithm: 8,
              digestType: 2,
              digest: 'ae8ea2f2800727f9ad3b6d7c802dac2a0790bdc8ea717bf5f6dc21f83fb8cc4e'
            }
          ]
        }
      );
    });
  });
});
