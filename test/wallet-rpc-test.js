'use strict';

const {NodeClient,WalletClient} = require('hs-client');
const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const HDPrivateKey = require('../lib/hd/private');
const Script = require('../lib/script/script');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');

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

const ports = {
  p2p: 14331,
  node: 14332,
  wallet: 14333
};

const node = new FullNode({
  network: network.type,
  apiKey: 'bar',
  walletAuth: true,
  memory: true,
  port: ports.p2p,
  httpPort: ports.node,
  workers: true,
  plugins: [require('../lib/wallet/plugin')],
  env: {
    'HSD_WALLET_HTTP_PORT': ports.wallet.toString()
  }
});

const nclient = new NodeClient({
  port: ports.node,
  apiKey: 'bar'
});

const wclient = new WalletClient({
  port: ports.wallet,
  apiKey: 'bar'
});

const {wdb} = node.require('walletdb');

const GNAME_SIZE = 10;

describe('Wallet RPC Methods', function() {
  this.timeout(15000);

  let xpub;

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

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
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

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
      assert.strictEqual(info.height, node.chain.height);
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
      for (let i = 0; i < n; i++) {
        const block = await node.miner.mineBlock(null, addr);
        await node.chain.add(block);
      }
    }

    before(async () => {
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
    // Prevent mempool from sending duplicate TXs back to the walletDB and txdb.
    // This will prevent a race condition when we need to remove spent (but
    // unconfirmed) outputs from the wallet so they can be reused in other tests.
    node.mempool.emit = () => {};

    let wallet;
    before(async () => {
      await wclient.createWallet('auctionRPCWallet');
      wallet = wclient.wallet('auctionRPCWallet');
      await wclient.execute('selectwallet', ['auctionRPCWallet']);
      const addr = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [10, addr]);
    });

    it('should do an auction', async () => {
      const NAME1 = rules.grindName(GNAME_SIZE, 2, network);
      const NAME2 = rules.grindName(GNAME_SIZE, 3, network);
      const addr = await wclient.execute('getnewaddress', []);
      await nclient.execute('generatetoaddress', [10, addr]);
      await forValue(wdb, 'height', node.chain.height);

      await wclient.execute('sendopen', [NAME1]);
      await wclient.execute('sendopen', [NAME2]);
      await nclient.execute('generatetoaddress', [treeInterval + 1, addr]);
      await forValue(wdb, 'height', node.chain.height);

      // NAME1 gets 3 bids, NAME2 gets 4.
      await wclient.execute('sendbid', [NAME1, 1, 2]);
      await wclient.execute('sendbid', [NAME1, 3, 4]);
      await wclient.execute('sendbid', [NAME1, 5, 6]);

      await wclient.execute('sendbid', [NAME2, 1, 2]);
      await wclient.execute('sendbid', [NAME2, 3, 4]);
      await wclient.execute('sendbid', [NAME2, 5, 6]);
      await wclient.execute('sendbid', [NAME2, 7, 8]);
      await nclient.execute('generatetoaddress', [biddingPeriod, addr]);
      await forValue(wdb, 'height', node.chain.height);

      // Works with and without specifying name.
      const createRevealName = await wclient.execute('createreveal', [NAME1]);
      const createRevealAll = await wclient.execute('createreveal', []);
      const sendRevealName = await wclient.execute('sendreveal', [NAME1]);

      // Un-send so we can try again.
      await node.mempool.reset();
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
      await forValue(wdb, 'height', node.chain.height);

      // Works with and without specifying name.
      const createRedeemName = await wclient.execute('createredeem', [NAME1]);
      const createRedeemAll = await wclient.execute('createredeem', []);
      const sendRedeemName = await wclient.execute('sendredeem', [NAME1]);

      // Un-send so we can try again.
      await node.mempool.reset();
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
});
