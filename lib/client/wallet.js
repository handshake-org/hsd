/*!
 * wallet.js - http wallet for bcoin
 * Copyright (c) 2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

// NOTE: This is part of generated `hs-client`.
// Don't introduce any unnecessary dependencies to this.

const assert = require('bsert');
const EventEmitter = require('events');
const bcurl = require('bcurl');

/**
 * Wallet Client
 * @alias module:client.WalletClient
 * @extends {bcurl.Client}
 */

class WalletClient extends bcurl.Client {
  /**
   * Create a wallet client.
   * @param {Object?} options
   */

  constructor(options) {
    super(options);
    this.wallets = new Map();
  }

  /**
   * Open the client.
   */

  init() {
    this.bind('tx', (id, details) => {
      this.dispatch(id, 'tx', details);
    });

    this.bind('confirmed', (id, details) => {
      this.dispatch(id, 'confirmed', details);
    });

    this.bind('unconfirmed', (id, details) => {
      this.dispatch(id, 'unconfirmed', details);
    });

    this.bind('conflict', (id, details) => {
      this.dispatch(id, 'conflict', details);
    });

    this.bind('updated', (id, details) => {
      this.dispatch(id, 'updated', details);
    });

    this.bind('address', (id, receive) => {
      this.dispatch(id, 'address', receive);
    });

    this.bind('balance', (id, balance) => {
      this.dispatch(id, 'balance', balance);
    });
  }

  /**
   * Dispatch event.
   * @private
   */

  dispatch(id, event, ...args) {
    const wallet = this.wallets.get(id);

    if (wallet)
      wallet.emit(event, ...args);
  }

  /**
   * Open the client.
   * @returns {Promise}
   */

  async open() {
    await super.open();
    this.init();
  }

  /**
   * Close the client.
   * @returns {Promise}
   */

  async close() {
    await super.close();
    this.wallets = new Map();
  }

  /**
   * Auth with server.
   * @returns {Promise}
   */

  async auth() {
    await this.call('auth', this.password);
  }

  /**
   * Make an RPC call.
   * @returns {Promise}
   */

  execute(name, params) {
    return super.execute('/', name, params);
  }

  /**
   * Create a wallet object.
   * @param {String} id
   * @param {String} [token]
   * @returns {Wallet}
   */

  wallet(id, token) {
    return new Wallet(this, id, token);
  }

  /**
   * Join a wallet.
   */

  all(token) {
    return this.call('join', '*', token);
  }

  /**
   * Leave a wallet.
   */

  none() {
    return this.call('leave', '*');
  }

  /**
   * Join a wallet.
   */

  join(id, token) {
    return this.call('join', id, token);
  }

  /**
   * Leave a wallet.
   */

  leave(id) {
    return this.call('leave', id);
  }

  /**
   * Rescan the chain.
   * @param {Number} height
   * @returns {Promise}
   */

  rescan(height) {
    return this.post('/rescan', { height });
  }

  /**
   * Resend pending transactions.
   * @returns {Promise}
   */

  resend() {
    return this.post('/resend');
  }

  /**
   * Backup the walletdb.
   * @param {String} path
   * @returns {Promise}
   */

  backup(path) {
    return this.post('/backup', { path });
  }

  /**
   * Get list of all wallet IDs.
   * @returns {Promise}
   */

  getWallets() {
    return this.get('/wallet');
  }

  /**
   * Create a wallet.
   * @param {Object} options
   * @returns {Promise}
   */

  createWallet(id, options) {
    if (id == null)
      throw new Error('Wallet id is required.');

    return this.put(`/wallet/${id}`, options);
  }

  /**
   * Get wallet transaction history.
   * @param {String} id - wallet id
   * @param {Object} options
   * @param {String|Number} [options.account=-1]
   * @param {Number} [options.limit]
   * @param {Boolean} [options.reverse=false]
   * @param {Hash} [options.after]
   * @param {Number} [options.time]
   * @returns {Promise}
   */

  getHistory(id, options) {
    return this.get(`/wallet/${id}/tx/history`, options);
  }

  /**
   * Get wallet coins.
   * @param {String} account
   * @returns {Promise}
   */

  getCoins(id, account) {
    return this.get(`/wallet/${id}/coin`, { account });
  }

