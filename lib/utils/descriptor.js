/**
 * descriptor.js - Output descriptor for hsd
 * Copyright (c) 2020, The Handshake Developers (MIT License).
 * Copyright (c) 2020, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Script = require('../script/script');
const secp256k1 = require('bcrypto/lib/secp256k1');
const Address = require('../primitives/address');
const {BufferSet} = require('buffer-map');

// all are top level
const typeCache = new Set([
  'wpkh',
  'wsh',
  'addr',
  'opreturn'
]);

class Descriptor {
  constructor(descriptor) {
    this.descriptor = descriptor || '';
    this.addresses = new BufferSet();

    if (descriptor)
      this.fromString(descriptor);
  }

  fromString(descriptor) {
    const chars = descriptor.split('');

    const stack = [];
    let word = [];
    let action = '';

    for (const char of chars) {
      switch (char) {
        case '(': {
          stack.push(char);
          const w = word.join('');
          if (!typeCache.has(w))
            throw new Error(`Unknown word ${w}`);

          action = w;
          word = [];
          break;
        }
        case ')': {
          const item = stack.pop();
          if (item !== '(')
            throw new Error('Unclosed ")"');

          const w = word.join('');
          switch (action) {
            case 'wsh': {
              // w is a script
              const script = Script.fromHex(w);
              const address = Address.fromScript(script);
              this.addresses.add(address.encode());
              break;
            }
            case 'wpkh': {
              // w is a pubkey
              const pubkey = Buffer.from(w, 'hex');
              assert(secp256k1.publicKeyVerify(pubkey));
              const address = Address.fromPubkey(pubkey);
              this.addresses.add(address.encode());
              break;
            }
            case 'addr': {
              const address = Address.fromString(w);
              this.addresses.add(address.encode());
              break;
            }
            case 'opreturn': {
              let enc = 'ascii';
              if (w.startsWith('0x'))
                enc = 'hex';

              const data = Buffer.from(w, enc);
              const address = Address.fromNulldata(data);
              this.addresses.add(address.encode());
              break;
            }
          }

          break;
        }
        default:
          word.push(char);
          break;
      }
    }

    return this;
  }

  toString() {
    return this.descriptor;
  }

  test(address) {
    return this.addresses.has(address.encode());
  }

  static fromString(descriptor) {
    return new this(descriptor);
  }
}

module.exports = Descriptor;
