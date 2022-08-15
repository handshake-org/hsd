'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Network = require('../lib/protocol/network');
const packets = require('../lib/net/packets');
const packetTypes = packets.types;

const network = Network.get('main');

describe('P2P', function() {
  describe('Advertise own address', function() {
    it('should not share own address by default', async() => {
      const node1 = new FullNode({
        network: network.type,
        memory: true,
        listen: false,
        port: 11111,            // avoid port collisions with node2
        brontidePort: 22222,
        httpPort: 33333,
        noDns: true,
        only: '127.0.0.1'       // connect to node2
      });

      const node2 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        noDns: true,
        only: '10.20.30.40'     // won't connect
      });

      // Listen for ADDR packets from both peers
      let node1Sent = false;
      let node2Sent = false;
      node2.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node1Sent = true;
        }
      });
      node1.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node2Sent = true;
        }
      });

      // Ensure both peers connect successfully
      const waiter1 = new Promise((resolve, reject) => {
        node1.pool.on('peer open', () => {
          resolve();
        });
      });
      const waiter2 = new Promise((resolve, reject) => {
        node2.pool.on('peer open', () => {
          resolve();
        });
      });

      await node2.open();
      await node2.connect();
      node2.pool.hosts.reset(); // empty node2's "only" host to prevent gossip

      await node1.open();
      await node1.connect();

      await waiter1;
      await waiter2;

      await node1.close();
      await node2.close();

      assert.strictEqual(node1Sent, false);
      assert.strictEqual(node2Sent, false);
    });

    it('should not share own address if just listening', async() => {
      const node1 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        port: 11111,            // avoid port collisions with node2
        brontidePort: 22222,
        httpPort: 33333,
        noDns: true,
        only: '127.0.0.1'       // connect to node2
      });

      const node2 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        noDns: true,
        only: '10.20.30.40'     // won't connect
      });

      // Listen for ADDR packets from both peers
      let node1Sent = false;
      let node2Sent = false;
      node2.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node1Sent = true;
        }
      });
      node1.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node2Sent = true;
        }
      });

      // Ensure both peers connect successfully
      const waiter1 = new Promise((resolve, reject) => {
        node1.pool.on('peer open', () => {
          resolve();
        });
      });
      const waiter2 = new Promise((resolve, reject) => {
        node2.pool.on('peer open', () => {
          resolve();
        });
      });

      await node2.open();
      await node2.connect();
      node2.pool.hosts.reset(); // empty node2's "only" host to prevent gossip

      await node1.open();
      await node1.connect();

      await waiter1;
      await waiter2;

      await node1.close();
      await node2.close();

      assert.strictEqual(node1Sent, false);
      assert.strictEqual(node2Sent, false);
    });

    it('should share own address if listening + publicHost', async() => {
      const publicHost = '4.20.69.100';

      const node1 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        publicHost,
        port: 11111,            // avoid port collisions with node2
        brontidePort: 22222,
        httpPort: 33333,
        noDns: true,
        only: '127.0.0.1'       // connect to node2
      });

      const node2 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        noDns: true,
        only: '10.20.30.40'     // won't connect
      });

      // Listen for ADDR packets from both peers
      let node1Sent = false;
      let node2Sent = false;
      node2.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node1Sent = true;
          assert.strictEqual(
            packet.items[0].hostname,
            `${publicHost}:${network.port}`
          );
        }
      });
      node1.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node2Sent = true;
        }
      });

      // Ensure both peers connect successfully
      const waiter1 = new Promise((resolve, reject) => {
        node1.pool.on('peer open', () => {
          resolve();
        });
      });
      const waiter2 = new Promise((resolve, reject) => {
        node2.pool.on('peer open', () => {
          resolve();
        });
      });

      await node2.open();
      await node2.connect();
      node2.pool.hosts.reset(); // empty node2's "only" host to prevent gossip

      await node1.open();
      await node1.connect();

      await waiter1;
      await waiter2;

      await node1.close();
      await node2.close();

      assert.strictEqual(node1Sent, true);
      assert.strictEqual(node2Sent, false);
    });

    it('should share own address with publicHost + publicPort', async() => {
      const publicHost = '4.20.69.100';
      const publicPort = 54321; // not the port node1 is actually listening to

      const node1 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        publicHost,
        publicPort,
        port: 11111,            // avoid port collisions with node2
        brontidePort: 22222,
        httpPort: 33333,
        noDns: true,
        only: '127.0.0.1'       // connect to node2
      });

      const node2 = new FullNode({
        network: network.type,
        memory: true,
        listen: true,
        noDns: true,
        only: '10.20.30.40'     // won't connect
      });

      // Listen for ADDR packets from both peers
      let node1Sent = false;
      let node2Sent = false;
      node2.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node1Sent = true;
          assert.strictEqual(
            packet.items[0].hostname,
            `${publicHost}:${publicPort}`
          );
        }
      });
      node1.pool.on('packet', (packet) => {
        if (packet.type === packetTypes.ADDR) {
          node2Sent = true;
        }
      });

      // Ensure both peers connect successfully
      const waiter1 = new Promise((resolve, reject) => {
        node1.pool.on('peer open', () => {
          resolve();
        });
      });
      const waiter2 = new Promise((resolve, reject) => {
        node2.pool.on('peer open', () => {
          resolve();
        });
      });

      await node2.open();
      await node2.connect();
      node2.pool.hosts.reset(); // empty node2's "only" host to prevent gossip

      await node1.open();
      await node1.connect();

      await waiter1;
      await waiter2;

      await node1.close();
      await node2.close();

      assert.strictEqual(node1Sent, true);
      assert.strictEqual(node2Sent, false);
    });
  });
});
