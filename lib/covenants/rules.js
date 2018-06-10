/*!
 * rules.js - covenant rules for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const sha3 = require('bcrypto/lib/sha3');
const reserved = require('./reserved');
const rules = exports;

/*
 * Constants
 */

const NAME_BUFFER = Buffer.allocUnsafe(64);

const CHARSET = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
  0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0
]);

/**
 * Covenant Types.
 * @enum {Number}
 * @default
 */

rules.types = {
  NONE: 0,
  CLAIM: 1,
  BID: 2,
  REVEAL: 3,
  REDEEM: 4,
  REGISTER: 5,
  UPDATE: 6,
  TRANSFER: 7,
  FINALIZE: 8,
  REVOKE: 9
};

const types = rules.types;

/**
 * Covenant types by value.
 * @const {Object}
 */

rules.typesByVal = {
  [types.NONE]: 'NONE',
  [types.CLAIM]: 'CLAIM',
  [types.BID]: 'BID',
  [types.REVEAL]: 'REVEAL',
  [types.REDEEM]: 'REDEEM',
  [types.REGISTER]: 'REGISTER',
  [types.UPDATE]: 'UPDATE',
  [types.TRANSFER]: 'TRANSFER',
  [types.FINALIZE]: 'FINALIZE',
  [types.REVOKE]: 'REVOKE'
};

/**
 * Blacklisted names.
 * @const {Set}
 */

rules.blacklist = new Set([
  'bit', // Namecoin
  'eth', // ENS
  'example', // ICANN reserved
  'invalid', // ICANN reserved
  'local', // mDNS
  'localhost', // ICANN reserved
  'onion', // Tor
  'test' // ICANN reserved
]);

/**
 * Maximum name size for a TLD.
 * @const {Number}
 * @default
 */

rules.MAX_NAME_SIZE = 63;

/**
 * Maximum resource size.
 * @const {Number}
 * @default
 */

rules.MAX_RESOURCE_SIZE = 512;

/**
 * Maximum covenant size.
 * @const {Number}
 * @default
 */

rules.MAX_COVENANT_SIZE = 0
  + 1 + 32
  + 2 + rules.MAX_RESOURCE_SIZE
  + 1 + 32;

/**
 * Maximum bid size.
 * @const {Number}
 * @default
 */

rules.MAX_BID_SIZE = 1 + 32 + 1 + rules.MAX_NAME_SIZE + 1 + 32;

/**
 * Maximum covenant type.
 * @const {Number}
 * @default
 */

rules.MAX_COVENANT_TYPE = types.REVOKE;

/**
 * Hash a domain name.
 * @param {String|Buffer} name
 * @returns {Buffer}
 */

rules.hashName = function hashName(name) {
  if (Buffer.isBuffer(name))
    return rules.hashBinary(name);
  return rules.hashString(name);
};

/**
 * Hash a domain name.
 * @param {String} name
 * @returns {Buffer}
 */

rules.hashString = function hashString(name) {
  assert(typeof name === 'string');
  assert(name.length >= 1 && name.length <= 64);

  const slab = NAME_BUFFER;
  const written = slab.write(name, 0, 64, 'ascii');

  assert(name.length === written);

  const buf = slab.slice(0, written);

  return rules.hashBinary(buf);
};

/**
 * Hash a domain name.
 * @param {Buffer} name
 * @returns {Buffer}
 */

rules.hashBinary = function hashBinary(name) {
  assert(Buffer.isBuffer(name));
  assert(name.length >= 1 && name.length <= 64);
  return sha3.digest(name);
};

/**
 * Verify a domain name meets HSK requirements.
 * @param {String|Buffer} name
 * @returns {Boolean}
 */

rules.verifyName = function verifyName(name) {
  if (Buffer.isBuffer(name))
    return rules.verifyBinary(name);
  return rules.verifyString(name);
};

/**
 * Verify a domain name meets HSK requirements.
 * @param {String} name
 * @returns {Boolean}
 */

rules.verifyString = function verifyString(str) {
  assert(typeof str === 'string');

  if (str.length === 0)
    return false;

  if (str.length > rules.MAX_NAME_SIZE)
    return false;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);

    // No unicode characters.
    if (ch & 0xff80)
      return false;

    const type = CHARSET[ch];

    switch (type) {
      case 0: // non-printable
        return false;
      case 1: // 0-9
      case 2: // a-z
        break;
      case 3: // - and _
        // Do not allow at end or beginning.
        if (i === 0 || i === str.length - 1)
          return false;
        break;
    }
  }

  if (rules.blacklist.has(str))
    return false;

  return true;
};

/**
 * Verify a domain name meets HSK requirements.
 * @param {Buffer} name
 * @returns {Boolean}
 */

