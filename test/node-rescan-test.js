'use strict';

const assert = require('bsert');
const {BufferSet} = require('buffer-map');
const {BloomFilter} = require('@handshake-org/bfilter');
const TX = require('../lib/primitives/tx');
const nodeCommon = require('../lib/blockchain/common');
const {scanAction} = nodeCommon;
const NodeContext = require('./util/node');
const {forEvent} = require('./util/common');
const MemWallet = require('./util/memwallet');
const rules = require('../lib/covenants/rules');

describe('Node Rescan Interactive API', function() {
  const TIMEOUT = 10000;

  this.timeout(TIMEOUT);

  /** @type {NodeContext} */
  let nodeCtx;
  let funderWallet;

  const RESCAN_DEPTH = 10;
  const names = [];
  const addresses = [];
  // store txs by height.
  const allTXs = {};
  const addressTXs = {};
  const txHashTXs = {};
  const nameHashTXs = {};
  // use smaller filters than the default
  const addressFilter = BloomFilter.fromRate(10000, 0.001);
  const txHashFilter = BloomFilter.fromRate(10000, 0.001);
  const nameHashFilter = BloomFilter.fromRate(10000, 0.001);

  // test matrix
  const tests = [{
    name: 'all',
    filter: null,
    txs: allTXs,
    // +1 for the coinbase tx
    txCountCheck: (height, txs) => txs.length === allTXs[height].length + 1
  }, {
    name: 'txhash',
    filter: txHashFilter,
    txs: txHashTXs,
    // This has LOW Chance of failing because of the BloomFilter nature.
    txCountCheck: (height, txs) => txs.length === txHashTXs[height].length
  }, {
    name: 'address',
    filter: addressFilter,
    txs: addressTXs,
    // We can't do exact check because filter get's updated.
    // (TODO: Add non-updating filter test
    //  issue - https://github.com/handshake-org/hsd/issues/855)
    txCountCheck: (height, txs) => txs.length >= addressTXs[height].length
  }, {
    name: 'namehash',
    filter: nameHashFilter,
    txs: nameHashTXs,
    // We can't do exact check because filter get's updated.
    // (TODO: Add non-updating filter test
    //  issue - https://github.com/handshake-org/hsd/issues/855)
    txCountCheck: (height, txs) => txs.length >= nameHashTXs[height].length
  }];

  before(async () => {
    nodeCtx = new NodeContext();
    const {network} = nodeCtx;

    funderWallet = new MemWallet({ network });

    await nodeCtx.open();

    nodeCtx.on('connect', (entry, block) => {
      funderWallet.addBlock(entry, block.txs);
    });

    nodeCtx.miner.addAddress(funderWallet.getReceive());

    // Prepare addresses bloom filter.
    const walletForAddrs = new MemWallet({ network });

    for (let i = 0; i < RESCAN_DEPTH; i++) {
      const addr = walletForAddrs.createReceive();
      const hash = addr.getHash();
      addressFilter.add(hash);
      addresses.push(addr.getAddress().toString(network));
    }

    {
      // generate 20 blocks.
      const blockEvents = forEvent(nodeCtx, 'block', 20);

      for (let i = 0; i < 20; i++) {
        const block = await nodeCtx.miner.mineBlock();
        await nodeCtx.chain.add(block);
      }

      await blockEvents;
    }

    // For 10 blocks create 3 different kind of transactions for each filter:
    //   1. regular send to address.
    //   2. regular send but only txhash
    //   3. name open
    {
      const blockEvents = forEvent(nodeCtx, 'block', RESCAN_DEPTH);

      for (let i = 0; i < RESCAN_DEPTH; i++) {
        const name = rules.grindName(20, nodeCtx.height, nodeCtx.network);
        const nameHash = rules.hashName(name, nodeCtx.network);
        nameHashFilter.add(nameHash);
        names.push(name);

        const openTX = await funderWallet.sendOpen(name);
        const sendTX = await funderWallet.send({
          outputs: [{
            address: addresses[i],
            value: 1e4
          }]
        });

        const normalTX = await funderWallet.send({});
        const txHash = normalTX.hash();

        allTXs[nodeCtx.height + 1] = [openTX, sendTX, normalTX];
        addressTXs[nodeCtx.height + 1] = [sendTX];
        txHashTXs[nodeCtx.height + 1] = [normalTX];
        nameHashTXs[nodeCtx.height + 1] = [openTX];

        txHashFilter.add(txHash);

        const txEvents = forEvent(nodeCtx.mempool, 'tx', 3);
        await nodeCtx.mempool.addTX(openTX.toTX());
        await nodeCtx.mempool.addTX(sendTX.toTX());
        await nodeCtx.mempool.addTX(normalTX.toTX());
        await txEvents;

        const block = await nodeCtx.miner.mineBlock();
        await nodeCtx.chain.add(block);
      }

      await blockEvents;
    };
  });

  after(async () => {
    await nodeCtx.close();
    await nodeCtx.destroy();
  });

  for (const test of tests) {
    it(`should rescan all blocks with ${test.name} filter`, async () => {
      const {node} = nodeCtx;
      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;
      let count = 0;

      await node.scanInteractive(startHeight, test.filter, async (entry, txs) => {
        assert.strictEqual(entry.height, startHeight + count);
        count++;

        const testTXs = test.txs[entry.height];

        assert(test.txCountCheck(entry.height, txs));
        const hashset = txsToTXHashes(txs);

        for (const tx of testTXs)
          assert(hashset.has(tx.hash()));

        return {
          type: scanAction.NEXT
        };
      });
    });

    it(`should rescan only 5 blocks and stop with ${test.name} filter`, async () => {
      const {node} = nodeCtx;
      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;
      let count = 0;

      const iter = async (entry, txs) => {
        assert.strictEqual(entry.height, startHeight + count);

        const testTXs = test.txs[entry.height];

        assert(test.txCountCheck(entry.height, txs));
        const hashset = txsToTXHashes(txs);

        for (const tx of testTXs)
          assert(hashset.has(tx.hash()));

        count++;

        if (count === 5) {
          return {
            type: scanAction.ABORT
          };
        }

        return {
          type: scanAction.NEXT
        };
      };

      let err;
      try {
        await node.scanInteractive(startHeight, test.filter, iter);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'scan request aborted.');
      assert.strictEqual(count, 5);
    });

    it(`should rescan the same block 5 times with ${test.name} filter (REPEAT_SET)`, async () => {
      const {node} = nodeCtx;
      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

      let count = 0;
      const iter = async (entry, txs) => {
        // we are repeating same block.
        assert.strictEqual(entry.height, startHeight);
        assert(test.txCountCheck(entry.height, txs));

        count++;

        if (count === 5) {
          return {
            type: scanAction.ABORT
          };
        }

        return {
          type: scanAction.REPEAT_SET,
          filter: test.filter
        };
      };

      let err;
      try {
        await node.scanInteractive(startHeight, test.filter, iter);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'scan request aborted.');
      assert.strictEqual(count, 5);
    });

    it(`should rescan the same block 5 times with ${test.name} filter (REPEAT)`, async () => {
      const {node} = nodeCtx;
      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

      let count = 0;
      const iter = async (entry, txs) => {
        // we are repeating same block.
        assert.strictEqual(entry.height, startHeight);
        assert(test.txCountCheck(entry.height, txs));

        count++;

        if (count === 5) {
          return {
            type: scanAction.ABORT
          };
        }

        return {
          type: scanAction.REPEAT
        };
      };

      let err;
      try {
        await node.scanInteractive(startHeight, test.filter, iter);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, 'scan request aborted.');
      assert.strictEqual(count, 5);
    });
  }

  it('should rescan the same block with updated filters (REPEAT_SET)', async () => {
    const {node} = nodeCtx;
    const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

    const filterAndTxs = tests.slice();
    let test = filterAndTxs.shift();

    // initial run is the first filter test.
    let count = 0;
    const iter = async (entry, txs) => {
      count++;

      // we are repeating same block.
      assert.strictEqual(entry.height, startHeight);

      // we are testing against the current filter.
      assert(test.txCountCheck(entry.height, txs));

      if (filterAndTxs.length === 0) {
        return {
          type: scanAction.ABORT
        };
      }

      // next test
      test = filterAndTxs.shift();

      return {
        type: scanAction.REPEAT_SET,
        filter: test.filter
      };
    };

    let err;
    try {
      await node.scanInteractive(startHeight, test.filter, iter);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, 'scan request aborted.');
    assert.strictEqual(count, tests.length);
  });

  it('should rescan the same block with updated filters (REPEAT_ADD)', async () => {
    const {node} = nodeCtx;
    const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

    const filter = BloomFilter.fromRate(10000, 0.001);
    const testTXs = allTXs[startHeight].slice();
    let expected = 0;

    const iter = async (entry, txs) => {
      // we are repeating same block.
      assert.strictEqual(entry.height, startHeight);
      // May fail sometimes (BloomFilter)
      assert.strictEqual(txs.length, expected);

      if (testTXs.length === 0) {
        return {
          type: scanAction.ABORT
        };
      }

      // next test
      const tx = testTXs.shift();
      const chunks = [tx.hash()];
      expected++;

      return {
        type: scanAction.REPEAT_ADD,
        chunks: chunks
      };
    };

    let err;
    try {
      await node.scanInteractive(startHeight, filter, iter);
    } catch (e) {
      err = e;
    }

    assert(err);
    assert.strictEqual(err.message, 'scan request aborted.');
  });

  it('should rescan in parallel', async () => {
    const {node} = nodeCtx;
    const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

    const events = [];
    const getIter = (counterObj) => {
      return async (entry, txs) => {
        assert.strictEqual(entry.height, startHeight + counterObj.count);
        assert.strictEqual(txs.length, 4);

        events.push({ ...counterObj });
        counterObj.count++;

        return {
          type: scanAction.NEXT
        };
      };
    };

    const counter1 = { id: 1, count: 0 };
    const counter2 = { id: 2, count: 0 };
    await Promise.all([
      node.scanInteractive(startHeight, null, getIter(counter1)),
      node.scanInteractive(startHeight, null, getIter(counter2))
    ]);

    assert.strictEqual(counter1.count, 10);
    assert.strictEqual(counter2.count, 10);

    // Chain gets locked per block, so we should see alternating events.
    // Because they start in parallel, but id1 starts first they will be
    // getting events in alternating older (first one gets lock, second waits,
    // second gets lock, first waits, etc.)
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(events[i].id, 1);
      assert.strictEqual(events[i + 1].id, 2);
      i++;
    }
  });

  describe('HTTP', function() {
    let client = null;

    beforeEach(async () => {
      client = nodeCtx.nodeClient();

      await client.open();
    });

    afterEach(async () => {
      if (client.opened)
        await client.close();
    });

    for (const test of tests) {
      it(`should rescan all blocks with ${test.name} filter`, async () => {
        const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;
        let count = 0;

        client.hook('block rescan interactive', (rawEntry, rawTXs) => {
          const [entry, txs] = parseBlock(rawEntry, rawTXs);
          assert.strictEqual(entry.height, startHeight + count);
          count++;

          const testTXs = test.txs[entry.height];

          assert(test.txCountCheck(entry.height, txs));
          const hashset = txsToTXHashes(txs);

          for (const tx of testTXs)
            assert(hashset.has(tx.hash()));

          return {
            type: scanAction.NEXT
          };
        });

        let filter = null;

        if (test.filter)
          filter = test.filter.encode();

        await client.rescanInteractive(startHeight, filter);
        assert.strictEqual(count, 10);

        count = 0;
        if (test.filter)
          await client.setFilter(test.filter.encode());

        await client.rescanInteractive(startHeight);
      });

      it(`should rescan only 5 blocks and stop with ${test.name} filter`, async () => {
        const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;
        let count = 0;

        client.hook('block rescan interactive', (rawEntry, rawTXs) => {
          const [entry, txs] = parseBlock(rawEntry, rawTXs);
          assert.strictEqual(entry.height, startHeight + count);

          const testTXs = test.txs[entry.height];

          assert(test.txCountCheck(entry.height, txs));
          const hashset = txsToTXHashes(txs);

          for (const tx of testTXs)
            assert(hashset.has(tx.hash()));

          count++;

          if (count === 5) {
            return {
              type: scanAction.ABORT
            };
          }

          return {
            type: scanAction.NEXT
          };
        });

        let aborted = false;

        client.hook('block rescan interactive abort', (message) => {
          assert.strictEqual(message, 'scan request aborted.');
          aborted = true;
        });

        let filter = null;

        if (test.filter)
          filter = test.filter.encode();

        await client.rescanInteractive(startHeight, filter);
        assert.strictEqual(count, 5);
        assert.strictEqual(aborted, true);

        // rescan using socket.filter
        count = 0;
        aborted = false;

        if (test.filter)
          await client.setFilter(test.filter.encode());

        await client.rescanInteractive(startHeight, null);
        assert.strictEqual(count, 5);
        assert.strictEqual(aborted, true);
      });

      it(`should rescan the same block 5 times with ${test.name} filter (REPEAT_SET)`, async () => {
        const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

        let count = 0;
        client.hook('block rescan interactive', (rawEntry, rawTXs) => {
          const [entry, txs] = parseBlock(rawEntry, rawTXs);

          // we are repeating same block.
          assert.strictEqual(entry.height, startHeight);
          assert(test.txCountCheck(entry.height, txs));

          count++;

          if (count === 5) {
            return {
              type: scanAction.ABORT
            };
          }

          return {
            type: scanAction.REPEAT_SET,
            filter: test.filter ? test.filter.encode() : null
          };
        });

        let aborted = false;

        client.hook('block rescan interactive abort', (message) => {
          assert.strictEqual(message, 'scan request aborted.');
          aborted = true;
        });

        let filter = null;

        if (test.filter)
          filter = test.filter.encode();

        await client.rescanInteractive(startHeight, filter);
        assert.strictEqual(count, 5);
        assert.strictEqual(aborted, true);

        count = 0;
        aborted = false;

        if (test.filter)
          await client.setFilter(test.filter.encode());

        await client.rescanInteractive(startHeight);
        assert.strictEqual(count, 5);
        assert.strictEqual(aborted, true);
      });

      it(`should rescan the same block 5 times with ${test.name} filter (REPEAT)`, async () => {
        const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

        let count = 0;
        client.hook('block rescan interactive', (rawEntry, rawTXs) => {
          const [entry, txs] = parseBlock(rawEntry, rawTXs);

          // we are repeating same block.
          assert.strictEqual(entry.height, startHeight);
          assert(test.txCountCheck(entry.height, txs));

          count++;

          if (count === 5) {
            return {
              type: scanAction.ABORT
            };
          }

          return {
            type: scanAction.REPEAT,
            filter: test.filter ? test.filter.encode() : null
          };
        });

        let aborted = false;

        client.hook('block rescan interactive abort', (message) => {
          assert.strictEqual(message, 'scan request aborted.');
          aborted = true;
        });

        let filter = null;

        if (test.filter)
          filter = test.filter.encode();

        await client.rescanInteractive(startHeight, filter);
        assert.strictEqual(count, 5);
        assert.strictEqual(aborted, true);

        count = 0;
        aborted = false;

        if (test.filter)
          await client.setFilter(test.filter.encode());

        await client.rescanInteractive(startHeight);
        assert.strictEqual(count, 5);
        assert.strictEqual(aborted, true);
      });
    }

    it('should rescan the same block with update filters (REPEAT_SET)', async () => {
      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

      const filterAndTxs = tests.slice();
      let test = filterAndTxs.shift();

      let count = 0;

      client.hook('block rescan interactive', (rawEntry, rawTXs) => {
        count++;

        const [entry, txs] = parseBlock(rawEntry, rawTXs);

        assert.strictEqual(entry.height, startHeight);
        assert(test.txCountCheck(entry.height, txs));

        if (filterAndTxs.length === 0) {
          return {
            type: scanAction.ABORT
          };
        }

        test = filterAndTxs.shift();

        return {
          type: scanAction.REPEAT_SET,
          filter: test.filter.encode()
        };
      });

      let aborted = false;
      client.hook('block rescan interactive abort', (message) => {
        assert.strictEqual(message, 'scan request aborted.');
        aborted = true;
      });

      let filter = null;

      if (test.filter)
        filter = test.filter.encode();

      await client.rescanInteractive(startHeight, filter);
      assert.strictEqual(count, tests.length);
      assert.strictEqual(aborted, true);
    });

    it('should rescan the same block with updated filters (REPEAT_ADD)', async () => {
      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;

      let testTXs = allTXs[startHeight].slice();
      let filter = BloomFilter.fromRate(10000, 0.001);
      let expected = 0;

      client.hook('block rescan interactive', (rawEntry, rawTXs) => {
        const [entry, txs] = parseBlock(rawEntry, rawTXs);

        // we are repeating same block.
        assert.strictEqual(entry.height, startHeight);
        // May fail sometimes (BloomFilter)
        assert.strictEqual(txs.length, expected);

        if (testTXs.length === 0) {
          return {
            type: scanAction.ABORT
          };
        }

        // next test
        const tx = testTXs.shift();
        const chunks = [tx.hash()];
        expected++;

        return {
          type: scanAction.REPEAT_ADD,
          chunks: chunks
        };
      });

      let aborted = false;
      client.hook('block rescan interactive abort', (message) => {
        assert.strictEqual(message, 'scan request aborted.');
        aborted = true;
      });

      await client.rescanInteractive(startHeight, filter.encode());
      assert.strictEqual(aborted, true);

      // Now try using client.filter
      aborted = false;
      filter = BloomFilter.fromRate(10000, 0.001);
      testTXs = allTXs[startHeight].slice();
      expected = 0;

      await client.setFilter(filter.encode());
      await client.rescanInteractive(startHeight);
      assert.strictEqual(aborted, true);
    });

    it('should rescan in parallel', async () => {
      const client2 = nodeCtx.nodeClient();
      await client2.open();

      const startHeight = nodeCtx.height - RESCAN_DEPTH + 1;
      const events = [];
      const counter1 = { id: 1, count: 0 };
      const counter2 = { id: 2, count: 0 };

      const getIter = (counterObj) => {
        return async (rawEntry, rawTXs) => {
          const [entry, txs] = parseBlock(rawEntry, rawTXs);
          assert.strictEqual(entry.height, startHeight + counterObj.count);
          assert.strictEqual(txs.length, 4);

          events.push({ ...counterObj });
          counterObj.count++;

          return {
            type: scanAction.NEXT
          };
        };
      };

      client.hook('block rescan interactive', getIter(counter1));
      client2.hook('block rescan interactive', getIter(counter2));

      await Promise.all([
        client.rescanInteractive(startHeight),
        client2.rescanInteractive(startHeight)
      ]);

      assert.strictEqual(counter1.count, 10);
      assert.strictEqual(counter2.count, 10);

      // Chain gets locked per block, so we should see alternating events.
      // Because they start in parallel, but id1 starts first they will be
      // getting events in alternating older (first one gets lock, second waits,
      // second gets lock, first waits, etc.)
      for (let i = 0; i < 10; i++) {
        assert.strictEqual(events[i].id, 1);
        assert.strictEqual(events[i + 1].id, 2);
        i++;
      }
    });
  });
});

function txsToTXHashes(txs) {
  return new BufferSet(txs.map(tx => tx.hash()));
}

function parseEntry(data) {
  // 32  hash
  // 4   height
  // 4   nonce
  // 8   time
  // 32  prev
  // 32  tree
  // 24  extranonce
  // 32  reserved
  // 32  witness
  // 32  merkle
  // 4   version
  // 4   bits
  // 32  mask
  // 32  chainwork
  // 304 TOTAL

  assert(Buffer.isBuffer(data));
  // Just enough to read the three data below
  assert(data.length >= 44);

  return {
    hash: data.slice(0, 32),
    height: data.readUInt32LE(32),
    time: data.readUInt32LE(40)
  };
}

function parseBlock(entry, txs) {
  const block = parseEntry(entry);
  const out = [];

  for (const tx of txs)
    out.push(TX.decode(tx));

  return [block, out];
}
