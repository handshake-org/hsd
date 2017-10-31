/*!
 * server.js - wallet server for bcoin
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const Node = require('../node/node');
const WalletDB = require('./walletdb');
const HTTP = require('./http');
const Client = require('./client');
const RPC = require('./rpc');

/**
 * Wallet Node
 * @extends Node
 * @constructor
 */

function WalletNode(options) {
  if (!(this instanceof WalletNode))
    return new WalletNode(options);

  Node.call(this, 'bcoin', 'wallet.conf', 'wallet.log', options);

  this.client = new Client({
    network: this.network,
    url: this.config.str('node-url'),
    host: this.config.str('node-host'),
    port: this.config.str('node-port', this.network.rpcPort),
    ssl: this.config.str('node-ssl'),
    apiKey: this.config.str('node-api-key')
  });

  this.wdb = new WalletDB({
    network: this.network,
    logger: this.logger,
    workers: this.workers,
    client: this.client,
    prefix: this.config.prefix,
    db: this.config.str('db'),
    maxFiles: this.config.uint('max-files'),
    cacheSize: this.config.mb('cache-size'),
    witness: this.config.bool('witness'),
    checkpoints: this.config.bool('checkpoints'),
    startHeight: this.config.uint('start-height'),
    wipeNoReally: this.config.bool('wipe-no-really'),
    spv: this.config.bool('spv')
  });

  this.rpc = new RPC(this);

  this.http = new HTTP({
    network: this.network,
    logger: this.logger,
    node: this,
    prefix: this.config.prefix,
    ssl: this.config.bool('ssl'),
    keyFile: this.config.path('ssl-key'),
    certFile: this.config.path('ssl-cert'),
    host: this.config.str('http-host'),
    port: this.config.uint('http-port'),
    apiKey: this.config.str('api-key'),
    noAuth: this.config.bool('no-auth'),
    walletAuth: this.config.bool('wallet-auth')
  });

  this._init();
}

Object.setPrototypeOf(WalletNode.prototype, Node.prototype);

/**
 * Initialize the node.
 * @private
 */

WalletNode.prototype._init = function _init() {
  this.wdb.on('error', err => this.error(err));
  this.http.on('error', err => this.error(err));

  this.loadPlugins();
};

/**
 * Open the node and all its child objects,
 * wait for the database to load.
 * @alias WalletNode#open
 * @returns {Promise}
 */

WalletNode.prototype._open = async function _open(callback) {
  // await this.client.open();
  await this.wdb.open();

  this.rpc.wallet = this.wdb.primary;

  await this.openPlugins();

  await this.http.open();

  this.logger.info('Wallet node is loaded.');
};

/**
 * Close the node, wait for the database to close.
 * @alias WalletNode#close
 * @returns {Promise}
 */

WalletNode.prototype._close = async function _close() {
  await this.http.close();

  await this.closePlugins();

  this.rpc.wallet = null;
  await this.wdb.close();
  // await this.client.close();
};

/*
 * Expose
 */

module.exports = WalletNode;