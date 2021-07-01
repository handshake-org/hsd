/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Logger = require('blgr');
const {
  AbstractMigration,
  Migrations
} = require('../lib/migrations/migrations');
const {
  MockChainDB,
  mockLayout,
  oldMockLayout
} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

describe('Migrations', function () {
  const logger = new Logger({
    level: 'debug',
    console: true
  });

  let location, defaultOptions;

  before(async () => {
    await logger.open();
  });

  after(async () => {
    await logger.close();
  });

  beforeEach(async () => {
    location = testdir('migration');
    defaultOptions = {
      prefix: location,
      logger: logger,
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

    assert.rejects(async () => {
      await db.open();
    }, {
      message: 'Database does not exist.'
    });
  });

  it('should recover old migration states', async () => {
    const db = new MockChainDB({
      ...defaultOptions,
      migrations: {
        1: null,
        2: null
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
      migrations: { 1: null }
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
          async migrate() {
            migrated1 = true;
          }
        },
        2: class extends AbstractMigration {
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
          async migrate() {
            if (!migrated1) {
              migrated1 = true;
              throw new Error('in progress error1');
            }
          }
        },
        2: class extends AbstractMigration {
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

  describe('Options', function () {
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
});