  /**
   * Get all unconfirmed transactions.
   * @param {String} id - wallet id
   * @param {Object} options
   * @param {String|Number} [options.account=-1]
   * @param {Number} [options.limit]
   * @param {Boolean} [options.reverse=false]
   * @param {Hash} [options.after]
   * @param {Number} [options.time]
   * @returns {Promise}
   */

  getPending(id, options) {
    return this.get(`/wallet/${id}/tx/unconfirmed`, options);
  }

  /**
   * Calculate wallet balance.
   * @param {String} account
   * @returns {Promise}
   */

  getBalance(id, account) {
    return this.get(`/wallet/${id}/balance`, { account });
  }

  /**
   * Get transaction (only possible if the transaction
   * is available in the wallet history).
   * @param {Hash} hash
   * @returns {Promise}
   */

  getTX(id, hash) {
    return this.get(`/wallet/${id}/tx/${hash}`);
  }

  /**
   * Get wallet blocks.
   * @param {Number} height
   * @returns {Promise}
   */

  getBlocks(id) {
    return this.get(`/wallet/${id}/block`);
  }

  /**
   * Get wallet block.
   * @param {Number} height
   * @returns {Promise}
   */

  getBlock(id, height) {
    return this.get(`/wallet/${id}/block/${height}`);
  }

  /**
   * Get unspent coin (only possible if the transaction
   * is available in the wallet history).
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise}
   */

  getCoin(id, hash, index) {
    return this.get(`/wallet/${id}/coin/${hash}/${index}`);
  }

  /**
   * Get name state for the given name.
   * {@see hsd.NameState}
   * @param {String} id
   * @param {String} name
   * @param {Object} [options]
   * @param {Boolean} [options.own=false]
   * @returns {Promise}
   */

  getName(id, name, options) {
    return this.get(`/wallet/${id}/name/${name}`, options);
  }

  /**
   * Get name state for all names
   * that the wallet is managing.
   * {@see hsd.NameState}
   * @param {String} id
   * @param {Object} [options]
   * @param {Boolean} [options.own=false]
   * @returns {Promise}
   */

  getNames(id, options) {
    return this.get(`/wallet/${id}/name`, options);
  }

  /**
   * Get bids, reveals and name state
   * for the given name.
   * {@see hsd.NameState}
   * {@see hsd.BlindBid}
   * {@see hsd.BidReveal}
   * @param {String} id
   * @param {String} name
   * @returns {Promise}
   */

  getAuctionByName(id, name) {
    return this.get(`/wallet/${id}/auction/${name}`);
  }

  /**
   * Get bids, reveals and name state
   * for all names the wallet manages.
   * {@see hsd.NameState}
   * {@see hsd.BlindBid}
   * {@see hsd.BidReveal}
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  getAuctions(id, options) {
    return this.get(`/wallet/${id}/auction`, options);
  }

  /**
   * Get bids for a given name.
   * {@see hsd.BlindBid}
   * @param {String} id
   * @param {String?} name
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getBidsByName(id, name, options) {
    return this.get(`/wallet/${id}/bid/${name}`, options);
  }

  /**
   * Get bids for all names.
   * the wallet manages.
   * {@see hsd.BlindBid}
   * @param {String} id
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getBids(id, options) {
    return this.get(`/wallet/${id}/bid`, options);
  }

  /**
   * Get wallet reveal for a given name.
   * {@see hsd.BidReveal}
   * @param {String} id
   * @param {String?} name
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getRevealsByName(id, name, options) {
    return this.get(`/wallet/${id}/reveal/${name}`, options);
  }

  /**
   * Get wallet reveals for all names
   * the wallet manages.
   * {@see hsd.BidReveal}
   * @param {String} id
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getReveals(id, options) {
    return this.get(`/wallet/${id}/reveal`, options);
  }

  /**
   * Get name resource.
   * {@see hsd.Resource}
   * @param {String} id
   * @param {String} name
   * @returns {Promise}
   */

  getResource(id, name) {
    return this.get(`/wallet/${id}/resource/${name}`);
  }

