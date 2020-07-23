/*!
 * rpc.js - bitcoind-compatible json rpc for hsd.
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {format} = require('util');
const bweb = require('bweb');
const {Lock} = require('bmutex');
const fs = require('bfile');
const {BufferMap, BufferSet} = require('buffer-map');
const Validator = require('bval');
const blake2b = require('bcrypto/lib/blake2b');
const util = require('../utils/util');
const Amount = require('../ui/amount');
const Script = require('../script/script');
const Address = require('../primitives/address');
const KeyRing = require('../primitives/keyring');
const MerkleBlock = require('../primitives/merkleblock');
const MTX = require('../primitives/mtx');
const Outpoint = require('../primitives/outpoint');
const Output = require('../primitives/output');
const TX = require('../primitives/tx');
const consensus = require('../protocol/consensus');
const pkg = require('../pkg');
const common = require('./common');
const rules = require('../covenants/rules');
const {Resource} = require('../dns/resource');
const {EXP} = consensus;
const RPCBase = bweb.RPC;
const RPCError = bweb.RPCError;

/*
 * Constants
 */

const errs = {
  // Standard JSON-RPC 2.0 errors
  INVALID_REQUEST: bweb.errors.INVALID_REQUEST,
  METHOD_NOT_FOUND: bweb.errors.METHOD_NOT_FOUND,
  INVALID_PARAMS: bweb.errors.INVALID_PARAMS,
  INTERNAL_ERROR: bweb.errors.INTERNAL_ERROR,
  PARSE_ERROR: bweb.errors.PARSE_ERROR,

  // General application defined errors
  MISC_ERROR: -1,
  FORBIDDEN_BY_SAFE_MODE: -2,
  TYPE_ERROR: -3,
  INVALID_ADDRESS_OR_KEY: -5,
  OUT_OF_MEMORY: -7,
  INVALID_PARAMETER: -8,
  DATABASE_ERROR: -20,
  DESERIALIZATION_ERROR: -22,
  VERIFY_ERROR: -25,
  VERIFY_REJECTED: -26,
  VERIFY_ALREADY_IN_CHAIN: -27,
  IN_WARMUP: -28,

  // Wallet errors
  WALLET_ERROR: -4,
  WALLET_INSUFFICIENT_FUNDS: -6,
  WALLET_INVALID_ACCOUNT_NAME: -11,
  WALLET_KEYPOOL_RAN_OUT: -12,
  WALLET_UNLOCK_NEEDED: -13,
  WALLET_PASSPHRASE_INCORRECT: -14,
  WALLET_WRONG_ENC_STATE: -15,
  WALLET_ENCRYPTION_FAILED: -16,
  WALLET_ALREADY_UNLOCKED: -17
};

const MAGIC_STRING = `${pkg.currency} signed message:\n`;

/**
 * Wallet RPC
 * @alias module:wallet.RPC
 * @extends bweb.RPC
 */

class RPC extends RPCBase {
  /**
   * Create an RPC.
   * @param {WalletDB} wdb
   */

  constructor(node) {
    super();

    assert(node, 'RPC requires a WalletDB.');

    this.wdb = node.wdb;
    this.network = node.network;
    this.logger = node.logger.context('rpc');
    this.client = node.client;
    this.locker = new Lock();

    this.wallet = null;

    this.init();
  }

  getCode(err) {
    switch (err.type) {
      case 'RPCError':
        return err.code;
      case 'ValidationError':
        return errs.TYPE_ERROR;
      case 'EncodingError':
        return errs.DESERIALIZATION_ERROR;
      case 'FundingError':
        return errs.WALLET_INSUFFICIENT_FUNDS;
      default:
        return errs.INTERNAL_ERROR;
    }
  }

  init() {
    this.add('help', this.help);
    this.add('stop', this.stop);
    this.add('fundrawtransaction', this.fundRawTransaction);
    this.add('resendwallettransactions', this.resendWalletTransactions);
    this.add('abandontransaction', this.abandonTransaction);
    this.add('backupwallet', this.backupWallet);
    this.add('dumpprivkey', this.dumpPrivKey);
    this.add('dumpwallet', this.dumpWallet);
    this.add('encryptwallet', this.encryptWallet);
    this.add('getaccountaddress', this.getAccountAddress);
    this.add('getaccount', this.getAccount);
    this.add('getaddressesbyaccount', this.getAddressesByAccount);
    this.add('getaddressinfo', this.getAddressInfo);
    this.add('getbalance', this.getBalance);
    this.add('getnewaddress', this.getNewAddress);
    this.add('getrawchangeaddress', this.getRawChangeAddress);
    this.add('getreceivedbyaccount', this.getReceivedByAccount);
    this.add('getreceivedbyaddress', this.getReceivedByAddress);
    this.add('gettransaction', this.getTransaction);
    this.add('getunconfirmedbalance', this.getUnconfirmedBalance);
    this.add('getwalletinfo', this.getWalletInfo);
    this.add('importprivkey', this.importPrivKey);
    this.add('importwallet', this.importWallet);
    this.add('importaddress', this.importAddress);
    this.add('importprunedfunds', this.importPrunedFunds);
    this.add('importpubkey', this.importPubkey);
    this.add('importname', this.importName);
    this.add('keypoolrefill', this.keyPoolRefill);
    this.add('listaccounts', this.listAccounts);
    this.add('listaddressgroupings', this.listAddressGroupings);
    this.add('listlockunspent', this.listLockUnspent);
    this.add('listreceivedbyaccount', this.listReceivedByAccount);
    this.add('listreceivedbyaddress', this.listReceivedByAddress);
    this.add('listsinceblock', this.listSinceBlock);
    this.add('listtransactions', this.listTransactions);
    this.add('listunspent', this.listUnspent);
    this.add('lockunspent', this.lockUnspent);
    this.add('sendfrom', this.sendFrom);
    this.add('sendmany', this.sendMany);
    this.add('sendtoaddress', this.sendToAddress);
    this.add('createsendtoaddress', this.createSendToAddress);
    this.add('setaccount', this.setAccount);
    this.add('settxfee', this.setTXFee);
    this.add('signmessage', this.signMessage);
    this.add('walletlock', this.walletLock);
    this.add('walletpassphrasechange', this.walletPassphraseChange);
    this.add('walletpassphrase', this.walletPassphrase);
    this.add('removeprunedfunds', this.removePrunedFunds);
    this.add('selectwallet', this.selectWallet);
    this.add('getmemoryinfo', this.getMemoryInfo);
    this.add('setloglevel', this.setLogLevel);
    this.add('getbids', this.getBids);
    this.add('getreveals', this.getReveals);
    this.add('getnames', this.getNames);
    this.add('getauctioninfo', this.getAuctionInfo);
    this.add('getnameinfo', this.getNameInfo);
    this.add('getnameresource', this.getNameResource);
    this.add('getnamebyhash', this.getNameByHash);
    this.add('createclaim', this.createClaim);
    this.add('sendfakeclaim', this.sendFakeClaim);
    this.add('sendclaim', this.sendClaim);
    this.add('sendopen', this.sendOpen);
    this.add('sendbid', this.sendBid);
    this.add('sendreveal', this.sendReveal);
    this.add('sendredeem', this.sendRedeem);
    this.add('sendupdate', this.sendUpdate);
    this.add('sendrenewal', this.sendRenewal);
    this.add('sendtransfer', this.sendTransfer);
    this.add('sendcancel', this.sendCancel);
    this.add('sendfinalize', this.sendFinalize);
    this.add('sendrevoke', this.sendRevoke);
    this.add('importnonce', this.importNonce);
    this.add('createopen', this.createOpen);
    this.add('createbid', this.createBid);
    this.add('createreveal', this.createReveal);
    this.add('createredeem', this.createRedeem);
    this.add('createupdate', this.createUpdate);
    this.add('createrenewal', this.createRenewal);
    this.add('createtransfer', this.createTransfer);
    this.add('createcancel', this.createCancel);
    this.add('createfinalize', this.createFinalize);
    this.add('createrevoke', this.createRevoke);

    // Compat
    this.add('getauctions', this.getNames);
    // this.add('getauctioninfo', this.getAuctionInfo);
    // this.add('getnameinfo', this.getNameInfo);
    // this.add('getnameresource', this.getNameResource);
  }

