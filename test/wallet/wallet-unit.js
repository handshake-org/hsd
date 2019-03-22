/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('../util/assert');
const common = require('../util/common');
const { HDPrivateKey, Mnemonic, WalletDB } = require('../../lib/hsd');

describe('Wallet Unit Tests', () => {
  describe('constructor', () => {
    const xprv = common.readFile('xprv.utf8', 'utf8');
    const phrase = common.readFile('mnemonic-128bit.utf8', 'utf8');
    const mnemonic = new Mnemonic(phrase);
    const wdb = new WalletDB();

    before(async () => {
      await wdb.open();
    });

    after(async () => {
      await wdb.close();
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
        const wallet = await wdb.create({ master: xprv });
        const want = xprv;
        const got = wallet.master.key.xprivkey();
        assert.deepEqual(got, want, 'Failed to instantiate from String.');
      }

      {
        // Should instatiate from HD.PrivateKey.
        const wallet = await wdb.create({ master: HDPrivateKey.fromMnemonic(mnemonic) });
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

    it('should handle options.wid', ($) => {
      $.skip();
    });

    it('should handle options.id', ($) => {
      $.skip();
    });

    it('should handle options.watchOnly', ($) => {
      $.skip();
    });

    it('should handle options.accountDepth', ($) => {
      $.skip();
    });

    it('should handle options.token', ($) => {
      $.skip();
    });

    it('should handle options.tokenDepth', ($) => {
      $.skip();
    });
  });
});
