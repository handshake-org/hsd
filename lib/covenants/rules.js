'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');

// TODO:
// locktime for transfer
// no duplicate names
// early reveals

const types = {
  NONE: 0,
  BID: 1,
  REVEAL: 2,
  UPDATE: 3,
  REDEEM: 4,
  RELEASE: 5
};

exports.types = types;

exports.MAX_NAME_SIZE = 255;
exports.MAX_RECORD_SIZE = 512;
exports.MAX_COVENANT_SIZE = 1 + exports.MAX_RECORD_SIZE;
exports.MAX_COVENANT_TYPE = types.RELEASE;

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
  const links = new Set();

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
    const {covenant} = tx.outputs[i];

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
      case types.UPDATE: {
        // Has to come from an UPDATE or REVEAL.
        if (i >= tx.inputs.length)
          return false;

        // Should contain record data.
        if (covenant.items.length !== 2)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
          return false;

        // Record data is limited to 1kb.
        if (covenant.items[1].length > exports.MAX_RECORD_SIZE)
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
      case types.RELEASE: {
        // Has to come from an UPDATE or REVEAL.
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

exports.verifyCovenants = function verifyCovenants(tx, view) {
  if (tx.isCoinbase())
    return true;

  for (let i = 0; i < tx.inputs.length; i++) {
    const {prevout} = tx.inputs[i];
    const coin = view.getOutput(prevout);

    if (!coin)
      continue;

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

        // Reveal has to go to an update, or
        // a redeem (in the case of the loser).
        switch (covenant.type) {
          case types.UPDATE:
          case types.RELEASE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Money is now locked up forever.
            if (output.value !== coin.value)
              return false;

            break;
          }
          case types.REDEEM: {
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
      case types.UPDATE: {
        // Must be be linked.
        if (!output)
          return false;

        // Can only send to another update or release.
        switch (covenant.type) {
          case types.UPDATE:
          case types.RELEASE: {
            // Names must match.
            if (!covenant.items[0].equals(uc.items[0]))
              return false;

            // Money is now locked up forever.
            if (output.value !== coin.value)
              return false;

            break;
          }
          default: {
            return false;
          }
        }

        break;
      }
      case types.RELEASE: {
        // Releases are perma-burned.
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
