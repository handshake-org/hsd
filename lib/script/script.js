/*!
 * script.js - script interpreter for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const ripemd160 = require('bcrypto/lib/ripemd160');
const sha1 = require('bcrypto/lib/sha1');
const sha256 = require('bcrypto/lib/sha256');
const hash160 = require('bcrypto/lib/hash160');
const hash256 = require('bcrypto/lib/hash256');
const blake2b = require('bcrypto/lib/blake2b');
const sha3 = require('bcrypto/lib/sha3');
const keccak = require('bcrypto/lib/keccak');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../protocol/consensus');
const Opcode = require('./opcode');
const Stack = require('./stack');
const ScriptError = require('./scripterror');
const ScriptNum = require('./scriptnum');
const common = require('./common');
const opcodes = common.opcodes;
const scriptTypes = common.types;
const {encoding} = bio;

/*
 * Constants
 */

const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Script
 * Represents a input or output script.
 * @alias module:script.Script
 * @property {Array} code - Parsed script code.
 * @property {Buffer?} raw - Serialized script.
 * @property {Number} length - Number of parsed opcodes.
 */

class Script extends bio.Struct {
  /**
   * Create a script.
   * @constructor
   * @param {Buffer|Array|Object} code
   */

  constructor(options) {
    super();

    this.raw = EMPTY_BUFFER;
    this.code = [];

    if (options)
      this.fromOptions(options);
  }

  /**
   * Get length.
   * @returns {Number}
   */

  get length() {
    return this.code.length;
  }

  /**
   * Set length.
   * @param {Number} value
   */

  set length(value) {
    this.code.length = value;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Script data is required.');

    if (Buffer.isBuffer(options))
      return this.decode(options);

    if (Array.isArray(options))
      return this.fromArray(options);

    if (options.raw) {
      if (!options.code)
        return this.decode(options.raw);
      assert(Buffer.isBuffer(options.raw), 'Raw must be a Buffer.');
      this.raw = options.raw;
    }

    if (options.code) {
      if (!options.raw)
        return this.fromArray(options.code);
      assert(Array.isArray(options.code), 'Code must be an array.');
      this.code = options.code;
    }

    return this;
  }

  /**
   * Instantiate a value-only iterator.
   * @returns {ScriptIterator}
   */

  values() {
    return this.code.values();
  }

  /**
   * Instantiate a key and value iterator.
   * @returns {ScriptIterator}
   */

  entries() {
    return this.code.entries();
  }

  /**
   * Instantiate a value-only iterator.
   * @returns {ScriptIterator}
   */

  [Symbol.iterator]() {
    return this.code[Symbol.iterator]();
  }

  /**
   * Convert the script to an array of
   * Buffers (pushdatas) and Numbers
   * (opcodes).
   * @returns {Array}
   */

  toArray() {
    return this.code.slice();
  }

  /**
   * Inject properties from an array of
   * of buffers and numbers.
   * @private
   * @param {Array} code
   * @returns {Script}
   */

  fromArray(code) {
    assert(Array.isArray(code));

    this.clear();

    for (const op of code)
      this.push(op);

    return this.compile();
  }

  /**
   * Instantiate script from an array
   * of buffers and numbers.
   * @param {Array} code
   * @returns {Script}
   */

  static fromArray(code) {
    return new this().fromArray(code);
  }

  /**
   * Convert script to stack items.
   * @returns {Buffer[]}
   */

  toItems() {
    const items = [];

    for (const op of this.code) {
      const data = op.toPush();

      if (!data)
        throw new Error('Non-push opcode in script.');

      items.push(data);
    }

    return items;
  }

  /**
   * Inject data from stack items.
   * @private
   * @param {Buffer[]} items
   * @returns {Script}
   */

  fromItems(items) {
    assert(Array.isArray(items));

    this.clear();

    for (const item of items)
      this.pushData(item);

    return this.compile();
  }

  /**
   * Instantiate script from stack items.
   * @param {Buffer[]} items
   * @returns {Script}
   */

  static fromItems(items) {
    return new this().fromItems(items);
  }

  /**
   * Convert script to stack.
   * @returns {Stack}
   */

  toStack() {
    return new Stack(this.toItems());
  }

  /**
   * Inject data from stack.
   * @private
   * @param {Stack} stack
   * @returns {Script}
   */

  fromStack(stack) {
    return this.fromItems(stack.items);
  }

  /**
   * Instantiate script from stack.
   * @param {Stack} stack
   * @returns {Script}
   */

  static fromStack(stack) {
    return new this().fromStack(stack);
  }

  /**
   * Inject properties from script.
   * Used for cloning.
   * @private
   * @param {Script} script
   * @returns {Script}
   */

  inject(script) {
    this.raw = script.raw;
    this.code = script.code.slice();
    return this;
  }

  /**
   * Test equality against script.
   * @param {Script} script
   * @returns {Boolean}
   */

  equals(script) {
    assert(Script.isScript(script));
    return this.raw.equals(script.raw);
  }

  /**
   * Compare against another script.
   * @param {Script} script
   * @returns {Number}
   */

  compare(script) {
    assert(Script.isScript(script));
    return this.raw.compare(script.raw);
  }

  /**
   * Clear the script.
   * @returns {Script}
   */

  clear() {
    this.raw = EMPTY_BUFFER;
    this.code.length = 0;
    return this;
  }

  /**
   * Inspect the script.
   * @returns {String} Human-readable script code.
   */

  format() {
    return `<Script: ${this.toString()}>`;
  }

  /**
   * Convert the script to a bitcoind test string.
   * @returns {String} Human-readable script code.
   */

  toString() {
    const out = [];

    for (const op of this.code)
      out.push(op.toFormat());

    return out.join(' ');
  }

  /**
   * Format the script as bitcoind asm.
   * @param {Boolean?} decode - Attempt to decode hash types.
   * @returns {String} Human-readable script.
   */

  toASM(decode) {
    const out = [];

    for (const op of this.code)
      out.push(op.toASM(decode));

    return out.join(' ');
  }

  /**
   * Re-encode the script internally. Useful if you
   * changed something manually in the `code` array.
   * @returns {Script}
   */