  async help(args, _help) {
    if (args.length === 0)
      return 'Select a command.';

    const json = {
      method: args[0],
      params: []
    };

    return await this.execute(json, true);
  }

  async stop(args, help) {
    if (help || args.length !== 0)
      throw new RPCError(errs.MISC_ERROR, 'stop');

    this.wdb.close();

    return 'Stopping.';
  }

  async fundRawTransaction(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'fundrawtransaction "hexstring" ( options )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const data = valid.buf(0);
    const options = valid.obj(1);

    if (!data)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid hex string.');

    const tx = MTX.decode(data);

    if (tx.outputs.length === 0) {
      throw new RPCError(errs.INVALID_PARAMETER,
        'TX must have at least one output.');
    }

    let rate = null;
    let change = null;

    if (options) {
      const valid = new Validator(options);

      rate = valid.ufixed('feeRate', EXP);
      change = valid.str('changeAddress');

      if (change)
        change = parseAddress(change, this.network);
    }

    await wallet.fund(tx, {
      rate: rate,
      changeAddress: change
    });

    return {
      hex: tx.toHex(),
      changepos: tx.changeIndex,
      fee: Amount.coin(tx.getFee(), true)
    };
  }

  /*
   * Wallet
   */

  async resendWalletTransactions(args, help) {
    if (help || args.length !== 0)
      throw new RPCError(errs.MISC_ERROR, 'resendwallettransactions');

    const wallet = this.wallet;
    const txs = await wallet.resend();
    const hashes = [];

    for (const tx of txs)
      hashes.push(tx.txid());

    return hashes;
  }

  async backupWallet(args, help) {
    const valid = new Validator(args);
    const dest = valid.str(0);

    if (help || args.length !== 1 || !dest)
      throw new RPCError(errs.MISC_ERROR, 'backupwallet "destination"');

    await this.wdb.backup(dest);

    return null;
  }

  async dumpPrivKey(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'dumpprivkey "address"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const addr = valid.str(0, '');

    const hash = parseHash(addr, this.network);
    const ring = await wallet.getPrivateKey(hash);

    if (!ring)
      throw new RPCError(errs.MISC_ERROR, 'Key not found.');

    return ring.toSecret(this.network);
  }

  async dumpWallet(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'dumpwallet "filename"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const file = valid.str(0);

    if (!file)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    const tip = await this.wdb.getTip();
    const time = util.date();

    const out = [
      format(`# Wallet Dump created by ${pkg.name} %s`, pkg.version),
      format('# * Created on %s', time),
      format('# * Best block at time of backup was %d (%s).',
        tip.height, tip.hash.toString('hex')),
      format('# * File: %s', file),
      ''
    ];

    const hashes = await wallet.getAddressHashes();

    for (const hash of hashes) {
      const ring = await wallet.getPrivateKey(hash);

      if (!ring)
        continue;

      const addr = ring.getAddress().toString(this.network);

      let fmt = '%s %s label= addr=%s';

      if (ring.branch === 1)
        fmt = '%s %s change=1 addr=%s';

      const str = format(fmt, ring.toSecret(this.network), time, addr);

      out.push(str);
    }

    out.push('');
    out.push('# End of dump');
    out.push('');

    const dump = out.join('\n');

    if (fs.unsupported)
      return dump;

    await fs.writeFile(file, dump, 'utf8');

    return null;
  }

  async encryptWallet(args, help) {
    const wallet = this.wallet;

    if (!wallet.master.encrypted && (help || args.length !== 1))
      throw new RPCError(errs.MISC_ERROR, 'encryptwallet "passphrase"');

    const valid = new Validator(args);
    const passphrase = valid.str(0, '');

    if (wallet.master.encrypted) {
      throw new RPCError(errs.WALLET_WRONG_ENC_STATE,
        'Already running with an encrypted wallet.');
    }

    if (passphrase.length < 1)
      throw new RPCError(errs.MISC_ERROR, 'encryptwallet "passphrase"');

    try {
      await wallet.encrypt(passphrase);
    } catch (e) {
      throw new RPCError(errs.WALLET_ENCRYPTION_FAILED, 'Encryption failed.');
    }

    return 'wallet encrypted; we do not need to stop!';
  }

  async getAccountAddress(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getaccountaddress "account"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0, '');

    if (name === '')
      name = 'default';

    const addr = await wallet.receiveAddress(name);

    if (!addr)
      return '';

