/*!
 * common.js - common script functions for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module script/common
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const ScriptNum = require('./scriptnum');

/**
 * Opcodes by value.
 * @const {Object}
 */

exports.opcodes = {
  // Push
  OP_0: 0x00,

  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_PUSHDATA4: 0x4e,

  OP_1NEGATE: 0x4f,

  OP_RESERVED: 0x50,

  OP_1: 0x51,
  OP_2: 0x52,
  OP_3: 0x53,
  OP_4: 0x54,
  OP_5: 0x55,
  OP_6: 0x56,
  OP_7: 0x57,
  OP_8: 0x58,
  OP_9: 0x59,
  OP_10: 0x5a,
  OP_11: 0x5b,
  OP_12: 0x5c,
  OP_13: 0x5d,
  OP_14: 0x5e,
  OP_15: 0x5f,
  OP_16: 0x60,

  // Control
  OP_NOP: 0x61,
  OP_VER: 0x62,
  OP_IF: 0x63,
  OP_NOTIF: 0x64,
  OP_VERIF: 0x65,
  OP_VERNOTIF: 0x66,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_VERIFY: 0x69,
  OP_RETURN: 0x6a,

  // Stack
  OP_TOALTSTACK: 0x6b,
  OP_FROMALTSTACK: 0x6c,
  OP_2DROP: 0x6d,
  OP_2DUP: 0x6e,
  OP_3DUP: 0x6f,
  OP_2OVER: 0x70,
  OP_2ROT: 0x71,
  OP_2SWAP: 0x72,
  OP_IFDUP: 0x73,
  OP_DEPTH: 0x74,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_NIP: 0x77,
  OP_OVER: 0x78,
  OP_PICK: 0x79,
  OP_ROLL: 0x7a,
  OP_ROT: 0x7b,
  OP_SWAP: 0x7c,
  OP_TUCK: 0x7d,

  // Splice
  OP_CAT: 0x7e,
  OP_SUBSTR: 0x7f,
  OP_LEFT: 0x80,
  OP_RIGHT: 0x81,
  OP_SIZE: 0x82,

  // Bit
  OP_INVERT: 0x83,
  OP_AND: 0x84,
  OP_OR: 0x85,
  OP_XOR: 0x86,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_RESERVED1: 0x89,
  OP_RESERVED2: 0x8a,

  // Numeric
  OP_1ADD: 0x8b,
  OP_1SUB: 0x8c,
  OP_2MUL: 0x8d,
  OP_2DIV: 0x8e,
  OP_NEGATE: 0x8f,
  OP_ABS: 0x90,
  OP_NOT: 0x91,
  OP_0NOTEQUAL: 0x92,
  OP_ADD: 0x93,
  OP_SUB: 0x94,
  OP_MUL: 0x95,
  OP_DIV: 0x96,
  OP_MOD: 0x97,
  OP_LSHIFT: 0x98,
  OP_RSHIFT: 0x99,
  OP_BOOLAND: 0x9a,
  OP_BOOLOR: 0x9b,
  OP_NUMEQUAL: 0x9c,
  OP_NUMEQUALVERIFY: 0x9d,
  OP_NUMNOTEQUAL: 0x9e,
  OP_LESSTHAN: 0x9f,
  OP_GREATERTHAN: 0xa0,
  OP_LESSTHANOREQUAL: 0xa1,
  OP_GREATERTHANOREQUAL: 0xa2,
  OP_MIN: 0xa3,
  OP_MAX: 0xa4,
  OP_WITHIN: 0xa5,

  // Crypto
  OP_RIPEMD160: 0xa6,
  OP_SHA1: 0xa7,
  OP_SHA256: 0xa8,
  OP_HASH160: 0xa9,
  OP_HASH256: 0xaa,
  OP_CODESEPARATOR: 0xab,
  OP_CHECKSIG: 0xac,
  OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKMULTISIG: 0xae,
  OP_CHECKMULTISIGVERIFY: 0xaf,

  // Expansion
  OP_NOP1: 0xb0,
  OP_CHECKLOCKTIMEVERIFY: 0xb1,
  OP_CHECKSEQUENCEVERIFY: 0xb2,
  OP_NOP4: 0xb3,
  OP_NOP5: 0xb4,
  OP_NOP6: 0xb5,
  OP_NOP7: 0xb6,
  OP_NOP8: 0xb7,
  OP_NOP9: 0xb8,
  OP_NOP10: 0xb9,

  // More Crypto
  OP_BLAKE160: 0xc0,
  OP_BLAKE256: 0xc1,
  OP_SHA3: 0xc2,
  OP_KECCAK: 0xc3,

  // More Ops
  OP_TYPE: 0xd0,

  // Custom
  OP_INVALIDOPCODE: 0xff
};

