/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const Opcode = require('../lib/script/opcode');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Output = require('../lib/primitives/output');
const Covenant = require('../lib/primitives/covenant');

describe('Script transaction introspection', function() {
  describe('OP_TYPE', function() {
    it('should verify covenant type from TX output', async() => {
      for (let t = 0; t < 10; t++) {
        const script = new Script([
          Opcode.fromSymbol('OP_TYPE'),
          Opcode.fromInt(t),
          Opcode.fromSymbol('OP_EQUAL')
        ]);

        const coin = Coin.fromOptions({
          value: 1000,
          address: Address.fromScript(script)
        });

        const witness = new Witness([script.encode()]);

        const output = new Output();
        output.covenant = new Covenant(t, []);

        const mtx = new MTX();
        mtx.addCoin(coin);
        mtx.inputs[0].witness.fromStack(witness);
        mtx.outputs[0] = output;

        assert(mtx.verify());
      }
    });

    it('should reject wrong covenant type from TX output', async() => {
      for (let t = 0; t < 10; t++) {
        const script = new Script([
          Opcode.fromSymbol('OP_TYPE'),
          Opcode.fromInt(t),
          Opcode.fromSymbol('OP_EQUAL')
        ]);

        const coin = Coin.fromOptions({
          value: 1000,
          address: Address.fromScript(script)
        });

        const witness = new Witness([script.encode()]);

        const output = new Output();
        output.covenant = new Covenant(t + 1, []);

        const mtx = new MTX();
        mtx.addCoin(coin);
        mtx.inputs[0].witness.fromStack(witness);
        mtx.outputs[0] = output;

        assert(!mtx.verify());
      }
    });
  });
});