  /*
   * Deterministically regenerate a bid's nonce.
   * @param {String} id
   * @param {String} name
   * @param {Object} options
   * @param {String} options.address
   * @param {Number} options.bid
   * @returns {Promise}
   */

  getNonce(id, name, options) {
    return this.get(`/wallet/${id}/nonce/${name}`, options);
  }

  /**
   * @param {Number} now - Current time.
   * @param {Number} age - Age delta.
   * @returns {Promise}
   */

  zap(id, account, age) {
    return this.post(`/wallet/${id}/zap`, { account, age });
  }

  /**
   * @param {Number} id
   * @param {Hash} hash
   * @returns {Promise}
   */

  abandon(id, hash) {
    return this.del(`/wallet/${id}/tx/${hash}`);
  }

  /**
   * Create a transaction, fill.
   * @param {Object} options
   * @returns {Promise}
   */

  createTX(id, options) {
    return this.post(`/wallet/${id}/create`, options);
  }

  /**
   * Create pre-signed bid and reveal txs,
   * fill, and optionally sign and broadcast.
   * @param {Object} options
   * @param {String} options.name
   * @param {Number} options.bid
   * @param {Number} options.lockup
   * @param {String} options.passphrase
   * @param {Boolean} options.sign
   * @param {Boolean} options.broadcastBid
   * @returns {Promise}
   */

  createAuctionTXs(id, options) {
    return this.post(`/wallet/${id}/auction`, options);
  }

  /**
   * Create a transaction, fill, sign, and broadcast.
   * @param {Object} options
   * @param {String} options.address
   * @param {Amount} options.value
   * @returns {Promise}
   */

  send(id, options) {
    return this.post(`/wallet/${id}/send`, options);
  }

  /**
   * Create open transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createOpen(id, options) {
    return this.post(`/wallet/${id}/open`, options);
  }

  /**
   * Create bid transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createBid(id, options) {
    return this.post(`/wallet/${id}/bid`, options);
  }

  /**
   * Create reveal transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createReveal(id, options) {
    return this.post(`/wallet/${id}/reveal`, options);
  }

  /**
   * Create redeem transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createRedeem(id, options) {
    return this.post(`/wallet/${id}/redeem`, options);
  }

  /**
   * Create update transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createUpdate(id, options) {
    return this.post(`/wallet/${id}/update`, options);
  }

  /**
   * Create renewal transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createRenewal(id, options) {
    return this.post(`/wallet/${id}/renewal`, options);
  }

  /**
   * Create transfer transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createTransfer(id, options) {
    return this.post(`/wallet/${id}/transfer`, options);
  }

  /**
   * Create cancel transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createCancel(id, options) {
    return this.post(`/wallet/${id}/cancel`, options);
  }

  /**
   * Create finalize transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createFinalize(id, options) {
    return this.post(`/wallet/${id}/finalize`, options);
  }

  /**
   * Create revoke transaction.
   * @param {String} id
   * @param {Object} options
   * @returns {Promise}
   */

  createRevoke(id, options) {
    return this.post(`/wallet/${id}/revoke`, options);
  }

  /**
   * Sign a transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  sign(id, options) {
    return this.post(`/wallet/${id}/sign`, options);
  }

  /**
   * Get the raw wallet JSON.
   * @returns {Promise}
   */

  getInfo(id) {
    return this.get(`/wallet/${id}`);
  }

  /**
   * Get wallet accounts.
   * @returns {Promise} - Returns Array.
   */

  getAccounts(id) {
    return this.get(`/wallet/${id}/account`);
  }

  /**
   * Get wallet master key.
   * @returns {Promise}
   */

  getMaster(id) {
    return this.get(`/wallet/${id}/master`);
  }

  /**
   * Get wallet account.
   * @param {String} account
   * @returns {Promise}
   */

  getAccount(id, account) {
    return this.get(`/wallet/${id}/account/${account}`);
  }

  /**
   * Create account.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise}
   */

  createAccount(id, name, options) {
    if (name == null)
      throw new Error('Account name is required.');

    return this.put(`/wallet/${id}/account/${name}`, options);
  }

  /**
   * Modify account.
   * @param {String} id
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<Object>}
   */

  modifyAccount(id, name, options) {
    return this.patch(`/wallet/${id}/account/${name}`, options);
  }

