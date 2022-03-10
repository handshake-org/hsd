'use strict';

const assert = require('bsert');
const blake2b = require('bcrypto/lib/blake2b');
const base58 = require('bcrypto/lib/encoding/base58');
const random = require('bcrypto/lib/random');
const bio = require('bufio');
const {
  HDPrivateKey,
  Mnemonic,
  WalletDB,
  Network,
  wallet: { Wallet }
} = require('../lib/hsd');

const mnemonics = require('./data/mnemonic-english.json');
const network = Network.get('main');

describe('Wallet Unit Tests', () => {
  describe('constructor', () => {
    // abandon, abandon... about
    const phrase = mnemonics[0][1];
    const passphrase = mnemonics[0][2];
    const mnemonic = new Mnemonic(phrase, passphrase);
    const hdprivkey = HDPrivateKey.fromMnemonic(mnemonic);
    const xprv = hdprivkey.xprivkey();

    let wdb;

    // m/44'/5355'/0'
    const xpub = ''
      + 'xpub6DBMpym6PM3qe7Ug7BwG6zo7dinMMjpk8nmb73czsjkzPTzfQ1d'
      + '5ZvqDea4uNmMVv1Y9DT6v17GuDL1x2km9FQuKqWMdnrDfRiDNrG1nTMr';

    // Open and close the WalletDB between tests because
    // each time wdb.create is called, it mutates properties
    // on the WalletDB instance
    beforeEach(async () => {
      wdb = new WalletDB({ network: network.type });
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

      await assert.rejects(async () => {
        await wdb.create({ master: Buffer.from('00', 'hex') });
      }, errorMsg, assertMsg);

      {
        // Should instatiate from String.
        const wallet = await wdb.create({ master: xprv });
        const want = xprv;
        const got = wallet.master.key.xprivkey();
        assert.deepEqual(got, want, 'Failed to instantiate from String.');
      }

      {
        // Should instatiate from HD.PrivateKey.
        const opt = { master: HDPrivateKey.fromMnemonic(mnemonic) };
        const wallet = await wdb.create(opt);
        const want = xprv;
        const got = wallet.master.key.xprivkey();
        assert.deepEqual(got, want, 'Failed to instatiate from HD.PrivateKey.');
      }
    });

    it('should handle options.mnemonic', async () => {
      // Should instantiate from HD.Mnemonic.
      const wallet = await wdb.create({ mnemonic: phrase });
      const want = phrase;
      const got = wallet.master.mnemonic.phrase;
      assert.deepEqual(got, want, 'Phrase mismatch.');
    });

    it('should handle options.wid', async () => {
      {
        // Wallet ids increment by one staring at 1 each
        // time that a new wallet is created
        for (let i = 0; i < 3; i++) {
          const wallet = await wdb.create();
          const want = i + 1;
          const got = wallet.wid;
          assert.deepEqual(got, want, 'Wallet ID mismatch.');
        }
      }

      {
        // fromOptions should appropriately set value
        const w = Wallet.fromOptions(wdb, { wid: 2 });
        const want = 2;
        const got = w.wid;
        assert.equal(got, want, 'Wallet ID mismatch.');
      }
      {
        // Wallet ids can only be uint32s
        assert.throws(() => Wallet.fromOptions(wdb, { wid: 2**32 }));
        assert.throws(() => Wallet.fromOptions(wdb, { wid: -1 }));
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
          await assert.rejects(fn, 'Bad wallet ID.');
        } else {
          const wallet = await wdb.create({ id });

          const got = wallet.id;
          const want = id;
          assert.equal(got, want);
        }
      }

      {
        // Auto generated id matches schema
        // BLAKE2b(m/44->public|magic, 20)
        // of `0x03be04` to base58
        const wallet = await wdb.create({ mnemonic });
        // hdprivkey is derived from the mnemonic
        const key = hdprivkey.derive(44);

        const bw = bio.write(37);
        bw.writeBytes(key.publicKey);
        bw.writeU32(network.magic);

        const hash = blake2b.digest(bw.render(), 20);

        const b58 = bio.write(23);
        b58.writeU8(0x03);
        b58.writeU8(0xbe);
        b58.writeU8(0x04);
        b58.writeBytes(hash);

        const want = base58.encode(b58.render());
        const got = wallet.id;
        assert.equal(got, want);
      }
    });

    it('should handle auto generation of tokens', async () => {
      const wallet = await wdb.create({ mnemonic });
      // hdprivkey is derived from the mnemonic
      const key = hdprivkey.derive(44, true);

      // Always use the same privateKey
      function getToken(nonce) {
        const bw = bio.write(36);
        bw.writeBytes(key.privateKey);
        bw.writeU32(nonce);
        return blake2b.digest(bw.render());
      }

      // Assert that the nonce is generated correctly
      // for different integers
      for (let i = 0; i < 3; i++) {
        const nonce = i;
        const want = getToken(nonce);
        const got = wallet.getToken(nonce);
        assert.bufferEqual(want, got);
      }

      {
        // Tokens can only be generated safely for
        // up through the MAX_SAFE_INTEGER
        const nonce = Number.MAX_SAFE_INTEGER + 1;
        const msg = '\'num\' must be a(n) integer';
        assert.throws(() => wallet.getToken(nonce), msg);
      }
    });

    it('should handle options.watchOnly', async () => {
      {
        // Should create a Wallet with a watch only account
        // and be able to recover the accountKey
        const wallet = await wdb.create({
          watchOnly: true,
          accountKey: xpub
        });

        {
          const got = wallet.watchOnly;
          const want = true;
          assert.equal(got, want);
        }

        {
          const key = await wallet.accountKey();
          const got = key.xpubkey();
          const want = xpub;
          assert.equal(got, want);
        }
      }

      {
        // Requires an accountKey to instantiate
        const fn = async () => await wdb.create({ watchOnly: true });
        await assert.rejects(fn, 'Must add HD public keys to watch only wallet.');
      }

      {
        // Wrong type should throw assertion error
        const fn = async () => await wdb.create({ watchOnly: 'foo' });
        await assert.rejects(fn, 'Assertion failed.');
      }
    });

    it('should handle options.accountDepth', async () => {
      {
        // fromOptions should appropriately set value
        const w = Wallet.fromOptions(wdb, { accountDepth: 2 });
        const got = w.accountDepth;
        const want = 2;
        assert.equal(got, want, 'Account Depth mismatch.');
      }

      {
        // Wallet increments the account depth each time after
        // creating an account
        for (let i = 0; i < 3; i++) {
          const wallet = await wdb.create({ accountDepth: i });
          const got = wallet.accountDepth;
          const want = i + 1;
          assert.equal(got, want);
        }
      }

      {
        // Account Depth can only be uint32s
        const overflow = { accountDepth: 2**32 };
        assert.throws(() => Wallet.fromOptions(wdb, overflow));
        const underflow = { accountDepth: -1 };
        assert.throws(() => Wallet.fromOptions(wdb, underflow));
      }
    });

    it('should handle options.token', async () => {
      {
        const token = random.randomBytes(32);
        const wallet = await wdb.create({ token });

        const got = wallet.token;
        const want = token;
        assert.bufferEqual(got, want);
      }
      {
        // The token must be 32 bytes
        const token = random.randomBytes(16);
        const fn = async () => await wdb.create({ token });
        await assert.rejects(fn, 'Assertion failed.');
      }
    });

    it('should handle options.tokenDepth', async () => {
      {
        // Token depth should be set based on the input value
        const wallet = await wdb.create({ tokenDepth: 10 });
        assert.equal(wallet.tokenDepth, 10);
      }

      {
        // Token depth can only be uint32s
        const overflow = { tokenDepth: 2**32 };
        assert.throws(() => Wallet.fromOptions(wdb, overflow));
        const underflow = { tokenDepth: -1 };
        assert.throws(() => Wallet.fromOptions(wdb, underflow));
      }
    });
  });
});
