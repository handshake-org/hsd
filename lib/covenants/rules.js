/*!
 * rules.js - covenant rules for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const sha3 = require('bcrypto/lib/sha3');
const consensus = require('../protocol/consensus');
const reserved = require('./reserved');
const {OwnershipProof} = require('./ownership');
const rules = exports;

/*
 * Constants
 */

const NAME_BUFFER = Buffer.allocUnsafe(63);

const CHARSET = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 4,
  0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0
]);

/**
 * Covenant Types.
 * @enum {Number}
 * @default
 */

rules.types = {
  NONE: 0,
  CLAIM: 1,
  OPEN: 2,
  BID: 3,
  REVEAL: 4,
  REDEEM: 5,
  REGISTER: 6,
  UPDATE: 7,
  TRANSFER: 8,
  FINALIZE: 9,
  REVOKE: 10
};

const types = rules.types;

/**
 * Covenant types by value.
 * @const {Object}
 */

rules.typesByVal = {
  [types.NONE]: 'NONE',
  [types.CLAIM]: 'CLAIM',
  [types.OPEN]: 'OPEN',
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

rules.MAX_BID_SIZE = 1 + 32 + 1 + rules.MAX_NAME_SIZE + 1 + 4 + 1 + 32;

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
  assert(rules.verifyString(name));

  const slab = NAME_BUFFER;
  const written = slab.write(name, 0, slab.length, 'ascii');

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
  assert(rules.verifyBinary(name));
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
        break;
      case 2: // A-Z
        return false;
      case 3: // a-z
        break;
      case 4: // - and _
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
        break;
      case 2: // A-Z
        return false;
      case 3: // a-z
        break;
      case 4: // - and _
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
 * Get height and week of name hash rollout.
 * @param {Buffer} nameHash
 * @param {Network} network
 * @returns {Array} [height, week]
 */

rules.getRollout = function getRollout(nameHash, network) {
  assert(Buffer.isBuffer(nameHash) && nameHash.length === 32);
  assert(network && network.names);

  if (network.names.noRollout)
    return [0, 0];

  // Modulo the hash by 52 to get week number.
  const week = modBuffer(nameHash, 52);

  // Multiply result by a number of blocks-per-week.
  const height = week * network.names.rolloutInterval;

  // Add the auction start height to the rollout height.
  return [network.names.auctionStart + height, week];
};

/**
 * Verify a name hash meets the rollout.
 * @param {Buffer} hash
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.verifyRollout = function verifyRollout(hash, height, network) {
  assert((height >>> 0) === height);
  assert(network);

  const [start] = rules.getRollout(hash, network);

  if (height < start)
    return false;

  return true;
};

/**
 * Grind a name for rollout.
 * Used for testing.
 * @param {Number} target
 * @param {Network} network
 * @returns {String}
 */

rules.grindName = function grindName(target, network) {
  assert((target >>> 0) === target);
  assert(network && network.names);

  if (network.names.noRollout)
    return randomString(10);

  if (target < network.names.auctionStart)
    target = network.names.auctionStart;

  for (;;) {
    const name = randomString(10);
    const hash = rules.hashName(name);
    const [height] = rules.getRollout(hash, network);

    if (height <= target)
      return name;
  }
};

/**
 * Test whether a name is reserved.
 * @param {Buffer} nameHash
 * @param {Number} height
 * @param {Network} network
 * @returns {Boolean}
 */

rules.isReserved = function isReserved(nameHash, height, network) {
  assert(Buffer.isBuffer(nameHash));
  assert((height >>> 0) === height);
  assert(network && network.names);

  if (network.names.noReserved)
    return false;

  if (height >= network.names.claimPeriod)
    return false;

  return reserved.has(nameHash);
};

/**
 * Create a blind bid hash from a value and nonce.
 * @param {Amount} value
 * @param {Buffer} nonce
 * @returns {Buffer}
 */

rules.blind = function blind(value, nonce) {
  assert(Number.isSafeInteger(value) && value >= 0);
  assert(Buffer.isBuffer(nonce));

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
  assert(tx);

  let total = 0;

  for (const output of tx.outputs) {
    const {covenant} = output;

    switch (covenant.type) {
      case types.CLAIM:
      case types.OPEN:
        total += 1;
        break;
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
  assert(tx);

  // Coinbases are only capable of creating claims.
  if (tx.isCoinbase()) {
    if (tx.inputs.length > tx.outputs.length)
      return false;

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const {covenant} = output;

      switch (covenant.type) {
        case types.NONE: {
          // Must not be linked.
          if (i > 0 && i < tx.inputs.length)
            return false;

          // Just a regular payment.
          if (covenant.items.length !== 0)
            return false;

          break;
        }

        case types.CLAIM: {
          // Must not be the first input/output.
          if (i === 0)
            return false;

          // Must be linked.
          if (i > tx.inputs.length)
            return false;

          const input = tx.inputs[i];
          const {witness} = input;

          // Must have exactly 1 witness item.
          if (witness.items.length !== 1)
            return false;

          // Should contain a name hash, name, and flags.
          if (covenant.items.length !== 3)
            return false;

          // Name hash is 32 bytes.
          if (covenant.items[0].length !== 32)
            return false;

          // Name must be valid.
          if (!rules.verifyName(covenant.items[1]))
            return false;

          // Flags must be 1 byte.
          if (covenant.items[2].length !== 1)
            return false;

          // Must be a reserved name.
          const nameHash = covenant.items[0];

          if (!reserved.has(nameHash))
            return false;

          // Must match the hash.
          const name = covenant.items[1];
          const key = rules.hashName(name);

          if (!key.equals(nameHash))
            return false;

          let proof;

          try {
            proof = OwnershipProof.decode(witness.items[0]);
          } catch (e) {
            return false;
          }

          if (!proof.isSane())
            return false;

          if (proof.getName() !== name.toString('ascii'))
            return false;

          const flags = covenant.items[2][0];
          const weak = (flags & 1) === 1;

          if (proof.isWeak() !== weak)
            return false;

          break;
        }

        default: {
          return false;
        }
      }
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
        // Cannot exist in a non-coinbase.
        return false;
      }
      case types.OPEN: {
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

        const key = rules.hashName(covenant.items[1]);

        if (!key.equals(covenant.items[0]))
          return false;

        break;
      }
      case types.BID: {
        // Has to come from NONE or REDEEM.

        // Should contain a name hash, name, height, and hash.
        if (covenant.items.length !== 4)
          return false;

        // Name hash is 32 bytes.
        if (covenant.items[0].length !== 32)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[1]))
          return false;

        // Height must be 4 bytes.
        if (covenant.items[2].length !== 4)
          return false;

        // Hash must be 32 bytes.
        if (covenant.items[3].length !== 32)
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

        // Must have an address.
        const addr = covenant.items[1];

        // Must obey address size limits.
        if (addr.length < 4 || addr.length > 42)
          return false;

        // Todo: Add policy rule for high versions.
        if (addr[0] > 31)
          return false;

        if (2 + addr[1] !== addr.length)
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

        // Should contain name hash and state.
        if (covenant.items.length !== 5)
          return false;

        // Name hash must be valid.
        if (covenant.items[0].length !== 32)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[1]))
          return false;

        // Must be height.
        if (covenant.items[2].length !== 4)
          return false;

        // Must be flags byte.
        if (covenant.items[3].length !== 1)
          return false;

        // Must be a block hash.
        if (covenant.items[4].length !== 32)
          return false;

        const key = rules.hashName(covenant.items[1]);

        if (!key.equals(covenant.items[0]))
          return false;

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
 * @returns {Number}
 */

rules.verifyCovenants = function verifyCovenants(tx, view, height, network) {
  assert(tx && view);
  assert(network && network.names);

  if (tx.isCoinbase()) {
    let conjured = 0;

    for (let i = 1; i < tx.inputs.length; i++) {
      const {witness} = tx.inputs[i];
      const output = tx.outputs[i];
      const {covenant} = output;

      assert(covenant.type === types.CLAIM);

      if (witness.items.length !== 1)
        return -1;

      let proof;
      try {
        proof = OwnershipProof.decode(witness.items[0]);
      } catch (e) {
        return -1;
      }

      const data = proof.getData(network);

      if (!data)
        return -1;

      if (output.address.version !== data.version)
        return -1;

      if (!output.address.hash.equals(data.hash))
        return -1;

      const flags = covenant.items[2][0];
      const forked = (flags & 2) === 2;

      if (forked !== data.forked)
        return false;

      if (forked) {
        if (data.fee !== 0)
          return false;

        if (output.value !== 0)
          return false;
      } else {
        if (output.value !== data.value - data.fee)
          return false;

        conjured += data.value;
      }

      if (conjured > consensus.MAX_MONEY)
        return -1;
    }

    return conjured;
  }

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
      case types.OPEN:
      case types.REDEEM: {
        // Can go nowhere.
        if (!output)
          break;

        // Can only go to a NONE, OPEN, or BID.
        switch (covenant.type) {
          case types.NONE:
            break;
          case types.OPEN:
            break;
          case types.BID:
            break;
          default:
            return -1;
        }

        break;
      }
      case types.BID: {
        // Must be be linked.
        if (!output)
          return -1;

        // Bid has to go to a reveal.
        if (covenant.type !== types.REVEAL)
          return -1;

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return -1;

        const nonce = covenant.items[1];
        const blind = rules.blind(output.value, nonce);

        // The value and nonce must match the
        // hash they presented in their bid.
        if (!blind.equals(uc.items[3]))
          return -1;

        // If they lied to us, they can
        // never redeem their money.
        if (coin.value < output.value)
          return -1;

        break;
      }
      case types.CLAIM:
      case types.REVEAL: {
        // Must be be linked.
        if (!output)
          return -1;

        // Reveal has to go to a REGISTER, or
        // a REDEEM (in the case of the loser).
        switch (covenant.type) {
          case types.REGISTER: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            // Addresses must match.
            if (!output.address.equals(coin.address))
              return -1;

            // Note: We use a vickrey auction.
            // Output value must match the second
            // highest bid. This will be checked
            // elsewhere.

            break;
          }
          case types.REDEEM: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            if (uc.type === types.CLAIM)
              return -1;

            break;
          }
          default: {
            return -1;
          }
        }

        break;
      }
      case types.REGISTER:
      case types.UPDATE:
      case types.FINALIZE: {
        // Must be be linked.
        if (!output)
          return -1;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return -1;

        // Addresses must match.
        if (!output.address.equals(coin.address))
          return -1;

        // Can only send to an
        // UPDATE or TRANSFER.
        switch (covenant.type) {
          case types.UPDATE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            break;
          }
          case types.TRANSFER: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            break;
          }
          case types.REVOKE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            break;
          }
          default: {
            return -1;
          }
        }

        break;
      }
      case types.TRANSFER: {
        // Must be be linked.
        if (!output)
          return -1;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return -1;

        // Can only send to an UPDATE, FINALIZE, or REVOKE.
        switch (covenant.type) {
          case types.UPDATE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            // Addresses must match.
            if (!output.address.equals(coin.address))
              return -1;

            break;
          }
          case types.FINALIZE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            // Address must match the one committed
            // to in the original transfer covenant.
            if (!output.address.encode().equals(uc.items[1]))
              return -1;

            break;
          }
          case types.REVOKE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return -1;

            // Must match the original owner's address.
            if (!output.address.equals(coin.address))
              return -1;

            break;
          }
          default: {
            return -1;
          }
        }

        break;
      }
      case types.REVOKE: {
        // Revocations are perma-burned.
        return -1;
      }
      default: {
        // Unknown covenant.
        // Don't enforce anything.
        if (covenant.type >= types.CLAIM
            && covenant.type <= types.REVOKE) {
          return -1;
        }
        break;
      }
    }
  }

  return 0;
};

/**
 * Test whether a covenant should be considered "linked".
 * @param {Covenant} covenant
 * @returns {Boolean}
 */

rules.isLinked = function isLinked(covenant) {
  assert(covenant && typeof covenant.type === 'number');

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

rules.isUnspendable = function isUnspendable(coin) {
  assert(coin && coin.covenant);

  switch (coin.covenant.type) {
    case types.NONE:
    case types.OPEN:
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
  assert((type >>> 0) === type);

  switch (type) {
    case types.NONE:
    case types.BID:
      return true;
    default:
      return type > types.REVOKE;
  }
};

/*
 * Helpers
 */

function randomString(len) {
  assert((len >>> 0) === len);

  let str = '';

  while (str.length < len) {
    const r = (Math.random() * 0x100000000) >>> 0;

    str += r.toString(32);
  }

  return str.slice(0, len);
}

function modBuffer(buf, num) {
  assert(Buffer.isBuffer(buf));
  assert((num & 0xff) === num);
  assert(num !== 0);

  const p = 256 % num;

  let acc = 0;

  for (let i = 0; i < buf.length; i++)
    acc = (p * acc + buf[i]) % num;

  return acc;
}