/**
 * Opcodes by value.
 * @const {Object}
 */

exports.opcodesByVal = {
  // Push
  0x00: 'OP_0',

  0x4c: 'OP_PUSHDATA1',
  0x4d: 'OP_PUSHDATA2',
  0x4e: 'OP_PUSHDATA4',

  0x4f: 'OP_1NEGATE',

  0x50: 'OP_RESERVED',

  0x51: 'OP_1',
  0x52: 'OP_2',
  0x53: 'OP_3',
  0x54: 'OP_4',
  0x55: 'OP_5',
  0x56: 'OP_6',
  0x57: 'OP_7',
  0x58: 'OP_8',
  0x59: 'OP_9',
  0x5a: 'OP_10',
  0x5b: 'OP_11',
  0x5c: 'OP_12',
  0x5d: 'OP_13',
  0x5e: 'OP_14',
  0x5f: 'OP_15',
  0x60: 'OP_16',

  // Control
  0x61: 'OP_NOP',
  0x62: 'OP_VER',
  0x63: 'OP_IF',
  0x64: 'OP_NOTIF',
  0x65: 'OP_VERIF',
  0x66: 'OP_VERNOTIF',
  0x67: 'OP_ELSE',
  0x68: 'OP_ENDIF',
  0x69: 'OP_VERIFY',
  0x6a: 'OP_RETURN',

  // Stack
  0x6b: 'OP_TOALTSTACK',
  0x6c: 'OP_FROMALTSTACK',
  0x6d: 'OP_2DROP',
  0x6e: 'OP_2DUP',
  0x6f: 'OP_3DUP',
  0x70: 'OP_2OVER',
  0x71: 'OP_2ROT',
  0x72: 'OP_2SWAP',
  0x73: 'OP_IFDUP',
  0x74: 'OP_DEPTH',
  0x75: 'OP_DROP',
  0x76: 'OP_DUP',
  0x77: 'OP_NIP',
  0x78: 'OP_OVER',
  0x79: 'OP_PICK',
  0x7a: 'OP_ROLL',
  0x7b: 'OP_ROT',
  0x7c: 'OP_SWAP',
  0x7d: 'OP_TUCK',

  // Splice
  0x7e: 'OP_CAT',
  0x7f: 'OP_SUBSTR',
  0x80: 'OP_LEFT',
  0x81: 'OP_RIGHT',
  0x82: 'OP_SIZE',

  // Bit
  0x83: 'OP_INVERT',
  0x84: 'OP_AND',
  0x85: 'OP_OR',
  0x86: 'OP_XOR',
  0x87: 'OP_EQUAL',
  0x88: 'OP_EQUALVERIFY',
  0x89: 'OP_RESERVED1',
  0x8a: 'OP_RESERVED2',

  // Numeric
  0x8b: 'OP_1ADD',
  0x8c: 'OP_1SUB',
  0x8d: 'OP_2MUL',
  0x8e: 'OP_2DIV',
  0x8f: 'OP_NEGATE',
  0x90: 'OP_ABS',
  0x91: 'OP_NOT',
  0x92: 'OP_0NOTEQUAL',
  0x93: 'OP_ADD',
  0x94: 'OP_SUB',
  0x95: 'OP_MUL',
  0x96: 'OP_DIV',
  0x97: 'OP_MOD',
  0x98: 'OP_LSHIFT',
  0x99: 'OP_RSHIFT',
  0x9a: 'OP_BOOLAND',
  0x9b: 'OP_BOOLOR',
  0x9c: 'OP_NUMEQUAL',
  0x9d: 'OP_NUMEQUALVERIFY',
  0x9e: 'OP_NUMNOTEQUAL',
  0x9f: 'OP_LESSTHAN',
  0xa0: 'OP_GREATERTHAN',
  0xa1: 'OP_LESSTHANOREQUAL',
  0xa2: 'OP_GREATERTHANOREQUAL',
  0xa3: 'OP_MIN',
  0xa4: 'OP_MAX',
  0xa5: 'OP_WITHIN',

  // Crypto
  0xa6: 'OP_RIPEMD160',
  0xa7: 'OP_SHA1',
  0xa8: 'OP_SHA256',
  0xa9: 'OP_HASH160',
  0xaa: 'OP_HASH256',
  0xab: 'OP_CODESEPARATOR',
  0xac: 'OP_CHECKSIG',
  0xad: 'OP_CHECKSIGVERIFY',
  0xae: 'OP_CHECKMULTISIG',
  0xaf: 'OP_CHECKMULTISIGVERIFY',

  // Expansion
  0xb0: 'OP_NOP1',
  0xb1: 'OP_CHECKLOCKTIMEVERIFY',
  0xb2: 'OP_CHECKSEQUENCEVERIFY',
  0xb3: 'OP_NOP4',
  0xb4: 'OP_NOP5',
  0xb5: 'OP_NOP6',
  0xb6: 'OP_NOP7',
  0xb7: 'OP_NOP8',
  0xb8: 'OP_NOP9',
  0xb9: 'OP_NOP10',

  // More Crypto
  0xc0: 'OP_BLAKE160',
  0xc1: 'OP_BLAKE256',
  0xc2: 'OP_SHA3',
  0xc3: 'OP_KECCAK',

  // More Ops
  0xd0: 'OP_TYPE',

  // Custom
  0xff: 'OP_INVALIDOPCODE'
};