rules.verifyBinary = function verifyBinary(buf) {
  assert(Buffer.isBuffer(buf));

  if (buf.length === 0)
    return false;

  if (buf.length > rules.MAX_NAME_SIZE)
    return false;

  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];

    // No unicode characters.
    if (ch & 0x80)
      return false;

    const type = CHARSET[ch];

    switch (type) {
      case 0: // non-printable
        return false;
      case 1: // 0-9
      case 2: // a-z
        break;
      case 3: // - and _
        // Do not allow at end or beginning.
        if (i === 0 || i === buf.length - 1)
          return false;
        break;
    }
  }

  const str = buf.toString('ascii');

  if (rules.blacklist.has(str))
    return false;

  return true;
};

/**
 * Get height and week of name rollout.
 * @param {String|Buffer} name
 * @param {Network} network
 * @returns {Array} [height, week]
 */

rules.getRollout = function getRollout(name, network) {
  const nameHash = rules.hashName(name);
  return rules.getHashRollout(nameHash, network);
};

/**
 * Get height and week of name hash rollout.
 * @param {Buffer} nameHash
 * @param {Network} network
 * @returns {Array} [height, week]
 */

rules.getHashRollout = function getHashRollout(nameHash, network) {
  assert(Buffer.isBuffer(nameHash) && nameHash.length === 32);

  const week = nameHash[0] % 52;
  const height = week * network.names.rolloutInterval;

  return [network.names.auctionStart + height, week];
};

/**
 * Verify a name meets the rollout.
 * @param {String|Buffer} name
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.verifyRollout = function verifyRollout(name, height, network) {
  assert((height >>> 0) === height);
  assert(network);

  if (network.names.noRollout)
    return true;

  const [start] = rules.getRollout(name, network);

  if (height < start)
    return false;

  return true;
};

/**
 * Verify a name hash meets the rollout.
 * @param {Buffer} hash
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.verifyHashRollout = function verifyHashRollout(hash, height, network) {
  assert((height >>> 0) === height);
  assert(network);

  if (network.names.noRollout)
    return true;

  const [start] = rules.getHashRollout(hash, network);

  if (height < start)
    return false;

  return true;
};

/**
 * Test whether a name is reserved.
 * @param {String|Buffer} name
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.isReserved = function isReserved(name, height, network) {
  if (Buffer.isBuffer(name))
    name = name.toString('ascii');

  assert(typeof name === 'string');
  assert((height >>> 0) === height);
  assert(network);

  if (network.names.noReserved)
    return false;

  if (height >= network.names.claimPeriod)
    return false;

  return reserved.has(name);
};

/**
 * Perform several tests to check
 * whether a name is available.
 * @param {String|Buffer} name
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.isAvailable = function isAvailable(name, height, network) {
  if (!rules.verifyName(name))
    return false;

  if (rules.isReserved(name, height, network))
    return false;

  if (!rules.verifyRollout(name, height, network))
    return false;

  return true;
};

/**
 * Create a blind bid hash from a value and nonce.
 * @param {Amount} value
 * @param {Buffer} nonce
 * @returns {Buffer}
 */

rules.blind = function blind(value, nonce) {
  const bw = bio.write(40);
  bw.writeU64(value);
  bw.writeBytes(nonce);
  return blake2b.digest(bw.render());
};

/**
 * Count name updates.
 * @param {TX} tx
 * @returns {Number}
 */

rules.countUpdates = function countUpdates(tx) {
  let total = 0;

  for (const output of tx.outputs) {
    const {covenant} = output;

    switch (covenant.type) {
      case types.REGISTER:
      case types.UPDATE:
        if (covenant.items[1].length > 0)
          total += 1;
        break;
      case types.REVOKE:
        total += 1;
        break;
    }
  }

  return total;
};

/**
 * Check covenant sanity (called from `tx.checkSanity()`).
 * @param {TX} tx
 * @returns {Boolean}
 */

