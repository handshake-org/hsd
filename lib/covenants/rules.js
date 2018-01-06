'use strict';

const assert = require('assert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');

const types = {
  NONE: 0,
  BID: 1,
  REVEAL: 2,
  UPDATE: 3,
  REDEEM: 4,
  // locktime for transfer
  RELEASE: 5
};

exports.types = types;

exports.MAX_NAME_SIZE = 255;
exports.MAX_RECORD_SIZE = 512;
exports.MAX_COVENANT_SIZE = 1 + exports.MAX_RECORD_SIZE;
exports.MAX_COVENANT_TYPE = types.UPDATE;

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
    if (tx.inputs[0].link !== 0xffffffff)
      return false;

    for (const {covenant} of tx.outputs) {
      if (covenant.type !== types.NONE)
        return false;
    }

    return true;
  }

  // Do not allow invalid links.
  for (const input of tx.inputs) {
    if (input.link === 0xffffffff)
      continue;

    // Link is higher than the amount of outputs.
    if (input.link >= tx.outputs.length)
      return false;

    // Duplicate link.
    if (links.has(input.link))
      return false;

    links.add(input.link);
  }

  for (let i = 0; i < tx.outputs.length; i++) {
    const {covenant} = tx.outputs[i];

    switch (covenant.type) {
      case types.NONE:
        // No inputs can be linked.
        if (links.has(i))
          return false;
        // Just a regular payment.
        // Can come from a payment or a reveal (loser).
        break;
      case types.BID:
        // No inputs can be linked.
        if (links.has(i))
          return false;

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
      case types.REVEAL:
        // Has to come from a BID.
        if (!links.has(i))
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
      case types.UPDATE:
        // Has to come from an UPDATE or REVEAL.
        if (!links.has(i))
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
      case types.REDEEM:
        // Has to come from a REVEAL.
        if (!links.has(i))
          return false;

        // Should contain name data.
        if (covenant.items.length !== 1)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
          return false;

        break;
      case types.RELEASE:
        // Has to come from an UPDATE or REVEAL.
        if (!links.has(i))
          return false;

        // Should contain name data.
        if (covenant.items.length !== 1)
          return false;

        // Name must be valid.
        if (!exports.verifyName(covenant.items[0]))
          return false;

        break;
      default:
        // Unknown covenant.
        // Don't enforce anything.
        break;
    }
  }

  return true;
};

exports.verifyCovenants = function verifyCovenants(tx, view) {
  if (tx.isCoinbase())
    return true;

  for (const input of tx.inputs) {
    const coin = view.getOutputFor(input);

    if (!coin)
      continue;

    const uc = coin.covenant;

    // XXX More verification here?
    if (input.link === 0xffffffff)
      continue;

    assert(input.link < tx.outputs.length);

    // Output the covenant is linked to.
    const output = tx.outputs[input.link];
    const {covenant} = output;

    switch (uc.type) {
      case types.NONE: {
        // Payment has to go to either
        // another payment, or a bid.
        if (covenant.type !== types.NONE
            && covenant.type !== types.BID) {
          return false;
        }
        break;
      }
      case types.BID: {
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
        // Reveal has to go to an update, or
        // a redeem (in the case of the loser).
        if (covenant.type !== types.UPDATE
            && covenant.type !== types.REDEEM) {
          return false;
        }

        // Money is now locked up forever.
        if (covenant.type === types.UPDATE) {
          // Names must match.
          if (!covenant.items[0].equals(uc.items[0]))
            return false;

          if (output.value !== coin.value)
            return false;
        }

        if (covenant.type === types.REDEEM) {
          // Names must match.
          if (!covenant.items[0].equals(uc.items[0]))
            return false;
        }

        break;
      }
      case types.UPDATE: {
        // Names must match.
        if (!covenant.items[0].equals(uc.items[0]))
          return false;

        // Money is now locked up forever.
        if (output.value !== coin.value)
          return false;

        if (covenant.type !== types.UPDATE)
          return false;

        break;
      }
      case types.REDEEM: {
        // Can go anywhere.
        if (covenant.items.length !== 0)
          return false;

        break;
      }
      case types.RELEASE: {
        // Can go anywhere.
        if (covenant.items.length !== 0)
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

exports.blind = function blind(value, nonce) {
  const bw = bio.write(40);
  bw.writeU64(value);
  bw.writeBytes(nonce);
  return blake2b.digest(bw.render());
};
