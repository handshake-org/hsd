/*!
 * wallet.js - wallet object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const {Lock} = require('bmutex');
const base58 = require('bcrypto/lib/encoding/base58');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const cleanse = require('bcrypto/lib/cleanse');
const TXDB = require('./txdb');
const Path = require('./path');
const common = require('./common');
const Address = require('../primitives/address');
const MTX = require('../primitives/mtx');
const Script = require('../script/script');
const CoinView = require('../coins/coinview');
const WalletCoinView = require('./walletcoinview');
const WalletKey = require('./walletkey');
const HDPrivateKey = require('../hd/private');
const HDPublicKey = require('../hd/public');
const Mnemonic = require('../hd/mnemonic');
const HD = require('../hd/hd');
const Output = require('../primitives/output');
const Account = require('./account');
const MasterKey = require('./masterkey');
const policy = require('../protocol/policy');
const consensus = require('../protocol/consensus');
const rules = require('../covenants/rules');
const {Resource} = require('../dns/resource');
const Claim = require('../primitives/claim');
const reserved = require('../covenants/reserved');
const {ownership} = require('../covenants/ownership');
const {states} = require('../covenants/namestate');
const {types} = rules;
const {BufferSet} = require('buffer-map');
const Coin = require('../primitives/coin');
const Outpoint = require('../primitives/outpoint');

/** @typedef {import('bdb').DB} DB */
/** @typedef {ReturnType<DB['batch']>} Batch */
/** @typedef {import('../types').Base58String} Base58String */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../types').Amount} Amount */
/** @typedef {import('../types').Rate} Rate */
/** @typedef {import('../covenants/namestate')} NameState */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('./records').BlockMeta} BlockMeta */
/** @typedef {import('./records').TXRecord} TXRecord */
/** @typedef {import('./txdb').BlockExtraInfo} BlockExtraInfo */
/** @typedef {import('./txdb').Details} Details */
/** @typedef {import('./txdb').Credit} Credit */
/** @typedef {import('./txdb').Balance} Balance */
/** @typedef {import('./txdb').BlindBid} BlindBid */
/** @typedef {import('./txdb').BidReveal} BidReveal */
/** @typedef {import('./txdb').BlindValue} BlindValue */
/** @typedef {import('./txdb').BlockRecord} BlockRecord */
/** @typedef {import('./walletdb')} WalletDB */

/*
 * Constants
 */

const EMPTY = Buffer.alloc(0);

/**
 * @typedef {Object} AddResult
 * @property {Details} details
 * @property {WalletKey[]} derived
 */

/**
 * Wallet
 * @alias module:wallet.Wallet
 * @extends EventEmitter
 */

class Wallet extends EventEmitter {
  /**
   * Create a wallet.
   * @constructor
   * @param {WalletDB} wdb
   * @param {Object} options
   */

  constructor(wdb, options) {
    super();

    assert(wdb, 'WDB required.');

    this.wdb = wdb;
    this.db = wdb.db;
    this.network = wdb.network;
    this.logger = wdb.logger;
    this.writeLock = new Lock();
    this.fundLock = new Lock();

    this.wid = 0;
    /** @type {String|null} */
    this.id = null;
    this.watchOnly = false;
    this.accountDepth = 0;
    this.token = consensus.ZERO_HASH;
    this.tokenDepth = 0;
    this.master = new MasterKey();

    this.txdb = new TXDB(this.wdb);

    this.maxAncestors = policy.MEMPOOL_MAX_ANCESTORS;
    this.absurdFactor = policy.ABSURD_FEE_FACTOR;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @param {Object} options
   */

  fromOptions(options) {
    if (!options)
      return this;

    let key = options.master;
    let mnemonic = options.mnemonic;
    let id, token;

    if (key) {
      if (typeof key === 'string')
        key = HDPrivateKey.fromBase58(key, this.network);

      assert(HDPrivateKey.isHDPrivateKey(key),
        'Must create wallet with hd private key.');
    } else {
      if (typeof mnemonic === 'string')
        mnemonic = new Mnemonic({ phrase: mnemonic });

      if (!mnemonic)
        mnemonic = new Mnemonic({ language: options.language });

      key = HDPrivateKey.fromMnemonic(mnemonic, options.bip39Passphrase);
    }

    this.master.fromKey(key, mnemonic);

    if (options.wid != null) {
      assert((options.wid >>> 0) === options.wid);
      this.wid = options.wid;
    }

    if (options.id) {
      assert(common.isName(options.id), 'Bad wallet ID.');
      id = options.id;
    }

    if (options.watchOnly != null) {
      assert(typeof options.watchOnly === 'boolean');
      this.watchOnly = options.watchOnly;
    }

    if (options.accountDepth != null) {
      assert((options.accountDepth >>> 0) === options.accountDepth);
      this.accountDepth = options.accountDepth;
    }

    if (options.token) {
      assert(Buffer.isBuffer(options.token));
      assert(options.token.length === 32);
      token = options.token;
    }

    if (options.tokenDepth != null) {
      assert((options.tokenDepth >>> 0) === options.tokenDepth);
      this.tokenDepth = options.tokenDepth;
    }

    if (options.maxAncestors != null) {
      assert((options.maxAncestors >>> 0) === options.maxAncestors);
      this.maxAncestors = options.maxAncestors;
    }

    if (options.absurdFactor != null) {
      assert((options.absurdFactor >>> 0) === options.absurdFactor);
      this.absurdFactor = options.absurdFactor;
    }

    if (!id)
      id = this.getID();

    if (!token)
      token = this.getToken(this.tokenDepth);

    this.id = id;
    this.token = token;

    return this;
  }

  /**
   * Instantiate wallet from options.
   * @param {WalletDB} wdb
   * @param {Object} options
   * @returns {Wallet}
   */

  static fromOptions(wdb, options) {
    return new this(wdb).fromOptions(options);
  }

  /**
   * Attempt to intialize the wallet (generating
   * the first addresses along with the lookahead
   * addresses). Called automatically from the
   * walletdb.
   * @param {Object} options
   * @param {(String|Buffer)?} [passphrase]
   * @returns {Promise}
   */

  async init(options, passphrase) {
    if (passphrase)
      await this.master.encrypt(passphrase);

    const account = await this._createAccount(options, passphrase);
    assert(account);

    await this.txdb.open(this);

    this.logger.info('Wallet initialized (%s).', this.id);
  }

  /**
   * Open wallet (done after retrieval).
   * @returns {Promise}
   */

  async open() {
    const account = await this.getAccount(0);

    if (!account)
      throw new Error('Default account not found.');

    await this.txdb.open(this);
    this.logger.info('Wallet opened (%s).', this.id);
  }

  /**
   * Close the wallet, unregister with the database.
   * @returns {Promise}
   */

  async destroy() {
    const unlock1 = await this.writeLock.lock();
    const unlock2 = await this.fundLock.lock();
    try {
      await this.master.destroy();
      this.writeLock.destroy();
      this.fundLock.destroy();
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Add a public account key to the wallet (multisig).
   * Saves the key in the wallet database.
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise<Boolean>}
   */

  async addSharedKey(acct, key) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._addSharedKey(acct, key);
    } finally {
      unlock();
    }
  }

  /**
   * Add a public account key to the wallet without a lock.
   * @private
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise<Boolean>}
   */

  async _addSharedKey(acct, key) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    const result = await account.addSharedKey(b, key);
    await b.write();

