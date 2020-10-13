/*!
 * test/wallet-http-test.js - test for wallet http endoints
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const {NodeClient, WalletClient} = require('hs-client');
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

let name, cbAddress;
const accountTwo = 'foobar';

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

describe('Wallet HTTP', function() {
  this.timeout(20000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    await wclient.createWallet('secondary');
    cbAddress = (await wallet.createAddress('default')).address;
    await wallet.createAccount(accountTwo);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

  beforeEach(async () => {
    name = await nclient.execute('grindname', [5]);
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
    const json = await wallet.createOpen({
      name: name
    });

    let entered = false;
    node.mempool.on('tx', () => entered = true);

    // wait for tx event on mempool
    await common.event(node.mempool, 'tx');

    assert.equal(entered, true);
    const mempool = await nclient.getMempool();

    assert.ok(mempool.includes(json.hash));

    const opens = json.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);
  });

  it('should create an open and not broadcast the transaction', async () => {
    const json = await wallet.createOpen({
      name: name,
      broadcast: false
    });

    let entered = false;
    node.mempool.on('tx', () => {
      entered = true;
      assert.ok(false);
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
  });

  it('should create an open and not sign the transaction', async () => {
    const json = await wallet.createOpen({
      name: name,
      broadcast: false,
      sign: false
    });

    let entered = false;
    node.mempool.on('tx', () => {
      entered = true;
      assert.ok(false);
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

    await assert.rejects(fn, {message: 'No reveals to redeem.'});

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
