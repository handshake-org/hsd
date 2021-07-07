/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Network = require('../lib/protocol/network');
const WalletDB = require('../lib/wallet/walletdb');
const layouts = require('../lib/wallet/layout');
const WalletMigrations = require('../lib/wallet/migrations');
const MigrationState = require('../lib/migrations/state');
const {
  AbstractMigration,
  types,
  oldLayout
} = require('../lib/migrations/migrations');
const {rimraf, testdir} = require('./util/common');

const NETWORK = 'regtest';
const network = Network.get(NETWORK);
const layout = layouts.wdb;

describe('Wallet Migrations', function() {
  describe('Migration State', function() {
    const location = testdir('migrate-wallet-ensure');
    const migrationsBAK = WalletMigrations.migrations;

    const walletOptions = {
      prefix: location,
      memory: false,
      network: network
    };

    let walletDB, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);

      walletDB = new WalletDB(walletOptions);
      ldb = walletDB.db;

      WalletMigrations.migrations = migrationsBAK;
    });

    afterEach(async () => {
      if (ldb.opened)
        await ldb.close();
      await rimraf(location);
    });

    it('should initialize fresh walletdb migration state', async () => {
      await walletDB.open();

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);

      await walletDB.close();
    });

    it('should migrate pre-old migration state', async () => {
      await walletDB.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      await b.write();
      await walletDB.close();

      let error;
      try {
        await walletDB.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'WalletDB must throw an error.');
      assert.strictEqual(error.message, 'Database needs migration.');

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should not migrate from last old migration state', async () => {
      await walletDB.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await walletDB.close();

      await walletDB.open();

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);

      await walletDB.close();
    });

    it('should migrate from last old migration state', async () => {
      WalletMigrations.migrations = {
        1: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }
        },
        2: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }
        }
      };

      await walletDB.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await walletDB.close();

      let error;
      try {
        await walletDB.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'WalletDB must throw an error.');
      assert.strictEqual(error.message, 'Database needs migration.');

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });
  });

  describe('Migrate change address (integration)', function() {
    const location = testdir('wallet-change');
    const migrationsBAK = WalletMigrations.migrations;

    const walletOptions = {
      prefix: location,
      memory: false,
      network: network
    };

    const ADD_CHANGE_DEPTH = 10;

    let walletDB, ldb;
    const missingAddrs = [];
    before(async () => {
      WalletMigrations.migrations = {};
      await fs.mkdirp(location);
    });

    after(async () => {
      WalletMigrations.migrations = migrationsBAK;
      await rimraf(location);
    });

    beforeEach(async () => {
      walletDB = new WalletDB(walletOptions);
      ldb = walletDB.db;
    });

    afterEach(async () => {
      if (ldb.opened)
        await ldb.close();
    });

    it('should set incorrect walletdb state', async () => {
      await walletDB.open();

      const wallet = walletDB.primary;
      const account = await wallet.getAccount(0);

      for (let i = 0; i < ADD_CHANGE_DEPTH; i++) {
        const {changeDepth, lookahead} = account;
        const changeKey = account.deriveChange(changeDepth + lookahead);
        missingAddrs.push(changeKey.getAddress());
        account.changeDepth += 1;
      }

      const b = ldb.batch();
      walletDB.saveAccount(b, account);
      await b.write();
      await walletDB.close();
    });

    it('should have missing addresses', async () => {
      await walletDB.open();
      const wallet = walletDB.primary;

      for (const addr of missingAddrs) {
        const hasAddr = await wallet.hasAddress(addr);
        assert.strictEqual(hasAddr, false);
      }

      await walletDB.close();
    });

    it('should fail without migrate flag', async () => {
      WalletMigrations.migrations = migrationsBAK;

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: 'Database needs migration.'
      });
    });

    it('should migrate with migrate flag', async () => {
      WalletMigrations.migrations = migrationsBAK;
      walletDB.options.walletMigrate = true;

      let rescan = false;
      walletDB.scan = () => {
        rescan = true;
      };

      await walletDB.open();
      const wallet = walletDB.primary;

      for (const addr of missingAddrs) {
        const hasAddr = await wallet.hasAddress(addr);
        assert.strictEqual(hasAddr, true);
      }

      assert.strictEqual(rescan, true);

      await walletDB.close();
    });
  });
});
