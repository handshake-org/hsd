/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Network = require('../lib/protocol/network');
const WalletDB = require('../lib/wallet/walletdb');
const layouts = require('../lib/wallet/layout');
const WalletMigrations = require('../lib/wallet/migrations');
const {MigrateMigrations} = require('../lib/wallet/migrations');
const MigrationState = require('../lib/migrations/state');
const {
  AbstractMigration,
  types,
  oldLayout
} = require('../lib/migrations/migrations');
const {migrationError} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

const NETWORK = 'regtest';
const network = Network.get(NETWORK);
const layout = layouts.wdb;

const WDB_FLAG_ERROR = '`hsd --wallet-migrate` or `hsw --migrate`\n' +
  '(Full node may be required for rescan)';

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

    it('should not migrate pre-old migration state w/o flag', async () => {
      await walletDB.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      await b.write();
      await walletDB.close();

      const expectedError = migrationError(WalletMigrations.migrations, [0, 1],
        WDB_FLAG_ERROR);

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should migrate pre-old migration state with flag', async () => {
      await walletDB.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = true;
      await walletDB.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await walletDB.close();
    });

    it('should not migrate from last old migration state w/o flag', async () => {
      await walletDB.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await walletDB.close();

      const expectedError = migrationError(WalletMigrations.migrations, [0],
        WDB_FLAG_ERROR);

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);

      await ldb.close();
    });

    it('should not migrate from last old migration state with flag', async () => {
      await walletDB.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = true;
      await walletDB.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await walletDB.close();
    });

    it('should not upgrade and run new migration w/o flag', async () => {
      WalletMigrations.migrations = {
        0: MigrateMigrations,
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

      const expectedError = migrationError(WalletMigrations.migrations, [0, 2],
        WDB_FLAG_ERROR);

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should upgrade and run new migration with flag', async () => {
      let migrated1 = false;
      let migrated2 = false;
      WalletMigrations.migrations = {
        0: MigrateMigrations,
        1: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }

          async migrate() {
            migrated1 = true;
          }
        },
        2: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }

          async migrate() {
            migrated2 = true;
          }
        }
      };

      await walletDB.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = true;
      await walletDB.open();

      assert.strictEqual(migrated1, false);
      assert.strictEqual(migrated2, true);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 3);
      assert.strictEqual(state.lastMigration, 2);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await walletDB.close();
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

      const expectedError = migrationError(WalletMigrations.migrations, [0, 1],
        WDB_FLAG_ERROR);

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
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
