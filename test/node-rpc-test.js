/**
 * test/node-rpc-test.js - Node RPC tests for hsd
 * Copyright (c) 2020, The Handshake Developers (MIT Licence)
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const {NodeClient} = require('hs-client');

const ports = {
  p2p: 49331,
  node: 49332,
  wallet: 49333
};
const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  workersSize: 2,
  port: ports.p2p,
  httpPort: ports.node
});

const nclient = new NodeClient({
  port: ports.node,
  apiKey: 'foo',
  timeout: 15000
});

describe('RPC', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
  });

  after(async () => {
    await nclient.close();
    await node.close();
  });

  describe('getblock', function () {
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
});