    return addr.toString(this.network);
  }

  async getAccount(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getaccount "address"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const addr = valid.str(0, '');

    const hash = parseHash(addr, this.network);
    const path = await wallet.getPath(hash);

    if (!path)
      return '';

    return path.name;
  }

  async getAddressesByAccount(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getaddressesbyaccount "account"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0, '');
    const addrs = [];

    if (name === '')
      name = 'default';

    const paths = await wallet.getPaths(name);

    for (const path of paths) {
      const addr = path.toAddress();
      addrs.push(addr.toString(this.network));
    }

    return addrs;
  }

  async getAddressInfo(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getaddressinfo "address"');

    const valid = new Validator(args);
    const addr = valid.str(0, '');
    const address = parseAddress(addr, this.network);

    const wallet = this.wallet.toJSON();
    const path = await this.wallet.getPath(address);

    return {
      address: address.toString(this.network),
      ismine: path != null,
      iswatchonly: wallet.watchOnly,
      ischange: path ? path.branch === 1 : false,
      isspendable: !address.isUnspendable(),
      isscript: address.isScripthash(),
      witness_version: address.version,
      witness_program: address.hash.toString('hex')
    };
  }

  async getBalance(args, help) {
    if (help || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'getbalance ( "account" minconf includeWatchonly )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0);
    const minconf = valid.u32(1, 1);
    const watchOnly = valid.bool(2, false);

    if (name === '')
      name = 'default';

    if (name === '*')
      name = null;

    if (wallet.watchOnly !== watchOnly)
      return 0;

    const balance = await wallet.getBalance(name);

    let value;
    if (minconf > 0)
      value = balance.confirmed;
    else
      value = balance.unconfirmed;

    return Amount.coin(value, true);
  }

  async getNewAddress(args, help) {
    if (help || args.length > 1)
      throw new RPCError(errs.MISC_ERROR, 'getnewaddress ( "account" )');

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0, '');

    if (name === '')
      name = 'default';

    const addr = await wallet.createReceive(name);

    return addr.getAddress().toString(this.network);
  }

  async getRawChangeAddress(args, help) {
    if (help || args.length > 1)
      throw new RPCError(errs.MISC_ERROR, 'getrawchangeaddress');

    const wallet = this.wallet;
    const addr = await wallet.createChange();

    return addr.getAddress().toString(this.network);
  }

  async getReceivedByAccount(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'getreceivedbyaccount "account" ( minconf )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0, '');
    const minconf = valid.u32(1, 0);
    const height = this.wdb.state.height;

    if (name === '')
      name = 'default';

    const paths = await wallet.getPaths(name);
    const filter = new BufferSet();

    for (const path of paths)
      filter.add(path.hash);

    const txs = await wallet.getHistory(name);

    let total = 0;
    let lastConf = -1;

    for (const wtx of txs) {
      const conf = wtx.getDepth(height);

      if (conf < minconf)
        continue;

      if (lastConf === -1 || conf < lastConf)
        lastConf = conf;

      for (const output of wtx.tx.outputs) {
        const hash = output.getHash();
        if (hash && filter.has(hash))
          total += output.value;
      }
    }

    return Amount.coin(total, true);
  }

  async getReceivedByAddress(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'getreceivedbyaddress "address" ( minconf )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const addr = valid.str(0, '');
    const minconf = valid.u32(1, 0);
    const height = this.wdb.state.height;

    const hash = parseHash(addr, this.network);
    const txs = await wallet.getHistory();

    let total = 0;

    for (const wtx of txs) {
      if (wtx.getDepth(height) < minconf)
        continue;

      for (const output of wtx.tx.outputs) {
        if (output.getHash().equals(hash))
          total += output.value;
      }
    }

    return Amount.coin(total, true);
  }

  async _toWalletTX(wtx) {
    const wallet = this.wallet;
    const details = await wallet.toDetails(wtx);

    if (!details)
      throw new RPCError(errs.WALLET_ERROR, 'TX not found.');

    let receive = true;
    for (const member of details.inputs) {
      if (member.path) {
        receive = false;
        break;
      }
    }

    const det = [];
    let sent = 0;
    let received = 0;

    for (let i = 0; i < details.outputs.length; i++) {
      const member = details.outputs[i];

      if (member.path) {
        if (member.path.branch === 1)
          continue;

        det.push({
          account: member.path.name,
          address: member.address.toString(this.network),
          category: 'receive',
          amount: Amount.coin(member.value, true),
          label: member.path.name,
          vout: i
        });

        received += member.value;

        continue;
      }

      if (receive)
        continue;

      det.push({
        account: '',
        address: member.address
          ? member.address.toString(this.network)
          : null,
        category: 'send',
        amount: -(Amount.coin(member.value, true)),
        fee: -(Amount.coin(details.fee, true)),
        vout: i
      });

      sent += member.value;
    }

    return {
      amount: Amount.coin(receive ? received : -sent, true),
      confirmations: details.confirmations,
      blockhash: details.block ? details.block.toString('hex') : null,
      blockindex: details.index,
      blocktime: details.time,
      txid: details.hash.toString('hex'),
      walletconflicts: [],
      time: details.mtime,
      timereceived: details.mtime,
      'bip125-replaceable': 'no',
      details: det,
      hex: details.tx.toHex()
    };
  }

  async getTransaction(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'gettransaction "txid" ( includeWatchonly )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const hash = valid.bhash(0);
    const watchOnly = valid.bool(1, false);

    if (!hash)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter');

    const wtx = await wallet.getTX(hash);

    if (!wtx)
      throw new RPCError(errs.WALLET_ERROR, 'TX not found.');

    return await this._toWalletTX(wtx, watchOnly);
  }

  async abandonTransaction(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'abandontransaction "txid"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const hash = valid.bhash(0);

    if (!hash)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    const result = await wallet.abandon(hash);

    if (!result)
      throw new RPCError(errs.WALLET_ERROR, 'Transaction not in wallet.');

    return null;
  }

  async getUnconfirmedBalance(args, help) {
    if (help || args.length > 0)
      throw new RPCError(errs.MISC_ERROR, 'getunconfirmedbalance');

    const wallet = this.wallet;
    const balance = await wallet.getBalance();

    return Amount.coin(balance.unconfirmed, true);
  }

  async getWalletInfo(args, help) {
    if (help || args.length !== 0)
      throw new RPCError(errs.MISC_ERROR, 'getwalletinfo');

    const wallet = this.wallet;
    const balance = await wallet.getBalance();

    return {
      walletid: wallet.id,
      walletversion: 6,
      balance: Amount.coin(balance.unconfirmed, true),
      unconfirmed_balance: Amount.coin(balance.unconfirmed, true),
      txcount: balance.tx,
      keypoololdest: 0,
      keypoolsize: 0,
      unlocked_until: wallet.master.until,
      paytxfee: Amount.coin(this.wdb.feeRate, true),
      height: this.wdb.height
    };
  }

  async importPrivKey(args, help) {
    if (help || args.length < 1 || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'importprivkey "privkey" ( "label" rescan )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const secret = valid.str(0);
    const rescan = valid.bool(2, false);

    const key = parseSecret(secret, this.network);

    await wallet.importKey(0, key);

    if (rescan)
      await this.wdb.rescan(0);

    return null;
  }

  async importWallet(args, help) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, 'importwallet "filename" ( rescan )');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const file = valid.str(0);
    const rescan = valid.bool(1, false);

    if (fs.unsupported)
      throw new RPCError(errs.INTERNAL_ERROR, 'FS not available.');

    let data;
    try {
      data = await fs.readFile(file, 'utf8');
    } catch (e) {
      throw new RPCError(errs.INTERNAL_ERROR, e.code || '');
    }

    const lines = data.split(/\n+/);
    const keys = [];

    for (let line of lines) {
      line = line.trim();

      if (line.length === 0)
        continue;

      if (/^\s*#/.test(line))
        continue;

      const parts = line.split(/\s+/);

      if (parts.length < 4)
        throw new RPCError(errs.DESERIALIZATION_ERROR, 'Malformed wallet.');

      const secret = parseSecret(parts[0], this.network);

      keys.push(secret);
    }

    for (const key of keys)
      await wallet.importKey(0, key);

    if (rescan)
      await this.wdb.rescan(0);

    return null;
  }

  async importAddress(args, help) {
    if (help || args.length < 1 || args.length > 4) {
      throw new RPCError(errs.MISC_ERROR,
        'importaddress "address" ( "label" rescan p2sh )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    let addr = valid.str(0, '');
    const rescan = valid.bool(2, false);
    const p2sh = valid.bool(3, false);

    if (p2sh) {
      let script = valid.buf(0);

      if (!script)
        throw new RPCError(errs.TYPE_ERROR, 'Invalid parameters.');

      script = Script.decode(script);

      addr = Address.fromScripthash(script.sha3());
    } else {
      addr = parseAddress(addr, this.network);
    }

    await wallet.importAddress(0, addr);

    if (rescan)
      await this.wdb.rescan(0);

    return null;
  }

  async importPubkey(args, help) {
    if (help || args.length < 1 || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'importpubkey "pubkey" ( "label" rescan )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const data = valid.buf(0);
    const rescan = valid.bool(2, false);

    if (!data)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    const key = KeyRing.fromPublic(data, this.network);

    await wallet.importKey(0, key);

    if (rescan)
      await this.wdb.rescan(0);

    return null;
  }

  async importName(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'importname "name" ( height )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);
    const height = valid.u32(1);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    await wallet.importName(name);

    if (height != null)
      await this.wdb.rescan(height);

    return null;
  }

  async keyPoolRefill(args, help) {
    if (help || args.length > 1)
      throw new RPCError(errs.MISC_ERROR, 'keypoolrefill ( newsize )');
    return null;
  }

  async listAccounts(args, help) {
    if (help || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'listaccounts ( minconf includeWatchonly)');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const minconf = valid.u32(0, 0);
    const watchOnly = valid.bool(1, false);

    const accounts = await wallet.getAccounts();
    const map = Object.create(null);

    for (const account of accounts) {
      const balance = await wallet.getBalance(account);
      let value = balance.unconfirmed;

      if (minconf > 0)
        value = balance.confirmed;

      if (wallet.watchOnly !== watchOnly)
        value = 0;

      map[account] = Amount.coin(value, true);
    }

    return map;
  }

  async listAddressGroupings(args, help) {
    if (help)
      throw new RPCError(errs.MISC_ERROR, 'listaddressgroupings');
    throw new Error('Not implemented.');
  }

  async listLockUnspent(args, help) {
    if (help || args.length > 0)
      throw new RPCError(errs.MISC_ERROR, 'listlockunspent');

    const wallet = this.wallet;
    const outpoints = wallet.getLocked();
    const out = [];

    for (const outpoint of outpoints) {
      out.push({
        txid: outpoint.txid(),
        vout: outpoint.index
      });
    }

    return out;
  }

  async listReceivedByAccount(args, help) {
    if (help || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'listreceivedbyaccount ( minconf includeempty includeWatchonly )');
    }

    const valid = new Validator(args);
    const minconf = valid.u32(0, 0);
    const includeEmpty = valid.bool(1, false);
    const watchOnly = valid.bool(2, false);

    return await this._listReceived(minconf, includeEmpty, watchOnly, true);
  }

  async listReceivedByAddress(args, help) {
    if (help || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'listreceivedbyaddress ( minconf includeempty includeWatchonly )');
    }

    const valid = new Validator(args);
    const minconf = valid.u32(0, 0);
    const includeEmpty = valid.bool(1, false);
    const watchOnly = valid.bool(2, false);

    return await this._listReceived(minconf, includeEmpty, watchOnly, false);
  }

  async _listReceived(minconf, empty, watchOnly, account) {
    const wallet = this.wallet;
    const paths = await wallet.getPaths();
    const height = this.wdb.state.height;

    const map = new BufferMap();

    for (const path of paths) {
      const addr = path.toAddress();
      map.set(path.hash, {
        involvesWatchonly: wallet.watchOnly,
        address: addr.toString(this.network),
        account: path.name,
        amount: 0,
        confirmations: -1,
        label: ''
      });
    }

    const txs = await wallet.getHistory();

    for (const wtx of txs) {
      const conf = wtx.getDepth(height);

      if (conf < minconf)
        continue;

      for (const output of wtx.tx.outputs) {
        const addr = output.getAddress();

        if (!addr)
          continue;

        const hash = addr.getHash();
        const entry = map.get(hash);

        if (entry) {
          if (entry.confirmations === -1 || conf < entry.confirmations)
            entry.confirmations = conf;
          entry.address = addr.toString(this.network);
          entry.amount += output.value;
        }
      }
    }

    let out = [];
    for (const entry of map.values())
      out.push(entry);

    if (account) {
      const map = new Map();

      for (const entry of out) {
        const item = map.get(entry.account);
        if (!item) {
          map.set(entry.account, entry);
          entry.address = undefined;
          continue;
        }
        item.amount += entry.amount;
      }

      out = [];

      for (const entry of map.values())
        out.push(entry);
    }

    const result = [];
    for (const entry of out) {
      if (!empty && entry.amount === 0)
        continue;

      if (entry.confirmations === -1)
        entry.confirmations = 0;

      entry.amount = Amount.coin(entry.amount, true);
      result.push(entry);
    }

    return result;
  }

  async listSinceBlock(args, help) {
    if (help || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'listsinceblock ( "blockhash" target-confirmations includeWatchonly)');
    }

    const wallet = this.wallet;
    const chainHeight = this.wdb.state.height;
    const valid = new Validator(args);
    const block = valid.bhash(0);
    const minconf = valid.u32(1, 0);
    const watchOnly = valid.bool(2, false);

    if (wallet.watchOnly !== watchOnly)
      return [];

    let height = -1;

    if (block) {
      const entry = await this.client.getEntry(block);

      if (!entry)
        throw new RPCError(errs.MISC_ERROR, 'Block not found');

      height = entry.height;
    }

    if (height === -1)
      height = chainHeight;

    const txs = await wallet.getHistory();
    const out = [];

    let highest = null;

    for (const wtx of txs) {
      if (wtx.height < height)
        continue;

      if (wtx.getDepth(chainHeight) < minconf)
        continue;

      if (!highest || wtx.height > highest)
        highest = wtx;

      const json = await this._toListTX(wtx);

      out.push(json);
    }

    return {
      transactions: out,
      lastblock: highest && highest.block
        ? highest.block.toString('hex')
        : consensus.ZERO_HASH.toString('hex')
    };
  }

  async _toListTX(wtx) {
    const wallet = this.wallet;
    const details = await wallet.toDetails(wtx);

    if (!details)
      throw new RPCError(errs.WALLET_ERROR, 'TX not found.');

    let receive = true;
    for (const member of details.inputs) {
      if (member.path) {
        receive = false;
        break;
      }
    }

    let sent = 0;
    let received = 0;
    let sendMember = null;
    let recMember = null;
    let sendIndex = -1;
    let recIndex = -1;

    for (let i = 0; i < details.outputs.length; i++) {
      const member = details.outputs[i];

      if (member.path) {
        if (member.path.branch === 1)
          continue;
        received += member.value;
        recMember = member;
        recIndex = i;
        continue;
      }

      sent += member.value;
      sendMember = member;
      sendIndex = i;
    }

    let member = null;
    let index = -1;

    if (receive) {
      assert(recMember);
      member = recMember;
      index = recIndex;
    } else {
      if (sendMember) {
        member = sendMember;
        index = sendIndex;
      } else {
        // In the odd case where we send to ourselves.
        receive = true;
        received = 0;
        member = recMember;
        index = recIndex;
      }
    }

    return {
      account: member.path ? member.path.name : '',
      address: member.address
        ? member.address.toString(this.network)
        : null,
      category: receive ? 'receive' : 'send',
      amount: Amount.coin(receive ? received : -sent, true),
      label: member.path ? member.path.name : undefined,
      vout: index,
      confirmations: details.getDepth(this.wdb.height),
      blockhash: details.block ? details.block.toString('hex') : null,
      blockindex: -1,
      blocktime: details.time,
      blockheight: details.height,
      txid: details.hash.toString('hex'),
      walletconflicts: [],
      time: details.mtime,
      timereceived: details.mtime
    };
  }

  async listTransactions(args, help) {
    if (help || args.length > 4) {
      throw new RPCError(errs.MISC_ERROR,
        'listtransactions ( "account" count from includeWatchonly)');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0);
    const count = valid.u32(1, 10);
    const from = valid.u32(2, 0);
    const watchOnly = valid.bool(3, false);

    if (wallet.watchOnly !== watchOnly)
      return [];

    if (name === '')
      name = 'default';

    if (name === '*')
      name = null;

    const txs = await wallet.getHistory(name);

    common.sortTX(txs);

    const end = from + count;
    const to = Math.min(end, txs.length);
    const out = [];

    for (let i = from; i < to; i++) {
      const wtx = txs[i];
      const json = await this._toListTX(wtx);
      out.push(json);
    }

    return out;
  }

  async listUnspent(args, help) {
    if (help || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'listunspent ( minconf maxconf  ["address",...] )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const minDepth = valid.u32(0, 1);
    const maxDepth = valid.u32(1, 9999999);
    const addrs = valid.array(2);
    const height = this.wdb.state.height;

    const map = new BufferSet();

    if (addrs) {
      const valid = new Validator(addrs);
      for (let i = 0; i < addrs.length; i++) {
        const addr = valid.str(i, '');
        const hash = parseHash(addr, this.network);

        if (map.has(hash))
          throw new RPCError(errs.INVALID_PARAMETER, 'Duplicate address.');

        map.add(hash);
      }
    }

    const coins = await wallet.getCoins();

    common.sortCoins(coins);

    const out = [];

    for (const coin of coins) {
      const depth = coin.getDepth(height);

      if (depth < minDepth || depth > maxDepth)
        continue;

      const hash = coin.getHash();

      if (addrs) {
        if (!hash || !map.has(hash))
          continue;
      }

      const ring = await wallet.getKey(hash);

      out.push({
        txid: coin.txid(),
        vout: coin.index,
        address: coin.address.toString(this.network),
        account: ring ? ring.name : undefined,
        redeemScript: ring && ring.script
          ? ring.script.toJSON()
          : undefined,
        amount: Amount.coin(coin.value, true),
        confirmations: depth,
        spendable: !wallet.isLocked(coin),
        solvable: true
      });
    }

    return out;
  }

  async lockUnspent(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'lockunspent unlock ([{"txid":"txid","vout":n},...])');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const unlock = valid.bool(0, false);
    const outputs = valid.array(1);

    if (args.length === 1) {
      if (unlock)
        wallet.unlockCoins();
      return true;
    }

    if (!outputs)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    for (const output of outputs) {
      const valid = new Validator(output);
      const hash = valid.bhash('txid');
      const index = valid.u32('vout');

      if (hash == null || index == null)
        throw new RPCError(errs.INVALID_PARAMETER, 'Invalid parameter.');

      const outpoint = new Outpoint(hash, index);

      if (unlock) {
        wallet.unlockCoin(outpoint);
        continue;
      }

      wallet.lockCoin(outpoint);
    }

    return true;
  }

  async sendFrom(args, help) {
    if (help || args.length < 3 || args.length > 6) {
      throw new RPCError(errs.MISC_ERROR,
        'sendfrom "fromaccount" "toaddress"'
        + ' amount ( minconf "comment" "comment-to" )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0, '');
    const str = valid.str(1);
    const value = valid.ufixed(2, EXP);
    const minconf = valid.u32(3, 0);

    const addr = parseAddress(str, this.network);

    if (!addr || value == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    if (name === '')
      name = 'default';

    const options = {
      account: name,
      depth: minconf,
      outputs: [{
        address: addr,
        value: value
      }]
    };

    const tx = await wallet.send(options);

    return tx.txid();
  }

  async sendMany(args, help) {
    if (help || args.length < 2 || args.length > 5) {
      throw new RPCError(errs.MISC_ERROR,
        'sendmany "fromaccount" {"address":amount,...}'
        + ' ( minconf "comment" ["address",...] )');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    let name = valid.str(0, '');
    const sendTo = valid.obj(1);
    const minconf = valid.u32(2, 1);
    const subtract = valid.bool(4, false);

    if (name === '')
      name = 'default';

    if (!sendTo)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    const to = new Validator(sendTo);
    const uniq = new BufferSet();
    const outputs = [];

    for (const key of Object.keys(sendTo)) {
      const value = to.ufixed(key, EXP);
      const addr = parseAddress(key, this.network);
      const hash = addr.getHash();

      if (value == null)
        throw new RPCError(errs.INVALID_PARAMETER, 'Invalid parameter.');

      if (uniq.has(hash))
        throw new RPCError(errs.INVALID_PARAMETER, 'Invalid parameter.');

      uniq.add(hash);

      const output = new Output();
      output.value = value;
      output.address = addr;
      outputs.push(output);
    }

    const options = {
      outputs: outputs,
      subtractFee: subtract,
      account: name,
      depth: minconf
    };

    const tx = await wallet.send(options);

    return tx.txid();
  }

  async sendToAddress(args, help) {
    const opts = this._validateSendToAddress(args, help, 'sendtoaddress');
    const wallet = this.wallet;

    const options = {
      account: opts.account,
      subtractFee: opts.subtract,
      outputs: [{
        address: opts.addr,
        value: opts.value
      }]
    };

    const tx = await wallet.send(options);

    return tx.txid();
  }

  async createSendToAddress(args, help) {
    const opts = this._validateSendToAddress(args, help, 'createsendtoaddress');
    const wallet = this.wallet;

    const options = {
      paths: true,
      account: opts.account,
      subtractFee: opts.subtract,
      outputs: [{
        address: opts.addr,
        value: opts.value
      }]
    };

    const mtx = await wallet.createTX(options);

    return mtx.getJSON(this.network);
  }

  _validateSendToAddress(args, help, method) {
    const msg = `${method} "address" amount `
      + '( "comment" "comment-to" subtractfeefromamount "account" )';

    if (help || args.length < 2 || args.length > 6)
      throw new RPCError(errs.MISC_ERROR, msg);

    const valid = new Validator(args);
    const str = valid.str(0);
    const value = valid.ufixed(1, EXP);
    const subtract = valid.bool(4, false);
    const account = valid.str(5);

    const addr = parseAddress(str, this.network);

    if (!addr || value == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    return {
      subtract,
      addr,
      value,
      account
    };
  }

  async setAccount(args, help) {
    if (help || args.length < 1 || args.length > 2) {
      throw new RPCError(errs.MISC_ERROR,
        'setaccount "address" "account"');
    }

    // Impossible to implement:
    throw new Error('Not implemented.');
  }

  async setTXFee(args, help) {
    const valid = new Validator(args);
    const rate = valid.ufixed(0, EXP);

    if (help || args.length < 1 || args.length > 1)
      throw new RPCError(errs.MISC_ERROR, 'settxfee amount');

    if (rate == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    this.wdb.feeRate = rate;

    return true;
  }

  async signMessage(args, help) {
    if (help || args.length !== 2) {
      throw new RPCError(errs.MISC_ERROR,
        'signmessage "address" "message"');
    }

    const wallet = this.wallet;
    const valid = new Validator(args);
    const b58 = valid.str(0, '');
    const str = valid.str(1, '');

    const addr = parseHash(b58, this.network);

    const ring = await wallet.getKey(addr);

    if (!ring)
      throw new RPCError(errs.WALLET_ERROR, 'Address not found.');

    if (!wallet.master.key)
      throw new RPCError(errs.WALLET_UNLOCK_NEEDED, 'Wallet is locked.');

    const msg = Buffer.from(MAGIC_STRING + str, 'utf8');
    const hash = blake2b.digest(msg);

    const sig = ring.sign(hash);

    return sig.toString('base64');
  }

  async walletLock(args, help) {
    const wallet = this.wallet;

    if (help || (wallet.master.encrypted && args.length !== 0))
      throw new RPCError(errs.MISC_ERROR, 'walletlock');

    if (!wallet.master.encrypted) {
      throw new RPCError(
        errs.WALLET_WRONG_ENC_STATE,
        'Wallet is not encrypted.');
    }

    await wallet.lock();

    return null;
  }

  async walletPassphraseChange(args, help) {
    const wallet = this.wallet;

    if (help || (wallet.master.encrypted && args.length !== 2)) {
      throw new RPCError(errs.MISC_ERROR, 'walletpassphrasechange'
        + ' "oldpassphrase" "newpassphrase"');
    }

    const valid = new Validator(args);
    const old = valid.str(0, '');
    const passphrase = valid.str(1, '');

    if (!wallet.master.encrypted) {
      throw new RPCError(
        errs.WALLET_WRONG_ENC_STATE,
        'Wallet is not encrypted.');
    }

    if (old.length < 1 || passphrase.length < 1)
      throw new RPCError(errs.INVALID_PARAMETER, 'Invalid parameter');

    await wallet.setPassphrase(passphrase, old);

    return null;
  }

  async walletPassphrase(args, help) {
    const wallet = this.wallet;
    const valid = new Validator(args);
    const passphrase = valid.str(0, '');
    const timeout = valid.u32(1);

    if (help || (wallet.master.encrypted && args.length !== 2)) {
      throw new RPCError(errs.MISC_ERROR,
        'walletpassphrase "passphrase" timeout');
    }

    if (!wallet.master.encrypted) {
      throw new RPCError(
        errs.WALLET_WRONG_ENC_STATE,
        'Wallet is not encrypted.');
    }

    if (passphrase.length < 1)
      throw new RPCError(errs.INVALID_PARAMETER, 'Invalid parameter');

    if (timeout == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter');

    await wallet.unlock(passphrase, timeout);

    return null;
  }

  async importPrunedFunds(args, help) {
    if (help || args.length < 2 || args.length > 3) {
      throw new RPCError(errs.MISC_ERROR,
        'importprunedfunds "rawtransaction" "txoutproof" ( "label" )');
    }

    const valid = new Validator(args);
    const txRaw = valid.buf(0);
    const blockRaw = valid.buf(1);

    if (!txRaw || !blockRaw)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    const tx = TX.decode(txRaw);
    const block = MerkleBlock.decode(blockRaw);
    const hash = block.hash();

    if (!block.verify())
      throw new RPCError(errs.VERIFY_ERROR, 'Invalid proof.');

    if (!block.hasTX(tx.hash()))
      throw new RPCError(errs.VERIFY_ERROR, 'Invalid proof.');

    const height = await this.client.getEntry(hash);

    if (height === -1)
      throw new RPCError(errs.VERIFY_ERROR, 'Invalid proof.');

    const entry = {
      hash: hash,
      time: block.time,
      height: height
    };

    if (!await this.wdb.addTX(tx, entry))
      throw new RPCError(errs.WALLET_ERROR, 'No tracked address for TX.');

    return null;
  }

  async removePrunedFunds(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'removeprunedfunds "txid"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const hash = valid.bhash(0);

    if (!hash)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid parameter.');

    if (!await wallet.remove(hash))
      throw new RPCError(errs.WALLET_ERROR, 'Transaction not in wallet.');

    return null;
  }

  async selectWallet(args, help) {
    const valid = new Validator(args);
    const id = valid.str(0);

    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'selectwallet "id"');

    const wallet = await this.wdb.get(id);

    if (!wallet)
      throw new RPCError(errs.WALLET_ERROR, 'Wallet not found.');

    this.wallet = wallet;

    return null;
  }

  async getMemoryInfo(args, help) {
    if (help || args.length !== 0)
      throw new RPCError(errs.MISC_ERROR, 'getmemoryinfo');

    return this.logger.memoryUsage();
  }

  async setLogLevel(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'setloglevel "level"');

    const valid = new Validator(args);
    const level = valid.str(0, '');

    this.logger.setLevel(level);

    return null;
  }

  async getBids(args, help) {
    if (help || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, 'getbids "name"  ( own )');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);
    let own = valid.bool(1, false);

    if (name && !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (!name)
      own = true;

    const bids = await wallet.getBidsByName(name);
    const items = [];

    for (const bid of bids) {
      if (!own || bid.own)
        items.push(bid.toJSON());
    }

    return items;
  }

  async getReveals(args, help) {
    if (help || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, 'getreveals "name"  ( own )');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);
    let own = valid.bool(1, false);

    if (name && !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (!name)
      own = true;

    const reveals = await wallet.getRevealsByName(name);
    const items = [];

    for (const brv of reveals) {
      if (!own || brv.own)
        items.push(brv.toJSON());
    }

    return items;
  }

  async getNames(args, help) {
    if (help || args.length !== 0)
      throw new RPCError(errs.MISC_ERROR, 'getnames');

    const wallet = this.wallet;
    const height = this.wdb.height;
    const network = this.network;

    const names = await wallet.getNames();
    const items = [];

    for (const ns of names)
      items.push(ns.getJSON(height, network));

    return items;
  }

  async getAuctionInfo(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getauctioninfo "name"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);
    const height = this.wdb.height;
    const network = this.network;

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const ns = await wallet.getNameStateByName(name);

    if (!ns)
      throw new RPCError(errs.MISC_ERROR, 'Auction not found.');

    const bids = await wallet.getBidsByName(name);
    const reveals = await wallet.getRevealsByName(name);

    const info = ns.getJSON(height, network);
    info.bids = [];
    info.reveals = [];

    for (const bid of bids)
      info.bids.push(bid.toJSON());

    for (const reveal of reveals)
      info.reveals.push(reveal.toJSON());

    return info;
  }

  async getNameInfo(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getnameinfo "name"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);
    const height = this.wdb.height;
    const network = this.network;

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const ns = await wallet.getNameStateByName(name);

    if (!ns)
      throw new RPCError(errs.MISC_ERROR, 'Auction not found.');

    return ns.getJSON(height, network);
  }

  async getNameResource(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getnameresource "name"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const ns = await wallet.getNameStateByName(name);

    if (!ns || ns.data.length === 0)
      return null;

    try {
      const res = Resource.decode(ns.data);
      return res.toJSON();
    } catch (e) {
      return {};
    }
  }

  async getNameByHash(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'getnamebyhash "hash"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const hash = valid.bhash(0);

    if (!hash)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name hash.');

    const ns = await wallet.getNameState(hash);

    if (!ns)
      return null;

    return ns.name.toString('binary');
  }

  async createClaim(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'createclaim "name"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const claim = await wallet.createClaim(name);

    return {
      name: claim.name,
      target: claim.target,
      value: claim.value,
      size: claim.size,
      fee: claim.fee,
      address: claim.address.toString(this.network),
      txt: claim.txt
    };
  }

  async sendFakeClaim(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'sendfakeclaim "name"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (this.network.type !== 'regtest')
      throw new RPCError(errs.MISC_ERROR, 'Forged claims are regtest-only.');

    const claim = await wallet.sendFakeClaim(name);

    return claim.getJSON(this.network);
  }

  async sendClaim(args, help) {
    if (help || args.length !== 1)
      throw new RPCError(errs.MISC_ERROR, 'sendclaim "name"');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const claim = await wallet.sendClaim(name);

    return claim.getJSON(this.network);
  }

  async sendOpen(args, help) {
    const opts = this._validateOpen(args, help, 'sendopen');
    const wallet = this.wallet;
    const tx = await wallet.sendOpen(opts.name, opts.force, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createOpen(args, help) {
    const opts = this._validateOpen(args, help, 'createopen');
    const wallet = this.wallet;
    const mtx = await wallet.createOpen(opts.name, opts.force, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateOpen(args, help, method) {
    const msg = `${method} "name" ( force "account" )`;

    if (help || args.length < 1 || args.length > 3)
      throw new RPCError(errs.MISC_ERROR, msg);

    const valid = new Validator(args);
    const name = valid.str(0);
    const force = valid.bool(1, false);
    const account = valid.str(2);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    return {name, force, account};
  }

  async sendBid(args, help) {
    const opts = this._validateBid(args, help, 'sendbid');
    const wallet = this.wallet;
    const tx = await wallet.sendBid(opts.name, opts.bid, opts.value, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createBid(args, help) {
    const opts = this._validateBid(args, help, 'createbid');
    const wallet = this.wallet;
    const mtx = await wallet.createBid(opts.name, opts.bid, opts.value, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateBid(args, help, method) {
    const msg = `${method} "name" bid value ( "account" )`;

    if (help || args.length < 3 || args.length > 4)
      throw new RPCError(errs.MISC_ERROR, msg);

    const valid = new Validator(args);
    const name = valid.str(0);
    const bid = valid.ufixed(1, EXP);
    const value = valid.ufixed(2, EXP);
    const account = valid.str(3);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (bid == null || value == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid values.');

    if (bid > value)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid bid.');

    return {
      name,
      bid,
      value,
      account
    };
  }

  async sendReveal(args, help) {
    const opts = this._validateReveal(args, help, 'sendreveal');
    const wallet = this.wallet;

    if (!opts.name) {
      const tx = await wallet.sendRevealAll();
      return tx.getJSON(this.network);
    }

    if (!rules.verifyName(opts.name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const tx = await wallet.sendReveal(opts.name, { account: opts.account });

    return tx.getJSON(this.network);
  }

  async createReveal(args, help) {
    const opts = this._validateReveal(args, help, 'createreveal');
    const wallet = this.wallet;

    if (!opts.name) {
      const mtx = await wallet.createRevealAll({
        paths: true,
        account: opts.account
      });

      return mtx.getJSON(this.network);
    }

    if (!rules.verifyName(opts.name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const mtx = await wallet.createReveal(opts.name, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateReveal(args, help, method) {
    if (help || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, `${method} "name" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const account = valid.str(1);

    return {name, account};
  }

  async sendRedeem(args, help) {
    const opts = this._validateRedeem(args, help, 'sendredeem');
    const wallet = this.wallet;

    if (!opts.name) {
      const tx = await wallet.sendRedeemAll({ account: opts.account });
      return tx.getJSON(this.network);
    }

    if (!rules.verifyName(opts.name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const tx = await wallet.sendRedeem(opts.name, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createRedeem(args, help) {
    const opts = this._validateRedeem(args, help, 'createredeem');
    const wallet = this.wallet;

    if (!opts.name) {
      const mtx = await wallet.createRedeemAll({
        paths: true,
        account: opts.account
      });
      return mtx.getJSON(this.network);
    }

    if (!rules.verifyName(opts.name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    const mtx = await wallet.createRedeem(opts.name, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateRedeem(args, help, method) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, `${method} "name" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const account = valid.str(1);

    return {name, account};
  }

  async sendUpdate(args, help) {
    const opts = this._validateUpdate(args, help, 'sendupdate');
    const wallet = this.wallet;
    const tx = await wallet.sendUpdate(opts.name, opts.resource, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createUpdate(args, help) {
    const opts = this._validateUpdate(args, help, 'createupdate');
    const wallet = this.wallet;
    const mtx = await wallet.createUpdate(opts.name, opts.resource, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateUpdate(args, help, method) {
    if (help || args.length < 2 || args.length > 3)
      throw new RPCError(errs.MISC_ERROR,
        `${method} "name" "data" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const data = valid.obj(1);
    const account = valid.str(2);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (!data)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid hex string.');

    const resource = Resource.fromJSON(data);

    return {
      name,
      resource,
      account
    };
  }

  async sendRenewal(args, help) {
    const wallet = this.wallet;
    const opts = this._validateRenewal(args, help, 'sendrenewal');
    const tx = await wallet.sendRenewal(opts.name, { account: opts.account });

    return tx.getJSON(this.network);
  }

  async createRenewal(args, help) {
    const wallet = this.wallet;
    const opts = this._validateRenewal(args, help, 'createrenewal');
    const mtx = await wallet.createRenewal(opts.name, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateRenewal(args, help, method) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, `${method} "name" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const account = valid.str(1);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    return {name, account};
  }

  async sendTransfer(args, help) {
    const opts = this._validateTransfer(args, help, 'sendtransfer');
    const wallet = this.wallet;
    const tx = await wallet.sendTransfer(opts.name, opts.address, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createTransfer(args, help) {
    const opts = this._validateTransfer(args, help, 'createtransfer');
    const wallet = this.wallet;
    const tx = await wallet.createTransfer(opts.name, opts.address, {
      paths: true,
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  _validateTransfer(args, help, method) {
    if (help || args.length < 2 || args.length > 3)
      throw new RPCError(errs.MISC_ERROR,
        `${method} "name" "address" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const addr = valid.str(1);
    const account = valid.str(2);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (!addr)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid address.');

    const address = parseAddress(addr, this.network);

    return {
      name,
      address,
      account
    };
  }

  async sendCancel(args, help) {
    const opts = this._validateCancel(args, help, 'sendcancel');
    const wallet = this.wallet;
    const tx = await wallet.sendCancel(opts.name, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createCancel(args, help) {
    const opts = this._validateCancel(args, help, 'createcancel');
    const wallet = this.wallet;
    const mtx = await wallet.createCancel(opts.name, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateCancel(args, help, method) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, `${method} "name" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const account = valid.str(1);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    return {name, account};
  }

  async sendFinalize(args, help) {
    const opts = this._validateFinalize(args, help, 'sendfinalize');
    const wallet = this.wallet;
    const tx = await wallet.sendFinalize(opts.name, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createFinalize(args, help) {
    const opts = this._validateFinalize(args, help, 'createfinalize');
    const wallet = this.wallet;
    const mtx = await wallet.createFinalize(opts.name, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateFinalize(args, help, method) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, `${method} "name" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const account = valid.str(1);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    return {name, account};
  }

  async sendRevoke(args, help) {
    const opts = this._validateRevoke(args, help, 'sendrevoke');
    const wallet = this.wallet;
    const tx = await wallet.sendRevoke(opts.name, {
      account: opts.account
    });

    return tx.getJSON(this.network);
  }

  async createRevoke(args, help) {
    const opts = this._validateRevoke(args, help, 'createrevoke');
    const wallet = this.wallet;
    const mtx = await wallet.createRevoke(opts.name, {
      paths: true,
      account: opts.account
    });

    return mtx.getJSON(this.network);
  }

  _validateRevoke(args, help, method) {
    if (help || args.length < 1 || args.length > 2)
      throw new RPCError(errs.MISC_ERROR, `${method} "name" ( "account" )`);

    const valid = new Validator(args);
    const name = valid.str(0);
    const account = valid.str(1);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    return {name, account};
  }

  async importNonce(args, help) {
    if (help || args.length < 2 || args.length > 3)
      throw new RPCError(errs.MISC_ERROR, 'importnonce "name" "address" bid');

    const wallet = this.wallet;
    const valid = new Validator(args);
    const name = valid.str(0);
    const addr = valid.str(1);
    const value = valid.ufixed(2, EXP);

    if (!name || !rules.verifyName(name))
      throw new RPCError(errs.TYPE_ERROR, 'Invalid name.');

    if (addr == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid value.');

    if (value == null)
      throw new RPCError(errs.TYPE_ERROR, 'Invalid value.');

    const nameHash = rules.hashName(name);
    const address = parseAddress(addr, this.network);

    const blind = await wallet.generateBlind(nameHash, address, value);

    return blind.toString('hex');
  }
}

/*
 * Helpers
 */

function parseHash(raw, network) {
  const addr = parseAddress(raw, network);
  return addr.getHash();
}

function parseAddress(raw, network) {
  try {
    return Address.fromString(raw, network);
  } catch (e) {
    throw new RPCError(errs.INVALID_ADDRESS_OR_KEY, 'Invalid address.');
  }
}

function parseSecret(raw, network) {
  try {
    return KeyRing.fromSecret(raw, network);
  } catch (e) {
    throw new RPCError(errs.INVALID_ADDRESS_OR_KEY, 'Invalid key.');
  }
}

/*
 * Expose
 */

module.exports = RPC;
