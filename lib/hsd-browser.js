/*!
 * hsd.js - a javascript handshake library.
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * An HSD "environment" which exposes all
 * constructors for primitives, the blockchain,
 * mempool, wallet, etc. It also exposes a
 * global worker pool.
 *
 * @exports hsd
 * @type {Object}
 */

const hsd = exports;

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
hsd.blockchain = require('./blockchain');
hsd.Chain = require('./blockchain/chain');
hsd.ChainEntry = require('./blockchain/chainentry');

// Coins
hsd.coins = require('./coins');
hsd.Coins = require('./coins/coins');
hsd.CoinEntry = require('./coins/coinentry');
hsd.CoinView = require('./coins/coinview');

// Covenants
hsd.covenants = require('./covenants');
hsd.Namestate = require('./covenants/namestate');
hsd.Ownership = require('./covenants/ownership');
hsd.Rules = require('./covenants/rules');

// DNS
hsd.dns = require('./dns/server');
hsd.resource = require('./dns/resource');

// HD
hsd.hd = require('./hd');
hsd.HDPrivateKey = require('./hd/private');
hsd.HDPublicKey = require('./hd/public');
hsd.Mnemonic = require('./hd/mnemonic');

// Mempool
hsd.mempool = require('./mempool');
hsd.Fees = require('./mempool/fees');
hsd.Mempool = require('./mempool/mempool');
hsd.MempoolEntry = require('./mempool/mempoolentry');

// Miner
hsd.mining = require('./mining');
hsd.Miner = require('./mining/miner');

// Net
hsd.net = require('./net');
hsd.packets = require('./net/packets');
hsd.Peer = require('./net/peer');
hsd.Pool = require('./net/pool');

// Node
hsd.node = require('./node');
hsd.Node = require('./node/node');
hsd.FullNode = require('./node/fullnode');
hsd.SPVNode = require('./node/spvnode');

// Primitives
hsd.primitives = require('./primitives');
hsd.Address = require('./primitives/address');
hsd.Block = require('./primitives/block');
hsd.Coin = require('./primitives/coin');
hsd.Headers = require('./primitives/headers');
hsd.Input = require('./primitives/input');
hsd.InvItem = require('./primitives/invitem');
hsd.KeyRing = require('./primitives/keyring');
hsd.MerkleBlock = require('./primitives/merkleblock');
hsd.MTX = require('./primitives/mtx');
hsd.Outpoint = require('./primitives/outpoint');
hsd.Output = require('./primitives/output');
hsd.TX = require('./primitives/tx');

// Protocol
hsd.protocol = require('./protocol');
hsd.consensus = require('./protocol/consensus');
hsd.Network = require('./protocol/network');
hsd.networks = require('./protocol/networks');
hsd.policy = require('./protocol/policy');

// Script
hsd.script = require('./script');
hsd.Opcode = require('./script/opcode');
hsd.Script = require('./script/script');
hsd.ScriptNum = require('./script/scriptnum');
hsd.SigCache = require('./script/sigcache');
hsd.Stack = require('./script/stack');
hsd.Witness = require('./script/witness');

// UI
hsd.ui = require('./ui');
hsd.Amount = require('./ui/amount');
hsd.URI = require('./ui/uri');

// Utils
hsd.utils = require('./utils');
hsd.util = require('./utils/util');

// Wallet
hsd.wallet = require('./wallet');
hsd.WalletDB = require('./wallet/walletdb');

// Workers
hsd.workers = require('./workers');
hsd.WorkerPool = require('./workers/workerpool');

// Package Info
hsd.pkg = require('./pkg');
