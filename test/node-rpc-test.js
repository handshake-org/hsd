'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const consensus = require('../lib/protocol/consensus');
const MemWallet = require('./util/memwallet');
const TX = require('../lib/primitives/tx');
const NodeContext = require('./util/node-context');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');

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
  memory: true,
  workers: true,
  workersSize: 2,
  port: ports.p2p,
  httpPort: ports.node
};

const errs = {
  MISC_ERROR: -1
};

describe('RPC', function() {
  this.timeout(15000);

  describe('getblockchaininfo', function() {
    const nodeCtx = new NodeContext(nodeOptions);
    nodeCtx.init();
    const nclient = nodeCtx.nclient;

    before(async () => {
      await nodeCtx.open();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should get blockchain info', async () => {
      const info = await nclient.execute('getblockchaininfo', []);
      assert.strictEqual(info.chain, NETWORK);
      assert.strictEqual(info.blocks, 0);
      assert.strictEqual(info.headers, 0);
      assert.strictEqual(info.pruned, false);
    });
  });

  describe('getrawmempool', function() {
    const nodeCtx = new NodeContext(nodeOptions);
    nodeCtx.init();
    const nclient = nodeCtx.nclient;

    before(async () => {
      await nodeCtx.open();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should get raw mempool', async () => {
      const hashes = await nclient.execute('getrawmempool', [true]);
      assert.deepEqual(hashes, {});
    });
  });

  describe('getblock', function () {
    let nodeCtx, nclient, node;

    before(async () => {
      nodeCtx = new NodeContext({
        ...nodeOptions,
        name: 'node-rpc-test'
      });

      await nodeCtx.open();
      nclient = nodeCtx.nclient;
      node = nodeCtx.node;
    });

    after(async () => {
      await nodeCtx.close();
      nodeCtx = null;
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
      await nodeCtx.mineBlocks(2, address);

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
  });

  describe('pruneblockchain', function() {
    const network = Network.get(NETWORK);
    const PRUNE_AFTER_HEIGHT = network.block.pruneAfterHeight;
    const KEEP_BLOCKS = network.KEEP_BLOCKS;

    const TEST_KEEP_BLOCKS = 10;
    const TEST_PRUNED_BLOCKS = 10;
    const TEST_PRUNE_AFTER_HEIGHT = 10;

    let nodeCtx;

    before(() => {
      network.block.pruneAfterHeight = TEST_PRUNE_AFTER_HEIGHT;
      network.block.keepBlocks = TEST_KEEP_BLOCKS;
    });

    after(() => {
      network.block.pruneAfterHeight = PRUNE_AFTER_HEIGHT;
      network.block.keepBlocks = KEEP_BLOCKS;
    });

    afterEach(async () => {
      if (nodeCtx)
        await nodeCtx.close();
    });

    it('should fail with wrong arguments', async () => {
      nodeCtx = new NodeContext(nodeOptions);
      await nodeCtx.open();

      await assert.rejects(async () => {
        await nodeCtx.nclient.execute('pruneblockchain', [1]);
      }, {
        code: errs.MISC_ERROR,
        type: 'RPCError',
        message: 'pruneblockchain'
      });
    });

    it('should not work for spvnode', async () => {
      nodeCtx = new NodeContext({
        ...nodeOptions,
        spv: true
      });

      await nodeCtx.open();

      await assert.rejects(async () => {
        await nodeCtx.nclient.execute('pruneblockchain');
      }, {
        type: 'RPCError',
        message: 'Cannot prune chain in SPV mode.',
        code: errs.MISC_ERROR
      });
    });

    it('should fail for pruned node', async () => {
      nodeCtx = new NodeContext({
        ...nodeOptions,
        prune: true
      });
      await nodeCtx.open();

      await assert.rejects(async () => {
        await nodeCtx.nclient.execute('pruneblockchain');
      }, {
        type: 'RPCError',
        code: errs.MISC_ERROR,
        message: 'Chain is already pruned.'
      });
    });

    it('should fail for short chain', async () => {
      nodeCtx = new NodeContext(nodeOptions);
      await nodeCtx.open();

      await assert.rejects(async () => {
        await nodeCtx.nclient.execute('pruneblockchain');
      }, {
        type: 'RPCError',
        code: errs.MISC_ERROR,
        message: 'Chain is too short for pruning.'
      });
    });

    it('should prune chain', async () => {
      // default - prune: false
      nodeCtx = new NodeContext(nodeOptions);
      await nodeCtx.open();
      const {miner, nclient} = nodeCtx;

      const addr = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';
      miner.addAddress(addr);

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
    });
  });

  describe('mining', function() {
    const nodeCtx = new NodeContext(nodeOptions);
    nodeCtx.init();
    const {
      miner,
      chain,
      mempool,
      nodeRPC,
      nclient
    } = nodeCtx;

    const wallet = new MemWallet({
      network: NETWORK
    });

    let mtx1, mtx2;

    before(async () => {
      await nodeCtx.open();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should get a block template', async () => {
      const {network, chain} = nodeCtx;
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
        longpollid: chain.tip.hash.toString('hex') + '00000000',
        submitold: false,
        coinbaseaux: { flags: '6d696e656420627920687364' },
        coinbasevalue: 2000000000,
        claims: [],
        airdrops: [],
        transactions: []
      });
    });

    it('should send a block template proposal', async () => {
      const {node} = nodeCtx;
      const attempt = await node.miner.createBlock();
      const block = attempt.toBlock();
      const hex = block.toHex();
      const json = await nclient.execute('getblocktemplate', [{
        mode: 'proposal',
        data: hex
      }]);
      assert.strictEqual(json, null);
    });

    it('should submit a block', async () => {
      const block = await miner.mineBlock();
      const hex = block.toHex();

      const result = await nclient.execute('submitblock', [hex]);

      assert.strictEqual(result, null);
      assert.bufferEqual(chain.tip.hash, block.hash());
    });

    it('should add transactions to mempool', async () => {
      // Fund MemWallet
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
      for (let i = 0; i < 10; i++) {
        const block = await miner.mineBlock();
        const entry = await chain.add(block);
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
      await mempool.addTX(mtx1.toTX());

      // Low fee
      mtx2 = await wallet.send({
        rate: 10000,
        outputs: [{
          value: 100000,
          address: wallet.getReceive()
        }]
      });
      await mempool.addTX(mtx2.toTX());

      assert.strictEqual(mempool.map.size, 2);
    });

    it('should get a block template', async () => {
      nodeRPC.refreshBlock();

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

      nodeRPC.refreshBlock();

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
      const block = await miner.mineBlock();
      assert(block);
      await chain.add(block);
    });
  });

  describe('transactions', function() {
    const nodeCtx = new NodeContext({
      ...nodeOptions,
      indexTX: true
    });
    nodeCtx.init();

    const {
      miner,
      chain,
      mempool,
      nclient
    } = nodeCtx;

    const wallet = new MemWallet({
      network: NETWORK
    });

    let tx1;

    before(async () => {
      await nodeCtx.open();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should confirm a transaction in a block', async () => {
      // Fund MemWallet
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
      for (let i = 0; i < 10; i++) {
        const block = await miner.mineBlock();
        const entry = await chain.add(block);
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

      await mempool.addTX(tx1);

      assert.strictEqual(mempool.map.size, 1);

      const block = await miner.mineBlock();
      assert(block);
      assert.strictEqual(block.txs.length, 2);
      await chain.add(block);
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
        assert.equal(vout.address.string, output.address.toString(nodeCtx.network));
        assert.equal(vout.address.hash, output.address.hash.toString('hex'));
      }
    });
  });

  describe('networking', function() {
    const nodeCtx = new NodeContext({ ...nodeOptions, bip37: true });
    nodeCtx.init();
    const nclient = nodeCtx.nclient;

    before(async () => {
      await nodeCtx.open();
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should get service names for rpc getnetworkinfo', async () => {
      const result = await nclient.execute('getnetworkinfo', []);

      assert.deepEqual(result.localservicenames, ['NETWORK', 'BLOOM']);
    });
  });

  describe('DNS Utility', function() {
    const nodeCtx = new NodeContext(nodeOptions);
    nodeCtx.init();
    const nclient = nodeCtx.nclient;

    before(async () => {
      await nodeCtx.open();
    });

    after(async () => {
      await nodeCtx.close();
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

  describe('Address Utility', function() {
    const nodeCtx = new NodeContext({
      ...nodeOptions,
      wallet: true
    });

    nodeCtx.init();

    const {
      node,
      nclient,
      wdb
    } = nodeCtx;

    let wallet, addr;

    before(async () => {
      await nodeCtx.open();
      wallet = await wdb.create({ id: 'test'});
    });

    after(async () => {
      await nodeCtx.close();
    });

    it('should validate an address', async () => {
      addr = await wallet.receiveAddress('default');
      const json = await nclient.execute('validateaddress', [
        addr.toString(nodeCtx.network)
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
        const result = await wallet.receiveKey('default');
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
  });
});
