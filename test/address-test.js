/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const Opcode = require('../lib/script/opcode');
const Witness = require('../lib/script/witness');
const secp256k1 = require('bcrypto/lib/secp256k1');
const blake2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');

describe('Address', function() {
  it('should match mainnet p2pkh address', () => {
    const raw = '6d5571fdbca1019cd0f0cd792d1b0bdfa7651c7e';
    const p2pkh = Buffer.from(raw, 'hex');
    const addr = Address.fromPubkeyhash(p2pkh);
    const expect = 'hs1qd42hrldu5yqee58se4uj6xctm7nk28r70e84vx';
    assert.strictEqual(addr.toString('main'), expect);
  });

  it('should render the correct p2wpkh script', () => {
    // create a keypair and hash the pubkey
    const priv = secp256k1.privateKeyGenerate();
    const pub = secp256k1.publicKeyCreate(priv);
    const hash = blake2b.digest(pub, 20);

    // create an address from the pubkey
    const addr = Address.fromPubkeyhash(hash);

    // convert the address to a script
    const script = addr.toScript();

    // expect a pay to pubkey hash
    const expect = Script.fromArray([
      Opcode.fromSymbol('dup'),
      Opcode.fromSymbol('blake160'),
      Opcode.fromPush(hash),
      Opcode.fromSymbol('equalverify'),
      Opcode.fromSymbol('checksig')
    ]);

    assert(script.equals(expect));
    assert.deepEqual(script.toHex(), expect.toHex());
  });

  it('should render the correct p2sh script', () => {
    const script = Script.fromArray([
      Opcode.fromInt(2),
      Opcode.fromSymbol('add'),
      Opcode.fromInt(4),
      Opcode.fromSymbol('equal')
    ]);

    const witness = Witness.fromArray([
      Buffer.from([2]),
      script.encode()
    ]);

    const addr = Address.fromScript(script);
    const got = addr.toScript(witness);

    assert(script.equals(got));
    assert.deepEqual(script.toHex(), got.toHex());
  });

  it('should not render p2sh script when incorrect', () => {
    const script = Script.fromArray([
      Opcode.fromSymbol('verify')
    ]);

    const fake = Script.fromArray([
      Opcode.fromSymbol('return')
    ]);

    const witness = Witness.fromArray([
      fake.encode()
    ]);

    const addr = Address.fromScript(script);
    const got = addr.toScript(witness);

    assert.deepEqual(got, null);
  });

  it('should render the correct opreturn script', () => {
    const msg = Buffer.from('1100112233', 'hex');

    const addr = Address.fromNulldata(msg);
    const got = addr.toScript();

    const expect = Script.fromArray([
      Opcode.fromSymbol('return'),
      Opcode.fromPush(msg)
    ]);

    assert(got.equals(expect));
    assert.deepEqual(got.toHex(), expect.toHex());
  });

  it('should render null when unknown version', () => {
    const hash = random.randomBytes(20);
    // version 30 is unknown at this time
    const addr = Address.fromHash(hash, 30);
    const script = addr.toScript();

    assert.deepEqual(script, null);
  });
});
