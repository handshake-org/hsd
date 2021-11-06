'use strict';

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const consensus = require('../lib/protocol/consensus');
const Records = require('../lib/wallet/records');
const ChainEntry = require('../lib/blockchain/chainentry');
const {
  ChainState,
  BlockMeta
} = Records;

describe('Wallet Records', function() {
  describe('ChainState', function() {
    function check(state, expected) {
      assert.strictEqual(state.startHeight, expected.startHeight);
      assert.bufferEqual(state.startHash, expected.startHash);
      assert.strictEqual(state.height, expected.height);
      assert.strictEqual(state.marked, expected.marked);
    };

    function getRandomChainState(marked = false) {
      return {
        startHeight: random.randomInt(),
        startHash: random.randomBytes(32),
        height: random.randomInt(),
        marked: marked
      };
    }
    it('should encode/decode with defaults', () => {
      const state = new ChainState();
      const encoded = state.encode();
      const decoded = ChainState.decode(encoded);

      assert.deepStrictEqual(state, decoded);

      check(state, {
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
      check(state, data1);

      state = new ChainState();
      state.inject(data2);
      check(state, data2);
    });

    it('should encode/decode', () => {
      const data = getRandomChainState(false);
      const state = new ChainState();
      state.inject(data);

      const encoded = state.encode();
      const decoded = ChainState.decode(encoded);

      check(decoded, state);
    });

    it('should encode/decode with marked true', () => {
      const data = getRandomChainState(true);
      const state = new ChainState();
      state.inject(data);

      const encoded = state.encode();
      const decoded = ChainState.decode(encoded);

      check(decoded, state);
    });
  });

  describe('BlockMeta', function() {
    function check(actual, expected) {
      assert.bufferEqual(actual.hash, expected.hash);
      assert.strictEqual(actual.height, expected.height);
      assert.strictEqual(actual.time, expected.time);
    }

    function getRandomBlockMetaData() {
      return {
        hash: random.randomBytes(32),
        height: random.randomInt(),
        time: random.randomInt()
      };
    }

    it('should initialize with proper defaults', () => {
      const meta = new BlockMeta();

      check(meta, {
        hash: consensus.ZERO_HASH,
        height: -1,
        time: 0
      });
    });

    it('should initialize with params', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta(data.hash, data.height, data.time);
      check(meta, data);
    });

    it('should inject data', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta();
      meta.inject(data);

      check(meta, data);
    });

    it('should encode/decode', () => {
      const data = getRandomBlockMetaData();
      const meta = new BlockMeta();
      meta.inject(data);

      const encoded = meta.encode();
      const decoded = BlockMeta.decode(encoded);

      check(meta, data);
      check(decoded, meta);
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
      check(decoded, data);
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
      check(meta, data);
    });
  });
});
