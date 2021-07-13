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
const ChainMigrations = require('../lib/blockchain/migrations');
const MigrationState = require('../lib/migrations/state');
const {
  AbstractMigration,
  types,
  oldLayout
} = require('../lib/migrations/migrations');
const {rimraf, testdir} = require('./util/common');

const network = Network.get('regtest');

describe('Chain Migrations', function() {
  describe('Migration State', function() {
    const location = testdir('migrate-chain-ensure');
    const migrationsBAK = ChainMigrations.migrations;

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

      ChainMigrations.migrations = migrationsBAK;
    });

    afterEach(async () => {
      if (chain.opened)
        await chain.close();

      await rimraf(location);
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

    it('should migrate pre-old migration state', async () => {
      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      const info = ChainMigrations.migrations[1].info();
      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, `Database needs migration.\n${info}`);

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should migrate from first old migration state', async () => {
      await chain.open();
      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      await b.write();
      await chain.close();

      let error;
      try {
        await chain.open();
      } catch (e) {
        error = e;
        chain.opened = false;
      }

      const info = ChainMigrations.migrations[1].info();
      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, `Database needs migration.\n${info}`);

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 0);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
    });

    it('should not migrate from last old migration state', async () => {
      await chain.open();

      const b = ldb.batch();
      b.del(layout.M.encode());
      b.put(oldLayout.M.encode(0), null);
      b.put(oldLayout.M.encode(1), null);
      await b.write();
      await chain.close();

      await chain.open();

      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
    });

    it('should migrate from last old migration state', async () => {
      ChainMigrations.migrations = {
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

      const info = ChainMigrations.migrations[1].info();
      assert(error, 'Chain must throw an error.');
      assert.strictEqual(error.message, `Database needs migration.\n${info}`);

      await ldb.open();
      const rawState = await ldb.get(layout.M.encode());
      const state = MigrationState.decode(rawState);

      assert.strictEqual(state.lastMigration, 1);
      assert.strictEqual(state.skipped.length, 0);
      assert.strictEqual(state.inProgress, false);
      await ldb.close();
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
    const migrationsBAK = ChainMigrations.migrations;

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
      ChainMigrations.migrations = {};
      await fs.mkdirp(location);
      await workers.open();
    });

    after(async () => {
      ChainMigrations.migrations = migrationsBAK;
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
      ChainMigrations.migrations = {
        1: ChainMigrations.MigrateChainState
      };
    });

    it('should throw error when new migration is available', async () => {
      const info = ChainMigrations.migrations[1].info();
      await assert.rejects(async () => {
        await chain.open();
      }, {
        message: `Database needs migration.\n${info}`
      });

      chain.opened = false;
    });

    it('should migrate chain state', async () => {
      chain.options.chainMigrate = true;

      await chain.open();

      assert.bufferEqual(chain.db.state.encode(), correctState.encode(),
        'Chain State did not properly migrate.');

      await chain.close();
    });
  });
});