  compile() {
    if (this.code.length === 0)
      return this.clear();

    let size = 0;

    for (const op of this.code)
      size += op.getSize();

    const bw = bio.write(size);

    for (const op of this.code)
      op.write(bw);

    this.raw = bw.render();

    return this;
  }

  /**
   * Write the script to a buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeVarBytes(this.raw);
    return bw;
  }

  /**
   * Encode the script to a Buffer. See {@link Script#encode}.
   * @param {String} enc - Encoding, either `'hex'` or `null`.
   * @returns {Buffer|String} Serialized script.
   */

  encode() {
    return this.raw;
  }

  /**
   * Convert script to a hex string.
   * @returns {String}
   */

  getJSON() {
    return this.toHex();
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {String} json
   */

  fromJSON(json) {
    assert(typeof json === 'string', 'Code must be a string.');
    return this.decode(Buffer.from(json, 'hex'));
  }

  /**
   * Get the script's "subscript" starting at a separator.
   * @param {Number} index - The last separator to sign/verify beyond.
   * @returns {Script} Subscript.
   */

  getSubscript(index) {
    if (index === 0)
      return this.clone();

    const script = new Script();

    for (let i = index; i < this.code.length; i++) {
      const op = this.code[i];

      if (op.value === -1)
        break;

      script.code.push(op);
    }

    return script.compile();
  }

  /**
   * Get the script's "subscript" starting at a separator.
   * Remove all OP_CODESEPARATORs if present. This bizarre
   * behavior is necessary for signing and verification when
   * code separators are present.
   * @returns {Script} Subscript.
   */

  removeSeparators() {
    let found = false;

    // Optimizing for the common case:
    // Check for any separators first.
    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (op.value === opcodes.OP_CODESEPARATOR) {
        found = true;
        break;
      }
    }

    if (!found)
      return this;

    // Uncommon case: someone actually
    // has a code separator. Go through
    // and remove them all.
    const script = new Script();

    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (op.value !== opcodes.OP_CODESEPARATOR)
        script.code.push(op);
    }