  /**
   * Create address.
   * @param {Object} options
   * @returns {Promise}
   */

  createAddress(id, account) {
    return this.post(`/wallet/${id}/address`, { account });
  }

  /**
   * Create change address.
   * @param {Object} options
   * @returns {Promise}
   */

  createChange(id, account) {
    return this.post(`/wallet/${id}/change`, { account });
  }

  /**
   * Change or set master key`s passphrase.
   * @param {String|Buffer} passphrase
   * @param {(String|Buffer)?} old
   * @returns {Promise}
   */

  setPassphrase(id, passphrase, old) {
    return this.post(`/wallet/${id}/passphrase`, { passphrase, old });
  }

  /**
   * Generate a new token.
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  retoken(id, passphrase) {
    return this.post(`/wallet/${id}/retoken`, {
      passphrase
    });
  }

  /**
   * Import private key.
   * @param {Number|String} account
   * @param {String} key
   * @returns {Promise}
   */

  importPrivate(id, account, privateKey, passphrase) {
    return this.post(`/wallet/${id}/import`, {
      account,
      privateKey,
      passphrase
    });
  }

  /**
   * Import public key.
   * @param {Number|String} account
   * @param {String} key
   * @returns {Promise}
   */

  importPublic(id, account, publicKey) {
    return this.post(`/wallet/${id}/import`, {
      account,
      publicKey
    });
  }

  /**
   * Import address.
   * @param {Number|String} account
   * @param {String} address
   * @returns {Promise}
   */

  importAddress(id, account, address) {
    return this.post(`/wallet/${id}/import`, { account, address });
  }

  /**
   * Lock a coin.
   * @param {String} hash
   * @param {Number} index
   * @returns {Promise}
   */

  lockCoin(id, hash, index) {
    return this.put(`/wallet/${id}/locked/${hash}/${index}`);
  }

  /**
   * Unlock a coin.
   * @param {String} hash
   * @param {Number} index
   * @returns {Promise}
   */

  unlockCoin(id, hash, index) {
    return this.del(`/wallet/${id}/locked/${hash}/${index}`);
  }

  /**
   * Get locked coins.
   * @returns {Promise}
   */

  getLocked(id) {
    return this.get(`/wallet/${id}/locked`);
  }

  /**
   * Lock wallet.
   * @returns {Promise}
   */

  lock(id) {
    return this.post(`/wallet/${id}/lock`);
  }

  /**
   * Unlock wallet.
   * @param {String} passphrase
   * @param {Number} timeout
   * @returns {Promise}
   */

  unlock(id, passphrase, timeout) {
    return this.post(`/wallet/${id}/unlock`, { passphrase, timeout });
  }

  /**
   * Get wallet key.
   * @param {String} address
   * @returns {Promise}
   */

  getKey(id, address) {
    return this.get(`/wallet/${id}/key/${address}`);
  }

  /**
   * Get wallet key WIF dump.
   * @param {String} address
   * @param {String?} passphrase
   * @returns {Promise}
   */

  getWIF(id, address, passphrase) {
    return this.get(`/wallet/${id}/wif/${address}`, { passphrase });
  }

  /**
   * Add a public account key to the wallet for multisig.
   * @param {String} account
   * @param {String} key - Account (bip44) key (base58).
   * @returns {Promise}
   */

  addSharedKey(id, account, accountKey) {
    return this.put(`/wallet/${id}/shared-key`, { account, accountKey });
  }

  /**
   * Remove a public account key to the wallet for multisig.
   * @param {String} account
   * @param {String} key - Account (bip44) key (base58).
   * @returns {Promise}
   */

  removeSharedKey(id, account, accountKey) {
    return this.del(`/wallet/${id}/shared-key`, { account, accountKey });
  }

  /**
   * Resend wallet transactions.
   * @returns {Promise}
   */

  resendWallet(id) {
    return this.post(`/wallet/${id}/resend`);
  }
}

/**
 * Wallet Instance
 * @extends {EventEmitter}
 */

class Wallet extends EventEmitter {
  /**
   * Create a wallet client.
   * @param {WalletClient} parent
   * @param {String} id
   * @param {String} [token]
   */

