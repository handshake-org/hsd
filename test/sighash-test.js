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
const Network = require('../lib/protocol/network');
const common = require('../lib/script/common');
const {HARDENED} = require('../lib/hd/common');
const random = require('bcrypto/lib/random');

const mnemonics = require('./data/mnemonic-english.json');
const phrase = mnemonics[0][1];
const mnemonic = Mnemonic.fromPhrase(phrase);

const rules = require('../lib/covenants/rules');
const {types} = rules;

Network.set('regtest');
const network = Network.get('regtest');

// sighash types
const SINGLEPRESIGNFINALIZE = common.hashType.SINGLEPRESIGNFINALIZE;

const ONE_HASH = Buffer.alloc(32, 0x00);
ONE_HASH[0] = 0x01;
const COIN_TYPE= network.keyPrefix.coinType;

describe('Signature Hashes', function () {
  describe('SINGLEPRESIGNFINALIZE', function () {
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
      assert('SINGLEPRESIGNFINALIZE' in common.hashType);
      assert(common.hashTypeByVal[SINGLEPRESIGNFINALIZE] === 'SINGLEPRESIGNFINALIZE');
    });

    it('should calculate the correct sighash for FINALIZE transaction', () => {
      const name = 'foo';
      const rawName = Buffer.from(name, 'ascii');
      const nameHash = rules.hashName(rawName);

      const mtx = new MTX();

      mtx.addOutput({
        value: 0,
        address: receives[0],
        covenant: {
          type: types.FINALIZE,
          items: [
            nameHash,
            b('0000dead'),         // height
            rawName,
            b('00'),               // flags
            b('dead0000'),         // claim height
            b('00dead00'),         // renewal count
            random.randomBytes(32) // block hash
          ]
        }
      });

      const coin = new Coin({
        height: 0,
        value: 0,
        address: addr,
        hash: ONE_HASH,
        index: 0,
        covenant: {
          type: types.TRANSFER,
          items: [
            nameHash,
            b('0000dead'), // height
            rawName
          ]
        }
      });

      mtx.addCoin(coin);

      const script = Script.fromPubkeyhash(keyring.getHash());
      const sighash = mtx.signatureHash(0, script, 0, SINGLEPRESIGNFINALIZE);

      // malleate transaction
      mtx.covenant(0).set(6, random.randomBytes(32));
      const malleated = mtx.signatureHash(0, script, 0, SINGLEPRESIGNFINALIZE);

      assert.bufferEqual(sighash, malleated);

      // malleate in unintended way
      mtx.covenant(0).set(0, random.randomBytes(32));
      const fail = mtx.signatureHash(0, script, 0, SINGLEPRESIGNFINALIZE);
      assert.notBufferEqual(sighash, fail);
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

function harden(uint) {
  assert(Number.isSafeInteger(uint) && uint >= 0);
  return (uint | HARDENED) >>> 0;
}

function b(str) {
  assert(typeof str === 'string');
  return Buffer.from(str, 'hex');
}
