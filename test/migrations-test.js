'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Logger = require('blgr');
const MigrationState = require('../lib/migrations/state');
const AbstractMigration = require('../lib/migrations/migration');
const {
  Migrator,
  types
} = require('../lib/migrations/migrator');
const {
  DB_FLAG_ERROR,
  MockChainDB,
  migrationError
} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

class MockMigration1 extends AbstractMigration {
  async check() {
    return types.MIGRATE;
  }

  async migrate() {
    return true;
  }

  static info() {
    return {
      name: 'mock migration 1',
      description: 'mock description 1'
    };
  }
}

class MockMigration2 extends AbstractMigration {
  async check() {
    return types.MIGRATE;
  }

  async migrate() {
    return true;
  }

  static info() {
    return {
      name: 'mock migration 2',
      description: 'mock description 2'
    };
  }
}

describe('Migrations', function() {
  describe('Migrate flag', function() {
    let location, defaultOptions;

    async function initDB() {
      const db = new MockChainDB(defaultOptions);
      await db.open();
      await db.close();
    }

    beforeEach(async () => {
      location = testdir('migration');
      defaultOptions = {
        prefix: location,
        memory: false,
        migrations: {
          0: MockMigration1
        }
      };
      await fs.mkdirp(location);
      await initDB();
    });

    afterEach(async () => {
      await rimraf(location);
    });

    it('should do nothing w/o new migrations & w/o flag', async () => {
      const db = new MockChainDB({
        ...defaultOptions
      });

      await db.open();
      await db.close();
    });

    it('should fail with new migration & w/o flag', async () => {
      const migrations = {
        0: MockMigration1,
        1: MockMigration2
      };
      const db = new MockChainDB({
        ...defaultOptions,
        migrations
      });

      const error = migrationError(migrations, [1], DB_FLAG_ERROR);
      await assert.rejects(async () => {
        await db.open();
      }, {
        message: error
      });
    });

    it('should do nothing w/o new migrations & with correct flag', async () => {
      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0
      });

      await db.open();
      await db.close();
    });

    it('should do run migrations with correct flag', async () => {
      let migrated = false;
      const migrations = {
        0: MockMigration1,
        1: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }
          async migrate() {
            migrated = true;
          }
        }
      };
      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 1,
        migrations
      });

      await db.open();
      assert.strictEqual(migrated, true);
      await db.close();
    });

    it('should fail w/o new migration & with incorrect flag', async () => {
      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 1
      });

      await assert.rejects(async () => {
        await db.open();
      }, {
        message: 'Migrate flag 1 does not match last ID: 0'
      });
    });

    it('should fail with new migrations & incorrect flag', async () => {
      const migrations = {
        0: MockMigration1,
        1: MockMigration2
      };

      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0,
        migrations
      });

      const error = migrationError(migrations, [1], DB_FLAG_ERROR);
      await assert.rejects(async () => {
        await db.open();
      }, {
        message: error
      });
    });
  });

  describe('Running migrations', function() {
    let location, defaultOptions;

    async function initDB() {
      const db = new MockChainDB(defaultOptions);
      await db.open();
      await db.close();
    }

    beforeEach(async () => {
      location = testdir('migration');
      defaultOptions = {
        prefix: location,
        memory: false
      };
      await fs.mkdirp(location);
      await initDB();
    });

    afterEach(async () => {
      await rimraf(location);
    });

    it('should initialize fresh migration state', async () => {
      await rimraf(location);

      const db = new MockChainDB(defaultOptions);
      const {migrations} = db;

      migrations.logger = {
        info: () => {},
        debug: () => {},
        warning: (msg) => {
          throw new Error(`Unexpected warning: ${msg}`);
        }
      };

      await db.open();
      const state = await migrations.getState();
      assert.strictEqual(state.inProgress, false);
      assert.strictEqual(state.nextMigration, 0);
      await db.close();
    });

    it('should ignore migration flag on non-existent db', async () => {
      await rimraf(location);

      const db = new MockChainDB({
        ...defaultOptions,
        migrations: { 0: MockMigration1 },
        migrateFlag: 0
      });

      const {migrations} = db;

      let warning = null;
      migrations.logger = {
        info: () => {},
        debug: () => {},
        warning: (msg) => {
          warning = msg;
        }
      };

      await db.open();
      assert.strictEqual(warning, 'Fresh start, ignoring migration flag.');
      const state = await migrations.getState();
      assert.strictEqual(state.inProgress, false);
      assert.strictEqual(state.nextMigration, 1);
      await db.close();
    });

    it('should throw if migrateFlag is incorrect', async () => {
      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0
      });

      await assert.rejects(async () => {
        await db.open();
      }, {
        message: 'Migrate flag 0 does not match last ID: -1'
      });
    });

    it('should fail if there are available migrations', async () => {
      const migrations = { 0: MockMigration1 };
      const db = new MockChainDB({
        ...defaultOptions,
        migrations
      });

      const error = migrationError(migrations, [0], DB_FLAG_ERROR);
      await assert.rejects(async () => {
        await db.open();
      }, {
        message: error
      });
    });

    it('should fail if there are available migrations with id', async () => {
      const migrations = {
        0: class extends AbstractMigration {
          async check() {}
          async migrate() {}
          static info() {
            return {
              name: 'mig1',
              description: 'desc1'
            };
          }
        },
        1: class extends AbstractMigration {
          async check() {}
          async migrate() {}
          static info() {
            return {
              name: 'mig2',
              description: 'desc2'
            };
          }
        }
      };

      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0,
        migrations: migrations
      });

      const error = migrationError(migrations, [0, 1], DB_FLAG_ERROR);
      await assert.rejects(async () => {
        await db.open();
      }, {
        message: error
      });
    });

    it('should migrate', async () => {
      let migrated1 = false;
      let migrated2 = false;

      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 1,
        migrations: {
          0: class extends AbstractMigration {
            async check() {
              return types.MIGRATE;
            }
            async migrate() {
              migrated1 = true;
            }
          },
          1: class extends AbstractMigration {
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

      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(lastID, 1);
      assert.strictEqual(migrated1, true);
      assert.strictEqual(migrated2, true);
      await db.close();
    });

    it('should show in progress migration status', async () => {
      let migrated1 = false;
      let migrated2 = false;

      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 1,
        migrations: {
          0: class extends AbstractMigration {
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
          1: class extends AbstractMigration {
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

      await db.close();

      {
        // check the state is correct.
        await db.db.open();

        const state = await db.migrations.getState();
        assert.strictEqual(state.inProgress, true);
        assert.strictEqual(state.nextMigration, 0);

        await db.db.close();
      }

      await assert.rejects(async () => {
        await db.open();
      }, {
        message: 'in progress error2'
      });

      await db.close();

      {
        // check the state is correct.
        await db.db.open();

        const state = await db.migrations.getState();
        assert.strictEqual(state.inProgress, true);
        assert.strictEqual(state.nextMigration, 1);

        await db.db.close();
      }

      await db.open();
      const state = await db.migrations.getState();
      assert.strictEqual(state.inProgress, false);
      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(migrated1, true);
      assert.strictEqual(migrated2, true);
      await db.close();
    });

    it('should fake migrate if it does not apply', async () => {
      let migrate = false;
      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0,
        migrations: {
          0: class extends AbstractMigration {
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
      assert.strictEqual(state.nextMigration, 1);
      assert.strictEqual(migrate, false);

      await db.close();
    });

    it('should skip migrations if it cant be fullfilled', async () => {
      let checked = 0;
      let showedWarning = 0;
      let migrated = 0;

      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0,
        migrations: {
          0: class extends AbstractMigration {
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
      assert.strictEqual(state.nextMigration, 1);
      assert.deepStrictEqual(state.skipped, [0]);

      assert.strictEqual(checked, 1);
      assert.strictEqual(showedWarning, 1);
      assert.strictEqual(migrated, 0);

      await db.close();

      db.migrations.migrateFlag = -1;
      await db.open();
      const state2 = await db.migrations.getState();
      assert.strictEqual(state2.inProgress, false);
      assert.strictEqual(state2.nextMigration, 1);
      assert.deepStrictEqual(state2.skipped, [0]);

      assert.strictEqual(checked, 1);
      assert.strictEqual(showedWarning, 2);
      assert.strictEqual(migrated, 0);
      await db.close();
    });

    it('should fail with unknown migration type', async () => {
      const db = new MockChainDB({
        ...defaultOptions,
        migrateFlag: 0,
        migrations: {
          0: class extends AbstractMigration {
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
        assert.throws(() => new Migrator(opts), { message: err });
    });
  });

  describe('MigrationState', function() {
    it('should clone the state', () => {
      const state1 = new MigrationState();

      state1.inProgress = 1;
      state1.nextMigration = 3;
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
