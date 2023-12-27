'use strict';

const assert = require('bsert');
const bio = require('bufio');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
const {
  ChainEntry,
  KeyRing,
  MTX,
  Network,
  Path
} = require('..');
const {forValue} = require('./util/common');
const NodeContext = require('./util/node-context');

class TestUtil {
  constructor() {
    this.nodeCtx = new NodeContext({
      memory: true,
      workers: true,
      listen: true,
      bip37: true,
      wallet: true
    });

    this.nodeCtx.init();

    this.network = this.nodeCtx.network;
    this.txs = {};
    this.blocks = {};

    this.node = this.nodeCtx.node;
  }

  get nclient() {
    return this.nodeCtx.nclient;
  }

  get wclient() {
    return this.nodeCtx.wclient;
  }

  wrpc(method, params = []) {
    return this.nodeCtx.wrpc(method, params);
  }

  nrpc(method, params = []) {
    return this.nodeCtx.nrpc(method, params);
  }

  async open() {
    assert(!this.opened, 'TestUtil is already open.');
    this.opened = true;

    await this.nodeCtx.open();

    this.nodeCtx.wdb.on('confirmed', ((details, tx) => {
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

  async close() {
    await this.nodeCtx.close();
  }

  async confirmTX(txid, timeout = 5000) {
    return common.forValue(this.txs, txid, txid, timeout);
  }

  async confirmBlock(hash, timeout = 5000) {
    return common.forValue(this.blocks, hash, hash, timeout);
  }
}

const GNAME_SIZE = 10;

describe('Auction RPCs', function() {
  this.timeout(60000);

  const util = new TestUtil();
  const name = rules.grindName(GNAME_SIZE, 0, Network.get('regtest'));
  let winner, loser;
  const winnerBid = {
    bid: 5,
    lockup: 10
  };
  const loserBid ={
    bid: 4,
    lockup: 10
  };
  const COIN = 1e6;
  let signAddr, signSig;
  const signMsg = 'The Defendants are engaged in a campaign of chaos.';

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
    assert(await util.wrpc('sendbid', [name, loserBid.bid, loserBid.lockup]));

    // Create, assert, submit and mine winner's BID.
    await util.wrpc('selectwallet', [winner.id]);
    const submit = true;
    const json = await util.wrpc(
      'createbid',
      [name, winnerBid.bid, winnerBid.lockup]
    );
    await processJSON(json, submit);

    // Mine past BID period.
    await mineBlocks(util.network.names.biddingPeriod, winner);
  });

  it('should get all BIDs for name', async () => {
    // Loser gets all bids
    await util.wrpc('selectwallet', [loser.id]);
    const all = await util.wrpc('getbids', [name]);
    assert.strictEqual(all.length, 2);
    let own = 0;
    let unown = 0;
    for (const bid of all) {
      // "unrevealed" not set.
      assert(!bid.address);

      if (bid.own)
        own++;
      else
        unown++;
    }
    assert.strictEqual(own, 1);
    assert.strictEqual(unown, 1);
  });

  it('should get only owned BIDs for name', async () => {
    await util.wrpc('selectwallet', [loser.id]);
    const bids = await util.wrpc('getbids', [name, true]);
    assert.strictEqual(bids.length, 1);
    let own = 0;
    let unown = 0;
    for (const bid of bids) {
      // "unrevealed" not set.
      assert(!bid.address);

      if (bid.own)
        own++;
      else
        unown++;
    }
    assert.strictEqual(own, 1);
    assert.strictEqual(unown, 0);
  });

  it('should get unrevealed BIDs for name', async () => {
    await util.wrpc('selectwallet', [loser.id]);
    const bids = await util.wrpc('getbids', [name, true, true]);
    assert.strictEqual(bids.length, 1);
    let own = 0;
    let unown = 0;
    for (const bid of bids) {
      // Unrevealed bids come with their address
      assert(bid.address);

      if (bid.own)
        own++;
      else
        unown++;
    }
    assert.strictEqual(own, 1);
    assert.strictEqual(unown, 0);
  });

  it('should have enough data to import nonce', async () => {
    await util.wrpc('selectwallet', [loser.id]);
    // Same as last test, getting "owned" and "unrevealed" BIDs only
    const bids = await util.wrpc('getbids', [name, true, true]);
    assert.strictEqual(bids.length, 1);

    const bid = bids[0];
    const bidName = bid.name;
    const bidAddress = bid.address;
    const bidValue = bid.value;
    const bidLockup = bid.lockup;
    const bidBlind = bid.blind;

    assert.strictEqual(name, bidName);
    assert.strictEqual(loserBid.bid  * COIN, bidValue);
    assert.strictEqual(loserBid.lockup * COIN, bidLockup);

    // In this case, "loser" already knows their blind value,
    // but we can still check that importnonce works by returning
    // that same value. Note that "loser" MUST remember their original
    // bid value. If this were a wallet recovery scenario, that value
    // would have to be entered by the user without data from the blockchain.
    const importedBlinds = await util.wrpc(
      'importnonce',
      [bidName, bidAddress, loserBid.bid]
    );
    assert.strictEqual(importedBlinds[0], bidBlind);
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

  it('should request only unrevealed BIDs for name and find none', async () => {
    await util.wrpc('selectwallet', [loser.id]);
    const owned = await util.wrpc('getbids', [name, true, false]);
    const unrevealed = await util.wrpc('getbids', [name, true, true]);

    assert.strictEqual(owned.length, 1);
    assert.strictEqual(unrevealed.length, 0);
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
    signAddr = (await loser.createAddress('default')).address;
    await util.wrpc('selectwallet', [winner.id]);
    assert(await util.wrpc('sendtransfer', [name, signAddr]));

    // Mine past TRANSFER lockup period.
    await mineBlocks(util.network.names.transferLockup, winner);

    // Create, assert, submit and mine FINALIZE.
    const submit = true;
    const json = await util.wrpc('createfinalize', [name]);
    await processJSON(json, submit);
  });

  it('should verify signed message', async () => {
    // Sign and save
    await util.wrpc('selectwallet', [loser.id]);
    signSig = await util.wrpc('signmessagewithname', [name, signMsg]);

    // Verify at current height
    assert(await util.nrpc('verifymessagewithname', [name, signSig, signMsg]));

    // Unable to verify at safe height, historical UTXO is spent
    await assert.rejects(
      util.nrpc('verifymessagewithname', [name, signSig, signMsg, true]),
      {message: /Cannot find the owner's address/}
    );

    // Mine 20 blocks (safe height is still 12 confirmations even on regtest)
    await mineBlocks(20, winner);

    // Verify at current height
    assert(await util.nrpc('verifymessagewithname', [name, signSig, signMsg]));

    // Verify at safe height
    assert(await util.nrpc('verifymessagewithname', [name, signSig, signMsg, true]));
  });

  it('should create REVOKE with signing paths', async () => {
    // Create, assert, submit and mine REVOKE.
    await util.wrpc('selectwallet', [loser.id]);
    const submit = true;
    const json = await util.wrpc('createrevoke', [name]);
    await processJSON(json, submit, loser, true);
  });

  it('should not verify signed message after REVOKE', async () => {
    await assert.rejects(
      util.nrpc('verifymessagewithname', [name, signSig, signMsg]),
      {message: /Invalid name state/}
    );
  });

  it('should not verify signed message at safe height after REVOKE', async () => {
    // This safe height is before the REVOKE was confirmed, back when
    // the name state was still valid. However, the UTXO that owned the name
    // in that state has been spent and no longer exists.
    await assert.rejects(
      util.nrpc('verifymessagewithname', [name, signSig, signMsg, true]),
      {message: /Cannot find the owner's address/}
    );
  });

  describe('SPV', function () {
    const spvCtx = new NodeContext({
      httpPort: 30000,
      only: '127.0.0.1',
      noDns: true,

      spv: true
    });

    before(async () => {
      await util.node.connect();
      await spvCtx.open();

      await forValue(spvCtx.chain, 'height', util.node.chain.height);
    });

    after(async () => {
      await spvCtx.close();
    });

    it('should not get current namestate', async () => {
      const {info} = await spvCtx.nrpc('getnameinfo', [name]);
      assert.strictEqual(info, null);
    });

    it('should get historcial namestate at safe height', async () => {
      const {info} = await spvCtx.nrpc('getnameinfo', [name, true]);
      assert.strictEqual(info.name, name);
      assert.strictEqual(info.state, 'CLOSED');
      assert.strictEqual(info.value, loserBid.bid * COIN);
      assert.strictEqual(info.highest, winnerBid.bid * COIN);
    });

    it('should not get current resource', async () => {
      const json = await spvCtx.nrpc('getnameresource', [name]);
      assert.strictEqual(json, null);
    });

    it('should get historcial resource at safe height', async () => {
      const json = await spvCtx.nrpc('getnameresource', [name, true]);
      assert.deepStrictEqual(
        json,
        {
          records: [
            {
              type: 'NS',
              ns: 'example.com.'
            }
          ]
        }
      );
    });

    it('should not verifymessagewithname', async () => {
      // No local Urkel tree, namestate is always null
      await assert.rejects(
        spvCtx.nrpc('verifymessagewithname', [name, signSig, signMsg]),
        {message: /Cannot find the name owner/}
      );
    });

    it('should not verifymessagewithname at safe height', async () => {
      // This time we do have a valid namestate to work with, but
      // SPV nodes still don't have a UTXO set to get addresses from
      await assert.rejects(
        spvCtx.nrpc('verifymessagewithname', [name, signSig, signMsg, true]),
        {message: /Cannot find the owner's address/}
      );
    });
  });
});
