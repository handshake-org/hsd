/*!
 * network.js - network object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const binary = require('../utils/binary');
const networks = require('./networks');
const TimeData = require('./timedata');

/**
 * Network
 * Represents a network.
 * @alias module:protocol.Network
 */

class Network {
  /**
   * Create a network.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    assert(!Network[options.type], 'Cannot create two networks.');

    this.type = options.type;
    this.seeds = options.seeds;
    this.magic = options.magic;
    this.port = options.port;
    this.brontidePort = options.brontidePort;
    this.checkpointMap = options.checkpointMap;
    this.lastCheckpoint = options.lastCheckpoint;
    this.checkpoints = [];
    this.halvingInterval = options.halvingInterval;
    this.coinbaseMaturity = options.coinbaseMaturity;
    this.genesis = options.genesis;
    this.genesisBlock = options.genesisBlock;
    this.pow = options.pow;
    this.names = options.names;
    this.goosigStop = options.goosigStop;
    this.block = options.block;
    this.activationThreshold = options.activationThreshold;
    this.minerWindow = options.minerWindow;
    this.deployments = options.deployments;
    this.deploys = options.deploys;
    this.unknownBits = 0;
    this.keyPrefix = options.keyPrefix;
    this.addressPrefix = options.addressPrefix;
    this.requireStandard = options.requireStandard;
    this.rpcPort = options.rpcPort;
    this.walletPort = options.walletPort;
    this.nsPort = options.nsPort;
    this.rsPort = options.rsPort;
    this.minRelay = options.minRelay;
    this.feeRate = options.feeRate;
    this.maxFeeRate = options.maxFeeRate;
    this.identityKey = options.identityKey;
    this.selfConnect = options.selfConnect;
    this.requestMempool = options.requestMempool;
    this.claimPrefix = options.claimPrefix;
    this.time = new TimeData();
    this.txStart = options.txStart;

    this.init();
  }

  /**
   * Get a deployment by bit index.
   * @param {Number} bit
   * @returns {Object}
   */

  init() {
    let bits = 0;

    for (const deployment of this.deploys)
      bits |= 1 << deployment.bit;

    this.unknownBits = ~bits >>> 0;

    for (const key of Object.keys(this.checkpointMap)) {
      const hash = this.checkpointMap[key];
      const height = Number(key);

      this.checkpoints.push({ hash, height });
    }

    this.checkpoints.sort(cmpNode);
  }

  /**
   * Get a deployment by bit index.
   * @param {Number} bit
   * @returns {Object}
   */

  byBit(bit) {
    const index = binary.search(this.deploys, bit, cmpBit);

    if (index === -1)
      return null;

    return this.deploys[index];
  }

  /**
   * Get network adjusted time.
   * @returns {Number}
   */

  now() {
    return this.time.now();
  }

  /**
   * Get network adjusted time in milliseconds.
   * @returns {Number}
   */

  ms() {
    return this.time.ms();
  }

  /**
   * Create a network. Get existing network if possible.
   * @param {NetworkType|Object} options
   * @returns {Network}
   */

  static create(options) {
    if (typeof options === 'string')
      options = networks[options];

    assert(options, 'Unknown network.');

    if (Network[options.type])
      return Network[options.type];

    const network = new Network(options);

    Network[network.type] = network;

    if (!Network.primary)
      Network.primary = network;

    return network;
  }

  /**
   * Set the default network. This network will be used
   * if nothing is passed as the `network` option for
   * certain objects.
   * @param {NetworkType} type - Network type.
   * @returns {Network}
   */

  static set(type) {
    assert(typeof type === 'string', 'Bad network.');
    Network.primary = Network.get(type);
    Network.type = type;
    return Network.primary;
  }

  /**
   * Get a network with a string or a Network object.
   * @param {NetworkType|Network} type - Network type.
   * @returns {Network}
   */

  static get(type) {
    if (!type) {
      assert(Network.primary, 'No default network.');
      return Network.primary;
    }

    if (type instanceof Network)
      return type;

    if (typeof type === 'string')
      return Network.create(type);

    throw new Error('Unknown network.');
  }

  /**
   * Get a network with a string or a Network object.
   * @param {NetworkType|Network} type - Network type.
   * @returns {Network}
   */