/**
 * Small ints (1 indexed, 1==0).
 * @const {Buffer[]}
 */

exports.small = [
  Buffer.from([0x81]),
  Buffer.from([]),
  Buffer.from([0x01]),
  Buffer.from([0x02]),
  Buffer.from([0x03]),
  Buffer.from([0x04]),
  Buffer.from([0x05]),
  Buffer.from([0x06]),
  Buffer.from([0x07]),
  Buffer.from([0x08]),
  Buffer.from([0x09]),
  Buffer.from([0x0a]),
  Buffer.from([0x0b]),
  Buffer.from([0x0c]),
  Buffer.from([0x0d]),
  Buffer.from([0x0e]),
  Buffer.from([0x0f]),
  Buffer.from([0x10])
];

/**
 * Script and locktime flags. See {@link VerifyFlags}.
 * @enum {Number}
 */

exports.flags = {
  VERIFY_NONE: 0,
  VERIFY_MINIMALDATA: 1 << 1,
  VERIFY_DISCOURAGE_UPGRADABLE_NOPS: 1 << 2,
  VERIFY_DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM: 1 << 3,
  VERIFY_MINIMALIF: 1 << 4,
  VERIFY_NULLFAIL: 1 << 5
};

/**
 * Consensus verify flags (used for block validation).
 * @const {VerifyFlags}
 * @default
 */

exports.flags.MANDATORY_VERIFY_FLAGS = 0
  | exports.flags.VERIFY_MINIMALDATA
  | exports.flags.VERIFY_MINIMALIF
  | exports.flags.VERIFY_NULLFAIL;

/**
 * Standard verify flags (used for mempool validation).
 * @const {VerifyFlags}
 * @default
 */

