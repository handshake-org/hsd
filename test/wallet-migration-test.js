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
const {
  migrationError,
  writeVersion,
  getVersion,
  checkVersion,
  checkEntries,
  fillEntries
} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

const NETWORK = 'regtest';
const network = Network.get(NETWORK);
const layout = layouts.wdb;

const countAndTimeData = [
  require('./data/migrations/wallet-5-pagination.json'),
  require('./data/migrations/wallet-5-pagination-2.json')
];

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
      b.del(layouts.wdb.M.encode());
      b.put(oldLayout.M.encode(0), null);
      writeVersion(b, layouts.wdb.V.encode(), 'wallet', 0);
      await b.write();
      await walletDB.close();

      walletDB.options.walletMigrate = lastMigrationID;
      walletDB.version = 1;
      await walletDB.open();

      const versionData = await ldb.get(layouts.wdb.V.encode());
      const version = await getVersion(versionData, 'wallet');
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

  describe('Migrations #0 & #1 (data)', function() {
    const location = testdir('migrate-wallet-0-1-int');
    const migrationBAK = WalletMigrator.migrations;
    const data = require('./data/migrations/wallet-0-migrate-migrations.json');
    const Migration = WalletMigrator.MigrateMigrations;
    const layout = Migration.layout();

    const walletOptions = {
      prefix: location,
      memory: false,
      network
    };

    let wdb, ldb;
    beforeEach(async () => {
      WalletMigrator.migrations = {};
      await fs.mkdirp(location);

      wdb = new WalletDB(walletOptions);
      ldb = wdb.db;
    });

    afterEach(async () => {
      WalletMigrator.migrations = migrationBAK;
      await rimraf(location);
    });

    for (let i = 0; i < data.cases.length; i++) {
      it(`should migrate ${data.cases[i].description}`, async () => {
        const before = data.cases[i].before;
        const after = data.cases[i].after;
        await ldb.open();
        const b = ldb.batch();

        for (const [key, value] of Object.entries(before)) {
          const bkey = Buffer.from(key, 'hex');
          const bvalue = Buffer.from(value, 'hex');

          b.put(bkey, bvalue);
        }

        writeVersion(b, layouts.wdb.V.encode(), 'wallet', 0);

        await b.write();
        await ldb.close();

        WalletMigrator.migrations = {
          0: Migration,
          1: WalletMigrator.MigrateChangeAddress
        };

        wdb.options.walletMigrate = 1;
        wdb.version = 1;

        await wdb.open();
        await checkVersion(ldb, layouts.wdb.V.encode(), 1);
        await checkEntries(ldb, {
          after,
          throw: true,
          bail: true
        });
        const oldM = await ldb.get(layout.oldLayout.wdb.M.encode(0));
        assert.strictEqual(oldM, null);
        await wdb.close();
      });
    }
  });

  describe('Migrate change address (data)', function() {
    const location = testdir('wallet-change-data');
    const migrationsBAK = WalletMigrator.migrations;
    const data = require('./data/migrations/wallet-1-change.json');
    const Migration = WalletMigrator.MigrateChangeAddress;

    const walletOptions = {
      prefix: location,
      memory: false,
      network
    };

    let wdb, ldb;
    before(async () => {
      WalletMigrator.migrations = {};
      await fs.mkdirp(location);

      wdb = new WalletDB(walletOptions);
      ldb = wdb.db;

      await ldb.open();
      await fillEntries(ldb, data.beforeOnly);
      await fillEntries(ldb, data.before);
      await ldb.close();
    });

    after(async () => {
      WalletMigrator.migrations = migrationsBAK;
      await rimraf(location);
    });

    it('should have before entries', async () => {
      wdb.version = 0;
      try {
        // We don't care that new wallet can't decode old data.
        // It will still run migrations.
        await wdb.open();
      } catch (e) {
        ;
      }
      await checkVersion(ldb, layouts.wdb.V.encode(), 0);
      await checkEntries(ldb, {
        after: data.before,
        throw: true,
        bail: true
      });
      await wdb.close();
    });

    it('should enable wallet migration', () => {
      WalletMigrator.migrations = {
        0: Migration
      };
    });

    it('should fail without migrate flag', async () => {
      const expectedError = migrationError(WalletMigrator.migrations, [0],
          wdbFlagError(0));

      await assert.rejects(async () => {
        await wdb.open();
      }, {
        message: expectedError
      });

      await ldb.close();
    });

    it('should migrate', async () => {
      wdb.options.walletMigrate = 0;

      try {
        // We don't care that new wallet can't decode old data.
        // It will still run migrations.
        await wdb.open();
      } catch (e) {
        ;
      }
      await checkVersion(ldb, layouts.wdb.V.encode(), 0);
      await checkEntries(ldb, {
        after: data.after,
        throw: true,
        bail: true
      });

      await wdb.close();
    });
  });

  describe('Migrate account lookahead (data)', function() {
    const location = testdir('wallet-lookahead-data');
    const migrationsBAK = WalletMigrator.migrations;
    const data = require('./data/migrations/wallet-2-account-lookahead.json');
    const Migration = WalletMigrator.MigrateAccountLookahead;

    const walletOptions = {
      prefix: location,
      memory: false,
      network
    };

    let wdb, ldb;
    before(async () => {
      WalletMigrator.migrations = {};
      await fs.mkdirp(location);

      wdb = new WalletDB(walletOptions);
      ldb = wdb.db;

      await ldb.open();
      await fillEntries(ldb, data.before);
      await ldb.close();
    });

    after(async () => {
      WalletMigrator.migrations = migrationsBAK;
      await rimraf(location);
    });

    it('should have before entries', async () => {
      wdb.version = 1;
      try {
        // We don't care that new wallet can't decode old data.
        // It will still run migrations.
        await wdb.open();
      } catch (e) {
        ;
      }
      await checkVersion(ldb, layouts.wdb.V.encode(), 1);
      await checkEntries(ldb, {
        after: data.before,
        throw: true,
        bail: true
      });
      await wdb.close();
    });

    it('should enable wallet migration', () => {
      WalletMigrator.migrations = {
        0: Migration
      };
    });

    it('should fail without migrate flag', async () => {
      const expectedError = migrationError(WalletMigrator.migrations, [0],
          wdbFlagError(0));

      await assert.rejects(async () => {
        await wdb.open();
      }, {
        message: expectedError
      });

      await ldb.close();
    });

    it('should migrate', async () => {
      wdb.options.walletMigrate = 0;

      try {
        // We don't care that new wallet can't decode old data.
        // It will still run migrations.
        await wdb.open();
      } catch (e) {
        ;
      }
      await checkVersion(ldb, layouts.wdb.V.encode(), 2);
      await checkEntries(ldb, {
        after: data.after,
        throw: true,
        bail: true
      });
      await wdb.close();
    });
  });

  describe('Migrate account lookahead (integration)', function () {
    const location = testdir('wallet-lookahead');
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
      walletDB.version = 2;

      await walletDB.open();
      const wallet = walletDB.primary;
      const wallet2 = await walletDB.get(1);
      await checkLookahead(wallet, TEST_LOOKAHEAD + 0);
      await checkLookahead(wallet2, TEST_LOOKAHEAD + 10);
      await walletDB.close();
    });
  });

  describe('Migrate txdb balances (integration)', function() {
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

  describe('Bid Reveal Migration (integration)', function() {
    const location = testdir('wallet-bid-reveal');
    const migrationsBAK = WalletMigrator.migrations;
    const data = require('./data/migrations/wallet-4-bid-reveal.json');
    const Migration = WalletMigrator.MigrateBidRevealEntries;
    const layout = Migration.layout();

    const walletOptions = {
      prefix: location,
      memory: false,
      network
    };

    let walletDB, ldb;
    before(async () => {
      WalletMigrator.migrations = {};
      await fs.mkdirp(location);

      walletDB = new WalletDB(walletOptions);
      ldb = walletDB.db;

      await ldb.open();

      const b = ldb.batch();
      for (const [key, value] of Object.entries(data.before)) {
        const bkey = Buffer.from(key, 'hex');
        const bvalue = Buffer.from(value, 'hex');

        b.put(bkey, bvalue);
      }
      await b.write();

      await ldb.close();
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

    it('should have before entries', async () => {
      walletDB.version = 2;
      await walletDB.open();
      await checkVersion(ldb, layout.wdb.V.encode(), 2);
      await checkEntries(ldb, {
        after: data.before,
        throw: true,
        bail: true
      });
      await walletDB.close();
    });

    it('should enable wallet migration', () => {
      WalletMigrator.migrations = {
        0: Migration
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

    it('should migrate', async () => {
      walletDB.options.walletMigrate = 0;

      walletDB.version = 3;
      await walletDB.open();
      // check we have migrated entries.
      await checkEntries(ldb, {
        after: data.after,
        throw: true,
        bail: true
      });
      await walletDB.close();
    });
  });

  for (const [i, data] of countAndTimeData.entries())
  describe(`TX Count and time indexing migration (integration ${i})`, function() {
    const location = testdir('wallet-tx-count-time');
    const migrationsBAK = WalletMigrator.migrations;
    // const data = require('./data/migrations/wallet-5-pagination.json');
    const Migration = WalletMigrator.MigrateTXCountTimeIndex;
    const layout = Migration.layout();

    const walletOptions = {
      prefix: location,
      memory: false,
      network
    };

    /** @type {WalletDB} */
    let walletDB;
    /** @type {bdb.DB} */
    let ldb;
    const headersByHash = new Map();
    const headersByHeight = new Map();

    before(async () => {
      WalletMigrator.migrations = {};
      await fs.mkdirp(location);

      walletDB = new WalletDB(walletOptions);
      ldb = walletDB.db;

      await ldb.open();

      const b = ldb.batch();
      for (const [key, value] of Object.entries(data.before)) {
        const bkey = Buffer.from(key, 'hex');
        const bvalue = Buffer.from(value, 'hex');

        b.put(bkey, bvalue);
      }

      await b.write();
      await ldb.close();

      // load headers into maps.
      for (const header of data.headers) {
        headersByHash.set(header.hash, header);
        headersByHeight.set(header.height, header);
      }
    });

    after(async () => {
      WalletMigrator.migrations = migrationsBAK;
      await rimraf(location);
    });

    it('should have before entries', async () => {
      walletDB.version = 3;
      await walletDB.open();
      await checkVersion(ldb, layout.wdb.V.encode(), 3);
      await checkEntries(ldb, {
        after: data.before,
        throw: true
      });
      await walletDB.close();
    });

    it('should enable wallet migration', () => {
      WalletMigrator.migrations = {
        0: WalletMigrator.MigrateTXCountTimeIndex
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

    it('should migrate', async () => {
      walletDB.options.walletMigrate = 0;

      // patch getBlockHeader to return headers from data.
      walletDB.client.getBlockHeader = (block) => {
        if (typeof block === 'number')
          return headersByHeight.get(block);

        return headersByHash.get(block);
      };

      walletDB.version = 4;
      await walletDB.open();
      // check we have migrated entries.
      await checkEntries(ldb, {
        before: data.before,
        after: data.after,
        throw: true,
        logErrors: true
      });

      await walletDB.close();
    });
  });
});
