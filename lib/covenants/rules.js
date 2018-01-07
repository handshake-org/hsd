'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');

const types = {
  NONE: 0,
  BID: 1,
  REVEAL: 2,
  REGISTER: 3,
  REDEEM: 4,
  TRANSFER: 5,
  REVOKE: 6
};

exports.types = types;

exports.MAX_NAME_SIZE = 64;
exports.MAX_RECORD_SIZE = 256;
exports.MAX_COVENANT_SIZE = 1 + exports.MAX_RECORD_SIZE;
exports.MAX_COVENANT_TYPE = types.REVOKE;
exports.ROLLOUT_INTERVAL = (7 * 24 * 60) / 2.5 | 0;
exports.RENEWAL_PERIOD = (182 * 24 * 60) / 2.5 | 0;
exports.RENEWAL_WINDOW = (365 * 24 * 60) / 2.5 | 0;
exports.REVOCATION_WINDOW = (2 * 24 * 60) / 2.5 | 0;

exports.BIDDING_PERIOD = 1;
exports.REVEAL_PERIOD = 1;
exports.TOTAL_PERIOD = exports.BIDDING_PERIOD + exports.REVEAL_PERIOD;

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
        // Can come from a payment or a reveal (loser).
        if (covenant.items.length !== 0)
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

        // Should contain a nonce and height.
        if (covenant.items.length !== 3)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // Nonce must be 32 bytes.
        if (covenant.items[1].length !== 32)
          return false;

        // Height the user bid at.
        if (covenant.items[2].length !== 4)
          return false;

        break;
      }
      case types.REGISTER: {
        // Has to come from an REGISTER or REVEAL.
        if (i >= tx.inputs.length)
          return false;

        // Should contain record data and possibly a block hash.
        if (covenant.items.length < 2 || covenant.items.length > 3)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // Record data is limited to 1kb.
        if (covenant.items[1].length > exports.MAX_RECORD_SIZE)
          return false;

        if (covenant.items.length === 3) {
          // Must be a block hash.
          if (covenant.items[2].length !== 32)
            return false;
        }

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
      case types.TRANSFER: {
        // Has to come from an REGISTER.
        if (i >= tx.inputs.length)
          return false;

        // Should contain record data and address.
        if (covenant.items.length !== 3)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // Record data is limited to 1kb.
        if (covenant.items[1].length > exports.MAX_RECORD_SIZE)
          return false;

        // Must obey address size limits.
        if (covenant.items[2].length < 2 || covenant.items[2].length > 40)
          return false;

        // No point in transferring if addrs are the same.
        if (output.address.hash.equals(covenant.items[2]))
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
        if (!exports.verifyName(covenant.items[0]))
          return false;

        break;
      }
      default: {
        // Unknown covenant.
        // Don't enforce anything.
        break;
      }
    }
  }

  return true;
};

exports.isLinked = function isLinked(covenant) {
  return covenant.type > types.BID;
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

exports.verifyCovenants = function verifyCovenants(tx, view, height) {
  if (tx.isCoinbase())
    return true;

  for (let i = 0; i < tx.inputs.length; i++) {
    const {prevout} = tx.inputs[i];
    const entry = view.getEntry(prevout);

    if (!entry)
      continue;

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

        // Can only go to a payment or bid.
        if (covenant.type !== types.NONE
            && covenant.type !== types.BID
            && covenant.type <= exports.MAX_COVENANT_TYPE) {
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

        // Height must match their bid height.
        if (covenant.items[2].readUInt32LE(0, true) !== entry.height)
          return false;

        // If they lied to us, they can
        // never redeem their money.
        if (coin.value < output.value)
          return false;

        break;
      }
      case types.REVEAL: {
        // Must be be linked.
        if (!output)
          return false;

        // Addresses must match.
        if (!output.address.equals(coin.address))
          return false;

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        // Reveal has to go to an REGISTER, or
        // a REDEEM (in the case of the loser).
        switch (covenant.type) {
          case types.REGISTER: {
            // Money is now locked up forever.
            if (output.value !== coin.value)
              return false;

            // No renewals allowed here.
            if (covenant.items.length !== 2)
              return false;

            break;
          }
          case types.REDEEM: {
            break;
          }
          default: {
            return false;
          }
        }

        break;
      }
      case types.REGISTER: {
        // Must be be linked.
        if (!output)
          return false;

        // Addresses must match.
        if (!output.address.equals(coin.address))
          return false;

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        // Can only send to another
        // REGISTER or TRANSFER.
        switch (covenant.type) {
          case types.TRANSFER: {
            // Record data must match during a transfer.
            if (!covenant.items[1].equals(uc.items[1]))
              return false;
            break;
          }
          case types.REGISTER: {
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

        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        // Can only send to another
        // REGISTER, TRANSFER, or REVOKE.
        switch (covenant.type) {
          case types.REGISTER: {
            // Transfers must wait 48 hours before updating.
            if (height < entry.height + exports.REVOCATION_WINDOW)
              return false;

            // Address must match the one committed
            // to in the original transfer covenant.
            if (!output.address.hash.equals(uc.items[2]))
              return false;

            break;
          }
          case types.REVOKE: {
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
        break;
      }
    }
  }

  return true;
};

exports.blind = function blind(value, nonce) {
  const bw = bio.write(40);
  bw.writeU64(value);
  bw.writeBytes(nonce);
  return blake2b.digest(bw.render());
};
