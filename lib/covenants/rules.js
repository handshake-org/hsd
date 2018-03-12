'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const reserved = require('./reserved');
const consensus = require('../protocol/consensus');
const Address = require('../primitives/address');
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
  COLD: 7,
  TRANSFER: 8,
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
  [types.COLD]: 'COLD',
  [types.TRANSFER]: 'TRANSFER',
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

rules.MAX_NAME_SIZE = 64;

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
  + 1 + rules.MAX_NAME_SIZE
  + 2 + rules.MAX_RESOURCE_SIZE
  + 1 + 32;

/**
 * Maximum bid size.
 * @const {Number}
 * @default
 */

rules.MAX_BID_SIZE = 1 + rules.MAX_NAME_SIZE + 1 + 32;

/**
 * Maximum covenant type.
 * @const {Number}
 * @default
 */

rules.MAX_COVENANT_TYPE = types.REVOKE;

/**
 * Key required to claim reserved names.
 * @const {Address}
 * @default
 */

rules.CLAIMANT = Address.fromHash(consensus.FOUNDATION_HOT, 0);

/**
 * Key required to claim reserved names.
 * @const {Address}
 * @default
 */

rules.CLAIMANT_COLD = Address.fromHash(consensus.FOUNDATION_KEY, 0);

/**
 * Hash a domain name.
 * @param {String|Buffer} name
 * @returns {Buffer}
 */