rules.hasSaneCovenants = function hasSaneCovenants(tx) {
  // Coinbases cannot use covenants.
  if (tx.isCoinbase()) {
    for (const {covenant} of tx.outputs) {
      if (covenant.type !== types.NONE)
        return false;

      if (covenant.items.length !== 0)
        return false;
    }

    return true;
  }

  for (let i = 0; i < tx.outputs.length; i++) {
    const output = tx.outputs[i];
    const {covenant} = output;

    switch (covenant.type) {
      case types.NONE: {
        // Just a regular payment.
        // Can come from a NONE or a REDEEM.
        if (covenant.items.length !== 0)
          return false;

        break;
      }
      case types.CLAIM: {
        // Has to come from NONE or REDEEM.

        // Should contain a name hash and name.
        if (covenant.items.length !== 2)
          return false;

        // Name hash is 32 bytes.
        if (covenant.items[0].length !== 32)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[1]))
          return false;

        // Must be a reserved name.
        const name = covenant.items[1].toString('ascii');

        if (!reserved.has(name))
          return false;

        const key = rules.hashName(covenant.items[1]);

        if (!key.equals(covenant.items[0]))
          return false;

        break;
      }
      case types.BID: {
        // Has to come from NONE or REDEEM.

        // Should contain a name hash, name, and hash.
        if (covenant.items.length !== 3)
          return false;

        // Name hash is 32 bytes.
        if (covenant.items[0].length !== 32)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[1]))
          return false;

        // Hash must be 32 bytes.
        if (covenant.items[2].length !== 32)
          return false;

        const key = rules.hashName(covenant.items[1]);

        if (!key.equals(covenant.items[0]))
          return false;

        break;
      }
      case types.REVEAL: {
        // Has to come from a BID.
        if (i >= tx.inputs.length)
          return false;

        // Should contain a nonce.
        if (covenant.items.length !== 2)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        // Nonce must be 32 bytes.
        if (covenant.items[1].length !== 32)
          return false;

        break;
      }
      case types.REDEEM: {
        // Has to come from a REVEAL.
        if (i >= tx.inputs.length)
          return false;

        // Should contain name data.
        if (covenant.items.length !== 1)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        break;
      }
      case types.REGISTER: {
        // Has to come from a REVEAL.
        if (i >= tx.inputs.length)
          return false;

        // Should contain record data and a block hash.
        if (covenant.items.length !== 3)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        // Record data is limited to 512 bytes.
        if (covenant.items[1].length > rules.MAX_RESOURCE_SIZE)
          return false;

        // Must be a block hash.
        if (covenant.items[2].length !== 32)
          return false;

        break;
      }
      case types.UPDATE: {
        // Has to come from a REGISTER, UPDATE, or FINALIZE.
        if (i >= tx.inputs.length)
          return false;

        // Should contain record data and possibly a block hash.
        if (covenant.items.length < 2 || covenant.items.length > 3)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        // Record data is limited to 512 bytes.
        if (covenant.items[1].length > rules.MAX_RESOURCE_SIZE)
          return false;

        if (covenant.items.length === 3) {
          // Must be a block hash.
          if (covenant.items[2].length !== 32)
            return false;
        }

        break;
      }
      case types.TRANSFER: {
        // Has to come from a REGISTER, UPDATE, or FINALIZE.
        if (i >= tx.inputs.length)
          return false;

        // Should contain the address we
        // _intend_ to transfer to.
        if (covenant.items.length < 2 || covenant.items.length > 3)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        // Must obey address size limits.
        if (covenant.items[1].length < 4 || covenant.items[1].length > 42)
          return false;

        if (covenant.items.length === 3) {
          // Must be a block hash.
          if (covenant.items[2].length !== 32)
            return false;
        }

        break;
      }
      case types.FINALIZE: {
        // Has to come from a TRANSFER.
        if (i >= tx.inputs.length)
          return false;

        // Should contain name hash.
        if (covenant.items.length < 1 || covenant.items.length > 2)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        if (covenant.items.length === 2) {
          // Must be a block hash.
          if (covenant.items[1].length !== 32)
            return false;
        }

        break;
      }
      case types.REVOKE: {
        // Has to come from a REGISTER, UPDATE, or FINALIZE.
        if (i >= tx.inputs.length)
          return false;

        // Should contain name data.
        if (covenant.items.length !== 1)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        break;
      }
      default: {
        // Unknown covenant.
        // Don't enforce anything.
        if (covenant.getSize() > rules.MAX_COVENANT_SIZE)
          return false;
        break;
      }
    }
  }

  return true;
};

