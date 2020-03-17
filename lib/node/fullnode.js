/*!
 * fullnode.js - full node for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Chain = require('../blockchain/chain');
const Fees = require('../mempool/fees');
const Mempool = require('../mempool/mempool');
const Pool = require('../net/pool');
const Miner = require('../mining/miner');
const Node = require('./node');
const HTTP = require('./http');
const RPC = require('./rpc');
const pkg = require('../pkg');
const {RootServer, RecursiveServer} = require('../dns/server');

/**
 * Full Node
 * Respresents a fullnode complete with a
 * chain, mempool, miner, etc.
 * @alias module:node.FullNode
 * @extends Node
 */

class FullNode extends Node {
  /**
   * Create a full node.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super(pkg.core, pkg.cfg, 'debug.log', options);

    this.opened = false;

    // SPV flag.
    this.spv = false;

    // Instantiate blockchain.
    this.chain = new Chain({
      network: this.network,
      logger: this.logger,
      workers: this.workers,
      memory: this.config.bool('memory'),
      prefix: this.config.prefix,
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size'),
      forceFlags: this.config.bool('force-flags'),
      prune: this.config.bool('prune'),
      checkpoints: this.config.bool('checkpoints'),
      entryCache: this.config.uint('entry-cache'),
      indexTX: this.config.bool('index-tx'),
      indexAddress: this.config.bool('index-address')
    });

    // Fee estimation.
    this.fees = new Fees(this.logger);
    this.fees.init();

    // Mempool needs access to the chain.
    this.mempool = new Mempool({
      network: this.network,
      logger: this.logger,
      workers: this.workers,
      chain: this.chain,
      fees: this.fees,
      memory: this.config.bool('memory'),
      prefix: this.config.prefix,
      persistent: this.config.bool('persistent-mempool'),
      maxSize: this.config.mb('mempool-size'),
      limitFree: this.config.bool('limit-free'),
      limitFreeRelay: this.config.uint('limit-free-relay'),
      requireStandard: this.config.bool('require-standard'),
      rejectAbsurdFees: this.config.bool('reject-absurd-fees'),
      indexAddress: this.config.bool('index-address')
    });

    // Pool needs access to the chain and mempool.
    this.pool = new Pool({
      network: this.network,
      logger: this.logger,
      chain: this.chain,
      mempool: this.mempool,
      prefix: this.config.prefix,
      compact: this.config.bool('compact'),
      bip37: this.config.bool('bip37'),
      identityKey: this.identityKey,
      maxOutbound: this.config.uint('max-outbound'),
      maxInbound: this.config.uint('max-inbound'),
      maxProofRPS: this.config.uint('max-proof-rps'),
      createSocket: this.config.func('create-socket'),
      proxy: this.config.str('proxy'),
      onion: this.config.bool('onion'),
      brontideOnly: this.config.bool('brontide-only'),
      upnp: this.config.bool('upnp'),
      seeds: this.config.array('seeds'),
      nodes: this.config.array('nodes'),
      only: this.config.array('only'),
      publicHost: this.config.str('public-host'),
      publicPort: this.config.uint('public-port'),
      publicBrontidePort: this.config.uint('public-brontide-port'),
      host: this.config.str('host'),
      port: this.config.uint('port'),
      brontidePort: this.config.uint('brontide-port'),
      listen: this.config.bool('listen'),
      memory: this.config.bool('memory')
    });

    // Miner needs access to the chain and mempool.
    this.miner = new Miner({
      network: this.network,
      logger: this.logger,
      workers: this.workers,
      chain: this.chain,
      mempool: this.mempool,
      address: this.config.array('coinbase-address'),
      coinbaseFlags: this.config.str('coinbase-flags'),
      preverify: this.config.bool('preverify'),
      maxWeight: this.config.uint('max-weight'),
      reservedWeight: this.config.uint('reserved-weight'),
      reservedSigops: this.config.uint('reserved-sigops')
    });

    // RPC needs access to the node.
    this.rpc = new RPC(this);

    // HTTP needs access to the node.
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
      lookup: key => this.chain.db.tree.get(key),
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
    this.mempool.on('error', err => this.error(err));
    this.pool.on('error', err => this.error(err));
    this.miner.on('error', err => this.error(err));

    if (this.http)
      this.http.on('error', err => this.error(err));

    this.mempool.on('tx', (tx) => {
      this.miner.cpu.notifyEntry();
      this.emit('tx', tx);
    });

    this.mempool.on('claim', (claim) => {
      this.miner.cpu.notifyEntry();
      this.emit('claim', claim);
    });

    this.mempool.on('airdrop', (proof) => {
      this.miner.cpu.notifyEntry();
      this.emit('airdrop', proof);
    });

    this.chain.on('connect', async (entry, block, view) => {
      try {
        await this.mempool._addBlock(entry, block.txs, view);
      } catch (e) {
        this.error(e);
      }
      this.emit('block', block);
      this.emit('connect', entry, block);
    });

    this.chain.on('disconnect', async (entry, block) => {
      try {
        await this.mempool._removeBlock(entry, block.txs);
      } catch (e) {
        this.error(e);
      }
      this.emit('disconnect', entry, block);
    });

    this.chain.on('reorganize', async (tip, competitor) => {
      try {
        await this.mempool._handleReorg();
      } catch (e) {
        this.error(e);
      }
      this.emit('reorganize', tip, competitor);
    });

    this.chain.on('reset', async (tip) => {
      try {
        await this.mempool._reset();
      } catch (e) {
        this.error(e);
      }
      this.emit('reset', tip);
    });

    this.loadPlugins();
  }

  /**
   * Open the node and all its child objects,
   * wait for the database to load.
   * @alias FullNode#open
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'FullNode is already open.');
    this.opened = true;

    await this.handlePreopen();
    await this.chain.open();
    await this.mempool.open();
    await this.miner.open();
    await this.pool.open();

    await this.openPlugins();

    await this.http.open();
    await this.ns.open();
    await this.rs.open();
    await this.handleOpen();

    if (this.has('walletdb')) {
      const {wdb} = this.require('walletdb');
      if (this.miner.addresses.length === 0) {
        const addr = await wdb.primary.receiveAddress();
        this.miner.addresses.push(addr);
      }
    }

    this.logger.info('Node is loaded.');
  }

  /**
   * Close the node, wait for the database to close.
   * @alias FullNode#close
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'FullNode is not open.');
    this.opened = false;

    await this.handlePreclose();
    await this.http.close();
    await this.rs.close();
    await this.ns.close();

    await this.closePlugins();

    await this.pool.close();
    await this.miner.close();
    await this.mempool.close();
    await this.chain.close();
    await this.handleClose();

    this.logger.info('Node is closed.');
  }

  /**
   * Rescan for any missed transactions.
   * @param {Number|Hash} start - Start block.
   * @param {Bloom} filter
   * @param {Function} iter - Iterator.
   * @returns {Promise}
   */

