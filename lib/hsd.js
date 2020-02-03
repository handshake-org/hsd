/*!
 * hsd.js - a javascript handshake library.
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint prefer-arrow-callback: "off" */

'use strict';

/**
 * An hsd "environment" which exposes all
 * constructors for primitives, the blockchain,
 * mempool, wallet, etc. It also exposes a
 * global worker pool.
 *
 * @exports hsd
 * @type {Object}
 */

const hsd = exports;

/**
 * Define a module for lazy loading.
 * @param {String} name
 * @param {String} path
 */

hsd.define = function define(name, path) {
  let cache = null;
  Object.defineProperty(hsd, name, {
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

hsd.set = function set(network) {
  hsd.Network.set(network);
  return hsd;
};

/*
 * Expose
 */

// Blockchain
hsd.define('blockchain', './blockchain');
hsd.define('Chain', './blockchain/chain');
hsd.define('ChainEntry', './blockchain/chainentry');

// Coins
hsd.define('coins', './coins');
hsd.define('Coins', './coins/coins');
hsd.define('CoinEntry', './coins/coinentry');
hsd.define('CoinView', './coins/coinview');

// Covenants
hsd.define('covenants', './covenants');
hsd.define('Namestate', './covenants/namestate');
hsd.define('Ownership', './covenants/ownership');
hsd.define('Rules', './covenants/rules');

// DNS
hsd.define('dns', './dns/server');
hsd.define('resource', './dns/resource');

// HD
hsd.define('hd', './hd');
hsd.define('HDPrivateKey', './hd/private');
hsd.define('HDPublicKey', './hd/public');
hsd.define('Mnemonic', './hd/mnemonic');

// Mempool
hsd.define('mempool', './mempool');
hsd.define('Fees', './mempool/fees');
hsd.define('Mempool', './mempool/mempool');
hsd.define('MempoolEntry', './mempool/mempoolentry');

// Miner
hsd.define('mining', './mining');
hsd.define('Miner', './mining/miner');

// Net
hsd.define('net', './net');
hsd.define('packets', './net/packets');
hsd.define('Peer', './net/peer');
hsd.define('Pool', './net/pool');

// Node
hsd.define('node', './node');
hsd.define('Node', './node/node');
hsd.define('FullNode', './node/fullnode');
hsd.define('SPVNode', './node/spvnode');

// Primitives
hsd.define('primitives', './primitives');
hsd.define('Address', './primitives/address');
hsd.define('Block', './primitives/block');
hsd.define('Coin', './primitives/coin');
hsd.define('Covenant', './primitives/covenant');
hsd.define('Headers', './primitives/headers');
hsd.define('Input', './primitives/input');
hsd.define('InvItem', './primitives/invitem');
hsd.define('KeyRing', './primitives/keyring');
hsd.define('MerkleBlock', './primitives/merkleblock');
hsd.define('MTX', './primitives/mtx');
hsd.define('Outpoint', './primitives/outpoint');
hsd.define('Output', './primitives/output');
hsd.define('TX', './primitives/tx');

// Protocol
hsd.define('protocol', './protocol');
hsd.define('consensus', './protocol/consensus');
hsd.define('Network', './protocol/network');
hsd.define('networks', './protocol/networks');
hsd.define('policy', './protocol/policy');

// Script
hsd.define('script', './script');
hsd.define('Opcode', './script/opcode');
hsd.define('Script', './script/script');
hsd.define('ScriptNum', './script/scriptnum');
hsd.define('SigCache', './script/sigcache');
hsd.define('Stack', './script/stack');
hsd.define('Witness', './script/witness');

// UI
hsd.define('ui', './ui');
hsd.define('Amount', './ui/amount');
hsd.define('URI', './ui/uri');

// Utils
hsd.define('utils', './utils');
hsd.define('util', './utils/util');

// Wallet
hsd.define('wallet', './wallet');
hsd.define('Path', './wallet/path');
hsd.define('WalletKey', './wallet/walletkey');
hsd.define('WalletDB', './wallet/walletdb');

// Workers
hsd.define('workers', './workers');
hsd.define('WorkerPool', './workers/workerpool');

// Package Info
hsd.define('pkg', './pkg');