/**
 * Perform contextual verification for covenants.
 * Called from `tx.checkInputs()`.
 * @param {TX} tx
 * @param {CoinView} view
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.verifyCovenants = function verifyCovenants(tx, view, height, network) {
  if (tx.isCoinbase())
    return true;

  let checkClaimant = false;

  for (let i = 0; i < tx.inputs.length; i++) {
    const {prevout} = tx.inputs[i];
    const entry = view.getEntry(prevout);
    assert(entry);

    const coin = entry.output;
    const uc = coin.covenant;

    let output = null;
    let covenant = null;

    if (i < tx.outputs.length) {
      output = tx.outputs[i];
      covenant = output.covenant;
    }

    switch (uc.type) {
      case types.NONE:
      case types.REDEEM: {
        // Can go nowhere.
        if (!output)
          break;

        // Can only go to a NONE, CLAIM, or BID.
        switch (covenant.type) {
          case types.NONE:
            break;
          case types.CLAIM:
            // Must be sending to claimant address.
            if (output.address.version !== 0)
              return false;

            if (!output.address.hash.equals(network.keys.claimant))
              return false;

            // Must be redeeming a claimant UTXO.
            checkClaimant = true;

            break;
          case types.BID:
            break;
          default:
            return false;
        }

        break;
      }
      case types.BID: {
        // Must be be linked.
        if (!output)
          return false;

        // Bid has to go to a reveal.
        if (covenant.type !== types.REVEAL)
          return false;

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        const nonce = covenant.items[1];
        const blind = rules.blind(output.value, nonce);

        // The value and nonce must match the
        // hash they presented in their bid.
        if (!blind.equals(uc.items[2]))
          return false;

        // If they lied to us, they can
        // never redeem their money.
        if (coin.value < output.value)
          return false;

        break;
      }
      case types.CLAIM:
      case types.REVEAL: {
        // Must be be linked.
        if (!output)
          return false;

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        // Reveal has to go to a REGISTER, or
        // a REDEEM (in the case of the loser).
        switch (covenant.type) {
          case types.REGISTER: {
            // Addresses must match (reveal only).
            if (uc.type === types.REVEAL) {
              if (!output.address.equals(coin.address))
                return false;
            }

            // Note: We use a vickrey auction.
            // Output value must match the second
            // highest bid. This will be checked
            // elsewhere.

            break;
          }
          case types.REDEEM: {
            if (uc.type === types.CLAIM)
              return false;
            break;
          }
          default: {
            return false;
          }
        }

        break;
      }
      case types.REGISTER:
      case types.UPDATE:
      case types.FINALIZE: {
        // Must be be linked.
        if (!output)
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        // Addresses must match.
        if (!output.address.equals(coin.address))
          return false;

        // Can only send to an
        // UPDATE or TRANSFER.
        switch (covenant.type) {
          case types.UPDATE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            break;
          }
          case types.TRANSFER: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            break;
          }
          case types.REVOKE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            break;
          }
          default: {
            return false;
          }
        }

        break;
      }
      case types.TRANSFER: {
        // Must be be linked.
        if (!output)
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        // Can only send to an UPDATE, FINALIZE, or REVOKE.
        switch (covenant.type) {
          case types.UPDATE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Addresses must match.
            if (!output.address.equals(coin.address))
              return false;

            break;
          }
          case types.FINALIZE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Address must match the one committed
            // to in the original transfer covenant.
            if (!output.address.toRaw().equals(uc.items[1]))
              return false;

            break;
          }
          case types.REVOKE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Must match the original owner's address.
            if (!output.address.equals(coin.address))
              return false;

            break;
          }
          default: {
            return false;
          }
        }

        break;
      }
      case types.REVOKE: {
        // Revocations are perma-burned.
        return false;
      }
      default: {
        // Unknown covenant.
        // Don't enforce anything.
        if (covenant.type >= types.CLAIM
            && covenant.type <= types.REVOKE) {
          return false;
        }
        break;
      }
    }
  }

  if (checkClaimant) {
    if (!rules.hasClaimant(tx, view, network))
      return false;
  }

  return true;
};

/**
 * Test whether a transaction is redeeming
 * one of the claimant's UTXOs.
 * @param {TX} tx
 * @param {CoinView} view
 * @param {Network} network
 * @returns {Boolean}
 */

rules.hasClaimant = function hasClaimant(tx, view, network) {
  for (const {prevout} of tx.inputs) {
    const coin = view.getOutput(prevout);

    if (!coin)
      continue;

    if (coin.address.version !== 0)
      continue;

    if (!coin.address.hash.equals(network.keys.claimant))
      continue;

    return true;
  }

  return false;
};

/**
 * Test whether a covenant should be considered "linked".
 * @param {Covenant} covenant
 * @returns {Boolean}
 */

rules.isLinked = function isLinked(covenant) {
  const {type} = covenant;
  return type >= types.REVEAL && type <= types.REVOKE;
};

/**
 * Test whether a coin should be considered
 * unspendable in the coin selector.
 * @param {Coin} coin
 * @param {Number} height
 * @returns {Boolean}
 */

rules.isUnspendable = function isUnspendable(coin, height) {
  switch (coin.covenant.type) {
    case types.NONE:
    case types.REDEEM:
      return false;
    default:
      return true;
  }
};

/**
 * Test whether a covenant type should be
 * considered subject to the dust policy rule.
 * @param {Number} type
 * @returns {Boolean}
 */

rules.isDustworthy = function isDustworthy(type) {
  switch (type) {
    case types.NONE:
    case types.BID:
      return true;
    default:
      return type > types.REVOKE;
  }
};
