'use strict';

const assert = require('bsert');
const blake2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');
const rules = require('../../lib/covenants/rules');
const Input = require('../../lib/primitives/input');
const Address = require('../../lib/primitives/address');
const Output = require('../../lib/primitives/output');
const Outpoint = require('../../lib/primitives/outpoint');
const Coin = require('../../lib/primitives/coin');
const Covenant = require('../../lib/primitives/covenant');

/** @typedef {import('../../lib/types').Hash} Hash */

exports.coinbaseInput = () => {
  return Input.fromOutpoint(new Outpoint());
};

exports.dummyInput = () => {
  const hash = random.randomBytes(32);
  return Input.fromOutpoint(new Outpoint(hash, 0));
};

exports.deterministicInput = (id) => {
  const hash = blake2b.digest(fromU32(id));
  return Input.fromOutpoint(new Outpoint(hash, 0));
};

/**
 * @typedef {Object} OutputOptions
 * @property {Number} value
 * @property {Address} [address]
 * @property {CovenantOptions} [covenant]
 */

/**
 * @param {OutputOptions} options
 * @returns {Output}
 */

exports.makeOutput = (options) => {
  const address = options.address || exports.randomP2PKAddress();
  const output = new Output();
  output.address = address;
  output.value = options.value;

  if (options.covenant)
    output.covenant = exports.makeCovenant(options.covenant);

  return output;
};

/**
 * @typedef {Object} CovenantOptions
 * @property {String} [name]
 * @property {Hash} [nameHash]
 * @property {Covenant.types} [type=Covenant.types.NONE]
 * @property {Number} [height]
 * @property {Array} [args] - leftover args for the covenant except
 *                            for nameHash, name and height.
 */

/**
 * @param {CovenantOptions} options
 * @returns {Covenant}
 */

exports.makeCovenant = (options) => {
  const covenant = new Covenant();
  covenant.type = options.type || Covenant.types.NONE;

  const args = options.args || [];
  const height = options.height || 0;
  let nameHash = options.nameHash;
  let name = options.name;

  if (name) {
    nameHash = rules.hashName(name);
  } else if (!nameHash) {
    name = randomString(30);
    nameHash = rules.hashName(name);
  }

  switch (covenant.type) {
    case Covenant.types.NONE:
      break;
    case Covenant.types.OPEN: {
      assert(args.length === 0, 'Pass `options.name` instead.');
      const rawName = Buffer.from(name, 'ascii');
      covenant.setOpen(nameHash, rawName);
      break;
    }
    case Covenant.types.BID: {
      assert(args.length < 1, 'Pass [blind?] instead.');
      const blind = args[0] || random.randomBytes(32);
      const rawName = Buffer.from(name, 'ascii');
      covenant.setBid(nameHash, height, rawName, blind);
      break;
    }
    case Covenant.types.REVEAL: {
      assert(args.length < 1, 'Pass [nonce?] instead.');
      const nonce = args[0] || random.randomBytes(32);
      covenant.setReveal(nameHash, height, nonce);
      break;
    }
    case Covenant.types.REDEEM: {
      assert(args.length === 0, 'No args for redeem.');
      covenant.setRedeem(nameHash, height);
      break;
    }
    case Covenant.types.REGISTER: {
      assert(args.length < 2, 'Pass [record?, blockHash?] instead.');
      const record = args[0] || Buffer.alloc(0);
      const blockHash = args[1] || random.randomBytes(32);
      covenant.setRegister(nameHash, height, record, blockHash);
      break;
    }
    case Covenant.types.UPDATE: {
      assert(args.length < 1, 'Pass [resource?] instead.');
      const resource = args[0] || Buffer.alloc(0);
      covenant.setUpdate(nameHash, height, resource);
      break;
    }
    case Covenant.types.RENEW: {
      assert(args.length < 1, 'Pass [blockHash?] instead.');
      const blockHash = args[0] || random.randomBytes(32);
      covenant.setRenew(nameHash, height, blockHash);
      break;
    }
    case Covenant.types.TRANSFER: {
      assert(args.length < 1, 'Pass [address?] instead.');
      const address = args[0] || exports.randomP2PKAddress();
      covenant.setTransfer(nameHash, height, address);
      break;
    }
    case Covenant.types.FINALIZE: {
      assert(args.length < 4, 'Pass [flags?, claimed?, renewal?, blockHash?] instead.');
      const rawName = Buffer.from(name, 'ascii');
      const flags = args[0] || 0;
      const claimed = args[1] || 0;
      const renewal = args[2] || 0;
      const blockHash = args[3] || random.randomBytes(32);

      covenant.setFinalize(
        nameHash,
        height,
        rawName,
        flags,
        claimed,
        renewal,
        blockHash
      );
      break;
    }
    case Covenant.types.REVOKE: {
      assert(args.length === 0, 'No args for revoke.');
      covenant.setRevoke(nameHash, height);
      break;
    }
    default:
      throw new Error(`Invalid covenant type ${covenant.type}.`);
  }

  return covenant;
};

exports.randomP2PKAddress = () => {
  const key = random.randomBytes(33);
  return Address.fromPubkey(key);
};

/**
 * @typedef {Object} CoinOptions
 * @param {String} [options.version=1]
 * @param {String} [options.height=-1]
 * @param {String} [options.value=0]
 * @param {String} [options.address]
 * @param {Object} [options.covenant]
 * @param {Boolean} [options.coinbase=false]
 * @param {Buffer} [options.hash]
 * @param {Number} [options.index=0]
 */

/**
 * @param {CoinOptions} options
 * @returns {Coin}
 */

exports.makeCoin = (options) => {
  return Coin.fromOptions({
    hash: options.hash || random.randomBytes(32),
    address: options.address || Address.fromPubkey(random.randomBytes(33)),
    ...options
  });
};

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}

function randomString(len) {
  assert((len >>> 0) === len);

  let s = '';

  for (let i = 0; i < len; i++) {
    const n = Math.random() * (0x7b - 0x61) + 0x61;
    const c = Math.floor(n);

    s += String.fromCharCode(c);
  }

  return s;
}
