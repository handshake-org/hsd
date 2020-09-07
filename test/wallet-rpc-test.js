/* eslint-env mocha */

'use strict';

const {NodeClient,WalletClient} = require('hs-client');
const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const HDPrivateKey = require('../lib/hd/private');
const Script = require('../lib/script/script');
const Address = require('../lib/primitives/address');
const network = Network.get('regtest');
const mnemonics = require('./data/mnemonic-english.json');
// Commonly used test mnemonic
const phrase = mnemonics[0][1];
// First 200 addresses derived from watch only wallet
const addresses = require('./data/addresses.json');

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
  });
});
