/* eslint-env mocha */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const {rimraf, testdir} = require('./util/common');

describe('Node Critical Error', function() {
  this.timeout(30000);

  let prefix, node;

  beforeEach(async () => {
    prefix = testdir('hsd-critical-error-test');
    node = new FullNode({
      memory: false,
      network: 'regtest',
      prefix
    });
    await node.ensure();
    await node.open();
  });

  afterEach(async () => {
    if (node && node.opened)
      await node.close();
    await rimraf(prefix);
  });

  async function mineBlocks(node, count) {
    for (let i = 0; i < count; i++) {
      if (!node || !node.opened)
        break;

      const block = await node.miner.mineBlock(
        null,
        'rs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqn6kda'
      );

      try {
        // We are catching this error in the test but normally
        // it would bubble up all the way from blockstore to Peer,
        // where it is caught and logged, then we disconnect the peer
        // that sent us whatever data caused the error (even if it's our fault!)
        //
        // [error] (net) Could not write block.
        //   at FileBlockStore._write (hsd/lib/blockstore/file.js:424:13)
        //   at async FileBatch.write (hsd/lib/blockstore/file.js:755:11)
        //   at async ChainDB.commit (hsd/lib/blockchain/chaindb.js:332:7)
        //   at async ChainDB.save (hsd/lib/blockchain/chaindb.js:1531:5)
        //   at async Chain.setBestChain (hsd/lib/blockchain/chain.js:1835:5)
        //   at async Chain.connect (hsd/lib/blockchain/chain.js:2236:7)
        //   at async Chain._add (hsd/lib/blockchain/chain.js:2145:19)
        //   at async Chain.add (hsd/lib/blockchain/chain.js:2073:14)
        //   at async Pool._addBlock (hsd/lib/net/pool.js:2459:15)
        //   at async Pool.addBlock (hsd/lib/net/pool.js:2426:14)
        //   at async Pool.handleBlock (hsd/lib/net/pool.js:2410:5)
        //   at async Pool.handlePacket (hsd/lib/net/pool.js:1331:9)
        //   at async Peer.handlePacket (hsd/lib/net/peer.js:1549:7)
        //   at async Peer.readPacket (hsd/lib/net/peer.js:1486:11)
        //   at async Parser.<anonymous> (hsd/lib/net/peer.js:185:9)
        await node.chain.add(block);
      } catch (e) {
        assert.strictEqual(e.message, 'Critical Error: Disk full!');
        assert.strictEqual(e.type, 'CriticalError');
        break;
      }
    }
  }

  it('should not run out of disk space', async () => {
    await mineBlocks(node, 100);
    assert.strictEqual(node.chain.height, 100);
    assert.strictEqual(node.opened, true);
    assert.strictEqual(node.chain.opened, true);
    assert.strictEqual(node.chain.db.db.loaded, true);
    assert.strictEqual(node.chain.db.blocks.db.loaded, true);
    await node.close();
    assert.strictEqual(node.opened, false);
    assert.strictEqual(node.chain.opened, false);
    assert.strictEqual(node.chain.db.db.loaded, false);
    assert.strictEqual(node.chain.db.blocks.db.loaded, false);
  });

  it('should run out of disk space on block write and abort', async () => {
    const waiter = new Promise((resolve) => {
      node.once('closed', () => resolve());
    });

    node.on('abort', async () => {
      try {
        await node.close();
      } catch (e) {
        ;
      }
    });

    await mineBlocks(node, 99);
    node.chain.db.db.batch = () => {
      return {
        clear: () => {},
        put: () => {},
        del: () => {},
        write: () => {
          throw new Error('Disk full!');
        }
      };
    };
    await mineBlocks(node, 1);
    await waiter;
    assert.strictEqual(node.opened, false);
    assert.strictEqual(node.chain.opened, false);
    assert.strictEqual(node.chain.db.db.loaded, false);
    assert.strictEqual(node.chain.db.blocks.db.loaded, false);
  });

  it('should run out of disk space on tree commit and abort', async () => {
    const waiter = new Promise((resolve) => {
      node.once('closed', () => resolve());
    });

    node.on('abort', async () => {
      try {
        await node.close();
      } catch (e) {
        ;
      }
    });

    await mineBlocks(node, 50);
    node.chain.db.tree.store.commit = () => {
      throw new Error('Disk full!');
    };
    await mineBlocks(node, 50);
    await waiter;
    assert.strictEqual(node.opened, false);
    assert.strictEqual(node.chain.opened, false);
    assert.strictEqual(node.chain.db.db.loaded, false);
    assert.strictEqual(node.chain.db.blocks.db.loaded, false);
  });
});
