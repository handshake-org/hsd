'use strict';

const assert = require('bsert');
const common = require('./common');
const fs = require('bfile');
const SPVNode = require('../../lib/node/spvnode');
const FullNode = require('../../lib/node/fullnode');
const plugin = require('../../lib/wallet/plugin');
const Network = require('../../lib/protocol/network');
const {NodeClient, WalletClient} = require('../../lib/client');
const Logger = require('blgr');

class NodeContext {
  constructor(options = {}) {
    this.name = 'node-test';
    this.options = {};
    this.node = null;
    this.opened = false;
    this.logger = new Logger({
      console: true,
      filename: null,
      level: 'none'
    });

    this.nclient = null;
    this.wclient = null;

    this.clients = [];

    this.fromOptions(options);
    this.init();
  }

  fromOptions(options) {
    const fnodeOptions = {
      ...options,
      memory: true,
      workers: true,
      network: 'regtest',
      listen: false,
      wallet: false,
      spv: false,
      logger: this.logger,

      // wallet plugin options
      walletHttpPort: null
    };

    if (options.network != null)
      fnodeOptions.network = Network.get(options.network).type;

    if (options.name != null)
      fnodeOptions.name = options.name;

    if (options.listen != null) {
      assert(typeof options.listen === 'boolean');
      fnodeOptions.listen = options.listen;
    }

    if (options.prefix != null) {
      fnodeOptions.prefix = this.prefix;
      fnodeOptions.memory = false;
    }

    if (options.memory != null) {
      assert(!fnodeOptions.prefix, 'Can not set prefix with memory.');
      fnodeOptions.memory = options.memory;
    }

    if (!this.memory && !this.prefix)
      fnodeOptions.prefix = common.testdir(this.name);

    if (options.wallet != null)
      fnodeOptions.wallet = options.wallet;

    if (options.spv != null) {
      assert(typeof options.spv === 'boolean');
      fnodeOptions.spv = options.spv;
    }

    if (options.httpPort != null) {
      assert(typeof options.httpPort === 'number');
      fnodeOptions.httpPort = options.httpPort;
    }

    if (options.walletHttpPort != null) {
      assert(typeof options.walletHttpPort === 'number');
      fnodeOptions.walletHttpPort = options.walletHttpPort;
    }

    if (options.timeout != null)  {
      assert(typeof options.timeout === 'number');
      fnodeOptions.timeout = options.timeout;
    }

    this.options = fnodeOptions;
  }

  init() {
    if (this.options.spv)
      this.node = new SPVNode(this.options);
    else
      this.node = new FullNode(this.options);

    if (this.options.wallet)
      this.node.use(plugin);

    // Initial wallets.
    this.nclient = this.nodeClient();

    if (this.options.wallet)
      this.wclient = this.walletClient();
  }

  get network() {
    return this.node.network;
  }

  get miner() {
    return this.node.miner;
  }

  get mempool() {
    return this.node.mempool;
  }

  get chain() {
    return this.node.chain;
  }

  get height() {
    return this.chain.tip.height;
  }

  get wdb() {
    return this.node.get('walletdb').wdb;
  }

  /*
   * Event Listeners wrappers
   */

  on(event, listener) {
    this.node.on(event, listener);
  }

  once(event, listener) {
    this.node.once(event, listener);
  }

  addListener(event, listener) {
    this.node.addListener(event, listener);
  }

  removeListener(event, listener) {
    this.node.removeListener(event, listener);
  }

  removeAllListeners(event) {
    this.node.removeAllListeners(event);
  }

  /*
   * Life Cycle
   */

  async open() {
    if (this.prefix)
      await fs.mkdirp(this.prefix);

    await this.node.ensure();
    await this.node.open();
    await this.node.connect();
    this.node.startSync();

    if (this.wclient)
      await this.wclient.open();

    await this.nclient.open();

    this.opened = true;
  }

  async close() {
    if (!this.opened)
      return;

    const close = common.forEvent(this.node, 'close');
    const closeClients = [];

    for (const client of this.clients) {
      if (client.opened)
        closeClients.push(client.close());
    }

    await Promise.all(closeClients);
    await this.node.close();
    await close;

    this.opened = false;
  }

  async destroy() {
    if (this.prefix)
      await fs.rimraf(this.prefix);
  }

  /*
   * Helpers
   */

  enableLogging() {
    this.logger.setLevel('debug');
  }

  disableLogging() {
    this.logger.setLevel('none');
  }

  /**
   * Execute an RPC using the node client.
   * @param {String}  method - RPC method
   * @param {Array}   params - method parameters
   * @returns {Promise<Array>} - Returns a two item array with the
   * RPC's return value or null as the first item and an error or
   * null as the second item.
   */

  async nrpc(method, params) {
    return this.nclient.execute(method, params);
  }

  /**
   * Execute an RPC using the wallet client.
   * @param {String}  method - RPC method
   * @param {Array}   params - method parameters
   * @returns {Promise} - Returns a two item array with the RPC's return value
   * or null as the first item and an error or null as the second item.
   */

  async wrpc(method, params) {
    return this.wclient.execute(method, params);
  };

  /**
   * Create new client
   * @param {Object} [options]
   * @returns {NodeClient}
   */

  nodeClient(options = {}) {
    const client = new NodeClient({
      timeout: this.options.timeout,
      apiKey: this.options.apiKey,
      port: this.options.httpPort || this.network.rpcPort,
      ...options
    });

    this.clients.push(client);

    return client;
  }

  /**
   * Create new wallet client.
   * @param {Object} [options]
   * @returns {WalletClient}
   */

  walletClient(options = {}) {
    const client = new WalletClient({
      timeout: this.options.timeout,
      port: this.options.walletHttpPort || this.network.walletPort,
      ...options
    });

    this.clients.push(client);

    return client;
  }
}

module.exports = NodeContext;
