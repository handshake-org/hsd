'use strict';

const assert = require('bsert');
const fs = require('bfile');
const random = require('bcrypto/lib/random');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const Coin = require('../lib/primitives/coin');
const WalletDB = require('../lib/wallet/walletdb');
const layouts = require('../lib/wallet/layout');
const TXDB = require('../lib/wallet/txdb');
const {Credit} = TXDB;
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

class MockMigration extends AbstractMigration {
  async check() {
    return types.MIGRATE;
  }

  async migrate(_, pending) {
    return pending;
  }
}

const mockMigrations = {
  0: MigrateMigrations,
  1: class Migration1 extends MockMigration {
    static info() {
      return {
        name: 'mock migration 1',
        description: 'desc mock migration 1'
      };
    }
  },
  2: class Migration2 extends MockMigration {
    static info() {
      return {
        name: 'mock migration 2',
        description: 'desc mock migration 2'
      };
    }
  }
};

describe('Wallet Migrations', function() {
  describe('General', function() {
    const location = testdir('migrate-wallet-ensure');
    const migrationsBAK = WalletMigrator.migrations;
    WalletMigrator.migrations = mockMigrations;
    const lastMigrationID = Math.max(...Object.keys(mockMigrations));

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

      WalletMigrator.migrations = mockMigrations;

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
      walletDB.version = 1;
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
      network
    };

    let walletDB, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);

      walletDB = new WalletDB(walletOptions);
      walletDB.version = 1;
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

      let rollback = false;
      walletDB.rollback = () => {
        rollback = true;
      };

      await walletDB.open();
      const wallet = walletDB.primary;

      for (const addr of missingAddrs) {
        const hasAddr = await wallet.hasAddress(addr);
        assert.strictEqual(hasAddr, true);
      }

      assert.strictEqual(rollback, true);

      await walletDB.close();
    });
  });

  describe('Migrate account lookahead (integration)', function () {
    const location = testdir('wallet-change');
    const migrationsBAK = WalletMigrator.migrations;
    const TEST_LOOKAHEAD = 150;

    const walletOptions = {
      prefix: location,
      memory: false,
      network: network
    };

    let walletDB, ldb;
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

    const newToOld = (raw) => {
      // flags, type, m, n, receiveDepth, changeDepth
      const preLen = 1 + 1 + 1 + 1 + 4 + 4;
      const pre = raw.slice(0, preLen);
      const lookahead = raw.slice(preLen, preLen + 4);
      const post = raw.slice(preLen + 4);

      return Buffer.concat([
        pre,
        Buffer.alloc(1, lookahead[0]),
        post
      ]);
    };

    it('should write old account record', async () => {
      const setupLookahead = async (wallet, n) => {
        const accounts = [];
        let b;

        for (let i = 0; i < 3; i++)
          accounts.push(await wallet.getAccount(i));

        b = ldb.batch();
        for (let i = 0; i < 3; i++)
          await accounts[i].setLookahead(b, n + i);
        await b.write();

        b = ldb.batch();
        for (let i = 0; i < 3; i++) {
          const encoded = newToOld(accounts[i].encode(), n + i);
          b.put(layout.a.encode(wallet.wid, i), encoded);
        }

        // previous version
        walletDB.writeVersion(b, 1);
        await b.write();
      };

      await walletDB.open();

      const wallet = walletDB.primary;
      await wallet.createAccount({});
      await wallet.createAccount({});

      await setupLookahead(wallet, TEST_LOOKAHEAD + 0);

      const wallet2 = await walletDB.create({});
      await wallet2.createAccount({});
      await wallet2.createAccount({});
      await setupLookahead(wallet2, TEST_LOOKAHEAD + 10);

      await walletDB.close();
    });

    it('should enable wallet account lookahead migration', () => {
      WalletMigrator.migrations = {
        0: WalletMigrator.MigrateAccountLookahead
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
      const checkLookahead = async (wallet, n) => {
        for (let i = 0; i < 3; i++) {
          const account = await wallet.getAccount(i);
          assert.strictEqual(account.lookahead, n + i);
        }
      };

      walletDB.options.walletMigrate = 0;

      await walletDB.open();
      const wallet = walletDB.primary;
      const wallet2 = await walletDB.get(1);
      await checkLookahead(wallet, TEST_LOOKAHEAD + 0);
      await checkLookahead(wallet2, TEST_LOOKAHEAD + 10);
      await walletDB.close();
    });
  });

  describe('Migrate txdb  (integration)', function() {
    const location = testdir('walet-txdb-refresh');
    const migrationsBAK = WalletMigrator.migrations;

    const walletOptions = {
      prefix: location,
      memory: false,
      network
    };

    const balanceEquals = (balance, expected) => {
      assert.strictEqual(balance.tx, expected.tx);
      assert.strictEqual(balance.coin, expected.coin);
      assert.strictEqual(balance.unconfirmed, expected.unconfirmed);
      assert.strictEqual(balance.confirmed, expected.confirmed);
      assert.strictEqual(balance.ulocked, expected.ulocked);
      assert.strictEqual(balance.clocked, expected.clocked);
    };

    let walletDB, ldb;
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

    it('should write some coins w/o updating balance', async () => {
      // generate credits for the first 10 addresses stored on initialization.
      await walletDB.open();

      const wallet = walletDB.primary;

      await wallet.createAccount({
        name: 'alt'
      });

      const randomCoin = (options) => {
        const coin = new Coin({
          version: 1,
          coinbase: false,
          hash: random.randomBytes(32),
          index: 0,
          ...options
        });

        if (options.covenantType != null)
          coin.covenant.type = options.covenantType;

        return coin;
      };

      const coins = [];
      const spentCoins = [];

      const addCoin = (addr, spent, confirmed, bid) => {
        const list = spent ? spentCoins : coins;

        const coin = randomCoin({
          value: 1e6,
          address: addr.getAddress(),
          height: confirmed ? 1 : -1
        });

        if (bid)
          coin.covenant.type = rules.types.BID;

        list.push(coin);
      };

      for (let i = 0; i < 5; i++) {
        const addr0 = await wallet.createReceive(0);
        const addr1 = await wallet.createReceive(1);

        // 5 NONE coins to default account, of each type:
        //  confirmed spent,
        //  unconfirmed spent,
        //  unconfirmed unspent,
        //  confirmed unspent

        // confirmed += 1e6 * 5;
        // unconfirmed += 1e6 * 5;
        // coin += 5;
        addCoin(addr0, false, true);

        // confirmed += 1e6 * 5;
        // unconfirmed += 0;
        // coin += 0;
        addCoin(addr0, true, true);

        // confirmed += 0;
        // unconfirmed += 0;
        // coin += 0;
        addCoin(addr0, true, false);

        // confirmed += 0;
        // unconfirmed += 1e6 * 5;
        // coin += 5;
        addCoin(addr0, false, false);

        // 5 BID coins to alt account, of each type:
        //  confirmed spent,
        //  unconfirmed spent,
        //  unconfirmed unspent,
        //  confirmed unspent

        // confirmed += 1e6 * 5;
        // unconfirmed += 1e6 * 5;
        // coin += 5;
        // locked += 1e6 * 5;
        // unlocked += 1e6 * 5;
        addCoin(addr1, false, true, true);

        // confirmed += 1e6 * 5;
        // unconfirmed += 0;
        // coin += 0;
        // locked += 1e6 * 5;
        // unlocked += 0;
        addCoin(addr1, true, true, true);

        // confirmed += 0;
        // unconfirmed += 0;
        // coin += 0;
        // locked += 0;
        // unlocked += 0;
        addCoin(addr1, true, false, true);

        // confirmed += 0;
        // unconfirmed += 1e6 * 5;
        // coin += 5;
        // locked += 0;
        // unlocked += 1e6 * 5;
        addCoin(addr1, false, false, true);
      }

      const batch = wallet.txdb.bucket.batch();
      for (const coin of coins) {
        const path = await wallet.txdb.getPath(coin);
        const credit = new Credit(coin);
        await wallet.txdb.saveCredit(batch, credit, path);
      }

      for (const coin of spentCoins) {
        const path = await wallet.txdb.getPath(coin);
        const credit = new Credit(coin, true);
        await wallet.txdb.saveCredit(batch, credit, path);
      }

      await batch.write();

      await walletDB.close();
    });

    it('should have incorrect balance before migration', async () => {
      await walletDB.open();

      const wallet = walletDB.primary;
      const balance = await wallet.getBalance(-1);
      const defBalance = await wallet.getBalance(0);
      const altBalance = await wallet.getBalance(1);

      const empty = {
        tx: 0,
        coin: 0,
        unconfirmed: 0,
        confirmed: 0,
        ulocked: 0,
        clocked: 0
      };

      balanceEquals(balance, empty);
      balanceEquals(defBalance, empty);
      balanceEquals(altBalance, empty);

      await walletDB.close();
    });

    it('should enable txdb migration', () => {
      WalletMigrator.migrations = {
        0: WalletMigrator.MigrateTXDBBalances
      };
    });

    it('should migrate', async () => {
      walletDB.options.walletMigrate = 0;

      await walletDB.open();

      const wallet = walletDB.primary;
      const balance = await wallet.getBalance(-1);
      const defBalance = await wallet.getBalance(0);
      const altBalance = await wallet.getBalance(1);

      const expectedDefault = {
        tx: 0,
        coin: 10,

        confirmed: 10e6,
        unconfirmed: 10e6,

        ulocked: 0,
        clocked: 0
      };

      const expectedAlt = {
        tx: 0,
        coin: 10,

        confirmed: 10e6,
        unconfirmed: 10e6,

        ulocked: 10e6,
        clocked: 10e6
      };

      const expecteBalance = {
        tx: expectedDefault.tx + expectedAlt.tx,
        coin: expectedDefault.coin + expectedAlt.coin,

        confirmed: expectedDefault.confirmed + expectedAlt.confirmed,
        unconfirmed: expectedDefault.unconfirmed + expectedAlt.unconfirmed,

        ulocked: expectedDefault.ulocked + expectedAlt.ulocked,
        clocked: expectedDefault.clocked + expectedAlt.clocked
      };

      balanceEquals(defBalance, expectedDefault);
      balanceEquals(altBalance, expectedAlt);
      balanceEquals(balance, expecteBalance);

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
