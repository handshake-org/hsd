'use strict';

const assert = require('bsert');
const fs = require('bfile');
const {encoding} = require('bufio');
const Logger = require('blgr');
const {ZERO_HASH} = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore');
const chLayout = require('../lib/blockchain/layout');
const ChainMigrator = require('../lib/blockchain/migrations');
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
  fillEntries,
  checkEntries
} = require('./util/migrations');
const common = require('./util/common');
const {rimraf, testdir} = common;

const network = Network.get('regtest');

const chainFlagError = (id) => {
  return `Restart with \`hsd --chain-migrate=${id}\``;
};

const VERSION_ERROR = 'Database version mismatch for database: "chain".'
  + ' Please run a data migration before opening.';

describe('Chain Migrations', function() {
  describe('General', function() {
    const location = testdir('migrate-chain-general');
    const store = BlockStore.create({
      memory: true,
      network
    });

    const migrationsBAK = ChainMigrator.migrations;
    const lastMigrationID = Math.max(...Object.keys(migrationsBAK));

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
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

      await store.open();
      await chain.open();
    });

    afterEach(async () => {
      await chain.close();
      await store.close();
      await rimraf(location);
    });

    after(() => {
      ChainMigrator.migrations = migrationsBAK;
    });

    it('should initialize fresh chain migration state', async () => {
      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, lastMigrationID);
      assert.strictEqual(state.nextMigration, lastMigrationID + 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should not migrate pre-old migration state w/o flag', async () => {
      // set the oldest state
      const genesisBlock = await chainDB.getBlock(0);
      const genesisHash = genesisBlock.hash();
      const genesisUndo = await chainDB.getUndoCoins(genesisHash);

      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(chLayout.b.encode(genesisHash), genesisBlock.encode());
      b.put(chLayout.u.encode(genesisHash), genesisUndo.encode());
      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();

      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const ids = getIDs(0, lastMigrationID);
      const expected = migrationError(ChainMigrator.migrations, [...ids],
        chainFlagError(lastMigrationID));
      assert.strictEqual(error.message, expected);

      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    // special case in migrations
    it('should not migrate last old migration state w/o flag', async () => {
      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const ids = getIDs(0, lastMigrationID);
      ids.delete(1);
      const expected = migrationError(ChainMigrator.migrations, [...ids],
        chainFlagError(lastMigrationID));
      assert.strictEqual(error.message, expected);

      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should only migrate the migration states with flag', async () => {
      // set the oldest state
      // NOTE: Every new migration would need to set oldest state.
      const genesisBlock = await chainDB.getBlock(0);
      const genesisHash = genesisBlock.hash();
      const genesisUndo = await chainDB.getUndoCoins(genesisHash);

      const b = ldb.batch();
      b.del(chLayout.M.encode());

      // Migration blockstore
      b.put(chLayout.b.encode(genesisHash), genesisBlock.encode());
      b.put(chLayout.u.encode(genesisHash), genesisUndo.encode());

      // migration 3 - MigrateTreeState
      b.put(chLayout.s.encode(), Buffer.alloc(32, 0));

      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();

      await chain.close();

      chain.options.chainMigrate = lastMigrationID;
      await chain.open();
      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, chainDB.version);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, lastMigrationID);
      assert.strictEqual(state.nextMigration, lastMigrationID + 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should check chaindb flags if there are migrations', async () => {
      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);
      state.nextMigration -= 1;
      await ldb.put(chLayout.M.encode(), state.encode());
      await chain.close();

      chain.options.spv = true;

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain should throw an error');
      assert.strictEqual(error.message,
        'Cannot retroactively enable SPV.');
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

      await chain.close();
      ChainMigrator.migrations[nextID] = LastMigration;

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [nextID],
        chainFlagError(nextID));
      assert.strictEqual(error.message, expected);
    });
  });

  describe('Migrations #0 & #1', function() {
    const location = testdir('migrate-chain-0-1');
    const store = BlockStore.create({
      memory: true,
      network
    });

    const migrationsBAK = ChainMigrator.migrations;
    const testMigrations = {
      0: ChainMigrator.MigrateMigrations,
      1: ChainMigrator.MigrateChainState
    };

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      network
    };

    let chain, chainDB, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);
      chain = new Chain(chainOptions);
      chainDB = chain.db;
      ldb = chainDB.db;

      // Chain Version was 2 at that time.
      chainDB.version = 2;

      await store.open();
      ChainMigrator.migrations = testMigrations;
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();

      await store.close();
      await rimraf(location);
    });

    after(() => {
      ChainMigrator.migrations = migrationsBAK;
    });

    it('should initialize fresh chain migration state', async () => {
      await chain.open();

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should not migrate pre-old migration state w/o flag', async () => {
      await chain.open();

      // set the oldest state
      const genesisBlock = await chainDB.getBlock(0);
      const genesisHash = genesisBlock.hash();
      const genesisUndo = await chainDB.getUndoCoins(genesisHash);

      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(chLayout.b.encode(genesisHash), genesisBlock.encode());
      b.put(chLayout.u.encode(genesisHash), genesisUndo.encode());
      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();

      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [0, 1],
        chainFlagError(1));
      assert.strictEqual(error.message, expected);

      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should migrate from first old migration state with flag', async () => {
      await chain.open();

      // set the oldest state
      const genesisBlock = await chainDB.getBlock(0);
      const genesisHash = genesisBlock.hash();
      const genesisUndo = await chainDB.getUndoCoins(genesisHash);

      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(chLayout.b.encode(genesisHash), genesisBlock.encode());
      b.put(chLayout.u.encode(genesisHash), genesisUndo.encode());
      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();

      await chain.close();

      chain.options.chainMigrate = 1;
      await chain.open();
      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 2);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should not migrate last old migration state w/o flag', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [0],
        chainFlagError(1));
      assert.strictEqual(error.message, expected);

      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 1);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should only migrate the migration states with flag', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      writeVersion(b, chLayout.V.encode(), 'chain', 1);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 1;
      await chain.open();
      const versionData = await ldb.get(chLayout.V.encode());
      const version = getVersion(versionData, 'chain');
      assert.strictEqual(version, 2);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 2);
      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
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
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      const expected = migrationError(ChainMigrator.migrations, [0, 2],
        chainFlagError(2));
      assert.strictEqual(error.message, expected);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 0);
      assert.strictEqual(state.lastMigration, -1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
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
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 2;
      await chain.open();

      assert.strictEqual(migrated1, false);
      assert.strictEqual(migrated2, true);

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.nextMigration, 3);
      assert.strictEqual(state.lastMigration, 2);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should have skipped migration for prune', async () => {
      chain.options.prune = true;

      await chain.open();
      const b = ldb.batch();
      b.del(chLayout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      chain.options.chainMigrate = 1;
      await chain.open();

      const rawState = await ldb.get(chLayout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 1);
      assert.strictEqual(state.skipped[0], 1);
      assert.strictEqual(state.inProgress, false);
    });
  });

  describe('Migration #0 & #1 (data)', function() {
    const location = testdir('migrate-chain-0-1-data');
    const data = require('./data/migrations/chain-0-migrate-migrations.json');
    const migrationsBAK = ChainMigrator.migrations;
    const Migration = ChainMigrator.MigrateMigrations;
    const store = BlockStore.create({
      memory: true,
      network
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      logger: Logger.global,
      network
    };

    let chain;
    beforeEach(async () => {
      await fs.mkdirp(location);
      await store.open();
    });

    afterEach(async () => {
      ChainMigrator.migrations = migrationsBAK;
      await store.close();

      if (chain.opened) {
        await chain.close();
      }

      await rimraf(location);
    });

    for (const tcase of data.cases) {
      it(`should migrate ${tcase.description}`, async () => {
        const before = tcase.before;
        const after = tcase.after;
        const version = tcase.dbVersion;
        const mustMigrate1 = tcase.migrate1;
        assert(typeof version === 'number');
        assert(typeof mustMigrate1 === 'boolean');

        chain = new Chain({
          ...chainOptions,
          ...tcase.options
        });
        let ldb = chain.db.db;

        await ldb.open();
        await fillEntries(ldb, before);
        const batch = ldb.batch();
        writeVersion(batch, chLayout.V.encode(), 'chain', version);
        await batch.write();
        await ldb.close();

        let migrated = false;
        ChainMigrator.migrations = {
          0: Migration,
          1: class extends AbstractMigration {
            async check() {
              if (tcase.options.spv)
                return types.FAKE_MIGRATE;

              if (tcase.options.prune)
                return types.SKIP;

              return types.MIGRATE;
            }

            async migrate() {
              migrated = true;
            }
          }
        };

        chain.options.chainMigrate = 1;
        chain.db.version = 2;

        try {
          await chain.open();
        } catch (e) {
          ;
        }

        ldb = chain.db.db;

        if (mustMigrate1)
          assert(migrated, 'Migration 1 did not run.');
        await checkEntries(ldb, after);
      });
    }
  });

  describe('Migrate ChainState (data)', function() {
    const location = testdir('migrate-chainstate-data');
    const data = require('./data/migrations/chain-1-chainstate.json');
    const migrationsBAK = ChainMigrator.migrations;
    const Migration = ChainMigrator.MigrateChainState;
    const store = BlockStore.create({
      memory: true,
      network
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      logger: Logger.global,
      network
    };

    let chain, ldb;
    before(async () => {
      ChainMigrator.migrations = {};
      await fs.mkdirp(location);
      await store.open();
      chain = new Chain(chainOptions);
      await chain.open();
      ldb = chain.db.db;

      await fillEntries(ldb, data.before);

      await chain.close();
      await store.close();
    });

    after(async () => {
      ChainMigrator.migrations = migrationsBAK;
      await rimraf(location);
    });

    beforeEach(async () => {
      await fs.mkdirp(location);
      await store.open();
    });

    afterEach(async () => {
      await store.close();

      if (chain.opened) {
        await chain.close();
      }
    });

    it('should migrate', async () => {
      ChainMigrator.migrations = {
        0: Migration
      };

      chain.options.chainMigrate = 0;
      try {
        await chain.open();
      } catch (e) {
        ;
      }

      await checkEntries(ldb, data.after);
      await chain.close();
    });
  });

  describe('Migration Blockstore (integration)', function() {
    const location = testdir('migrate-chain-state');
    const migrationsBAK = ChainMigrator.migrations;
    const store = BlockStore.create({
      memory: false,
      prefix: location,
      network
    });

    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      network,
      workers
    };

    let chain, miner, cpu;
    before(async () => {
      ChainMigrator.migrations = {};
      await fs.mkdirp(location);
      await store.ensure();
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
      await store.open();
      await chain.open();
    });

    afterEach(async () => {
      await chain.close();
      await store.close();
      await miner.close();
    });

    const blocks = [];
    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
        blocks.push(block);
      }
    });

    it('should move blocks back to ldb.', async () => {
      const ldb = chain.db.db;

      const ldbBatch = ldb.batch();
      const blocksBatch = store.batch();

      for (const block of blocks) {
        const hash = block.hash();

        // we don't actually have undo blocks with those blocks.
        const undoData = Buffer.alloc(100, 1);
        ldbBatch.put(chLayout.b.encode(hash), block.encode());
        ldbBatch.put(chLayout.u.encode(hash), undoData);
        blocksBatch.pruneBlock(hash);
      }

      await ldbBatch.write();
      await blocksBatch.commit();
    });

    it('should fail getting blocks', async () => {
      for (const minedBlock of blocks) {
        const block = await chain.getBlock(minedBlock.hash());

        assert.strictEqual(block, null);
      }
    });

    it('should migrate data to block store', async () => {
      await chain.close();
      ChainMigrator.migrations = {
        0: ChainMigrator.MigrateBlockStore
      };

      chain.options.chainMigrate = 0;

      // Run the migrations
      await chain.open();
    });

    it('should return blocks and undo data', async () => {
      const undoData = Buffer.alloc(100, 1);
      for (const minedBlock of blocks) {
        const hash = minedBlock.hash();
        const block = await chain.getBlock(hash);
        const undo = await store.readUndo(hash);

        assert.bufferEqual(block.encode(), minedBlock.encode());
        assert.bufferEqual(undo, undoData);
      }
    });
  });

  describe('Migrate BlockStore (data)', function() {
    const location = testdir('migrate-blockstore-data');
    const data = require('./data/migrations/chain-2-blockstore.json');
    const migrationsBAK = ChainMigrator.migrations;
    const Migration = ChainMigrator.MigrateBlockStore;
    const layout = Migration.layout();
    const store = BlockStore.create({
      memory: true,
      network
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      logger: Logger.global,
      network
    };

    const full = {
      name: 'full',
      options: chainOptions,
      data: data.full
    };
    const pruned = {
      name: 'pruned',
      options: {
        ...chainOptions,
        prune: true
      },
      data: data.pruned
    };

    let chain, ldb;
    beforeEach(async () => {
      await fs.mkdirp(location);
      await store.open();
    });

    afterEach(async () => {
      await rimraf(location);
      await store.close();

      if (chain.opened)
        await chain.close();
    });

    after(async () => {
      ChainMigrator.migrations = migrationsBAK;
    });

    for (const tcase of [full, pruned]) {
    it(`should migrate ${tcase.name} node`, async () => {
      ChainMigrator.migrations = {};
      chain = new Chain(tcase.options);
      await chain.open();
      ldb = chain.db.db;

      await fillEntries(ldb, tcase.data);
      await chain.close();

      ChainMigrator.migrations = {
        0: Migration
      };

      chain.options.chainMigrate = 0;

        await chain.open();

      // do we have block entries.
      const blocks = await ldb.range({
        gte: layout.b.min(),
        lte: layout.b.max()
      });

      assert.strictEqual(blocks.length, 0);

      const undos = await ldb.range({
        gte: layout.u.min(),
        lte: layout.u.max()
      });

      assert.strictEqual(undos.length, 0);

      for (const [hexKey, hexValue] of Object.entries(data.full)) {
        // block.
        if (hexKey.slice(0, 2) === 'b'.charCodeAt(0).toString(16)) {
          const key = layout.b.decode(Buffer.from(hexKey, 'hex'));
          const hash = key[0];
          const value = Buffer.from(hexValue, 'hex');

          const block = await store.readBlock(hash);
          assert(block);
          assert.bufferEqual(block, value);
          continue;
        }

        // undo block
        if (hexKey.slice(0, 2) === 'u'.charCodeAt(0).toString(16)) {
          const key = layout.u.decode(Buffer.from(hexKey, 'hex'));
          const hash = key[0];
          const value = Buffer.from(hexValue, 'hex');

          const undo = await store.readUndo(hash);
          assert(undo);
          assert.bufferEqual(undo, value);
        }
      }
    });
    }
  });

  describe('Migration Tree State (integration)', function() {
    const location = testdir('migrate-tree-state');
    const migrationsBAK = ChainMigrator.migrations;
    const store = BlockStore.create({
      memory: false,
      prefix: location,
      network
    });

    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      network,
      workers
    };

    let chain, chaindb, ldb, miner, cpu;
    before(async () => {
      ChainMigrator.migrations = {};
      await fs.mkdirp(location);
      await store.ensure();
      await workers.open();
    });

    after(async () => {
      ChainMigrator.migrations = migrationsBAK;
      await rimraf(location);
      await workers.close();
    });

    beforeEach(async () => {
      chain = new Chain(chainOptions);
      chaindb = chain.db;
      ldb = chaindb.db;
      miner = new Miner({ chain });
      cpu = miner.cpu;

      chaindb.version = 3;

      await miner.open();
      await store.open();
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();

      await store.close();
      await miner.close();
    });

    it('should mine 10 blocks', async () => {
      await chain.open();

      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should throw version check error', async () => {
      // Previous state
      await chain.open();
      const b = ldb.batch();
      b.put(chLayout.s.encode(), Buffer.alloc(32, 0x00));
      writeVersion(b, chLayout.V.encode(), 'chain', 2);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error);
      assert.strictEqual(error.message, VERSION_ERROR);
    });

    it('should enable tree state migration', async () => {
      ChainMigrator.migrations = {
        0: ChainMigrator.MigrateTreeState
      };
    });

    it('should throw when new migration is available', async () => {
      const expected = migrationError(ChainMigrator.migrations, [0],
        chainFlagError(0));

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, expected);
    });

    it('should migrate tree state', async () => {
      chain.options.chainMigrate = 0;

      await chain.open();
      const state = chaindb.treeState;
      const encoded = Buffer.alloc(72, 0);

      encoding.writeU32(encoded, chain.height, 32);
      assert.bufferEqual(state.encode(), encoded);
    });

    it('should migrate tree state (2)', async () => {
      await chain.open();

      const state = MigrationState.decode(await ldb.get(chLayout.M.encode()));
      state.nextMigration = 0;

      // revert migration
      const b = ldb.batch();
      const root = Buffer.alloc(32, 0x01);
      // revert version in DB.
      writeVersion(b, chLayout.V.encode(), 'chain', 2);
      // encode wrong tree state (non default)
      b.put(chLayout.s.encode(), root);
      b.put(chLayout.M.encode(), state.encode());
      await b.write();

      await chain.close();

      chain.options.chainMigrate = 0;
      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      // Now our error should be incorrect tree (after migration)
      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, `Missing node: ${root.toString('hex')}.`);

      const version = getVersion(await ldb.get(chLayout.V.encode()), 'chain');
      assert.strictEqual(version, 3);
      assert.bufferEqual(chaindb.treeState.treeRoot, root);
      assert.bufferEqual(chaindb.treeState.compactionRoot, ZERO_HASH);
      assert.strictEqual(chaindb.treeState.compactionHeight, 0);
    });
  });

  describe('Migration Tree State SPV (integration)', function() {
    const location = testdir('migrate-tree-state-spv');
    const migrationsBAK = ChainMigrator.migrations;

    const workers = new WorkerPool({
      enabled: true,
      size: 2
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      spv: true,
      network,
      workers
    };

    let chain, chaindb, ldb;
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
      chaindb = chain.db;
      ldb = chaindb.db;

      chaindb.version = 3;
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();
    });

    it('should throw version check error', async () => {
      // Previous state
      await chain.open();
      const b = ldb.batch();
      writeVersion(b, chLayout.V.encode(), 'chain', 2);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error);
      assert.strictEqual(error.message, VERSION_ERROR);
    });

    it('should enable tree state migration', async () => {
      ChainMigrator.migrations = {
        0: ChainMigrator.MigrateTreeState
      };
    });

    it('should throw when new migration is available', async () => {
      const expected = migrationError(ChainMigrator.migrations, [0],
        chainFlagError(0));

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
      }

      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, expected);
    });

    it('should migrate db version', async () => {
      chain.options.chainMigrate = 0;

      await chain.open();
      const state = chaindb.treeState;
      const encoded = Buffer.alloc(72, 0);

      encoding.writeU32(encoded, chain.height, 32);
      assert.bufferEqual(state.encode(), encoded);
    });
  });

  describe('Migrate Tree State (data)', function() {
    const location = testdir('migrate-treestate-data');
    const data = require('./data/migrations/chain-3-treestate.json');
    const migrationsBAK = ChainMigrator.migrations;
    const Migration = ChainMigrator.MigrateTreeState;
    const store = BlockStore.create({
      memory: true,
      network
    });

    const chainOptions = {
      prefix: location,
      memory: false,
      blocks: store,
      logger: Logger.global,
      network
    };

    let chain, ldb;
    before(async () => {
      ChainMigrator.migrations = {};
      await fs.mkdirp(location);
      await store.open();
      chain = new Chain(chainOptions);
      chain.db.version = 2;
      await chain.open();
      ldb = chain.db.db;

      await fillEntries(ldb, data.before);

      await chain.close();
      await store.close();
    });

    after(async () => {
      ChainMigrator.migrations = migrationsBAK;
      await rimraf(location);
    });

    beforeEach(async () => {
      await fs.mkdirp(location);
      await store.open();
    });

    afterEach(async () => {
      await store.close();

      if (chain.opened) {
        await chain.close();
      }
    });

    it('should migrate', async () => {
      ChainMigrator.migrations = {
        0: Migration
      };

      chain.options.chainMigrate = 0;
      chain.db.version = 3;
      try {
        await chain.open();
      } catch (e) {
        ;
      }

      await checkEntries(ldb, data.after);
      await chain.close();
    });
  });
});

