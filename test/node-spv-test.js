'use strict';

const assert = require('bsert');
const SPVNode = require('../lib/node/spvnode');
const rules = require('../lib/covenants/rules');

describe('SPV Node', function() {
  describe('Filter update', function() {
    const node = new SPVNode({
      memory: true,
      network: 'regtest',
      plugins: [require('../lib/wallet/plugin')]
    });

    const pool = node.pool;
    const {wdb} = node.require('walletdb');
    let wallet;

    const name1 = 'control'; // never add
    const hash1 = rules.hashName(name1);
    const name2 = 'lettuce';
    const hash2 = rules.hashName(name2);
    const name3 = 'tomato';
    const hash3 = rules.hashName(name3);

    // This function normally calls
    // peer.sendFilterLoad(this.spvFilter)
    // for each peer in pool.
    // This stub hands us the filter directly without any p2p connections.
    pool.sendFilterLoad = () => {
      pool.emit('filter load', pool.spvFilter);
    };

    before(async () => {
      await node.open();
      wallet = await wdb.get('primary');
    });

    after(async () => {
      await node.close();
    });

    it('should test false for all names', () => {
      assert(!wdb.filter.test(hash1));
      assert(!wdb.filter.test(hash2));
      assert(!wdb.filter.test(hash3));
      assert(!pool.spvFilter.test(hash1));
      assert(!pool.spvFilter.test(hash2));
      assert(!pool.spvFilter.test(hash3));
    });

    it('should import name (wallet) and update filter', async () => {
      const waiter = new Promise((resolve) => {
        pool.once('filter load', (filter) => {
          resolve(filter);
        });
      });
      await wallet.importName(name2);

      // WalletDB filter has added name
      assert(!wdb.filter.test(hash1));
      assert(wdb.filter.test(hash2));
      assert(!wdb.filter.test(hash3));

      // Filter sent from pool has also added name
      const filter = await waiter;
      assert(!filter.test(hash1));
      assert(filter.test(hash2));
      assert(!filter.test(hash3));
    });

    it('should watch name (pool) and update filter again', async () => {
      const waiter = new Promise((resolve) => {
        pool.once('filter load', (filter) => {
          resolve(filter);
        });
      });
      await pool.watchName(hash3);

      // Filter sent from pool has added name
      const filter = await waiter;
      assert(!filter.test(hash1));
      assert(filter.test(hash2));
      assert(filter.test(hash3));

      // ...so has walletDB filter
      // (seems backwards, but the filters are the same literal object)
      assert(!wdb.filter.test(hash1));
      assert(wdb.filter.test(hash2));
      assert(wdb.filter.test(hash3));
    });
  });
});
