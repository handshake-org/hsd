'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const HDPrivateKey = require('../lib/hd/private');
const Script = require('../lib/script/script');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const Amount = require('../lib/ui/amount');
const NodeContext = require('./util/node-context');
const {forEvent} = require('./util/common');
const {generateInitialBlocks} = require('./util/pagination');

const {types} = rules;
const {forValue} = require('./util/common');

// Commonly used test mnemonic
const mnemonics = require('./data/mnemonic-english.json');
const phrase = mnemonics[0][1];
// First 200 addresses derived from watch only wallet
const addresses = require('./data/addresses.json');

const network = Network.get('regtest');

const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

const GNAME_SIZE = 10;

describe('Wallet RPC Methods', function() {
  this.timeout(15000);

  /** @type {NodeContext} */
  let nodeCtx;
  /** @type {import('../lib/client/node')} */
  let nclient;
  /** @type {import('../lib/client/wallet')} */
  let wclient;
  /** @type {WalletDB} */
  let wdb;

  let xpub;

  const beforeAll = async () => {
    nodeCtx = new NodeContext({
      network: network.type,
      apiKey: 'bar',
      walletAuth: true,
      wallet: true
    });

    nodeCtx.init();

    wclient = nodeCtx.wclient;
    nclient = nodeCtx.nclient;
    wdb = nodeCtx.wdb;

    await nodeCtx.open();

    // Derive the xpub using the well known
    // mnemonic and network's coin type
    const mnemonic = Mnemonic.fromPhrase(phrase);
    const priv = HDPrivateKey.fromMnemonic(mnemonic);
    const type = network.keyPrefix.coinType;
    const key = priv.derive(44, true).derive(type, true).derive(0, true);

    xpub = key.toPublic();

    assert.equal(phrase, [
      'abandon', 'abandon', 'abandon', 'abandon',
      'abandon', 'abandon', 'abandon', 'abandon',
      'abandon', 'abandon', 'abandon', 'about'
    ].join(' '));
  };

  const afterAll = async () => {
    await nodeCtx.close();
  };

  describe('getaddressinfo', () => {
    const watchOnlyWalletId = 'foo';
    const standardWalletId = 'bar';

    // m/44'/5355'/0'/0/{0,1}
    const pubkeys = [
      Buffer.from('03253ea6d6486d1b9cc3a'
        + 'b01a9a321d65c350c6c26a9c536633e2ef36163316bf2', 'hex'),
      Buffer.from('02cd38edb6f9cb4fd7380'
        + '3b49aed97bfa95ef402cac2c34e8f551f8537811d2159', 'hex')
    ];

    // set up the initial testing state
    before(async () => {
      await beforeAll();

      {
        // Set up the testing environment
        // by creating a wallet and a watch
        // only wallet
        const info = await nclient.getInfo();
        assert.equal(info.chain.height, 0);
      }

      {
        // Create a watch only wallet using the path
        // m/44'/5355'/0' and assert that the wallet
        // was properly created
        const accountKey = xpub.xpubkey(network.type);
        const response = await wclient.createWallet(watchOnlyWalletId, {
          watchOnly: true,
          accountKey: accountKey
        });

        assert.equal(response.id, watchOnlyWalletId);

        const wallet = wclient.wallet(watchOnlyWalletId);
        const info = await wallet.getAccount('default');
        assert.equal(info.accountKey, accountKey);
        assert.equal(info.watchOnly, true);
      }

      {
        // Create a wallet that manages the private keys itself
        const response = await wclient.createWallet(standardWalletId);
        assert.equal(response.id, standardWalletId);

        const info = await wclient.getAccount(standardWalletId, 'default');
        assert.equal(info.watchOnly, false);
      };
    });

    after(afterAll);

    // the rpc interface requires the wallet to be selected first
    it('should return iswatchonly correctly', async () => {
      // m/44'/5355'/0'/0/0
      const receive = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';

      {
        await wclient.execute('selectwallet', [standardWalletId]);
        const response = await wclient.execute('getaddressinfo', [receive]);
        assert.equal(response.iswatchonly, false);
      }
      {
        await wclient.execute('selectwallet', [watchOnlyWalletId]);
        const response = await wclient.execute('getaddressinfo', [receive]);
        assert.equal(response.iswatchonly, true);
      }
    });

    it('should return the correct address', async () => {
      // m/44'/5355'/0'/0/0
      const receive = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';

      await wclient.execute('selectwallet', [watchOnlyWalletId]);
      const response = await wclient.execute('getaddressinfo', [receive]);
      assert.equal(response.address, receive);
    });

    it('should detect owned address', async () => {
      // m/44'/5355'/0'/0/0
      const receive = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';

      {
        await wclient.execute('selectwallet', [watchOnlyWalletId]);
        const response = await wclient.execute('getaddressinfo', [receive]);
        assert.equal(response.ismine, true);
      }
      {
        await wclient.execute('selectwallet', [standardWalletId]);
        const response = await wclient.execute('getaddressinfo', [receive]);
        assert.equal(response.ismine, false);
      }
    });

    it('should return the correct program for a p2pkh address', async () => {
      // m/44'/5355'/0'/0/0
      const receive = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';

      const address = Address.fromString(receive);
      const addr = address.toString(network);
      await wclient.execute('selectwallet', [watchOnlyWalletId]);
      const response = await wclient.execute('getaddressinfo', [addr]);
      assert.equal(response.witness_program, address.hash.toString('hex'));
    });

    it('should detect a p2wsh and its witness program', async () => {
      const script = Script.fromMultisig(2, 2, pubkeys);
      const address = Address.fromScript(script);

      const addr = address.toString(network);
      const response = await wclient.execute('getaddressinfo', [addr]);

      assert.equal(response.isscript, true);
      assert.equal(response.witness_program, address.hash.toString('hex'));
    });

    it('should detect ismine up to the lookahead', async () => {
      const info = await wclient.getAccount(watchOnlyWalletId, 'default');
      await wclient.execute('selectwallet', [watchOnlyWalletId]);

      // Assert that the lookahead is configured as expected
      // subtract one from addresses.length, it is 0 indexed
      assert.equal(addresses.length - 1, info.lookahead);

      // Each address through the lookahead number should
      // be recognized as an owned address
      for (let i = 0; i < info.lookahead+1; i++) {
        const address = addresses[i];
        const response = await wclient.execute('getaddressinfo', [address]);
        assert.equal(response.ismine, true);
      }

      // m/44'/5355'/0'/201
      // This address is outside of the lookahead range
      const failed = 'rs1qs2a5lthdy8uxh7d7faeqzuwlandyn0kg2lylqp';

      const response = await wclient.execute('getaddressinfo', [failed]);
      assert.equal(response.ismine, false);
    });

    it('should detect change addresses', async () => {
      await wclient.execute('selectwallet', [watchOnlyWalletId]);
      // m/44'/5355'/0'/1/0
      const address = 'rs1qxps2ljf5604tgyz7pvecuq6twwt4k9qsxcd27y';
      const info = await wclient.execute('getaddressinfo', [address]);

      assert.equal(info.ischange, true);
    });

    it('should throw for the wrong network', async () => {
      // m/44'/5355'/0'/0/0
      const failed = 'hs1q4rvs9pp9496qawp2zyqpz3s90fjfk362rl50q4';

      const fn = async () => await wclient.execute('getaddressinfo', [failed]);
      await assert.rejects(fn, 'Invalid address.');
    });

    it('should throw for invalid address', async () => {
      let failed = 'rs1q4rvs9pp9496qawp2zyqpz3s90fjfk362q92vq8';
      // remove the first character
      failed = failed.slice(1, failed.length);

      const fn = async () => await wclient.execute('getaddressinfo', [failed]);
      await assert.rejects(fn, 'Invalid address.');
    });
  });

  describe('signmessage', function() {
    before(beforeAll);
    after(afterAll);

    const nonWalletAddress = 'rs1q7q3h4chglps004u3yn79z0cp9ed24rfrhvrxnx';
    const message = 'This is just a test message';

    it('should signmessage with address', async () => {
      await wclient.execute('selectwallet', ['primary']);
      const address = await wclient.execute('getnewaddress');

      const signature = await wclient.execute('signmessage', [
        address,
        message
      ]);

      const verify = await nclient.execute('verifymessage', [
        address,
        signature,
        message
      ]);

      assert.strictEqual(verify, true);
    });

    it('should fail with invalid address', async () => {
      await assert.rejects(async () => {
        await wclient.execute('signmessage', [
          'invalid address format',
          message
        ]);
      }, {
        type: 'RPCError',
        message: 'Invalid address.'
      });
    });

    it('should fail with non-wallet address.', async () => {
      await assert.rejects(async () => {
        await wclient.execute('signmessage', [
          nonWalletAddress,
          message
        ]);
      }, {
        type: 'RPCError',
        message: 'Address not found.'
      });
    });

    it('should verify an externally signed message', async () => {
      // Created with node RPC signmessagewithprivkey, private key:
      // ERYZra8yTpNWNXsd1b3YdnRbZByykPg62TFM7KeXMqF7C2x4EvyW
      const address = 'rs1qapm5cx5j60nhyp6mmzx23xrk66yj3atpvj63ek';
      const message = 'Handshake is for friends!';
      const signature = 'ymnS7vTpo+IBWliXWnubTD7UX2aTbzLT5qg5btFxNlYBq' +
        'kdCJyji19FcpkINo+JQvJWgIwIq0IPybTPMBTlrJA==';

      const verify = await nclient.execute('verifymessage', [
        address,
        signature,
        message
      ]);

      assert.strictEqual(verify, true);
    });

    it('should get wallet info', async () => {
      const info = await wclient.execute('getwalletinfo', []);
      assert.strictEqual(info.walletid, 'primary');
      assert.strictEqual(info.height, nodeCtx.height);
    });

    describe('multisig', () => {
      const multiSigWalletId = 'foobar';

      before(async () => {
        // Create multisig wallet
        const response = await wclient.createWallet(multiSigWalletId, {
          type: 'multisig',
          mnemonic: mnemonics[1][1],
          passphrase:'secret456',
          m: 2,
          n: 2
        });
        assert.equal(response.id, multiSigWalletId);

        await wclient.addSharedKey(multiSigWalletId, 'default', xpub.xpubkey(network.type));

        const info = await wclient.getAccount(multiSigWalletId, 'default');
        assert.equal(info.initialized, true);
        assert.equal(info.type, 'multisig');
        assert.equal(info.watchOnly, false);
      });

      it('should not signmessage with address from multisig wallet', async () => {
        await wclient.execute('selectwallet', [multiSigWalletId]);
        const address = await wclient.execute('getnewaddress');

        await assert.rejects(async () => {
          await wclient.execute('signmessage', [
            address,
            message
          ]);
        }, {
          type: 'RPCError',
          message: 'Version 0 pubkeyhash address required for signing.'
        });
      });
    });
  });

  describe('signmessagewithname & verifymessagewithname', () => {
    const name = rules.grindName(GNAME_SIZE, 1, network);
    const nonWalletName = rules.grindName(GNAME_SIZE, 1, network);
    const message = 'Decentralized naming and certificate authority';
    const invalidNames = ['', null, '\'null\'', 'localhost'];

    assert(name !== nonWalletName);

    async function mineBlocks(n, addr) {
      addr = addr ? addr : new Address().toString('regtest');
      await nodeCtx.mineBlocks(n, addr);
    }

    before(async () => {
      await beforeAll();

      // Create new wallets
      await wclient.createWallet('alice');
      await wclient.createWallet('bob');

      const {receiveAddress: aliceAddr} = await wclient.getAccount('alice', 'default');
      const {receiveAddress: bobAddr} = await wclient.getAccount('bob', 'default');
      await wclient.execute('selectwallet', ['alice']);

      // fund wallets
      await mineBlocks(2, aliceAddr);
      await mineBlocks(2, bobAddr);

      // start an auction
      await wclient.execute('sendopen', [name]);
      await mineBlocks(network.names.treeInterval + 1);

      // +--------+-------+--------+
      // | Wallet | Value | Lockup |
      // +--------+-------+--------+
      // | Alice  |    10 |     10 |
      // +--------+-------+--------+
      // | Bob    |   100 |    100 |
      // +--------+-------+--------+

      await wclient.execute('selectwallet', ['alice']);
      await wclient.execute('sendbid', [name, 10, 10]);

      await wclient.execute('selectwallet', ['bob']);
      await wclient.execute('sendbid', [name, 100, 100]);
      await mineBlocks(network.names.biddingPeriod);

      // Alice reveal and become the temporary winner
      await wclient.execute('selectwallet', ['alice']);
      await wclient.execute('sendreveal', [name]);

      // mine just Alice's reveal.
      await mineBlocks(1);

      // Still in reveal phase
    });

    after(afterAll);

    it('should fail to sign before auction is closed', async () => {
      await wclient.execute('selectwallet', ['alice']);

      await assert.rejects(async () => {
        await wclient.execute('signmessagewithname', [
          name,
          'Nobody should be able to sign this message in the current auction phase'
        ]);
      }, {
        type: 'RPCError',
        message: 'Invalid name state.'
      });
    });

    it('should fail to verify before auction is closed', async () => {
      await wclient.execute('selectwallet', ['alice']);
      const message = 'We cannot verify a message before auction is closed';
      const signature = 'U2lnbmF0dXJlIGlzIGludmFsaWQsIGFzc2VydCB0aGUgZXJyb3IgbWVzc2FnZQ==';

      await assert.rejects(async () => {
        await nclient.execute('verifymessagewithname', [
          name,
          signature,
          message
        ]);
      }, {
        type: 'RPCError',
        message: 'Invalid name state.'
      });
    });

    it('should mine blocks until the auction is finished', async () => {
      await mineBlocks(network.names.revealPeriod);
    });

    it('should sign and verify message with name', async () => {
      await wclient.execute('selectwallet', ['alice']);

      const signature = await wclient.execute('signmessagewithname', [
        name,
        message
      ]);

      const verify = await nclient.execute('verifymessagewithname', [
        name,
        signature,
        message
      ]);

      assert.strictEqual(verify, true);
    });

    it('should fail with non-wallet name.', async () => {
      await wclient.execute('selectwallet', ['alice']);

      await assert.rejects(async () => {
        await wclient.execute('signmessagewithname', [
          nonWalletName,
          message
        ]);
      }, {
        type: 'RPCError',
        message: 'Cannot find the name owner.'
      });
    });

    it('should fail with non-owned name.', async () => {
      await wclient.execute('selectwallet', ['bob']);

      await assert.rejects(async () => {
        await wclient.execute('signmessagewithname', [
          name,
          message
        ]);
      }, {
        type: 'RPCError',
        message: 'Cannot find name owner\'s coin in wallet.'
      });
    });

    it('should fail to sign with invalid name.', async () => {
      await wclient.execute('selectwallet', ['alice']);

      for(const invalidName of invalidNames) {
        await assert.rejects(async () => {
          await wclient.execute('signmessagewithname', [
            invalidName,
            message
          ]);
        }, {
          type: 'RPCError',
          message: 'Invalid name.'
        });
      }
    });

    it('should fail to verify with invalid name.', async () => {
      const signature = 'S+ROcYA6r1xaFq+5cIMnd+O3Db7lzUmkpaR5b/FnwkgrZagroTYHnA+ZTMPRWAiWdVrGPjobXpSx9dZT+G5h6Q==';

      for(const invalidName of invalidNames) {
        await assert.rejects(async () => {
          await nclient.execute('verifymessagewithname', [
            invalidName,
            signature,
            message
          ]);
        }, {
          type: 'RPCError',
          message: 'Invalid name.'
        });
      }
    });

    it('should revoke the name', async () => {
      // Bob didn't reveal, Alice won.
      await wclient.execute('selectwallet', ['alice']);
      await wclient.execute('sendupdate', [name, {'records':[]}]);
      await mineBlocks(1);

      // Revoke the name
      await wclient.execute('sendrevoke', [name]);
      await mineBlocks(1);

      const ns = await nclient.execute('getnameinfo', [name]);
      assert(ns.info.state, 'REVOKED');
    });

    it('should fail to sign after revoke', async () => {
      await wclient.execute('selectwallet', ['alice']);

      await assert.rejects(async () => {
        await wclient.execute('signmessagewithname', [
          name,
          'Nobody should be able to sign this message in the current name state'
        ]);
      }, {
        type: 'RPCError',
        message: 'Invalid name state.'
      });
    });

    it('should fail to verify after revoke', async () => {
      await wclient.execute('selectwallet', ['alice']);
      const message = 'We cannot verify a message after revoke';
      const signature = 'U2lnbmF0dXJlIGlzIGludmFsaWQsIGFzc2VydCB0aGUgZXJyb3IgbWVzc2FnZQ==';

      await assert.rejects(async () => {
        await nclient.execute('verifymessagewithname', [
          name,
          signature,
          message
        ]);
      }, {
        type: 'RPCError',
        message: 'Invalid name state.'
      });
    });
  });

  describe('auction RPC', () => {
    let wallet;

    before(async () => {
      await beforeAll();
      // Prevent mempool from sending duplicate TXs back to the walletDB and txdb.
      // This will prevent a race condition when we need to remove spent (but
      // unconfirmed) outputs from the wallet so they can be reused in other tests.
      nodeCtx.mempool.emit = () => {};

      await wclient.createWallet('auctionRPCWallet');
      wallet = wclient.wallet('auctionRPCWallet');
      await wclient.execute('selectwallet', ['auctionRPCWallet']);
      const addr = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [10, addr]);
    });

    after(afterAll);

    it('should do an auction', async () => {
      const NAME1 = rules.grindName(GNAME_SIZE, 2, network);
      const NAME2 = rules.grindName(GNAME_SIZE, 3, network);
      const addr = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [10, addr]);
      await forValue(wdb, 'height', nodeCtx.height);

      await wclient.execute('sendopen', [NAME1]);
      await wclient.execute('sendopen', [NAME2]);
      await nclient.execute('generatetoaddress', [treeInterval + 1, addr]);
      await forValue(wdb, 'height', nodeCtx.height);

      // NAME1 gets 3 bids, NAME2 gets 4.
      await wclient.execute('sendbid', [NAME1, 1, 2]);
      await wclient.execute('sendbid', [NAME1, 3, 4]);
      await wclient.execute('sendbid', [NAME1, 5, 6]);

      await wclient.execute('sendbid', [NAME2, 1, 2]);
      await wclient.execute('sendbid', [NAME2, 3, 4]);
      await wclient.execute('sendbid', [NAME2, 5, 6]);
      await wclient.execute('sendbid', [NAME2, 7, 8]);
      await nclient.execute('generatetoaddress', [biddingPeriod, addr]);
      await forValue(wdb, 'height', nodeCtx.height);

      // Works with and without specifying name.
      const createRevealName = await wclient.execute('createreveal', [NAME1]);
      const createRevealAll = await wclient.execute('createreveal', []);
      const sendRevealName = await wclient.execute('sendreveal', [NAME1]);

      // Un-send so we can try again.
      await nodeCtx.mempool.reset();
      await wallet.abandon(sendRevealName.hash);
      const sendRevealAll = await wclient.execute('sendreveal', []);

      // If we don't specify the name, all 7 bids are revealed.
      // If we DO specify the name, only those 3 are revealed.
      assert.strictEqual(
        createRevealAll.outputs.filter(
          output => output.covenant.type === types.REVEAL
        ).length,
        7
      );
      assert.strictEqual(
        createRevealName.outputs.filter(
          output => output.covenant.type === types.REVEAL
        ).length,
        3
      );
      assert.strictEqual(
        sendRevealAll.outputs.filter(
          output => output.covenant.type === types.REVEAL
        ).length,
        7
      );
      assert.strictEqual(
        sendRevealName.outputs.filter(
          output => output.covenant.type === types.REVEAL
        ).length,
        3
      );

      await nclient.execute('generatetoaddress', [revealPeriod, addr]);
      await forValue(wdb, 'height', nodeCtx.height);

      // Works with and without specifying name.
      const createRedeemName = await wclient.execute('createredeem', [NAME1]);
      const createRedeemAll = await wclient.execute('createredeem', []);
      const sendRedeemName = await wclient.execute('sendredeem', [NAME1]);

      // Un-send so we can try again.
      await nodeCtx.mempool.reset();
      await wallet.abandon(sendRedeemName.hash);
      const sendRedeemAll = await wclient.execute('sendredeem', []);

      // If we don't specify the name, all 5 losing reveals are redeemed.
      // If we DO specify the name, only those 2 are redeemed.
      assert.strictEqual(
        createRedeemAll.outputs.filter(
          output => output.covenant.type === types.REDEEM
        ).length,
        5
      );
      assert.strictEqual(
        createRedeemName.outputs.filter(
          output => output.covenant.type === types.REDEEM
        ).length,
        2
      );
      assert.strictEqual(
        sendRedeemAll.outputs.filter(
          output => output.covenant.type === types.REDEEM
        ).length,
        5
      );
      assert.strictEqual(
        sendRedeemName.outputs.filter(
          output => output.covenant.type === types.REDEEM
        ).length,
        2
      );

      // Confirm wallet has won both names.
      await wclient.execute('sendupdate', [NAME1, {'records':[]}]);
      await wclient.execute('sendupdate', [NAME2, {'records':[]}]);
      await nclient.execute('generatetoaddress', [1, addr]);
    });
  });

  describe('Wallet RPC Auction', function() {
    before(beforeAll);
    after(afterAll);

    let addr1, addr2, name1, name2;

    it('should create wallets', async () => {
      await wclient.createWallet('wallet1');
      await wclient.createWallet('wallet2');
    });

    it('should get wallet addresses', async () => {
      await wclient.execute('selectwallet', ['wallet1']);
      addr1 = await wclient.execute('getnewaddress', []);
      await wclient.execute('selectwallet', ['wallet2']);
      addr2 = await wclient.execute('getnewaddress', []);
    });

    it('should fund wallets', async () => {
      await nclient.execute('generatetoaddress', [10, addr1]);
      await nclient.execute('generatetoaddress', [10, addr2]);
    });

    it('should open names', async () => {
      name1 = await nclient.execute('grindname', [5]);
      name2 = await nclient.execute('grindname', [5]);

      await wclient.execute('selectwallet', ['wallet1']);
      await wclient.execute('sendopen', [name1]);
      await wclient.execute('sendopen', [name2]);

      // confirm and advance to bidding phase
      await nclient.execute('generatetoaddress', [treeInterval + 1, addr1]);
    });

    it('should bid on names', async () => {
      // wallet1 will win name1
      await wclient.execute('selectwallet', ['wallet1']);
      await wclient.execute('sendbid', [name1, 10, 10]);
      await wclient.execute('sendbid', [name2, 5, 5]);

      // wallet2 will win name2
      await wclient.execute('selectwallet', ['wallet2']);
      await wclient.execute('sendbid', [name1, 5, 5]);
      await wclient.execute('sendbid', [name2, 10, 10]);

      // confirm and advance to reveal phase
      await nclient.execute('generatetoaddress', [biddingPeriod + 1, addr1]);
    });

    it('should reveal names', async () => {
      await wclient.execute('selectwallet', ['wallet1']);
      await wclient.execute('sendreveal', []);

      await wclient.execute('selectwallet', ['wallet2']);
      await wclient.execute('sendreveal', []);

      // confirm and advance to close auction
      await nclient.execute('generatetoaddress', [revealPeriod + 1, addr1]);
    });

    it('should get all wallet names', async () => {
      await wclient.execute('selectwallet', ['wallet1']);
      const wallet1AllNames = await wclient.execute('getnames', []);

      await wclient.execute('selectwallet', ['wallet2']);
      const wallet2AllNames = await wclient.execute('getnames', []);

      assert.strictEqual(wallet1AllNames.length, 2);
      assert.deepStrictEqual(wallet1AllNames, wallet2AllNames);
    });

    it('should only get wallet-owned names', async () => {
      await wclient.execute('selectwallet', ['wallet1']);
      const wallet1OwnedNames = await wclient.execute('getnames', [true]);

      await wclient.execute('selectwallet', ['wallet2']);
      const wallet2OwnedNames = await wclient.execute('getnames', [true]);

      assert.strictEqual(wallet1OwnedNames.length, 1);
      assert.strictEqual(wallet2OwnedNames.length, 1);
      assert.strictEqual(wallet1OwnedNames[0].name, name1);
      assert.strictEqual(wallet2OwnedNames[0].name, name2);
    });
  });

  describe('Batches', function() {
    let addr;

    before(async () => {
      await beforeAll();
      await wclient.createWallet('batchWallet');
      wclient.wallet('batchWallet');
      await wclient.execute('selectwallet', ['batchWallet']);
      addr = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [100, addr]);
    });

    after(afterAll);

    it('should have paths when creating batch', async () => {
      const json = await wclient.execute(
        'createbatch',
        [
          [['NONE', addr, 1]]
        ]
      );

      assert(json.inputs[0].path);
    });

    it('should not have paths when sending batch', async () => {
      const json = await wclient.execute(
        'sendbatch',
        [
          [['NONE', addr, 1]]
        ]
      );

      assert(!json.inputs[0].path);
    });

    it('should not send invalid batch: OPEN arguments', async () => {
      await assert.rejects(
        wclient.execute(
          'sendbatch',
          [
            [['OPEN', 'abc123'], ['OPEN', 'def456'], ['OPEN']]
          ]
        ),
        {message: 'OPEN action requires 1 argument: name'}
      );
    });

    it('should not send invalid batch: BID arguments', async () => {
      await assert.rejects(
        wclient.execute(
          'sendbatch',
          [
            [['OPEN', 'abc123'], ['OPEN', 'def456'], ['BID', 'ghi789', 1000]]
          ]
        ),
        {message: 'BID action requires 3 arguments: name, bid, value'}
      );
    });

    it('should not send invalid batch: BID values', async () => {
      // Bid value is higher than lockup
      await assert.rejects(
        wclient.execute(
          'sendbatch',
          [
            [['OPEN', 'abc123'], ['OPEN', 'def456'], ['BID', 'ghi789', 2, 1]]
          ]
        ),
        {message: 'Invalid bid.'}
      );
    });

    it('should not send invalid batch: REVEAL arguments', async () => {
      await assert.rejects(
        wclient.execute(
          'sendbatch',
          [
            [['OPEN', 'abc123'], ['OPEN', 'def456'], ['REVEAL', 'invalid.name']]
          ]
        ),
        {message: 'Invalid name: invalid.name.'}
      );
    });

    it('should send multiple OPENs', async () => {
      const tx = await wclient.execute(
        'sendbatch',
        [
          [['OPEN', 'abc123'], ['OPEN', 'def456'], ['OPEN', 'ghi789']]
        ]
      );
      assert(tx.outputs.length === 4);
      await nclient.execute('generatetoaddress', [7, addr]);
    });

    it('should send multiple BIDs', async () => {
      const tx = await wclient.execute(
        'sendbatch',
        [
          [
            ['BID', 'abc123', 1, 1],
            ['BID', 'def456', 2, 2],
            ['BID', 'ghi789', 3, 3],
            ['BID', 'ghi789', 4, 4]
          ]
        ]
      );
      assert(tx.outputs.length === 5);
      await nclient.execute('generatetoaddress', [7, addr]);
    });

    it('should send multiple REVEALs', async () => {
      const tx = await wclient.execute(
        'sendbatch',
        [
          [
            ['REVEAL', 'abc123'],
            ['REVEAL', 'def456']
          ]
        ]
      );
      assert(tx.outputs.length === 3);
      await nclient.execute('generatetoaddress', [1, addr]);
    });

    it('should send REVEAL all', async () => {
      const tx = await wclient.execute(
        'sendbatch',
        [
          [
            ['REVEAL']
          ]
        ]
      );
      assert(tx.outputs.length === 3);
      await nclient.execute('generatetoaddress', [10, addr]);
    });

    it('should send REDEEM all', async () => {
      const tx = await wclient.execute(
        'sendbatch',
        [
          [
            ['REDEEM']
          ]
        ]
      );
      assert(tx.outputs.length === 2);
      await nclient.execute('generatetoaddress', [1, addr]);
    });

    it('should send multiple REGISTERs', async () => {
      const tx = await wclient.execute(
        'sendbatch',
        [
          [
            ['UPDATE', 'abc123', {'records': [{'type': 'TXT', 'txt':['abc']}]}],
            ['UPDATE', 'def456', {'records': [{'type': 'TXT', 'txt':['def']}]}],
            ['UPDATE', 'ghi789', {'records': [{'type': 'TXT', 'txt':['ghi']}]}]
          ]
        ]
      );
      assert(tx.outputs.length === 4);
      await nclient.execute('generatetoaddress', [1, addr]);
    });
  });

  describe('gettransaction', function () {
    let alexAddr, barrieAddr;

    before(async () => {
      await beforeAll();
      await wclient.createWallet('alex');
      await wclient.createWallet('barrie');
      await wclient.execute('selectwallet', ['alex']);
      alexAddr = await wclient.execute('getnewaddress', []);
      await wclient.execute('selectwallet', ['barrie']);
      barrieAddr = await wclient.execute('getnewaddress', []);
    });

    after(afterAll);

    async function getCoinbaseTXID(height) {
      const block = await nclient.execute('getblockbyheight', [height]);
      return block.tx[0];
    }

    it('should mine 10 tx to each wallet and gettransaction', async () => {
      await nclient.execute('generatetoaddress', [10, alexAddr]);
      await nclient.execute('generatetoaddress', [10, barrieAddr]);

      const height = await nclient.execute('getblockcount', []);

      await wclient.execute('selectwallet', ['barrie']);
      for (let i = 0; i < 10; i++) {
        const txid = await getCoinbaseTXID(height - i);
        const json = await wclient.execute('gettransaction', [txid]);
        assert.strictEqual(json.amount, 2000);
        assert.strictEqual(json.details[0].category, 'receive');
        assert.strictEqual(json.details[0].amount, 2000);
        assert.strictEqual(json.details[0].fee, undefined);
      }

      await wclient.execute('selectwallet', ['alex']);
      for (let i = 10; i < 20; i++) {
        const txid = await getCoinbaseTXID(height - i);
        const json = await wclient.execute('gettransaction', [txid]);
        assert.strictEqual(json.amount, 2000);
        assert.strictEqual(json.details[0].category, 'receive');
        assert.strictEqual(json.details[0].amount, 2000);
        assert.strictEqual(json.details[0].fee, undefined);
      }
    });

    it('should receive from Barrie to Alex and gettransaction', async () => {
      await wclient.execute('selectwallet', ['barrie']);
      const txid = await wclient.execute('sendtoaddress', [alexAddr, 10]);
      await wclient.execute('selectwallet', ['alex']);
      const json = await wclient.execute('gettransaction', [txid]);
      assert.strictEqual(json.amount, 10);
      assert.strictEqual(json.details[0].category, 'receive');
      assert.strictEqual(json.details[0].amount, 10);
      assert.strictEqual(json.details[0].fee, undefined);
    });

    it('should send from Alex to Barrie and gettransaction', async () => {
      await wclient.execute('selectwallet', ['alex']);
      const txid = await wclient.execute('sendtoaddress', [barrieAddr, 21]);
      await wclient.execute('selectwallet', ['alex']);
      const json = await wclient.execute('gettransaction', [txid]);
      assert.strictEqual(json.amount, -21);
      assert.strictEqual(json.details[0].category, 'send');
      assert.strictEqual(json.details[0].amount, -21);

      const vsize = 140; // 1-in, 2-out pkh
      const fee = vsize * network.feeRate / 1000;
      const amount = Amount.fromBase(fee).toCoins(); // returned in whole HNS units
      assert.strictEqual(json.details[0].fee, amount * -1); // fees are negative
    });
  });

  describe('Multisig Auction RPC', function() {
    // wallet clients
    let alice, bob;

    // auction
    let name;
    const bidValue = 5, blindValue = 5;

    async function signMultisigTx(tx, walletClients) {
      assert(tx.hex, 'tx must be a json object with `hex`');
      assert(walletClients.length);

      for (const wclient of walletClients)
        tx = await wclient.sign({tx: tx.hex});

      return tx;
    }

    before(async () => {
      await beforeAll();
      await wclient.createWallet('msAlice', {
        type: 'multisig',
        m: 2,
        n: 2
      });
      await wclient.createWallet('msBob', {
        type: 'multisig',
        m: 2,
        n: 2
      });

      alice = wclient.wallet('msAlice');
      bob = wclient.wallet('msBob');

      // Initialize both multisig wallets
      const accountKeys = {
        alice: (await alice.getAccount('default')).accountKey,
        bob: (await bob.getAccount('default')).accountKey
      };
      await alice.addSharedKey('default', accountKeys.bob);
      await bob.addSharedKey('default', accountKeys.alice);

      // Fund wallet
      await wclient.execute('selectwallet', ['msAlice']);
      const addr = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [100, addr]);
    });

    after(afterAll);

    it('(alice) should open name for auction', async () => {
      await wclient.execute('selectwallet', ['msAlice']);

      // Create, sign, send OPEN
      name = await nclient.execute('grindname', [5]);
      const tx = await wclient.execute('createopen', [name]);
      const txSigned = await signMultisigTx(tx, [alice, bob]);
      await nclient.execute('sendrawtransaction', [txSigned.hex]);

      // confirm and advance to bidding phase
      const addrAlice = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [treeInterval + 1, addrAlice]);
    });

    it('(alice) should bid on name with blind', async () => {
      await wclient.execute('selectwallet', ['msAlice']);

      // Create, sign, send BID
      const tx = await wclient.execute(
        'createbid',
        [name, bidValue, bidValue + blindValue]
      );
      const txSigned = await signMultisigTx(tx, [alice, bob]);
      await nclient.execute('sendrawtransaction', [txSigned.hex]);

      // confirm and advance to reveal phase
      const addrAlice = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [biddingPeriod + 1, addrAlice]);
    });

    it('(bob) should not be able to reveal bid', async () => {
      // Alice can create reveal
      await wclient.execute('selectwallet', ['msAlice']);
      assert.doesNotReject(wclient.execute('createreveal', [name]));

      // Bob cannot.
      await wclient.execute('selectwallet', ['msBob']);
      await assert.rejects(
        wclient.execute('createreveal', [name]),
        {message: `No bids to reveal for name: ${name}.`}
      );
    });

    it('(bob) should import nonce', async () => {
      await wclient.execute('selectwallet', ['msBob']);
      const bidsBob = await wclient.execute('getbids', [name, true, true]);
      const address = bidsBob[0].address;
      const blinds = await wclient.execute('importnonce', [name, address, 5]);
      assert.strictEqual(blinds[0], bidsBob[0].blind);
    });

    it('(bob) should reveal bid', async () => {
      await wclient.execute('selectwallet', ['msBob']);

      // Create, sign, send REVEAL
      const tx = await wclient.execute('createreveal', [name]);
      const txSigned = await signMultisigTx(tx, [alice, bob]);
      await nclient.execute('sendrawtransaction', [txSigned.hex]);

      // confirm and advance to close auction
      const addrAlice = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [revealPeriod + 1, addrAlice]);

      // Ensure name is owned
      const ownedNames = await wclient.execute('getnames', [true]);
      assert.strictEqual(ownedNames.length, 1);
    });
  });

  describe('transactions', function() {
    const GENESIS_TIME = 1580745078;

    // account to receive single tx per block.
    const SINGLE_ACCOUNT = 'single';
    const DEFAULT_ACCOUNT = 'default';

    let fundWallet, testWallet, unconfirmedTime;
    let fundAddress;

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

      fundAddress = (await fundWallet.createAddress('default')).address;

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

    after(afterAll);

    beforeEach(async () => {
      await wclient.execute('selectwallet', ['test']);
    });

    describe('getreceivedbyaccount', function() {
      it('should get the correct balance', async () => {
        const bal = await wclient.execute('getreceivedbyaccount',
                                          [SINGLE_ACCOUNT]);
        assert.strictEqual(bal, 20);
      });
    });

    describe('listreceivedbyaccount', function() {
      it('should get expected number of results', async () => {
        const res = await wclient.execute('listreceivedbyaccount');
        assert.strictEqual(res.length, 2);
      });
    });

    describe('getreceivedbyaddress', function() {
      it('should get the correct balance', async () => {
        await wclient.execute('selectwallet', ['primary']);
        const bal = await wclient.execute('getreceivedbyaddress',
                                          [fundAddress]);
        assert.strictEqual(bal, 80001.12);
      });
    });

    describe('listreceivedbyaddress', function() {
      it('should get expected number of results', async () => {
        const res = await wclient.execute('listreceivedbyaddress');
        assert.strictEqual(res.length, 420);
      });
    });

    describe('listsinceblock', function() {
      it('should get expected number of results', async () => {
        const res = await wclient.execute('listsinceblock');
        assert.strictEqual(res.transactions.length, 20);
      });
    });

    describe('listhistory', function() {
      it('should get wallet history (desc)', async () => {
        const history = await wclient.execute('listhistory', ['*', 100, true]);;
        assert.strictEqual(history.length, 100);
        assert.strictEqual(history[0].confirmations, 0);
        assert.strictEqual(history[19].confirmations, 0);
        assert.strictEqual(history[20].confirmations, 1);
        assert.strictEqual(history[39].confirmations, 1);
        assert.strictEqual(history[40].confirmations, 2);
        assert.strictEqual(history[99].confirmations, 4);
      });

      it('should get wallet history (desc w/ account)', async () => {
        const history = await wclient.execute('listhistory',
          [SINGLE_ACCOUNT, 100, true]);

        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 1);
        assert.strictEqual(history[1].confirmations, 2);
        assert.strictEqual(history[2].confirmations, 3);
      });

      it('should get wallet history (asc)', async () => {
        const history = await wclient.execute('listhistory', ['*', 100, false]);
        assert.strictEqual(history.length, 100);

        assert.strictEqual(history[0].confirmations, 20);
        assert.strictEqual(history[19].confirmations, 20);
        assert.strictEqual(history[20].confirmations, 19);
        assert.strictEqual(history[39].confirmations, 19);
        assert.strictEqual(history[40].confirmations, 18);
        assert.strictEqual(history[99].confirmations, 16);
      });

      it('should get wallet history (asc w/ account)', async () => {
        const history = await wclient.execute('listhistory',
          [SINGLE_ACCOUNT, 100, false]);

        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 20);
        assert.strictEqual(history[1].confirmations, 19);
        assert.strictEqual(history[19].confirmations, 1);
      });
    });

    describe('listhistoryafter', function() {
      it('should get wallet history after (desc)', async () => {
        const history = await wclient.execute('listhistory', ['*', 100, true]);
        const historyAfter = await wclient.execute('listhistoryafter',
          ['*', history[99].txid, 100, true]);

        assert.strictEqual(historyAfter.length, 100);
        assert.strictEqual(historyAfter[0].confirmations, 5);
        assert.strictEqual(historyAfter[19].confirmations, 5);
        assert.strictEqual(historyAfter[20].confirmations, 6);
        assert.strictEqual(historyAfter[99].confirmations, 9);
        assert.notStrictEqual(historyAfter[0].txid, history[99].txid);
      });

      it('should get wallet history after (desc w/ account)', async () => {
        const history = await wclient.execute('listhistory',
          [SINGLE_ACCOUNT, 10, true]);

        const historyAfter = await wclient.execute('listhistoryafter',
          [SINGLE_ACCOUNT, history[9].txid, 10, true]);

        assert.strictEqual(historyAfter.length, 10);
        assert.strictEqual(historyAfter[0].confirmations, 11);
        assert.strictEqual(historyAfter[9].confirmations, 20);
        assert.notStrictEqual(historyAfter[0].txid, history[9].txid);
      });

      it('should get wallet history after (asc)', async () => {
        const history = await wclient.execute('listhistory', ['*', 100, false]);
        const historyAfter = await wclient.execute('listhistoryafter',
          ['*', history[99].txid, 100, false]);

        assert.strictEqual(historyAfter.length, 100);
        assert.strictEqual(historyAfter[0].confirmations, 15);
        assert.strictEqual(historyAfter[19].confirmations, 15);
        assert.strictEqual(historyAfter[20].confirmations, 14);
        assert.strictEqual(historyAfter[99].confirmations, 11);
        assert.notStrictEqual(historyAfter[0].txid, history[99].txid);
      });

      it('should get wallet history after (asc w/ account)', async () => {
        const history = await wclient.execute('listhistory',
          [SINGLE_ACCOUNT, 10, false]);
        const historyAfter = await wclient.execute('listhistoryafter',
          [SINGLE_ACCOUNT, history[9].txid, 10, false]);

        assert.strictEqual(historyAfter.length, 10);
        assert.strictEqual(historyAfter[0].confirmations, 10);
        assert.strictEqual(historyAfter[9].confirmations, 1);
        assert.notStrictEqual(historyAfter[0].txid, history[9].txid);
      });
    });

    describe('listhistorybytime', function() {
      it('should get wallet history by time (desc)', async () => {
        const time = Math.ceil(Date.now() / 1000);
        // This will look latest first confirmed. (does not include unconfirmed)
        const history = await wclient.execute('listhistorybytime',
          ['*', time, 100, true]);

        assert.strictEqual(history.length, 100);
        assert.strictEqual(history[0].confirmations, 1);
        assert.strictEqual(history[19].confirmations, 1);
        assert.strictEqual(history[20].confirmations, 2);
        assert.strictEqual(history[99].confirmations, 5);
        assert(history[0].confirmations <= history[99].confirmations);
      });

      it('should get wallet history by time (desc w/ account)', async () => {
        const time = Math.ceil(Date.now() / 1000);
        const history = await wclient.execute('listhistorybytime',
          [SINGLE_ACCOUNT, time, 100, true]);

        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 1);
        assert.strictEqual(history[19].confirmations, 20);
        assert(history[0].confirmations <= history[19].confirmations);
      });

      it('should get wallet history by time (asc)', async () => {
        const time = GENESIS_TIME;
        const history = await wclient.execute('listhistorybytime',
          ['*', time, 100, false]);

        assert.strictEqual(history.length, 100);
        assert.strictEqual(history[0].confirmations, 20);
        assert.strictEqual(history[19].confirmations, 20);
        assert.strictEqual(history[20].confirmations, 19);
        assert.strictEqual(history[99].confirmations, 16);
        assert(history[0].confirmations >= history[99].confirmations);
      });

      it('should get wallet history by time (asc w/ account)', async () => {
        const time = GENESIS_TIME;
        const history = await wclient.execute('listhistorybytime',
          [SINGLE_ACCOUNT, time, 100, false]);

        assert.strictEqual(history.length, 20);
        assert.strictEqual(history[0].confirmations, 20);
        assert.strictEqual(history[19].confirmations, 1);
        assert(history[0].confirmations >= history[19].confirmations);
      });
    });

    describe('listunconfirmed', function() {
      it('should get wallet unconfirmed txs (desc)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          ['*', 100, true]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a >= b);
      });

      it('should get wallet unconfirmed txs (desc w/ account)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          [DEFAULT_ACCOUNT, 100, true]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a >= b);
      });

      it('should get wallet unconfirmed txs (asc)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          ['*', 100, false]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a <= b);
      });

      it('should get wallet unconfirmed txs (asc w/ account)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          [DEFAULT_ACCOUNT, 100, false]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a <= b);
      });
    });

    describe('listunconfirmedafter', function() {
      it('should get wallet unconfirmed txs after (desc)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          ['*', 10, true]);
        const unconfirmedAfter = await wclient.execute('listunconfirmedafter',
          ['*', unconfirmed[9].txid, 10, true]);

        assert.strictEqual(unconfirmedAfter.length, 10);
        assert.strictEqual(unconfirmedAfter[0].confirmations, 0);
        assert.strictEqual(unconfirmedAfter[9].confirmations, 0);
        assert.notStrictEqual(unconfirmedAfter[0].txid, unconfirmed[9].txid);

        const a = unconfirmedAfter[0].time;
        const b = unconfirmedAfter[9].time;
        assert(a >= b);
      });

      it('should get wallet unconfirmed txs after (desc w/ account)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          [DEFAULT_ACCOUNT, 10, true]);
        const unconfirmedAfter = await wclient.execute('listunconfirmedafter',
          [DEFAULT_ACCOUNT, unconfirmed[9].txid, 10, true]);

        assert.strictEqual(unconfirmedAfter.length, 10);
        assert.strictEqual(unconfirmedAfter[0].confirmations, 0);
        assert.strictEqual(unconfirmedAfter[9].confirmations, 0);
        assert.notStrictEqual(unconfirmedAfter[0].txid, unconfirmed[9].txid);

        const a = unconfirmedAfter[0].time;
        const b = unconfirmedAfter[9].time;
        assert(a >= b);
      });

      it('should get wallet unconfirmed txs after (asc)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          ['*', 10, false]);
        const unconfirmedAfter = await wclient.execute('listunconfirmedafter',
          ['*', unconfirmed[9].txid, 10, false]);

        assert.strictEqual(unconfirmedAfter.length, 10);
        assert.strictEqual(unconfirmedAfter[0].confirmations, 0);
        assert.strictEqual(unconfirmedAfter[9].confirmations, 0);
        assert.notStrictEqual(unconfirmedAfter[0].txid, unconfirmed[9].txid);

        const a = unconfirmedAfter[0].time;
        const b = unconfirmedAfter[9].time;
        assert(a <= b);
      });

      it('should get wallet unconfirmed txs after (asc w/ account)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmed',
          [DEFAULT_ACCOUNT, 10, false]);
        const unconfirmedAfter = await wclient.execute('listunconfirmedafter',
          [DEFAULT_ACCOUNT, unconfirmed[9].txid, 10, false]);

        assert.strictEqual(unconfirmedAfter.length, 10);
        assert.strictEqual(unconfirmedAfter[0].confirmations, 0);
        assert.strictEqual(unconfirmedAfter[9].confirmations, 0);
        assert.notStrictEqual(unconfirmedAfter[0].txid, unconfirmed[9].txid);

        const a = unconfirmedAfter[0].time;
        const b = unconfirmedAfter[9].time;
        assert(a <= b);
      });
    });

    describe('listunconfirmedbytime', function() {
      it('should get wallet unconfirmed txs by time (desc)', async () => {
        const time = Math.ceil((Date.now() + 2000) / 1000);
        const unconfirmed = await wclient.execute('listunconfirmedbytime',
          ['*', time, 20, true]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a >= b);
      });

      it('should get wallet unconfirmed txs by time (desc w/ account)', async () => {
        const time = Math.ceil((Date.now() + 2000) / 1000);
        const unconfirmed = await wclient.execute('listunconfirmedbytime',
          [DEFAULT_ACCOUNT, time, 20, true]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a >= b);
      });

      it('should get wallet unconfirmed txs by time (asc)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmedbytime',
          ['*', unconfirmedTime, 20, false]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a <= b);
      });

      it('should get wallet unconfirmed txs by time (asc w/ account)', async () => {
        const unconfirmed = await wclient.execute('listunconfirmedbytime',
          [DEFAULT_ACCOUNT, unconfirmedTime, 20, false]);

        assert.strictEqual(unconfirmed.length, 20);
        assert.strictEqual(unconfirmed[0].confirmations, 0);
        assert.strictEqual(unconfirmed[19].confirmations, 0);
        const a = unconfirmed[0].time;
        const b = unconfirmed[19].time;
        assert(a <= b);
      });
    });
  });
});