  scan(start, filter, iter) {
    return this.chain.scan(start, filter, iter);
  }

  /**
   * Broadcast a transaction.
   * @param {TX|Block|Claim|AirdropProof} item
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
   * Add transaction to mempool, broadcast.
   * @param {TX} tx
   */

  async sendTX(tx) {
    let missing;

    try {
      missing = await this.mempool.addTX(tx);
    } catch (err) {
      if (err.type === 'VerifyError' && err.score === 0) {
        this.error(err);
        this.logger.warning('Verification failed for tx: %x.', tx.hash());
        this.logger.warning('Attempting to broadcast anyway...');
        this.broadcast(tx);
        return;
      }
      throw err;
    }

    if (missing) {
      this.logger.warning('TX was orphaned in mempool: %x.', tx.hash());
      this.logger.warning('Attempting to broadcast anyway...');
      this.broadcast(tx);
    }
  }

  /**
   * Add transaction to mempool, broadcast. Silence errors.
   * @param {TX} tx
   * @returns {Promise}
   */

  async relay(tx) {
    try {
      await this.sendTX(tx);
    } catch (e) {
      this.error(e);
    }
  }

  /**
   * Add claim to mempool, broadcast.
   * @param {Claim} claim
   */

  async sendClaim(claim) {
    try {
      await this.mempool.addClaim(claim);
    } catch (err) {
      if (err.type === 'VerifyError' && err.score === 0) {
        this.error(err);
        this.logger.warning('Verification failed for claim: %x.', claim.hash());
        this.logger.warning('Attempting to broadcast anyway...');
        this.broadcast(claim);
        return;
      }
      throw err;
    }
  }

