'use strict';

const assert = require('bsert');
const blake2b = require('bcrypto/lib/blake2b');
const base58 = require('bcrypto/lib/encoding/base58');
const random = require('bcrypto/lib/random');
const bio = require('bufio');
const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const HDPrivateKey = require('../lib/hd/private');
const Mnemonic = require('../lib/hd/mnemonic');
const WalletDB = require('../lib/wallet/walletdb');
const Wallet = require('../lib/wallet/wallet');
const Account = require('../lib/wallet/account');
const wutils = require('./util/wallet');
const {nextEntry, fakeEntry} = require('./util/wallet');
const MemWallet = require('./util/memwallet');

/** @typedef {import('../lib/primitives/tx')} TX */

const mnemonics = require('./data/mnemonic-english.json');
const network = Network.get('main');

describe('Wallet Unit Tests', () => {
  describe('constructor', function() {
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

    it('should handle options.lookahead (account)', async () => {
      const wid = 0;
      const id = 'primary';
      const key = HDPrivateKey.generate();
      const accountKey = key.toPublic();
      const accountIndex = 0;
      const invalid = [
        -1000,
        -1,
        2 ** 32,
        2 ** 33
      ];

      const valid = [
        0,
        1,
        1000
      ];

      for (const lookahead of invalid) {
        assert.throws(() => {
          Account.fromOptions({}, {
            id,
            wid,
            accountKey,
            accountIndex,
            lookahead
          });
        });

        await assert.rejects(wdb.create({ lookahead }));
      }

      for (const lookahead of valid) {
        const wallet = await wdb.create({ lookahead });
        const account = await wallet.getAccount(0);
        assert.strictEqual(account.lookahead, lookahead);
      }

      // Wallet create will take a lot of time generating all lookaheads.
      valid.push(2 ** 32 - 1);

      for (const lookahead of valid) {
        const account = Account.fromOptions({}, {
          id,
          wid,
          accountKey,
          accountIndex,
          lookahead
        });
        assert.strictEqual(account.lookahead, lookahead);
      }
    });
  });

  describe('addBlock', function() {
    const ALT_SEED = 0xdeadbeef;

    /** @type {WalletDB} */
    let wdb;
    /** @type {Wallet} */
    let wallet;
    /** @type {MemWallet} */
    let memwallet;

    beforeEach(async () => {
      wdb = new WalletDB({
        network: network.type,
        memory: true
      });

      await wdb.open();
      wallet = wdb.primary;

      memwallet = new MemWallet({
        network
      });

      for (let i = 0; i < 10; i++) {
        const entry = nextEntry(wdb);
        await wdb.addBlock(entry, []);
      }
    });

    afterEach(async () => {
      await wdb.close();
      wdb = null;
    });

    // Move forward
    it('should progress with 10 block', async () => {
      const tip = await wdb.getTip();

      for (let i = 0; i < 10; i++) {
        const entry = nextEntry(wdb);
        const added = await wdb.addBlock(entry, []);
        assert.ok(added);
        assert.strictEqual(added.txs, 0);
        assert.strictEqual(added.filterUpdated, false);
        assert.equal(wdb.height, entry.height);
      }

      assert.strictEqual(wdb.height, tip.height + 10);
    });

    it('should return number of transactions added (owned)', async () => {
      const tip = await wdb.getTip();
      const wtx = await fakeWTX(wallet);
      const entry = nextEntry(wdb);
      const added = await wdb.addBlock(entry, [wtx]);

      assert.ok(added);
      assert.strictEqual(added.txs, 1);
      assert.strictEqual(added.filterUpdated, true);
      assert.equal(wdb.height, tip.height + 1);
    });

    it('should return number of transactions added (none)', async () => {
      const tip = await wdb.getTip();
      const entry = nextEntry(wdb);
      const added = await wdb.addBlock(entry, []);

      assert.ok(added);
      assert.strictEqual(added.txs, 0);
      assert.strictEqual(added.filterUpdated, false);
      assert.equal(wdb.height, tip.height + 1);
    });

    it('should fail to add block on unusual reorg', async () => {
      const tip = await wdb.getTip();
      const entry = nextEntry(wdb, ALT_SEED, ALT_SEED);

      // TODO: Detect sync chain is correct.
      const added = await wdb.addBlock(entry, []);
      assert.strictEqual(added, null);
      assert.strictEqual(wdb.height, tip.height);
    });

    // Same block
    it('should re-add the same block', async () => {
      const tip = await wdb.getTip();
      const entry = nextEntry(wdb);
      const wtx1 = await fakeWTX(wallet);
      const wtx2 = await fakeWTX(wallet);

      const added1 = await wdb.addBlock(entry, [wtx1]);
      assert.ok(added1);
      assert.strictEqual(added1.txs, 1);
      assert.strictEqual(added1.filterUpdated, true);
      assert.equal(wdb.height, tip.height + 1);

      // Same TX wont show up second time.
      const added2 = await wdb.addBlock(entry, [wtx1]);
      assert.ok(added2);
      assert.strictEqual(added2.txs, 0);
      assert.strictEqual(added2.filterUpdated, false);
      assert.equal(wdb.height, tip.height + 1);

      const added3 = await wdb.addBlock(entry, [wtx1, wtx2]);
      assert.ok(added3);
      assert.strictEqual(added3.txs, 1);
      // Both txs are using the same address.
      assert.strictEqual(added3.filterUpdated, false);
      assert.equal(wdb.height, tip.height + 1);
    });

    it('should ignore txs not owned by wallet', async () => {
      const tip = await wdb.getTip();
      const addr = memwallet.getReceive().toString(network);
      const tx = fakeTX(addr);

      const entry = nextEntry(wdb);
      const added = await wdb.addBlock(entry, [tx]);
      assert.ok(added);
      assert.strictEqual(added.txs, 0);
      assert.strictEqual(added.filterUpdated, false);

      assert.strictEqual(wdb.height, tip.height + 1);
    });

    // This should not happen, but there should be guards in place.
    it('should resync if the block is the same', async () => {
      const tip = await wdb.getTip();
      const entry = fakeEntry(tip.height, 0, ALT_SEED);

      // TODO: Detect sync chain is correct.
      const added = await wdb.addBlock(entry, []);
      assert.strictEqual(added, null);
    });

    // LOW BLOCKS
    it('should ignore blocks before tip', async () => {
      const tip = await wdb.getTip();
      const entry = fakeEntry(tip.height - 1);
      const wtx = await fakeWTX(wallet);

      // ignore low blocks.
      const added = await wdb.addBlock(entry, [wtx]);
      assert.strictEqual(added, null);
      assert.strictEqual(wdb.height, tip.height);
    });

    it('should sync chain blocks before tip on unusual low block reorg', async () => {
      const tip = await wdb.getTip();
      const entry = fakeEntry(tip.height - 1, 0, ALT_SEED);
      const wtx = await fakeWTX(wallet);

      // TODO: Detect sync chain is correct.

      // ignore low blocks.
      const added = await wdb.addBlock(entry, [wtx]);
      assert.strictEqual(added, null);
      assert.strictEqual(wdb.height, tip.height);
    });

    // HIGH BLOCKS
    it('should rescan for missed blocks', async () => {
      const tip = await wdb.getTip();
      // next + 1
      const entry = fakeEntry(tip.height + 2);

      let rescan = false;
      let rescanHash = null;

      wdb.client.rescanInteractive = async (hash) => {
        rescan = true;
        rescanHash = hash;
      };

      const added = await wdb.addBlock(entry, []);
      assert.strictEqual(added, null);

      assert.strictEqual(rescan, true);
      assert.bufferEqual(rescanHash, tip.hash);
    });
  });
});

/**
 * @param {String} addr
 * @returns {TX}
 */

function fakeTX(addr) {
  const tx = new MTX();
  tx.addInput(wutils.dummyInput());
  tx.addOutput({
    address: addr,
    value: 5460
  });
  return tx.toTX();
}

/**
 * @param {Wallet} wallet
 * @returns {Promise<TX>}
 */

async function fakeWTX(wallet) {
  const addr = await wallet.receiveAddress();
  return fakeTX(addr);
}
