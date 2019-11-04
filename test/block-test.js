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
      block = Block.fromJSON({
        version: 1,
        prevBlock:
          '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot:
          '0101010101010101010101010101010101010101010101010101010101010101',
        witnessRoot:
          '0202020202020202020202020202020202020202020202020202020202020202',
        treeRoot:
          '0303030303030303030303030303030303030303030303030303030303030303',
        reservedRoot:
          '0404040404040404040404040404040404040404040404040404040404040404',
        extraNonce:
          '050505050505050505050505050505050505050505050505',
        mask:
          '0606060606060606060606060606060606060606060606060606060606060606',
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
      assert(block);
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
