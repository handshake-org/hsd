'use strict';

const assert = require('assert');
const Network = require('../../lib/protocol/network');
const NodeContext = require('./node-context');

class NodesContext {
  constructor(network, size = 1) {
    this.network = Network.get(network);
    this.size = size;
    this.nodeCtxs = [];

    assert(this.size > 0);
  }

  init(options) {
    for (let i = 0; i < this.size; i++)
      this.addNode(options);
  }

  addNode(options = {}) {
    const index = this.nodeCtxs.length + 1;

    let seedPort = this.network.port + index - 1;

    if (seedPort < this.network.port)
      seedPort = this.network.port;

    const port = this.network.port + index;
    const brontidePort = this.network.brontidePort + index;
    const httpPort = this.network.rpcPort + index + 100;
    const walletHttpPort = this.network.walletPort + index + 200;
    const nsPort = this.network.nsPort + index;
    const rsPort = this.network.rsPort + index + 100;

    const nodeCtx = new NodeContext({
      listen: true,

      ...options,

      // override
      name: `node-${index}`,
      network: this.network,
      port: port,
      brontidePort: brontidePort,
      rsPort: rsPort,
      nsPort: nsPort,
      httpPort: httpPort,
      walletHttpPort: walletHttpPort,
      seeds: [
        `127.0.0.1:${seedPort}`
      ]
    });

    this.nodeCtxs.push(nodeCtx);
    return nodeCtx;
  }

  /**
   * Open all or specific nodes.
   * @param {Number} [index=-1] default all
   * @returns {Promise}
   */

  open(index = -1) {
    if (index !== -1)
      return this.context(index).open();

    const jobs = [];

    for (const nodeCtx of this.nodeCtxs)
      jobs.push(nodeCtx.open());

    return Promise.all(jobs);
  }

  /**
   * Close all or specific nodes.
   * @param {Number} [index=-1] default all
   * @returns {Promise}
   */

  close(index = -1) {
    if (index !== -1)
      return this.context(index).close();

    const jobs = [];

    for (const nodeCtx of this.nodeCtxs)
      jobs.push(nodeCtx.close());

    return Promise.all(jobs);
  }

  /**
   * Destroy specific or all nodes. Clean up directories on the disk.
   * @param {Number} [index=-1] default all
   * @returns {Promise}
   */

  destroy(index = -1) {
    if (index !== -1)
      return this.context(index).destroy();

    const jobs = [];

    for (const nodeCtx of this.nodeCtxs)
      jobs.push(nodeCtx.destroy());

    return Promise.all(jobs);
  }

  /**
   * Connect all nodes.
   * @returns {Promise}
   */

  async connect() {
    for (const nodeCtx of this.nodeCtxs) {
      await nodeCtx.node.connect();
      await nodeCtx.node.startSync();
    }
  }

  /**
   * Disconnect all nodes.
   * @returns {Promise}
   */

  async disconnect() {
    for (let i = this.nodeCtxs.length - 1; i >= 0; i--) {
      const node = this.nodeCtxs[i].node;
      await node.disconnect();
    }
  }

  /**
   * Start syncing.
   */

  startSync() {
    for (const nodeCtx of this.nodeCtxs) {
      nodeCtx.chain.synced = true;
      nodeCtx.chain.emit('full');
      nodeCtx.node.startSync();
    }
  }

  /**
   * Stop syncing.
   */

  stopSync() {
    for (const nodeCtx of this.nodeCtxs)
      nodeCtx.stopSync();
  }

  /**
   * Mine blocks.
   * @param {Number} index
   * @param {Number} blocks
   * @param {String} address
   * @param {ChainEntry} [tip=chain.tip]
   * @returns {Promise}
   */

  async generate(index, blocks, address, tip) {
    return this.context(index).mineBlocks(blocks, address, tip);
  }

  /**
   * Get NodeCtx for the node.
   * @param {Number} index
   * @returns {NodeContext}
   */

  context(index) {
    const nodeCtx = this.nodeCtxs[index];
    assert(nodeCtx);
    return nodeCtx;
  }

  /**
   * Get height for the node.
   * @param {Number} index
   * @returns {Number}
   */

  height(index) {
    return this.context(index).height;
  }
}

module.exports = NodesContext;