    return result;
  }

  /**
   * Remove a public account key from the wallet (multisig).
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise<Boolean>}
   */

  async removeSharedKey(acct, key) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._removeSharedKey(acct, key);
    } finally {
      unlock();
    }
  }

  /**
   * Remove a public account key from the wallet (multisig).
   * @private
   * @param {(Number|String)} acct
   * @param {HDPublicKey} key
   * @returns {Promise<Boolean>}
   */

  async _removeSharedKey(acct, key) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    const result = account.removeSharedKey(b, key);
    await b.write();

    return result;
  }

  /**
   * Change or set master key's passphrase.
   * @param {String|Buffer} passphrase
   * @param {String|Buffer} old
   * @returns {Promise}
   */

  async setPassphrase(passphrase, old) {
    if (old != null)
      await this.decrypt(old);

    await this.encrypt(passphrase);
  }

  /**
   * Encrypt the wallet permanently.
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async encrypt(passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._encrypt(passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Encrypt the wallet permanently, without a lock.
   * @private
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async _encrypt(passphrase) {
    const key = await this.master.encrypt(passphrase, true);
    const b = this.db.batch();

    try {
      await this.wdb.encryptKeys(b, this.wid, key);
    } finally {
      cleanse(key);
    }

    this.save(b);

    await b.write();
  }

  /**
   * Decrypt the wallet permanently.
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async decrypt(passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._decrypt(passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Decrypt the wallet permanently, without a lock.
   * @private
   * @param {String|Buffer} passphrase
   * @returns {Promise}
   */

  async _decrypt(passphrase) {
    const key = await this.master.decrypt(passphrase, true);
    const b = this.db.batch();

    try {
      await this.wdb.decryptKeys(b, this.wid, key);
    } finally {
      cleanse(key);
    }

    this.save(b);

    await b.write();
  }

  /**
   * Generate a new token.
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise<Buffer>}
   */

  async retoken(passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._retoken(passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Generate a new token without a lock.
   * @private
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise<Buffer>}
   */

  async _retoken(passphrase) {
    if (passphrase)
      await this.unlock(passphrase);

    this.tokenDepth += 1;
    this.token = this.getToken(this.tokenDepth);

    const b = this.db.batch();
    this.save(b);

    await b.write();

    return this.token;
  }

  /**
   * Rename the wallet.
   * @param {String} id
   * @returns {Promise}
   */

  async rename(id) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.wdb.rename(this, id);
    } finally {
      unlock();
    }
  }

  /**
   * Rename account.
   * @param {String} acct
   * @param {String} name
   * @returns {Promise}
   */

  async renameAccount(acct, name) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._renameAccount(acct, name);
    } finally {
      unlock();
    }
  }

  /**
   * Rename account without a lock.
   * @private
   * @param {String} acct
   * @param {String} name
   * @returns {Promise}
   */

  async _renameAccount(acct, name) {
    if (!common.isName(name))
      throw new Error('Bad account name.');

    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    if (account.accountIndex === 0)
      throw new Error('Cannot rename default account.');

    if (await this.hasAccount(name))
      throw new Error('Account name not available.');

    const b = this.db.batch();

    this.wdb.renameAccount(b, account, name);

    await b.write();
  }

  /**
   * Lock the wallet, destroy decrypted key.
   */

  async lock() {
    const unlock1 = await this.writeLock.lock();
    const unlock2 = await this.fundLock.lock();
    try {
      await this.master.lock();
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Unlock the key for `timeout` seconds.
   * @param {Buffer|String} passphrase
   * @param {Number?} [timeout=60]
   */

  unlock(passphrase, timeout) {
    return this.master.unlock(passphrase, timeout);
  }

  /**
   * Generate the wallet ID if none was passed in.
   * It is represented as BLAKE2b(m/44->public|magic, 20)
   * converted to an "address" with a prefix
   * of `0x03be04` (`WLT` in base58).
   * @private
   * @returns {Base58String}
   */

  getID() {
    assert(this.master.key, 'Cannot derive id.');

    const key = this.master.key.derive(44);

    const bw = bio.write(37);
    bw.writeBytes(key.publicKey);
    bw.writeU32(this.network.magic);

    const hash = blake2b.digest(bw.render(), 20);

    const b58 = bio.write(23);
    b58.writeU8(0x03);
    b58.writeU8(0xbe);
    b58.writeU8(0x04);
    b58.writeBytes(hash);

    return base58.encode(b58.render());
  }

  /**
   * Generate the wallet api key if none was passed in.
   * It is represented as BLAKE2b(m/44'->private|nonce).
   * @private
   * @param {Number} nonce
   * @returns {Buffer}
   */

  getToken(nonce) {
    if (!this.master.key)
      throw new Error('Cannot derive token.');

    const key = this.master.key.derive(44, true);

    const bw = bio.write(36);
    bw.writeBytes(key.privateKey);
    bw.writeU32(nonce);

    return blake2b.digest(bw.render());
  }

  /**
   * Create an account. Requires passphrase if master key is encrypted.
   * @param {Object} options - See {@link Account} options.
   * @param {(String|Buffer)?} [passphrase]
   * @returns {Promise<Account>}
   */

  async createAccount(options, passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._createAccount(options, passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Create an account without a lock.
   * @param {Object} options - See {@link Account} options.
   * @param {(String|Buffer)?} [passphrase]
   * @returns {Promise<Account>}
   */

  async _createAccount(options, passphrase) {
    let name = options.name;

    if (!name)
      name = this.accountDepth.toString(10);

    if (await this.hasAccount(name))
      throw new Error('Account already exists.');

    await this.unlock(passphrase);

    let key;
    if (this.watchOnly) {
      key = options.accountKey;

      if (typeof key === 'string')
        key = HDPublicKey.fromBase58(key, this.network);

      if (!HDPublicKey.isHDPublicKey(key))
        throw new Error('Must add HD public keys to watch only wallet.');
    } else {
      assert(this.master.key);
      const type = this.network.keyPrefix.coinType;
      key = this.master.key.deriveAccount(44, type, this.accountDepth);
      key = key.toPublic();
    }

    const opt = {
      wid: this.wid,
      id: this.id,
      name: this.accountDepth === 0 ? 'default' : name,
      watchOnly: this.watchOnly,
      accountKey: key,
      accountIndex: this.accountDepth,
      type: options.type,
      m: options.m,
      n: options.n,
      keys: options.keys,
      lookahead: options.lookahead
    };

    const b = this.db.batch();

    const account = Account.fromOptions(this.wdb, opt);

    await account.init(b);

    this.logger.info('Created account %s/%s/%d.',
      account.id,
      account.name,
      account.accountIndex);

    this.accountDepth += 1;
    this.save(b);

    if (this.accountDepth === 1)
      this.increment(b);

    await b.write();

    return account;
  }

  /**
   * Modify an account. Requires passphrase if master key is encrypted.
   * @param {String|Number} acct
   * @param {Object} options
   * @param {String} [passphrase]
   * @returns {Promise<Account>}
   */

  async modifyAccount(acct, options, passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._modifyAccount(acct, options, passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Create an account without a lock.
   * @param {String|Number} acct
   * @param {Object} options
   * @param {(String|Buffer)?} [passphrase]
   * @returns {Promise<Account>}
   */

  async _modifyAccount(acct, options, passphrase) {
    if (!await this.hasAccount(acct))
      throw new Error(`Account ${acct} does not exist.`);

    await this.unlock(passphrase);

    const account = await this.getAccount(acct);
    assert(account);

    const b = this.db.batch();

    if (options.lookahead != null)
      await account.setLookahead(b, options.lookahead);

    await b.write();

    return account;
  }

  /**
   * Ensure an account. Requires passphrase if master key is encrypted.
   * @param {Object} options - See {@link Account} options.
   * @param {(String|Buffer)?} [passphrase]
   * @returns {Promise<Account>}
   */

  async ensureAccount(options, passphrase) {
    const name = options.name;
    const account = await this.getAccount(name);

    if (account)
      return account;

    return this.createAccount(options, passphrase);
  }

  /**
   * List account names and indexes from the db.
   * @returns {Promise<String[]>} - Returns Array.
   */

  getAccounts() {
    return this.wdb.getAccounts(this.wid);
  }

  /**
   * Get all wallet address hashes.
   * @param {(String|Number)?} acct
   * @returns {Promise<Hash[]>}
   */

  getAddressHashes(acct) {
    if (acct != null)
      return this.getAccountHashes(acct);
    return this.wdb.getWalletHashes(this.wid);
  }

  /**
   * Get all account address hashes.
   * @param {String|Number} acct
   * @returns {Promise<Hash[]>} - Returns Array.
   * @throws on non-existent account
   */

  async getAccountHashes(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      throw new Error('Account not found.');

    return this.wdb.getAccountHashes(this.wid, index);
  }

  /**
   * Retrieve an account from the database.
   * @param {Number|String} acct
   * @returns {Promise<Account|null>}
   */

  async getAccount(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      return null;

    const account = await this.wdb.getAccount(this.wid, index);

    if (!account)
      return null;

    account.wid = this.wid;
    account.id = this.id;
    account.watchOnly = this.watchOnly;

    return account;
  }

  /**
   * Lookup the corresponding account name's index.
   * @param {String|Number} acct - Account name/index.
   * @returns {Promise<Number>}
   */

  async getAccountIndex(acct) {
    if (acct == null)
      return -1;

    if (typeof acct === 'number')
      return acct;

    return this.wdb.getAccountIndex(this.wid, acct);
  }

  /**
   * Lookup the corresponding account name's index.
   * @param {(String|Number)?} [acct] - Account name/index.
   * @returns {Promise<Number>}
   * @throws on non-existent account
   */

  async ensureIndex(acct) {
    if (acct == null || acct === -1)
      return -1;

    const index = await this.getAccountIndex(acct);

    if (index === -1)
      throw new Error('Account not found.');

    return index;
  }

  /**
   * Lookup the corresponding account index's name.
   * @param {(String|Number)} index - Account index.
   * @returns {Promise<String|null>}
   */

  async getAccountName(index) {
    if (typeof index === 'string')
      return index;

    return this.wdb.getAccountName(this.wid, index);
  }

  /**
   * Test whether an account exists.
   * @param {Number|String} acct
   * @returns {Promise<Boolean>}
   */

  async hasAccount(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      return false;

    return this.wdb.hasAccount(this.wid, index);
  }

  /**
   * Create a new receiving address (increments receiveDepth).
   * @param {(Number|String)?} acct
   * @returns {Promise<WalletKey>}
   */

  createReceive(acct = 0) {
    return this.createKey(acct, 0);
  }

  /**
   * Create a new change address (increments changeDepth).
   * @param {(Number|String)?} acct
   * @returns {Promise<WalletKey>}
   */

  createChange(acct = 0) {
    return this.createKey(acct, 1);
  }

  /**
   * Create a new address (increments depth).
   * @param {(Number|String)?} acct
   * @param {Number} branch
   * @returns {Promise<WalletKey>}
   */

  async createKey(acct, branch) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._createKey(acct, branch);
    } finally {
      unlock();
    }
  }

  /**
   * Create a new address (increments depth) without a lock.
   * @private
   * @param {(Number|String)?} acct
   * @param {Number} branch
   * @returns {Promise<WalletKey>}
   */

  async _createKey(acct, branch) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    const b = this.db.batch();
    const key = await account.createKey(b, branch);
    await b.write();

    return key;
  }

  /**
   * Save the wallet to the database. Necessary
   * when address depth and keys change.
   * @param {Batch} b
   * @returns {void}
   */

  save(b) {
    return this.wdb.save(b, this);
  }

  /**
   * Increment the wid depth.
   * @param {Batch} b
   * @returns {void}
   */

  increment(b) {
    return this.wdb.increment(b, this.wid);
  }

  /**
   * Test whether the wallet possesses an address.
   * @param {Address|Hash} address
   * @returns {Promise<Boolean>}
   */

  async hasAddress(address) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);
    return path != null;
  }

  /**
   * Get path by address hash.
   * @param {Address|Hash} address
   * @returns {Promise<Path|null>}
   */

  async getPath(address) {
    const hash = Address.getHash(address);
    return this.wdb.getPath(this.wid, hash);
  }

  /**
   * Get path by address hash (without account name).
   * @private
   * @param {Address|Hash} address
   * @returns {Promise<Path|null>}
   */

  async readPath(address) {
    const hash = Address.getHash(address);
    return this.wdb.readPath(this.wid, hash);
  }

  /**
   * Test whether the wallet contains a path.
   * @param {Address|Hash} address
   * @returns {Promise<Boolean>}
   */

  async hasPath(address) {
    const hash = Address.getHash(address);
    return this.wdb.hasPath(this.wid, hash);
  }

  /**
   * Get all wallet paths.
   * @param {(String|Number)?} acct
   * @returns {Promise<Path[]>}
   */

  async getPaths(acct) {
    if (acct != null)
      return this.getAccountPaths(acct);

    return this.wdb.getWalletPaths(this.wid);
  }

  /**
   * Get all account paths.
   * @param {String|Number} acct
   * @returns {Promise<Path[]>}
   */

  async getAccountPaths(acct) {
    const index = await this.getAccountIndex(acct);

    if (index === -1)
      throw new Error('Account not found.');

    const hashes = await this.getAccountHashes(index);
    const name = await this.getAccountName(acct);

    assert(name);

    const result = [];

    for (const hash of hashes) {
      const path = await this.readPath(hash);

      assert(path);
      assert(path.account === index);

      path.name = name;

      result.push(path);
    }

    return result;
  }

  /**
   * Import a keyring (will not exist on derivation chain).
   * Rescanning must be invoked manually.
   * @param {(String|Number)?} acct
   * @param {WalletKey} ring
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async importKey(acct, ring, passphrase) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._importKey(acct, ring, passphrase);
    } finally {
      unlock();
    }
  }

  /**
   * Import a keyring (will not exist on derivation chain) without a lock.
   * @private
   * @param {(String|Number)?} acct
   * @param {WalletKey} ring
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async _importKey(acct, ring, passphrase) {
    if (!this.watchOnly) {
      if (!ring.privateKey)
        throw new Error('Cannot import pubkey into non watch-only wallet.');
    } else {
      if (ring.privateKey)
        throw new Error('Cannot import privkey into watch-only wallet.');
    }

    const hash = ring.getHash();

    if (await this.getPath(hash))
      throw new Error('Key already exists.');

    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    if (account.type !== Account.types.PUBKEYHASH)
      throw new Error('Cannot import into non-pkh account.');

    await this.unlock(passphrase);

    const key = WalletKey.fromRing(account, ring);
    const path = key.toPath();

    if (this.master.encrypted) {
      path.data = this.master.encipher(path.data, path.hash);
      assert(path.data);
      path.encrypted = true;
    }

    const b = this.db.batch();
    await account.savePath(b, path);
    await b.write();
  }

  /**
   * Import a keyring (will not exist on derivation chain).
   * Rescanning must be invoked manually.
   * @param {(String|Number)?} acct
   * @param {Address} address
   * @returns {Promise}
   */

  async importAddress(acct, address) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._importAddress(acct, address);
    } finally {
      unlock();
    }
  }

  /**
   * Import a keyring (will not exist on derivation chain) without a lock.
   * @private
   * @param {(String|Number)?} acct
   * @param {Address} address
   * @returns {Promise}
   */

  async _importAddress(acct, address) {
    if (!this.watchOnly)
      throw new Error('Cannot import address into non watch-only wallet.');

    if (await this.getPath(address))
      throw new Error('Address already exists.');

    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    if (account.type !== Account.types.PUBKEYHASH)
      throw new Error('Cannot import into non-pkh account.');

    const path = Path.fromAddress(account, address);

    const b = this.db.batch();
    await account.savePath(b, path);
    await b.write();
  }

  /**
   * Import a name.
   * Rescanning must be invoked manually.
   * @param {String} name
   * @returns {Promise}
   */

  async importName(name) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._importName(name);
    } finally {
      unlock();
    }
  }

  /**
   * Import a name without a lock.
   * @private
   * @param {String} name
   * @returns {Promise}
   */

  async _importName(name) {
    const nameHash = rules.hashName(name);

    if (await this.txdb.hasNameState(nameHash))
      throw new Error('Name already exists.');

    const b = this.db.batch();
    await this.wdb.addNameMap(b, nameHash, this.wid);
    await b.write();
  }

  /**
   * Fill a transaction with inputs, estimate
   * transaction size, calculate fee, and add a change output.
   * @see MTX#selectCoins
   * @see MTX#fill
   * @param {MTX} mtx - _Must_ be a mutable transaction.
   * @param {Object} [options]
   * @param {(String|Number)?} options.account - If no account is
   * specified, coins from the entire wallet will be filled.
   * @param {String?} options.selection - Coin selection priority. Can
   * be `age`, `random`, or `all`. (default=age).
   * @param {Boolean} options.round - Whether to round to the nearest
   * kilobyte for fee calculation.
   * See {@link TX#getMinFee} vs. {@link TX#getRoundFee}.
   * @param {Rate} options.rate - Rate used for fee calculation.
   * @param {Boolean} options.confirmed - Select only confirmed coins.
   * @param {Boolean} options.free - Do not apply a fee if the
   * transaction priority is high enough to be considered free.
   * @param {Amount?} options.hardFee - Use a hard fee rather than
   * calculating one.
   * @param {Number|Boolean} options.subtractFee - Whether to subtract the
   * fee from existing outputs rather than adding more inputs.
   * @param {Boolean} [force]
   */

  async fund(mtx, options, force) {
    const unlock = await this.fundLock.lock(force);
    try {
      return await this.fill(mtx, options);
    } finally {
      unlock();
    }
  }

  /**
   * Fill a transaction with inputs without a lock.
   * @private
   * @see MTX#selectCoins
   * @see MTX#fill
   * @param {MTX} mtx
   * @param {Object} [options]
   */

  async fill(mtx, options) {
    if (!options)
      options = {};

    const acct = options.account || 0;
    const change = await this.changeAddress(acct);

    if (!change)
      throw new Error('Account not found.');

    let rate = options.rate;
    if (rate == null)
      rate = await this.wdb.estimateFee(options.blocks);

    let coins = options.coins || [];
    assert(Array.isArray(coins));
    if (options.smart) {
      const smartCoins = await this.getSmartCoins(options.account);
      coins = coins.concat(smartCoins);
    } else {
      let availableCoins = await this.getCoins(options.account);
      availableCoins = this.txdb.filterLocked(availableCoins);
      coins = coins.concat(availableCoins);
    }

    await mtx.fund(coins, {
      selection: options.selection,
      round: options.round,
      depth: options.depth,
      hardFee: options.hardFee,
      subtractFee: options.subtractFee,
      subtractIndex: options.subtractIndex,
      changeAddress: change,
      height: this.wdb.height,
      coinbaseMaturity: this.network.coinbaseMaturity,
      rate: rate,
      maxFee: options.maxFee,
      estimate: prev => this.estimateSize(prev)
    });
  }

  /**
   * Get public keys at index based on
   * address and value for nonce generation
   * @param {Address} address
   * @param {Amount} value
   * @returns {Promise<Buffer[]>} public keys
   */

  async _getNoncePublicKeys(address, value) {
    const path = await this.getPath(address.hash);

    if (!path)
      throw new Error('Account not found.');

    const account = await this.getAccount(path.account);

    if (!account)
      throw new Error('Account not found.');

    const hi = (value * (1 / 0x100000000)) >>> 0;
    const lo = value >>> 0;
    const index = (hi ^ lo) & 0x7fffffff;

    const publicKeys = [];
    for (const accountKey of [account.accountKey, ...account.keys])
      publicKeys.push(accountKey.derive(index).publicKey);

    // Use smallest public key
    publicKeys.sort(Buffer.compare);

    return publicKeys;
  }

  /**
   * Generate nonce deterministically
   * based on address (smallest pubkey),
   * name hash, and bid value.
   * @param {Buffer} nameHash
   * @param {Address} address
   * @param {Amount} value
   * @returns {Promise<Buffer>}
   */

  async generateNonce(nameHash, address, value) {
    const publicKeys = await this._getNoncePublicKeys(address, value);
    return blake2b.multi(address.hash, publicKeys[0], nameHash);
  }

  /**
   * Generate nonces deterministically
   * for all keys (in multisig).
   * @param {Buffer} nameHash
   * @param {Address} address
   * @param {Amount} value
   * @returns {Promise<Buffer[]>}
   */

  async generateNonces(nameHash, address, value) {
    const publicKeys = await this._getNoncePublicKeys(address, value);

    // Generate nonces for all public keys
    const nonces = [];
    for (const publicKey of publicKeys)
      nonces.push(blake2b.multi(address.hash, publicKey, nameHash));

    return nonces;
  }

  /**
   * Generate nonce & blind, save nonce.
   * @param {Buffer} nameHash
   * @param {Address} address
   * @param {Amount} value
   * @returns {Promise<Buffer>}
   */

  async generateBlind(nameHash, address, value) {
    const nonce = await this.generateNonce(nameHash, address, value);
    const blind = rules.blind(value, nonce);

    await this.txdb.saveBlind(blind, {value, nonce});
    return blind;
  }

  /**
   * Generate all nonces & blinds, save nonces.
   * @param {Buffer} nameHash
   * @param {Address} address
   * @param {Amount} value
   * @returns {Promise<Buffer[]>}
   */

  async generateBlinds(nameHash, address, value) {
    const nonces = await this.generateNonces(nameHash, address, value);

    const blinds = [];
    for (const nonce of nonces) {
      const blind = rules.blind(value, nonce);
      await this.txdb.saveBlind(blind, {value, nonce});
      blinds.push(blind);
    }

    return blinds;
  }

  /**
   * Make a claim MTX.
   * @param {String} name
   * @param {Object?} [options]
   * @returns {Promise<Object>}
   */

  async _createClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');
    assert(options && typeof options === 'object');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    // Must get this from chain (not walletDB) in case
    // this name has already been claimed by an attacker
    // and we are trying to replace that claim.
    const ns = await this.wdb.getNameStatus(nameHash);

    if (!await this.wdb.isAvailable(nameHash))
      throw new Error('Name is not available.');

    const item = reserved.get(nameHash);
    assert(item);

    let rate = options.rate;
    if (rate == null)
      rate = await this.wdb.estimateFee(options.blocks);

    let size = 5 << 10;
    let vsize = size / consensus.WITNESS_SCALE_FACTOR | 0;
    let proof = null;

    try {
      proof = await ownership.prove(item.target, true);
    } catch (e) {
      ;
    }

    if (proof) {
      const zones = proof.zones;
      const zone = zones.length >= 2
        ? zones[zones.length - 1]
        : null;

      let added = 0;

      // TXT record.
      added += item.target.length; // rrname
      added += 10; // header
      added += 1; // txt size
      added += 200; // max string size

      // RRSIG record size.
      if (!zone || zone.claim.length === 0) {
        added += item.target.length; // rrname
        added += 10; // header
        added += 275; // avg rsa sig size
      }

      const claim = Claim.fromProof(proof);

      size = claim.getSize() + added;

      added /= consensus.WITNESS_SCALE_FACTOR;
      added |= 0;

      vsize = claim.getVirtualSize() + added;
    }

    let minFee = options.fee;

    if (minFee == null)
      minFee = policy.getMinFee(vsize, rate);

    if (this.wdb.height < 1)
      throw new Error('Chain too immature for name claim.');

    let commitHeight = 1;
    if (ns && ns.claimed)
      commitHeight = ns.claimed + 1;

    const commitHash = (await this.wdb.getBlock(commitHeight)).hash;

    let fee = Math.min(item.value, minFee);

    if (ns && !ns.owner.isNull()) {
      const coin = await this.wdb.getCoin(ns.owner.hash, ns.owner.index);
      assert(coin, 'Coin not found for name owner.');
      fee = item.value - coin.value;
    }

    const acct = options.account || 0;
    const address = await this.receiveAddress(acct);

    const txt = ownership.createData(address,
                                     fee,
                                     commitHash,
                                     commitHeight,
                                     network);

    return {
      name,
      proof,
      target: item.target,
      value: item.value,
      size,
      fee,
      address,
      txt
    };
  }

  /**
   * Create and send a claim MTX.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<Object>}
   */

  async createClaim(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createClaim(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a claim proof.
   * @param {String} name
   * @param {Object?} [options]
   * @returns {Promise<Claim>}
   */

  async makeFakeClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error('Name is not reserved.');

    const {proof, txt} = await this._createClaim(name, options);

    if (!proof)
      throw new Error('Could not resolve name.');

    proof.addData([txt]);

    const data = proof.getData(this.network);

    if (!data)
      throw new Error(`No valid DNS commitment found for ${name}.`);

    return Claim.fromProof(proof);
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   */

  async _sendFakeClaim(name, options) {
    const claim = await this.makeFakeClaim(name, options);
    await this.wdb.sendClaim(claim);
    return claim;
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   */

  async sendFakeClaim(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendFakeClaim(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a claim proof.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<Claim>}
   */

  async makeClaim(name, options) {
    if (options == null)
      options = {};

    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    // TODO: Handle expired behavior.
    if (!rules.isReserved(nameHash, height, network))
      throw new Error(`Name is not reserved: ${name}.`);

    const ns = await this.getNameState(nameHash);

    if (ns) {
      if (!ns.isExpired(height, network))
        throw new Error(`Name already claimed: ${name}.`);
    } else {
      if (!await this.wdb.isAvailable(nameHash))
        throw new Error(`Name is not available: ${name}.`);
    }

    const item = reserved.get(nameHash);
    assert(item);

    const proof = await ownership.prove(item.target);
    const data = proof.getData(this.network);

    if (!data)
      throw new Error(`No valid DNS commitment found for ${name}.`);

    return Claim.fromProof(proof);
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<Claim>}
   */

  async _sendClaim(name, options) {
    const claim = await this.makeClaim(name, options);
    await this.wdb.sendClaim(claim);
    return claim;
  }

  /**
   * Create and send a claim proof.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<Claim>}
   */

  async sendClaim(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendClaim(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a open MTX.
   * @param {String} name
   * @param {Number|String} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeOpen(name, acct, mtx) {
    assert(typeof name === 'string');
    assert((acct >>> 0) === acct || typeof acct === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;
    const {icannlockup} = this.wdb.options;

    // TODO: Handle expired behavior.
    if (rules.isReserved(nameHash, height, network))
      throw new Error(`Name is reserved: ${name}.`);

    if (icannlockup && rules.isLockedUp(nameHash, height, network))
      throw new Error(`Name is locked up: ${name}.`);

    if (!rules.hasRollout(nameHash, height, network))
      throw new Error(`Name not yet available: ${name}.`);

    let ns = await this.getNameState(nameHash);

    if (!ns)
      ns = await this.wdb.getNameStatus(nameHash);

    ns.maybeExpire(height, network);

    const start = ns.height;

    if (!ns.isOpening(height, network))
      throw new Error(`Name is not available: ${name}.`);

    if (start !== 0 && start !== height)
      throw new Error(`Name is already opening: ${name}.`);

    const addr = await this.receiveAddress(acct);

    const output = new Output();
    output.address = addr;
    output.value = 0;
    output.covenant.setOpen(nameHash, rawName);

    if (!mtx)
      mtx = new MTX();

    mtx.outputs.push(output);

    if (await this.txdb.isDoubleOpen(mtx))
      throw new Error(`Already sent an open for: ${name}.`);

    return mtx;
  }

  /**
   * Create and finalize an open
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createOpen(name, options) {
    const acct = options ? options.account || 0 : 0;
    const mtx = await this.makeOpen(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize an open
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createOpen(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createOpen(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send an open
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendOpen(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createOpen(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send an open
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendOpen(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendOpen(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a bid MTX.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Number|String} acct
   * @param {MTX?} [mtx]
   * @param {Address?} [addr]
   * @returns {Promise<MTX>}
   */

  async makeBid(name, value, lockup, acct, mtx, addr) {
    assert(typeof name === 'string');
    assert(Number.isSafeInteger(value) && value >= 0);
    assert(Number.isSafeInteger(lockup) && lockup >= 0);
    assert((acct >>> 0) === acct || typeof acct === 'string');
    assert(addr == null || addr instanceof Address);

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    let ns = await this.getNameState(nameHash);

    if (!ns)
      ns = await this.wdb.getNameStatus(nameHash);

    ns.maybeExpire(height, network);

    const start = ns.height;

    if (ns.isOpening(height, network))
      throw new Error(`Name has not reached the bidding phase yet: ${name}.`);

    if (!ns.isBidding(height, network))
      throw new Error(`Name is not available: ${name}.`);

    if (value > lockup)
      throw new Error(
        `Bid (${value}) exceeds lockup value (${lockup}): ${name}.`
      );

    if (!addr)
      addr = await this.receiveAddress(acct);

    const blind = await this.generateBlind(nameHash, addr, value);

    const output = new Output();
    output.address = addr;
    output.value = lockup;
    output.covenant.setBid(nameHash, start, rawName, blind);

    if (!mtx)
      mtx = new MTX();
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a bid
   * MTX without a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createBid(name, value, lockup, options) {
    const acct = options ? options.account || 0 : 0;
    const mtx = await this.makeBid(name, value, lockup, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a bid
   * MTX with a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createBid(name, value, lockup, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBid(name, value, lockup, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a bid MTX.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   */

  async _sendBid(name, value, lockup, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createBid(name, value, lockup, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a bid MTX.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendBid(name, value, lockup, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBid(name, value, lockup, options);
    } finally {
      unlock();
    }
  }

  /**
   * @typedef {Object} CreateAuctionResults
   * @param {MTX} bid
   * @param {MTX} reveal
   */

  /**
   * Create and finalize a bid & a reveal (in advance)
   * MTX with a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<CreateAuctionResults>}
   */

  async createAuctionTXs(name, value, lockup, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createAuctionTXs(name, value, lockup, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and finalize a bid & a reveal (in advance)
   * MTX without a lock.
   * @param {String} name
   * @param {Number} value
   * @param {Number} lockup
   * @param {Object} options
   * @returns {Promise<CreateAuctionResults>}
   */

  async _createAuctionTXs(name, value, lockup, options) {
    const bid = await this._createBid(name, value, lockup, options);

    const bidOuputIndex = bid.outputs.findIndex(o => o.covenant.isBid());
    const bidOutput = bid.outputs[bidOuputIndex];
    const bidCoin = Coin.fromTX(bid, bidOuputIndex, -1);

    // Prepare the data needed to make the reveal in advance
    const nameHash = bidOutput.covenant.getHash(0);
    const height = bidOutput.covenant.getU32(1);

    const coins = [];
    coins.push(bidCoin);

    const blind = bidOutput.covenant.getHash(3);
    const bv = await this.getBlind(blind);
    if (!bv)
      throw new Error(`Blind value not found for name: ${name}.`);
    const { nonce } = bv;

    const reveal = new MTX();
    const output = new Output();
    output.address = bidCoin.address;
    output.value = value;
    output.covenant.setReveal(nameHash, height, nonce);

    reveal.addOutpoint(Outpoint.fromTX(bid, bidOuputIndex));
    reveal.outputs.push(output);

    await this.fill(reveal, { ...options, coins: coins });
    assert(
      reveal.inputs.length === 1,
      'Pre-signed REVEAL must not require additional inputs'
    );

    const finalReveal = await this.finalize(reveal, options);
    return { bid, reveal: finalReveal };
  }

  /**
   * Make a reveal MTX.
   * @param {String} name
   * @param {(Number|String)?} [acct]
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeReveal(name, acct, mtx) {
    assert(typeof name === 'string');

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    ns.maybeExpire(height, network);

    const state = ns.state(height, network);

    if (state < states.REVEAL)
      throw new Error(`Cannot reveal yet: ${name}.`);

    if (state > states.REVEAL)
      throw new Error(`Reveal period has passed: ${name}.`);

    const bids = await this.getBids(nameHash);

    if (!mtx)
      mtx = new MTX();

    let pushed = 0;
    for (const {prevout, own} of bids) {
      if (!own)
        continue;

      const {hash, index} = prevout;
      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      if (acctno != null) {
        if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
          continue;
      }

      // Is local?
      if (coin.height < ns.height)
        continue;

      const blind = coin.covenant.getHash(3);
      const bv = await this.getBlind(blind);

      if (!bv) {
        this.logger.warning(`Blind value not found for name: ${name}.`);
        continue;
      }

      const {value, nonce} = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.setReveal(nameHash, ns.height, nonce);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);
      pushed++;
    }

    if (pushed === 0)
      throw new Error(`No bids to reveal for name: ${name}.`);

    return mtx;
  }

  /**
   * Create and finalize a reveal
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createReveal(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeReveal(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a reveal
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createReveal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createReveal(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a reveal MTX.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendReveal(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createReveal(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a bid MTX.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendReveal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendReveal(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a reveal MTX.
   * @param {MTX?} [mtx]
   * @param {Number?} [witnessSize]
   * @returns {Promise<MTX>}
   */

  async makeRevealAll(mtx, witnessSize) {
    const height = this.wdb.height + 1;
    const network = this.network;
    const bids = await this.getBids();

    if (!mtx)
      mtx = new MTX();
    else
      assert(witnessSize, 'Witness size required for batch size estimation.');

    let pushed = 0;
    for (const {nameHash, prevout, own} of bids) {
      if (!own)
        continue;

      const ns = await this.getNameState(nameHash);
      const name = ns.name;

      if (!ns)
        continue;

      ns.maybeExpire(height, network);

      if (!ns.isReveal(height, network))
        continue;

      const {hash, index} = prevout;
      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      const blind = coin.covenant.getHash(3);
      const bv = await this.getBlind(blind);

      if (!bv) {
        this.logger.warning(`Blind value not found for name: ${name}.`);
        continue;
      }

      const {value, nonce} = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.setReveal(nameHash, ns.height, nonce);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);

      // Keep batches below policy size limit
      if (this.isOversizedBatch(mtx, witnessSize)) {
        mtx.inputs.pop();
        mtx.outputs.pop();
        break;
      }

      pushed++;
    }

    // Ignore in batches
    if (pushed === 0 && !witnessSize)
      throw new Error('No bids to reveal.');

    return mtx;
  }

  /**
   * Create and finalize a reveal all
   * MTX without a lock.
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createRevealAll(options) {
    const mtx = await this.makeRevealAll();
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a reveal all
   * MTX with a lock.
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createRevealAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRevealAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a reveal all MTX.
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendRevealAll(options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRevealAll(options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a bid MTX.
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendRevealAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRevealAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a redeem MTX.
   * @param {String} name
   * @param {(Number|String)?} [acct]
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeRedeem(name, acct, mtx) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    if (!ns.isRedeemable(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    const reveals = await this.txdb.getReveals(nameHash);

    if (!mtx)
      mtx = new MTX();

    let pushed = 0;
    for (const {prevout, own} of reveals) {
      const {hash, index} = prevout;

      if (!own)
        continue;

      // Winner can not redeem
      if (prevout.equals(ns.owner))
        continue;

      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      if (acctno != null) {
        if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
          continue;
      }

      // Is local?
      if (coin.height < ns.height)
        continue;

      mtx.addOutpoint(prevout);

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.setRedeem(nameHash, ns.height);

      mtx.outputs.push(output);
      pushed++;
    }

    if (pushed === 0)
      throw new Error(`No reveals to redeem for name: ${name}.`);

    return mtx;
  }

  /**
   * Create and finalize a redeem
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createRedeem(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeRedeem(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a redeem
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createRedeem(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRedeem(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a redeem
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendRedeem(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRedeem(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a redeem
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendRedeem(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRedeem(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a redeem MTX.
   * @param {MTX?} [mtx]
   * @param {Number?} [witnessSize]
   * @returns {Promise<MTX>}
   */

  async makeRedeemAll(mtx, witnessSize) {
    const height = this.wdb.height + 1;
    const network = this.network;
    const reveals = await this.txdb.getReveals();

    if (!mtx)
      mtx = new MTX();
    else
      assert(witnessSize, 'Witness size required for batch size estimation.');

    let pushed = 0;
    for (const {nameHash, prevout, own} of reveals) {
      const {hash, index} = prevout;

      const ns = await this.getNameState(nameHash);

      if (!ns)
        continue;

      if (ns.isExpired(height, network))
        continue;

      if (!ns.isRedeemable(height, network))
        continue;

      if (!own)
        continue;

      if (prevout.equals(ns.owner))
        continue;

      const coin = await this.getUnspentCoin(hash, index);

      if (!coin)
        continue;

      // Is local?
      if (coin.height < ns.height)
        continue;

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.setRedeem(nameHash, ns.height);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);

      // Keep batches below policy size limit
      if (this.isOversizedBatch(mtx, witnessSize)) {
        mtx.inputs.pop();
        mtx.outputs.pop();
        break;
      }

      pushed++;
    }

    // Ignore in batches
    if (pushed === 0 && !witnessSize)
      throw new Error('No reveals to redeem.');

    return mtx;
  }

  /**
   * Create and finalize a redeem
   * all MTX without a lock.
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createRedeemAll(options) {
    const mtx = await this.makeRedeemAll();
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a redeem
   * all MTX with a lock.
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createRedeemAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRedeemAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a redeem all
   * MTX without a lock.
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendRedeemAll(options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRedeemAll(options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a redeem all
   * MTX with a lock.
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendRedeemAll(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRedeemAll(options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a register MTX.
   * @private
   * @param {String} name
   * @param {Resource?} resource
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async _makeRegister(name, resource, mtx) {
    assert(typeof name === 'string');
    assert(!resource || (resource instanceof Resource));

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet did not win the auction: ${name}.`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: ${name}.`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet did not win the auction: ${name}.`);

    if (!coin.covenant.isReveal() && !coin.covenant.isClaim())
      throw new Error(`Name is not in REVEAL or CLAIM state: ${name}.`);

    if (coin.covenant.isClaim()) {
      if (height < coin.height + network.coinbaseMaturity)
        throw new Error(`Claim is not yet mature: ${name}.`);
    }

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    const output = new Output();
    output.address = coin.address;
    output.value = ns.value;

    let rawResource = EMPTY;

    if (resource) {
      const raw = resource.encode();

      if (raw.length > rules.MAX_RESOURCE_SIZE)
        throw new Error(
          `Resource size (${raw.length}) exceeds maximum `+
          `(${rules.MAX_RESOURCE_SIZE}) for name: ${name}.`
        );

      rawResource = raw;
    }

    const blockHash = await this.wdb.getRenewalBlock();

    output.covenant.setRegister(nameHash, ns.height, rawResource, blockHash);

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Make an update MTX.
   * @param {String} name
   * @param {Resource} resource
   * @param {(Number|String)?} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeUpdate(name, resource, acct, mtx) {
    assert(typeof name === 'string');
    assert(resource instanceof Resource);

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: ${name}.`);

    if (acctno != null) {
      if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
        throw new Error(`Account does not own name: ${name}.`);
    }

    const coin = credit.coin;

    if (coin.covenant.isReveal() || coin.covenant.isClaim())
      return this._makeRegister(name, resource, mtx);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name is not registered: ${name}.`);
    }

    const raw = resource.encode();

    if (raw.length > rules.MAX_RESOURCE_SIZE)
      throw new Error(`Resource exceeds maximum size: ${name}.`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.setUpdate(nameHash, ns.height, raw);

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize an update
   * MTX without a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createUpdate(name, resource, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeUpdate(name, resource, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize an update
   * MTX with a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createUpdate(name, resource, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createUpdate(name, resource, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send an update
   * MTX without a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendUpdate(name, resource, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createUpdate(name, resource, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send an update
   * MTX with a lock.
   * @param {String} name
   * @param {Resource} resource
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendUpdate(name, resource, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendUpdate(name, resource, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a renewal MTX.
   * @private
   * @param {String} name
   * @param {(Number|String)?} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeRenewal(name, acct, mtx) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (credit.spent) {
      throw new Error(`Credit is already pending for: ${name}.`);
    }

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (acctno != null) {
      if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
        throw new Error(`Account does not own name: ${name}.`);
    }

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name is not registered: ${name}.`);
    }

    if (height < ns.renewal + network.names.treeInterval)
      throw new Error(`Can not renew yet: ${name}.`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    const blockHash = await this.wdb.getRenewalBlock();
    output.covenant.setRenew(nameHash, ns.height, blockHash);

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Make a renewal MTX for all expiring names.
   * @param {MTX?} mtx
   * @param {Number?} witnessSize
   * @returns {Promise<MTX>}
   */

  async makeRenewalAll(mtx, witnessSize) {
    // Only allowed in makeBatch
    assert(mtx, 'Batch MTX required for makeRenewalAll.');
    assert(witnessSize, 'Witness size required for batch size estimation.');
    const height = this.wdb.height + 1;
    const network = this.network;
    const names = await this.getNames();

    let expiring = [];
    for (const ns of names) {
      // Easiest check is for expiring time, do that first
      if (ns.isExpired(height, network))
        continue;

      // TODO: Should this factor of 8 be user-configurable?
      // About 90 days on main (1.75 years after REGISTER)
      // 625 blocks on regtest (4375 blocks after REGISTER)
      const blocksLeft = (ns.renewal + network.names.renewalWindow) - height;
      if (blocksLeft >= network.names.renewalWindow / 8)
        continue;

      if (height < ns.renewal + network.names.treeInterval)
        continue; // Can not renew yet

      // Now do the db lookups to see if we own the name
      const {hash, index} = ns.owner;
      const coin = await this.getUnspentCoin(hash, index);
      if (!coin)
        continue;

      if (!coin.covenant.isRegister()
          && !coin.covenant.isUpdate()
          && !coin.covenant.isRenew()
          && !coin.covenant.isFinalize()) {
        continue; // Name is not yet registered
      }

      expiring.push({ns, coin});
    }

    // Ignore in batches
    if (!expiring.length)
      return mtx;

    // Sort by urgency, oldest/lowest renewal heights go first
    expiring.sort((a, b) => {
      return a.ns.renewal - b.ns.renewal;
    });

    // TODO: Should this factor of 6 be user-configurable?
    // Enforce consensus limit per block at a maxmium
    expiring = expiring.slice(0, consensus.MAX_BLOCK_RENEWALS / 6);

    const renewalBlock = await this.wdb.getRenewalBlock();
    for (const {ns, coin} of expiring) {
      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.setRenew(ns.nameHash, ns.height, renewalBlock);

      mtx.addOutpoint(new Outpoint(coin.hash, coin.index));
      mtx.outputs.push(output);

      // Keep batches below policy size limit
      if (this.isOversizedBatch(mtx, witnessSize)) {
        mtx.inputs.pop();
        mtx.outputs.pop();
        break;
      }
    }

    return mtx;
  }

  /**
   * Create and finalize a renewal
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createRenewal(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeRenewal(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a renewal
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createRenewal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRenewal(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a renewal
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendRenewal(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRenewal(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a renewal
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendRenewal(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRenewal(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a transfer MTX.
   * @param {String} name
   * @param {Address} address
   * @param {(Number|String)?} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeTransfer(name, address, acct, mtx) {
    assert(typeof name === 'string');
    assert(address instanceof Address);

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: ${name}.`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (acctno != null) {
      if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
        throw new Error(`Account does not own name: ${name}.`);
    }

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    if (coin.covenant.isTransfer())
      throw new Error(`Name is already being transferred: ${name}.`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name is not registered: ${name}.`);
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.setTransfer(nameHash, ns.height, address);

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a transfer
   * MTX without a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createTransfer(name, address, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeTransfer(name, address, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a transfer
   * MTX with a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createTransfer(name, address, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createTransfer(name, address, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a transfer
   * MTX without a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendTransfer(name, address, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createTransfer(
      name,
      address,
      options
    );
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a transfer
   * MTX with a lock.
   * @param {String} name
   * @param {Address} address
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendTransfer(name, address, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendTransfer(name, address, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a transfer-cancelling MTX.
   * @private
   * @param {String} name
   * @param {(Number|String)?} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeCancel(name, acct, mtx) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const coin = await this.getCoin(hash, index);

    if (!coin)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (acctno != null) {
      if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
        throw new Error(`Account does not own name: ${name}.`);
    }

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    if (!coin.covenant.isTransfer())
      throw new Error(`Name is not being transferred: ${name}.`);

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.setUpdate(nameHash, ns.height, EMPTY);

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a cancel
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createCancel(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeCancel(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a cancel
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createCancel(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createCancel(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a cancel
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendCancel(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createCancel(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a cancel
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendCancel(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendCancel(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a transfer-finalizing MTX.
   * @private
   * @param {String} name
   * @param {(Number|String)?} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeFinalize(name, acct, mtx) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: ${name}.`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (acctno != null) {
      if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
        throw new Error(`Account does not own name: ${name}.`);
    }

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    if (!coin.covenant.isTransfer())
      throw new Error(`Name is not being transferred: ${name}.`);

    if (height < coin.height + network.names.transferLockup)
      throw new Error(`Transfer is still locked up: ${name}.`);

    const version = coin.covenant.getU8(2);
    const addr = coin.covenant.get(3);
    const address = Address.fromHash(addr, version);

    let flags = 0;

    if (ns.weak)
      flags |= 1;

    const output = new Output();
    output.address = address;
    output.value = coin.value;
    output.covenant.setFinalize(
      nameHash,
      ns.height,
      rawName,
      flags,
      ns.claimed,
      ns.renewals,
      await this.wdb.getRenewalBlock()
    );

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Make a finazling MTX for all transferring names
   * @private
   * @param {MTX?} mtx
   * @param {Number?} witnessSize
   * @returns {Promise<MTX>}
   */

  async makeFinalizeAll(mtx, witnessSize) {
    // Only allowed in makeBatch
    assert(mtx, 'Batch MTX required for makeFinalizeAll.');
    assert(witnessSize, 'Witness size required for batch size estimation.');
    const height = this.wdb.height + 1;
    const network = this.network;
    const names = await this.getNames();

    let finalizes = 0;
    for (const ns of names) {
      // Easiest check is for transfer state, do that first
      if (!ns.transfer)
        continue;

      const blocksLeft = (ns.transfer + network.names.transferLockup) - height;
      if (blocksLeft > 0)
        continue;

      // Then check for expiration
      if (ns.isExpired(height, network))
        continue;

      // Now do the db lookups to see if we own the name
      const {hash, index} = ns.owner;
      const coin = await this.getUnspentCoin(hash, index);
      if (!coin)
        continue;

      const version = coin.covenant.getU8(2);
      const addr = coin.covenant.get(3);
      const address = Address.fromHash(addr, version);

      let flags = 0;

      if (ns.weak)
        flags |= 1;

      const output = new Output();
      output.address = address;
      output.value = coin.value;
      output.covenant.setFinalize(
        ns.nameHash,
        ns.height,
        Buffer.from(ns.name, 'ascii'),
        flags,
        ns.claimed,
        ns.renewals,
        await this.wdb.getRenewalBlock()
      );

      mtx.addOutpoint(new Outpoint(coin.hash, coin.index));
      mtx.outputs.push(output);

      // Keep batches below policy size limit
      if (this.isOversizedBatch(mtx, witnessSize)) {
        mtx.inputs.pop();
        mtx.outputs.pop();
        break;
      }

      // TODO: Should this factor of 6 be user-configurable?
      // Enforce consensus limit per block at a maxmium
      finalizes++;
      if (finalizes >= consensus.MAX_BLOCK_RENEWALS / 6)
        break;
    }

    return mtx;
  }

  /**
   * Create and finalize a finalize
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createFinalize(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeFinalize(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a finalize
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createFinalize(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createFinalize(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a finalize
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendFinalize(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createFinalize(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a finalize
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendFinalize(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendFinalize(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a revoke MTX.
   * @param {String} name
   * @param {(Number|String)?} acct
   * @param {MTX?} [mtx]
   * @returns {Promise<MTX>}
   */

  async makeRevoke(name, acct, mtx) {
    assert(typeof name === 'string');

    if (!rules.verifyName(name))
      throw new Error(`Invalid name: ${name}.`);

    let acctno;

    if (acct != null) {
      assert((acct >>> 0) === acct || typeof acct === 'string');
      acctno = await this.getAccountIndex(acct);
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await this.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error(`Auction not found: ${name}.`);

    const {hash, index} = ns.owner;
    const credit = await this.getCredit(hash, index);

    if (!credit)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (credit.spent)
      throw new Error(`Credit is already pending for: ${name}.`);

    if (acctno != null) {
      if (!await this.txdb.hasCoinByAccount(acctno, hash, index))
        throw new Error(`Account does not own name: ${name}.`);
    }

    const coin = credit.coin;

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own name: ${name}.`);

    if (ns.isExpired(height, network))
      throw new Error(`Name has expired: ${name}.`);

    if (!ns.isClosed(height, network))
      throw new Error(`Auction is not yet closed: ${name}.`);

    if (!coin.covenant.isRegister()
        && !coin.covenant.isUpdate()
        && !coin.covenant.isRenew()
        && !coin.covenant.isTransfer()
        && !coin.covenant.isFinalize()) {
      throw new Error(`Name is not registered: ${name}.`);
    }

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;

    output.covenant.setRevoke(nameHash, ns.height);

    if (!mtx)
      mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    return mtx;
  }

  /**
   * Create and finalize a revoke
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createRevoke(name, options) {
    const acct = options ? options.account : null;
    const mtx = await this.makeRevoke(name, acct);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Create and finalize a revoke
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createRevoke(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createRevoke(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a revoke
   * MTX without a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendRevoke(name, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createRevoke(name, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a revoke
   * MTX with a lock.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendRevoke(name, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendRevoke(name, options);
    } finally {
      unlock();
    }
  }

  /**
   * Get account by address.
   * @param {Address} address
   * @returns {Promise<Account?>}
   */

  async getAccountByAddress(address) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);

    if (!path)
      return null;

    return this.getAccount(path.account);
  }

  /**
   * Estimate witness size given output address.
   * Unlike Bitcoin, our signatures are always 65 bytes.
   * However, we still assume that the witness varInt size
   * is only one byte. In short, this estimate may be off
   * by 2 (at most) but only if a witness has > 253 items.
   * Also note we are only processing the witness data here,
   * which will be scaled down by WITNESS_SCALE_FACTOR to compute
   * vsize. Input data like prevout and sequence count as base data
   * and must be added in outside this function.
   * @param {Address} addr
   * @returns {Promise<Number>}
   */

  async estimateSize(addr) {
    const account = await this.getAccountByAddress(addr);

    if (!account)
      return -1;

    let size = 0;

    // Varint witness items length.
    size += 1;

    switch (account.type) {
      case Account.types.PUBKEYHASH:
        // P2PKH
        // varint-len [signature]
        size += 1 + 65;
        // varint-len [key]
        size += 1 + 33;
        break;
      case Account.types.MULTISIG:
        // P2SH Multisig
        // OP_0
        size += 1;
        // varint-len [signature] ...
        size += (1 + 65) * account.m;
        // varint-len [redeem]
        // at 8 pubkeys (n) script size requires 3-byte varInt
        size += account.n > 7 ? 3 : 1;
        // m value
        size += 1;
        // OP_PUSHDATA0 [key] ...
        size += (1 + 33) * account.n;
        // n value
        size += 1;
        // OP_CHECKMULTISIG
        size += 1;
        break;
    }

    return size;
  }

 /**
  * Make a transaction with normal outputs.
  * @param {Object[]} outputs - See {@link MTX#addOutput}
  * @param {MTX?} [mtx] - MTX to modify instead of new one.
  * @returns {MTX} - MTX with populated outputs.
  */

  makeTX(outputs, mtx) {
    assert(Array.isArray(outputs), 'output must be an array.');
    assert(outputs.length > 0, 'At least one output is required.');

    if (!mtx)
      mtx = new MTX();

    // Add the outputs
    for (const obj of outputs) {
      const output = new Output(obj);
      const addr = output.getAddress();

      if (output.isDust())
        throw new Error('Output is dust.');

      if (output.value > 0) {
        if (!addr)
          throw new Error('Cannot send to unknown address.');

        if (addr.isNull())
          throw new Error('Cannot send to null address.');
      }

      mtx.outputs.push(output);
    }

    return mtx;
  }

  /**
   * Build a transaction, fill and finalize without a lock.
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @returns {Promise<MTX>} - MTX with populated inputs and outputs.
   */

  async _createTX(options) {
    const mtx = this.makeTX(options.outputs);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Build a transaction, fill and finalize with a lock.
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @returns {Promise} - Returns {@link MTX}.
   */

  async createTX(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createTX(options);
    } finally {
      unlock();
    }
  }

  /**
   * Make a batch transaction with multiple actions.
   * @param {Array} actions
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async makeBatch(actions, options) {
    assert(Array.isArray(actions));
    assert(actions.length, 'Batches require at least one action.');

    const acct = options ? options.account || 0 : 0;
    const mtx = new MTX();

    // Track estimated size of batch TX to keep it under policy limit
    const address = await this.changeAddress(acct);
    const witnessSize = await this.estimateSize(address);

    // Sort actions so covenants that require linked inputs
    // are pushed first into the mtx input/output arrays.
    // This is a required step otherwise an unlinked
    // covenant like NONE, OPEN, or BID could shift the
    // output array out of sync with their corresponding inputs.
    actions.sort((a, b) => {
      assert(Array.isArray(a));
      assert(Array.isArray(b));
      assert(a.length);
      assert(b.length);

      switch (b[0]) {
        case 'REVEAL':
        case 'REDEEM':
        case 'UPDATE':
        case 'RENEW':
        case 'TRANSFER':
        case 'FINALIZE':
        case 'CANCEL':
        case 'REVOKE':
          return 1;
        default:
          return -1;
      }
    });

    // Some actions accept output addresses to avoid address reuse.
    // We track that by bumping receiveIndex.
    const account = await this.getAccount(acct);
    let receiveIndex = account.receiveDepth - 1;

    // "actions" are arrays that start with a covenant type (or meta-type)
    // followed by the arguments expected by the corresponding "make" function.
    for (const action of actions) {
      const type = action.shift();
      assert(typeof type === 'string');

      switch (type) {
        case 'NONE': {
          assert(action.length === 2);
          this.makeTX([{
            address: action[0],
            value: action[1]
          }], mtx);

          break;
        }
        case 'OPEN': {
          assert(action.length === 1, 'Bad arguments for OPEN.');
          const name = action[0];
          await this.makeOpen(name, acct, mtx);
          break;
        }
        case 'BID': {
          assert(action.length === 3, 'Bad arguments for BID.');
          const address = account.deriveReceive(receiveIndex++).getAddress();
          const name = action[0];
          const value = action[1];
          const lockup = action[2];
          await this.makeBid(name, value, lockup, acct, mtx, address);
          break;
        }
        case 'REVEAL': {
          if (action.length === 1) {
            const name = action[0];
            await this.makeReveal(name, acct, mtx);
            break;
          }

          assert(action.length === 0, 'Bad arguments for REVEAL.');
          await this.makeRevealAll(mtx, witnessSize);
          break;
        }
        case 'REDEEM': {
          if (action.length === 1) {
            const name = action[0];
            await this.makeRedeem(name, acct, mtx);
            break;
          }

          assert(action.length === 0, 'Bad arguments for REDEEM.');
          await this.makeRedeemAll(mtx, witnessSize);
          break;
        }
        case 'UPDATE': {
          assert(action.length === 2, 'Bad arguments for UPDATE.');
          const name = action[0];
          const resource = action[1];
          await this.makeUpdate(name, resource, acct, mtx);
          break;
        }
        case 'RENEW': {
          if (action.length === 1) {
            const name = action[0];
            await this.makeRenewal(name, acct, mtx);
            break;
          }

          assert(action.length === 0, 'Bad arguments for RENEW.');
          await this.makeRenewalAll(mtx, witnessSize);
          break;
        }
        case 'TRANSFER': {
          assert(action.length === 2, 'Bad arguments for TRANSFER.');
          const name = action[0];
          const address = action[1];
          await this.makeTransfer(name, address, acct, mtx);
          break;
        }
        case 'FINALIZE': {
          if (action.length === 1) {
            const name = action[0];
            await this.makeFinalize(name, acct, mtx);
            break;
          }

          assert(action.length === 0, 'Bad arguments for FINALIZE.');
          await this.makeFinalizeAll(mtx, witnessSize);
          break;
        }
        case 'CANCEL': {
          assert(action.length === 1, 'Bad arguments for CANCEL.');
          const name = action[0];
          await this.makeCancel(name, acct, mtx);
          break;
        }
        case 'REVOKE': {
          assert(action.length === 1, 'Bad arguments for REVOKE.');
          const name = action[0];
          await this.makeRevoke(name, acct, mtx);
          break;
        }
        default:
          throw new Error(`Unknown action type: ${type}`);
      }

      if (rules.countOpens(mtx) > consensus.MAX_BLOCK_OPENS)
        throw new Error('Too many OPENs.');

      if (rules.countUpdates(mtx) > consensus.MAX_BLOCK_UPDATES)
        throw new Error('Too many UPDATEs.');

      if (rules.countRenewals(mtx) > consensus.MAX_BLOCK_RENEWALS)
        throw new Error('Too many RENEWs.');
    }

    if (!mtx.outputs.length)
      throw new Error('Nothing to do.');

    // Clean up.
    // 1. Some actions MUST be the ONLY action for a name.
    //    i.e. no duplicate OPENs or REVOKE/FINALIZE for same name in one tx.
    const set = new BufferSet();
    for (const output of mtx.outputs) {
      const {covenant} = output;
      if (!covenant.isName())
        continue;

      const nameHash = covenant.getHash(0);

      switch (covenant.type) {
        case types.CLAIM:
        case types.OPEN:
          output.address = account.deriveReceive(receiveIndex++).getAddress();
          assert(!set.has(nameHash), 'Duplicate name with exclusive action.');
          set.add(nameHash);
          break;
        case types.BID:
        case types.REVEAL:
        case types.REDEEM:
          break;
        case types.REGISTER:
        case types.UPDATE:
        case types.RENEW:
        case types.TRANSFER:
        case types.FINALIZE:
        case types.REVOKE:
          assert(!set.has(nameHash), 'Duplicate name with exclusive action.');
          set.add(nameHash);
          break;
      }

      if (receiveIndex > account.receiveDepth - 1 + account.lookahead)
        throw new Error('Batch output addresses would exceed lookahead.');
    }

    return mtx;
  }

  /**
   * Make a batch transaction with multiple actions.
   * @param {Array} actions
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async _createBatch(actions, options) {
    const mtx = await this.makeBatch(actions, options);
    await this.fill(mtx, options);
    return this.finalize(mtx, options);
  }

  /**
   * Make a batch transaction with multiple actions.
   * @param {Array} actions
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async createBatch(actions, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._createBatch(actions, options);
    } finally {
      unlock();
    }
  }

  /**
   * Create and send a batch transaction with multiple actions.
   * @param {Array} actions
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async _sendBatch(actions, options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createBatch(actions, options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Create and send a batch transaction with multiple actions.
   * @param {Array} actions
   * @param {Object} options
   * @returns {Promise<TX>}
   */

  async sendBatch(actions, options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._sendBatch(actions, options);
    } finally {
      unlock();
    }
  }

  /**
   * Check batch MTX for excessive size
   * @param {MTX} mtx
   * @param {Number} witnessSize
   * @returns {Boolean}
   */

  isOversizedBatch(mtx, witnessSize) {
    if (!witnessSize)
      return false;

    const sizes = mtx.getSizes();

    sizes.base += 40;  // Assume funding input: hash, index, sequence
    sizes.witness += (mtx.inputs.length + 1) // Current inputs plus funding
                     * (witnessSize - 1);    // Replace 0x00 placeholder
    sizes.witness += 1; // the funding input never had a placeholder

    // Assume we need a change output, pay to scripthash address for safety
    sizes.base += 44; // value, p2sh address, NONE covenant

    return sizes.getWeight() > policy.MAX_TX_WEIGHT;
  }

  /**
   * Finalize and template an MTX.
   * @param {MTX} mtx
   * @param {Object} options
   * @returns {Promise<MTX>}
   */

  async finalize(mtx, options) {
    if (!options)
      options = {};

    // Sort members a la BIP69
    if (options.sort !== false)
      mtx.sortMembers();

    // Set the locktime to target value.
    if (options.locktime != null)
      mtx.setLocktime(options.locktime);

    // Consensus sanity checks.
    assert(mtx.isSane(), 'TX failed sanity check.');
    assert(mtx.verifyInputs(this.wdb.height + 1, this.network),
      'TX failed context check.');
    assert(this.wdb.height + 1 >= this.network.txStart,
      'Transactions are not allowed on network yet.');

    // Set the HD paths.
    if (options.paths === true)
      mtx.view = await this.getWalletCoinView(mtx, mtx.view);

    const total = await this.template(mtx);

    if (total === 0)
      throw new Error('Templating failed.');

    return mtx;
  }

  /**
   * Build a transaction, fill it with outputs and inputs,
   * sort the members according to BIP69, set locktime,
   * sign and broadcast. Doing this all in one go prevents
   * coins from being double spent.
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @param {String} options.passphrase
   * @returns {Promise<TX>}
   */

  async send(options) {
    const unlock = await this.fundLock.lock();
    try {
      return await this._send(options);
    } finally {
      unlock();
    }
  }

  /**
   * Build and send a transaction without a lock.
   * @private
   * @param {Object} options - See {@link Wallet#fund options}.
   * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
   * @param {String} options.passphrase
   * @returns {Promise<TX>}
   */

  async _send(options) {
    const passphrase = options ? options.passphrase : null;
    const mtx = await this._createTX(options);
    return this.sendMTX(mtx, passphrase);
  }

  /**
   * Sign and send a (templated) mutable transaction.
   * @param {MTX} mtx
   * @param {String} passphrase
   * @returns {Promise<TX>}
   */

  async sendMTX(mtx, passphrase) {
    await this.sign(mtx, passphrase);

    if (!mtx.isSigned())
      throw new Error('TX could not be fully signed.');

    const tx = mtx.toTX();

    // Policy sanity checks.
    if (tx.getSigops(mtx.view) > policy.MAX_TX_SIGOPS)
      throw new Error('TX exceeds policy sigops.');

    if (tx.getWeight() > policy.MAX_TX_WEIGHT)
      throw new Error('TX exceeds policy weight.');

    const minFee = policy.getMinFee(
      mtx.getVirtualSize(),
      this.network.minRelay
    );

    const absurdFee = minFee * this.absurdFactor;

    const fee = mtx.getFee();

    if (fee < minFee)
      throw new Error('Fee is below minimum relay limit.');

    if (fee > absurdFee)
      throw new Error('Fee exceeds absurd limit.');

    const ancestors = await this.getPendingAncestors(tx);
    if (ancestors.size + 1 > this.maxAncestors)
      throw new Error('TX exceeds maximum unconfirmed ancestors.');

    for (const output of tx.outputs) {
      if (output.isDust())
        throw new Error('Output is dust.');

      if (output.value > 0) {
        if (!output.address)
          throw new Error('Cannot send to unknown address.');

        if (output.address.isNull())
          throw new Error('Cannot send to null address.');
      }
    }

    await this.wdb.addTX(tx);

    this.logger.debug('Sending wallet tx (%s): %x', this.id, tx.hash());

    await this.wdb.send(tx);

    return tx;
  }

  /**
   * Intentionally double-spend outputs by
   * increasing fee for an existing transaction.
   * @param {Hash} hash
   * @param {Rate} rate
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise<TX>}
   */

  async increaseFee(hash, rate, passphrase) {
    assert((rate >>> 0) === rate, 'Rate must be a number.');

    const wtx = await this.getTX(hash);

    if (!wtx)
      throw new Error('Transaction not found.');

    if (wtx.height !== -1)
      throw new Error('Transaction is confirmed.');

    const tx = wtx.tx;

    if (tx.isCoinbase())
      throw new Error('Transaction is a coinbase.');

    const view = await this.getSpentView(tx);

    if (!tx.hasCoins(view))
      throw new Error('Not all coins available.');

    const oldFee = tx.getFee(view);

    const fee = tx.getMinFee(null, rate);

    if (oldFee >= fee)
      throw new Error('Fee is not increasing.');

    const mtx = MTX.fromTX(tx);
    mtx.view = view;

    for (const input of mtx.inputs)
      input.witness.clear();

    let change = null;

    for (let i = 0; i < mtx.outputs.length; i++) {
      const output = mtx.outputs[i];
      const addr = output.getAddress();

      if (!addr)
        continue;

      const path = await this.getPath(addr);

      if (!path)
        continue;

      if (path.branch === 1) {
        change = output;
        mtx.changeIndex = i;
        break;
      }
    }

    if (!change)
      throw new Error('No change output.');

    change.value += oldFee;

    if (mtx.getFee() !== 0)
      throw new Error('Arithmetic error for change.');

    change.value -= fee;

    if (change.value < 0)
      throw new Error('Fee is too high.');

    if (change.isDust()) {
      mtx.outputs.splice(mtx.changeIndex, 1);
      mtx.changeIndex = -1;
    }

    await this.sign(mtx, passphrase);

    if (!mtx.isSigned())
      throw new Error('TX could not be fully signed.');

    const ntx = mtx.toTX();

    this.logger.debug(
      'Increasing fee for wallet tx (%s): %x',
      this.id, ntx.hash());

    await this.wdb.addTX(ntx);
    await this.wdb.send(ntx);

    return ntx;
  }

  /**
   * Resend pending wallet transactions.
   * @returns {Promise}
   */

  async resend() {
    const wtxs = await this.getPending();

    if (wtxs.length > 0)
      this.logger.info('Rebroadcasting %d transactions.', wtxs.length);

    const txs = [];

    for (const wtx of wtxs) {
      if (!wtx.tx.isCoinbase())
        txs.push(wtx.tx);
    }

    const sorted = common.sortDeps(txs);

    for (const tx of sorted)
      await this.wdb.send(tx);

    return txs;
  }

  /**
   * Derive necessary addresses for signing a transaction.
   * @param {MTX} mtx
   * @returns {Promise<WalletKey[]>}
   */

  async deriveInputs(mtx) {
    assert(mtx.mutable);

    const paths = await this.getInputPaths(mtx);
    const rings = [];

    for (const path of paths) {
      const account = await this.getAccount(path.account);

      if (!account)
        continue;

      const ring = account.derivePath(path, this.master);

      if (ring)
        rings.push(ring);
    }

    return rings;
  }

  /**
   * Retrieve a single keyring by address.
   * @param {Address|Hash} address
   * @returns {Promise}
   */

  async getKey(address) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);

    if (!path)
      return null;

    const account = await this.getAccount(path.account);

    if (!account)
      return null;

    // The account index in the db may be wrong.
    // We must read it from the stored xpub to be
    // sure of its correctness.
    //
    // For more details see:
    // https://github.com/bcoin-org/bcoin/issues/698.
    //
    // TODO(boymanjor): remove index manipulation
    // once the watch-only wallet bug is fixed.
    account.accountIndex = account.accountKey.childIndex;

    // Unharden the account index, if necessary.
    if (account.accountIndex & HD.common.HARDENED)
      account.accountIndex ^= HD.common.HARDENED;

    return account.derivePath(path, this.master);
  }

  /**
   * Retrieve a single keyring by address
   * (with the private key reference).
   * @param {Address|Hash} address
   * @param {(Buffer|String)?} passphrase
   * @returns {Promise}
   */

  async getPrivateKey(address, passphrase) {
    const hash = Address.getHash(address);
    const path = await this.getPath(hash);

    if (!path)
      return null;

    const account = await this.getAccount(path.account);

    if (!account)
      return null;

    await this.unlock(passphrase);

    const key = account.derivePath(path, this.master);

    if (!key.privateKey)
      return null;

    return key;
  }

  /**
   * Map input addresses to paths.
   * @param {MTX} mtx
   * @returns {Promise} - Returns {@link Path}[].
   */

  async getInputPaths(mtx) {
    assert(mtx.mutable);

    if (!mtx.hasCoins())
      throw new Error('Not all coins available.');

    const hashes = mtx.getInputHashes();
    const paths = [];

    for (const hash of hashes) {
      const path = await this.getPath(hash);
      if (path)
        paths.push(path);
    }

    return paths;
  }

  /**
   * Map output addresses to paths.
   * @param {TX} tx
   * @returns {Promise<Path[]>}
   */

  async getOutputPaths(tx) {
    const paths = [];
    const hashes = tx.getOutputHashes();

    for (const hash of hashes) {
      const path = await this.getPath(hash);
      if (path)
        paths.push(path);
    }

    return paths;
  }

  /**
   * Sync address depths based on a transaction's outputs.
   * This is used for deriving new addresses when
   * a confirmed transaction is seen.
   * @param {TX} tx
   * @returns {Promise<WalletKey[]>} - derived rings.
   */

  async syncOutputDepth(tx) {
    const map = new Map();

    for (const hash of tx.getOutputHashes()) {
      const path = await this.readPath(hash);

      if (!path)
        continue;

      if (path.index === -1)
        continue;

      if (!map.has(path.account))
        map.set(path.account, []);

      map.get(path.account).push(path);
    }

    const derived = [];
    const b = this.db.batch();

    for (const [acct, paths] of map) {
      let receive = -1;
      let change = -1;

      for (const path of paths) {
        switch (path.branch) {
          case 0:
            if (path.index > receive)
              receive = path.index;
            break;
          case 1:
            if (path.index > change)
              change = path.index;
            break;
        }
      }

      receive += 2;
      change += 2;

      const account = await this.getAccount(acct);
      assert(account);

      const ring = await account.syncDepth(b, receive, change);

      if (ring)
        derived.push(ring);
    }

    await b.write();

    return derived;
  }

  /**
   * Build input scripts templates for a transaction (does not
   * sign, only creates signature slots). Only builds scripts
   * for inputs that are redeemable by this wallet.
   * @param {MTX} mtx
   * @returns {Promise<Number>} - total number of scripts built.
   */

  async template(mtx) {
    const rings = await this.deriveInputs(mtx);
    return mtx.template(rings);
  }

  /**
   * Build input scripts and sign inputs for a transaction. Only attempts
   * to build/sign inputs that are redeemable by this wallet.
   * @param {MTX} mtx
   * @param {String|Buffer} passphrase
   * @returns {Promise} - Returns Number (total number
   * of inputs scripts built and signed).
   */

  async sign(mtx, passphrase) {
    if (this.watchOnly)
      throw new Error('Cannot sign from a watch-only wallet.');

    await this.unlock(passphrase);

    const rings = await this.deriveInputs(mtx);

    return mtx.signAsync(rings, Script.hashType.ALL, this.wdb.workers);
  }

  /**
   * Get pending ancestors up to the policy limit
   * @param {TX} tx
   * @returns {Promise<BufferSet>} - Returns {BufferSet} with Hash
   */

   async getPendingAncestors(tx) {
    return this._getPendingAncestors(tx, new BufferSet());
   }

  /**
   * Get pending ancestors up to the policy limit.
   * @param {TX} tx
   * @param {BufferSet} set
   * @returns {Promise<BufferSet>}
   */

  async _getPendingAncestors(tx, set) {
    for (const {prevout} of tx.inputs) {
      const hash = prevout.hash;

      if (set.has(hash))
        continue;

      if (!await this.hasPending(hash))
        continue;

      set.add(hash);

      if (set.size > this.maxAncestors)
        break;

      const parent = await this.getTX(hash);
      await this._getPendingAncestors(parent.tx, set);

      if (set.size > this.maxAncestors)
        break;
    }

    return set;
  }

  /**
   * Test whether the database has a pending transaction.
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  hasPending(hash) {
    return this.txdb.hasPending(hash);
  }

  /**
   * Get a coin viewpoint.
   * @param {TX} tx
   * @returns {Promise<CoinView>}
   */

  getCoinView(tx) {
    return this.txdb.getCoinView(tx);
  }

  /**
   * Get a wallet coin viewpoint with HD paths.
   * @param {TX} tx
   * @param {CoinView?} [view] - Coins to be used in wallet coin viewpoint.
   * @returns {Promise<WalletCoinView>}
   */

  async getWalletCoinView(tx, view) {
    if (!(view instanceof CoinView))
      view = new CoinView();

    if (!tx.hasCoins(view))
      view = await this.txdb.getCoinView(tx);

    const wview = WalletCoinView.fromCoinView(view);

    for (const input of tx.inputs) {
      const prevout = input.prevout;
      const coin = wview.getCoin(prevout);

      if (!coin)
        continue;

      const path = await this.getPath(coin.address);

      if (!path)
        continue;

      const account = await this.getAccount(path.account);

      if (!account)
        continue;

      // The account index in the db may be wrong.
      // We must read it from the stored xpub to be
      // sure of its correctness.
      //
      // For more details see:
      // https://github.com/bcoin-org/bcoin/issues/698.
      //
      // TODO(boymanjor): remove index manipulation
      // once the watch-only wallet bug is fixed.
      path.account = account.accountKey.childIndex;

      // Unharden the account index, if necessary.
      if (path.account & HD.common.HARDENED)
        path.account ^= HD.common.HARDENED;

      // Add path to the viewpoint.
      wview.addPath(prevout, path);
    }

    return wview;
  }

  /**
   * Get a historical coin viewpoint.
   * @param {TX} tx
   * @returns {Promise<CoinView>}
   */

  getSpentView(tx) {
    return this.txdb.getSpentView(tx);
  }

  /**
   * Convert transaction to transaction details.
   * @param {TXRecord} wtx
   * @returns {Promise<Details>}
   */

  toDetails(wtx) {
    return this.txdb.toDetails(wtx);
  }

  /**
   * Get transaction details.
   * @param {Hash} hash
   * @returns {Promise<Details>}
   */

  getDetails(hash) {
    return this.txdb.getDetails(hash);
  }

  /**
   * Get a coin from the wallet.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Coin>}
   */

  getCoin(hash, index) {
    return this.txdb.getCoin(hash, index);
  }

  /**
   * Get an unspent coin from the wallet.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Coin>}
   */

  async getUnspentCoin(hash, index) {
    const credit = await this.txdb.getCredit(hash, index);

    if (!credit || credit.spent)
      return null;

    return credit.coin;
  }

  /**
   * Get credit from the wallet.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Credit>}
   */

  getCredit(hash, index) {
    return this.txdb.getCredit(hash, index);
  }

  /**
   * Get a transaction from the wallet.
   * @param {Hash} hash
   * @returns {Promise<TXRecord>}
   */

  getTX(hash) {
    return this.txdb.getTX(hash);
  }

  /**
   * List blocks for the wallet.
   * @returns {Promise<BlockRecord[]>}
   */

  getBlocks() {
    return this.txdb.getBlocks();
  }

  /**
   * Get a block from the wallet.
   * @param {Number} height
   * @returns {Promise} - Returns {@link BlockRecord}.
   */

  getBlock(height) {
    return this.txdb.getBlock(height);
  }

  /**
   * Get all names.
   * @returns {Promise<NameState[]>}
   */

  async getNames() {
    return this.txdb.getNames();
  }

  /**
   * Get a name if present.
   * @param {Buffer} nameHash
   * @returns {Promise<NameState>}
   */

  async getNameState(nameHash) {
    return this.txdb.getNameState(nameHash);
  }

  /**
   * Get a name if present.
   * @param {String|Buffer} name
   * @returns {Promise<NameState>}
   */

  async getNameStateByName(name) {
    return this.txdb.getNameState(rules.hashName(name));
  }

  /**
   * Get a blind value if present.
   * @param {Buffer} blind - Blind hash.
   * @returns {Promise<BlindValue>}
   */

  async getBlind(blind) {
    return this.txdb.getBlind(blind);
  }

  /**
   * Get bid
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @returns {Promise<BlindBid?>}
   */

  async getBid(nameHash, outpoint) {
    return this.txdb.getBid(nameHash, outpoint);
  }

  /**
   * Get all bids for name.
   * @param {Buffer} [nameHash]
   * @returns {Promise<BlindBid[]>}
   */

  async getBids(nameHash) {
    return this.txdb.getBids(nameHash);
  }

  /**
   * Get all bids for name.
   * @param {String|Buffer} [name]
   * @returns {Promise<BlindBid[]>}
   */

  async getBidsByName(name) {
    return this.txdb.getBids(name ? rules.hashName(name) : null);
  }

  /**
   * Get bid by reveal.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint - reveal outpoint
   * @returns {Promise<BlindBid?>}
   */

  async getBidByReveal(nameHash, outpoint) {
    return this.txdb.getBidByReveal(nameHash, outpoint);
  }

  /**
   * Get reveal.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint
   * @returns {Promise<BidReveal?>}
   */

  async getReveal(nameHash, outpoint) {
    return this.txdb.getReveal(nameHash, outpoint);
  }

  /**
   * Get all reveals by name.
   * @param {Buffer} nameHash
   * @returns {Promise<BidReveal[]>}
   */

  async getReveals(nameHash) {
    return this.txdb.getReveals(nameHash);
  }

  /**
   * Get all reveals by name.
   * @param {String|Buffer} name
   * @returns {Promise<BidReveal[]>}
   */

  async getRevealsByName(name) {
    return this.txdb.getReveals(name ? rules.hashName(name) : null);
  }

  /**
   * Get reveal for bid.
   * @param {Buffer} nameHash
   * @param {Outpoint} outpoint - bid outpoint
   * @returns {Promise<BidReveal?>}
   */

  async getRevealByBid(nameHash, outpoint) {
    return this.txdb.getRevealByBid(nameHash, outpoint);
  }

  /**
   * Add a transaction to the wallets TX history.
   * @param {TX} tx
   * @param {BlockMeta} [block]
   * @param {BlockExtraInfo} [extra]
   * @returns {Promise<AddResult?>}
   */

  async add(tx, block, extra) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._add(tx, block, extra);
    } finally {
      unlock();
    }
  }

  /**
   * Add a transaction to the wallet without a lock.
   * Potentially resolves orphans.
   * @private
   * @param {TX} tx
   * @param {BlockMeta} [block]
   * @param {BlockExtraInfo} [extra]
   * @returns {Promise<AddResult?>}
   */

  async _add(tx, block, extra) {
    const details = await this.txdb.add(tx, block, extra);

    if (!details)
      return null;

    const derived = await this.syncOutputDepth(tx);

    if (derived.length > 0) {
      this.wdb.emit('address', this, derived);
      this.emit('address', derived);
    }

    return {
      details,
      derived
    };
  }

  /**
   * Revert a block.
   * @param {Number} height
   * @returns {Promise<Number>} - number of txs removed.
   */

  async revert(height) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.txdb.revert(height);
    } finally {
      unlock();
    }
  }

  /**
   * Remove a wallet transaction.
   * @param {Hash} hash
   * @returns {Promise<Details?>}
   */

  async remove(hash) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.txdb.remove(hash);
    } finally {
      unlock();
    }
  }

  /**
   * Recalculate balances
   * @returns {Promise}
   */

  async recalculateBalances() {
    const unlock1 = await this.writeLock.lock();
    const unlock2 = await this.fundLock.lock();

    try {
      return await this.txdb.recalculateBalances();
    } finally {
      unlock2();
      unlock1();
    }
  }

  /**
   * Zap stale TXs from wallet.
   * @param {(Number|String)?} acct
   * @param {Number} age - Age threshold (unix time, default=72 hours).
   * @returns {Promise<Number>}
   */

  async zap(acct, age) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._zap(acct, age);
    } finally {
      unlock();
    }
  }

  /**
   * Zap stale TXs from wallet without a lock.
   * @private
   * @param {(Number|String)?} acct
   * @param {Number} age
   * @returns {Promise<Number>}
   */

  async _zap(acct, age) {
    const account = await this.ensureIndex(acct);
    return this.txdb.zap(account, age);
  }

  /**
   * Abandon transaction.
   * @param {Hash} hash
   * @returns {Promise<Details>} - removed tx details.
   */

  async abandon(hash) {
    const unlock = await this.writeLock.lock();
    try {
      return await this._abandon(hash);
    } finally {
      unlock();
    }
  }

  /**
   * Abandon transaction without a lock.
   * @private
   * @param {Hash} hash
   * @returns {Promise<Details>} - removed tx details.
   */

  _abandon(hash) {
    return this.txdb.abandon(hash);
  }

  /**
   * Lock a single coin.
   * @param {Coin|Outpoint} coin
   */

  lockCoin(coin) {
    return this.txdb.lockCoin(coin);
  }

  /**
   * Unlock a single coin.
   * @param {Coin|Outpoint} coin
   * @returns {Boolean}
   */

  unlockCoin(coin) {
    return this.txdb.unlockCoin(coin);
  }

  /**
   * Unlock all locked coins.
   */

  unlockCoins() {
    return this.txdb.unlockCoins();
  }

  /**
   * Test locked status of a single coin.
   * @param {Coin|Outpoint} coin
   * @returns {Boolean}
   */

  isLocked(coin) {
    return this.txdb.isLocked(coin);
  }

  /**
   * Return an array of all locked outpoints.
   * @returns {Outpoint[]}
   */

  getLocked() {
    return this.txdb.getLocked();
  }

  /**
   * Get all available coins.
   * @param {(String|Number)?} [acct]
   * @returns {Promise<Coin[]>}
   */

  async getCoins(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getCoins(account);
  }

  /**
   * Get all available credits.
   * @param {(String|Number)?} [acct]
   * @returns {Promise<Credit[]>}
   */

  async getCredits(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getCredits(account);
  }

  /**
   * Get "smart" coins.
   * @param {(String|Number)?} acct
   * @returns {Promise<Coin[]>}
   */

  async getSmartCoins(acct) {
    const credits = await this.getCredits(acct);
    const coins = [];

    for (const credit of credits) {
      const coin = credit.coin;

      if (credit.spent)
        continue;

      if (this.txdb.isLocked(coin))
        continue;

      // Always used confirmed coins.
      if (coin.height !== -1) {
        coins.push(coin);
        continue;
      }

      // Use unconfirmed only if they were
      // created as a result of one of our
      // _own_ transactions. i.e. they're
      // not low-fee and not in danger of
      // being double-spent by a bad actor.
      if (!credit.own)
        continue;

      coins.push(coin);
    }

    return coins;
  }

  /**
   * Get all pending/unconfirmed transactions.
   * @param {(String|Number)?} [acct]
   * @returns {Promise<TXRecord[]>}
   */

  async getPending(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getPending(account);
  }

  /**
   * Get wallet balance.
   * @param {(String|Number)?} [acct]
   * @returns {Promise<Balance>}
   */

  async getBalance(acct) {
    const account = await this.ensureIndex(acct);
    return this.txdb.getBalance(account);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistory(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listHistory(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistoryAfter(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listHistoryAfter(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistoryFrom(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listHistoryAfter(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Number} options.time - Time in seconds.
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listHistoryByTime(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listHistoryByTime(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmed(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listUnconfirmed(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmedAfter(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listUnconfirmedAfter(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Buffer} options.hash
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmedFrom(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listUnconfirmedFrom(account, options);
  }

  /**
   * @param {(String|Number)?} acct
   * @param {Object} options
   * @param {Number} options.time - Time in seconds.
   * @param {Number} options.limit
   * @param {Boolean} options.reverse
   * @returns {Promise<TXRecord[]>}
   */

  async listUnconfirmedByTime(acct, options) {
    const account = await this.ensureIndex(acct);
    return this.txdb.listUnconfirmedByTime(account, options);
  }

  /**
   * Get account key.
   * @param {Number} [acct=0]
   * @returns {Promise<HDPublicKey>}
   */

  async accountKey(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.accountKey;
  }

  /**
   * Get current receive depth.
   * @param {Number} [acct=0]
   * @returns {Promise<Number>}
   */

  async receiveDepth(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.receiveDepth;
  }

  /**
   * Get current change depth.
   * @param {Number} [acct=0]
   * @returns {Promise<Number>}
   */

  async changeDepth(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.changeDepth;
  }

  /**
   * Get current receive address.
   * @param {(String|Number)} [acct=0]
   * @returns {Promise<Address>}
   */

  async receiveAddress(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.receiveAddress();
  }

  /**
   * Get current change address.
   * @param {Number} [acct=0]
   * @returns {Promise<Address>}
   */

  async changeAddress(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.changeAddress();
  }

  /**
   * Get current receive key.
   * @param {Number} [acct=0]
   * @returns {Promise<WalletKey>}
   */

  async receiveKey(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.receiveKey();
  }

  /**
   * Get current change key.
   * @param {Number} [acct=0]
   * @returns {Promise<WalletKey>}
   */

  async changeKey(acct = 0) {
    const account = await this.getAccount(acct);

    if (!account)
      throw new Error('Account not found.');

    return account.changeKey();
  }

  /**
   * Convert the wallet to a more inspection-friendly object.
   * @returns {Object}
   */

  format() {
    return {
      wid: this.wid,
      id: this.id,
      network: this.network.type,
      accountDepth: this.accountDepth,
      token: this.token.toString('hex'),
      tokenDepth: this.tokenDepth,
      master: this.master
    };
  }

  /**
   * Convert the wallet to a more inspection-friendly object.
   * @returns {Object}
   */

  inspect() {
    return this.format();
  }

  /**
   * Convert the wallet to an object suitable for
   * serialization.
   * @param {Boolean?} [unsafe] - Whether to include
   * the master key in the JSON.
   * @param {Balance?} [balance]
   * @returns {Object}
   */

  getJSON(unsafe, balance) {
    return {
      network: this.network.type,
      wid: this.wid,
      id: this.id,
      watchOnly: this.watchOnly,
      accountDepth: this.accountDepth,
      token: this.token.toString('hex'),
      tokenDepth: this.tokenDepth,
      master: this.master.getJSON(this.network, unsafe),
      balance: balance ? balance.getJSON(true) : null
    };
  }

  /**
   * Convert the wallet to an object suitable for
   * serialization.
   * @returns {Object}
   */

  toJSON() {
    return this.getJSON(false);
  }

  /**
   * Calculate serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += 41;
    size += this.master.getSize();
    return size;
  }

  /**
   * Serialize the wallet.
   * @returns {Buffer}
   */

  encode() {
    const size = this.getSize();
    const bw = bio.write(size);

    let flags = 0;

    if (this.watchOnly)
      flags |= 1;

    bw.writeU8(flags);
    bw.writeU32(this.accountDepth);
    bw.writeBytes(this.token);
    bw.writeU32(this.tokenDepth);
    this.master.write(bw);

    return bw.render();
  }

  /**
   * Inject properties from serialized data.
   * @param {Buffer} data
   * @returns {this}
   */

  decode(data) {
    const br = bio.read(data);

    const flags = br.readU8();

    this.watchOnly = (flags & 1) !== 0;
    this.accountDepth = br.readU32();
    this.token = br.readBytes(32);
    this.tokenDepth = br.readU32();
    this.master.read(br);

    return this;
  }

  /**
   * Instantiate a wallet from serialized data.
   * @param {WalletDB} wdb
   * @param {Buffer} data
   * @returns {Wallet}
   */

  static decode(wdb, data) {
    return new this(wdb).decode(data);
  }

  /**
   * Test an object to see if it is a Wallet.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isWallet(obj) {
    return obj instanceof Wallet;
  }
}

/*
 * Expose
 */

module.exports = Wallet;
