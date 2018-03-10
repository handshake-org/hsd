'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const reserved = require('./reserved');

const NAME_BUFFER = Buffer.allocUnsafe(64);

const types = {
  NONE: 0,
  CLAIM: 1,
  BID: 2,
  REVEAL: 3,
  REDEEM: 4,
  UPDATE: 5,
  COLD: 6
};

exports.types = types;

const blacklist = new Set([
  'bit', // Namecoin
  'eth', // ENS
  'example', // ICANN reserved
  'invalid', // ICANN reserved
  'local', // mDNS
  'localhost', // ICANN reserved
  'onion', // Tor
  'test' // ICANN reserved
]);

exports.CLAIMANT = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000000', 'hex');

exports.MAX_NAME_SIZE = 64;
exports.MAX_RESOURCE_SIZE = 512;
exports.MAX_COVENANT_SIZE = 0
  + 1 + exports.MAX_NAME_SIZE
  + 2 + exports.MAX_RESOURCE_SIZE
  + 1 + 42; // 622
exports.MAX_BID_SIZE = 1 + 64 + 1 + 32;
exports.MAX_COVENANT_TYPE = types.COLD;

exports.ROLLOUT_INTERVAL = (7 * 24 * 60) / 2.5 | 0;
exports.RENEWAL_PERIOD = (182 * 24 * 60) / 2.5 | 0;
exports.RENEWAL_WINDOW = (365 * 24 * 60) / 2.5 | 0;
exports.RENEWAL_MATURITY = (30 * 24 * 60) / 2.5 | 0;
exports.CLAIM_PERIOD = (3 * 365 * 24 * 60) / 2.5 | 0;
exports.BIDDING_PERIOD = 1;
exports.REVEAL_PERIOD = 1;
exports.TOTAL_PERIOD = exports.BIDDING_PERIOD + exports.REVEAL_PERIOD;
exports.TRIE_INTERVAL = 144;

/*
main.names = {
  rolloutInterval: (7 * 24 * 60) / 2.5 | 0,
  renewalPeriod: (182 * 24 * 60) / 2.5 | 0,
  renewalWindow: (365 * 24 * 60) / 2.5 | 0,
  renewalMaturity: (30 * 24 * 60) / 2.5 | 0,
  claimPeriod: (3 * 365 * 24 * 60) / 2.5 | 0,
  biddingPeriod: 1,
  revealPeriod: 1,
  totalPeriod: 2,
  trieInterval: 144
};
*/

exports.CHARSET = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
  0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0
]);

exports.hashName = function hashName(name) {
  if (Buffer.isBuffer(name))
    return blake2b.digest(name);

  assert(typeof name === 'string');

  const buf = NAME_BUFFER;
  assert(name.length <= 64);

  const written = buf.write(name, 0, 64, 'ascii');
  assert(name.length === written);

  return blake2b.digest(buf.slice(0, written));
};

exports.verifyName = function verifyName(name) {
  if (Buffer.isBuffer(name))
    return exports.verifyBinary(name);
  return exports.verifyString(name);
};

exports.verifyString = function verifyString(str) {
  assert(typeof str === 'string');

  if (str.length === 0)
    return false;

  if (str.length > exports.MAX_NAME_SIZE)
    return false;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);

    // No unicode characters.
    if (ch & 0xff80)
      return false;

    const type = exports.CHARSET[ch];

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

  if (blacklist.has(str))
    return false;

  return true;
};

exports.verifyBinary = function verifyBinary(buf) {
  assert(Buffer.isBuffer(buf));

  if (buf.length === 0)
    return false;

  if (buf.length > exports.MAX_NAME_SIZE)
    return false;

  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];

    // No unicode characters.
    if (ch & 0x80)
      return false;

    const type = exports.CHARSET[ch];

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

  if (blacklist.has(str))
    return false;

  return true;
};

exports.getRollout = function getRollout(name) {
  if (typeof name === 'string')
    name = Buffer.from(name, 'ascii');

  assert(Buffer.isBuffer(name) && name.length <= exports.MAX_NAME_SIZE);

  const week = blake2b.digest(name)[0] % 52;
  const height = week * exports.ROLLOUT_INTERVAL;

  return [height, week];
};

exports.verifyRollout = function verifyRollout(name, height, network) {
  assert((height >>> 0) === height);
  assert(network);

  if (network.type !== 'main')
    return true;

  const [start] = exports.getRollout(name);

  if (height < start)
    return false;

  return true;
};

exports.isReserved = function isReserved(name, height, network) {
  if (Buffer.isBuffer(name))
    name = name.toString('ascii');

  assert(typeof name === 'string');
  assert((height >>> 0) === height);
  assert(network);

  // if (network.type !== 'main')
  //   return false;

  if (height >= exports.CLAIM_PERIOD)
    return false;

  return reserved.has(name);
};

exports.isAvailable = function isAvailable(name, height, network) {
  if (!exports.verifyName(name))
    return false;

  if (exports.isReserved(name, height, network))
    return false;

  if (!exports.verifyRollout(name, height, network))
    return false;

  return true;
};

