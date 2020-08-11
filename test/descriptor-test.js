/**
 * test/descriptor-test.js - Test output descriptor
 * Copyright (c) 2020, The Handshake Developers (MIT License).
 * Copyright (c) 2020, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const Opcode = require('../lib/script/opcode');
const Descriptor = require('../lib/utils/descriptor');

describe('Descriptor', function() {
  it('should create wsh', () => {
    const script = new Script([
      Opcode.fromSymbol('return')
    ]);

    const copy = script.clone();
    const address = Address.fromScript(copy);

    const str = `wsh(${script.toHex()})`;
    const desc = Descriptor.fromString(str);

    assert.equal(desc.descriptor, str);
    assert(desc.test(address));
  });


  it('should create wpkh', () => {
    const privkey = secp256k1.privateKeyGenerate();
    const pubkey = secp256k1.publicKeyCreate(privkey, true);
    const str = `wpkh(${pubkey.toString('hex')})`;

    const address = Address.fromPubkey(pubkey);
    const desc = Descriptor.fromString(str);

    assert.equal(desc.descriptor, str);
    assert(desc.test(address));
  });

  it('should create addr', () => {
    const address = new Address();
    const str = `addr(${address.toString()})`;

    const desc = Descriptor.fromString(str);
    assert.equal(desc.descriptor, str);
    assert(desc.test(address));
  });

  it('should create opreturn', () => {
    const data = 'Bitcoin & BitDNS can be used separately'; // --Satoshi
    const str = `opreturn(${data})`;
    const address = Address.fromNulldata(Buffer.from(data, 'ascii'));

    const desc = Descriptor.fromString(str);
    assert.equal(desc.descriptor, str);
    assert(desc.test(address));
  });
});
