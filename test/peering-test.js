/*!
 * test/peering-test.js - test for peering
 * Copyright (c) 2020, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {NodeClient, WalletClient} = require('hs-client');
const common = require('./util/common');
const FullNode = require('../lib/node/fullnode');

/**
 * NodeFactory manages creating
 * full nodes and the ports they
 * listen on.
 */

class NodeFactory {
  constructor() {
    this.counter = 0;
    this.PORT_COUNT = 5;
  }

  async new(config) {
    this.counter += this.PORT_COUNT;
    return newNode(this.counter, config);
  }

  reset() {
    this.counter = 0;
  }
}

const nodes = [];
const factory = new NodeFactory();

describe('Peering', function() {
  afterEach(async () => {
    for (const node of nodes)
      await node.close();

    nodes.length = 0;
    factory.reset();
  });

  describe('Node `only` option', function() {
    this.timeout(4000);

    it('should create peers (standard)', async () => {
      let seenOne = false, seenTwo = false;

      const one = await factory.new({
        listen: true,
        seeds: [],
        agent: 'one'
      });

      const addr = `127.0.0.1:${one.ports.p2p}`;

      const two = await factory.new({
        only: [addr],
        agent: 'two'
      });

      nodes.push(one, two);

      one.node.pool.on('peer open', (peer) => {
        assert.equal(peer.agent, 'two');
        // Peer one has a single inbound connection.
        assert.equal(one.node.pool.peers.standard.inbound, 1);
        assert.equal(one.node.pool.peers.brontide.inbound, 0);

        // The peer is not connected over brontide
        assert.equal(peer.isBrontide(), false);
        // The peer's address does not have a key.
        assert.equal(peer.address.hasKey(), false);
        seenOne = true;
      });

      two.node.pool.on('peer open', (peer) => {
        assert.equal(peer.agent, 'one');
        // Peer two has a single outbound connection
        assert.equal(two.node.pool.peers.standard.outbound, 1);
        assert.equal(two.node.pool.peers.brontide.outbound, 0);
        // The peer is not connected over brontide
        assert.equal(peer.isBrontide(), false);
        // The peer's address does not have a key.
        assert.equal(peer.address.hasKey(), false);
        // The expected peer has connected.
        assert.equal(peer.fullname(), addr);
        seenTwo = true;
      });

      await common.event(one.node.pool, 'peer open');
      await common.event(two.node.pool, 'peer open');

      assert.equal(seenOne, true);
      assert.equal(seenTwo, true);
    });

    it('should create peers (encrypted)', async () => {
      let seenOne = false, seenTwo = false;

      const one = await factory.new({
        listen: true,
        seeds: [],
        agent: 'one'
      });

      const key = one.node.pool.getKey('base32');
      const addr = `${key}@127.0.0.1:${one.ports.bp2p}`;

      const two = await factory.new({
        only: [addr],
        agent: 'two'
      });

      nodes.push(one, two);

      one.node.pool.on('peer open', (peer) => {
        assert.equal(peer.agent, 'two');
        // Peer one has a single inbound connection.
        assert.equal(one.node.pool.peers.standard.inbound, 0);
        assert.equal(one.node.pool.peers.brontide.inbound, 1);
        // The peer is connected over brontide.
        assert.equal(peer.isBrontide(), true);
        // The peer's address does have a key.
        assert.equal(peer.address.hasKey(), true);
        seenOne = true;
      });

      two.node.pool.on('peer open', (peer) => {
        assert.equal(peer.agent, 'one');
        // Peer two has a single outbound connection
        assert.equal(two.node.pool.peers.standard.outbound, 0);
        assert.equal(two.node.pool.peers.brontide.outbound, 1);
        // The peer is connected over brontide.
        assert.equal(peer.isBrontide(), true);
        // The peer's address does have a key.
        assert.equal(peer.address.hasKey(), true);
        // The expected peer has connected.
        assert.equal(peer.fullname(), addr);
        seenTwo = true;
      });

      await common.event(two.node.pool, 'peer open');
      await common.event(one.node.pool, 'peer open');

      assert.equal(seenOne, true);
      assert.equal(seenTwo, true);
    });

    it('should create both standard and encrypted peers', async () => {
      const one = await factory.new({
        listen: true,
        seeds: [],
        agent: 'one'
      });

      const key = one.node.pool.getKey('base32');
      const addr = `${key}@127.0.0.1:${one.ports.bp2p}`;

      // Connecting over brontide
      const two = await factory.new({
        only: [addr],
        agent: 'two'
      });

      await common.event(two.node.pool, 'peer open');

      // Connecting via standard
      const three = await factory.new({
        only: [`127.0.0.1:${one.ports.p2p}`],
        agent: 'three'
      });

      await common.event(three.node.pool, 'peer connect');

      nodes.push(one, two, three);

      const peers = await one.nclient.execute('getpeerinfo');

      assert.equal(peers.length, 2);

      const brontide = peers.find(p => p.type === 'BRONTIDE');
      const standard = peers.find(p => p.type === 'STANDARD');

      assert(brontide);
      assert.equal(brontide.subver, 'two');

      assert(standard);
      assert.equal(standard.subver, 'three');
    });

    it('should gossip blocks over standard and brontide', async () => {
      const one = await factory.new({
        listen: true,
        seeds: [],
        agent: 'one'
      });

      const key = one.node.pool.getKey('base32');
      const addr = `${key}@127.0.0.1:${one.ports.bp2p}`;

      const two = await factory.new({
        only: [addr],
        agent: 'two'
      });

      await common.event(two.node.pool, 'peer open');

      const three = await factory.new({
        only: [`127.0.0.1:${one.ports.p2p}`],
        agent: 'three'
      });

      await common.event(three.node.pool, 'peer connect');

      nodes.push(one, two, three);

      // Keep track of seen blocks for each node.
      const seen = {one: 0, two: 0, three: 0};

      three.node.chain.on('connect', (block) => {
        seen.one++;
      });

      two.node.chain.on('connect', (block) => {
        seen.two++;
      });

      one.node.chain.on('connect', (block) => {
        seen.three++;
      });

      // Mine blocks to gossip to peers.
      const blocks = 3;
      await one.nclient.execute('generate', [blocks]);

      await common.forValue(seen, 'one', blocks);
      await common.forValue(seen, 'two', blocks);
      await common.forValue(seen, 'three', blocks);

      assert.bufferEqual(one.node.chain.tip.hash, two.node.chain.tip.hash);
      assert.bufferEqual(one.node.chain.tip.hash, three.node.chain.tip.hash);
    });
  });

  describe('RPC addnode', function() {
    it('should add a standard node', async () => {
      const one = await factory.new({
        listen: true,
        seeds: [],
        agent: 'one'
      });

      const two = await factory.new({
        seeds: [],
        agent: 'two'
      });

      nodes.push(one, two);

      assert.equal(one.node.pool.peers.size(), 0);
      assert.equal(two.node.pool.peers.size(), 0);

      two.node.pool.on('peer connect', () => {
        two.seen = true;
      });

      const addr = `127.0.0.1:${one.ports.p2p}`;
      await two.nclient.execute('addnode', [addr, 'onetry']);
      await common.forValue(two, 'seen', true);

      assert.equal(one.node.pool.peers.size(), 1);
      assert.equal(two.node.pool.peers.size(), 1);
    });

    it('should add a brontide node', async () => {
      const one = await factory.new({
        listen: true,
        seeds: []
      });

      const two = await factory.new({
        seeds: []
      });

      nodes.push(one, two);

      assert.equal(one.node.pool.peers.size(), 0);
      assert.equal(two.node.pool.peers.size(), 0);

      two.node.pool.on('peer connect', () => {
        two.seen = true;
      });

      const key = one.node.pool.getKey('base32');
      const addr = `${key}@127.0.0.1:${one.ports.bp2p}`;
      await two.nclient.execute('addnode', [addr, 'onetry']);
      await common.forValue(two, 'seen', true);

      assert.equal(one.node.pool.peers.size(), 1);
      assert.equal(two.node.pool.peers.size(), 1);
    });
  });
});