  constructor(parent, id, token) {
    super();

    /** @type {WalletClient} */
    this.parent = parent;

    /** @type {WalletClient} */
    this.client = parent.clone();
    this.client.token = token;

    /** @type {String} */
    this.id = id;

    /** @type {String} */
    this.token = token;
  }

  /**
   * Open wallet.
   * @returns {Promise}
   */

  async open() {
    await this.parent.join(this.id, this.token);
    this.parent.wallets.set(this.id, this);
  }

  /**
   * Close wallet.
   * @returns {Promise}
   */

  async close() {
    await this.parent.leave(this.id);
    this.parent.wallets.delete(this.id);
  }

  /**
   * Get wallet transaction history.
   * @param {Object} options
   * @param {Number} [options.limit]
   * @param {Boolean} [options.reverse=false]
   * @param {Hash} [options.after]
   * @param {Number} [options.time]
   * @returns {Promise<TX[]>}
   */

  getHistory(options) {
    return this.client.getHistory(this.id, options);
  }

  /**
   * Get wallet coins.
   * @param {String} account
   * @returns {Promise}
   */

  getCoins(account) {
    return this.client.getCoins(this.id, account);
  }

  /**
   * Get all unconfirmed transactions.
   * @param {Object} options
   * @param {String|Number} [options.account=-1]
   * @param {Number} [options.limit]
   * @param {Boolean} [options.reverse=false]
   * @param {Hash} [options.after]
   * @param {Number} [options.time]
   * @returns {Promise}
   */

  getPending(options) {
    return this.client.getPending(this.id, options);
  }

  /**
   * Calculate wallet balance.
   * @param {String} account
   * @returns {Promise}
   */

  getBalance(account) {
    return this.client.getBalance(this.id, account);
  }

  /**
   * Get transaction (only possible if the transaction
   * is available in the wallet history).
   * @param {Hash} hash
   * @returns {Promise}
   */

  getTX(hash) {
    return this.client.getTX(this.id, hash);
  }

  /**
   * Get wallet blocks.
   * @param {Number} height
   * @returns {Promise}
   */

  getBlocks() {
    return this.client.getBlocks(this.id);
  }

  /**
   * Get wallet block.
   * @param {Number} height
   * @returns {Promise}
   */

  getBlock(height) {
    return this.client.getBlock(this.id, height);
  }

  /**
   * Get unspent coin (only possible if the transaction
   * is available in the wallet history).
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise}
   */

  getCoin(hash, index) {
    return this.client.getCoin(this.id, hash, index);
  }

  /**
   * Get name state for the given name.
   * {@see hsd.NameState}
   * @param {String} name
   * @param {Object} [options]
   * @param {Boolean} [options.own=false]
   * @returns {Promise}
   */

  getName(name, options) {
    return this.client.getName(this.id, name, options);
  }

  /**
   * Get name state for all names
   * that the wallet is managing.
   * {@see hsd.NameState}
   * @param {Object} [options]
   * @param {Boolean} [options.own=false]
   * @returns {Promise}
   */

  getNames(options) {
    return this.client.getNames(this.id, options);
  }

  /**
   * Get bids, reveals and name state
   * for the given name.
   * {@see hsd.NameState}
   * {@see hsd.BlindBid}
   * {@see hsd.BidReveal}
   * @param {String} name
   * @returns {Promise}
   */

  getAuctionByName(name) {
    return this.client.getAuctionByName(this.id, name);
  }

  /**
   * Get bids, reveals and name state
   * for all names the wallet manages.
   * {@see hsd.NameState}
   * {@see hsd.BlindBid}
   * {@see hsd.BidReveal}
   * @param {Object} options
   * @returns {Promise}
   */

  getAuctions(options) {
    return this.client.getAuctions(this.id, options);
  }

  /**
   * Get bids for a given name.
   * {@see hsd.BlindBid}
   * @param {String?} name
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getBidsByName(name, options) {
    return this.client.getBidsByName(this.id, name, options);
  }

  /**
   * Get bids for all names.
   * the wallet manages.
   * {@see hsd.BlindBid}
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getBids(options) {
    return this.client.getBids(this.id, options);
  }

  /**
   * Get wallet reveal for a given name.
   * {@see hsd.BidReveal}
   * @param {String?} name
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getRevealsByName(name, options) {
    return this.client.getRevealsByName(this.id, name, options);
  }

  /**
   * Get wallet reveals for all names
   * the wallet manages.
   * {@see hsd.BidReveal}
   * @param {Object?} options
   * @param {Boolean?} options.own
   * @returns {Promise}
   */

