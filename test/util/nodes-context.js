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
    const index = this.nodeCtxs.length;

    let seedPort = this.network.port + index - 1;

    if (seedPort < this.network.port)
      seedPort = this.network.port;

    const port = this.network.port + index;
    const brontidePort = this.network.brontidePort + index;
    const httpPort = this.network.rpcPort + index + 100;
    const walletHttpPort = this.network.walletPort + index + 200;

    const nodeCtx = new NodeContext({
      ...options,

      // override
      name: `node-${index}`,
      network: this.network,
      listen: true,
      publicHost: '127.0.0.1',
      publicPort: port,
      brontidePort: brontidePort,
      httpPort: httpPort,
      walletHttpPort: walletHttpPort,
      seeds: [
        `127.0.0.1:${seedPort}`
      ]
    });

    this.nodeCtxs.push(nodeCtx);
  }

  open() {
    const jobs = [];

    for (const nodeCtx of this.nodeCtxs)
      jobs.push(nodeCtx.open());

    return Promise.all(jobs);
  }

  close() {
    const jobs = [];

    for (const nodeCtx of this.nodeCtxs)
      jobs.push(nodeCtx.close());

    return Promise.all(jobs);
  }

  async connect() {
    for (const nodeCtx of this.nodeCtxs) {
      await nodeCtx.node.connect();
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async disconnect() {
    for (let i = this.nodeCtxs.length - 1; i >= 0; i--) {
      const node = this.nodeCtxs[i];
      await node.disconnect();
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  startSync() {
    for (const nodeCtx of this.nodeCtxs) {
      nodeCtx.chain.synced = true;
      nodeCtx.chain.emit('full');
      nodeCtx.node.startSync();
    }
  }

  stopSync() {
    for (const nodeCtx of this.nodeCtxs)
      nodeCtx.stopSync();
  }

  async generate(index, blocks) {
    const nodeCtx = this.nodeCtxs[index];

    assert(nodeCtx);

    for (let i = 0; i < blocks; i++) {
      const block = await nodeCtx.miner.mineBlock();
      await nodeCtx.chain.add(block);
    }
  }

  context(index) {
    const node = this.nodeCtxs[index];
    assert(node);
    return node;
  }

  height(index) {
    const nodeCtx = this.nodeCtxs[index];
    assert(nodeCtx);
    return nodeCtx.height;
  }
}

module.exports = NodesContext;
