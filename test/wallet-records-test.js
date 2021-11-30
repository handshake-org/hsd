'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const consensus = require('../lib/protocol/consensus');
const Records = require('../lib/wallet/records');
const ChainEntry = require('../lib/blockchain/chainentry');
const TX = require('../lib/primitives/tx');

const {
  ChainState,
  BlockMeta,
  TXRecord,
  MapRecord
} = Records;

function getRandomChainState(marked = false) {
  return {
    startHeight: random.randomInt(),
    startHash: random.randomBytes(32),
    height: random.randomInt(),
    marked: marked
  };
}

function getRandomBlockMetaData() {
  return {
    hash: random.randomBytes(32),
    height: random.randomInt(),
    time: random.randomInt()
  };
}

function getRandomTX() {
  return new TX({
    inputs: [{
      prevout: {
        hash: random.randomBytes(32),
        index: random.randomRange(0, 100)
      }
    }],
    outputs: [{
      value: random.randomInt()
    }]
  });
}

function getRandomTXRecordData(genTX = false, genBlock = false) {
  let block, tx;

  if (genBlock) {
    const blockData = getRandomBlockMetaData();
    block = new BlockMeta(blockData.hash, blockData.height, blockData.time);
  }

  if (genTX)
    tx = getRandomTX();

  const data = {
    height: block ? block.height : -1,
    time: block ? block.time : 0,
    block: block ? block.hash : null,
    tx: tx,
    hash: tx ? tx.hash() : null
  };

  return {data, tx, block};
}

/*
 * These don't expect actual instances of these classes
 * just object property checks.
 */

function compareChainState(state, expected) {
  assert.strictEqual(state.startHeight, expected.startHeight);
  assert.bufferEqual(state.startHash, expected.startHash);
  assert.strictEqual(state.height, expected.height);
  assert.strictEqual(state.marked, expected.marked);
};

function compareBlockMeta(actual, expected) {
  assert.bufferEqual(actual.hash, expected.hash);
  assert.strictEqual(actual.height, expected.height);
  assert.strictEqual(actual.time, expected.time);
}

function compareTXRecord(actual, expected) {
  if (actual.tx == null) {
    // defaults
    assert.strictEqual(actual.hash, null);

    // expected should be the same (otherwise it's a bug in the test).
    assert.strictEqual(actual.tx, expected.tx);
    assert.strictEqual(actual.hash, expected.hash);
  } else {
    assert.bufferEqual(actual.hash, expected.hash);
    assert.bufferEqual(actual.tx.encode(), expected.tx.encode());
  }

  if (actual.block == null) {
    // same as actual.tx checks
    assert.strictEqual(actual.height, -1);
    assert.strictEqual(actual.time, 0);

    assert.strictEqual(actual.block, expected.block);
    assert.strictEqual(actual.height, expected.height);
    assert.strictEqual(actual.time, expected.time);
  } else {
    assert.bufferEqual(actual.block, expected.block);
    assert.strictEqual(actual.height, expected.height);
    assert.strictEqual(actual.time, expected.time);
  }

  assert(typeof actual.mtime === 'number');
  assert(actual.mtime > 0);
  assert.strictEqual(actual.index, -1);
}

