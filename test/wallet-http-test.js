'use strict';

const Network = require('../lib/protocol/network');
const MTX = require('../lib/primitives/mtx');
const {isSignatureEncoding, isKeyEncoding} = require('../lib/script/common');
const {Resource} = require('../lib/dns/resource');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const HD = require('../lib/hd/hd');
const Mnemonic = require('../lib/hd/mnemonic');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const secp256k1 = require('bcrypto/lib/secp256k1');
const network = Network.get('regtest');
const assert = require('bsert');
const {BufferSet} = require('buffer-map');
const common = require('./util/common');
const Outpoint = require('../lib/primitives/outpoint');
const consensus = require('../lib/protocol/consensus');
const NodeContext = require('./util/node-context');
const {forEvent, sleep} = require('./util/common');
const {generateInitialBlocks} = require('./util/pagination');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

describe('Wallet HTTP', function() {
  this.timeout(20000);

  /** @type {NodeContext} */
  let nodeCtx;
  let wclient, nclient;

  // primary wallet client.
  let wallet, cbAddress;

  const beforeAll = async () => {
    nodeCtx = new NodeContext({
      apiKey: 'foo',
      network: 'regtest',
      walletAuth: true,
      wallet: true
    });

    await nodeCtx.open();

    wclient = nodeCtx.wclient;
    nclient = nodeCtx.nclient;

    wallet = nodeCtx.wclient.wallet('primary');
    cbAddress = (await wallet.createAddress('default')).address;
  };

  const afterAll = async () => {
    await nodeCtx.close();
  };

  describe('Create wallet', function() {
    before(beforeAll);
    after(afterAll);

    it('should create wallet', async () => {
      const info = await wclient.createWallet('test');
      assert.strictEqual(info.id, 'test');
      const wallet = wclient.wallet('test', info.token);
      await wallet.open();
    });

    it('should create wallet with spanish mnemonic', async () => {
      await wclient.createWallet(
        'cartera1',
        {language: 'spanish'}
      );
      const master = await wclient.getMaster('cartera1');
      const phrase = master.mnemonic.phrase;
      for (const word of phrase.split(' ')) {
        const language = Mnemonic.getLanguage(word);
        assert.strictEqual(language, 'spanish');
        // Comprobar la cordura:
        assert.notStrictEqual(language, 'english');
      }

      // Verificar
      await wclient.createWallet(
        'cartera2',
        {mnemonic: phrase}
      );
      assert.deepStrictEqual(
        await wclient.getAccount('cartera1', 'default'),
        await wclient.getAccount('cartera2', 'default')
      );
    });
  });

  describe('Lookahead', function() {
    before(beforeAll);
    after(afterAll);

    it('should create wallet with default account 1000 lookahead', async () => {
      const wname = 'lookahead';
      await wclient.createWallet(wname, {
        lookahead: 1000
      });

      const defAccount = await wclient.getAccount(wname, 'default');
      assert.strictEqual(defAccount.lookahead, 1000);

      const newAccount = await wclient.createAccount(wname, 'newaccount', {
        lookahead: 1001
      });
      assert.strictEqual(newAccount.lookahead, 1001);
      const getNewAccount = await wclient.getAccount(wname, 'newaccount', {
        lookahead: 1001
      });

      assert.strictEqual(getNewAccount.lookahead, 1001);
    });

    it('should modify account lookahead to 1000', async () => {
      const wname = 'lookahead2';
      await wclient.createWallet(wname);

      const defAccount = await wclient.getAccount(wname, 'default');
      assert.strictEqual(defAccount.lookahead, 200);

      const modified = await wclient.modifyAccount(wname, 'default', {
        lookahead: 1000
      });
      assert.strictEqual(modified.lookahead, 1000);
    });
  });

  describe('Wallet info', function() {
    let wallet;

    before(async () => {
      await beforeAll();

      await wclient.createWallet('test');
      wallet = wclient.wallet('test');
    });
    after(afterAll);

    it('should get wallet info', async () => {
      const info = await wallet.getInfo();
      assert.strictEqual(info.id, 'test');
      const acct = await wallet.getAccount('default');
      const str = acct.receiveAddress;
      assert(typeof str === 'string');
    });
  });

  describe('Key/Address', function() {
    before(beforeAll);
    after(afterAll);

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
  });

  describe('Mine/Fund', function() {
    before(beforeAll);
    after(afterAll);

    it('should mine to the primary/default wallet', async () => {
      const height = 20;

      await nodeCtx.mineBlocks(height, cbAddress);

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
  });

  describe('Events', function() {
    before(beforeAll);
    after(afterAll);

    it('balance address and tx events', async () => {
      await wclient.createWallet('test');
      const testWallet = wclient.wallet('test');
      await testWallet.open();
      const {address} = await testWallet.createAddress('default');

      const mtx = new MTX();
      mtx.addOutpoint(new Outpoint(consensus.ZERO_HASH, 0));
      mtx.addOutput(address, 50460);
      mtx.addOutput(address, 50460);
      mtx.addOutput(address, 50460);
      mtx.addOutput(address, 50460);

      const tx = mtx.toTX();

      let balance = null;
      testWallet.once('balance', (b) => {
        balance = b;
      });

      let receive = null;
      testWallet.once('address', (r) => {
        receive = r[0];
      });

      let details = null;
      testWallet.once('tx', (d) => {
        details = d;
      });

      await nodeCtx.wdb.addTX(tx);
      await new Promise(r => setTimeout(r, 300));

      assert(receive);
      assert.strictEqual(receive.name, 'default');
      assert.strictEqual(receive.branch, 0);
      assert(balance);
      assert.strictEqual(balance.confirmed, 0);
      assert.strictEqual(balance.unconfirmed, 201840);
      assert(details);
      assert.strictEqual(details.hash, tx.txid());
    });
  });

  describe('Create/Send transaction', function() {
    let wallet2;

    before(async () => {
      await beforeAll();
      await nodeCtx.mineBlocks(20, cbAddress);
      await wclient.createWallet('secondary');
      wallet2 = wclient.wallet('secondary');
    });

    after(afterAll);

    it('should create a transaction', async () => {
      const tx = await wallet.createTX({
        outputs: [{ address: cbAddress, value: 1e4 }]
      });

      assert.ok(tx);
      assert.equal(tx.outputs.length, 1 + 1); // send + change
      assert.equal(tx.locktime, 0);
    });

    it('should create self-send transaction with HD paths', async () => {
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

      // cbAddress is a self-send
      // so all output paths including change should be known
      for (let i = 0; i < tx.outputs.length; i++) {
        const path = tx.outputs[i].path;

        assert.ok(typeof path.name === 'string');
        assert.ok(typeof path.account === 'number');
        assert.ok(typeof path.change === 'boolean');
        assert.ok(typeof path.derivation === 'string');
      }
    });

    it('should create a transaction with HD paths', async () => {
      const tx = await wallet.createTX({
        paths: true,
        outputs: [{
          address: 'rs1qlf5se77y0xlg5940slyf00djvveskcsvj9sdrd',
          value: 1e4
        }]
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
      {
        const path = tx.outputs[1].path; // change
        assert.ok(typeof path.name === 'string');
        assert.ok(typeof path.account === 'number');
        assert.ok(typeof path.change === 'boolean');
        assert.ok(typeof path.derivation === 'string');
      }
      {
        const path = tx.outputs[0].path; // receiver
        assert(!path);
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
      await nodeCtx.mineBlocks(height, address);

      const accountInfo = await wallet2.getAccount('default');
      assert.equal(accountInfo.balance.coin, height);
    });
  });

  describe('Get balance', function() {
    before(async () => {
      await beforeAll();
      await nodeCtx.mineBlocks(20, cbAddress);
    });

    after(afterAll);

    it('should get balance', async () => {
      const balance = await wallet.getBalance();
      assert.equal(balance.tx, 20);
      assert.equal(balance.coin, 20);
    });
  });

  describe('Get TX', function() {
    let hash;

    before(async () => {
      await beforeAll();

      await nodeCtx.mineBlocks(10, cbAddress);
      const {address} = await wallet.createAddress('default');
      const tx = await wallet.send({outputs: [{address, value: 1e4}]});

      hash = tx.hash;
    });

    after(afterAll);

    it('should fail to get TX that does not exist', async () => {
      const hash = consensus.ZERO_HASH;
      const tx = await wallet.getTX(hash.toString('hex'));
      assert.strictEqual(tx, null);
    });

    it('should get TX', async () => {
      const tx = await wallet.getTX(hash.toString('hex'));
      assert(tx);
      assert.strictEqual(tx.hash, hash);
    });
  });

  describe('Zap TXs', function() {
    const TEST_WALLET = 'test';
    const DEFAULT = 'default';
    const ALT = 'alt';

    let testWallet;

    const resetPending = async () => {
      await wallet.zap(null, 0);
      nodeCtx.mempool.reset();
    };

    before(async () => {
      await beforeAll();

      await wclient.createWallet(TEST_WALLET);
      testWallet = wclient.wallet(TEST_WALLET);

      await testWallet.createAccount(ALT);

      await nodeCtx.mineBlocks(10, cbAddress);
    });

    afterEach(resetPending);

    after(afterAll);

    it('should zap all txs (wallet)', async () => {
      for (const account of [DEFAULT, ALT]) {
        const {address} = await testWallet.createAddress(account);

        for (let i = 0; i < 3; i++)
          await wallet.send({outputs: [{address, value: 1e4}]});
      }

      const result = await testWallet.zap(null, 0);
      assert.strictEqual(result.zapped, 6);
    });

    it('should zap all txs (account)', async () => {
      for (const account of [DEFAULT, ALT]) {
        const {address} = await testWallet.createAddress(account);

        for (let i = 0; i < 3; i++)
          await wallet.send({outputs: [{address, value: 1e4}]});
      }

      const resultDefault = await testWallet.zap(DEFAULT, 0);
      assert.strictEqual(resultDefault.zapped, 3);

      const resultAlt = await testWallet.zap(ALT, 0);
      assert.strictEqual(resultAlt.zapped, 3);
    });
  });

  describe('Create account (Integration)', function() {
    before(beforeAll);
    after(afterAll);

    it('should create an account', async () => {
      const info = await wallet.createAccount('foo');
      assert(info);
      assert(info.initialized);
      assert.strictEqual(info.name, 'foo');
      assert.strictEqual(info.accountIndex, 1);
      assert.strictEqual(info.m, 1);
      assert.strictEqual(info.n, 1);
    });

    it('should create account', async () => {
      const info = await wallet.createAccount('foo1');
      assert(info);
      assert(info.initialized);
      assert.strictEqual(info.name, 'foo1');
      assert.strictEqual(info.accountIndex, 2);
      assert.strictEqual(info.m, 1);
      assert.strictEqual(info.n, 1);
    });

    it('should create account', async () => {
      const info = await wallet.createAccount('foo2', {
        type: 'multisig',
        m: 1,
        n: 2
      });
      assert(info);
      assert(!info.initialized);
      assert.strictEqual(info.name, 'foo2');
      assert.strictEqual(info.accountIndex, 3);
      assert.strictEqual(info.m, 1);
      assert.strictEqual(info.n, 2);
    });
  });

  describe('Wallet auction (Integration)', function() {
    const accountTwo = 'foobar';

    let name, wallet2;

    const ownedNames = [];
    const allNames = [];

    before(async () => {
      await beforeAll();

      await nodeCtx.mineBlocks(20, cbAddress);
      await wallet.createAccount(accountTwo);

      await wclient.createWallet('secondary');
      wallet2 = wclient.wallet('secondary');
      const saddr = (await wallet2.createAddress('default')).address;
      await nodeCtx.mineBlocks(5, saddr);
    });

    after(afterAll);

    beforeEach(async () => {
      name = await nclient.execute('grindname', [5]);
    });

    afterEach(async () => {
      await nodeCtx.mempool.reset();
    });

    it('should have no name state indexed initially', async () => {
      const names = await wallet.getNames();
      assert.strictEqual(names.length, 0);
    });

    it('should allow covenants with create tx', async () => {
      const {address} = await wallet.createChange('default');

      const output = openOutput(name, address, network);

      const tx = await wallet.createTX({
        outputs: [output.getJSON(network)]
      });
      assert.equal(tx.outputs[0].covenant.type, types.OPEN);
    });

    it('should allow covenants with send tx', async () => {
      const {address} = await wallet.createChange('default');

      const output = openOutput(name, address, network);

      const tx = await wallet.send({
        outputs: [output.getJSON(network)]
      });

      assert.equal(tx.outputs[0].covenant.type, types.OPEN);
    });

    it('should create an open and broadcast the tx', async () => {
      let emitted = 0;
      const handler = () => emitted++;
      nodeCtx.mempool.on('tx', handler);

      const mempoolTXEvent = common.forEvent(nodeCtx.mempool, 'tx');
      const json = await wallet.createOpen({
        name: name
      });
      await mempoolTXEvent;

      const mempool = await nodeCtx.nclient.getMempool();

      assert.ok(mempool.includes(json.hash));

      const opens = json.outputs.filter(output => output.covenant.type === types.OPEN);
      assert.equal(opens.length, 1);

      assert.equal(emitted, 1);

      // reset for next test
      nodeCtx.mempool.removeListener('tx', handler);
    });

    it('should create an open and not broadcast the transaction', async () => {
      let entered = false;
      const handler = () => entered = true;
      nodeCtx.mempool.on('tx', handler);

      const json = await wallet.createOpen({
        name: name,
        broadcast: false
      });

      await sleep(200);

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
      nodeCtx.mempool.removeListener('tx', handler);
    });

    it('should create an open and not sign the transaction', async () => {
      let entered = false;
      const handler = () => entered = true;
      nodeCtx.mempool.on('tx', handler);

      const json = await wallet.createOpen({
        name: name,
        broadcast: false,
        sign: false
      });

      await sleep(200);

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
      nodeCtx.mempool.removeListener('tx', handler);
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

      await nodeCtx.mineBlocks(height, receiveAddress);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      const primary = nodeCtx.wdb.primary;
      const nonces = await primary.generateNonces(nameHash, address, bid);
      const blinds = nonces.map(nonce => rules.blind(bid, nonce));

      assert.deepStrictEqual(response, {
        address: address.toString(network.type),
        blinds: blinds.map(blind => blind.toString('hex')),
        nonces: nonces.map(nonce => nonce.toString('hex')),
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

      const primary = nodeCtx.wdb.primary;
      const nonces = await primary.generateNonces(nameHash, address, bid);
      const blinds = nonces.map(nonce => rules.blind(bid, nonce));

      assert.deepStrictEqual(response, {
        address: address.toString(network.type),
        blinds: blinds.map(blind => blind.toString('hex')),
        nonces: nonces.map(nonce => nonce.toString('hex')),
        bid: bid,
        name: name,
        nameHash: nameHash.toString('hex')
      });
    });

    it('should get name info', async () => {
      const names = await wallet.getNames();

      assert.strictEqual(allNames.length, names.length);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      await nodeCtx.mineBlocks(1, cbAddress);

      // this method gets all bids for all names
      const bids = await wallet.getBids();

      // this depends on this it block creating
      // the first bids of this test suite
      assert.equal(bids.length, 3);
      assert.ok(bids.every(bid => bid.name === name));
      assert.ok(bids.every(bid => bid.height === nodeCtx.height));

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      await nodeCtx.mineBlocks(1, cbAddress);

      {
        await sleep(100);
        // fetch all bids for the name
        const bids = await wallet.getBidsByName(name);
        assert.equal(bids.length, 2);

        assert.ok(bids.every(bid => bid.height === nodeCtx.height));

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
        assert.strictEqual(bid.height, nodeCtx.height);
      }
    });

    it('should create a reveal', async () => {
      await wallet.createOpen({
        name: name
      });

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      for (let i = 0; i < 3; i++) {
        await wallet.createBid({
          name: name,
          bid: 1000,
          lockup: 2000
        });
      }

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      const {info} = await nclient.execute('getnameinfo', [name]);
      assert.equal(info.name, name);
      assert.equal(info.state, 'REVEAL');

      const json = await wallet.createReveal();

      const reveals = json.outputs.filter(output => output.covenant.type === types.REVEAL);
      assert.equal(reveals.length, 3);

      ownedNames.push(name);

      await nodeCtx.mineBlocks(1, cbAddress);

      const allReveals = await wallet.getReveals();
      assert.strictEqual(allReveals.length, 3);
      assert.ok(allReveals.every(reveal => reveal.name === name));
      assert.ok(allReveals.every(reveal => reveal.height === nodeCtx.height));

      const revealsByName = await wallet.getRevealsByName(name);
      assert.strictEqual(revealsByName.length, 3);
      assert.ok(revealsByName.every(reveal => reveal.name === name));
      assert.ok(revealsByName.every(reveal => reveal.height === nodeCtx.height));
    });

    it('should get all reveals (single player)', async () => {
      await wallet.createOpen({
        name: name
      });

      const name2 = await nclient.execute('grindname', [5]);

      await wallet.createOpen({
        name: name2
      });

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);
      allNames.push(name2);

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

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await wallet.createReveal({
        name: name2
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);
      ownedNames.push(name2);

      {
        const reveals = await wallet.getReveals();
        assert.equal(reveals.length, 5);
      }

      {
        // a single reveal per name
        const reveals = await wallet.getRevealsByName(name);
        const [reveal] = reveals;
        assert.strictEqual(reveal.height + revealPeriod, nodeCtx.height);
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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      const r1 = await wallet.createReveal({
        name: name
      });

      const r2 = await wallet2.createReveal({
        name: name
      });

      state.reveals.push(r1);
      state.reveals.push(r2);

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // wallet did not win this auction so name is not pushed to ownedNames[]

      {
        const reveals = await wallet.getRevealsByName(name, {own: true});
        assert.strictEqual(reveals.length, 1);
        const [reveal] = reveals;
        assert.strictEqual(reveal.bidPrevout.hash, state.bids[0].hash);
        assert.strictEqual(reveal.bidPrevout.index, 0);
        assert.strictEqual(reveal.own, true);
        assert.strictEqual(reveal.prevout.hash, r1.hash);
      }

      {
        const reveals = await wallet.getRevealsByName(name);
        assert.strictEqual(reveals.length, 2);

        const r1 = reveals.find(reveal =>
          reveal.prevout.hash === state.reveals[0].hash);
        const r2 = reveals.find(reveal =>
          reveal.prevout.hash === state.reveals[1].hash);

        assert.ok(r1);
        assert.ok(r2);

        assert.strictEqual(r1.bidPrevout.hash, state.bids[0].hash);
        assert.strictEqual(r1.bidPrevout.index, 0);

        assert.strictEqual(r2.bidPrevout.hash, state.bids[1].hash);
        assert.strictEqual(r2.bidPrevout.index, 0);
      }

      const dump = await nodeCtx.wdb.dump();
      const dumpSlice = {};

      Object.keys(dump).filter((key) => {
        const wid1 = '7400000001';
        // txdblayout.t
        if (key.startsWith(wid1 + '74'))
          dumpSlice[key] = dump[key];

        // txdblayout.i
        if (key.startsWith(wid1 + '69'))
          dumpSlice[key] = dump[key];

        // txdblayout.B
        if (key.startsWith(wid1 + '42'))
          dumpSlice[key] = dump[key];
      });
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

      await nodeCtx.mineBlocks(treeInterval + 2, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      const balanceBeforeBid = await wallet.getBalance();
      assert.equal(balanceBeforeBid.lockedConfirmed - lockConfirmedBeforeTest, 0);
      assert.equal(
        balanceBeforeBid.lockedUnconfirmed - lockUnconfirmedBeforeTest,
        0
      );

      const bidValue = 1000000;
      const lockupValue = 5000000;

      const auctionTXs = await wallet.client.post(
        `/wallet/${wallet.id}/auction`,
        {
          name: name,
          bid: 1000000,
          lockup: 5000000,
          broadcastBid: true
        }
      );

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      let walletAuction = await wallet.getAuctionByName(name);
      const bidFromWallet = walletAuction.bids.find(
        b => b.prevout.hash === auctionTXs.bid.hash
      );
      assert(bidFromWallet);

      const { info } = await nclient.execute('getnameinfo', [name]);
      assert.equal(info.name, name);
      assert.equal(info.state, 'REVEAL');

      const b5 = await wallet.getBalance();
      assert.equal(b5.lockedConfirmed - lockConfirmedBeforeTest, lockupValue);
      assert.equal(b5.lockedUnconfirmed - lockUnconfirmedBeforeTest, lockupValue);

      await nclient.broadcast(auctionTXs.reveal.hex);
      await nodeCtx.mineBlocks(1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

      walletAuction = await wallet.getAuctionByName(name);
      const revealFromWallet = walletAuction.reveals.find(
        b => b.prevout.hash === auctionTXs.reveal.hash
      );
      assert(revealFromWallet);

      const b6 = await wallet.getBalance();
      assert.equal(b6.lockedConfirmed - lockConfirmedBeforeTest, bidValue);
      assert.equal(b6.lockedUnconfirmed - lockUnconfirmedBeforeTest, bidValue);

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      const ns = await nclient.execute('getnameinfo', [name]);
      const coin = await wallet.getCoin(ns.info.owner.hash, ns.info.owner.index);
      assert.ok(coin);
    });

    it('should create a redeem', async () => {
      await wallet.createOpen({
        name: name
      });

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

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

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await wallet2.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // wallet did not win this auction so name is not pushed to ownedNames[]

      // wallet2 is the winner, therefore cannot redeem
      const fn = async () => (await wallet2.createRedeem({
        name: name
      }));

      await assert.rejects(
        fn,
        {message: `No reveals to redeem for name: ${name}.`}
      );

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

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
      await nodeCtx.mineBlocks(1, cbAddress);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

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
      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      const {receiveAddress} = await wallet2.getAccount('default');

      await wallet.createTransfer({
        name,
        address: receiveAddress
      });

      await nodeCtx.mineBlocks(transferLockup + 1, cbAddress);

      const json = await wallet.createFinalize({
        name
      });

      const final = json.outputs.filter(({covenant}) => covenant.type === types.FINALIZE);
      assert.equal(final.length, 1);

      await nodeCtx.mineBlocks(1, cbAddress);

      // Confirmed FINALIZE means this wallet is not the owner anymore!
      ownedNames.splice(ownedNames.indexOf(name), 1);

      const ns = await nclient.execute('getnameinfo', [name]);
      const coin = await nclient.getCoin(ns.info.owner.hash, ns.info.owner.index);

      assert.equal(coin.address, receiveAddress);
    });

    it('should create a cancel', async () => {
      await wallet.createOpen({
        name: name
      });

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      const {receiveAddress} = await wallet.getAccount(accountTwo);

      await wallet.createTransfer({
        name,
        address: receiveAddress
      });

      await nodeCtx.mineBlocks(transferLockup + 1, cbAddress);

      const json = await wallet.createCancel({name});

      const cancel = json.outputs.filter(({covenant}) => covenant.type === types.UPDATE);
      assert.equal(cancel.length, 1);

      await nodeCtx.mineBlocks(1, cbAddress);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Confirmed OPEN adds name to wallet's namemap
      allNames.push(name);

      await wallet.createBid({
        name: name,
        bid: 1000,
        lockup: 2000
      });

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      await wallet.createReveal({
        name: name
      });

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Confirmed REVEAL with highest bid makes wallet the owner
      ownedNames.push(name);

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

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      const json = await wallet.createRevoke({name});

      const final = json.outputs.filter(({covenant}) => covenant.type === types.REVOKE);
      assert.equal(final.length, 1);

      await nodeCtx.mineBlocks(1, cbAddress);

      // Confirmed REVOKE means no one owns this name anymore
      ownedNames.splice(ownedNames.indexOf(name), 1);

      const ns = await nclient.execute('getnameinfo', [name]);
      assert.equal(ns.info.name, name);
      assert.equal(ns.info.state, 'REVOKED');
    });

    it('should require passphrase for auction TXs', async () => {
      const passphrase = 'BitDNS!5353';
      await wclient.createWallet('lockedWallet', {passphrase});
      const lockedWallet = await wclient.wallet('lockedWallet');

      // Fast-forward through the default 60-second unlock timeout
      async function lock() {
        const wallet = await nodeCtx.wdb.get('lockedWallet');
        return wallet.lock();
      }
      await lock();

      // Wallet is created and encrypted
      const info = await lockedWallet.getInfo();
      assert(info);
      assert(info.master.encrypted);

      // Fund
      const addr = await lockedWallet.createAddress('default');
      await nodeCtx.mineBlocks(10, addr.address);
      await common.forValue(nodeCtx.wdb, 'height', nodeCtx.chain.height);
      const bal = await lockedWallet.getBalance();
      assert(bal.confirmed > 0);

      // Open
      await assert.rejects(
        lockedWallet.createOpen({name}),
        {message: 'No passphrase.'}
      );

      await lockedWallet.createOpen({name, passphrase});
      await lock();

      await nodeCtx.mineBlocks(treeInterval + 1, cbAddress);

      // Bid
      await assert.rejects(
        lockedWallet.createBid({name, lockup: 1, bid: 1}),
        {message: 'No passphrase.'}
      );

      // Send multiple bids, wallet remains unlocked for 60 seconds (all 3 bids)
      await lockedWallet.createBid(
        {name, lockup: 1000000, bid: 1000000, passphrase}
      );
      await lockedWallet.createBid({name, lockup: 2000000, bid: 2000000});
      await lockedWallet.createBid({name, lockup: 3000000, bid: 3000000});
      await lock();

      await nodeCtx.mineBlocks(biddingPeriod + 1, cbAddress);

      // Reveal
      await assert.rejects(
        lockedWallet.createReveal({name}),
        {message: 'No passphrase.'}
      );
      const revealAll = await lockedWallet.createReveal({name, passphrase});
      await lock();

      // All 3 bids are revealed
      const reveals = revealAll.outputs.filter(
        output => output.covenant.type === types.REVEAL
      );
      assert.equal(reveals.length, 3);

      await nodeCtx.mineBlocks(revealPeriod + 1, cbAddress);

      // Redeem all by not passing specific name
      await assert.rejects(
        lockedWallet.createRedeem(),
        {message: 'No passphrase.'}
      );
      const redeemAll = await lockedWallet.createRedeem({passphrase});
      await lock();

      // Only 2 reveals are redeemed (because the third one is the winner)
      const redeems = redeemAll.outputs.filter(
        output => output.covenant.type === types.REDEEM
      );
      assert.equal(redeems.length, 2);

      // Register
      await assert.rejects(
        lockedWallet.createUpdate({name, data: {records: []}}),
        {message: 'No passphrase.'}
      );
      const register = await lockedWallet.createUpdate(
        {name, data: {records: []}, passphrase}
      );
      await lock();

      // Only 1 register, only 1 winner!
      const registers = register.outputs.filter(
        output => output.covenant.type === types.REGISTER
      );
      assert.equal(registers.length, 1);
    });

    it('should get all wallet names', async () => {
      const names = await wallet.getNames();

      assert.equal(allNames.length, names.length);

      for (const {name} of names) {
        assert(allNames.includes(name));
      }
    });

    it('should only get wallet-owned names', async () => {
      const names = await wallet.getNames({ own: true });

      assert.equal(names.length, ownedNames.length);

      for (const {name} of names) {
        assert(ownedNames.includes(name));
      }
    });

    it('should get owned names name info', async () => {
      const ownedNSes = await wallet.getNames({ own: true });
      const ownedNames = new Map(ownedNSes.map(ns => [ns.name, ns]));

      for (const name of allNames) {
        const isOwned = ownedNames.has(name);
        const ns = await wallet.getName(name, { own: true });

        assert.strictEqual(ns != null, isOwned);

        if (isOwned)
          assert.deepEqual(ns, ownedNames.get(name));
      }
    });
  });

  describe('HTTP tx races (Integration)', function() {
    const WNAME1 = 'racetest-1';
    const WNAME2 = 'racetest-2';
    const FUND_VALUE = 1e6;
    const HARD_FEE = 1e4;
    const NAMES = [];
    const PASSPHRASE1 = 'racetest-passphrase-1';
    const PASSPHRASE2 = 'racetest-passphrase-2';

    let rcwallet1, rcwallet2, wclient;
    let w1addr;

    const checkDoubleSpends = (txs) => {
      const spentCoins = new BufferSet();

      for (const tx of txs) {
        for (const input of tx.inputs) {
          const key = input.prevout.toKey();

          if (spentCoins.has(key))
            throw new Error(`Input ${input.prevout.format()} is already spent.`);

          spentCoins.add(key);
        }
      }
    };

    const wMineBlocks = async (n = 1) => {
      const forConnect = common.forEvent(nodeCtx.wdb, 'block connect', n);
      await nodeCtx.mineBlocks(n, w1addr);
      await forConnect;
    };

    const fundNcoins = async (recvWallet, n, value = FUND_VALUE) => {
      assert(typeof n === 'number');
      for (let i = 0; i < n; i++) {
        const addr = (await recvWallet.createAddress('default')).address;

        await wallet.send({
          hardFee: HARD_FEE,
          outputs: [{
            address: addr,
            value: value
          }]
        });
      }

      await wMineBlocks(1);
    };

    before(async () => {
      await beforeAll();

      wclient = nodeCtx.wclient;
      rcwallet1 = wclient.wallet(WNAME1);
      rcwallet2 = wclient.wallet(WNAME2);

      w1addr = (await wallet.createAddress('default')).address;
      const winfo1 = await wclient.createWallet(WNAME1, {
        passphrase: PASSPHRASE1
      });

      const winfo2 = await wclient.createWallet(WNAME2, {
        passphrase: PASSPHRASE2
      });

      assert(winfo1);
      assert(winfo2);

      // Fund primary wallet.
      await wMineBlocks(5);
    });

    after(afterAll);

    beforeEach(async () => {
      await rcwallet1.lock();
      await rcwallet2.lock();
    });

    it('should fund 3 new transactions', async () => {
      const promises = [];

      await fundNcoins(rcwallet1, 3);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.send({
          passphrase: PASSPHRASE1,
          subtractFee: true,
          hardFee: HARD_FEE,
          outputs: [{
            address: w1addr,
            value: FUND_VALUE
          }]
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(details => MTX.fromHex(details.tx));
      checkDoubleSpends(txs);

      await forMemTX;
      await wMineBlocks(1);

      const balance = await rcwallet1.getBalance();

      assert.strictEqual(balance.confirmed, 0);
      assert.strictEqual(balance.unconfirmed, 0);
      assert.strictEqual(balance.coin, 0);
    });

    it('should open 3 name auctions', async () => {
      await fundNcoins(rcwallet1, 3);

      for (let i = 0; i < 3; i++)
        NAMES.push(rules.grindName(10, nodeCtx.chain.tip.height, network));

      const promises = [];

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 4);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createOpen({
          name: NAMES[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(result => MTX.fromHex(result.hex));
      checkDoubleSpends(txs);

      // spend all money for now.
      // Passphrase not necessary as the wallet is unlocked.
      await rcwallet1.send({
        subtractFee: true,
        outputs: [{
          value: (FUND_VALUE - HARD_FEE) * 3,
          address: w1addr
        }]
      });

      await forMemTX;
      await wMineBlocks(1);

      const balance = await rcwallet1.getBalance();
      // 3 opens (0 value)
      assert.strictEqual(balance.coin, 3);
      assert.strictEqual(balance.confirmed, 0);
    });

    it('should bid 3 times', async () => {
      const promises = [];

      // 2 blocks.
      await fundNcoins(rcwallet1, 3);
      await fundNcoins(rcwallet2, 6);

      // this is 2 blocks ahead, but does not matter for this test.
      await wMineBlocks(network.names.treeInterval + 1);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3 + 3 * 2);

      for (let i = 0; i < 3; i++) {
        // make sure we use ALL coins, no NONE left.
        // winner.
        promises.push(rcwallet1.createBid({
          name: NAMES[i],
          bid: HARD_FEE,
          lockup: HARD_FEE,
          passphrase: PASSPHRASE1,
          hardFee: FUND_VALUE - HARD_FEE
        }));

        // We want redeemer to not have enough funds
        // to redeem the money back and has to use
        // extra funds for it.
        //
        // ALSO We want to have enough redeems to
        // do redeemAll and redeem.
        for (let j = 0; j < 2; j++) {
          promises.push(rcwallet2.createBid({
            name: NAMES[i],
            bid: HARD_FEE - 1,
            lockup: HARD_FEE - 1,
            passphrase: PASSPHRASE2,
            // lose all funds in fees.
            hardFee: FUND_VALUE - HARD_FEE
          }));
        }
      }

      const results = await Promise.all(promises);
      const txs = results.map(result => MTX.fromHex(result.hex));
      checkDoubleSpends(txs);

      await forMemTX;

      await wMineBlocks(1);
      const balance1 = await rcwallet1.getBalance();
      const balance2 = await rcwallet2.getBalance();

      // 3 opens and 3 bids (nothing extra)
      assert.strictEqual(balance1.coin, 6);
      assert.strictEqual(balance1.confirmed, HARD_FEE * 3);

      // 6 bids (nothing extra)
      assert.strictEqual(balance2.coin, 6);
      assert.strictEqual(balance2.confirmed, (HARD_FEE - 1) * 6);
    });

    it('should reveal 3 times and reveal all', async () => {
      // Now we don't have fees to reveal. Fund these fees.
      await fundNcoins(rcwallet1, 3, HARD_FEE);
      await fundNcoins(rcwallet2, 1, HARD_FEE);

      const promises = [];

      await wMineBlocks(network.names.biddingPeriod);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 4);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createReveal({
          name: NAMES[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        }));
      }

      // do reveal all
      promises.push(rcwallet2.createReveal({
        passphrase: PASSPHRASE2,
        hardFee: HARD_FEE
      }));

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;

      await wMineBlocks(1);

      const balance1 = await rcwallet1.getBalance();

      // 3 opens and 3 reveals
      assert.strictEqual(balance1.coin, 6);
      assert.strictEqual(balance1.confirmed, HARD_FEE * 3);

      const balance2 = await rcwallet2.getBalance();

      // 6 reveals
      assert.strictEqual(balance2.coin, 6);
      assert.strictEqual(balance2.confirmed, (HARD_FEE - 1) * 6);
      await wMineBlocks(network.names.revealPeriod);
    });

    it('should register 3 times', async () => {
      const promises = [];

      // We don't have funds to fund anything.
      // Add 3 coins to pay for the fees and cause
      // double spend.
      await fundNcoins(rcwallet1, 3, HARD_FEE);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createUpdate({
          name: NAMES[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE,
          data: {
            records: [
              {
                type: 'TXT',
                txt: ['foobar']
              }
            ]
          }
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;

      await wMineBlocks(1);
    });

    it('should redeem 3 times and redeem all', async () => {
      const promises = [];

      await fundNcoins(rcwallet2, 3, HARD_FEE);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      for (let i = 0; i < 2; i++) {
        promises.push(rcwallet2.createRedeem({
          name: NAMES[i],
          passphrase: PASSPHRASE2,
          hardFee: HARD_FEE
        }));
      }

      promises.push(rcwallet2.createRedeem({
        hardFee: HARD_FEE
      }));

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;
    });

    it('should renew 3 names', async () => {
      const promises = [];

      await wMineBlocks(network.names.treeInterval);
      await fundNcoins(rcwallet1, 3, HARD_FEE);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createRenewal({
          name: NAMES[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;

      await wMineBlocks(1);
    });

    it('should transfer 3 names', async () => {
      const promises = [];

      await fundNcoins(rcwallet1, 3, HARD_FEE);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      const addrs = [
        (await rcwallet2.createAddress('default')).address,
        (await rcwallet2.createAddress('default')).address,
        (await rcwallet2.createAddress('default')).address
      ];

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createTransfer({
          name: NAMES[i],
          address: addrs[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;
      await wMineBlocks(1);
    });

    it('should cancel 3 names', async () => {
      const promises = [];

      await fundNcoins(rcwallet1, 3, HARD_FEE);

      const forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createCancel({
          name: NAMES[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;
      await wMineBlocks(1);
    });

    it('should finalize 3 names', async () => {
      await fundNcoins(rcwallet1, 6, HARD_FEE);

      let forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      const addrs = [
        (await rcwallet2.createAddress('default')).address,
        (await rcwallet2.createAddress('default')).address,
        (await rcwallet2.createAddress('default')).address
      ];

      for (let i = 0; i < 3; i++) {
        await rcwallet1.createTransfer({
          name: NAMES[i],
          address: addrs[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        });
      }

      await forMemTX;
      await wMineBlocks(network.names.transferLockup);

      // Now we finalize all.
      const promises = [];

      forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet1.createFinalize({
          name: NAMES[i],
          passphrase: PASSPHRASE1,
          hardFee: HARD_FEE
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;

      await wMineBlocks(1);
    });

    it('should revoke 3 names', async () => {
      // send them back
      await fundNcoins(rcwallet2, 6, HARD_FEE);

      let forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);

      const addrs = [
        (await rcwallet1.createAddress('default')).address,
        (await rcwallet1.createAddress('default')).address,
        (await rcwallet1.createAddress('default')).address
      ];

      for (let i = 0; i < 3; i++) {
        await rcwallet2.createTransfer({
          name: NAMES[i],
          address: addrs[i],
          passphrase: PASSPHRASE2,
          hardFee: HARD_FEE
        });
      }

      await forMemTX;
      await wMineBlocks(network.names.transferLockup);

      forMemTX = common.forEvent(nodeCtx.mempool, 'tx', 3);
      const promises = [];

      for (let i = 0; i < 3; i++) {
        promises.push(rcwallet2.createRevoke({
          name: NAMES[i],
          passphrase: PASSPHRASE2,
          hardFee: HARD_FEE
        }));
      }

      const results = await Promise.all(promises);
      const txs = results.map(r => MTX.fromHex(r.hex));
      checkDoubleSpends(txs);
      await forMemTX;
    });
  });

  describe('Wallet TX pagination', function() {
    const GENESIS_TIME = 1580745078;

    // account to receive single tx per block.
    const SINGLE_ACCOUNT = 'single';
    const DEFAULT_ACCOUNT = 'default';

    let fundWallet, testWallet, unconfirmedTime;

    async function sendTXs(count, account = DEFAULT_ACCOUNT) {
      const mempoolTXs = forEvent(nodeCtx.mempool, 'tx', count);

      for (let i = 0; i < count; i++) {
        const {address} = await testWallet.createAddress(account);
        await fundWallet.send({ outputs: [{address, value: 1e6}] });
      }

      await mempoolTXs;
    }

    before(async () => {
      await beforeAll();

      await wclient.createWallet('test');
      fundWallet = wclient.wallet('primary');
      testWallet = wclient.wallet('test');

      await testWallet.createAccount(SINGLE_ACCOUNT);

      const fundAddress = (await fundWallet.createAddress('default')).address;

      await generateInitialBlocks({
        nodeCtx,
        sendTXs,
        singleAccount: SINGLE_ACCOUNT,
        coinbase: fundAddress,
        genesisTime: GENESIS_TIME
      });

      unconfirmedTime = Math.floor(Date.now() / 1000);

      // 20 txs unconfirmed
      const all = forEvent(nodeCtx.wdb, 'tx', 20);
      await sendTXs(20);
      await all;
    });

    after(async () => {
      await afterAll();
    });

    describe('confirmed and unconfirmed txs (dsc)', function() {
      it('first page', async () => {
        const history = await testWallet.getHistory({
          limit: 100,
          reverse: true
        });

        assert.strictEqual(history.length, 100);
        assert.strictEqual(history[0].confirmations, 0);
        assert.strictEqual(history[19].confirmations, 0);
        assert.strictEqual(history[20].confirmations, 1);
        assert.strictEqual(history[39].confirmations, 1);
        assert.strictEqual(history[40].confirmations, 2);
        assert.strictEqual(history[99].confirmations, 4);
      });

      it('second page', async () => {
        const one = await testWallet.getHistory({
          limit: 100,
          reverse: true
        });

        assert.strictEqual(one.length, 100);
        assert.strictEqual(one[0].confirmations, 0);
        assert.strictEqual(one[19].confirmations, 0);
        assert.strictEqual(one[20].confirmations, 1);
        assert.strictEqual(one[99].confirmations, 4);

        const after = one[99].hash;

        const two = await testWallet.getHistory({
          after,
          limit: 100,
          reverse: true
        });

        assert.strictEqual(two.length, 100);
        assert.strictEqual(two[0].confirmations, 5);
        assert.strictEqual(two[19].confirmations, 5);
        assert.strictEqual(two[20].confirmations, 6);
        assert.strictEqual(two[99].confirmations, 9);
        assert.notStrictEqual(two[0].hash, one[99].hash);
      });

      it('first page (w/ account)', async () => {
        const history = await testWallet.getHistory({
          account: SINGLE_ACCOUNT,
          limit: 100,
          reverse: true
        });

        // we are sending txs from coinbase.
        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 1);
        assert.strictEqual(history[1].confirmations, 2);
        assert.strictEqual(history[19].confirmations, 20);
      });

      it('second page (w/ account)', async () => {
        const one = await testWallet.getHistory({
          account: SINGLE_ACCOUNT,
          limit: 10,
          reverse: true
        });

        assert.strictEqual(one.length, 10);

        const after = one[9].hash;

        const two = await testWallet.getHistory({
          account: SINGLE_ACCOUNT,
          after: after,
          limit: 10,
          reverse: true
        });

        assert.strictEqual(two.length, 10);
        assert.strictEqual(two[0].confirmations, 11);
        assert.strictEqual(two[9].confirmations, 20);
        assert.notStrictEqual(two[0].hash, one[9].hash);
      });

      it('with datetime (MTP in epoch seconds)', async () => {
        const history = await testWallet.getHistory({
          limit: 100,
          time: Math.ceil(Date.now() / 1000),
          reverse: true
        });

        assert.strictEqual(history.length, 100);
        assert(history[0].confirmations < history[99].confirmations);
      });
    });

    describe('confirmed txs (asc)', function() {
      it('first page', async () => {
        const history = await testWallet.getHistory({
          account: SINGLE_ACCOUNT,
          limit: 12,
          reverse: false
        });

        assert.strictEqual(history.length, 12);
        assert.strictEqual(history[0].confirmations, 20);
        assert.strictEqual(history[11].confirmations, 9);
      });

      it('second page', async () => {
        const one = await testWallet.getHistory({
          account: SINGLE_ACCOUNT,
          limit: 12,
          reverse: false
        });

        assert.strictEqual(one.length, 12);
        assert.strictEqual(one[0].confirmations, 20);
        assert.strictEqual(one[11].confirmations, 9);

        const after = one[11].hash;

        const two = await testWallet.getHistory({
          account: SINGLE_ACCOUNT,
          after: after,
          limit: 10,
          reverse: false
        });

        assert.strictEqual(two.length, 8);
        assert.strictEqual(two[0].confirmations, 8);
        assert.strictEqual(two[7].confirmations, 1);
        assert.notStrictEqual(two[0].hash, one[7].hash);
      });

      it('with datetime (MTP in epoch seconds)', async () => {
        const history = await testWallet.getHistory({
          limit: 100,
          time: GENESIS_TIME,
          reverse: false
        });

        assert.strictEqual(history.length, 100);
        assert(history[0].confirmations > history[99].confirmations);
      });
    });

    describe('unconfirmed txs (dsc)', function() {
      it('first page', async () => {
        const history = await testWallet.getPending({
          limit: 50,
          reverse: true
        });

        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 0);
        const a = history[0].mtime;
        assert.strictEqual(Number.isInteger(a), true);
        assert.strictEqual(history[19].confirmations, 0);
        const b = history[19].mtime;
        assert.strictEqual(Number.isInteger(b), true);
        assert.strictEqual(a >= b, true);

        const historyAccount = await testWallet.getPending({
          account: DEFAULT_ACCOUNT,
          limit: 50,
          reverse: true
        });

        assert.deepStrictEqual(historyAccount, history);
      });

      it('second page', async () => {
        const one = await testWallet.getPending({
          limit: 5,
          reverse: true
        });

        const oneAccount = await testWallet.getPending({
          account: DEFAULT_ACCOUNT,
          limit: 5,
          reverse: true
        });

        assert.deepStrictEqual(oneAccount, one);

        const after = one[4].hash;

        const two = await testWallet.getPending({
          after: after,
          limit: 40,
          reverse: true
        });

        const twoAccount = await testWallet.getPending({
          after: after,
          account: DEFAULT_ACCOUNT,
          limit: 40,
          reverse: true
        });

        assert.deepStrictEqual(twoAccount, two);

        assert.strictEqual(two.length, 15);
        assert.strictEqual(two[0].confirmations, 0);
        const a = two[0].mtime;
        assert.strictEqual(Number.isInteger(a), true);
        assert.strictEqual(two[14].confirmations, 0);
        const b = two[14].mtime;
        assert.strictEqual(Number.isInteger(b), true);
        assert.strictEqual(a >= b, true);

        assert.notStrictEqual(two[0].hash, one[4].hash);
      });

      it('with datetime (MTP in epoch seconds)', async () => {
        const history = await testWallet.getPending({
          limit: 20,
          time: Math.ceil((Date.now() + 2000) / 1000),
          reverse: true
        });

        assert.strictEqual(history.length, 20);
        assert(history[0].mtime >= history[19].mtime);

        const historyAccount = await testWallet.getPending({
          account: DEFAULT_ACCOUNT,
          limit: 20,
          time: Math.ceil((Date.now() + 2000) / 1000),
          reverse: true
        });

        assert.deepStrictEqual(historyAccount, history);
      });
    });

    describe('unconfirmed txs (asc)', function() {
      it('first page', async () => {
        const history = await testWallet.getPending({
          limit: 50,
          reverse: false
        });

        const historyAccount = await testWallet.getPending({
          account: DEFAULT_ACCOUNT,
          limit: 50,
          reverse: false
        });

        assert.deepStrictEqual(historyAccount, history);

        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 0);
        const a = history[0].mtime;
        assert.strictEqual(Number.isInteger(a), true);
        assert.strictEqual(history[19].confirmations, 0);
        const b = history[19].mtime;
        assert.strictEqual(Number.isInteger(b), true);
        assert.strictEqual(a <= b, true);
      });

      it('second page', async () => {
        const one = await testWallet.getPending({
          limit: 5,
          reverse: false
        });

        const oneAccount = await testWallet.getPending({
          account: DEFAULT_ACCOUNT,
          limit: 5,
          reverse: false
        });

        assert.deepStrictEqual(oneAccount, one);

        assert.strictEqual(one.length, 5);
        const after = one[4].hash;

        const two = await testWallet.getPending({
          after: after,
          limit: 15,
          reverse: false
        });

        const twoAccount = await testWallet.getPending({
          after: after,
          account: DEFAULT_ACCOUNT,
          limit: 15,
          reverse: false
        });

        assert.deepStrictEqual(twoAccount, two);

        assert.strictEqual(two.length, 15);
        assert.strictEqual(two[0].confirmations, 0);
        const a = two[0].mtime;
        assert.strictEqual(Number.isInteger(a), true);
        assert.strictEqual(two[14].confirmations, 0);
        const b = two[14].mtime;
        assert.strictEqual(Number.isInteger(b), true);
        assert.strictEqual(a <= b, true);

        assert.notStrictEqual(two[0].hash, one[4].hash);
      });

      it('with datetime (MTP in epoch seconds)', async () => {
        const history = await testWallet.getPending({
          limit: 20,
          time: unconfirmedTime,
          reverse: false
        });

        assert.strictEqual(history.length, 20);
        assert(history[0].mtime <= history[19].mtime);

        const historyAccount = await testWallet.getPending({
          account: DEFAULT_ACCOUNT,
          limit: 20,
          time: unconfirmedTime,
          reverse: false
        });

        assert.deepStrictEqual(historyAccount, history);
      });
    });
  });
});

// create an OPEN output
function openOutput(name, address, network) {
  const nameHash = rules.hashName(name);
  const rawName = Buffer.from(name, 'ascii');

  const output = new Output();
  output.address = Address.fromString(address, network);
  output.value = 0;
  output.covenant.setOpen(nameHash, rawName);

  return output;
}
