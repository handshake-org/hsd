/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const Stack = require('../lib/script/stack');
const Opcode = require('../lib/script/opcode');
const TX = require('../lib/primitives/tx');
const consensus = require('../lib/protocol/consensus');

const scripts = require('./data/script-tests.json');

function isSuccess(stack) {
  if (stack.length === 0)
    return false;

  if (!stack.getBool(-1))
    return false;

  return true;
}

function parseScriptTest(data) {
  const script = Script.fromString(data.script);
  const witness = Witness.fromJSON(data.witness);

  let flags = 0;

  for (const name of data.flags) {
    const flag = Script.flags[`VERIFY_${name}`];

    if (flag == null)
      throw new Error(`Unknown flag: ${name}.`);

    flags |= flag;
  }

  witness.items.push(script.encode());

  return {
    comments: data.comments || data.script.substring(0, 60),
    script: script,
    address: Address.fromScript(script),
    value: data.value,
    witness: witness,
    locktime: data.locktime,
    sequence: data.sequence,
    flags: flags,
    result: data.result
  };
}

describe('Script', function() {
  it('should handle if statements correctly', () => {
    {
      const input = new Script([
        Opcode.fromInt(1),
        Opcode.fromInt(2)
      ]);

      const output = new Script([
        Opcode.fromInt(2),
        Opcode.fromSymbol('equal'),
        Opcode.fromSymbol('if'),
        Opcode.fromInt(3),
        Opcode.fromSymbol('else'),
        Opcode.fromInt(4),
        Opcode.fromSymbol('endif'),
        Opcode.fromInt(5)
      ]);

      const stack = new Stack();

      input.execute(stack);
      output.execute(stack);

      assert.deepEqual(stack.items, [
        Buffer.from([1]),
        Buffer.from([3]),
        Buffer.from([5])
      ]);
    }

    {
      const input = new Script([
        Opcode.fromInt(1),
        Opcode.fromInt(2)
      ]);

      const output = new Script([
        Opcode.fromInt(9),
        Opcode.fromSymbol('equal'),
        Opcode.fromSymbol('if'),
        Opcode.fromInt(3),
        Opcode.fromSymbol('else'),
        Opcode.fromInt(4),
        Opcode.fromSymbol('endif'),
        Opcode.fromInt(5)
      ]);

      const stack = new Stack();

      input.execute(stack);
      output.execute(stack);

      assert.deepEqual(stack.items, [
        Buffer.from([1]),
        Buffer.from([4]),
        Buffer.from([5])
      ]);
    }

    {
      const input = new Script([
        Opcode.fromInt(1),
        Opcode.fromInt(2)
      ]);

      const output = new Script([
        Opcode.fromInt(2),
        Opcode.fromSymbol('equal'),
        Opcode.fromSymbol('if'),
        Opcode.fromInt(3),
        Opcode.fromSymbol('endif'),
        Opcode.fromInt(5)
      ]);

      const stack = new Stack();

      input.execute(stack);
      output.execute(stack);

      assert.deepEqual(stack.items, [
        Buffer.from([1]),
        Buffer.from([3]),
        Buffer.from([5])
      ]);
    }

    {
      const input = new Script([
        Opcode.fromInt(1),
        Opcode.fromInt(2)
      ]);

      const output = new Script([
        Opcode.fromInt(9),
        Opcode.fromSymbol('equal'),
        Opcode.fromSymbol('if'),
        Opcode.fromInt(3),
        Opcode.fromSymbol('endif'),
        Opcode.fromInt(5)
      ]);

      const stack = new Stack();

      input.execute(stack);
      output.execute(stack);

      assert.deepEqual(stack.items, [
        Buffer.from([1]),
        Buffer.from([5])
      ]);
    }

    {
      const input = new Script([
        Opcode.fromInt(1),
        Opcode.fromInt(2)
      ]);

      const output = new Script([
        Opcode.fromInt(9),
        Opcode.fromSymbol('equal'),
        Opcode.fromSymbol('notif'),
        Opcode.fromInt(3),
        Opcode.fromSymbol('endif'),
        Opcode.fromInt(5)
      ]);

      const stack = new Stack();

      input.execute(stack);
      output.execute(stack);

      assert.deepEqual(stack.items, [
        Buffer.from([1]),
        Buffer.from([3]),
        Buffer.from([5])
      ]);
    }
  });

  it('should handle CScriptNums correctly', () => {
    const input = new Script([
      Opcode.fromString('ffffff7f', 'hex'),
      Opcode.fromSymbol('negate'),
      Opcode.fromSymbol('dup'),
      Opcode.fromSymbol('add')
    ]);

    const output = new Script([
      Opcode.fromString('feffffff80', 'hex'),
      Opcode.fromSymbol('equal')
    ]);

    const stack = new Stack();

    input.execute(stack);
    output.execute(stack);

    assert(isSuccess(stack));
  });

  it('should handle CScriptNums correctly', () => {
    const input = new Script([
      Opcode.fromInt(11),
      Opcode.fromInt(10),
      Opcode.fromInt(1),
      Opcode.fromSymbol('add')
    ]);

    const output = new Script([
      Opcode.fromSymbol('numnotequal'),
      Opcode.fromSymbol('not')
    ]);

    const stack = new Stack();

    input.execute(stack);
    output.execute(stack);

    assert(isSuccess(stack));
  });

  it('should handle OP_ROLL correctly', () => {
    const input = new Script([
      Opcode.fromInt(0x16),
      Opcode.fromInt(0x15),
      Opcode.fromInt(0x14)
    ]);

    const output = new Script([
      Opcode.fromInt(0),
      Opcode.fromSymbol('roll'),
      Opcode.fromInt(0x14),
      Opcode.fromSymbol('equalverify'),
      Opcode.fromSymbol('depth'),
      Opcode.fromInt(2),
      Opcode.fromSymbol('equal')
    ]);

    const stack = new Stack();

    input.execute(stack);
    output.execute(stack);

    assert(isSuccess(stack));
  });

  for (const data of scripts) {
    const {
      comments,
      address,
      value,
      witness,
      locktime,
      sequence,
      flags,
      result
    } = parseScriptTest(data);

    it(`should handle script test: ${comments}`, () => {
      // Funding transaction.
      const prev = new TX({
        version: 1,
        inputs: [{
          prevout: {
            hash: consensus.ZERO_HASH,
            index: 0xffffffff
          },
          witness: [
            Buffer.alloc(1),
            Buffer.alloc(1)
          ],
          sequence: 0xffffffff
        }],
        outputs: [{
          address,
          value
        }],
        locktime: 0
      });

      // Spending transaction.
      const tx = new TX({
        version: 1,
        inputs: [{
          prevout: {
            hash: prev.hash(),
            index: 0
          },
          witness: witness,
          sequence: sequence
        }],
        outputs: [{
          address: new Address(),
          value: value
        }],
        locktime: locktime
      });

      let err = null;

      try {
        Script.verify(witness, address, tx, 0, value, flags);
      } catch (e) {
        err = e;
      }

      if (result !== 'OK') {
        assert(err instanceof Error);
        assert.strictEqual(err.code, result);
        return;
      }

      assert.ifError(err);
    });
  }
});
