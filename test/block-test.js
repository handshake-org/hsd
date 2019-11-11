/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const assert = require('bsert');
const Block = require('../lib/primitives/block');
const MemBlock = require('../lib/primitives/memblock');

describe('Block', function() {
  this.timeout(10000);

  describe('Serialization', function() {
    let block = null;
    let raw = null;

    it('should create a block from JSON', async () => {
      const prevBlock =
        '0000000000000000000000000000000000000000000000000000000000000000';
      const merkleRoot =
        '0101010101010101010101010101010101010101010101010101010101010101';
      const witnessRoot =
        '0202020202020202020202020202020202020202020202020202020202020202';
      const treeRoot =
        '0303030303030303030303030303030303030303030303030303030303030303';
      const reservedRoot =
        '0404040404040404040404040404040404040404040404040404040404040404';
      const extraNonce =
        '050505050505050505050505050505050505050505050505';
      const mask =
        '0606060606060606060606060606060606060606060606060606060606060606';

      block = Block.fromJSON({
        version: 1,
        prevBlock,
        merkleRoot,
        witnessRoot,
        treeRoot,
        reservedRoot,
        extraNonce,
        mask,
        time: 0,
        bits: 0,
        nonce: 0,
        txs: [
          {
            version: 1,
            locktime: 0,
            inputs: [
              {
                sequence: 0,
                prevout: {
                  hash: Buffer.alloc(32, 7).toString('hex'),
                  index: 0
                },
                witness: []
              }
            ],
            outputs: [
              {
                value: 1234567,
                address: 'rs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqn6kda'
              }
            ]
          }
        ]
      });

      assert.bufferEqual(block.prevBlock, Buffer.from(prevBlock, 'hex'));
      assert.bufferEqual(block.merkleRoot, Buffer.from(merkleRoot, 'hex'));
      assert.bufferEqual(block.witnessRoot, Buffer.from(witnessRoot, 'hex'));
      assert.bufferEqual(block.treeRoot, Buffer.from(treeRoot, 'hex'));
      assert.bufferEqual(block.reservedRoot, Buffer.from(reservedRoot, 'hex'));
      assert.bufferEqual(block.extraNonce, Buffer.from(extraNonce, 'hex'));
      assert.bufferEqual(block.mask, Buffer.from(mask, 'hex'));
      assert.strictEqual(block.version, 1);
      assert.strictEqual(block.time, 0);
      assert.strictEqual(block.bits, 0);
      assert.strictEqual(block.nonce, 0);
      assert.strictEqual(block.txs.length, 1);
    });

    it('should deserialize and reserialze block', async () => {
      raw = block.encode();
      const block2 = Block.decode(raw);
      assert.deepStrictEqual(block.toJSON(), block2.toJSON());
    });

    it('should create memblock from raw block', async () => {
      const memblock = MemBlock.decode(raw);
      assert.bufferEqual(block.hash(), memblock.hash());
    });
  });
});