    return script.compile();
  }

  /**
   * Execute and interpret the script.
   * @param {Stack} stack - Script execution stack.
   * @param {Number?} flags - Script standard flags.
   * @param {TX?} tx - Transaction being verified.
   * @param {Number?} index - Index of input being verified.
   * @param {Amount?} value - Previous output value.
   * @throws {ScriptError} Will be thrown on VERIFY failures.
   */

  execute(stack, flags, tx, index, value) {
    if (flags == null)
      flags = Script.flags.STANDARD_VERIFY_FLAGS;

    if (this.raw.length > consensus.MAX_SCRIPT_SIZE)
      throw new ScriptError('SCRIPT_SIZE');

    const state = [];
    const alt = [];

    let lastSep = 0;
    let opCount = 0;
    let negate = 0;
    let minimal = false;

    if (flags & Script.flags.VERIFY_MINIMALDATA)
      minimal = true;

    for (let ip = 0; ip < this.code.length; ip++) {
      const op = this.code[ip];

      if (op.value === -1)
        throw new ScriptError('BAD_OPCODE', op, ip);

      if (op.data && op.data.length > consensus.MAX_SCRIPT_PUSH)
        throw new ScriptError('PUSH_SIZE', op, ip);

      if (op.value > opcodes.OP_16 && ++opCount > consensus.MAX_SCRIPT_OPS)
        throw new ScriptError('OP_COUNT', op, ip);

      if (op.isDisabled())
        throw new ScriptError('DISABLED_OPCODE', op, ip);

      if (negate && !op.isBranch()) {
        if (stack.length + alt.length > consensus.MAX_SCRIPT_STACK)
          throw new ScriptError('STACK_SIZE', op, ip);
        continue;
      }

      if (op.data) {
        if (minimal && !op.isMinimal())
          throw new ScriptError('MINIMALDATA', op, ip);

        stack.push(op.data);

        if (stack.length + alt.length > consensus.MAX_SCRIPT_STACK)
          throw new ScriptError('STACK_SIZE', op, ip);

        continue;
      }

      switch (op.value) {
        case opcodes.OP_0: {
          stack.pushInt(0);
          break;
        }
        case opcodes.OP_1NEGATE: {
          stack.pushInt(-1);
          break;
        }
        case opcodes.OP_1:
        case opcodes.OP_2:
        case opcodes.OP_3:
        case opcodes.OP_4:
        case opcodes.OP_5:
        case opcodes.OP_6:
        case opcodes.OP_7:
        case opcodes.OP_8:
        case opcodes.OP_9:
        case opcodes.OP_10:
        case opcodes.OP_11:
        case opcodes.OP_12:
        case opcodes.OP_13:
        case opcodes.OP_14:
        case opcodes.OP_15:
        case opcodes.OP_16: {
          stack.pushInt(op.value - 0x50);
          break;
        }
        case opcodes.OP_NOP: {
          break;
        }
        case opcodes.OP_TYPE: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (index >= tx.outputs.length) {
            stack.pushInt(0);
            break;
          }

          const {covenant} = tx.outputs[index];

          stack.pushInt(covenant.type);

          break;
        }
        case opcodes.OP_CHECKLOCKTIMEVERIFY: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const num = stack.getNum(-1, minimal, 5);

          if (num.isNeg())
            throw new ScriptError('NEGATIVE_LOCKTIME', op, ip);

          const locktime = num.toDouble();

          if (!tx.verifyLocktime(index, locktime))
            throw new ScriptError('UNSATISFIED_LOCKTIME', op, ip);

          break;
        }
        case opcodes.OP_CHECKSEQUENCEVERIFY: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const num = stack.getNum(-1, minimal, 5);

          if (num.isNeg())
            throw new ScriptError('NEGATIVE_LOCKTIME', op, ip);

          const locktime = num.toDouble();

          if (!tx.verifySequence(index, locktime))
            throw new ScriptError('UNSATISFIED_LOCKTIME', op, ip);

          break;
        }
        case opcodes.OP_NOP1:
        case opcodes.OP_NOP4:
        case opcodes.OP_NOP5:
        case opcodes.OP_NOP6:
        case opcodes.OP_NOP7:
        case opcodes.OP_NOP8:
        case opcodes.OP_NOP9:
        case opcodes.OP_NOP10: {
          if (flags & Script.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
            throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
          break;
        }
        case opcodes.OP_IF:
        case opcodes.OP_NOTIF: {
          let val = false;

          if (!negate) {
            if (stack.length < 1)
              throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

            if (flags & Script.flags.VERIFY_MINIMALIF) {
              const item = stack.get(-1);

              if (item.length > 1)
                throw new ScriptError('MINIMALIF');

              if (item.length === 1 && item[0] !== 1)
                throw new ScriptError('MINIMALIF');
            }

            val = stack.getBool(-1);

            if (op.value === opcodes.OP_NOTIF)
              val = !val;

            stack.pop();
          }

          state.push(val);

          if (!val)
            negate += 1;

          break;
        }
        case opcodes.OP_ELSE: {
          if (state.length === 0)
            throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

          state[state.length - 1] = !state[state.length - 1];

          if (!state[state.length - 1])
            negate += 1;
          else
            negate -= 1;

          break;
        }
        case opcodes.OP_ENDIF: {
          if (state.length === 0)
            throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

          if (!state.pop())
            negate -= 1;

          break;
        }
        case opcodes.OP_VERIFY: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          if (!stack.getBool(-1))
            throw new ScriptError('VERIFY', op, ip);

          stack.pop();

          break;
        }
        case opcodes.OP_RETURN: {
          throw new ScriptError('OP_RETURN', op, ip);
        }
        case opcodes.OP_TOALTSTACK: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          alt.push(stack.pop());
          break;
        }
        case opcodes.OP_FROMALTSTACK: {
          if (alt.length === 0)
            throw new ScriptError('INVALID_ALTSTACK_OPERATION', op, ip);

          stack.push(alt.pop());
          break;
        }
        case opcodes.OP_2DROP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pop();
          stack.pop();
          break;
        }
        case opcodes.OP_2DUP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-2);
          const v2 = stack.get(-1);

          stack.push(v1);
          stack.push(v2);
          break;
        }
        case opcodes.OP_3DUP: {
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-3);
          const v2 = stack.get(-2);
          const v3 = stack.get(-1);

          stack.push(v1);
          stack.push(v2);
          stack.push(v3);
          break;
        }
        case opcodes.OP_2OVER: {
          if (stack.length < 4)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-4);
          const v2 = stack.get(-3);

          stack.push(v1);
          stack.push(v2);
          break;
        }
        case opcodes.OP_2ROT: {
          if (stack.length < 6)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-6);
          const v2 = stack.get(-5);

          stack.erase(-6, -4);
          stack.push(v1);
          stack.push(v2);
          break;
        }
        case opcodes.OP_2SWAP: {
          if (stack.length < 4)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.swap(-4, -2);
          stack.swap(-3, -1);
          break;
        }
        case opcodes.OP_IFDUP: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          if (stack.getBool(-1)) {
            const val = stack.get(-1);
            stack.push(val);
          }

          break;
        }
        case opcodes.OP_DEPTH: {
          stack.pushInt(stack.length);
          break;
        }
        case opcodes.OP_DROP: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pop();
          break;
        }
        case opcodes.OP_DUP: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(stack.get(-1));
          break;
        }
        case opcodes.OP_NIP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.remove(-2);
          break;
        }
        case opcodes.OP_OVER: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(stack.get(-2));
          break;
        }
        case opcodes.OP_PICK:
        case opcodes.OP_ROLL: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const num = stack.getInt(-1, minimal, 4);
          stack.pop();

          if (num < 0 || num >= stack.length)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const val = stack.get(-num - 1);

          if (op.value === opcodes.OP_ROLL)
            stack.remove(-num - 1);

          stack.push(val);
          break;
        }
        case opcodes.OP_ROT: {
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.swap(-3, -2);
          stack.swap(-2, -1);
          break;
        }
        case opcodes.OP_SWAP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.swap(-2, -1);
          break;
        }
        case opcodes.OP_TUCK: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.insert(-2, stack.get(-1));
          break;
        }
        case opcodes.OP_SIZE: {
          if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pushInt(stack.get(-1).length);
          break;
        }
        case opcodes.OP_EQUAL:
        case opcodes.OP_EQUALVERIFY: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-2);
          const v2 = stack.get(-1);

          const res = v1.equals(v2);

          stack.pop();
          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_EQUALVERIFY) {
            if (!res)
              throw new ScriptError('EQUALVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_1ADD:
        case opcodes.OP_1SUB:
        case opcodes.OP_NEGATE:
        case opcodes.OP_ABS:
        case opcodes.OP_NOT:
        case opcodes.OP_0NOTEQUAL: {
          if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          let num = stack.getNum(-1, minimal, 4);
          let cmp;

          switch (op.value) {
            case opcodes.OP_1ADD:
              num.iaddn(1);
              break;
            case opcodes.OP_1SUB:
              num.isubn(1);
              break;
            case opcodes.OP_NEGATE:
              num.ineg();
              break;
            case opcodes.OP_ABS:
              num.iabs();
              break;
            case opcodes.OP_NOT:
              cmp = num.isZero();
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_0NOTEQUAL:
              cmp = !num.isZero();
              num = ScriptNum.fromBool(cmp);
              break;
            default:
              assert(false, 'Fatal script error.');
              break;
          }

          stack.pop();
          stack.pushNum(num);

          break;
        }
        case opcodes.OP_ADD:
        case opcodes.OP_SUB:
        case opcodes.OP_BOOLAND:
        case opcodes.OP_BOOLOR:
        case opcodes.OP_NUMEQUAL:
        case opcodes.OP_NUMEQUALVERIFY:
        case opcodes.OP_NUMNOTEQUAL:
        case opcodes.OP_LESSTHAN:
        case opcodes.OP_GREATERTHAN:
        case opcodes.OP_LESSTHANOREQUAL:
        case opcodes.OP_GREATERTHANOREQUAL:
        case opcodes.OP_MIN:
        case opcodes.OP_MAX: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const n1 = stack.getNum(-2, minimal, 4);
          const n2 = stack.getNum(-1, minimal, 4);

          let num, cmp;

          switch (op.value) {
            case opcodes.OP_ADD:
              num = n1.iadd(n2);
              break;
            case opcodes.OP_SUB:
              num = n1.isub(n2);
              break;
            case opcodes.OP_BOOLAND:
              cmp = n1.toBool() && n2.toBool();
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_BOOLOR:
              cmp = n1.toBool() || n2.toBool();
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_NUMEQUAL:
              cmp = n1.eq(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_NUMEQUALVERIFY:
              cmp = n1.eq(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_NUMNOTEQUAL:
              cmp = !n1.eq(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_LESSTHAN:
              cmp = n1.lt(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_GREATERTHAN:
              cmp = n1.gt(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_LESSTHANOREQUAL:
              cmp = n1.lte(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_GREATERTHANOREQUAL:
              cmp = n1.gte(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_MIN:
              num = ScriptNum.min(n1, n2);
              break;
            case opcodes.OP_MAX:
              num = ScriptNum.max(n1, n2);
              break;
            default:
              assert(false, 'Fatal script error.');
              break;
          }

          stack.pop();
          stack.pop();
          stack.pushNum(num);

          if (op.value === opcodes.OP_NUMEQUALVERIFY) {
            if (!stack.getBool(-1))
              throw new ScriptError('NUMEQUALVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_WITHIN: {
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const n1 = stack.getNum(-3, minimal, 4);
          const n2 = stack.getNum(-2, minimal, 4);
          const n3 = stack.getNum(-1, minimal, 4);

          const val = n2.lte(n1) && n1.lt(n3);

          stack.pop();
          stack.pop();
          stack.pop();

          stack.pushBool(val);
          break;
        }
        case opcodes.OP_RIPEMD160: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(ripemd160.digest(stack.pop()));
          break;
        }
        case opcodes.OP_SHA1: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(sha1.digest(stack.pop()));
          break;
        }
        case opcodes.OP_SHA256: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(sha256.digest(stack.pop()));
          break;
        }
        case opcodes.OP_HASH160: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(hash160.digest(stack.pop()));
          break;
        }
        case opcodes.OP_HASH256: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(hash256.digest(stack.pop()));
          break;
        }
        case opcodes.OP_BLAKE160: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(blake2b.digest(stack.pop(), 20));
          break;
        }
        case opcodes.OP_BLAKE256: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(blake2b.digest(stack.pop()));
          break;
        }
        case opcodes.OP_SHA3: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(sha3.digest(stack.pop()));
          break;
        }
        case opcodes.OP_KECCAK: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(keccak.digest(stack.pop()));
          break;
        }
        case opcodes.OP_CODESEPARATOR: {
          lastSep = ip + 1;
          break;
        }
        case opcodes.OP_CHECKSIG:
        case opcodes.OP_CHECKSIGVERIFY: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const sig = stack.get(-2);
          const key = stack.get(-1);

          const subscript = this.getSubscript(lastSep);

          validateSignature(sig, flags);
          validateKey(key, flags);

          let res = false;

          if (sig.length > 0) {
            const type = sig[sig.length - 1];
            const hash = tx.signatureHash(
              index,
              subscript,
              value,
              type
            );
            res = checksig(hash, sig, key);
          }

          if (!res && (flags & Script.flags.VERIFY_NULLFAIL)) {
            if (sig.length !== 0)
              throw new ScriptError('NULLFAIL', op, ip);
          }

          stack.pop();
          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_CHECKSIGVERIFY) {
            if (!res)
              throw new ScriptError('CHECKSIGVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_CHECKMULTISIG:
        case opcodes.OP_CHECKMULTISIGVERIFY: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          let i = 1;
          if (stack.length < i)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          let n = stack.getInt(-i, minimal, 4);
          let okey = n + 2;
          let ikey, isig;

          if (n < 0 || n > consensus.MAX_MULTISIG_PUBKEYS)
            throw new ScriptError('PUBKEY_COUNT', op, ip);

          opCount += n;

          if (opCount > consensus.MAX_SCRIPT_OPS)
            throw new ScriptError('OP_COUNT', op, ip);

          i += 1;
          ikey = i;
          i += n;

          if (stack.length < i)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          let m = stack.getInt(-i, minimal, 4);

          if (m < 0 || m > n)
            throw new ScriptError('SIG_COUNT', op, ip);

          i += 1;
          isig = i;
          i += m;

          if (stack.length < i)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const subscript = this.getSubscript(lastSep);

          let res = true;
          while (res && m > 0) {
            const sig = stack.get(-isig);
            const key = stack.get(-ikey);

            validateSignature(sig, flags);
            validateKey(key, flags);

            if (sig.length > 0) {
              const type = sig[sig.length - 1];
              const hash = tx.signatureHash(
                index,
                subscript,
                value,
                type
              );

              if (checksig(hash, sig, key)) {
                isig += 1;
                m -= 1;
              }
            }

            ikey += 1;
            n -= 1;

            if (m > n)
              res = false;
          }

          while (i > 1) {
            if (!res && (flags & Script.flags.VERIFY_NULLFAIL)) {
              if (okey === 0 && stack.get(-1).length !== 0)
                throw new ScriptError('NULLFAIL', op, ip);
            }

            if (okey > 0)
              okey -= 1;

            stack.pop();

            i -= 1;
          }

          if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          if (stack.get(-1).length !== 0)
            throw new ScriptError('SIG_NULLDUMMY', op, ip);

          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_CHECKMULTISIGVERIFY) {
            if (!res)
              throw new ScriptError('CHECKMULTISIGVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        default: {
          throw new ScriptError('BAD_OPCODE', op, ip);
        }
      }

      if (stack.length + alt.length > consensus.MAX_SCRIPT_STACK)
        throw new ScriptError('STACK_SIZE', op, ip);
    }

    if (state.length !== 0)
      throw new ScriptError('UNBALANCED_CONDITIONAL');
  }

  /**
   * Find a data element in a script.
   * @param {Buffer} data - Data element to match against.
   * @returns {Number} Index (`-1` if not present).
   */

  indexOf(data) {
    for (let i = 0; i < this.code.length; i++) {
      const op = this.code[i];

      if (op.value === -1)
        break;

      if (!op.data)
        continue;

      if (op.data.equals(data))
        return i;
    }

    return -1;
  }

  /**
   * Test a script to see if it is likely
   * to be script code (no weird opcodes).
   * @returns {Boolean}
   */

  isCode() {
    for (const op of this.code) {
      if (op.value === -1)
        return false;

      if (op.isDisabled())
        return false;

      switch (op.value) {
        case opcodes.OP_RESERVED:
        case opcodes.OP_NOP:
        case opcodes.OP_VER:
        case opcodes.OP_VERIF:
        case opcodes.OP_VERNOTIF:
        case opcodes.OP_RESERVED1:
        case opcodes.OP_RESERVED2:
          return false;
      }

      if (op.value > opcodes.OP_CHECKSEQUENCEVERIFY)
        return false;
    }

    return true;
  }

  /**
   * Inject properties from a pay-to-pubkey script.
   * @private
   * @param {Buffer} key
   */

  fromPubkey(key) {
    assert(Buffer.isBuffer(key) && key.length === 33);

    this.raw = Buffer.allocUnsafe(35);
    this.raw[0] = 33;
    key.copy(this.raw, 1);
    this.raw[34] = opcodes.OP_CHECKSIG;

    key = this.raw.slice(1, 34);

    this.code.length = 0;
    this.code.push(Opcode.fromPush(key));
    this.code.push(Opcode.fromOp(opcodes.OP_CHECKSIG));

    return this;
  }

  /**
   * Create a pay-to-pubkey script.
   * @param {Buffer} key
   * @returns {Script}
   */

  static fromPubkey(key) {
    return new this().fromPubkey(key);
  }

  /**
   * Inject properties from a pay-to-pubkeyhash script.
   * @private
   * @param {Buffer} hash
   */

  fromPubkeyhash(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 20);

    this.raw = Buffer.allocUnsafe(25);
    this.raw[0] = opcodes.OP_DUP;
    this.raw[1] = opcodes.OP_BLAKE160;
    this.raw[2] = 0x14;
    hash.copy(this.raw, 3);
    this.raw[23] = opcodes.OP_EQUALVERIFY;
    this.raw[24] = opcodes.OP_CHECKSIG;

    hash = this.raw.slice(3, 23);

    this.code.length = 0;
    this.code.push(Opcode.fromOp(opcodes.OP_DUP));
    this.code.push(Opcode.fromOp(opcodes.OP_BLAKE160));
    this.code.push(Opcode.fromPush(hash));
    this.code.push(Opcode.fromOp(opcodes.OP_EQUALVERIFY));
    this.code.push(Opcode.fromOp(opcodes.OP_CHECKSIG));

    return this;
  }

  /**
   * Create a pay-to-pubkeyhash script.
   * @param {Buffer} hash
   * @returns {Script}
   */

  static fromPubkeyhash(hash) {
    return new this().fromPubkeyhash(hash);
  }

  /**
   * Inject properties from pay-to-multisig script.
   * @private
   * @param {Number} m
   * @param {Number} n
   * @param {Buffer[]} keys
   */

  fromMultisig(m, n, keys) {
    assert((m & 0xff) === m && (n & 0xff) === n);
    assert(Array.isArray(keys));
    assert(keys.length === n, '`n` keys are required for multisig.');
    assert(m >= 1 && m <= n);
    assert(n >= 1 && n <= 15);

    this.clear();

    this.pushSmall(m);

    for (const key of sortKeys(keys))
      this.pushData(key);

    this.pushSmall(n);
    this.pushOp(opcodes.OP_CHECKMULTISIG);

    return this.compile();
  }

  /**
   * Create a pay-to-multisig script.
   * @param {Number} m
   * @param {Number} n
   * @param {Buffer[]} keys
   * @returns {Script}
   */

  static fromMultisig(m, n, keys) {
    return new this().fromMultisig(m, n, keys);
  }

  /**
   * Get the standard script type.
   * @returns {ScriptType}
   */

  getType() {
    if (this.isPubkey())
      return scriptTypes.PUBKEY;

    if (this.isPubkeyhash())
      return scriptTypes.PUBKEYHASH;

    if (this.isMultisig())
      return scriptTypes.MULTISIG;

    return scriptTypes.NONSTANDARD;
  }

  /**
   * Test whether a script is of an unknown/non-standard type.
   * @returns {Boolean}
   */

  isUnknown() {
    return this.getType() === scriptTypes.NONSTANDARD;
  }

  /**
   * Test whether the script is standard by policy standards.
   * @returns {Boolean}
   */

  isStandard() {
    const [m, n] = this.getMultisig();

    if (m !== -1) {
      if (n < 1 || n > 3)
        return false;

      if (m < 1 || m > n)
        return false;

      return true;
    }

    return this.getType() !== scriptTypes.NONSTANDARD;
  }

  /**
   * Calculate the size of the script
   * excluding the varint size bytes.
   * @returns {Number}
   */

  getSize() {
    return this.raw.length;
  }

  /**
   * Calculate the size of the script
   * including the varint size bytes.
   * @returns {Number}
   */

  getVarSize() {
    return encoding.sizeVarBytes(this.raw);
  }

  /**
   * Get the sha3 of the raw script.
   * @returns {Hash}
   */

  sha3() {
    return sha3.digest(this.encode());
  }

  /**
   * Test whether the output script is pay-to-pubkey.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Boolean}
   */

  isPubkey(minimal) {
    if (minimal) {
      return this.raw.length === 35
        && this.raw[0] === 33
        && this.raw[0] + 2 === this.raw.length
        && this.raw[this.raw.length - 1] === opcodes.OP_CHECKSIG;
    }

    if (this.code.length !== 2)
      return false;

    return this.getLength(0) === 33
      && this.getOp(1) === opcodes.OP_CHECKSIG;
  }

  /**
   * Get P2PK key if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Buffer|null}
   */

  getPubkey(minimal) {
    if (!this.isPubkey(minimal))
      return null;

    if (minimal)
      return this.raw.slice(1, 1 + this.raw[0]);

    return this.getData(0);
  }

  /**
   * Test whether the output script is pay-to-pubkeyhash.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Boolean}
   */

  isPubkeyhash(minimal) {
    if (minimal || this.raw.length === 25) {
      return this.raw.length === 25
        && this.raw[0] === opcodes.OP_DUP
        && this.raw[1] === opcodes.OP_BLAKE160
        && this.raw[2] === 0x14
        && this.raw[23] === opcodes.OP_EQUALVERIFY
        && this.raw[24] === opcodes.OP_CHECKSIG;
    }

    if (this.code.length !== 5)
      return false;

    return this.getOp(0) === opcodes.OP_DUP
      && this.getOp(1) === opcodes.OP_BLAKE160
      && this.getLength(2) === 20
      && this.getOp(3) === opcodes.OP_EQUALVERIFY
      && this.getOp(4) === opcodes.OP_CHECKSIG;
  }

  /**
   * Get P2PKH hash if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Buffer|null}
   */

  getPubkeyhash(minimal) {
    if (!this.isPubkeyhash(minimal))
      return null;

    if (minimal)
      return this.raw.slice(3, 23);

    return this.getData(2);
  }

  /**
   * Test whether the output script is pay-to-multisig.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Boolean}
   */

  isMultisig(minimal) {
    if (this.code.length < 4 || this.code.length > 19)
      return false;

    if (this.getOp(-1) !== opcodes.OP_CHECKMULTISIG)
      return false;

    const m = this.getSmall(0);

    if (m < 1)
      return false;

    const n = this.getSmall(-2);

    if (n < 1 || m > n)
      return false;

    if (this.code.length !== n + 3)
      return false;

    for (let i = 1; i < n + 1; i++) {
      const op = this.code[i];

      if (op.toLength() !== 33)
        return false;

      if (minimal && !op.isMinimal())
        return false;
    }

    return true;
  }

  /**
   * Get multisig m and n values if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Array} [m, n]
   */

  getMultisig(minimal) {
    if (!this.isMultisig(minimal))
      return [-1, -1];

    return [this.getSmall(0), this.getSmall(-2)];
  }

  /**
   * Test whether the output script is unspendable.
   * @returns {Boolean}
   */

  isUnspendable() {
    if (this.raw.length > consensus.MAX_SCRIPT_SIZE)
      return true;

    return this.raw.length > 0 && this.raw[0] === opcodes.OP_RETURN;
  }

  /**
   * Test the script against a bloom filter.
   * @param {Bloom} filter
   * @returns {Boolean}
   */

  test(filter) {
    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (!op.data || op.data.length === 0)
        continue;

      if (filter.test(op.data))
        return true;
    }

    return false;
  }

  /**
   * Test the script to see if it contains only push ops.
   * Push ops are: OP_1NEGATE, OP_0-OP_16 and all PUSHDATAs.
   * @returns {Boolean}
   */

  isPushOnly() {
    for (const op of this.code) {
      if (op.value === -1)
        return false;

      if (op.value > opcodes.OP_16)
        return false;
    }

    return true;
  }

  /**
   * Count the sigops in the script.
   * @returns {Number} sigop count
   */

  getSigops() {
    let total = 0;
    let lastOp = -1;

    for (const op of this.code) {
      if (op.value === -1)
        break;

      switch (op.value) {
        case opcodes.OP_CHECKSIG:
        case opcodes.OP_CHECKSIGVERIFY:
          total += 1;
          break;
        case opcodes.OP_CHECKMULTISIG:
        case opcodes.OP_CHECKMULTISIGVERIFY:
          if (lastOp >= opcodes.OP_1 && lastOp <= opcodes.OP_16)
            total += lastOp - 0x50;
          else
            total += consensus.MAX_MULTISIG_PUBKEYS;
          break;
      }

      lastOp = op.value;
    }

    return total;
  }

  /*
   * Mutation
   */

  get(index) {
    if (index < 0)
      index += this.code.length;

    if (index < 0 || index >= this.code.length)
      return null;

    return this.code[index];
  }

  pop() {
    const op = this.code.pop();
    return op || null;
  }

  shift() {
    const op = this.code.shift();
    return op || null;
  }

  remove(index) {
    if (index < 0)
      index += this.code.length;

    if (index < 0 || index >= this.code.length)
      return null;

    const items = this.code.splice(index, 1);

    if (items.length === 0)
      return null;

    return items[0];
  }

  set(index, op) {
    if (index < 0)
      index += this.code.length;

    assert(Opcode.isOpcode(op));
    assert(index >= 0 && index <= this.code.length);

    this.code[index] = op;

    return this;
  }

  push(op) {
    assert(Opcode.isOpcode(op));
    this.code.push(op);
    return this;
  }

  unshift(op) {
    assert(Opcode.isOpcode(op));
    this.code.unshift(op);
    return this;
  }

  insert(index, op) {
    if (index < 0)
      index += this.code.length;

    assert(Opcode.isOpcode(op));
    assert(index >= 0 && index <= this.code.length);

    this.code.splice(index, 0, op);

    return this;
  }

  /*
   * Op
   */

  getOp(index) {
    const op = this.get(index);
    return op ? op.value : -1;
  }

  popOp() {
    const op = this.pop();
    return op ? op.value : -1;
  }

  shiftOp() {
    const op = this.shift();
    return op ? op.value : -1;
  }

  removeOp(index) {
    const op = this.remove(index);
    return op ? op.value : -1;
  }

  setOp(index, value) {
    return this.set(index, Opcode.fromOp(value));
  }

  pushOp(value) {
    return this.push(Opcode.fromOp(value));
  }

  unshiftOp(value) {
    return this.unshift(Opcode.fromOp(value));
  }

  insertOp(index, value) {
    return this.insert(index, Opcode.fromOp(value));
  }

  /*
   * Data
   */

  getData(index) {
    const op = this.get(index);
    return op ? op.data : null;
  }

  popData() {
    const op = this.pop();
    return op ? op.data : null;
  }

  shiftData() {
    const op = this.shift();
    return op ? op.data : null;
  }

  removeData(index) {
    const op = this.remove(index);
    return op ? op.data : null;
  }

  setData(index, data) {
    return this.set(index, Opcode.fromData(data));
  }

  pushData(data) {
    return this.push(Opcode.fromData(data));
  }

  unshiftData(data) {
    return this.unshift(Opcode.fromData(data));
  }

  insertData(index, data) {
    return this.insert(index, Opcode.fromData(data));
  }

  /*
   * Length
   */

  getLength(index) {
    const op = this.get(index);
    return op ? op.toLength() : -1;
  }

  /*
   * Push
   */

  getPush(index) {
    const op = this.get(index);
    return op ? op.toPush() : null;
  }

  popPush() {
    const op = this.pop();
    return op ? op.toPush() : null;
  }

  shiftPush() {
    const op = this.shift();
    return op ? op.toPush() : null;
  }

  removePush(index) {
    const op = this.remove(index);
    return op ? op.toPush() : null;
  }

  setPush(index, data) {
    return this.set(index, Opcode.fromPush(data));
  }

  pushPush(data) {
    return this.push(Opcode.fromPush(data));
  }

  unshiftPush(data) {
    return this.unshift(Opcode.fromPush(data));
  }

  insertPush(index, data) {
    return this.insert(index, Opcode.fromPush(data));
  }

  /*
   * String
   */

  getString(index, enc) {
    const op = this.get(index);
    return op ? op.toString(enc) : null;
  }

  popString(enc) {
    const op = this.pop();
    return op ? op.toString(enc) : null;
  }

  shiftString(enc) {
    const op = this.shift();
    return op ? op.toString(enc) : null;
  }

  removeString(index, enc) {
    const op = this.remove(index);
    return op ? op.toString(enc) : null;
  }

  setString(index, str, enc) {
    return this.set(index, Opcode.fromString(str, enc));
  }

  pushString(str, enc) {
    return this.push(Opcode.fromString(str, enc));
  }

  unshiftString(str, enc) {
    return this.unshift(Opcode.fromString(str, enc));
  }

  insertString(index, str, enc) {
    return this.insert(index, Opcode.fromString(str, enc));
  }

  /*
   * Small
   */

  getSmall(index) {
    const op = this.get(index);
    return op ? op.toSmall() : -1;
  }

  popSmall() {
    const op = this.pop();
    return op ? op.toSmall() : -1;
  }

  shiftSmall() {
    const op = this.shift();
    return op ? op.toSmall() : -1;
  }

  removeSmall(index) {
    const op = this.remove(index);
    return op ? op.toSmall() : -1;
  }

  setSmall(index, num) {
    return this.set(index, Opcode.fromSmall(num));
  }

  pushSmall(num) {
    return this.push(Opcode.fromSmall(num));
  }

  unshiftSmall(num) {
    return this.unshift(Opcode.fromSmall(num));
  }

  insertSmall(index, num) {
    return this.insert(index, Opcode.fromSmall(num));
  }

  /*
   * Num
   */

  getNum(index, minimal, limit) {
    const op = this.get(index);
    return op ? op.toNum(minimal, limit) : null;
  }

  popNum(minimal, limit) {
    const op = this.pop();
    return op ? op.toNum(minimal, limit) : null;
  }

  shiftNum(minimal, limit) {
    const op = this.shift();
    return op ? op.toNum(minimal, limit) : null;
  }

  removeNum(index, minimal, limit) {
    const op = this.remove(index);
    return op ? op.toNum(minimal, limit) : null;
  }

  setNum(index, num) {
    return this.set(index, Opcode.fromNum(num));
  }

  pushNum(num) {
    return this.push(Opcode.fromNum(num));
  }

  unshiftNum(num) {
    return this.unshift(Opcode.fromNum(num));
  }

  insertNum(index, num) {
    return this.insert(index, Opcode.fromNum(num));
  }

  /*
   * Int
   */

  getInt(index, minimal, limit) {
    const op = this.get(index);
    return op ? op.toInt(minimal, limit) : -1;
  }

  popInt(minimal, limit) {
    const op = this.pop();
    return op ? op.toInt(minimal, limit) : -1;
  }

  shiftInt(minimal, limit) {
    const op = this.shift();
    return op ? op.toInt(minimal, limit) : -1;
  }

  removeInt(index, minimal, limit) {
    const op = this.remove(index);
    return op ? op.toInt(minimal, limit) : -1;
  }

  setInt(index, num) {
    return this.set(index, Opcode.fromInt(num));
  }

  pushInt(num) {
    return this.push(Opcode.fromInt(num));
  }

  unshiftInt(num) {
    return this.unshift(Opcode.fromInt(num));
  }

  insertInt(index, num) {
    return this.insert(index, Opcode.fromInt(num));
  }

  /*
   * Bool
   */

  getBool(index) {
    const op = this.get(index);
    return op ? op.toBool() : false;
  }

  popBool() {
    const op = this.pop();
    return op ? op.toBool() : false;
  }

  shiftBool() {
    const op = this.shift();
    return op ? op.toBool() : false;
  }

  removeBool(index) {
    const op = this.remove(index);
    return op ? op.toBool() : false;
  }

  setBool(index, value) {
    return this.set(index, Opcode.fromBool(value));
  }

  pushBool(value) {
    return this.push(Opcode.fromBool(value));
  }

  unshiftBool(value) {
    return this.unshift(Opcode.fromBool(value));
  }

  insertBool(index, value) {
    return this.insert(index, Opcode.fromBool(value));
  }

  /*
   * Symbol
   */

  getSym(index) {
    const op = this.get(index);
    return op ? op.toSymbol() : null;
  }

  popSym() {
    const op = this.pop();
    return op ? op.toSymbol() : null;
  }

  shiftSym() {
    const op = this.shift();
    return op ? op.toSymbol() : null;
  }

  removeSym(index) {
    const op = this.remove(index);
    return op ? op.toSymbol() : null;
  }

  setSym(index, symbol) {
    return this.set(index, Opcode.fromSymbol(symbol));
  }

  pushSym(symbol) {
    return this.push(Opcode.fromSymbol(symbol));
  }

  unshiftSym(symbol) {
    return this.unshift(Opcode.fromSymbol(symbol));
  }

  insertSym(index, symbol) {
    return this.insert(index, Opcode.fromSymbol(symbol));
  }

  /**
   * Inject properties from bitcoind test string.
   * @private
   * @param {String} items - Script string.
   * @throws Parse error.
   */

  fromString(code) {
    assert(typeof code === 'string');

    code = code.trim();

    if (code.length === 0)
      return this;

    const items = code.split(/\s+/);
    const bw = bio.write();

    for (const item of items) {
      let symbol = item;

      if (symbol.charCodeAt(0) & 32)
        symbol = symbol.toUpperCase();

      if (!/^OP_/.test(symbol))
        symbol = `OP_${symbol}`;

      const value = opcodes[symbol];

      if (value == null) {
        if (item[0] === '\'') {
          assert(item[item.length - 1] === '\'', 'Invalid string.');
          const str = item.slice(1, -1);
          const op = Opcode.fromString(str);
          bw.writeBytes(op.encode());
          continue;
        }

        if (/^-?\d+$/.test(item)) {
          const num = ScriptNum.fromString(item, 10);
          const op = Opcode.fromNum(num);
          bw.writeBytes(op.encode());
          continue;
        }

        assert(item.indexOf('0x') === 0, 'Unknown opcode.');

        const hex = item.substring(2);
        const data = Buffer.from(hex, 'hex');

        assert(data.length === hex.length / 2, 'Invalid hex string.');

        bw.writeBytes(data);

        continue;
      }

      bw.writeU8(value);
    }

    return this.decode(bw.render());
  }

  /**
   * Verify an input and output script, and a witness if present.
   * @param {Witness} witness
   * @param {Address} addr
   * @param {TX} tx
   * @param {Number} index
   * @param {Amount} value
   * @param {VerifyFlags} flags
   * @throws {ScriptError}
   */

  static verify(witness, addr, tx, index, value, flags) {
    if (flags == null)
      flags = Script.flags.STANDARD_VERIFY_FLAGS;

    assert(addr.version <= 31);

    if (addr.version === 31)
      throw new ScriptError('OP_RETURN');

    if (witness.items.length > consensus.MAX_SCRIPT_STACK)
      throw new ScriptError('STACK_SIZE');

    const stack = witness.toStack();

    let redeem = null;

    if (addr.version === 0) {
      if (addr.hash.length === 32) {
        if (stack.length === 0)
          throw new ScriptError('WITNESS_PROGRAM_WITNESS_EMPTY');

        const witnessScript = stack.pop();

        if (witnessScript.length > consensus.MAX_SCRIPT_SIZE)
          throw new ScriptError('SCRIPT_SIZE');

        if (!sha3.digest(witnessScript).equals(addr.hash))
          throw new ScriptError('WITNESS_PROGRAM_MISMATCH');

        redeem = Script.decode(witnessScript);
      } else if (addr.hash.length === 20) {
        if (stack.length !== 2)
          throw new ScriptError('WITNESS_PROGRAM_MISMATCH');

        redeem = Script.fromPubkeyhash(addr.hash);
      } else {
        // Failure on version=0 (bad program data length).
        throw new ScriptError('WITNESS_PROGRAM_WRONG_LENGTH');
      }
    } else {
      if (flags & Script.flags.VERIFY_DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM)
        throw new ScriptError('DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM');
      return;
    }

    // Witnesses still have push limits.
    for (let j = 0; j < stack.length; j++) {
      if (stack.get(j).length > consensus.MAX_SCRIPT_PUSH)
        throw new ScriptError('PUSH_SIZE');
    }

    // Verify the redeem script.
    redeem.execute(stack, flags, tx, index, value);

    // Verify the stack values.
    if (stack.length !== 1 || !stack.getBool(-1))
      throw new ScriptError('EVAL_FALSE');
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    return this.decode(br.readVarBytes());
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer}
   */

  decode(data) {
    const br = bio.read(data);

    this.raw = data;

    while (br.left())
      this.code.push(Opcode.read(br));

    return this;
  }

  /**
   * Test whether an object a Script.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isScript(obj) {
    return obj instanceof Script;
  }
}

/**
 * Script opcodes.
 * @enum {Number}
 * @default
 */