  static ensure(type) {
    if (!type) {
      assert(Network.primary, 'No default network.');
      return Network.primary;
    }

    if (type instanceof Network)
      return type;

    if (typeof type === 'string') {
      if (networks[type])
        return Network.create(type);
    }

    assert(Network.primary, 'No default network.');

    return Network.primary;
  }

  /**
   * Get a network by an associated comparator.
   * @private
   * @param {Object} value
   * @param {Function} compare
   * @param {Network|null} network
   * @param {String} name
   * @returns {Network}
   */

  static by(value, compare, network, name) {
    if (network) {
      network = Network.get(network);
      if (compare(network, value))
        return network;
      throw new Error(`Network mismatch for ${name}.`);
    }

    for (const type of networks.types) {
      network = networks[type];
      if (compare(network, value))
        return Network.get(type);
    }

    throw new Error(`Network not found for ${name}.`);
  }

  /**
   * Get a network by its magic number.
   * @param {Number} value
   * @param {Network?} network
   * @returns {Network}
   */

  static fromMagic(value, network) {
    return Network.by(value, cmpMagic, network, 'magic number');
  }

  /**
   * Get a network by its WIF prefix.
   * @param {Number} value
   * @param {Network?} network
   * @returns {Network}
   */

  static fromWIF(prefix, network) {
    return Network.by(prefix, cmpWIF, network, 'WIF');
  }

  /**
   * Get a network by its xpubkey prefix.
   * @param {Number} value
   * @param {Network?} network
   * @returns {Network}
   */

  static fromPublic(prefix, network) {
    return Network.by(prefix, cmpPub, network, 'xpubkey');
  }

  /**
   * Get a network by its xprivkey prefix.
   * @param {Number} value
   * @param {Network?} network
   * @returns {Network}
   */

  static fromPrivate(prefix, network) {
    return Network.by(prefix, cmpPriv, network, 'xprivkey');
  }

  /**
   * Get a network by its xpubkey base58 prefix.
   * @param {String} prefix
   * @param {Network?} network
   * @returns {Network}
   */

  static fromPublic58(prefix, network) {
    return Network.by(prefix, cmpPub58, network, 'xpubkey');
  }

  /**
   * Get a network by its xprivkey base58 prefix.
   * @param {String} prefix
   * @param {Network?} network
   * @returns {Network}
   */

  static fromPrivate58(prefix, network) {
    return Network.by(prefix, cmpPriv58, network, 'xprivkey');
  }

  /**
   * Get a network by its bech32 address prefix.
   * @param {String} hrp
   * @param {Network?} network
   * @returns {Network}
   */

  static fromAddress(hrp, network) {
    return Network.by(hrp, cmpAddress, network, 'address');
  }

  /**
   * Convert the network to a string.
   * @returns {String}
   */

  toString() {
    return this.type;
  }

  /**
   * Inspect the network.
   * @returns {String}
   */

  inspect() {
    return `<Network: ${this.type}>`;
  }

  /**
   * Test an object to see if it is a Network.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isNetwork(obj) {
    return obj instanceof Network;
  }
}

/**
 * Default network.
 * @type {Network}
 */

Network.primary = null;

/**
 * Default network type.
 * @type {String}
 */

Network.type = null;

/*
 * Networks (to avoid hash table mode).
 */

Network.main = null;
Network.testnet = null;
Network.regtest = null;
Network.segnet4 = null;
Network.simnet = null;

/*
 * Set initial network.
 */

Network.set(process.env.HSD_NETWORK || 'main');

/*
 * Helpers
 */

function cmpBit(a, b) {
  return a.bit - b;
}

function cmpNode(a, b) {
  return a.height - b.height;
}

function cmpMagic(network, magic) {
  return network.magic === magic;
}

function cmpWIF(network, prefix) {
  return network.keyPrefix.privkey === prefix;
}

function cmpPub(network, prefix) {
  return network.keyPrefix.xpubkey === prefix;
}

function cmpPriv(network, prefix) {
  return network.keyPrefix.xprivkey === prefix;
}

function cmpPub58(network, prefix) {
  return network.keyPrefix.xpubkey58 === prefix;
}

function cmpPriv58(network, prefix) {
  return network.keyPrefix.xprivkey58 === prefix;
}

function cmpAddress(network, hrp) {
  return network.addressPrefix === hrp;
}

/*
 * Expose
 */

module.exports = Network;