exports.hasSaneCovenants = function hasSaneCovenants(tx) {
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
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // Must be a reserved name.
        const name = covenant.items[0].toString('ascii');

        if (!reserved.has(name))
          return false;

        break;
      }
      case types.BID: {
        // Should contain a name and hash.
        if (covenant.items.length !== 2)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
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
        if (!exports.verifyName(covenant.items[0]))
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
        if (!exports.verifyName(covenant.items[0]))
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
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // Record data is limited to 512 bytes.
        if (covenant.items[1].length > exports.MAX_RESOURCE_SIZE)
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
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // An UPDATE must precede this.
        if (i === 0)
          return false;

        const update = tx.outputs[i - 1].covenant;

        // Must be an UPDATE.
        if (update.type !== types.UPDATE)
          return false;

        // Must have matching names.
        if (!update.items[0].equals(covenant.items[0]))
          return false;

        break;
      }
      default: {
        // Unknown covenant.
        // Don't enforce anything.
        if (covenant.getSize() > exports.MAX_COVENANT_SIZE)
          return false;
        break;
      }
    }
  }

  return true;
};

exports.hasClaimant = function hasClaimant(tx, view) {
  for (const {prevout} of tx.inputs) {
    const coin = view.getOutput(prevout);

    if (!coin)
      continue;

    const {version, hash} = coin.address;

    if (version !== 0)
      continue;

    if (!hash.equals(exports.CLAIMANT))
      continue;

    return true;
  }

  return false;
};

exports.verifyCovenants = function verifyCovenants(tx, view, height) {
  if (tx.isCoinbase())
    return true;

  const claimant = exports.hasClaimant(tx, view);

  let last = null;

  for (let i = 0; i < tx.inputs.length; i++) {
    const {prevout} = tx.inputs[i];
    const coin = view.getOutput(prevout);

    if (!coin) {
      last = null;
      continue;
    }

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
        if (covenant.type >= types.REVEAL
            && covenant.type <= types.UPDATE) {
          return false;
        }

        // Must be redeeming a claimant UTXO.
        if (covenant.type === types.CLAIM) {
          if (!claimant)
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
        const blind = exports.blind(output.value, nonce);

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
          case types.UPDATE: {
            // Addresses must match.
            if (!output.address.equals(coin.address))
              return false;

            // Note: Output value must match the
            // second highest bid. This will be
            // checked elsewhere.

            // First update must have data.
            if (covenant.items[1].length === 0)
              return false;

            // Must have a renewal.
            if (covenant.items.length !== 3)
              return false;

            // Must be a zero hash.
            if (!covenant.items[2].equals(consensus.ZERO_HASH))
              return false;

            // Must have a revocation output.
            if (i + 1 >= tx.outputs.length)
              return false;

            // This must precede a COLD.
            const cold = tx.outputs[i + 1];

            // Must be a revocation output.
            if (cold.covenant.type !== types.COLD)
              return false;

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
      case types.UPDATE: {
        // Must be be linked.
        if (!output)
          return false;

        // Can only send to an UPDATE.
        if (covenant.type !== types.UPDATE)
          return false;

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        // May have a revocation output.
        let hasCold = false;

        if (i + 1 < tx.outputs.length) {
          // May precede a new COLD.
          const cold = tx.outputs[i + 1];

          // Can be a COLD output.
          if (cold.covenant.type === types.COLD)
            hasCold = true;
        }

        // Addresses must match.
        if (!output.address.equals(coin.address)) {
          // If not, we must be registering
          // a new revocation key.
          if (!hasCold)
            return false;
        }

        break;
      }
      case types.COLD: {
        // Must be be linked.
        if (!output)
          return false;

        // Must go to a COLD.
        if (covenant.type !== types.COLD)
          return false;

        // Must have the same name.
        if (!uc.items[0].equals(covenant.items[0]))
          return false;

        // Must have an update precede it.
        if (!last)
          return false;

        // Must be an update.
        if (last.type !== types.UPDATE)
          return false;

        // Must have same name.
        if (!uc.items[0].equals(last.items[0]))
          return false;

        break;
      }
      default: {
        // Unknown covenant.
        // Don't enforce anything.
        if (covenant.type >= types.CLAIM
            && covenant.type <= types.COLD) {
          return false;
        }
        break;
      }
    }

    last = uc;
  }

  return true;
};

exports.isLinked = function isLinked(covenant) {
  const {type} = covenant;
  return type >= types.REVEAL && type <= types.COLD;
};

exports.isUnspendable = function isUnspendable(coin, height) {
  switch (coin.covenant.type) {
    case types.NONE:
    case types.REDEEM:
      return false;
    default:
      return true;
  }
};

exports.isDustworthy = function isDustworthy(type) {
  switch (type) {
    case types.NONE:
    case types.BID:
      return true;
    default:
      return type > types.COLD;
  }
};

exports.isUnresolvable = function isUnresolvable(tx, view) {
  return false;
};

exports.blind = function blind(value, nonce) {
  const bw = bio.write(40);
  bw.writeU64(value);
  bw.writeBytes(nonce);
  return blake2b.digest(bw.render());
};
