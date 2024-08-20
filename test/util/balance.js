'use strict';

const assert = require('bsert');
const Wallet = require('../../lib/wallet/wallet');
const WalletClient = require('../../lib/client/wallet');

/**
 * @property {Number} tx
 * @property {Number} coin
 * @property {Number} confirmed
 * @property {Number} unconfirmed
 * @property {Number} ulocked - unconfirmed locked
 * @property {Number} clocked - confirmed locked
 */

class Balance {
  constructor(options) {
    options = options || {};

    this.tx = options.tx || 0;
    this.coin = options.coin || 0;
    this.confirmed = options.confirmed || 0;
    this.unconfirmed = options.unconfirmed || 0;
    this.ulocked = options.ulocked || 0;
    this.clocked = options.clocked || 0;
  }

  clone() {
    return new Balance(this);
  }

  cloneWithDelta(obj) {
    return this.clone().apply(obj);
  }

  fromBalance(obj) {
    this.tx = obj.tx;
    this.coin = obj.coin;
    this.confirmed = obj.confirmed;
    this.unconfirmed = obj.unconfirmed;
    this.ulocked = obj.lockedUnconfirmed;
    this.clocked = obj.lockedConfirmed;

    return this;
  }

  apply(balance) {
    this.tx += balance.tx || 0;
    this.coin += balance.coin || 0;
    this.confirmed += balance.confirmed || 0;
    this.unconfirmed += balance.unconfirmed || 0;
    this.ulocked += balance.ulocked || 0;
    this.clocked += balance.clocked || 0;

    return this;
  }

  diff(balance) {
    return new Balance({
      tx: this.tx - balance.tx,
      coin: this.coin - balance.coin,
      confirmed: this.confirmed - balance.confirmed,
      unconfirmed: this.unconfirmed - balance.unconfirmed,
      ulocked: this.ulocked - balance.ulocked,
      clocked: this.clocked - balance.clocked
    });
  }

  static fromBalance(wbalance) {
    return new this().fromBalance(wbalance);
  }
}

/**
 * @param {Wallet} wallet
 * @param {String} accountName
 * @returns {Promise<Balance>}
 */

async function getWalletBalance(wallet, accountName) {
  assert(wallet instanceof Wallet);
  const balance = await wallet.getBalance(accountName);
  return Balance.fromBalance(balance.getJSON(true));
}

/**
 * @param {WalletClient} wclient
 * @param {String} id
 * @param {String} accountName
 * @returns {Promise<Balance>}
 */

async function getWClientBalance(wclient, id, accountName) {
  assert(wclient instanceof WalletClient);
  const balance = await wclient.getBalance(id, accountName);
  return Balance.fromBalance(balance);
}

/**
 * @param {WalletClient.Wallet} balance
 * @param {String} accountName
 * @returns {Promise<Balance>}
 */

async function getWClientWalletBalance(wallet, accountName) {
  assert(wallet instanceof WalletClient.Wallet);
  const balance = await wallet.getBalance(accountName);
  return Balance.fromBalance(balance);
}

async function getBalance(wallet, accountName) {
  if (wallet instanceof WalletClient.Wallet)
    return getWClientWalletBalance(wallet, accountName);

  return getWalletBalance(wallet, accountName);
}

/**
 * @param {Wallet} wallet
 * @param {String} accountName
 * @param {Balance} expectedBalance
 * @param {String} message
 * @returns {Promise}
 */

async function assertBalanceEquals(wallet, accountName, expectedBalance, message) {
  const balance = await getBalance(wallet, accountName);
  assert.deepStrictEqual(balance, expectedBalance, message);
}

async function assertWClientBalanceEquals(wclient, id, accountName, expectedBalance, message) {
  const balance = await getWClientBalance(wclient, id, accountName);
  assert.deepStrictEqual(balance, expectedBalance, message);
}

exports.Balance = Balance;

exports.getBalance = getBalance;
exports.getWalletBalance = getWalletBalance;
exports.getWClientBalance = getWClientBalance;
exports.getWClientWalletBalance = getWClientWalletBalance;

exports.assertBalanceEquals = assertBalanceEquals;
exports.assertWClientBalanceEquals = assertWClientBalanceEquals;