describe('Wallet Records', function() {
  describe('ChainState', function() {
    it('should encode/decode with defaults', () => {
      const state = new ChainState();
      const encoded = state.encode();
      const decoded = ChainState.decode(encoded);

      assert.deepStrictEqual(state, decoded);

      compareChainState(state, {
        startHeight: 0,
        startHash: consensus.ZERO_HASH,
        height: 0,
        marked: false
      });
    });

    it('should inject data', () => {
      const data1 = getRandomChainState(false);
      const data2 = getRandomChainState(true);

      let state = new ChainState();
      state.inject(data1);
      compareChainState(state, data1);

      state = new ChainState();
      state.inject(data2);
      compareChainState(state, data2);
    });

    it('should encode/decode', () => {
      const data = getRandomChainState(false);
      const state = new ChainState();
      state.inject(data);

      const encoded = state.encode();
      const decoded = ChainState.decode(encoded);

      compareChainState(decoded, state);
    });

    it('should encode/decode with marked true', () => {
      const data = getRandomChainState(true);
      const state = new ChainState();
      state.inject(data);

      const encoded = state.encode();
      const decoded = ChainState.decode(encoded);

      compareChainState(decoded, state);
    });
  });

  describe('BlockMeta', function() {
    it('should initialize with defaults', () => {
      const meta = new BlockMeta();

      compareBlockMeta(meta, {
        hash: consensus.ZERO_HASH,
        height: -1,
        time: 0
      });
    });

    it('should initialize with params', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta(data.hash, data.height, data.time);
      compareBlockMeta(meta, data);
    });

    it('should inject data', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta();
      meta.inject(data);

      compareBlockMeta(meta, data);
    });

    it('should encode/decode', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta();
      meta.inject(data);

      const encoded = meta.encode();
      const decoded = BlockMeta.decode(encoded);

      compareBlockMeta(meta, data);
      compareBlockMeta(decoded, meta);
    });

    it('should JSON encode/decode', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta();
      meta.inject(data);

      const encoded = meta.toJSON();
      const decoded = BlockMeta.fromJSON(encoded);

      assert.deepStrictEqual(encoded, {
        hash: data.hash.toString('hex'),
        height: data.height,
        time: data.time
      });
      compareBlockMeta(decoded, data);
    });

    it('should return block hash', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta();
      meta.inject(data);

      assert.bufferEqual(meta.toHash(), data.hash);
    });

    it('should be created from ChainEntry', () => {
      const data = getRandomBlockMetaData();
      const entry = new ChainEntry();
      entry.hash = data.hash;
      entry.height = data.height;
      entry.time = data.time;

      const meta = BlockMeta.fromEntry(entry);
      compareBlockMeta(meta, data);
    });
  });

  describe('TXRecord', function() {
    const emptyBlock = {
      height: -1,
      block: null,
      time: 0
    };

    const emptyTX = {
      tx: null,
      hash: null
    };

    it('should initialize with defaults', () => {
      const wtx = new TXRecord();
      const mtime = wtx.mtime;

      compareTXRecord(wtx, {
        mtime: mtime,
        index: -1,
        ...emptyTX,
        ...emptyBlock
      });
    });

    it('should initialize w/ tx', () => {
      const {data, tx} = getRandomTXRecordData(true);
      const wtx = new TXRecord(tx);

      compareTXRecord(wtx, data);
    });

    it('should initialize w/ tx and block', () => {
      const {data, block, tx} = getRandomTXRecordData(true, true);
      const wtx = new TXRecord(tx, block);

      compareTXRecord(wtx, data);
    });

    it('should fail encode w/o tx', () => {
      let err;
      try {
        const wtx = new TXRecord();
        wtx.encode();
      } catch (e) {
        err = e;
      }

      assert(err, 'Should throw error w/o tx');
    });

    it('should encode/decode w/ tx', () => {
      const {data, tx} = getRandomTXRecordData(true);

      const wtx = new TXRecord(tx);
      const encoded = wtx.encode();
      const decoded = TXRecord.decode(encoded);

      compareTXRecord(wtx, data);
      compareTXRecord(decoded, data);
    });

    it('should encode/decode w/ tx and block', () => {
      const {data, tx, block} = getRandomTXRecordData(true, true);

      const wtx = new TXRecord(tx, block);
      const encoded = wtx.encode();
      const decoded = TXRecord.decode(encoded);

      compareTXRecord(wtx, data);
      compareTXRecord(decoded, data);
    });

    it('should initialize from TX', () => {
      const {data, tx} = getRandomTXRecordData(true);
      const wtx = TXRecord.fromTX(tx);
      compareTXRecord(wtx, data);
    });

    it('should initialize from TX and Block', () => {
      const {data, tx, block} = getRandomTXRecordData(true, true);
      const wtx = TXRecord.fromTX(tx, block);
      compareTXRecord(wtx, data);
    });

    it('should set and unset block', () => {
      const {data, tx, block} = getRandomTXRecordData(true, true);
      const wtx = TXRecord.fromTX(tx);

      assert.strictEqual(wtx.getBlock(), null);
      assert.strictEqual(wtx.getDepth(random.randomInt()), 0);
      compareTXRecord(wtx, {
        ...data,
        ...emptyBlock
      });

      wtx.setBlock(block);
      assert.strictEqual(wtx.getDepth(0), 0);
      assert.strictEqual(wtx.getDepth(block.height), 1);
      assert.strictEqual(wtx.getDepth(block.height + 1000), 1001);
      compareBlockMeta(wtx.getBlock(), block);
      compareTXRecord(wtx, data);

      wtx.unsetBlock(block);
      assert.strictEqual(wtx.getBlock(), null);
      assert.strictEqual(wtx.getDepth(random.randomInt()), 0);
      compareTXRecord(wtx, {
        ...data,
        ...emptyBlock
      });
    });
  });

  describe('MapRecord', function() {
    it('should initialize with default', () => {
      const map = new MapRecord();

      assert.strictEqual(map.wids.size, 0);
    });

    it('should encode/decode empty map', () => {
      const map = new MapRecord();
      const encoded = map.encode();
      const decoded = MapRecord.decode(encoded);

      assert.bufferEqual(encoded, Buffer.from('00'.repeat(4), 'hex'));
      assert.strictEqual(map.wids.size, 0);
      assert.strictEqual(decoded.wids.size, 0);
    });

    it('should encode/decode map', () => {
      const rand = random.randomRange(1, 100);
      const map = new MapRecord();

      for (let i = 0; i < rand; i++)
        map.add(i);

      const encoded = map.encode();
      const decoded = MapRecord.decode(encoded);

      assert.strictEqual(decoded.wids.size, map.wids.size);
      for (let i = 0; i < rand; i++)
        assert(decoded.wids.has(i));
    });

    it('should add and remove items from the map', () => {
      const items = 20;
      const map = new MapRecord();

      for (let i = 0; i < items; i++) {
        const res = map.add(i);
        assert.strictEqual(res, true);
        assert.strictEqual(map.wids.size, i + 1);
      }

      for (let i = 0; i < items; i++) {
        const res = map.add(i);
        assert.strictEqual(res, false);
        assert.strictEqual(map.wids.size, items);
      }

      for (let i = items; i < items * 2; i++) {
        const res = map.remove(i);
        assert.strictEqual(res, false);
        assert.strictEqual(map.wids.size, items);
      }

      for (let i = 0; i < items; i++) {
        const res = map.remove(i);
        assert.strictEqual(res, true);
        assert.strictEqual(map.wids.size, items - i - 1);
      }

      for (let i = 0; i < items; i++) {
        const res = map.remove(i);
        assert.strictEqual(res, false);
        assert.strictEqual(map.wids.size, 0);
      }
    });
  });
});