  getReveals(options) {
    return this.client.getReveals(this.id, options);
  }

  /**
   * Get name resource.
   * {@see hsd.Resource}
   * @param {String} name
   * @returns {Promise}
   */

  getResource(name) {
    return this.client.getResource(this.id, name);
  }

  /*
   * Deterministically regenerate a bid's nonce.
   * @param {String} name
   * @param {Object} options
   * @param {String} options.address
   * @param {Number} options.bid
   * @returns {Promise}
   */

  getNonce(name, options) {
    return this.client.getNonce(this.id, name, options);
  }

  /**
   * @param {Number} now - Current time.
   * @param {Number} age - Age delta.
   * @returns {Promise}
   */

  zap(account, age) {
    return this.client.zap(this.id, account, age);
  }

  /**
   * Used to remove a pending transaction from the wallet.
   * That is likely the case if it has a policy or low fee
   * that prevents it from proper network propagation.
   * @param {Hash} hash
   * @returns {Promise}
   */

  abandon(hash) {
    return this.client.abandon(this.id, hash);
  }

  /**
   * Create a transaction, fill.
   * @param {Object} options
   * @returns {Promise}
   */

  createTX(options) {
    return this.client.createTX(this.id, options);
  }

  /**
   * Create pre-signed bid and reveal txs,
   * fill, and optionally sign and broadcast.
   * @param {Object} options
   * @param {String} options.name
   * @param {Number} options.bid
   * @param {Number} options.lockup
   * @param {String} options.passphrase
   * @param {Boolean} options.sign
   * @param {Boolean} options.broadcastBid
   * @returns {Promise}
   */

   createAuctionTXs(options) {
    return this.client.createAuctionTXs(this.id, options);
  }

  /**
   * Create a transaction, fill, sign, and broadcast.
   * @param {Object} options
   * @param {String} options.address
   * @param {Amount} options.value
   * @returns {Promise}
   */

  send(options) {
    return this.client.send(this.id, options);
  }

  /**
   * Create open transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createOpen(options) {
    return this.client.createOpen(this.id, options);
  }

  /**
   * Create bid transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createBid(options) {
    return this.client.createBid(this.id, options);
  }

  /**
   * Create reveal transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createReveal(options) {
    return this.client.createReveal(this.id, options);
  }

  /**
   * Create redeem transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createRedeem(options) {
    return this.client.createRedeem(this.id, options);
  }

  /**
   * Create update transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createUpdate(options) {
    return this.client.createUpdate(this.id, options);
  }

  /**
   * Create renewal transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createRenewal(options) {
    return this.client.createRenewal(this.id, options);
  }

  /**
   * Create transfer transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createTransfer(options) {
    return this.client.createTransfer(this.id, options);
  }

  /**
   * Create cancel transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createCancel(options) {
    return this.client.createCancel(this.id, options);
  }

  /**
   * Create finalize transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createFinalize(options) {
    return this.client.createFinalize(this.id, options);
  }

  /**
   * Create revoke transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  createRevoke(options) {
    return this.client.createRevoke(this.id, options);
  }

  /**
   * Sign a transaction.
   * @param {Object} options
   * @returns {Promise}
   */

  sign(options) {
    return this.client.sign(this.id, options);
  }

  /**
   * Get the raw wallet JSON.
   * @returns {Promise}
   */

  getInfo() {
    return this.client.getInfo(this.id);
  }

  /**
   * Get wallet accounts.
   * @returns {Promise} - Returns Array.
   */

  getAccounts() {
    return this.client.getAccounts(this.id);
  }

  /**
   * Get wallet master key.
   * @returns {Promise}
   */

  getMaster() {
    return this.client.getMaster(this.id);
  }

  /**
   * Get wallet account.
   * @param {String} account
   * @returns {Promise}
   */

