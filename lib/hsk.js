/*!
 * hsk.js - a javascript bitcoin library.
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License).
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

/* eslint prefer-arrow-callback: "off" */

'use strict';

/**
 * An hsk "environment" which exposes all
 * constructors for primitives, the blockchain,
 * mempool, wallet, etc. It also exposes a
 * global worker pool.
 *
 * @exports hsk
 * @type {Object}
 */

const hsk = exports;

/**
 * Define a module for lazy loading.
 * @param {String} name
 * @param {String} path
 */

hsk.define = function define(name, path) {
  let cache = null;
  Object.defineProperty(hsk, name, {
    get() {
      if (!cache)
        cache = require(path);
      return cache;
    }
  });
};

/**
 * Set the default network.
 * @param {String} network
 */

hsk.set = function set(network) {
  hsk.Network.set(network);
  return hsk;
};

/*
 * Expose
 */

// Blockchain
hsk.define('blockchain', './blockchain');
hsk.define('Chain', './blockchain/chain');
hsk.define('ChainEntry', './blockchain/chainentry');

// BTC
hsk.define('btc', './btc');
hsk.define('Amount', './btc/amount');
hsk.define('URI', './btc/uri');

// Coins
hsk.define('coins', './coins');
hsk.define('Coins', './coins/coins');
hsk.define('CoinEntry', './coins/coinentry');
hsk.define('CoinView', './coins/coinview');

// HD
hsk.define('hd', './hd');
hsk.define('HDPrivateKey', './hd/private');
hsk.define('HDPublicKey', './hd/public');
hsk.define('Mnemonic', './hd/mnemonic');

// Mempool
hsk.define('mempool', './mempool');
hsk.define('Fees', './mempool/fees');
hsk.define('Mempool', './mempool/mempool');
hsk.define('MempoolEntry', './mempool/mempoolentry');

// Miner
hsk.define('mining', './mining');
hsk.define('Miner', './mining/miner');

// Net
hsk.define('net', './net');
hsk.define('packets', './net/packets');
hsk.define('Peer', './net/peer');
hsk.define('Pool', './net/pool');

// Node
hsk.define('node', './node');
hsk.define('Node', './node/node');
hsk.define('FullNode', './node/fullnode');
hsk.define('SPVNode', './node/spvnode');

// Primitives
hsk.define('primitives', './primitives');
hsk.define('Address', './primitives/address');
hsk.define('Block', './primitives/block');
hsk.define('Coin', './primitives/coin');
hsk.define('Headers', './primitives/headers');
hsk.define('Input', './primitives/input');
hsk.define('InvItem', './primitives/invitem');
hsk.define('KeyRing', './primitives/keyring');
hsk.define('MerkleBlock', './primitives/merkleblock');
hsk.define('MTX', './primitives/mtx');
hsk.define('Outpoint', './primitives/outpoint');
hsk.define('Output', './primitives/output');
hsk.define('TX', './primitives/tx');

// Protocol
hsk.define('protocol', './protocol');
hsk.define('consensus', './protocol/consensus');
hsk.define('Network', './protocol/network');
hsk.define('networks', './protocol/networks');
hsk.define('policy', './protocol/policy');

// Script
hsk.define('script', './script');
hsk.define('Opcode', './script/opcode');
hsk.define('Program', './script/program');
hsk.define('Script', './script/script');
hsk.define('ScriptNum', './script/scriptnum');
hsk.define('SigCache', './script/sigcache');
hsk.define('Stack', './script/stack');
hsk.define('Witness', './script/witness');

// Utils
hsk.define('utils', './utils');
hsk.define('util', './utils/util');

// Wallet
hsk.define('wallet', './wallet');
hsk.define('Path', './wallet/path');
hsk.define('WalletKey', './wallet/walletkey');
hsk.define('WalletDB', './wallet/walletdb');

// Workers
hsk.define('workers', './workers');
hsk.define('WorkerPool', './workers/workerpool');

// Package Info
hsk.define('pkg', './pkg');
