/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const plugin = require('../lib/wallet/plugin');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
const {ChainEntry, FullNode, KeyRing, MTX, Network, Path} = require('..');
const {NodeClient, WalletClient} = require('hs-client');

class TestUtil {
  constructor(options) {
    if (!options)
      options = Object.create(null);

    if (!options.host)
      options.host = 'localhost';

    if (!options.nport)
      options.nport = 14037;

    if (!options.wport)
      options.wport = 14039;

    this.network = Network.get('regtest');

    this.txs = {};

    this.blocks = {};

    this.node = new FullNode({
      memory: true,
      workers: true,
      network: this.network.type
    });

    this.node.use(plugin);

    this.nclient = new NodeClient({
      timeout: 15000,
      host: options.host,
      port: options.nport
    });

    this.wclient = new WalletClient({
      host: options.host,
      port: options.wport
    });
  }

  /**
   * Execute an RPC using the wallet client.
   * @param {String}  method - RPC method
   * @param {Array}   params - method parameters
   * @returns {Promise} - Returns a two item array with the RPC's return value
   * or null as the first item and an error or null as the second item.
   */

  async wrpc(method, params = []) {
    return this.wclient.execute(method, params)
      .then(data => data)
      .catch((err) => {
        throw new Error(err);
      });
  }

  /**
   * Execute an RPC using the node client.
   * @param {String}  method - RPC method
   * @param {Array}   params - method parameters
   * @returns {Promise<Array>} - Returns a two item array with the
   * RPC's return value or null as the first item and an error or
   * null as the second item.
   */

  async nrpc(method, params = []) {
    return this.nclient.execute(method, params)
      .then(data => data)
      .catch((err) => {
        throw new Error(err);
      });
  }

  /**
   * Open the util and all its child objects.
   */

  async open() {
    assert(!this.opened, 'TestUtil is already open.');
    this.opened = true;

    await this.node.ensure();
    await this.node.open();
    await this.node.connect();
    this.node.startSync();

    await this.nclient.open();
    await this.wclient.open();

    this.node.plugins.walletdb.wdb.on('confirmed', ((details, tx) => {
      const txid = tx.txid();

      if (!this.txs[txid])
        this.txs[txid] = txid;
    }));

    this.nclient.bind('block connect', (data) => {
      const br = bio.read(data);
      const entry = (new ChainEntry()).read(br);
      const hash = entry.hash.toString('hex');

      if (!this.blocks[hash])
        this.blocks[hash] = hash;
    });
  }

  /**
   * Close util and all its child objects.
   */

  async close() {
    assert(this.opened, 'TestUtil is not open.');
    this.opened = false;

    await this.nclient.close();
    await this.wclient.close();
    await this.node.close();
  }

  async confirmTX(txid, timeout = 5000) {
    return common.forValue(this.txs, txid, txid, timeout);
  }

  async confirmBlock(hash, timeout = 5000) {
    return common.forValue(this.blocks, hash, hash, timeout);
  }
}