  getAccount(account) {
    return this.client.getAccount(this.id, account);
  }

  /**
   * Create account.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise}
   */

  createAccount(name, options) {
    return this.client.createAccount(this.id, name, options);
  }

  /**
   * Modify account.
   * @param {String} name
   * @param {Object} options
   * @returns {Promise<Object>}
   */

  modifyAccount(name, options) {
    return this.client.modifyAccount(this.id, name, options);
  }

  /**
   * Create address.
   * @param {Object} options
   * @returns {Promise}
   */

  createAddress(account) {
    return this.client.createAddress(this.id, account);
  }

  /**
   * Create change address.
   * @param {Object} options
   * @returns {Promise}
   */

  createChange(account) {
    return this.client.createChange(this.id, account);
  }

  /**
   * Change or set master key`s passphrase.
   * @param {String|Buffer} passphrase
   * @param {(String|Buffer)?} old
   * @returns {Promise}
   */

  setPassphrase(passphrase, old) {
    return this.client.setPassphrase(this.id, passphrase, old);
  }

  /**
   * Generate a new token.
   * @param {(String|Buffer)?} passphrase
   * @returns {Promise}
   */

  async retoken(passphrase) {
    const result = await this.client.retoken(this.id, passphrase);

    assert(result);
    assert(typeof result.token === 'string');

    this.token = result.token;

    return result;
  }

  /**
   * Import private key.
   * @param {Number|String} account
   * @param {String} key
   * @returns {Promise}
   */

  importPrivate(account, privateKey, passphrase) {
    return this.client.importPrivate(this.id, account, privateKey, passphrase);
  }

  /**
   * Import public key.
   * @param {Number|String} account
   * @param {String} key
   * @returns {Promise}
   */

  importPublic(account, publicKey) {
    return this.client.importPublic(this.id, account, publicKey);
  }

  /**
   * Import address.
   * @param {Number|String} account
   * @param {String} address
   * @returns {Promise}
   */

  importAddress(account, address) {
    return this.client.importAddress(this.id, account, address);
  }

  /**
   * Lock a coin.
   * @param {String} hash
   * @param {Number} index
   * @returns {Promise}
   */

  lockCoin(hash, index) {
    return this.client.lockCoin(this.id, hash, index);
  }

  /**
   * Unlock a coin.
   * @param {String} hash
   * @param {Number} index
   * @returns {Promise}
   */

  unlockCoin(hash, index) {
    return this.client.unlockCoin(this.id, hash, index);
  }

  /**
   * Get locked coins.
   * @returns {Promise}
   */

  getLocked() {
    return this.client.getLocked(this.id);
  }

  /**
   * Lock wallet.
   * @returns {Promise}
   */

  lock() {
    return this.client.lock(this.id);
  }

  /**
   * Unlock wallet.
   * @param {String} passphrase
   * @param {Number} timeout
   * @returns {Promise}
   */

  unlock(passphrase, timeout) {
    return this.client.unlock(this.id, passphrase, timeout);
  }

  /**
   * Get wallet key.
   * @param {String} address
   * @returns {Promise}
   */

  getKey(address) {
    return this.client.getKey(this.id, address);
  }

  /**
   * Get wallet key WIF dump.
   * @param {String} address
   * @param {String?} passphrase
   * @returns {Promise}
   */

  getWIF(address, passphrase) {
    return this.client.getWIF(this.id, address, passphrase);
  }

  /**
   * Add a public account key to the wallet for multisig.
   * @param {String} account
   * @param {String} key - Account (bip44) key (base58).
   * @returns {Promise}
   */

  addSharedKey(account, accountKey) {
    return this.client.addSharedKey(this.id, account, accountKey);
  }

  /**
   * Remove a public account key to the wallet for multisig.
   * @param {String} account
   * @param {String} key - Account (bip44) key (base58).
   * @returns {Promise}
   */

  removeSharedKey(account, accountKey) {
    return this.client.removeSharedKey(this.id, account, accountKey);
  }

  /**
   * Resend wallet transactions.
   * @returns {Promise}
   */

  resend() {
    return this.client.resendWallet(this.id);
  }
}

/*
 * Expose
 */

WalletClient.Wallet = Wallet;

module.exports = WalletClient;
