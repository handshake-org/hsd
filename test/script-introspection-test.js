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
    it('should verify covenant type from TX output', async () => {
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

    it('should reject wrong covenant type from TX output', async () => {
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

  describe('OP_CHECKOUTPUT', function() {
    it('should verify TX output with specified value', async () => {
      for (let v = 1; v < 10; v++) {
        const value = 1000 * v;
        const version = v;
        const hash = Buffer.alloc(20, v);

        const address = new Address({
          version,
          hash
        });

        const script = new Script([
          Opcode.fromInt(version),
          Opcode.fromData(hash),
          Opcode.fromInt(value),
          Opcode.fromSymbol('OP_CHECKOUTPUT')
        ]);

        const coin = Coin.fromOptions({
          value: value + 10000,
          address: Address.fromScript(script)
        });

        const witness = new Witness([script.encode()]);

        const output = new Output({
          value,
          address
        });

        const mtx = new MTX();
        mtx.addCoin(coin);
        mtx.inputs[0].witness.fromStack(witness);
        mtx.outputs[0] = output;

        assert(mtx.verify());
      }
    });

    it('should verify TX output with same-as-input value', async () => {
      const value = 123456789;
      const version = 0;
      const hash = Buffer.alloc(20, 1);

      const address = new Address({
        version,
        hash
      });

      const script = new Script([
        Opcode.fromInt(version),
        Opcode.fromData(hash),
        Opcode.fromInt(0),
        Opcode.fromSymbol('OP_CHECKOUTPUT')
      ]);

      const coin = Coin.fromOptions({
        value: value,
        address: Address.fromScript(script)
      });

      const witness = new Witness([script.encode()]);

      const output = new Output({
        value,
        address
      });

      const mtx = new MTX();
      mtx.addCoin(coin);
      mtx.inputs[0].witness.fromStack(witness);
      mtx.outputs[0] = output;

      assert(mtx.verify());
    });

    it('should reject TX output mismatch: value', async () => {
      const value = 123456789;
      const version = 0;
      const hash = Buffer.alloc(20, 1);

      const address = new Address({
        version,
        hash
      });

      const script = new Script([
        Opcode.fromInt(version),
        Opcode.fromData(hash),
        Opcode.fromInt(value + 1),
        Opcode.fromSymbol('OP_CHECKOUTPUT')
      ]);

      const coin = Coin.fromOptions({
        value: value - 1,
        address: Address.fromScript(script)
      });

      const witness = new Witness([script.encode()]);

      const output = new Output({
        value,
        address
      });

      const mtx = new MTX();
      mtx.addCoin(coin);
      mtx.inputs[0].witness.fromStack(witness);
      mtx.outputs[0] = output;

      assert(!mtx.verify());
    });

    it('should reject TX output mismatch: address', async () => {
      const value = 123456789;
      const version = 0;
      const hash = Buffer.alloc(20, 1);
      const badhash = Buffer.alloc(20, 2);

      const address = new Address({
        version,
        hash
      });

      const script = new Script([
        Opcode.fromInt(version),
        Opcode.fromData(badhash),
        Opcode.fromInt(value),
        Opcode.fromSymbol('OP_CHECKOUTPUT')
      ]);

      const coin = Coin.fromOptions({
        value: value,
        address: Address.fromScript(script)
      });

      const witness = new Witness([script.encode()]);

      const output = new Output({
        value,
        address
      });

      const mtx = new MTX();
      mtx.addCoin(coin);
      mtx.inputs[0].witness.fromStack(witness);
      mtx.outputs[0] = output;

      assert(!mtx.verify());
    });

    it('should reject TX output mismatch: version', async () => {
      const value = 123456789;
      const version = 0;
      const hash = Buffer.alloc(20, 1);

      const address = new Address({
        version,
        hash
      });

      const script = new Script([
        Opcode.fromInt(version + 1),
        Opcode.fromData(hash),
        Opcode.fromInt(value),
        Opcode.fromSymbol('OP_CHECKOUTPUT')
      ]);

      const coin = Coin.fromOptions({
        value: value,
        address: Address.fromScript(script)
      });

      const witness = new Witness([script.encode()]);

      const output = new Output({
        value,
        address
      });

      const mtx = new MTX();
      mtx.addCoin(coin);
      mtx.inputs[0].witness.fromStack(witness);
      mtx.outputs[0] = output;

      assert(!mtx.verify());
    });
  });
});