exports.flags.STANDARD_VERIFY_FLAGS = 0
  | exports.flags.MANDATORY_VERIFY_FLAGS
  | exports.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS
  | exports.flags.VERIFY_DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM;

/**
 * Standard flags without mandatory bits.
 * @const {VerifyFlags}
 * @default
 */

exports.flags.ONLY_STANDARD_VERIFY_FLAGS =
  exports.flags.STANDARD_VERIFY_FLAGS & ~exports.flags.MANDATORY_VERIFY_FLAGS;

/**
 * Sighash Types.
 * @enum {SighashType}
 * @default
 */

exports.hashType = {
  /*
   * Sign all outputs.
   */

  ALL: 1,

  /*
   * Do not sign outputs (zero sequences).
   */

  NONE: 2,

  /*
   * Sign output at the same index (zero sequences).
   */

  SINGLE: 3,

  /*
   * Sign output at the reversed index (zero sequences).
   * Input at index 0 would sign the output at the last
   * index, input at index 1 would sign the second to
   * last index and so on.
   */

  SINGLEREVERSE: 4,

  /*
   * Sign no inputs.
   */

  NOINPUT: 0x40,

  /*
   * Sign only the current input (mask).
   */

  ANYONECANPAY: 0x80
};

/**
 * Sighash types by value.
 * @const {Object}
 */

exports.hashTypeByVal = {
  1: 'ALL',
  2: 'NONE',
  3: 'SINGLE',
  4: 'SINGLEREVERSE',
  0x40: 'NOINPUT',
  0x80: 'ANYONECANPAY'
};

/**
 * Output script types.
 * @enum {Number}
 */

exports.types = {
  NONSTANDARD: 0,
  PUBKEY: 1,
  PUBKEYHASH: 2,
  MULTISIG: 3
};

/**
 * Output script types by value.
 * @const {Object}
 */

exports.typesByVal = {
  0: 'NONSTANDARD',
  1: 'PUBKEY',
  2: 'PUBKEYHASH',
  3: 'MULTISIG'
};

/**
 * Test whether the data element is a compressed key.
 * @param {Buffer} key
 * @returns {Boolean}
 */

exports.isKeyEncoding = function isKeyEncoding(key) {
  assert(Buffer.isBuffer(key));

  if (key.length !== 33)
    return false;

  if (key[0] !== 0x02 && key[0] !== 0x03)
    return false;

  return true;
};

/**
 * Test a signature to see if it abides by BIP66.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0066.mediawiki
 * @param {Buffer} sig
 * @returns {Boolean}
 */

exports.isSignatureEncoding = function isSignatureEncoding(sig) {
  assert(Buffer.isBuffer(sig));

  if (sig.length !== 65)
    return false;

  let type = sig[64];

  type &= ~exports.hashType.NOINPUT;
  type &= ~exports.hashType.ANYONECANPAY;

  if (type < exports.hashType.ALL || type > exports.hashType.SINGLEREVERSE)
    return false;

  if (!secp256k1.isLowS(sig.slice(0, -1)))
    return false;

  return true;
};

/**
 * Format stack item into bitcoind asm format.
 * @param {Buffer} item
 * @param {Boolean?} decode - Attempt to decode hash types.
 * @returns {String} Human-readable string.
 */

exports.toASM = function toASM(item, decode) {
  if (item.length <= 4) {
    const num = ScriptNum.decode(item);
    return num.toString(10);
  }

  if (decode && exports.isSignatureEncoding(item)) {
    const type = item[item.length - 1];

    let symbol = exports.hashTypeByVal[type & 0x1f] || '';

    if (symbol) {
      if (type & exports.hashType.NOINPUT)
        symbol += '|NOINPUT';

      if (type & exports.hashType.ANYONECANPAY)
        symbol += '|ANYONECANPAY';

      symbol = `[${symbol}]`;
    }

    return item.slice(0, -1).toString('hex') + symbol;
  }

  return item.toString('hex');
};