describe('Auction RPCs', function() {
  this.timeout(60000);

  const util = new TestUtil();
  const name = rules.grindName(2, 0, Network.get('regtest'));
  let winner, loser;

  const mineBlocks = async (num, wallet, account = 'default') => {
    const address = (await wallet.createAddress(account)).address;
    const hashes = await util.nrpc('generatetoaddress', [num, address]);
    await util.confirmBlock(hashes.pop());
  };

  // This function is a helper which:
  // - validates HD path of provided mtx
  // - signs the mtx using the corresponding private key
  // - submits and mines the signed tx, if submit argument is true
  const processJSON = async (json, submit, wallet = winner) => {
    const mtx = MTX.fromJSON(json);

    for (let i = 0; i < mtx.inputs.length; i++) {
      const input = mtx.inputs[i];
      const coin = mtx.view.getCoinFor(input);
      const path = mtx.view.getPathFor(input);
      const address = coin.address.toString('regtest');
      const key = await wallet.getKey(address);

      // Assert HD path.
      assert.ok(path instanceof Path);
      assert.deepStrictEqual(path.name, key.name);
      assert.deepStrictEqual(path.account, key.account);
      assert.deepStrictEqual(path.branch, key.branch);
      assert.deepStrictEqual(path.index, key.index);

      // Sign mtx.
      const secret = (await wallet.getWIF(address)).privateKey;
      const ring = KeyRing.fromSecret(secret);
      mtx.sign(ring);
    };

    // Verify mtx.
    assert(mtx.verify());

    // Submit and mine mtx, if necessary.
    if (submit) {
      await util.nrpc('sendrawtransaction', [mtx.encode().toString('hex')]);
      await mineBlocks(1, wallet);
      await util.confirmTX(mtx.txid());
    }

    return mtx;
  };

  before(async () => {
    util.node.network.coinbaseMaturity = 1;
    await util.open();
    await util.wclient.createWallet('loser');
    winner = await util.wclient.wallet('primary');
    loser = await util.wclient.wallet('loser');
    await mineBlocks(5, winner);
    await mineBlocks(5, loser);
  });

  after(async () => {
    util.node.network.coinbaseMaturity = 2;
    await util.close();
  });

  it('should create OPEN with signing paths', async () => {
    // Create, assert, submit and mine OPEN.
    const submit = true;
    const json = await util.wrpc('createopen', [name]);
    await processJSON(json, submit, winner);

    // Mine past OPEN period.
    await mineBlocks(util.network.names.treeInterval, winner);
  });

  it('should create BID with signing paths', async () => {
    // Create loser's BID.
    await util.wrpc('selectwallet', [loser.id]);
    assert(await util.wrpc('sendbid', [name, 4, 10]));

    // Create, assert, submit and mine winner's BID.
    await util.wrpc('selectwallet', [winner.id]);
    const submit = true;
    const json = await util.wrpc('createbid', [name, 5, 10]);
    await processJSON(json, submit);

    // Mine past BID period.
    await mineBlocks(util.network.names.biddingPeriod, winner);
  });

  it('should create REVEAL with signing paths', async () => {
    // Create loser's REVEAL.
    await util.wrpc('selectwallet', [loser.id]);
    assert(await util.wrpc('sendreveal', [name]));

    // Create, assert, submit and mine REVEAL.
    await util.wrpc('selectwallet', [winner.id]);
    const submit = true;
    const json = await util.wrpc('createreveal', [name]);
    await processJSON(json, submit);

    // Mine past REVEAL period.
    await mineBlocks(util.network.names.revealPeriod, winner);
  });

  it('should create REDEEM with signing paths', async () => {
    // Create, assert, submit and mine REDEEM.
    await util.wrpc('selectwallet', [loser.id]);
    const submit = true;
    const json = await util.wrpc('createredeem', [name]);
    await processJSON(json, submit, loser);
  });

  it('should create REGISTER with signing paths', async () => {
    // Create, assert, submit and mine REGISTER.
    await util.wrpc('selectwallet', [winner.id]);
    const submit = true;
    const json = await util.wrpc('createupdate', [name, {
      records: [
        {
          type: 'NS',
          ns: 'example.com.'
        }
      ]
    }]);
    await processJSON(json, submit);

    // Mine some blocks.
    await mineBlocks(util.network.names.treeInterval, winner);
  });

  it('should create RENEW with signing paths', async () => {
    // Create, assert, submit and mine RENEW.
    const submit = true;
    const json = await util.wrpc('createrenewal', [name]);
    await processJSON(json, submit);
  });

  it('should create TRANSFER with signing paths', async () => {
    // Create, assert, submit and mine TRANSFER.
    const submit = true;
    const address = (await loser.createAddress('default')).address;
    const json = await util.wrpc('createtransfer', [name, address]);
    await processJSON(json, submit);
  });

  it('Should create TRANSFER cancellation with signing paths', async () => {
    // Create, assert, submit and mine TRANSFER cancellation.
    const submit = true;
    const json = await util.wrpc('createcancel', [name]);
    await processJSON(json, submit);
  });

  it('should create FINALIZE with signing paths', async () => {
    // Submit TRANSFER.
    const address = (await loser.createAddress('default')).address;
    await util.wrpc('selectwallet', [winner.id]);
    assert(await util.wrpc('sendtransfer', [name, address]));

    // Mine past TRANSFER lockup period.
    await mineBlocks(util.network.names.transferLockup, winner);

    // Create, assert, submit and mine FINALIZE.
    const submit = true;
    const json = await util.wrpc('createfinalize', [name]);
    await processJSON(json, submit);
  });

  it('should create REVOKE with signing paths', async () => {
    // Create, assert, submit and mine REVOKE.
    await util.wrpc('selectwallet', [loser.id]);
    const submit = true;
    const json = await util.wrpc('createrevoke', [name]);
    await processJSON(json, submit, loser, true);
  });
});
