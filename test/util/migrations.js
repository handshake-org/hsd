/*!
 * migrations.js - Mock chain and migrations for the migration test.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Logger = require('blgr');
const Network = require('../../lib/protocol/network');
const consensus = require('../../lib/protocol/consensus');
const BlockTemplate = require('../../lib/mining/template');
const bdb = require('bdb');

let Migrator = class {};

try {
  const migrator = require('../../lib/migrations/migrator');
  Migrator = migrator.Migrator;
} catch (e) {
  ;
}

const oldMockLayout = {
  V: bdb.key('V'),
  M: bdb.key('M', ['uint32'])
};

const mockLayout = {
  V: bdb.key('V'),
  M: bdb.key('M'),

  // data for testing
  a: bdb.key('a'),
  b: bdb.key('b'),
  c: bdb.key('c'),
  d: bdb.key('d')
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

exports.prefix2hex = function prefix2hex(prefix) {
  return Buffer.from(prefix, 'ascii').toString('hex');
};

exports.dumpDB = async (db, prefixes) => {
  const data = await db.dump();
  const filtered = {};

  for (const [key, value] of Object.entries(data)) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) {
        filtered[key] = value;
        break;
      }
    }
  }

  return filtered;
};

exports.dumpChainDB = async (chaindb, prefixes) => {
  return exports.dumpDB(chaindb.db, prefixes);
};

/**
 * @param {bdb.DB} ldb
 * @param {Object} options
 * @param {Object} options.before - key value pairs to check before.
 * @param {Object} options.after - key value pairs to check.
 * @param {Boolean} options.throw - throw on error.
 * @param {Boolean} options.bail - bail on first error.
 * @param {Boolean} options.logErrors - log errors.
 * @returns {Promise<String[]>} - errors.
 */

exports.checkEntries = async (ldb, options) => {
  const errors = [];

  options.before = options.before || {};
  options.after = options.after || {};

  for (const [key, value] of Object.entries(options.after)) {
    if (errors.length > 0 && options.bail) {
      if (options.throw)
        throw new Error(errors[0]);

      break;
    }

    const bkey = Buffer.from(key, 'hex');
    const bvalue = Buffer.from(value, 'hex');

    const stored = await ldb.get(bkey);

    if (!stored) {
      errors.push(`Value for ${key} not found in db, expected: ${value}`);
      continue;
    }

    if (!bvalue.equals(stored)) {
      errors.push(`Value for ${key}: ${stored.toString('hex')} does not match expected: ${value}`);
      continue;
    }
  }

  // check that entries have been removed.
  for (const [key] of Object.entries(options.before)) {
    // if after also has this key, skip.
    if (options.after[key] != null)
      continue;

    const bkey = Buffer.from(key, 'hex');

    const stored = await ldb.get(bkey);

    if (stored) {
      errors.push(`Value for ${key}: ${stored.toString('hex')} should have been removed.`);
      continue;
    }
  }

  if (options.logErrors && errors.length !== 0) {
    console.error(
      JSON.stringify(errors, null, 2)
    );
  }

  if (errors.length > 0 && options.throw)
    throw new Error(`Check entries failed with ${errors.length} errors.`);

  return errors;
};

exports.fillEntries = async (ldb, data) => {
  const batch = await ldb.batch();

  for (const [key, value] of Object.entries(data)) {
    const bkey = Buffer.from(key, 'hex');
    const bvalue = Buffer.from(value, 'hex');

    batch.put(bkey, bvalue);
  }

  await batch.write();
};

exports.writeVersion = (b, key, name, version) => {
    const value = Buffer.alloc(name.length + 4);

    value.write(name, 0, 'ascii');
    value.writeUInt32LE(version, name.length);

    b.put(key, value);
};

exports.getVersion = (data, name) => {
  const error = 'version mismatch';

  if (data.length !== name.length + 4)
    throw new Error(error);

  if (data.toString('ascii', 0, name.length) !== name)
    throw new Error(error);

  return data.readUInt32LE(name.length);
};

exports.checkVersion = async (ldb, versionDBKey, expectedVersion) => {
  const data = await ldb.get(versionDBKey);
  const version = exports.getVersion(data, 'wallet');

  assert.strictEqual(version, expectedVersion);
};

// Chain generation
const REGTEST_TIME = 1580745078;
const getBlockTime = height => REGTEST_TIME + (height * 10 * 60);

/**
 * Create deterministic block.
 * @param {Object} options
 * @param {Chain} options.chain
 * @param {Miner} options.miner
 * @param {ChainEntry} options.tip
 * @param {Address} options.address
 * @param {Number} options.txno
 * @returns {BlockTemplate}
 */

exports.createBlock = async (options) => {
  const {
    chain,
    miner,
    tip,
    address,
    txno
  } = options;
  const version = await chain.computeBlockVersion(tip);
  const mtp = await chain.getMedianTime(tip);
  const time = getBlockTime(tip.height + 1);

  const state = await chain.getDeployments(time, tip);
  const target = await chain.getTarget(time, tip);
  const root = chain.db.treeRoot();

  const attempt = new BlockTemplate({
    prevBlock: tip.hash,
    treeRoot: root,
    reservedRoot: consensus.ZERO_HASH,
    height: tip.height + 1,
    version: version,
    time: time,
    bits: target,
    mtp: mtp,
    flags: state.flags,
    address: address,
    coinbaseFlags: Buffer.from('Miner for data gen', 'ascii'),
    interval: miner.network.halvingInterval,
    weight: miner.options.reservedWeight,
    sigops: miner.options.reservedSigops
  });

  miner.assemble(attempt);

  const _createCB = attempt.createCoinbase.bind(attempt);
  attempt.createCoinbase = function createCoinbase() {
    const cb = _createCB();
    const wit = Buffer.alloc(8);
    const id = txno;
    // make txs deterministic
    wit.writeUInt32LE(id, 0, true);
    cb.inputs[0].sequence = id;
    cb.inputs[0].witness.setData(1, wit);
    cb.refresh();
    return cb;
  };

  return attempt;
};
