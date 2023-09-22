'use strict';

const assert = require('bsert');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const Stack = require('../lib/script/stack');
const Opcode = require('../lib/script/opcode');
const TX = require('../lib/primitives/tx');
const consensus = require('../lib/protocol/consensus');
const ScriptNum = require('../lib/script/scriptnum');

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

  describe('ScriptNum', function () {
    // Src: https://github.com/bitcoin/bitcoin/blob/ff564c75e751db6cfaf2a5f1b8a3b471f510976f/test/functional/test_framework/script.py#L750-L769
    const sn2bytesVector = [
      [0, []],
      [1, [0x01]],
      [-1, [0x81]],
      [0x7F, [0x7F]],
      [-0x7F, [0xFF]],
      [0x80, [0x80, 0x00]],
      [-0x80, [0x80, 0x80]],
      [0xFF, [0xFF, 0x00]],
      [-0xFF, [0xFF, 0x80]],
      [0x100, [0x00, 0x01]],
      [-0x100, [0x00, 0x81]],
      [0x7FFF, [0xFF, 0x7F]],
      [-0x8000, [0x00, 0x80, 0x80]],
      [-0x7FFFFF, [0xFF, 0xFF, 0xFF]],
      [0x80000000, [0x00, 0x00, 0x00, 0x80, 0x00]],
      [-0x80000000, [0x00, 0x00, 0x00, 0x80, 0x80]],
      [0xFFFFFFFF, [0xFF, 0xFF, 0xFF, 0xFF, 0x00]],
      [123456789, [0x15, 0xCD, 0x5B, 0x07]],
      [-54321, [0x31, 0xD4, 0x80]]
    ];

    // Src: https://github.com/bitcoin/bitcoin/blob/ff564c75e751db6cfaf2a5f1b8a3b471f510976f/test/functional/test_framework/script.py#L771-L775
    const serializationVector = [
      0, 1, -1, -2, 127, 128, -255, 256, (1 << 15) - 1, -(1 << 16),
      (1 << 24) - 1, (1 << 31), 1500, -1500
    ];

    it('should serialize script numbers correctly', () => {
      for (const [num, bytes] of sn2bytesVector) {
        const sn = ScriptNum.fromNumber(num);
        const numBytes = sn.encode();
        const testBuffer = Buffer.from(bytes);

        assert.bufferEqual(numBytes, testBuffer);
      }
    });

    it('should serialize/deserialize script numbers correctly', () => {
      for (const num of serializationVector) {
        const encoded = ScriptNum.fromNumber(num).encode();
        const final = ScriptNum.decode(encoded).toNumber();

        assert.strictEqual(num, final);
      }
    });
  });

  describe('Script - mathops', function () {
    const execOK = (scriptStr) => {
      const stack = new Stack();

      let err;
      try {
        const script = Script.fromString(scriptStr);
        script.execute(stack);
      } catch (e) {
        err = e;
      }

      assert(!err, `${scriptStr} ${err}`);
      assert(isSuccess(stack), `${scriptStr}`);
    };

    it('should OP_1ADD', () => {
      const add1Vectors = [
        '1 OP_1ADD 2 equal',
        '0 OP_1ADD 1 equal',
        '-1 OP_1ADD 0 equal',
        '-2147483647 OP_1ADD -2147483646 equal',
        '2147483647 OP_1ADD 2147483648 equal'
      ];

      for (const script of add1Vectors)
        execOK(script);
    });

    it('should OP_1SUB', () => {
      const sub1Vectors = [
        '1 OP_1SUB 0 equal',
        '0 OP_1SUB -1 equal',
        '-1 OP_1SUB -2 equal',
        '-2147483647 OP_1SUB -2147483648 equal',
        '2147483647 OP_1SUB 2147483646 equal'
      ];

      for (const script of sub1Vectors)
        execOK(script);
    });

    it('should OP_NEGATE', () => {
      const negateVectors = [
        '0 OP_NEGATE 0 equal',
        '1 OP_NEGATE -1 equal',
        '-1 OP_NEGATE 1 equal',
        '-2147483647 OP_NEGATE 2147483647 equal',
        '2147483647 OP_NEGATE -2147483647 equal'
      ];

      for (const script of negateVectors)
        execOK(script);
    });

    it('should OP_ABS', () => {
      const absVectors = [
        '0 OP_ABS 0 equal',
        '1 OP_ABS 1 equal',
        '-1 OP_ABS 1 equal',
        '-2147483647 OP_ABS 2147483647 equal',
        '2147483647 OP_ABS 2147483647 equal'
      ];

      for (const script of absVectors)
        execOK(script);
    });

    it('should OP_NOT', () => {
      const notVectors = [
        '0 OP_NOT 1 equal',
        '1 OP_NOT 0 equal',
        '-1 OP_NOT 0 equal',
        '-2147483647 OP_NOT 0 equal',
        '2147483647 OP_NOT 0 equal'
      ];

      for (const script of notVectors)
        execOK(script);
    });

    it('should OP_0NOTEQUAL', () => {
      const notVectors = [
        '0 OP_0NOTEQUAL 0 equal',
        '1 OP_0NOTEQUAL 1 equal',
        '-1 OP_0NOTEQUAL 1 equal',
        '-2147483647 OP_0NOTEQUAL 1 equal',
        '2147483647 OP_0NOTEQUAL 1 equal'
      ];

      for (const script of notVectors)
        execOK(script);
    });

    it('should OP_ADD', () => {
      const addVectors = [
        '0 0 add 0 equal',
        '0 1 add 1 equal',
        '1 -1 add 0 equal',
        '1 2 add 3 equal',
        '-2147483647 2147483647 add 0 equal',
        '-2147483647 -2147483647 add -4294967294 equal',
        '2147483647 2147483647 add 4294967294 equal'
      ];

      for (const script of addVectors)
        execOK(script);
    });

    it('should OP_SUB', () => {
      const subVectors = [
        '0 0 sub 0 equal',
        '0 1 sub -1 equal',
        '1 -1 sub 2 equal',
        '1 2 sub -1 equal',
        '-2147483647 2147483647 sub -4294967294 equal',
        '-2147483647 -2147483647 sub 0 equal',
        '2147483647 2147483647 sub 0 equal',
        '2147483647 -2147483647 sub 4294967294 equal'
      ];

      for (const script of subVectors)
        execOK(script);
    });

    it('should OP_BOOLAND', () => {
      const boolandVectors = [
        '0 0 booland 0 equal',
        '0 1 booland 0 equal',
        '1 -1 booland 1 equal',
        '1 2 booland 1 equal',
        '-2147483647 2147483647 booland 1 equal',
        '-2147483647 -2147483647 booland 1 equal',
        '2147483647 2147483647 booland 1 equal',
        '2147483647 -2147483647 booland 1 equal',
        '2147483647 0 booland 0 equal',
        '0 2147483647 booland 0 equal'
      ];

      for (const script of boolandVectors)
        execOK(script);
    });

    it('should OP_BOOLOR', () => {
      const boolorVectors = [
        '0 0 boolor 0 equal',
        '0 1 boolor 1 equal',
        '1 -1 boolor 1 equal',
        '1 2 boolor 1 equal',
        '-2147483647 2147483647 boolor 1 equal',
        '-2147483647 -2147483647 boolor 1 equal',
        '2147483647 2147483647 boolor 1 equal',
        '2147483647 -2147483647 boolor 1 equal',
        '2147483647 0 boolor 1 equal',
        '0 2147483647 boolor 1 equal'
      ];

      for (const script of boolorVectors)
        execOK(script);
    });

    it('should OP_NUMEQUAL', () => {
      const numequalVectors = [
        '0 0 numequal 1 equal',
        '0 1 numequal 0 equal',
        '1 -1 numequal 0 equal',
        '1 2 numequal 0 equal',
        '-2147483647 2147483647 numequal 0 equal',
        '-2147483647 -2147483647 numequal 1 equal',
        '2147483647 2147483647 numequal 1 equal',
        '2147483647 -2147483647 numequal 0 equal',
        '2147483647 0 numequal 0 equal',
        '0 2147483647 numequal 0 equal'
      ];

      for (const script of numequalVectors)
        execOK(script);
    });

    it('should OP_NUMNOTEQUAL', () => {
      const numnotequalVectors = [
        '0 0 numnotequal 0 equal',
        '0 1 numnotequal 1 equal',
        '1 -1 numnotequal 1 equal',
        '1 2 numnotequal 1 equal',
        '-2147483647 2147483647 numnotequal 1 equal',
        '-2147483647 -2147483647 numnotequal 0 equal',
        '2147483647 2147483647 numnotequal 0 equal',
        '2147483647 -2147483647 numnotequal 1 equal',
        '2147483647 0 numnotequal 1 equal',
        '0 2147483647 numnotequal 1 equal'
      ];

      for (const script of numnotequalVectors)
        execOK(script);
    });

    it('should OP_LESSTHAN', () => {
      const lessthanVectors = [
        '0 0 lessthan 0 equal',
        '0 1 lessthan 1 equal',
        '1 -1 lessthan 0 equal',
        '1 2 lessthan 1 equal',
        '-2147483647 2147483647 lessthan 1 equal',
        '-2147483647 -2147483647 lessthan 0 equal',
        '2147483647 2147483647 lessthan 0 equal',
        '2147483647 -2147483647 lessthan 0 equal',
        '2147483647 0 lessthan 0 equal',
        '0 2147483647 lessthan 1 equal'
      ];

      for (const script of lessthanVectors)
        execOK(script);
    });

    it('should OP_GREATERTHAN', () => {
      const greaterthanVectors = [
        '0 0 greaterthan 0 equal',
        '0 1 greaterthan 0 equal',
        '1 -1 greaterthan 1 equal',
        '1 2 greaterthan 0 equal',
        '-2147483647 2147483647 greaterthan 0 equal',
        '-2147483647 -2147483647 greaterthan 0 equal',
        '2147483647 2147483647 greaterthan 0 equal',
        '2147483647 -2147483647 greaterthan 1 equal',
        '2147483647 0 greaterthan 1 equal',
        '0 2147483647 greaterthan 0 equal'
      ];

      for (const script of greaterthanVectors)
        execOK(script);
    });

    it('should OP_LESSTHANOREQUAL', () => {
      const lessthanorequalVectors = [
        '0 0 lessthanorequal 1 equal',
        '0 1 lessthanorequal 1 equal',
        '1 -1 lessthanorequal 0 equal',
        '1 2 lessthanorequal 1 equal',
        '-2147483647 2147483647 lessthanorequal 1 equal',
        '-2147483647 -2147483647 lessthanorequal 1 equal',
        '2147483647 2147483647 lessthanorequal 1 equal',
        '2147483647 -2147483647 lessthanorequal 0 equal',
        '2147483647 0 lessthanorequal 0 equal',
        '0 2147483647 lessthanorequal 1 equal'
      ];

      for (const script of lessthanorequalVectors)
        execOK(script);
    });

    it('should OP_GREATERTHANOREQUAL', () => {
      const greaterthanorequalVectors = [
        '0 0 greaterthanorequal 1 equal',
        '0 1 greaterthanorequal 0 equal',
        '1 -1 greaterthanorequal 1 equal',
        '1 2 greaterthanorequal 0 equal',
        '-2147483647 2147483647 greaterthanorequal 0 equal',
        '-2147483647 -2147483647 greaterthanorequal 1 equal',
        '2147483647 2147483647 greaterthanorequal 1 equal',
        '2147483647 -2147483647 greaterthanorequal 1 equal',
        '2147483647 0 greaterthanorequal 1 equal',
        '0 2147483647 greaterthanorequal 0 equal'
      ];

      for (const script of greaterthanorequalVectors)
        execOK(script);
    });

    it('should OP_MIN', () => {
      const minVectors = [
        '0 0 min 0 equal',
        '0 1 min 0 equal',
        '1 -1 min -1 equal',
        '1 2 min 1 equal',
        '-2147483647 2147483647 min -2147483647 equal',
        '-2147483647 -2147483647 min -2147483647 equal',
        '2147483647 2147483647 min 2147483647 equal',
        '2147483647 -2147483647 min -2147483647 equal',
        '2147483647 0 min 0 equal',
        '0 2147483647 min 0 equal'
      ];

      for (const script of minVectors)
        execOK(script);
    });

    it('should OP_MAX', () => {
      const maxVectors = [
        '0 0 max 0 equal',
        '0 1 max 1 equal',
        '1 -1 max 1 equal',
        '1 2 max 2 equal',
        '-2147483647 0 max 0 equal',
        '-2147483647 2147483647 max 2147483647 equal',
        '-2147483647 -2147483647 max -2147483647 equal',
        '2147483647 2147483647 max 2147483647 equal',
        '2147483647 -2147483647 max 2147483647 equal',
        '2147483647 0 max 2147483647 equal',
        '0 2147483647 max 2147483647 equal'
      ];

      for (const script of maxVectors)
        execOK(script);
    });

    it('should OP_WITHIN', () => {
      const withinVectors = [
        '0 -1 1 within 1 equal',
        '0 0 1 within 1 equal',
        '0 -2147483647 2147483647 within 1 equal',
        '-2147483647 -2147483647 2147483647 within 1 equal',
        '2147483646 -2147483647 2147483647 within 1 equal',
        '2147483647 -2147483647 2147483647 within 0 equal',
        '0 -2147483647 -2147483647 within 0 equal',
        '0 2147483647 2147483647 within 0 equal',
        '0 2147483647 -2147483647 within 0 equal',
        '0 2147483647 0 within 0 equal',
        '0 0 2147483647 within 1 equal'
      ];

      for (const script of withinVectors)
        execOK(script);
    });
  });
});
