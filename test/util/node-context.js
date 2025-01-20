'use strict';

const assert = require('bsert');
const common = require('./common');
const fs = require('bfile');
const Network = require('../../lib/protocol/network');
const SPVNode = require('../../lib/node/spvnode');
const FullNode = require('../../lib/node/fullnode');
const WalletNode = require('../../lib/wallet/node');
const plugin = require('../../lib/wallet/plugin');
const {NodeClient, WalletClient} = require('../../lib/client');
const Logger = require('blgr');

class NodeContext {
  constructor(options = {}) {
    this.name = 'node-test';
    this.options = {};
    this.prefix = null;
    this.opened = false;
    this.logger = new Logger({
      console: true,
      filename: null,
      level: 'none'
    });

    this.initted = false;
    /** @type {FullNode|SPVNode|null} */
    this.node = null;
    /** @type {WalletNode|null} */
    this.walletNode = null;
    /** @type {NodeClient|null} */
    this.nclient = null;
    /** @type {WalletClient|null} */
    this.wclient = null;

    this.clients = [];

    this.fromOptions(options);
  }

  fromOptions(options) {
    const fnodeOptions = {
      ...options,
      memory: true,
      network: 'regtest',
      listen: false,
      wallet: false,
      spv: false,
      logger: this.logger,

      // wallet plugin options
      walletHttpPort: null
    };

    if (options.name != null) {
      assert(typeof options.name === 'string');
      this.name = options.name;
    }

    if (options.network != null)
      fnodeOptions.network = Network.get(options.network).type;

    if (options.name != null)
      fnodeOptions.name = options.name;

    if (options.listen != null) {
      assert(typeof options.listen === 'boolean');
      fnodeOptions.listen = options.listen;
    }

    if (options.prefix != null) {
      fnodeOptions.prefix = options.prefix;
      fnodeOptions.memory = false;
      this.prefix = fnodeOptions.prefix;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean');
      assert(!(options.memory && options.prefix),
        'Can not set prefix with memory.');

      fnodeOptions.memory = options.memory;
    }

    if (!fnodeOptions.memory && !fnodeOptions.prefix) {
      fnodeOptions.prefix = common.testdir(this.name);
      this.prefix = fnodeOptions.prefix;
    }

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

    if (options.standalone != null) {
      assert(typeof options.standalone === 'boolean');
      fnodeOptions.standalone = options.standalone;
    }

    this.options = fnodeOptions;
  }

  init() {
    if (this.initted)
      return;

    if (this.options.spv)
      this.node = new SPVNode(this.options);
    else
      this.node = new FullNode(this.options);

    if (this.options.wallet && !this.options.standalone) {
      this.node.use(plugin);
    } else if (this.options.wallet && this.options.standalone) {
      this.walletNode = new WalletNode({
        ...this.options,

        nodeHost: '127.0.0.1',
        nodePort: this.options.httpPort,
        nodeApiKey: this.options.apiKey,

        httpPort: this.options.walletHttpPort,
        apiKey: this.options.apiKey
      });
    }

    // Initial wallets.
    this.nclient = this.nodeClient();

    if (this.options.wallet)
      this.wclient = this.walletClient();

    this.initted = true;
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

  get nodeRPC() {
    return this.node.rpc;
  }

  get height() {
    return this.chain.tip.height;
  }

  get wdb() {
    if (!this.options.wallet)
      return null;

    if (this.walletNode)
      return this.walletNode.wdb;

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
    this.init();

    if (this.opened)
      return;

    if (this.prefix)
      await fs.mkdirp(this.prefix);

    const open = common.forEvent(this.node, 'open');
    await this.node.ensure();
    await this.node.open();
    await this.node.connect();
    this.node.startSync();
    await open;

    if (this.walletNode) {
      const walletOpen = common.forEvent(this.walletNode, 'open');
      await this.walletNode.open();
      await walletOpen;
    }

    if (this.wclient)
      await this.wclient.open();

    await this.nclient.open();

    this.opened = true;
  }

  async close() {
    if (!this.opened)
      return;

    const closeClients = [];

    for (const client of this.clients) {
      if (client.opened)
        closeClients.push(client.close());
    }

    await Promise.all(closeClients);

    if (this.walletNode) {
      const walletClose = common.forEvent(this.walletNode, 'close');
      await this.walletNode.close();
      await walletClose;
    }

    const close = common.forEvent(this.node, 'close');
    await this.node.close();
    await close;

    this.node = null;
    this.wclient = null;
    this.nclient = null;
    this.opened = false;
    this.initted = false;
  }

  async destroy() {
    if (this.prefix)
      await fs.rimraf(this.prefix);
  }

  /*
   * Helpers
   */

  enableLogging(level = 'debug') {
    this.logger.setLevel(level);
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
      apiKey: this.options.apiKey,
      port: this.options.walletHttpPort || this.network.walletPort,
      ...options
    });

    this.clients.push(client);

    return client;
  }

  /**
   * Mine blocks and wait for connect.
   * @param {Number} count
   * @param {Address} address
   * @param {ChainEntry} [tip=chain.tip] - Tip to mine on
   * @returns {Promise<Buffer[]>} - Block hashes
   */

  async mineBlocks(count, address, tip) {
    assert(this.open);

    if (!tip)
      tip = this.chain.tip;

    const blocks = [];

    for (let i = 0; i < count; i++) {
      const block = await this.miner.mineBlock(tip, address);
      tip = await this.chain.add(block);
      blocks.push(block);
    }

    return blocks;
  }
}

module.exports = NodeContext;