/**
 * Create a new node and http clients.
 * @param {Number} id
 * @param {Object} config
 * @returns {Object}
 */

async function newNode(id, config) {
  const port = id + 10000;

  const ports = {
    p2p: port,
    bp2p: port + 1,
    node: port + 2,
    wallet: port + 3,
    ns: port + 4,
    rs: port + 5
  };

  const cfg = Object.assign({}, {
    network: 'regtest',
    memory: true,
    workers: true,
    workerSize: 1,
    plugins: [require('../lib/wallet/plugin')],
    port: ports.p2p,
    brontidePort: ports.bp2p,
    httpPort: ports.node,
    nsPort: ports.ns,
    rsPort: ports.rs,
    env: {
      'HSD_WALLET_HTTP_PORT': ports.wallet.toString()
    }
  }, config);

  const node = new FullNode(cfg);

  const nclient = new NodeClient({
    port: ports.node
  });

  const wclient = new WalletClient({
    port: ports.wallet
  });

  const wallet = wclient.wallet('primary');

  nclient.on('connect', async () => {
    await nclient.watchChain();
  });

  node.pool.on('error', () => {
    assert(false);
  });

  await node.open();
  await node.connect();
  node.startSync();
  await nclient.open();
  await wclient.open();

  async function close() {
    await wclient.close();
    await nclient.close();
    await node.disconnect();
    await node.close();
  }

  return {
    ports,
    node,
    nclient,
    wclient,
    wallet,
    close
  };
}