rules.hashName = function hashName(name) {
  if (Buffer.isBuffer(name))
    return blake2b.digest(name);

  assert(typeof name === 'string');

  const buf = NAME_BUFFER;
  assert(name.length <= 64);

  const written = buf.write(name, 0, 64, 'ascii');
  assert(name.length === written);

  return blake2b.digest(buf.slice(0, written));
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
  if (typeof name === 'string')
    name = Buffer.from(name, 'ascii');

  assert(Buffer.isBuffer(name));
  assert(name.length <= rules.MAX_NAME_SIZE);

  const week = blake2b.digest(name)[0] % 52;
  const height = week * network.names.rolloutInterval;

  return [height, week];
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
        // Should contain a name.
        if (covenant.items.length !== 1)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
          return false;

        // Must be a reserved name.
        const name = covenant.items[0].toString('ascii');

        if (!reserved.has(name))
          return false;

        // Must redeem it to claimant address.
        if (!output.address.equals(rules.CLAIMANT))
          return false;

        break;
      }
      case types.BID: {
        // Should contain a name and hash.
        if (covenant.items.length !== 2)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
          return false;

        // Hash must be 32 bytes.
        if (covenant.items[1].length !== 32)
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

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
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

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
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

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
          return false;

        // Register must have record data.
        if (covenant.items[1].length === 0)
          return false;

        // Record data is limited to 512 bytes.
        if (covenant.items[1].length > rules.MAX_RESOURCE_SIZE)
          return false;

        // Must be a block hash.
        if (covenant.items[2].length !== 32)
          return false;

        // Must have a cold output.
        if (i + 1 >= tx.outputs.length)
          return false;

        // Must be a cold covenant.
        const cold = tx.outputs[i + 1].covenant;

        if (cold.type !== types.COLD)
          return false;

        break;
      }
      case types.UPDATE: {
        // Has to come from a REVEAL or UPDATE.
        if (i >= tx.inputs.length)
          return false;

        // Should contain record data and possibly a block hash.
        if (covenant.items.length < 2 || covenant.items.length > 3)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
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
      case types.COLD: {
        // Has to come from a NONE or COLD.
        if (i >= tx.inputs.length)
          return false;

        // Should contain name data.
        if (covenant.items.length !== 1)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
          return false;

        // An REGISTER or TRANSFER must precede this.
        if (i === 0)
          return false;

        const last = tx.outputs[i - 1].covenant;

        // Must be a REGISTER or TRANSFER.
        if (last.type !== types.REGISTER
            && last.type !== types.TRANSFER) {
          return false;
        }

        // Must have matching names.
        if (!last.items[0].equals(covenant.items[0]))
          return false;

        break;
      }
      case types.TRANSFER: {
        // Has to come from an REGISTER.
        if (i >= tx.inputs.length)
          return false;

        // Should contain hot and cold addresses.
        // These are the addresses we _intend_ to
        // transfer to.
        if (covenant.items.length !== 3)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
          return false;

        // Must obey address size limits.
        if (covenant.items[1].length < 4 || covenant.items[1].length > 42)
          return false;

        // Must obey address size limits.
        if (covenant.items[2].length < 4 || covenant.items[2].length > 42)
          return false;

        // Must have a cold input.
        if (i + 1 >= tx.inputs.length)
          return false;

        // Must have a cold output.
        if (i + 1 >= tx.outputs.length)
          return false;

        // Must be a cold covenant.
        const cold = tx.outputs[i + 1].covenant;

        if (cold.type !== types.COLD)
          return false;

        break;
      }
      case types.REVOKE: {
        // Has to come from an REGISTER.
        if (i >= tx.inputs.length)
          return false;

        // Should contain name data.
        if (covenant.items.length !== 1)
          return false;

        // Name must be valid.
        if (!rules.verifyName(covenant.items[0]))
          return false;

        // Must have a cold input.
        if (i + 1 >= tx.inputs.length)
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
 * @returns {Boolean}
 */

rules.verifyCovenants = function verifyCovenants(tx, view, height) {
  if (tx.isCoinbase())
    return true;

  let checkClaimant = false;
  let last = null;

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

        // Can only go to a NONE, CLAIM, BID, or COLD.
        switch (covenant.type) {
          case types.NONE:
            break;
          case types.CLAIM:
            // Must be redeeming a claimant UTXO.
            checkClaimant = true;
            break;
          case types.BID:
            break;
          case types.COLD:
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
        if (!blind.equals(uc.items[1]))
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

        // Reveal has to go to an UPDATE, or
        // a REDEEM (in the case of the loser).
        switch (covenant.type) {
          case types.REGISTER: {
            // Addresses must match.
            if (!output.address.equals(coin.address))
              return false;

            // Note: Output value must match the
            // second highest bid. This will be
            // checked elsewhere.

            // Must create a cold output
            // with claimant's cold address.
            if (uc.type === types.CLAIM) {
              assert(i + 1 < tx.outputs.length);

              const cold = tx.outputs[i + 1];

              assert(cold.covenant.type === types.COLD);

              if (!cold.address.equals(rules.CLAIMANT_COLD))
                return false;
            }

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
      case types.UPDATE: {
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

            // Must not have a cold input.
            if (i + 1 < tx.inputs.length) {
              // Must not precede a new COLD.
              const coinCold = view.getOutputFor(tx.inputs[i + 1]);

              // Must not be a COLD output.
              if (coinCold.covenant.type === types.COLD)
                return false;
            }

            break;
          }
          case types.TRANSFER: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Must have a cold output (already verified).
            if (i + 1 >= tx.outputs.length)
              return false;

            // Must have a cold input (already verified).
            if (i + 1 >= tx.inputs.length)
              return false;

            // Must precede a new COLD.
            const cold = tx.outputs[i + 1];

            // Must be a COLD output (already verified).
            if (cold.covenant.type !== types.COLD)
              return false;

            // Must precede a new COLD.
            const coinCold = view.getOutputFor(tx.inputs[i + 1]);

            // Must be a COLD output.
            if (coinCold.covenant.type !== types.COLD)
              return false;

            // Addresses must match for now.
            if (!cold.address.equals(coinCold.address))
              return false;

            break;
          }
          case types.REVOKE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Must have a cold input (already verified).
            if (i + 1 >= tx.inputs.length)
              return false;

            // Must precede a previous COLD.
            const coinCold = view.getOutputFor(tx.inputs[i + 1]);
            assert(coinCold);

            // Must be a COLD output.
            if (coinCold.covenant.type !== types.COLD)
              return false;

            break;
          }
          default: {
            return false;
          }
        }

        break;
      }
      case types.COLD: {
        // Must be be linked (unless revoking).
        if (!output) {
          if (i === 0)
            return false;

          const revoke = tx.outputs[i - 1];

          if (revoke.covenant.type !== types.REVOKE)
            return false;

          // Must have the same name.
          if (!uc.items[0].equals(revoke.covenant.items[0]))
            return false;

          break;
        }

        // Must go to a COLD.
        if (covenant.type !== types.COLD)
          return false;

        // Must have the same name.
        if (!uc.items[0].equals(covenant.items[0]))
          return false;

        // Must have an register/transfer precede it.
        if (!last)
          return false;

        // Must be an REGISTER, UPDATE, or TRANSFER.
        if (last.type !== types.REGISTER
            && last.type !== types.UPDATE
            && last.type !== types.TRANSFER) {
          return false;
        }

        // Must have same name.
        if (!uc.items[0].equals(last.items[0]))
          return false;

        break;
      }
      case types.TRANSFER: {
        // Must be be linked.
        if (!output)
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        // Can only send to a REGISTER or REVOKE.
        switch (covenant.type) {
          case types.REGISTER: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Must precede a new COLD (already verified).
            if (i + 1 >= tx.outputs.length)
              return false;

            // Must precede a new COLD.
            const cold = tx.outputs[i + 1];

            // Must be a COLD output (already verified).
            if (cold.covenant.type !== types.COLD)
              return false;

            // If we're not sending it back to the owner
            // address, we have some more stipulations.
            if (!output.address.equals(coin.address)) {
              // Transfers must wait 48 hours before updating.
              if (height < entry.height + network.names.transferLockup)
                return false;

              // Addresses must match the ones committed
              // to in the original transfer covenant.
              if (!output.address.toRaw().equals(uc.items[1]))
                return false;

              if (!cold.address.toRaw().equals(uc.items[2]))
                return false;
            }

            break;
          }
          case types.REVOKE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Must match the original owner's address.
            if (!output.address.equals(coin.address))
              return false;

            // Must have a cold input (already verified).
            if (i + 1 >= tx.inputs.length)
              return false;

            // Must precede a previous COLD.
            const coinCold = view.getOutputFor(tx.inputs[i + 1]);
            assert(coinCold);

            // Must be a COLD output.
            if (coinCold.covenant.type !== types.COLD)
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

    last = uc;
  }

  if (checkClaimant) {
    if (!rules.hasClaimant(tx, view))
      return false;
  }

  return true;
};

/**
 * Test whether a transaction is redeeming
 * one of the claimant's UTXOs.
 * @param {TX} tx
 * @param {CoinView} view
 * @returns {Boolean}
 */

rules.hasClaimant = function hasClaimant(tx, view) {
  for (const {prevout} of tx.inputs) {
    const coin = view.getOutput(prevout);

    if (!coin)
      continue;

    if (!coin.address.equals(rules.CLAIMANT))
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

/**
 * Test whether a transaction would be
 * unresolvable in the mempool after a
 * reorg due to certain covenant time
 * locks. Right now this only includes
 * in-flight transfers.
 * @param {TX} tx
 * @param {CoinView} view
 * @returns {Boolean}
 */

rules.isUnresolvable = function isUnresolvable(tx, view) {
  for (let i = 0; i < tx.inputs.length; i++) {
    const {prevout} = tx.inputs[i];
    const coin = view.getOutput(prevout);

    if (!coin)
      continue;

    if (coin.covenant.type !== types.TRANSFER)
      continue;

    assert(i < tx.outputs.length);

    const output = tx.outputs[i];

    if (output.covenant.type !== types.REGISTER)
      continue;

    // In-flight transfers are unresolvable after a reorg.
    if (!output.address.equals(coin.address))
      return true;
  }

  return false;
};
