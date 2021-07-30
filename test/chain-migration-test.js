/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Network = require('../lib/protocol/network');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const Chain = require('../lib/blockchain/chain');
const layout = require('../lib/blockchain/layout');
const ChainMigrator = require('../lib/blockchain/migrations');
const MigrationState = require('../lib/migrations/state');
const AbstractMigration = require('../lib/migrations/migration');
const {
  types,
  oldLayout
} = require('../lib/migrations/migrator');
const {migrationError} = require('./util/migrations');
const {rimraf, testdir} = require('./util/common');

const network = Network.get('regtest');

const chainFlagError = (id) => {
  return `Restart with \`hsd --chain-migrate=${id}\``;
};

describe('Chain Migrations', function() {
  describe('General (v0..)', function() {
    const location = testdir('migrate-chain-general');
    const migrationsBAK = ChainMigrator.migrations;
    const lastMigrationID = Math.max(...Object.keys(migrationsBAK));

    const chainOptions = {
      prefix: location,
      memory: false,
      network
    };

    const getIDs = (min, max) => {
      const ids = new Set();
      for (let i = min; i <= max; i++)
        ids.add(i);

      return ids;
    };

    let chain, chainDB, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);
      chain = new Chain(chainOptions);
      chainDB = chain.db;
      ldb = chainDB.db;

      ChainMigrator.migrations = migrationsBAK;
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();

      await rimraf(location);
    });

    after(() => {
      ChainMigrator.migrations = migrationsBAK;
    });

    it('should initialize fresh chain migration state', async () => {
      await chain.open();

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, lastMigrationID);
      assert.strictEqual(state.nextMigration, lastMigrationID + 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);

      await chain.close();
    });

    it('should not migrate pre-old migration state w/o flag', async () => {
      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain must throw an error.');
      const ids = getIDs(0, lastMigrationID);
      const expected = migrationError(ChainMigrator.migrations, [...ids],
        chainFlagError(lastMigrationID));
      assert.strictEqual(error.message, expected);

      await ldb.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    // special case in migrations
    it('should not migrate last old migration state w/o flag', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain must throw an error.');
      const ids = getIDs(0, lastMigrationID);
      ids.delete(1);
      const expected = migrationError(ChainMigrator.migrations, [...ids],
        chainFlagError(lastMigrationID));
      assert.strictEqual(error.message, expected);

      await ldb.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should only migrate the migration states with flag', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = lastMigrationID;
      await chain.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, chainDB.version);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, lastMigrationID);
      assert.strictEqual(state.nextMigration, lastMigrationID + 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await chain.close();
    });

    it('should not run with forceFlags when there are migrations', async () => {
      await chain.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);
      state.nextMigration -= 1;
      await ldb.put(layout.M.encode(), state.encode());
      await chain.close();

      chain.options.forceFlags = true;

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain should throw an error');
      assert.strictEqual(error.message,
        'Migrations can not run with `forceFlags`');
    });

    it('should run with forceFlags when there are no migrations', async () => {
      await chain.open();
      await chain.close();

      chain.options.forceFlags = true;
      await chain.open();
      await chain.close();
      chain.options.forceFlags = false;
    });

    it('should check chaindb flags if there are migrations', async () => {
      await chain.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);
      state.nextMigration -= 1;
      await ldb.put(layout.M.encode(), state.encode());
      await chain.close();

      chain.options.spv = true;

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain should throw an error');
      assert.strictEqual(error.message,
        'Cannot retroactively enable SPV.');
    });
  });

  describe('Migrations v1..v2', function() {
    const location = testdir('migrate-chain-v1-v2');
    const migrationsBAK = ChainMigrator.migrations;
    const testMigrations = {
      0: ChainMigrator.MigrateMigrations,
      1: ChainMigrator.MigrateChainState
    };

    const chainOptions = {
      prefix: location,
      memory: false,
      network
    };

    let chain, chainDB, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);
      chain = new Chain(chainOptions);
      chainDB = chain.db;
      ldb = chainDB.db;

      ChainMigrator.migrations = testMigrations;
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();

      await rimraf(location);
    });

    after(() => {
      ChainMigrator.migrations = migrationsBAK;
    });

    it('should initialize fresh chain migration state', async () => {
      await chain.open();

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);

      await chain.close();
    });

    it('should not migrate pre-old migration state w/o flag', async () => {
      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [0, 1],
        chainFlagError(1));
      assert.strictEqual(error.message, expected);

      await ldb.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should migrate from first old migration state with flag', async () => {
      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 1;
      await chain.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 2);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await chain.close();
    });

    it('should not migrate last old migration state w/o flag', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [0],
        chainFlagError(1));
      assert.strictEqual(error.message, expected);

      await ldb.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should only migrate the migration states with flag', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      writeVersion(b, 'chain', 1);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 1;
      await chain.open();
      const versionData = await ldb.get(layout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 2);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await chain.close();
    });

    it('should not run new migration w/o flag', async () => {
      ChainMigrator.migrations = {
        0: migrationsBAK[0],
        1: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }

          static info() {
            return {
              name: 'test name1',
              description: 'test description1'
            };
          }
        },
        2: class extends AbstractMigration {
          async check() {
            return types.MIGRATE;
          }

          static info() {
            return {
              name: 'test name2',
              description: 'test description2'
            };
          }
        }
      };

      await chain.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [0, 2],
        chainFlagError(2));
      assert.strictEqual(error.message, expected);

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should run migration upgrade and new migration', async () => {
      let migrated1 = false;
      let migrated2 = false;
      ChainMigrator.migrations = {
        0: migrationsBAK[0],
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

      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 2;
      await chain.open();

      assert.strictEqual(migrated1, false);
      assert.strictEqual(migrated2, true);

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 3);
      assert.strictEqual(state.lastMigration, 2);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await chain.close();
    });

    it('should have skipped migration for prune', async () => {
      chain.options.prune = true;

      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 1;
      await chain.open();

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 1);
      assert.strictEqual(state.skipped[0], 1);
      assert.strictEqual(state.inProgress, false);
      await chain.close();
    });
  });

  describe('Migration ChainState (integration)', function() {
    const location = testdir('migrate-chain-state');
    const migrationsBAK = ChainMigrator.migrations;

    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      network,
      workers
    };

    let chain, miner, cpu;
    before(async () => {
      ChainMigrator.migrations = {};
      await fs.mkdirp(location);
      await workers.open();
    });

    after(async () => {
      ChainMigrator.migrations = migrationsBAK;
      await rimraf(location);
      await workers.close();
    });

    beforeEach(async () => {
      chain = new Chain(chainOptions);
      miner = new Miner({ chain });
      cpu = miner.cpu;

      await miner.open();
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();

      await miner.close();
    });

    let correctState;
    it('should mine 10 blocks', async () => {
      await chain.open();

      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      await chain.close();
    });

    it('should set incorrect chaindb state', async () => {
      await chain.open();
      const state = chain.db.state.clone();
      correctState = state.clone();

      state.coin = 0;
      state.value = 0;
      state.burned = 0;

      await chain.db.db.put(layout.R.encode(), state.encode());
      await chain.close();
    });

    it('should enable chain state migration', () => {
      ChainMigrator.migrations = {
        0: ChainMigrator.MigrateChainState
      };
    });

    it('should throw error when new migration is available', async () => {
      const expected = migrationError(ChainMigrator.migrations, [0],
        chainFlagError(0));

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, expected);
    });

    it('should migrate chain state', async () => {
      chain.options.chainMigrate = 0;

      await chain.open();

      assert.bufferEqual(chain.db.state.encode(), correctState.encode(),
        'Chain State did not properly migrate.');

      await chain.close();
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
