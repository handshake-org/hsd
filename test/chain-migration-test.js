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
const {rimraf, testdir} = require('./util/common');

const network = Network.get('regtest');

describe('Chain Migrations', function () {
  describe('Migration ChainState (integration)', function () {
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
      await assert.rejects(async () => {
        await chain.open();
      }, {
        message: 'Database needs migration.'
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
