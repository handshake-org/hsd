/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Logger = require('blgr');
const MigrationState = require('../lib/migrations/state');
const {
  AbstractMigration,
  Migrations,
  types
} = require('../lib/migrations/migrations');
const {
  MockChainDB,
  mockLayout,
  oldMockLayout
} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

class MockMigration1 {
  async check() {
    return types.MIGRATE;
  }

  async migrate() {
    return true;
  }
}

describe('Migrations', function() {
  let location, defaultOptions;

  beforeEach(async () => {
    location = testdir('migration');
    defaultOptions = {
      prefix: location,
      memory: false
    };
    await fs.mkdirp(location);
  });

  afterEach(async () => {
    await rimraf(location);
  });

  async function initDB() {
    const db = new MockChainDB(defaultOptions);
    await db.open();
    await db.close();
  }

  it('should initialize fresh migration state', async () => {
    const db = new MockChainDB(defaultOptions);
    const {migrations} = db;

    await db.open();
    const state = await migrations.getState();
    assert.strictEqual(state.inProgress, false);
    assert.strictEqual(state.lastMigration, 0);
    await db.close();
  });

  it('should fail migration on non-existent db', async () => {
    const db = new MockChainDB({
      ...defaultOptions,
      migrateFlag: true
    });

    await assert.rejects(async () => {
      await db.open();
    }, {
      message: 'Database does not exist.'
    });
  });

  it('should recover old migration states', async () => {
    const db = new MockChainDB({
      ...defaultOptions,
      migrations: {
        1: MockMigration1,
        2: MockMigration1
      }
    });
    const {migrations} = db;
    const ldb = db.db;

    {
      // replicate old Migration states.
      await ldb.open();
      await ldb.verify(mockLayout.V.encode(), 'chain', db.dbVersion);
      const batch = ldb.batch();
      batch.put(oldMockLayout.M.encode(0), null);
      batch.put(oldMockLayout.M.encode(1), null);
      batch.put(oldMockLayout.M.encode(2), null);
      await batch.write();
      await ldb.close();
    }

    await db.open();

    const state = await migrations.getState();
    assert.strictEqual(state.inProgress, false);
    assert.strictEqual(state.lastMigration, 2);

    assert.strictEqual(migrations.getLastMigrationID(), 2);

    await db.close();
  });

  it('should throw if there are no migrations', async () => {
    await initDB();

    const db = new MockChainDB({
      ...defaultOptions,
      migrateFlag: true
    });

    await assert.rejects(async () => {
      await db.open();
    }, {
      message: 'There are no available migrations.'
    });
  });

  it('should fail if there are available migrations', async () => {
    await initDB();

    const db = new MockChainDB({
      ...defaultOptions,
      migrations: { 1: MockMigration1 }
    });

    await assert.rejects(async () => {
      await db.open();
    }, {
      message: 'Database needs migration.'
    });
  });

  it('should migrate', async () => {
    await initDB();

    let migrated1 = false;
    let migrated2 = false;

    const db = new MockChainDB({
      ...defaultOptions,
      migrateFlag: true,
      migrations: {
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
      }
    });

    await db.open();

    const lastID = db.migrations.getLastMigrationID();
    const state = await db.migrations.getState();

    assert.strictEqual(state.lastMigration, 2);
    assert.strictEqual(lastID, 2);
    assert.strictEqual(migrated1, true);
    assert.strictEqual(migrated2, true);
    await db.close();
  });

  it('should show in progress migration status', async () => {
    await initDB();

    let migrated1 = false;
    let migrated2 = false;

    const db = new MockChainDB({
      ...defaultOptions,
      migrateFlag: true,
      migrations: {
        1: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }
          async migrate() {
            if (!migrated1) {
              migrated1 = true;
              throw new Error('in progress error1');
            }
          }
        },
        2: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }

          async migrate() {
            if (!migrated2) {
              migrated2 = true;
              throw new Error('in progress error2');
            }
          }
        }
      }
    });

    await assert.rejects(async () => {
      await db.open();
    }, {
      message: 'in progress error1'
    });

    {
      // check the state is correct.
      await db.db.open();

      const state = await db.migrations.getState();
      assert.strictEqual(state.inProgress, true);
      assert.strictEqual(state.lastMigration, 0);

      await db.db.close();
    }

    await assert.rejects(async () => {
      await db.open();
    }, {
      message: 'in progress error2'
    });

    {
      // check the state is correct.
      await db.db.open();

      const state = await db.migrations.getState();
      assert.strictEqual(state.inProgress, true);
      assert.strictEqual(state.lastMigration, 1);

      await db.db.close();
    }

    await db.open();
    const state = await db.migrations.getState();
    assert.strictEqual(state.inProgress, false);
    assert.strictEqual(state.lastMigration, 2);
    assert.strictEqual(migrated1, true);
    assert.strictEqual(migrated2, true);
    await db.close();
  });

  it('should fake migrate if it does not apply', async () => {
    await initDB();

    let migrate = false;
    const db = new MockChainDB({
      ...defaultOptions,
      migrations: {
        1: class extends AbstractMigration {
          async check() {
            return types.FAKE_MIGRATE;
          }

          async migrate() {
            migrate = true;
          }
        }
      }
    });

    await db.open();

    const state = await db.migrations.getState();
    assert.strictEqual(state.inProgress, false);
    assert.strictEqual(state.lastMigration, 1);
    assert.strictEqual(migrate, false);

    await db.close();
  });

  it('should skip migrations if it cant be fullfilled', async () => {
    await initDB();

    let checked = 0;
    let showedWarning = 0;
    let migrated = 0;

    const db = new MockChainDB({
      ...defaultOptions,
      migrations: {
        1: class extends AbstractMigration {
          async check() {
            checked++;
            return types.SKIP;
          }

          async warning() {
            showedWarning++;
          }

          async migrate() {
            migrated++;
          }
        }
      }
    });

    await db.open();

    const state = await db.migrations.getState();
    assert.strictEqual(state.inProgress, false);
    assert.strictEqual(state.lastMigration, 1);
    assert.deepStrictEqual(state.skipped, [1]);

    assert.strictEqual(checked, 1);
    assert.strictEqual(showedWarning, 1);
    assert.strictEqual(migrated, 0);

    await db.close();

    await db.open();
    const state2 = await db.migrations.getState();
    assert.strictEqual(state2.inProgress, false);
    assert.strictEqual(state2.lastMigration, 1);
    assert.deepStrictEqual(state2.skipped, [1]);

    assert.strictEqual(checked, 1);
    assert.strictEqual(showedWarning, 2);
    assert.strictEqual(migrated, 0);
    await db.close();
  });

  it('should fail with unknown migration type', async () => {
    await initDB();

    const db = new MockChainDB({
      ...defaultOptions,
      migrations: {
        1: class extends AbstractMigration {
          async check() {
            return -1;
          }
        }
      }
    });

    await assert.rejects(async () => {
      await db.open();
    }, {
      message: 'Unknown migration type.'
    });
  });

  describe('Options', function() {
    it('should fail w/o db && ldb', () => {
      const errors = [
        { opts: null, err: 'Migration options are required.' },
        { opts: {}, err: 'options.db is required.' },
        { opts: { db: {} }, err: 'options.ldb is required.' },
        {
          opts: { db: 1, ldb: {} },
          err: 'options.db needs to be an object.'
        },
        {
          opts: { db: {}, ldb: 1 },
          err: 'options.ldb needs to be an object.'
        }
      ];

      for (const {opts, err} of errors)
        assert.throws(() => new Migrations(opts), { message: err });
    });
  });

  describe('MigrationState', function() {
    it('should clone the state', () => {
      const state1 = new MigrationState();

      state1.inProgress = 1;
      state1.lastMigration = 3;
      state1.skipped = [1, 2];

      const state2 = state1.clone();

      assert.notEqual(state2.skipped, state1.skipped);
      assert.deepStrictEqual(state2, state1);
    });
  });

  describe('AbstractMigration', function() {
    let logger = null;

    function context(ctx) {
      return {warning: () => ctx};
    }

    const baseMethods = ['check', 'migrate'];

    beforeEach(() => {
      logger = Logger.global;
      Logger.global = {context};
    });

    afterEach(() => {
      Logger.global = logger;
    });

    it('construct with custom logger', async () => {
      const migration = new AbstractMigration({logger: {context}});
      assert(migration.logger);
      assert(migration.logger.warning);
      assert.strictEqual(migration.logger.warning(), 'migration');
    });

    it('should have method: warning', () => {
      let logged;
      const migration = new AbstractMigration({
        logger: {
          context: () => {
            return {
              warning: () => {
                logged = true;
              }
            };
          }
        }
      });

      assert(migration.warning);
      migration.warning();
      assert.strictEqual(logged, true);
    });

    for (const method of baseMethods) {
      it(`should have unimplemented method: ${method}`, async () => {
        const migration = new AbstractMigration({logger: {context}});

        assert(migration[method]);
        await assert.rejects(async () => {
          await migration[method]();
        }, {
          name: 'Error',
          message: 'Abstract method.'
        });
      });
    }
  });
});
