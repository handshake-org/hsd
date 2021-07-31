/*!
 * migrations.js - Mock chain and migrations for the migration test.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const Network = require('../../lib/protocol/network');
const bdb = require('bdb');

const {
  Migrator
} = require('../../lib/migrations/migrator');

const oldMockLayout = {
  V: bdb.key('V'),
  M: bdb.key('M', ['uint32'])
};

const mockLayout = {
  V: bdb.key('V'),
  M: bdb.key('M'),

  // data for testing
  a: bdb.key('a'),
  b: bdb.key('a'),
  c: bdb.key('a'),
  d: bdb.key('a')
};

const DB_FLAG_ERROR = 'mock chain needs migration';

/**
 * This could be ChainDB or WalletDB.
 * This will resemble ChainDB because it's easier to illustrate
 * structure of the migrations.
 */

class MockChainDB {
  constructor(options) {
    this.options = new MockChainDBOptions(options);

    this.logger = this.options.logger;
    this.network = this.options.network;

    this.db = bdb.create(this.options);
    this.dbVersion = 0;

    this.spv = this.options.spv;
    this.prune = this.options.prune;

    // This is here for testing purposes.
    this.migrations = new MockChainDBMigrator({
      ...this.options,
      db: this,
      dbVersion: this.dbVersion
    });
  }

  async open() {
    this.logger.debug('Opening mock chaindb.');
    await this.db.open();
    await this.migrations.migrate();
    await this.db.verify(mockLayout.V.encode(), 'chain', this.dbVersion);
  }

  async close() {
    this.logger.debug('Closing mock chaindb.');
    await this.db.close();
  }
}

class MockChainDBOptions {
  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;

    this.prefix = null;
    this.location = null;
    this.memory = true;

    this.spv = false;
    this.prune = false;

    this.migrateFlag = -1;
    this.migrations = null;

    this.fromOptions(options);
  }

  fromOptions(options) {
    assert(options);

    if (options.network != null)
      this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
    }

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      this.spv = options.spv;
    }

    if (options.prune != null) {
      assert(typeof options.prune === 'boolean');
      this.prune = options.prune;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.location = options.prefix;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean');
      this.memory = options.memory;
    }

    if (options.migrateFlag != null) {
      assert(typeof options.migrateFlag === 'number');
      this.migrateFlag = options.migrateFlag;
    }

    if (options.migrations != null) {
      assert(typeof options.migrations === 'object');
      this.migrations = options.migrations;
    }
  }
}

class MockChainDBMigrator extends Migrator {
  constructor(options) {
    super(new MockChainDBMigratorOptions(options));

    this.logger = this.options.logger.context('mock-migrations');
    this.flagError = DB_FLAG_ERROR;
  }
}

class MockChainDBMigratorOptions {
  constructor(options) {
    this.network = options.network;
    this.logger = options.logger;

    this.migrateFlag = options.migrateFlag;
    this.migrations = exports.migrations;

    this.dbVersion = options.dbVersion;
    this.db = options.db;
    this.ldb = options.db.db;
    this.layout = mockLayout;

    this.spv = options.spv;
    this.prune = options.prune;

    this.fromOptions(options);
  }

  fromOptions(options) {
    if (options.migrations != null) {
      assert(typeof options.migrations === 'object');
      this.migrations = options.migrations;
    }
  }
}

exports.migrations = {};
exports.MockChainDB = MockChainDB;
exports.MockChainDBMigrator = MockChainDBMigrator;
exports.mockLayout = mockLayout;
exports.oldMockLayout = oldMockLayout;
exports.DB_FLAG_ERROR = DB_FLAG_ERROR;

exports.migrationError = (migrations, ids, flagError) => {
  let error = 'Database needs migration(s):\n';

  for (const id of ids) {
    const info = migrations[id].info();
    error += `  - ${info.name} - ${info.description}\n`;
  }

  error += flagError;

  return error;
};
