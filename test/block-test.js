/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const assert = require('bsert');
const Block = require('../lib/primitives/block');
const MerkleBlock = require('../lib/primitives/merkleblock');
const MemBlock = require('../lib/primitives/memblock');
const Network = require('../lib/protocol/network');
const bip152 = require('../lib/net/bip152');
const CompactBlock = bip152.CompactBlock;
const WorkerPool = require('../lib/workers/workerpool');
const Chain = require('../lib/blockchain/chain');
const Miner = require('../lib/mining/miner');

const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true
});

const chain = new Chain({
  memory: true,
  network,
  workers
});

const miner = new Miner({
  chain,
  workers
});

describe('Block', function() {
  this.timeout(10000);

  before(async () => {
    await chain.open();
    await miner.open();
  });

  after(async () => {
    await chain.close();
    await miner.close();
  });

  describe('Serialization', function() {
    let block = null;
    let raw = null;

    it('should mine 1 block', async () => {
      block = await miner.mineBlock();
      assert(block);
    });

    it('should deserialize and reserialze block', async () => {
      raw = block.toRaw();
      const block2 = Block.fromRaw(raw);
      assert.deepStrictEqual(block.toJSON(), block2.toJSON());
    });

    it('should create memblock from raw block', async () => {
      const memblock = MemBlock.decode(raw);
      assert.bufferEqual(block.hash(), memblock.hash());
    });
  });
});
