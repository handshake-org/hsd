/*!
 * hsk.js - a javascript bitcoin library.
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License).
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

/**
 * An HSK "environment" which exposes all
 * constructors for primitives, the blockchain,
 * mempool, wallet, etc. It also exposes a
 * global worker pool.
 *
 * @exports hsk
 * @type {Object}
 */

const hsk = exports;

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
hsk.blockchain = require('./blockchain');
hsk.Chain = require('./blockchain/chain');
hsk.ChainEntry = require('./blockchain/chainentry');

// BTC
hsk.btc = require('./btc');
hsk.Amount = require('./btc/amount');
hsk.URI = require('./btc/uri');

// Coins
hsk.coins = require('./coins');
hsk.Coins = require('./coins/coins');
hsk.CoinEntry = require('./coins/coinentry');
hsk.CoinView = require('./coins/coinview');

// HD
hsk.hd = require('./hd');
hsk.HDPrivateKey = require('./hd/private');
hsk.HDPublicKey = require('./hd/public');
hsk.Mnemonic = require('./hd/mnemonic');

// Mempool
hsk.mempool = require('./mempool');
hsk.Fees = require('./mempool/fees');
hsk.Mempool = require('./mempool/mempool');
hsk.MempoolEntry = require('./mempool/mempoolentry');

// Miner
hsk.mining = require('./mining');
hsk.Miner = require('./mining/miner');

// Net
hsk.net = require('./net');
hsk.packets = require('./net/packets');
hsk.Peer = require('./net/peer');
hsk.Pool = require('./net/pool');

// Node
hsk.node = require('./node');
hsk.Node = require('./node/node');
hsk.FullNode = require('./node/fullnode');
hsk.SPVNode = require('./node/spvnode');

// Primitives
hsk.primitives = require('./primitives');
hsk.Address = require('./primitives/address');
hsk.Block = require('./primitives/block');
hsk.Coin = require('./primitives/coin');
hsk.Headers = require('./primitives/headers');
hsk.Input = require('./primitives/input');
hsk.InvItem = require('./primitives/invitem');
hsk.KeyRing = require('./primitives/keyring');
hsk.MerkleBlock = require('./primitives/merkleblock');
hsk.MTX = require('./primitives/mtx');
hsk.Outpoint = require('./primitives/outpoint');
hsk.Output = require('./primitives/output');
hsk.TX = require('./primitives/tx');

// Protocol
hsk.protocol = require('./protocol');
hsk.consensus = require('./protocol/consensus');
hsk.Network = require('./protocol/network');
hsk.networks = require('./protocol/networks');
hsk.policy = require('./protocol/policy');

// Script
hsk.script = require('./script');
hsk.Opcode = require('./script/opcode');
hsk.Program = require('./script/program');
hsk.Script = require('./script/script');
hsk.ScriptNum = require('./script/scriptnum');
hsk.SigCache = require('./script/sigcache');
hsk.Stack = require('./script/stack');
hsk.Witness = require('./script/witness');

// Utils
hsk.utils = require('./utils');
hsk.util = require('./utils/util');

// Wallet
hsk.wallet = require('./wallet');
hsk.WalletDB = require('./wallet/walletdb');

// Workers
hsk.workers = require('./workers');
hsk.WorkerPool = require('./workers/workerpool');

// Package Info
hsk.pkg = require('./pkg');