  /**
   * Add claim to mempool, broadcast. Silence errors.
   * @param {Claim} claim
   * @returns {Promise}
   */

  async relayClaim(claim) {
    try {
      await this.sendClaim(claim);
    } catch (e) {
      this.error(e);
    }
  }

  /**
   * Add airdrop proof to mempool, broadcast.
   * @param {AirdropProof} proof
   */

  async sendAirdrop(proof) {
    try {
      await this.mempool.addAirdrop(proof);
    } catch (err) {
      if (err.type === 'VerifyError' && err.score === 0) {
        this.error(err);
        this.logger.warning('Verification failed for proof: %x.', proof.hash());
        this.logger.warning('Attempting to broadcast anyway...');
        this.broadcast(proof);
        return;
      }
      throw err;
    }
  }

  /**
   * Add airdrop proof to mempool, broadcast. Silence errors.
   * @param {AirdropProof} proof
   * @returns {Promise}
   */

  async relayAirdrop(proof) {
    try {
      await this.sendAirdrop(proof);
    } catch (e) {
      this.error(e);
    }
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
   * Retrieve a block from the chain database.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link Block}.
   */

  getBlock(hash) {
    return this.chain.getBlock(hash);
  }

  /**
   * Retrieve a coin from the mempool or chain database.
   * Takes into account spent coins in the mempool.
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise} - Returns {@link Coin}.
   */

  async getCoin(hash, index) {
    const coin = this.mempool.getCoin(hash, index);

    if (coin)
      return coin;

    if (this.mempool.isSpent(hash, index))
      return null;

    return this.chain.getCoin(hash, index);
  }

  /**
   * Get coins that pertain to an address from the mempool or chain database.
   * Takes into account spent coins in the mempool.
   * @param {Address} addrs
   * @returns {Promise} - Returns {@link Coin}[].
   */

  async getCoinsByAddress(addrs) {
    const mempool = this.mempool.getCoinsByAddress(addrs);
    const chain = await this.chain.getCoinsByAddress(addrs);
    const out = [];

    for (const coin of chain) {
      const spent = this.mempool.isSpent(coin.hash, coin.index);

      if (spent)
        continue;

      out.push(coin);
    }

    for (const coin of mempool)
      out.push(coin);

    return out;
  }

  /**
   * Retrieve transactions pertaining to an
   * address from the mempool or chain database.
   * @param {Address} addrs
   * @returns {Promise} - Returns {@link TXMeta}[].
   */

  async getMetaByAddress(addrs) {
    const mempool = this.mempool.getMetaByAddress(addrs);
    const chain = await this.chain.getMetaByAddress(addrs);
    return chain.concat(mempool);
  }

  /**
   * Retrieve a transaction from the mempool or chain database.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TXMeta}.
   */

  async getMeta(hash) {
    const meta = this.mempool.getMeta(hash);

    if (meta)
      return meta;

    return this.chain.getMeta(hash);
  }

  /**
   * Retrieve a spent coin viewpoint from mempool or chain database.
   * @param {TXMeta} meta
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getMetaView(meta) {
    if (meta.height === -1)
      return this.mempool.getSpentView(meta.tx);
    return this.chain.getSpentView(meta.tx);
  }

  /**
   * Retrieve transactions pertaining to an
   * address from the mempool or chain database.
   * @param {Address} addrs
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getTXByAddress(addrs) {
    const mtxs = await this.getMetaByAddress(addrs);
    const out = [];

    for (const mtx of mtxs)
      out.push(mtx.tx);

    return out;
  }

  /**
   * Retrieve a transaction from the mempool or chain database.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TX}.
   */

  async getTX(hash) {
    const mtx = await this.getMeta(hash);

    if (!mtx)
      return null;

    return mtx.tx;
  }

  /**
   * Test whether the mempool or chain contains a transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async hasTX(hash) {
    if (this.mempool.hasEntry(hash))
      return true;

    return this.chain.hasTX(hash);
  }

  /**
   * Get current name state.
   * @param {Buffer} nameHash
   * @returns {NameState}
   */

  async getNameStatus(nameHash) {
    const height = this.chain.height + 1;
    const hardened = await this.mempool.hasHardening();
    return this.chain.db.getNameStatus(nameHash, height, hardened);
  }
}

/*
 * Expose
 */

module.exports = FullNode;
