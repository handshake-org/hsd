/*!
 * spvnode.js - spv node for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const NameState = require('../covenants/namestate');
const Chain = require('../blockchain/chain');
const Pool = require('../net/pool');
const Node = require('./node');
const HTTP = require('./http');
const RPC = require('./rpc');
const pkg = require('../pkg');
const {RootServer, RecursiveServer} = require('../dns/server');

/**
 * SPV Node
 * Create an spv node which only maintains
 * a chain, a pool, and an http server.
 * @alias module:node.SPVNode
 * @extends Node
 */

class SPVNode extends Node {
  /**
   * Create SPV node.
   * @constructor
   * @param {Object?} options
   * @param {Buffer?} options.sslKey
   * @param {Buffer?} options.sslCert
   * @param {Number?} options.httpPort
   * @param {String?} options.httpHost
   */

  constructor(options) {
    super(pkg.core, pkg.cfg, 'debug.log', options);

    this.opened = false;

    // SPV flag.
    this.spv = true;

    this.chain = new Chain({
      network: this.network,
      logger: this.logger,
      prefix: this.config.prefix,
      memory: this.config.bool('memory'),
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size'),
      entryCache: this.config.uint('entry-cache'),
      forceFlags: this.config.bool('force-flags'),
      checkpoints: this.config.bool('checkpoints'),
      spv: true
    });

    this.pool = new Pool({
      network: this.network,
      logger: this.logger,
      chain: this.chain,
      prefix: this.config.prefix,
      proxy: this.config.str('proxy'),
      onion: this.config.bool('onion'),
      brontideOnly: this.config.bool('brontide-only'),
      upnp: this.config.bool('upnp'),
      seeds: this.config.array('seeds'),
      nodes: this.config.array('nodes'),
      only: this.config.array('only'),
      identityKey: this.identityKey,
      maxOutbound: this.config.uint('max-outbound'),
      createSocket: this.config.func('create-socket'),
      memory: this.config.bool('memory'),
      selfish: true,
      listen: false
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
      cors: this.config.bool('cors')
    });

    this.ns = new RootServer({
      logger: this.logger,
      key: this.identityKey,
      host: this.config.str('ns-host'),
      port: this.config.uint('ns-port', this.network.nsPort),
      lookup: key => this.pool.resolve(key),
      publicHost: this.config.str('public-host')
    });

    this.rs = new RecursiveServer({
      logger: this.logger,
      key: this.identityKey,
      host: this.config.str('rs-host'),
      port: this.config.uint('rs-port', this.network.rsPort),
      stubHost: this.ns.host,
      stubPort: this.ns.port,
      noUnbound: this.config.bool('rs-no-unbound')
    });

    this.init();
  }

  /**
   * Initialize the node.
   * @private
   */

  init() {
    // Bind to errors
    this.chain.on('error', err => this.error(err));
    this.pool.on('error', err => this.error(err));

    if (this.http)
      this.http.on('error', err => this.error(err));

    this.pool.on('tx', (tx) => {
      this.emit('tx', tx);
    });

    this.chain.on('block', (block) => {
      this.emit('block', block);
    });

    this.chain.on('connect', async (entry, block) => {
      this.emit('connect', entry, block);
    });

    this.chain.on('disconnect', (entry, block) => {
      this.emit('disconnect', entry, block);
    });

    this.chain.on('reorganize', (tip, competitor) => {
      this.emit('reorganize', tip, competitor);
    });

    this.chain.on('reset', (tip) => {
      this.emit('reset', tip);
    });

    this.loadPlugins();
  }

  /**
   * Open the node and all its child objects,
   * wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'SPVNode is already open.');
    this.opened = true;

    await this.handlePreopen();
    await this.chain.open();
    await this.pool.open();

    await this.openPlugins();

    await this.http.open();
    await this.ns.open();
    await this.rs.open();
    await this.handleOpen();

    this.logger.info('Node is loaded.');
  }

  /**
   * Close the node, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'SPVNode is not open.');
    this.opened = false;

    await this.handlePreclose();
    await this.http.close();
    await this.rs.close();
    await this.ns.close();

    await this.closePlugins();

    await this.pool.close();
    await this.chain.close();
    await this.handleClose();
  }

  /**
   * Scan for any missed transactions.
   * Note that this will replay the blockchain sync.
   * @param {Number|Hash} start - Start block.
   * @returns {Promise}
   */

  async scan(start) {
    throw new Error('Not implemented.');
  }

  /**
   * Broadcast a transaction.
   * @param {TX|Block} item
   * @returns {Promise}
   */

  async broadcast(item) {
    try {
      await this.pool.broadcast(item);
    } catch (e) {
      this.emit('error', e);
    }
  }

  /**
   * Broadcast a transaction.
   * @param {TX} tx
   * @returns {Promise}
   */

  sendTX(tx) {
    return this.broadcast(tx);
  }

  /**
   * Broadcast a transaction. Silence errors.
   * @param {TX} tx
   * @returns {Promise}
   */

  relay(tx) {
    return this.broadcast(tx);
  }

  /**
   * Broadcast a claim.
   * @param {Claim} claim
   * @returns {Promise}
   */

  sendClaim(claim) {
    return this.broadcast(claim);
  }

  /**
   * Broadcast a claim. Silence errors.
   * @param {Claim} claim
   * @returns {Promise}
   */

  relayClaim(claim) {
    return this.broadcast(claim);
  }

  /**
   * Broadcast an airdrop proof.
   * @param {AirdropProof} proof
   * @returns {Promise}
   */

  sendAirdrop(proof) {
    const key = proof.getKey();

    if (!key) {
      this.emit('error', new Error('Invalid Airdrop.'));
      return Promise.resolve();
    }

    if (this.chain.tip.height + 1 >= this.network.goosigStop) {
      if (key.isGoo()) {
        this.emit('error', new Error('GooSig disabled.'));
        return Promise.resolve();
      }
    }

    return this.broadcast(proof);
  }

  /**
   * Broadcast an airdrop proof. Silence errors.
   * @param {AirdropProof} proof
   * @returns {Promise}
   */

  relayAirdrop(proof) {
    return this.broadcast(proof);
  }

  /**
   * Connect to the network.
   * @returns {Promise}
   */

  connect() {
    return this.pool.connect();
  }

  /**
   * Disconnect from the network.
   * @returns {Promise}
   */

  disconnect() {
    return this.pool.disconnect();
  }

  /**
   * Start the blockchain sync.
   */

  startSync() {
    return this.pool.startSync();
  }

  /**
   * Stop syncing the blockchain.
   */

  stopSync() {
    return this.pool.stopSync();
  }

  /**
   * Get current name state.
   * @param {Buffer} nameHash
   * @returns {NameState}
   */

  async getNameStatus(nameHash) {
    const network = this.network;
    const height = this.chain.height + 1;
    const blob = await this.pool.resolve(nameHash);

    if (!blob) {
      const state = new NameState();
      state.reset(height);
      return state;
    }

    const state = NameState.decode(blob);

    state.maybeExpire(height, network);

    return state;
  }
}

/*
 * Expose
 */

module.exports = SPVNode;