Script.opcodes = common.opcodes;

/**
 * Opcodes by value.
 * @const {RevMap}
 */

Script.opcodesByVal = common.opcodesByVal;

/**
 * Script and locktime flags. See {@link VerifyFlags}.
 * @enum {Number}
 */

Script.flags = common.flags;

/**
 * Sighash Types.
 * @enum {SighashType}
 * @default
 */

Script.hashType = common.hashType;

/**
 * Sighash types by value.
 * @const {RevMap}
 */

Script.hashTypeByVal = common.hashTypeByVal;

/**
 * Output script types.
 * @enum {Number}
 */

Script.types = common.types;

/**
 * Output script types by value.
 * @const {RevMap}
 */

Script.typesByVal = common.typesByVal;

/*
 * Helpers
 */

function sortKeys(keys) {
  return keys.slice().sort((a, b) => {
    return a.compare(b);
  });
}

/**
 * Test whether the data element is a valid key if VERIFY_STRICTENC is enabled.
 * @param {Buffer} key
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function validateKey(key, flags) {
  assert(Buffer.isBuffer(key));
  assert(typeof flags === 'number');

  if (!common.isKeyEncoding(key))
    throw new ScriptError('PUBKEY_ENCODING');

  return true;
}

/**
 * Test whether the data element is a valid signature based
 * on the encoding, S value, and sighash type. Requires
 * VERIFY_DERSIG|VERIFY_LOW_S|VERIFY_STRICTENC, VERIFY_LOW_S
 * and VERIFY_STRING_ENC to be enabled respectively. Note that
 * this will allow zero-length signatures.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function validateSignature(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  // Allow empty sigs
  if (sig.length === 0)
    return true;

  if (!common.isSignatureEncoding(sig))
    throw new ScriptError('SIG_ENCODING');

  return true;
}

/**
 * Verify a signature, taking into account sighash type.
 * @param {Buffer} msg - Signature hash.
 * @param {Buffer} sig
 * @param {Buffer} key
 * @returns {Boolean}
 */

function checksig(msg, sig, key) {
  return secp256k1.verify(msg, sig.slice(0, -1), key);
}

/*
 * Expose
 */

module.exports = Script;
