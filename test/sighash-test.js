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
const {
  ALL,
  SINGLEREVERSE,
  NOINPUT,
  ANYONECANPAY
} = common.hashType;

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;
const COIN_TYPE = network.keyPrefix.coinType;

describe('Signature Hashes', function () {
  const path = [harden(44), harden(5353), harden(0), 0, 0];
  const keyring = newKeyRing(path);
  const addr = keyring.getAddress();
  const script = Script.fromPubkeyhash(keyring.getHash());

  // generate receive addresses
  const receives = [
    newAddress([harden(44), harden(COIN_TYPE), harden(1), 0, 0]),
    newAddress([harden(44), harden(COIN_TYPE), harden(2), 0, 0]),
    newAddress([harden(44), harden(COIN_TYPE), harden(3), 0, 0])
  ];

  describe('SINGLEREVERSE', function () {
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

  describe('NOINPUT', function () {
    // We can spend this coin.
    const coin1 = new Coin({
      address: addr,
      hash: Buffer.alloc(32, 0x01),
      index: 1,
      value: 50000
    });

    // We can spend this coin,
    // But it has a different outpoint.
    const coin2 = new Coin({
      address: addr,
      hash: Buffer.alloc(32, 0x02),
      index: 2,
      value: 50000
    });

    it('should exist in common', () => {
      assert('NOINPUT' in common.hashType);
      assert(common.hashTypeByVal[NOINPUT] === 'NOINPUT');
    });

    it('should create same sighash, but doesn\'t', () => {
      const mtx1 = new MTX();
      mtx1.addOutput(receives[0], 40000);
      mtx1.addCoin(coin1);
      const sighash1 = mtx1.signatureHash(0, script, coin1.value, NOINPUT);

      const mtx2 = new MTX();
      mtx2.addOutput(receives[0], 40000);
      mtx2.addCoin(coin2);
      const sighash2 = mtx2.signatureHash(0, script, coin2.value, NOINPUT);

      // This fails because signatureHash() STILL COMMITS to the prevout
      // and sequence of each input EVEN THOUGH the separate commitment
      // to "this input's data" is cleared out by SIGHASH_NOINPUT
      assert.notBufferEqual(sighash1, sighash2);
    });

    it('should create different sighash using ANYONECANPAY', () => {
      const mtx1 = new MTX();
      mtx1.addOutput(receives[0], 40000);
      mtx1.addCoin(coin1);
      const sighash1 = mtx1.signatureHash(0, script, coin1.value, ANYONECANPAY);

      const mtx2 = new MTX();
      mtx2.addOutput(receives[0], 40000);
      mtx2.addCoin(coin2);
      const sighash2 = mtx2.signatureHash(0, script, coin2.value, ANYONECANPAY);

      // This fails for the opposite reason as NOINPUT.
      // This time we are wiping out the prevouts and sequences of all the inputs,
      // but we still commit to THIS input's outpoint and sequence.
      assert.notBufferEqual(sighash1, sighash2);
    });

    it('should create same sighash using NOINPUT | ANYONECANPAY', () => {
      const mtx1 = new MTX();
      mtx1.addOutput(receives[0], 40000);
      mtx1.addCoin(coin1);
      const sighash1 = mtx1.signatureHash(
        0,
        script,
        coin1.value,
        NOINPUT | ANYONECANPAY
      );

      const mtx2 = new MTX();
      mtx2.addOutput(receives[0], 40000);
      mtx2.addCoin(coin2);
      const sighash2 = mtx2.signatureHash(
        0,
        script,
        coin1.value,
        NOINPUT | ANYONECANPAY
      );

      // Finally we can malleate the input to this transaction without
      // invalidating the signature. All prevouts and sequences are nullified
      // before commitment.
      assert.bufferEqual(sighash1, sighash2);
    });

    it('should create different hash for different sequence', () => {
      const mtx = new MTX();
      mtx.addOutput(receives[0], 40000);
      mtx.addCoin(coin1);
      const sighash1 = mtx.signatureHash(
        0,
        script,
        coin1.value,
        ANYONECANPAY
      );
      mtx.input(0).sequence = 0xfffffffe;
      const sighash2 = mtx.signatureHash(
        0,
        script,
        coin1.value,
        ANYONECANPAY
      );

      assert.notBufferEqual(sighash1, sighash2);
    });

    it('should give same hash for different sequence values', () => {
      const mtx = new MTX();
      mtx.addOutput(receives[0], 40000);
      mtx.addCoin(coin1);
      const sighash1 = mtx.signatureHash(
        0,
        script,
        coin1.value,
        NOINPUT | ANYONECANPAY
      );
      mtx.input(0).sequence = 0xfffffffe;
      const sighash2 = mtx.signatureHash(
        0,
        script,
        coin1.value,
        NOINPUT | ANYONECANPAY
      );
      // Normally sequence value of input is commited to the sighash
      // However due to how NOINPUT is implemented, the sequence value
      // both at the time of signing and verifying the signature is
      // set to 0xffffffff. This means that the signature is valid
      // for any sequence value.
      // This deviates away from the orignal implementation of NOINPUT
      // in the eltoo paper (and the current implementation at BIP-0118).

      assert.bufferEqual(sighash1, sighash2);
    });

    it('signature is valid for any sequence', () => {
      const mtx = new MTX();
      mtx.addOutput(receives[0], 70000);
      const coin = new Coin({
        height: 0,
        value: 70000,
        address: addr,
        hash: ONE_HASH,
        index: 0
      });

      mtx.addCoin(coin);
      mtx.input(0).sequence = 0xaaaaaaaa;

      mtx.sign(
        keyring,
        ALL | NOINPUT | ANYONECANPAY
      );

      assert(mtx.verify());
      // A malacious user can simply change the sequence of the input and spend
      // it rendering relative timelocks uneffective, use nLockTime to enforce
      // timelocks.
      mtx.input(0).sequence = 0xffffffff;
      assert(mtx.verify());
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
