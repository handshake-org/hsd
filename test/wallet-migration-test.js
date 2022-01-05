'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Network = require('../lib/protocol/network');
const WalletDB = require('../lib/wallet/walletdb');
const layouts = require('../lib/wallet/layout');
const WalletMigrator = require('../lib/wallet/migrations');
const {MigrateMigrations} = require('../lib/wallet/migrations');
const MigrationState = require('../lib/migrations/state');
const AbstractMigration = require('../lib/migrations/migration');
const {
  types,
  oldLayout
} = require('../lib/migrations/migrator');
const {migrationError} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

const NETWORK = 'regtest';
const network = Network.get(NETWORK);
const layout = layouts.wdb;

const wdbFlagError = (id) => {
  return 'Restart with'
    + ` \`hsd --wallet-migrate=${id}\` or \`hsw --migrate=${id}\`\n`
    + '(Full node may be required for rescan)';
};

describe('Wallet Migrations', function() {
  describe('General', function() {
    const location = testdir('migrate-wallet-ensure');
    const migrationsBAK = WalletMigrator.migrations;
    const lastMigrationID = Math.max(...Object.keys(migrationsBAK));

    const walletOptions = {
      prefix: location,
      memory: false,
      network: network
    };

    const getIDs = (min, max) => {
      const ids = new Set();
      for (let i = min; i <= max; i++)
        ids.add(i);

      return ids;
    };

    let walletDB, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);

      walletDB = new WalletDB(walletOptions);
      ldb = walletDB.db;

      WalletMigrator.migrations = migrationsBAK;
      await walletDB.open();
    });

    afterEach(async () => {
      await rimraf(location);
    });

    after(() => {
      WalletMigrator.migrations = migrationsBAK;
    });

    it('should initialize fresh walletdb migration state', async () => {
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, lastMigrationID);
      assert.strictEqual(state.nextMigration, lastMigrationID + 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await walletDB.close();
    });

    it('should not migrate pre-old migration state w/o flag', async () => {
      const b = ldb.batch();
      b.del(layout.M.encode());
      await b.write();
      await walletDB.close();

      const ids = getIDs(0, lastMigrationID);
      const expectedError = migrationError(WalletMigrator.migrations, [...ids],
        wdbFlagError(lastMigrationID));

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    // special case
    it('should not migrate from last old migration state w/o flag', async () => {
      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await walletDB.close();

      const ids = getIDs(0, lastMigrationID);
      ids.delete(1);
      const expectedError = migrationError(WalletMigrator.migrations, [...ids],
        wdbFlagError(lastMigrationID));

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);

      await ldb.close();
    });

    it('should upgrade and run new migration with flag', async () => {
      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      writeVersion(b, 'wallet', 0);
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = lastMigrationID;
      await walletDB.open();

      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'wallet');
      assert.strictEqual(version, walletDB.version);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, lastMigrationID);
      assert.strictEqual(state.nextMigration, lastMigrationID + 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await walletDB.close();
    });

    it('should only list last migration', async () => {
      const LastMigration = class extends AbstractMigration {
        async check() {
          return types.MIGRATE;
        }

        static info() {
          return {
            name: 'last migration',
            description: 'last migration'
          };
        }
      };

      const nextID = lastMigrationID + 1;

      await walletDB.close();
      WalletMigrator.migrations[nextID] = LastMigration;

      let error;
      try {
        await walletDB.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(WalletMigrator.migrations, [nextID],
        wdbFlagError(nextID));
      assert.strictEqual(error.message, expected);
    });
  });

  describe('Migrations #0 & #1', function() {
    const location = testdir('migrate-wallet-0-1');
    const migrationsBAK = WalletMigrator.migrations;
    const testMigrations = {
      0: WalletMigrator.MigrateMigrations,
      1: WalletMigrator.MigrateChangeAddress
    };

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

      WalletMigrator.migrations = testMigrations;
    });

    afterEach(async () => {
      if (ldb.opened)
        await ldb.close();
      await rimraf(location);
    });

    after(() => {
      WalletMigrator.migrations = migrationsBAK;
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

      const expectedError = migrationError(WalletMigrator.migrations, [0, 1],
        wdbFlagError(1));

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

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
      writeVersion(b, 'wallet', 0);
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = 1;
      await walletDB.open();

      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'wallet');
      assert.strictEqual(version, 1);

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

      const expectedError = migrationError(WalletMigrator.migrations, [0],
        wdbFlagError(1));

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

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

      walletDB.options.walletMigrate = 1;
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
      WalletMigrator.migrations = {
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

      const expectedError = migrationError(WalletMigrator.migrations, [0, 2],
        wdbFlagError(2));

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

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
      WalletMigrator.migrations = {
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
      writeVersion(b, 'wallet', 0);
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = 2;
      await walletDB.open();

      assert.strictEqual(migrated1, false);
      assert.strictEqual(migrated2, true);

      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'wallet');
      assert.strictEqual(version, 1);

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
    const migrationsBAK = WalletMigrator.migrations;

    const walletOptions = {
      prefix: location,
      memory: false,
      network: network
    };

    const ADD_CHANGE_DEPTH = 10;

    let walletDB, ldb;
    const missingAddrs = [];
    before(async () => {
      WalletMigrator.migrations = {};
      await fs.mkdirp(location);
    });

    after(async () => {
      WalletMigrator.migrations = migrationsBAK;
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

    it('should enable wallet change migration', () => {
      WalletMigrator.migrations = {
        0: WalletMigrator.MigrateChangeAddress
      };
    });

    it('should fail without migrate flag', async () => {
      const expectedError = migrationError(WalletMigrator.migrations, [0],
        wdbFlagError(0));

      await assert.rejects(async () => {
        await walletDB.open();
      }, {
        message: expectedError
      });

      await ldb.close();
    });

    it('should migrate with migrate flag', async () => {
      walletDB.options.walletMigrate = 0;

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

function writeVersion(b, name, version) {
    const value = Buffer.alloc(name.length + 4);

    value.write(name, 0, 'ascii');
    value.writeUInt32LE(version, name.length);

    b.put(layout.V.encode(), value);
}

function getVersion(data, name) {
  const error = 'version mismatch';

  if (data.length !== name.length + 4)
    throw new Error(error);

  if (data.toString('ascii', 0, name.length) !== name)
    throw new Error(error);

  return data.readUInt32LE(name.length);
}
