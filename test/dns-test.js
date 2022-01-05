'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const network = Network.get('regtest');

const {Resolver} = require('dns').promises;

const rootResolver = new Resolver({timeout: 1000});
const recursiveResolver = new Resolver({timeout: 1000});
rootResolver.setServers([`127.0.0.1:${network.nsPort}`]);
recursiveResolver.setServers([`127.0.0.1:${network.rsPort}`]);

describe('Server Configuration', function() {
  describe('Full Node', function() {
    let node;

    afterEach(async () => {
      await node.close();
    });

    it('should open full node with both DNS servers', async () => {
      node = new FullNode({
        memory: true,
        network: network.type
      });

      await node.open();
      const res1 = await rootResolver.resolveSoa('.');
      assert(res1);
      const res2 = await recursiveResolver.resolveSoa('.');
      assert(res2);
    });

    it('should open full node with neither DNS server', async () => {
      node = new FullNode({
        memory: true,
        network: network.type,
        noDns: true
      });

      await node.open();
      await assert.rejects(
        rootResolver.resolveSoa('.'),
        {message: 'querySoa ECONNREFUSED .'}
      );
      await assert.rejects(
        recursiveResolver.resolveSoa('.'),
        {message: 'querySoa ECONNREFUSED .'}
      );
    });

    it('should open full node only with root name server', async () => {
      node = new FullNode({
        memory: true,
        network: network.type,
        noRs: true
      });

      await node.open();
      const res1 = await rootResolver.resolveSoa('.');
      assert(res1);
      await assert.rejects(
        recursiveResolver.resolveSoa('.'),
        {message: 'querySoa ECONNREFUSED .'}
      );
    });
  });

  describe('SPV Node', function() {
    let node;

    afterEach(async () => {
      await node.close();
    });

    it('should open SPV node with both DNS servers', async () => {
      node = new SPVNode({
        memory: true,
        network: network.type
      });

      await node.open();
      const res1 = await rootResolver.resolveSoa('.');
      assert(res1);
      const res2 = await recursiveResolver.resolveSoa('.');
      assert(res2);
    });

    it('should open SPV node with neither DNS server', async () => {
      node = new SPVNode({
        memory: true,
        network: network.type,
        noDns: true
      });

      await node.open();
      await assert.rejects(
        rootResolver.resolveSoa('.'),
        {message: 'querySoa ECONNREFUSED .'}
      );
      await assert.rejects(
        recursiveResolver.resolveSoa('.'),
        {message: 'querySoa ECONNREFUSED .'}
      );
    });

    it('should open SPV node only with root name server', async () => {
      node = new SPVNode({
        memory: true,
        network: network.type,
        noRs: true
      });

      await node.open();
      const res1 = await rootResolver.resolveSoa('.');
      assert(res1);
      await assert.rejects(
        recursiveResolver.resolveSoa('.'),
        {message: 'querySoa ECONNREFUSED .'}
      );
    });
  });
});
