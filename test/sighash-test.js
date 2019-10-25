/*!
 * sighash-test.js - test sighash types
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');
const Mnemonic = require('../lib/hd/mnemonic');
const HDPrivateKey = require('../lib/hd/private');
const Coin = require('../lib/primitives/coin');
const Output = require('../lib/primitives/output');
const Witness = require('../lib/script/witness');
const Network = require('../lib/protocol/network');
const common = require('../lib/script/common');
const {HARDENED} = require('../lib/hd/common');

const mnemonics = require('./data/mnemonic-english.json');
const phrase = mnemonics[0][1];
const mnemonic = Mnemonic.fromPhrase(phrase);

const network = Network.get('regtest');

// sighash types
const SINGLEREVERSE = common.hashType.SINGLEREVERSE;

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;
const COIN_TYPE= network.keyPrefix.coinType;

describe('Signature Hashes', function () {
  describe('SINGLEREVERSE', function () {
    let path, keyring, addr, receives;

    before(() => {
      path = [harden(44), harden(5353), harden(0), 0, 0];
      keyring = newKeyRing(path);
      addr = keyring.getAddress();

      // generate receive addresses
      receives = [
        newAddress([harden(44), harden(COIN_TYPE), harden(1), 0, 0]),
        newAddress([harden(44), harden(COIN_TYPE), harden(2), 0, 0]),
        newAddress([harden(44), harden(COIN_TYPE), harden(3), 0, 0])
      ];
    });

    after(() => {
      path = null;
      keyring = null;
      addr = null;
      receives = null;
    });

    it('should exist in common', () => {
      assert('SINGLEREVERSE' in common.hashType);
      assert(common.hashTypeByVal[SINGLEREVERSE] === 'SINGLEREVERSE');
    });

    it('should create the correct sighash', () => {
      // SINGLEREVERSE commits to the output at the opposite
      // index, meaning that it is the outputs.length - 1 - i'th index,
      // where i is the index of the input. 1 is subtracted from the
      // outputs length to make sure that it is 0 indexed.

      // create a transaction with 1 input and 2 outputs
      // sign with SINGLEREVERSE so that only the final output
      // is committed to
      const mtx = new MTX();
      mtx.addOutput(receives[0], 50000);
      mtx.addOutput(receives[1], 20000);

      const coin = new Coin({
        height: 0,
        value: 70000,
        address: addr,
        hash: ONE_HASH,
        index: 0
      });

      mtx.addCoin(coin);

      const script = Script.fromPubkeyhash(keyring.getHash());
      // sign the 0th input, commit to the output at index 1
      const sighash = mtx.signatureHash(0, script, 70000, SINGLEREVERSE);

      // malleate in safe way by altering the output at index 0
      mtx.outputs[0] = new Output();
      const malleated = mtx.signatureHash(0, script, 70000, SINGLEREVERSE);
      assert.bufferEqual(sighash, malleated);

      // malleate in unsafe way by altering the output at index 1
      mtx.outputs[1] = new Output();
      const fail = mtx.signatureHash(0, script, 70000, SINGLEREVERSE);
      assert.notBufferEqual(sighash, fail);
    });

    it('should create a valid signature', () => {
      // create a transaction with 2 outputs and 1 input
      // sign using SINGLEREVERSE and validate signature using mtx.verify()
      const mtx = new MTX();
      mtx.addOutput(receives[0], 50000);
      mtx.addOutput(receives[1], 20000);

      assert.deepEqual(mtx.outputs[0].address, receives[0]);
      assert.deepEqual(mtx.outputs[1].address, receives[1]);

      const coin = new Coin({
        height: 0,
        value: 70000,
        address: addr,
        hash: ONE_HASH,
        index: 0
      });

      mtx.addCoin(coin);

      assert.equal(mtx.inputs[0].prevout.hash, ONE_HASH);
      assert.equal(mtx.inputs[0].prevout.index, 0);

      const script = Script.fromPubkeyhash(keyring.getHash());
      const sig = mtx.signature(0, script, 70000, keyring.privateKey, SINGLEREVERSE);
      mtx.inputs[0].witness = Witness.fromItems([sig, keyring.publicKey]);

      const valid = mtx.verify();
      assert(valid);
    });

    it('should not commit to additional outputs', () => {
      // create a transaction with 2 outputs and 1 input
      // sign input 0 with SINGLEREVERSE which only
      // commits to output 1, alter output 0 to show that
      // the sighash does not commit to that output and
      // validate the signature using mtx.verify()

      const mtx = new MTX();
      mtx.addOutput(receives[0], 50000);
      mtx.addOutput(receives[1], 20000);

      const coin = new Coin({
        height: 0,
        value: 70000,
        address: addr,
        hash: ONE_HASH,
        index: 0
      });

      mtx.addCoin(coin);

      const script = Script.fromPubkeyhash(keyring.getHash());
      const sig = mtx.signature(0, script, 70000, keyring.privateKey, SINGLEREVERSE);
      mtx.inputs[0].witness = Witness.fromItems([sig, keyring.publicKey]);

      assert.deepEqual(mtx.outputs[0].address, receives[0]);
      assert.deepEqual(mtx.outputs[1].address, receives[1]);

      // replace the output that is not committed to
      // the transaction should still be valid
      mtx.outputs[0] = new Output({
        address: receives[2],
        value: 0
      });

      assert.deepEqual(mtx.outputs[0].address, receives[2]);
      assert(mtx.verify());

      // replace the output that has been committed to
      // the transaction should no longer be valid
      mtx.outputs[1] = new Output({
        address: receives[2],
        value: 0
      });

      assert.equal(mtx.verify(), false);
    });
  });
});

// deterministically generate keys from a path
function newKeyRing(path) {
  let key = HDPrivateKey.fromMnemonic(mnemonic);

  assert(Array.isArray(path));
  assert(path.every(index => Number.isSafeInteger(index)));

  for (let index of path) {
    let hardened = false;
    if (index & HARDENED) {
      index ^= HARDENED;
      hardened = true;
    }
    key = key.derive(index, hardened);
  }

  return KeyRing.fromPrivate(key.privateKey);
}

// create an address from a path
function newAddress(path) {
  return newKeyRing(path).getAddress();
}

// harden a uint
function harden(uint) {
  assert(Number.isSafeInteger(uint) && uint >= 0);
  return (uint | HARDENED) >>> 0;
}
