/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('../util/assert');
const common = require('../util/common');
const random = require('bcrypto/lib/random');
const {HDPrivateKey, Mnemonic, WalletDB, wallet} = require('../../lib/hsd');

describe('Wallet Unit Tests', () => {
  describe('constructor', () => {
    const xprv = common.readFile('xprv.utf8', 'utf8');
    const phrase = common.readFile('mnemonic-128bit.utf8', 'utf8');
    const mnemonic = new Mnemonic(phrase);
    let wdb;

    // m/44'/5355'/0'
    const xpub = ''
      + 'xpub6DBMpym6PM3qe7Ug7BwG6zo7dinMMjpk8nmb73czsjkzPTzfQ1d'
      + '5ZvqDea4uNmMVv1Y9DT6v17GuDL1x2km9FQuKqWMdnrDfRiDNrG1nTMr';

    // Open and close the WalletDB between tests because
    // each time wdb.create is called, it mutates properties
    // on the WalletDB instance
    beforeEach(async () => {
      wdb = new WalletDB();
      await wdb.open();
    });

    afterEach(async () => {
      await wdb.close();
      wdb = null;
    });

    it('should handle options.master', async () => {
      // Should fail due to invalid key.
      const errorMsg = 'Must create wallet with hd private key.';
      const assertMsg = 'Invalid HD.PrivateKey should throw.';
      assert.asyncThrows(async () => {
        await wdb.create({ master: Buffer.from('00', 'hex') });
      }, errorMsg, assertMsg);

      {
        // Should instatiate from String.
        const walletdb = await wdb.create({ master: xprv });
        const want = xprv;
        const got = walletdb.master.key.xprivkey();
        assert.deepEqual(got, want, 'Failed to instantiate from String.');
      }

      {
        // Should instatiate from HD.PrivateKey.
        const opt = { master: HDPrivateKey.fromMnemonic(mnemonic) };
        const walletdb = await wdb.create(opt);
        const want = xprv;
        const got = walletdb.master.key.xprivkey();
        assert.deepEqual(got, want, 'Failed to instatiate from HD.PrivateKey.');
      }
    });

    it('should handle options.mnemonic', async () => {
      // Should instantiate from HD.Mnemonic.
      const walletdb = await wdb.create({ mnemonic: phrase });
      const want = phrase;
      const got = walletdb.master.mnemonic.phrase;
      assert.deepEqual(got, want, 'Phrase mismatch.');
    });

    it('should handle options.wid', async () => {
      {
        // Wallet ids increment by one staring at 1 each
        // time that a new wallet is created
        for (let i = 0; i < 3; i++) {
          const walletdb = await wdb.create();
          const want = i + 1;
          const got = walletdb.wid;
          assert.deepEqual(got, want, 'Wallet ID mismatch.');
        }
      }

      {
        // fromOptions should appropriately set value
        const w = wallet.Wallet.fromOptions(wdb, { wid: 2 });
        const want = 2;
        const got = w.wid;
        assert.equal(got, want, 'Wallet ID mismatch.');
      }
      {
        // Wallet ids can only be uint32s
        assert.throws(() => wallet.Wallet.fromOptions(wdb, { wid: 2**32 }));
        assert.throws(() => wallet.Wallet.fromOptions(wdb, { wid: -1 }));
      }
    });

    it('should handle options.id', async () => {
      const names = [
        // id, expected
        ['foo', true],            // normal name
        ['1234567', true],        // all numbers
        ['123abc', true],         // mix of letters/numbers
        ['foo-bar', true],        // allow dash
        ['my fav wallet', false], // spaces
        [1234567, false],         // wrong type
        ['__proto__', false],     // illegal keyword
        [' ', false],             // whitespace
        ['.hsd', false],          // . prefix
        ['hsd.', false],          // . suffix
        ['a'.repeat(40), true],   // max length
        ['a'.repeat(41), false]   // 1 longer than max length
      ];

      for (const [id, expected] of names) {
        if (expected === false) {
          const fn = async () => await wdb.create({ id });
          assert.asyncThrows(fn, 'Bad wallet ID.');
        } else {
          const walletdb = await wdb.create({ id });

          const got = walletdb.id;
          const want = id;
          assert.equal(got, want);
        }
      }
    });

    it('should handle options.watchOnly', async () => {
      {
        // Should create a WalletDB with a watch only account
        // and be able to recover the accountKey
        const walletdb = await wdb.create({
          watchOnly: true,
          accountKey: xpub
        });

        {
          const got = walletdb.watchOnly;
          const want = true;
          assert.equal(got, want);
        }

        {
          const key = await walletdb.accountKey();
          const got = key.xpubkey();
          const want = xpub;
          assert.equal(got, want);
        }
      }

      {
        // Requires an accountKey to instantiate
        const fn = async () => await wdb.create({ watchOnly: true });
        assert.asyncThrows(fn, 'Must add HD public keys to watch only wallet.');
      }

      {
        // Wrong type should throw assertion error
        const fn = async () => await wdb.create({ watchOnly: 'foo' });
        assert.asyncThrows(fn, 'Assertion failed.');
      }
    });

    it('should handle options.accountDepth', async () => {
      {
        // fromOptions should appropriately set value
        const w = wallet.Wallet.fromOptions(wdb, { accountDepth: 2 });
        const got = w.accountDepth;
        const want = 2;
        assert.equal(got, want, 'Account Depth mismatch.');
      }

      {
        // WalletDB increments the account depth each time after
        // creating an account
        for (let i = 0; i < 3; i++) {
          const walletdb = await wdb.create({ accountDepth: i });
          const got = walletdb.accountDepth;
          const want = i + 1;
          assert.equal(got, want);
        }
      }

      {
        // Account Depth can only be uint32s
        const overflow = { accountDepth: 2**32 };
        assert.throws(() => wallet.Wallet.fromOptions(wdb, overflow));
        const underflow = { accountDepth: -1 };
        assert.throws(() => wallet.Wallet.fromOptions(wdb, underflow));
      }
    });

    it('should handle options.token', async () => {
      {
        const token = random.randomBytes(32);
        const walletdb = await wdb.create({ token });

        const got = walletdb.token;
        const want = token;
        assert.bufferEqual(got, want);
      }
      {
        // The token must be 32 bytes
        const token = random.randomBytes(16);
        const fn = async () => await wdb.create({ token });
        assert.asyncThrows(fn, 'Assertion failed.');
      }
    });

    it('should handle options.tokenDepth', async () => {
      {
        // Token depth should be set based on the input value
        const walletdb = await wdb.create({ tokenDepth: 10 });
        assert.equal(walletdb.tokenDepth, 10);
      }

      {
        // Token depth can only be uint32s
        const overflow = { tokenDepth: 2**32 };
        assert.throws(() => wallet.Wallet.fromOptions(wdb, overflow));
        const underflow = { tokenDepth: -1 };
        assert.throws(() => wallet.Wallet.fromOptions(wdb, underflow));
      }
    });
  });
});
