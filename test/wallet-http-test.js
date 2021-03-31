/*!
 * test/wallet-http-test.js - test for wallet http endoints
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const {NodeClient, WalletClient} = require('namebase-hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const {isSignatureEncoding, isKeyEncoding} = require('../lib/script/common');
const {Resource} = require('../lib/dns/resource');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const HD = require('../lib/hd/hd');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const secp256k1 = require('bcrypto/lib/secp256k1');
const network = Network.get('regtest');
const assert = require('bsert');
const common = require('./util/common');

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

const wallet = wclient.wallet('primary');
const wallet2 = wclient.wallet('secondary');

let name, name2, cbAddress;
const accountTwo = 'foobar';

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

describe('Wallet HTTP', function() {
  this.timeout(100000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    await wclient.createWallet('secondary');
    cbAddress  = (await wallet.createAddress('default')).address;
    await wallet.createAccount(accountTwo);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

  beforeEach(async () => {
    name = await nclient.execute('grindname', [5]);
    name2 = await nclient.execute('grindname', [5]);
  });

  afterEach(async () => {
    await node.mempool.reset();
  });

  it('should get key by address from watch-only', async () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon '
      + 'abandon abandon abandon abandon abandon about';
    const master = HD.HDPrivateKey.fromPhrase(phrase);
    const xprv = master.deriveAccount(44, 5355, 5);
    const xpub = xprv.toPublic();
    const pubkey = xpub.derive(0).derive(0);
    const addr = Address.fromPubkey(pubkey.publicKey);
    const wallet = wclient.wallet('watchonly');
    await wclient.createWallet('watchonly', {
      watchOnly: true,
      accountKey: xpub.xpubkey('regtest')
    });
    const key = await wallet.getKey(addr.toString('regtest'));
    assert.equal(xpub.childIndex ^ HD.common.HARDENED, key.account);
    assert.equal(0, key.branch);
    assert.equal(0, key.index);
  });

  it('should mine to the primary/default wallet', async () => {
    const height = 20;

    await mineBlocks(height, cbAddress);

    const info = await nclient.getInfo();
    assert.equal(info.chain.height, height);

    const accountInfo = await wallet.getAccount('default');
    // each coinbase output was indexed
    assert.equal(accountInfo.balance.coin, height);

    const coins = await wallet.getCoins();
    // the wallet has no previous history besides
    // what it has mined
    assert.ok(coins.every(coin => coin.coinbase === true));
  });

  it('should create a transaction', async () => {
    const tx = await wallet.createTX({
      outputs: [{ address: cbAddress, value: 1e4 }]
    });

    assert.ok(tx);
    assert.equal(tx.outputs.length, 1 + 1); // send + change
    assert.equal(tx.locktime, 0);
  });

  it('should create a transaction with HD paths', async () => {
    const tx = await wallet.createTX({
      paths: true,
      outputs: [{ address: cbAddress, value: 1e4 }]
    });

    assert.ok(tx);
    assert.ok(tx.inputs);

    for (let i = 0; i < tx.inputs.length; i++) {
      const path = tx.inputs[i].path;

      assert.ok(typeof path.name === 'string');
      assert.ok(typeof path.account === 'number');
      assert.ok(typeof path.change === 'boolean');
      assert.ok(typeof path.derivation === 'string');
    }
  });

  it('should create a transaction with a locktime', async () => {
    const locktime = 8e6;

    const tx = await wallet.createTX({
      locktime: locktime,
      outputs: [{ address: cbAddress, value: 1e4 }]
    });

    assert.equal(tx.locktime, locktime);
  });

  it('should create a transaction that is not bip 69 sorted', async () => {
    // create a list of outputs that descend in value
    // bip 69 sorts in ascending order based on the value
    const outputs = [];
    for (let i = 0; i < 5; i++) {
      const addr = await wallet.createAddress('default');
      outputs.push({ address: addr.address, value: (5 - i) * 1e5 });
    }

    const tx = await wallet.createTX({
      outputs: outputs,
      sort: false
    });

    // assert outputs in the same order that they were sent from the client
    for (const [i, output] of outputs.entries()) {
      assert.equal(tx.outputs[i].value, output.value);
      assert.equal(tx.outputs[i].address.toString(network), output.address);
    }

    const mtx = MTX.fromJSON(tx);
    mtx.sortMembers();

    // the order changes after sorting
    assert.ok(tx.outputs[0].value !== mtx.outputs[0].value);
  });

  it('should create a transaction that is bip 69 sorted', async () => {
    const outputs = [];
    for (let i = 0; i < 5; i++) {
      const addr = await wallet.createAddress('default');
      outputs.push({ address: addr.address, value: (5 - i) * 1e5 });
    }

    const tx = await wallet.createTX({
      outputs: outputs
    });

    const mtx = MTX.fromJSON(tx);
    mtx.sortMembers();

    // assert the ordering of the outputs is the
    // same after sorting the response client side
    for (const [i, output] of tx.outputs.entries()) {
      assert.equal(output.value, mtx.outputs[i].value);
      assert.equal(output.address, mtx.outputs[i].address.toString(network));
    }
  });

  it('should mine to the secondary/default wallet', async () => {
    const height = 5;

    const {address} = await wallet2.createAddress('default');
    await mineBlocks(height, address);

    const accountInfo = await wallet2.getAccount('default');
    assert.equal(accountInfo.balance.coin, height);
  });

  it('should have no name state indexed initially', async () => {
    const names = await wallet.getNames();

    assert.strictEqual(names.length, 0);
  });

  it('should allow covenants with create tx', async () => {
    const {address} = await wallet.createChange('default');

    const output = openOutput(name, address);

    const mtx = new MTX();
    mtx.outputs.push(output);

    const tx = await wallet.createTX(mtx);
    assert.equal(tx.outputs[0].covenant.type, types.OPEN);
  });

  it('should allow covenants with send tx', async () => {
    const {address} = await wallet.createChange('default');

    const output = openOutput(name, address);

    const mtx = new MTX();
    mtx.outputs.push(output);

    const tx = await wallet.send(mtx);
    assert.equal(tx.outputs[0].covenant.type, types.OPEN);
  });

  it('should create an open and broadcast the tx', async () => {
    let emitted = 0;
    const handler = () => emitted++;
    node.mempool.on('tx', handler);

    const json = await wallet.createOpen({
      name: name
    });

    // wait for tx event on mempool
    await common.event(node.mempool, 'tx');

    const mempool = await nclient.getMempool();

    assert.ok(mempool.includes(json.hash));

    const opens = json.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);

    assert.equal(emitted, 1);

    // reset for next test
    node.mempool.removeListener('tx', handler);
  });

  it('should create an open and not broadcast the transaction', async () => {
    let entered = false;
    const handler = () => entered = true;
    node.mempool.on('tx', handler);

    const json = await wallet.createOpen({
      name: name,
      broadcast: false
    });

    await sleep(500);

    // tx is not in the mempool
    assert.equal(entered, false);
    const mempool = await nclient.getMempool();
    assert.ok(!mempool.includes(json.hash));

    const mtx = MTX.fromJSON(json);
    assert.ok(mtx.hasWitness());

    // the signature and pubkey are templated correctly
    const sig = mtx.inputs[0].witness.get(0);
    assert.ok(isSignatureEncoding(sig));
    const pubkey = mtx.inputs[0].witness.get(1);
    assert.ok(isKeyEncoding(pubkey));
    assert.ok(secp256k1.publicKeyVerify(pubkey));

    // transaction is valid
    assert.ok(mtx.verify());

    const opens = mtx.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);

    // reset for next test
    node.mempool.removeListener('tx', handler);
  });

  it('should create an open and not sign the transaction', async () => {
    let entered = false;
    const handler = () => entered = true;
    node.mempool.on('tx', handler);

    const json = await wallet.createOpen({
      name: name,
      broadcast: false,
      sign: false
    });

    await sleep(500);

    // tx is not in the mempool
    assert.equal(entered, false);
    const mempool = await nclient.getMempool();
    assert.ok(!mempool.includes(json.hash));

    // the signature is templated as an
    // empty buffer
    const mtx = MTX.fromJSON(json);
    const sig = mtx.inputs[0].witness.get(0);
    assert.bufferEqual(Buffer.from(''), sig);
    assert.ok(!isSignatureEncoding(sig));

    // the pubkey is properly templated
    const pubkey = mtx.inputs[0].witness.get(1);
    assert.ok(isKeyEncoding(pubkey));
    assert.ok(secp256k1.publicKeyVerify(pubkey));

    // transaction not valid
    assert.equal(mtx.verify(), false);

    // reset for next test
    node.mempool.removeListener('tx', handler);
  });

  it('should throw error with incompatible broadcast and sign options', async () => {
    const fn = async () => await (wallet.createOpen({
      name: name,
      broadcast: true,
      sign: false
    }));

    await assert.rejects(fn, {message: 'Must sign when broadcasting.'});
  });

  it('should fail to create open for account with no monies', async () => {
    const info = await wallet.getAccount(accountTwo);
    assert.equal(info.balance.tx, 0);
    assert.equal(info.balance.coin, 0);

    const fn = async () => (await wallet.createOpen({
      name: name,
      account: accountTwo
    }));

    await assert.rejects(fn, {message: /Not enough funds./});
  });

  it('should mine to the account with no monies', async () => {
    const height = 5;

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    await mineBlocks(height, receiveAddress);

    const info = await wallet.getAccount(accountTwo);
    assert.equal(info.balance.tx, height);
    assert.equal(info.balance.coin, height);
  });

  it('should create open for specific account', async () => {
    const json = await wallet.createOpen({
      name: name,
      account: accountTwo
    });

    const info = await wallet.getAccount(accountTwo);

    // assert that each of the inputs belongs to the account
    for (const {address} of json.inputs) {
      const keyInfo = await wallet.getKey(address);
      assert.equal(keyInfo.name, info.name);
    }
  });

  it('should open an auction', async () => {
    await wallet.createOpen({
      name: name
    });

    // save chain height for later comparison
    const info = await nclient.getInfo();

    await mineBlocks(treeInterval + 1, cbAddress);

    const json = await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const bids = json.outputs.filter(output => output.covenant.type === types.BID);
    assert.equal(bids.length, 1);

    const [bid] = bids;
    assert.equal(bid.covenant.items.length, 4);

    const [nameHash, start, rawName, blind] = bid.covenant.items;
    assert.equal(nameHash, rules.hashName(name).toString('hex'));

    // initially opened in the first block mined, so chain.height + 1
    const hex = Buffer.from(start, 'hex').reverse().toString('hex');
    assert.equal(parseInt(hex, 16), info.chain.height + 1);

    assert.equal(rawName, Buffer.from(name, 'ascii').toString('hex'));

    // blind is type string, so 32 * 2
    assert.equal(blind.length, 32 * 2);
  });

  it('should be able to get nonce', async () => {
    const bid = 100;

    const response = await wallet.getNonce(name, {
      address: cbAddress,
      bid: bid
    });

    const address = Address.fromString(cbAddress, network.type);
    const nameHash = rules.hashName(name);

    const primary = node.plugins.walletdb.wdb.primary;
    const nonce = await primary.generateNonce(nameHash, address, bid);
    const blind = rules.blind(bid, nonce);

    assert.deepStrictEqual(response, {
      address: address.toString(network.type),
      blind: blind.toString('hex'),
      nonce: nonce.toString('hex'),
      bid: bid,
      name: name,
      nameHash: nameHash.toString('hex')
    });
  });

  it('should be able to get nonce for bid=0', async () => {
    const bid = 0;

    const response = await wallet.getNonce(name, {
      address: cbAddress,
      bid: bid
    });

    const address = Address.fromString(cbAddress, network.type);
    const nameHash = rules.hashName(name);

    const primary = node.plugins.walletdb.wdb.primary;
    const nonce = await primary.generateNonce(nameHash, address, bid);
    const blind = rules.blind(bid, nonce);

    assert.deepStrictEqual(response, {
      address: address.toString(network.type),
      blind: blind.toString('hex'),
      nonce: nonce.toString('hex'),
      bid: bid,
      name: name,
      nameHash: nameHash.toString('hex')
    });
  });

  it('should get name info', async () => {
    const names = await wallet.getNames();

    assert(names.length > 0);
    const [ns] = names;

    const nameInfo = await wallet.getName(ns.name);

    assert.deepEqual(ns, nameInfo);
  });

  it('should fail to open a bid without a bid value', async () => {
    const fn = async () => (await wallet.createBid({
      name: name
    }));

    await assert.rejects(fn, {message: 'Bid is required.'});
  });

  it('should fail to open a bid without a lockup value', async () => {
    const fn = async () => (await wallet.createBid({
      name: name,
      bid: 1000
    }));

    await assert.rejects(fn, {message: 'Lockup is required.'});
  });

  it('should send bid with 0 value and non-dust lockup', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 0,
      lockup: 1000
    });
  });

  it('should fail to send bid with 0 value and 0 lockup', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const fn = async () => await wallet.createBid({
      name: name,
      bid: 0,
      lockup: 0
    });

    await assert.rejects(fn, {message: 'Output is dust.'});
  });

  it('should get all bids (single player)', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const tx1 = await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const tx2 = await wallet.createBid({
      name: name,
      bid: 2000,
      lockup: 3000
    });

    const tx3 = await wallet.createBid({
      name: name,
      bid: 4000,
      lockup: 5000
    });

    await mineBlocks(1, cbAddress);

    // this method gets all bids for all names
    const bids = await wallet.getBids();

    // this depends on this it block creating
    // the first bids of this test suite
    assert.equal(bids.length, 3);
    assert.ok(bids.every(bid => bid.name === name));

    // tx1
    assert.ok(bids.find(bid =>
      (bid.value === 1000
        && bid.lockup === 2000
        && bid.prevout.hash === tx1.hash)
    ));

    // tx2
    assert.ok(bids.find(bid =>
      (bid.value === 2000
        && bid.lockup === 3000
        && bid.prevout.hash === tx2.hash)
    ));

    // tx3
    assert.ok(bids.find(bid =>
      (bid.value === 4000
        && bid.lockup === 5000
        && bid.prevout.hash === tx3.hash)
    ));
  });

  it('should get all bids (two players)', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const tx1 = await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const tx2 = await wallet2.createBid({
      name: name,
      bid: 2000,
      lockup: 3000
    });

    await mineBlocks(1, cbAddress);

    {
      await sleep(100);
      // fetch all bids for the name
      const bids = await wallet.getBidsByName(name);
      assert.equal(bids.length, 2);

      // there is no value property on bids
      // from other wallets
      assert.ok(bids.find(bid =>
        (bid.lockup === 2000
          && bid.prevout.hash === tx1.hash)
      ));

      assert.ok(bids.find(bid =>
        (bid.lockup === 3000
          && bid.prevout.hash === tx2.hash)
      ));
    }

    {
      // fetch only own bids for the name
      const bids = await wallet.getBidsByName(name, {own: true});
      assert.equal(bids.length, 1);
      const [bid] = bids;
      assert.equal(bid.prevout.hash, tx1.hash);
    }
  });

  it('should create a reveal', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const {info} = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.name, name);
    assert.equal(info.state, 'REVEAL');

    const json = await wallet.createReveal({
      name: name
    });

    const reveals = json.outputs.filter(output => output.covenant.type === types.REVEAL);
    assert.equal(reveals.length, 1);
  });

  it('should create all reveals', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    for (let i = 0; i < 3; i++) {
      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const {info} = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.name, name);
    assert.equal(info.state, 'REVEAL');

    const json = await wallet.createReveal();

    const reveals = json.outputs.filter(output => output.covenant.type === types.REVEAL);
    assert.equal(reveals.length, 3);
  });

  it('should get all reveals (single player)', async () => {
    await wallet.createOpen({
      name: name
    });

    const name2 = await nclient.execute('grindname', [5]);

    await wallet.createOpen({
      name: name2
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await wallet.createBid({
      name: name2,
      bid: 2000,
      lockup: 3000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await wallet.createReveal({
      name: name2
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    {
      const reveals = await wallet.getReveals();
      assert.equal(reveals.length, 2);
    }

    {
      // a single reveal per name
      const reveals = await wallet.getRevealsByName(name);
      assert.equal(reveals.length, 1);
    }
  });

  // this test creates namestate to use duing the
  // next test, hold on to the name being used.
  const state = {
    name: '',
    bids: [],
    reveals: []
  };

  it('should get own reveals (two players)', async () => {
    state.name = name;

    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const b1 = await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const b2 = await wallet2.createBid({
      name: name,
      bid: 2000,
      lockup: 3000
    });

    state.bids.push(b1);
    state.bids.push(b2);

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const r1 = await wallet.createReveal({
      name: name
    });

    const r2 = await wallet2.createReveal({
      name: name
    });

    state.reveals.push(r1);
    state.reveals.push(r2);

    await mineBlocks(revealPeriod + 1, cbAddress);

    {
      const reveals = await wallet.getRevealsByName(name, {own: true});
      assert.equal(reveals.length, 1);
      const [reveal] = reveals;
      assert.equal(reveal.own, true);
      assert.equal(reveal.prevout.hash, r1.hash);
    }

    {
      const reveals = await wallet.getRevealsByName(name);
      assert.equal(reveals.length, 2);

      assert.ok(reveals.find(reveal =>
        reveal.prevout.hash === r1.hash
      ));

      assert.ok(reveals.find(reveal =>
        reveal.prevout.hash === r2.hash
      ));
    }
  });

  it('should get auction info', async () => {
    const ns = await wallet.getName(state.name);

    const auction = await wallet.getAuctionByName(ns.name);

    // auction info returns a list of bids
    // and a list of reveals for the name
    assert.ok(Array.isArray(auction.bids));
    assert.ok(Array.isArray(auction.reveals));

    // 2 bids and 2 reveals in the previous test
    assert.equal(auction.bids.length, 2);
    assert.equal(auction.reveals.length, 2);

    // ordering can be nondeterministic
    function matchTxId(namestates, target) {
      assert.ok(namestates.find(ns => ns.prevout.hash === target));
    }

    matchTxId(auction.bids, state.bids[0].hash);
    matchTxId(auction.bids, state.bids[1].hash);
    matchTxId(auction.reveals, state.reveals[0].hash);
    matchTxId(auction.reveals, state.reveals[1].hash);
  });

  it('should create a bid and a reveal (reveal in advance)', async () => {
    const balanceBeforeTest = await wallet.getBalance();
    const lockConfirmedBeforeTest = balanceBeforeTest.lockedConfirmed;
    const lockUnconfirmedBeforeTest = balanceBeforeTest.lockedUnconfirmed;

    await wallet.createOpen({ name: name });

    await mineBlocks(treeInterval + 2, cbAddress);

    const balanceBeforeBid = await wallet.getBalance();
    assert.equal(balanceBeforeBid.lockedConfirmed - lockConfirmedBeforeTest, 0);
    assert.equal(
      balanceBeforeBid.lockedUnconfirmed - lockUnconfirmedBeforeTest,
      0
    );

    const bidValue = 1000000;
    const lockupValue = 5000000;

    const auctionTxs = await wallet.client.post(
      `/wallet/${wallet.id}/auction`,
      {
        name: name,
        bid: 1000000,
        lockup: 5000000,
        broadcastBid: true
      }
    );

    await mineBlocks(biddingPeriod + 1, cbAddress);

    let walletAuction = await wallet.getAuctionByName(name);
    const bidFromWallet = walletAuction.bids.find(
      b => b.prevout.hash === auctionTxs.bid.hash
    );
    assert(bidFromWallet);

    const { info } = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.name, name);
    assert.equal(info.state, 'REVEAL');

    const b5 = await wallet.getBalance();
    assert.equal(b5.lockedConfirmed - lockConfirmedBeforeTest, lockupValue);
    assert.equal(b5.lockedUnconfirmed - lockUnconfirmedBeforeTest, lockupValue);

    await nclient.broadcast(auctionTxs.reveal.hex);
    await mineBlocks(1, cbAddress);

    walletAuction = await wallet.getAuctionByName(name);
    const revealFromWallet = walletAuction.reveals.find(
      b => b.prevout.hash === auctionTxs.reveal.hash
    );
    assert(revealFromWallet);

    const b6 = await wallet.getBalance();
    assert.equal(b6.lockedConfirmed - lockConfirmedBeforeTest, bidValue);
    assert.equal(b6.lockedUnconfirmed - lockUnconfirmedBeforeTest, bidValue);

    await mineBlocks(revealPeriod + 1, cbAddress);

    const ns = await nclient.execute('getnameinfo', [name]);
    const coin = await wallet.getCoin(ns.info.owner.hash, ns.info.owner.index);
    assert.ok(coin);
  });

  it('should create a redeem', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // wallet2 wins the auction, wallet can submit redeem
    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await wallet2.createBid({
      name: name,
      bid: 2000,
      lockup: 3000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await wallet2.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    // wallet2 is the winner, therefore cannot redeem
    const fn = async () => (await wallet2.createRedeem({
      name: name
    }));

    await assert.rejects(fn, {message: `No reveals to redeem: "${name}".`});

    const json = await wallet.createRedeem({
      name: name
    });

    const redeem = json.outputs.filter(({covenant}) => covenant.type === types.REDEEM);
    assert.ok(redeem.length > 0);
  });

  it('should create an update', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    {
      const json = await wallet.createUpdate({
        name: name,
        data: {
          records: [
            {
              type: 'TXT',
              txt: ['foobar']
            }
          ]
        }
      });

      // register directly after reveal
      const registers = json.outputs.filter(({covenant}) => covenant.type === types.REGISTER);
      assert.equal(registers.length, 1);
    }

    // mine a block
    await mineBlocks(1, cbAddress);

    {
      const json = await wallet.createUpdate({
        name: name,
        data: {
          records: [
            {
              type: 'TXT',
              txt: ['barfoo']
            }
          ]
        }
      });

      // update after register or update
      const updates = json.outputs.filter(({covenant}) => covenant.type === types.UPDATE);
      assert.equal(updates.length, 1);
    }
  });

  it('should get name resource', async () => {
    const names = await wallet.getNames();
    // filter out names that have data
    // this test depends on the previous test
    const [ns] = names.filter(n => n.data.length > 0);
    assert(ns);

    const state = Resource.decode(Buffer.from(ns.data, 'hex'));

    const resource = await wallet.getResource(ns.name);
    assert(resource);
    const res = Resource.fromJSON(resource);

    assert.deepEqual(state, res);
  });

  it('should fail to get name resource for non existent name', async () => {
    const name = await nclient.execute('grindname', [10]);

    const resource = await wallet.getResource(name);
    assert.equal(resource, null);
  });

  it('should create a renewal', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    await wallet.createUpdate({
      name: name,
      data: {
        records: [
          {
            type: 'TXT',
            txt: ['foobar']
          }
        ]
      }
    });

    // mine up to the earliest point in which a renewal
    // can be submitted, a treeInterval into the future
    await mineBlocks(treeInterval + 1, cbAddress);

    const json = await wallet.createRenewal({
      name
    });

    const updates = json.outputs.filter(({covenant}) => covenant.type === types.RENEW);
    assert.equal(updates.length, 1);
  });

  it('should create a transfer', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    await wallet.createUpdate({
      name: name,
      data: {
        records: [
          {
            type: 'TXT',
            txt: ['foobar']
          }
        ]
      }
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    const json = await wallet.createTransfer({
      name,
      address: receiveAddress
    });

    const xfer = json.outputs.filter(({covenant}) => covenant.type === types.TRANSFER);
    assert.equal(xfer.length, 1);
  });

  it('should create a finalize', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    await wallet.createUpdate({
      name: name,
      data: {
        records: [
          {
            type: 'TXT',
            txt: ['foobar']
          }
        ]
      }
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    await wallet.createTransfer({
      name,
      address: receiveAddress
    });

    await mineBlocks(transferLockup + 1, cbAddress);

    const json = await wallet.createFinalize({
      name
    });

    const final = json.outputs.filter(({covenant}) => covenant.type === types.FINALIZE);
    assert.equal(final.length, 1);

    await mineBlocks(1, cbAddress);

    const ns = await nclient.execute('getnameinfo', [name]);
    const coin = await nclient.getCoin(ns.info.owner.hash, ns.info.owner.index);

    assert.equal(coin.address, receiveAddress);
  });

  it('should create a cancel', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    await wallet.createUpdate({
      name: name,
      data: {
        records: [
          {
            type: 'TXT',
            txt: ['foobar']
          }
        ]
      }
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    await wallet.createTransfer({
      name,
      address: receiveAddress
    });

    await mineBlocks(transferLockup + 1, cbAddress);

    const json = await wallet.createCancel({name});

    const cancel = json.outputs.filter(({covenant}) => covenant.type === types.UPDATE);
    assert.equal(cancel.length, 1);

    await mineBlocks(1, cbAddress);

    const ns = await nclient.execute('getnameinfo', [name]);
    assert.equal(ns.info.name, name);

    const coin = await wallet.getCoin(ns.info.owner.hash, ns.info.owner.index);
    assert.ok(coin);

    const keyInfo = await wallet.getKey(coin.address);
    assert.ok(keyInfo);
  });

  it('should create a revoke', async () => {
    await wallet.createOpen({
      name: name
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wallet.createReveal({
      name: name
    });

    await mineBlocks(revealPeriod + 1, cbAddress);

    await wallet.createUpdate({
      name: name,
      data: {
        records: [
          {
            type: 'TXT',
            txt: ['foobar']
          }
        ]
      }
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const json = await wallet.createRevoke({name});

    const final = json.outputs.filter(({covenant}) => covenant.type === types.REVOKE);
    assert.equal(final.length, 1);

    await mineBlocks(1, cbAddress);

    const ns = await nclient.execute('getnameinfo', [name]);
    assert.equal(ns.info.name, name);
    assert.equal(ns.info.state, 'REVOKED');
  });

  it('should create a batch open transaction (multiple outputs) for valid names', async () => {
    const NAMES_LEN = 200;
    const validNames = [];
    for (let i =0; i<NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await mineBlocks(treeInterval, cbAddress);

    const json = await wclient.createBatchOpen('primary', {
      passphrase: '',
      names: validNames,
      sign: true,
      broadcast: true});

    const transaction = json['tx'];
    const errors = json['errors'];

    await sleep(500);

    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(transaction.hash));
    assert.ok(errors.length === 0);
    assert.ok(transaction['outputs'] && transaction['outputs'].length === NAMES_LEN + 1); // NAMES_LEN OPEN + 1 NONE
  });

  it('should create a batch open transaction (multiple outputs) for partially valid names', async () => {
    const singleOpenJson = await wallet.createOpen({
      name: name,
      broadcast: true,
      sign: true
    });
    const firstNameHash = singleOpenJson['hash'];

    const batchOpenJson = await wclient.createBatchOpen('primary', {
      passphrase: '',
      names: [name, name2],
      sign: true,
      broadcast: true
    });

    const batchOpenTransaction = batchOpenJson['tx'];
    const batchOpenTransactionHash = batchOpenTransaction['hash'];
    const errors = batchOpenJson['errors'];

    await sleep(500);
    // tx should be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(firstNameHash));
    assert.ok(mempool.includes(batchOpenTransactionHash));

    assert.ok(errors.length === 1);
    assert.ok(batchOpenTransaction['outputs'] && batchOpenTransaction['outputs'].length === 2); // 1 OPEN, 1 NONE
  });

  it('should reject a batch open transaction (multiple outputs) for names already open', async () => {
    await wclient.createBatchOpen('primary', {
      passphrase: '',
      names: [name, name2],
      sign: true,
      broadcast: true
    });

    await sleep(500);

    try {
      await wclient.createBatchOpen('primary', {
        passphrase: '',
        names: [name, name2],
        sign: true,
        broadcast: true
      });
    } catch (err) {
      assert.ok(err);
    }

    // valid tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 1);
  });

  it('should reject a batch open transaction (multiple outputs) for more than 200 names', async () => {
    try {
      const tooManyNames = [...Array(201).keys()];
      await wclient.createBatchOpen('primary', {
        passphrase: '',
        names: tooManyNames,
        sign: true,
        broadcast: true
      });
    } catch (err) {
      assert.ok(err);
    }

    // valid tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 0);
  });

  it('should reject a batch open transaction (multiple outputs) for invalid names', async () => {
    const invalidNames = ['长城', '大鸟'];

    try {
      await wclient.createBatchOpen('primary', {
        passphrase: '',
        names: invalidNames,
        sign: true,
        broadcast: true
      });
    } catch (err) {
      assert.ok(err);
    }

    await sleep(500);
    // tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 0);
  });

  it('should create a batch reveal transaction (multiple outputs) for partial valid names', async function() {
    const VALID_NAMES_LEN = 2;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }
    const INVALID_NAMES_LEN = 10;
    const invalidNames = [...Array(INVALID_NAMES_LEN).keys()];

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // TODO Promise.All is failing ?
    const numberOfBids = VALID_NAMES_LEN * 2;
    for (const domainName of validNames) {
      await wallet.createBid({
        name: domainName,
        bid: 1000,
        lockup: 2000
      });
      await wallet.createBid({
        name: domainName,
        bid: 1500,
        lockup: 2000
      });
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: [...validNames, ...invalidNames]
    });

    const { processedReveals, errors } = json;
    assert.ok(errors.length === INVALID_NAMES_LEN);

    await sleep(500);

    const mempool = await nclient.getMempool();

    for (const processedReveal of processedReveals) {
      assert.ok(mempool.includes(processedReveal.tx_hash));
    }
    assert.ok(processedReveals.length === numberOfBids);
  });

  it('should create a batch reveal transaction with an output limit of 200 (+1 for NONE)', async function() {
    const BID_COUNT = 2;
    const VALID_NAMES_LEN = 105;
    const OUTPUT_LIMIT_EXCEEDING_NAMES_LEN = 5;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // TODO Promise.All is failing ?
    for (let i =0; i<BID_COUNT; i++) {
      for (const domainName of validNames) {
        await wallet.createBid({
          name: domainName,
          bid: 1000 + i,
          lockup: 2000
        });
      }
      await mineBlocks(1, cbAddress);
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames,
      sign: true,
      broadcast: true
    });

    const {processedReveals, errors} = json;

    assert.ok(errors.length === OUTPUT_LIMIT_EXCEEDING_NAMES_LEN);
    assert.ok(errors[0].name != null);

    await sleep(100);

    const mempool = await nclient.getMempool();
    for (const processedReveal of processedReveals) {
      assert.ok(mempool.includes(processedReveal.tx_hash));
    }

    const numberOfBids = (VALID_NAMES_LEN - OUTPUT_LIMIT_EXCEEDING_NAMES_LEN) * BID_COUNT;
    assert.ok(
      processedReveals.length === numberOfBids
    ); // BIDS LEN + 1 NONE
  });

  it('should not permit partially revealed domains', async function() {
    const VALID_NAMES_LEN = 5;
    const validNames = [];
    const BID_COUNT = 50;
    const MAX_REVEAL_COUNT = 200;
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await mineBlocks(1, cbAddress);
    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // using batch bids to speed up the test
    let bids = [];
    for (const domainName of validNames) {
      for (let i=1; i<=BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: domainName + '_' + i
        });

        if (i % 50 === 0) {
          await wclient.createBatchBid('primary', {
            passphrase: '',
            bids: bids
          });
          await mineBlocks(1, cbAddress);
          bids = [];
        }
      }
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames
    });

    const {processedReveals, errors} = json;

    assert.ok(errors.length === 1);
    assert.ok(processedReveals.length === MAX_REVEAL_COUNT);

    await sleep(100);

    const mempool = await nclient.getMempool();
    for (const processedReveal of processedReveals) {
      assert.ok(mempool.includes(processedReveal.tx_hash));
    }
  });

  it('should respond from cache to repeated identical requests', async function() {
    const VALID_NAMES_LEN = 2;
    const validNames = [];
    const BID_COUNT = 50;
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await mineBlocks(1, cbAddress);
    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // using batch bids to speed up the test
    let bids = [];
    for (const domainName of validNames) {
      for (let i=1; i<=BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: domainName + '_' + i
        });

        if (i % 50 === 0) {
          await wclient.createBatchBid('primary', {
            passphrase: '',
            bids: bids
          });
          await mineBlocks(1, cbAddress);
          bids = [];
        }
      }
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames
    });

    await mineBlocks(1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames
    });

    const {processedReveals, errors} = json;

    assert.ok(errors.length === 0);
    assert.ok(processedReveals.length === BID_COUNT * VALID_NAMES_LEN);

    for (const processedReveal of processedReveals) {
      assert.ok(processedReveal.from_cache);
    }
  });

  it('should reject a batch reveal transaction (multiple outputs) for invalid names', async function() {
    const invalidNames = ['长城', '大鸟'];
    try {
      await wclient.post('/wallet/primary/batch/revealwithcache', {
        passphrase: '',
        names: invalidNames
      });
    } catch (err) {
      assert.ok(err);
    }
    await sleep(500);
    // tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 0);
  });

  it('should return from cache when same idempotency_key is used in a bid request', async function() {
    await mineBlocks(5, cbAddress);

    const BID_COUNT = 2;
    const VALID_NAMES_LEN = 100;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [6]));
    }

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    let counter = 0;
    for (const domainName of validNames) {
      for (let i =0; i<BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: String(counter++)
        });
      }
    }

    const UNIQUE_BID_COUNT = 2;
    const TOTAL_BID_COUNT = VALID_NAMES_LEN * BID_COUNT;

    const uniqueBids = bids.splice(TOTAL_BID_COUNT - UNIQUE_BID_COUNT, UNIQUE_BID_COUNT);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: bids
    });

    for (let i=0; i<UNIQUE_BID_COUNT; i++) {
      bids.push(uniqueBids[i]);
    }

    // Duplicate request with UNIQUE_BID_COUNT unique bids at the end
    const {processedBids, errorMessages} = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: bids
    });

    assert.ok(processedBids);
    assert.equal(errorMessages.length, 0);
    assert.equal(bids.length, TOTAL_BID_COUNT);

    const allFromCache = processedBids.every(element => element.fromCache === true);
    assert.equal(allFromCache, false);

    await sleep(100);

    const mempool = await nclient.getMempool();
    //
    const uniqueTxs = new Set();
    processedBids.forEach(bid => uniqueTxs.add(bid.tx_hash));
    // should have 2 unique transactions within
    assert.equal(uniqueTxs.size, 2);
    assert.equal(mempool.length, uniqueTxs.size);
    for (const txHash of uniqueTxs.values()) {
      assert.ok(mempool.includes(txHash));
    }
  });

  it('should create a batch bid transaction (multiple outputs) for valid names', async function() {
    const BID_COUNT = 2;
    const VALID_NAMES_LEN = 100;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [6]));
    }

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    let counter = 0;
    for (const domainName of validNames) {
      for (let i =0; i<BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: 'key_' + counter++
        });
      }
    }

    const {processedBids, errorMessages} = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: bids
    });

    assert.ok(processedBids);
    assert.equal(errorMessages.length, 0);
    const expectedOutputCount = BID_COUNT * VALID_NAMES_LEN;
    assert.equal(bids.length, expectedOutputCount);

    await sleep(100);

    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(processedBids[0].tx_hash));
  });

  it('should reject a batch bid transaction that exceeds the total number of bid limit of 200 or not permitted 0 bid', async function() {
    const BID_COUNT = 4;
    const VALID_NAMES_LEN = 100;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [6]));
    }

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    let counter = 0;
    for (const domainName of validNames) {
      for (let i =0; i<BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: String(counter++)
        });
      }
    }

    assert.rejects(async () => {
      await wclient.createBatchBid('primary', {
        passphrase: '',
        bids: bids
      });
    });

    assert.rejects(async () => {
      await wclient.createBatchBid('primary', {
        passphrase: '',
        bids: []
      });
    });
  });

  it('should reject malformed/invalid finish requests', async function() {
    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: ['invalid_finish_data']
    }), /map must be a object./);

    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name: 'domain_name'}]
    }), /name and data must be present in every element./);

    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name: 'domain_name', data: 'invalid data'}]
    }), /data must be a object./);

    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name: 'domain_name', data: {}}]
    }), /Invalid records/);
  });

  it('should redeem lost bid and register won bids', async function() {
    const name1 = await nclient.execute('grindname', [6]);
    const name2 = await nclient.execute('grindname', [6]);
    const data = { records: [] };

    await wclient.createBatchOpen('primary', {
      names: [name1, name2],
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // wallet1(primary) wins name1, wallet2(secondary) wins name2
    const wallet1Name1WinningBidValue = 1000001;
    const wallet1Name1WinningBid = createBid(name1, wallet1Name1WinningBidValue, 'wallet-1-bid-1');

    const wallet1Name2LosingBidValue = 1000000;
    const wallet1Name2LosingBid = createBid(name2, wallet1Name2LosingBidValue, 'wallet-1-bid-2');

    const wallet2Name1LosingBidValue = 1000000;
    const wallet2Name1LosingBid = createBid(name1, wallet2Name1LosingBidValue, 'wallet-2-bid-1');

    const wallet2Name2WinningBidValue = 1000001;
    const wallet2Name2WinningBid = createBid(name2, wallet2Name2WinningBidValue, 'wallet-2-bid-2');

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: [wallet1Name1WinningBid, wallet1Name2LosingBid]
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchBid('secondary', {
      passphrase: '',
      bids: [wallet2Name1LosingBid, wallet2Name2WinningBid]
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name1, name2],
      sign: true,
      broadcast: true
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchReveal('secondary', {
      passphrase: '',
      names: [name1, name2],
      sign: true,
      broadcast: true
    });

    await mineBlocks(2*treeInterval + 1, cbAddress);

    const wallet2Finish = await wclient.createBatchFinish('secondary', {
      passphrase: '',
      finishRequests: [{name: name1, data}, {name: name2, data}]
    });

    assert.deepStrictEqual(wallet2Finish.errorMessages, []);
    assert.equal(wallet2Finish.processedFinishes.length, 2); // one redeem one finish

    const wallet2RedeemOutput = getOutputsOfType(wallet2Finish.processedFinishes, 'REDEEM')[0];
    const wallet2RegisterOutput = getOutputsOfType(wallet2Finish.processedFinishes, 'REGISTER')[0];

    assert.equal(wallet2RedeemOutput.value, wallet2Name1LosingBidValue);
    assert.equal(wallet2RegisterOutput.value, wallet1Name2LosingBidValue); // wickrey auction

    const wallet1Finish = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name: name1, data}, {name: name2, data}]
    });

    const wallet1RedeemOutput = getOutputsOfType(wallet1Finish.processedFinishes, 'REDEEM')[0];
    const wallet1RegisterOutput = getOutputsOfType(wallet1Finish.processedFinishes, 'REGISTER')[0];

    assert.equal(wallet1RedeemOutput.value, wallet1Name2LosingBidValue);
    assert.equal(wallet1RegisterOutput.value, wallet2Name1LosingBidValue); // wickrey auction

    assert.deepStrictEqual(wallet1Finish.errorMessages, []);
    assert.equal(wallet1Finish.processedFinishes.length, 2);

    await sleep(100);

    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(wallet2Finish.processedFinishes[0].tx_hash));
    assert.ok(mempool.includes(wallet1Finish.processedFinishes[0].tx_hash));
  });

  it('should partially process names when total finish count exceeds 200', async function() {
    const BATCH_FINISH_LIMIT = 200;
    const NAME_BID_COUNT = 100;
    const {name: name1, bids: name1Bids} = await createNameWithBids(NAME_BID_COUNT);
    const {name: name2, bids: name2Bids} = await createNameWithBids(NAME_BID_COUNT);
    const {name: name3, bids: name3Bids} = await createNameWithBids(NAME_BID_COUNT);
    const data = { records: [] };

    await wclient.createBatchOpen('primary', {
      names: [name1, name2, name3],
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: [...name1Bids, ...name2Bids]
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: name3Bids
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // we need to reveal 2 time since total amount exceeds 200 limit
    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name1, name2],
      sign: true,
      broadcast: true
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name3],
      sign: true,
      broadcast: true
    });

    await mineBlocks(2*treeInterval + 1, cbAddress);

    let processedFinishes, errorMessages;

    const batchFinishResponsePart1 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name: name1, data},{name: name2, data},{name: name3, data}]
    });

    processedFinishes = batchFinishResponsePart1.processedFinishes;
    errorMessages = batchFinishResponsePart1.errorMessages;

    assert.equal(processedFinishes.length, BATCH_FINISH_LIMIT);
    // 1 name is expected to fail
    assert.equal(errorMessages.length, 1);

    await sleep(100);

    let mempool = await nclient.getMempool();
    assert(mempool.length, 1);

    await mineBlocks(1, cbAddress);

    const batchFinishResponsePart2 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name: name1, data},{name: name2, data},{name: name3, data}]
    });

    processedFinishes = batchFinishResponsePart2.processedFinishes;
    errorMessages = batchFinishResponsePart2.errorMessages;

    await sleep(100);

    mempool = await nclient.getMempool();
    assert(mempool.length, 1);

    assert.equal(processedFinishes.length, 3 * NAME_BID_COUNT);
    assert.equal(errorMessages.length, 0);
  });

  it('should respond from cache when same names are used for batchFinish', async function() {
    const NAME_BID_COUNT = 100;
    const data = {records: []};

    const {name, bids} = await createNameWithBids(NAME_BID_COUNT);

    await wclient.createBatchOpen('primary', {
      names: [name],
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: bids
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name],
      sign: true,
      broadcast: true
    });

    await mineBlocks(2*treeInterval + 1, cbAddress);

    const batchFinishResponse1 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name, data}]
    });

    assert.equal(batchFinishResponse1.errorMessages.length, 0);
    assert.equal(batchFinishResponse1.processedFinishes.length, NAME_BID_COUNT);

    for (const processedFinish of batchFinishResponse1.processedFinishes) {
      assert.equal(processedFinish.from_cache, false);
    }

    await sleep(100);

    let mempool = await nclient.getMempool();
    assert(mempool.length, 1);

    await mineBlocks(1, cbAddress);

    const batchFinishResponse2 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{name, data}]
    });

    assert.equal(batchFinishResponse2.errorMessages.length, 0);
    assert.equal(batchFinishResponse2.processedFinishes.length, NAME_BID_COUNT);

    await sleep(100);

    mempool = await nclient.getMempool();
    assert.equal(mempool.length, 0);

    for (const processedFinish of batchFinishResponse2.processedFinishes) {
      assert.equal(processedFinish.from_cache, true);
    }
  });
});

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

// take into account race conditions
async function mineBlocks(count, address) {
  for (let i = 0; i < count; i++) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await common.forValue(obj, 'complete', true);
  }
}

// create an OPEN output
function openOutput(name, address) {
  const nameHash = rules.hashName(name);
  const rawName = Buffer.from(name, 'ascii');

  const output = new Output();
  output.address = Address.fromString(address);
  output.value = 0;
  output.covenant.type = types.OPEN;
  output.covenant.pushHash(nameHash);
  output.covenant.pushU32(0);
  output.covenant.push(rawName);

  return output;
}

// create bid
function createBid(name, bid, idempotencyKey) {
  return {
      name: name,
      bid: bid,
      lockup: bid + 1000000,
      idempotencyKey: idempotencyKey
  };
}

// create name with arbitrary number of bids
async function createNameWithBids(bidCount) {
  const name = await nclient.execute('grindname', [6]);
  const bids = [];
  const BaseBid = 10000000;

  for (let i=0; i<bidCount; i++) {
    const idempotencyKey = name + i;
    bids.push(createBid(name, BaseBid + i, idempotencyKey));
  }

  return {name, bids};
}

// filter and return outputs of type
function getOutputsOfType(processedFinishes, type) {
  return processedFinishes
    .filter((element) => {
      return element.output.covenant.action === type;
    }).map((element) => {
      return element.output;
    });
}
