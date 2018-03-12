/*!
 * packets.js - packets for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

/**
 * @module net/packets
 */

const assert = require('assert');
const bio = require('bufio');
const {BloomFilter} = require('bfilter');
const common = require('./common');
const util = require('../utils/util');
const bip152 = require('./bip152');
const NetAddress = require('./netaddress');
const consensus = require('../protocol/consensus');
const Headers = require('../primitives/headers');
const InvItem = require('../primitives/invitem');
const MemBlock = require('../primitives/memblock');
const MerkleBlock = require('../primitives/merkleblock');
const TX = require('../primitives/tx');
const {encoding} = bio;
const DUMMY = Buffer.alloc(0);

/**
 * Packet types.
 * @enum {Number}
 * @default
 */

exports.types = {
  VERSION: 0,
  VERACK: 1,
  PING: 2,
  PONG: 3,
  GETADDR: 4,
  ADDR: 5,
  INV: 6,
  GETDATA: 7,
  NOTFOUND: 8,
  GETBLOCKS: 9,
  GETHEADERS: 10,
  HEADERS: 11,
  SENDHEADERS: 12,
  BLOCK: 13,
  TX: 14,
  REJECT: 15,
  MEMPOOL: 16,
  FILTERLOAD: 17,
  FILTERADD: 18,
  FILTERCLEAR: 19,
  MERKLEBLOCK: 20,
  FEEFILTER: 21,
  SENDCMPCT: 22,
  CMPCTBLOCK: 23,
  GETBLOCKTXN: 24,
  BLOCKTXN: 25,
  GETPROOF: 26,
  PROOF: 27,
  UNKNOWN: 28,
  // Internal
  INTERNAL: 29,
  DATA: 30
};

/**
 * Packet types by value.
 * @const {Object}
 * @default
 */

exports.typesByVal = [
  'VERSION',
  'VERACK',
  'PING',
  'PONG',
  'GETADDR',
  'ADDR',
  'INV',
  'GETDATA',
  'NOTFOUND',
  'GETBLOCKS',
  'GETHEADERS',
  'HEADERS',
  'SENDHEADERS',
  'BLOCK',
  'TX',
  'REJECT',
  'MEMPOOL',
  'FILTERLOAD',
  'FILTERADD',
  'FILTERCLEAR',
  'MERKLEBLOCK',
  'FEEFILTER',
  'SENDCMPCT',
  'CMPCTBLOCK',
  'GETBLOCKTXN',
  'BLOCKTXN',
  'UNKNOWN',
  // Internal
  'INTERNAL',
  'DATA'
];

/**
 * Base Packet
 */

class Packet extends bio.Struct {
  /**
   * Create a base packet.
   * @constructor
   */

  constructor() {
    super();
    this.type = -1;
    this.cmd = '';
  }
}

/**
 * Version Packet
 * @extends Packet
 * @property {Number} version - Protocol version.
 * @property {Number} services - Service bits.
 * @property {Number} time - Timestamp of discovery.
 * @property {NetAddress} local - Our address.
 * @property {NetAddress} remote - Their address.
 * @property {Buffer} nonce
 * @property {String} agent - User agent string.
 * @property {Number} height - Chain height.
 * @property {Boolean} noRelay - Whether transactions
 * should be relayed immediately.
 */

class VersionPacket extends Packet {
  /**
   * Create a version packet.
   * @constructor
   * @param {Object?} options
   * @param {Number} options.version - Protocol version.
   * @param {Number} options.services - Service bits.
   * @param {Number} options.time - Timestamp of discovery.
   * @param {NetAddress} options.local - Our address.
   * @param {NetAddress} options.remote - Their address.
   * @param {Buffer} options.nonce
   * @param {String} options.agent - User agent string.
   * @param {Number} options.height - Chain height.
   * @param {Boolean} options.noRelay - Whether transactions
   * should be relayed immediately.
   */

  constructor(options) {
    super();

    this.cmd = 'version';
    this.type = exports.types.VERSION;

    this.version = common.PROTOCOL_VERSION;
    this.services = common.LOCAL_SERVICES;
    this.time = util.now();
    this.remote = new NetAddress();
    this.local = new NetAddress();
    this.nonce = common.ZERO_NONCE;
    this.agent = common.USER_AGENT;
    this.height = 0;
    this.noRelay = false;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    if (options.version != null)
      this.version = options.version;

    if (options.services != null)
      this.services = options.services;

    if (options.time != null)
      this.time = options.time;

    if (options.remote)
      this.remote.fromOptions(options.remote);

    if (options.local)
      this.local.fromOptions(options.local);

    if (options.nonce)
      this.nonce = options.nonce;

    if (options.agent)
      this.agent = options.agent;

    if (options.height != null)
      this.height = options.height;

    if (options.noRelay != null)
      this.noRelay = options.noRelay;

    return this;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += 20;
    size += this.remote.getSize();
    size += this.local.getSize();
    size += 8;
    size += 1;
    size += this.agent.length;
    size += 5;
    return size;
  }

  /**
   * Write version packet to buffer writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeU32(this.version);
    bw.writeU32(this.services);
    bw.writeU32(0);
    bw.writeU64(this.time);
    this.remote.write(bw);
    this.local.write(bw);
    bw.writeBytes(this.nonce);
    bw.writeU8(this.agent.length);
    bw.writeString(this.agent, 'ascii');
    bw.writeU32(this.height);
    bw.writeU8(this.noRelay ? 1 : 0);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.version = br.readU32();
    this.services = br.readU32();

    // Note: hi service bits
    // are currently unused.
    br.readU32();

    this.time = br.readU64();
    this.remote.read(br);
    this.local.read(br);
    this.nonce = br.readBytes(8);
    this.agent = br.readString('ascii', br.readU8());
    this.height = br.readU32();
    this.noRelay = br.readU8() === 1;

    return this;
  }
}

/**
 * Verack Packet
 * @extends Packet
 */

class VerackPacket extends Packet {
  /**
   * Create a `verack` packet.
   * @constructor
   */

  constructor() {
    super();
    this.cmd = 'verack';
    this.type = exports.types.VERACK;
  }
}

/**
 * Ping Packet
 * @extends Packet
 * @property {BN|null} nonce
 */

class PingPacket extends Packet {
  /**
   * Create a `ping` packet.
   * @constructor
   * @param {BN?} nonce
   */

  constructor(nonce) {
    super();

    this.cmd = 'ping';
    this.type = exports.types.PING;

    this.nonce = nonce || null;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 8;
  }

  /**
   * Serialize ping packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeBytes(this.nonce);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.nonce = br.readBytes(8);
    return this;
  }
}

/**
 * Pong Packet
 * @extends Packet
 * @property {BN} nonce
 */

class PongPacket extends Packet {
  /**
   * Create a `pong` packet.
   * @constructor
   * @param {BN?} nonce
   */

  constructor(nonce) {
    super();

    this.cmd = 'pong';
    this.type = exports.types.PONG;

    this.nonce = nonce || common.ZERO_NONCE;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 8;
  }

  /**
   * Serialize pong packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeBytes(this.nonce);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.nonce = br.readBytes(8);
    return this;
  }
}

/**
 * GetAddr Packet
 * @extends Packet
 */

class GetAddrPacket extends Packet {
  /**
   * Create a `getaddr` packet.
   * @constructor
   */

  constructor() {
    super();
    this.cmd = 'getaddr';
    this.type = exports.types.GETADDR;
  }
}

/**
 * Addr Packet
 * @extends Packet
 * @property {NetAddress[]} items
 */

class AddrPacket extends Packet {
  /**
   * Create a `addr` packet.
   * @constructor
   * @param {(NetAddress[])?} items
   */

  constructor(items) {
    super();

    this.cmd = 'addr';
    this.type = exports.types.ADDR;

    this.items = items || [];
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += encoding.sizeVarint(this.items.length);
    for (const addr of this.items)
      size += addr.getSize();
    return size;
  }

  /**
   * Serialize addr packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeVarint(this.items.length);

    for (const item of this.items)
      item.write(bw);

    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  read(br) {
    const count = br.readVarint();

    for (let i = 0; i < count; i++)
      this.items.push(NetAddress.read(br));

    return this;
  }
}

/**
 * Inv Packet
 * @extends Packet
 * @property {InvItem[]} items
 */

class InvPacket extends Packet {
  /**
   * Create a `inv` packet.
   * @constructor
   * @param {(InvItem[])?} items
   */

  constructor(items) {
    super();

    this.cmd = 'inv';
    this.type = exports.types.INV;

    this.items = items || [];
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += encoding.sizeVarint(this.items.length);
    size += 36 * this.items.length;
    return size;
  }

  /**
   * Serialize inv packet to writer.
   * @param {Buffer} bw
   */

  write(bw) {
    assert(this.items.length <= 50000);

    bw.writeVarint(this.items.length);

    for (const item of this.items)
      item.write(bw);

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    const count = br.readVarint();

    assert(count <= 50000, 'Inv item count too high.');

    for (let i = 0; i < count; i++)
      this.items.push(InvItem.read(br));

    return this;
  }
}

/**
 * GetData Packet
 * @extends InvPacket
 */

class GetDataPacket extends InvPacket {
  /**
   * Create a `getdata` packet.
   * @constructor
   * @param {(InvItem[])?} items
   */

  constructor(items) {
    super(items);
    this.cmd = 'getdata';
    this.type = exports.types.GETDATA;
  }
}

/**
 * NotFound Packet
 * @extends InvPacket
 */

class NotFoundPacket extends InvPacket {
  /**
   * Create a `notfound` packet.
   * @constructor
   * @param {(InvItem[])?} items
   */

  constructor(items) {
    super(items);
    this.cmd = 'notfound';
    this.type = exports.types.NOTFOUND;
  }
}

/**
 * GetBlocks Packet
 * @extends Packet
 * @property {Hash[]} locator
 * @property {Hash|null} stop
 */

class GetBlocksPacket extends Packet {
  /**
   * Create a `getblocks` packet.
   * @constructor
   * @param {Hash[]} locator
   * @param {Hash?} stop
   */

  constructor(locator, stop) {
    super();

    this.cmd = 'getblocks';
    this.type = exports.types.GETBLOCKS;

    this.locator = locator || [];
    this.stop = stop || null;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;
    size += encoding.sizeVarint(this.locator.length);
    size += 32 * this.locator.length;
    size += 32;
    return size;
  }

  /**
   * Serialize getblocks packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    assert(this.locator.length <= 50000, 'Too many block hashes.');

    bw.writeVarint(this.locator.length);

    for (const hash of this.locator)
      bw.writeHash(hash);

    bw.writeHash(this.stop || consensus.ZERO_HASH);

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    const count = br.readVarint();

    assert(count <= 50000, 'Too many block hashes.');

    for (let i = 0; i < count; i++)
      this.locator.push(br.readHash('hex'));

    this.stop = br.readHash('hex');

    if (this.stop === consensus.NULL_HASH)
      this.stop = null;

    return this;
  }
}

/**
 * GetHeader Packets
 * @extends GetBlocksPacket
 */

class GetHeadersPacket extends GetBlocksPacket {
  /**
   * Create a `getheaders` packet.
   * @constructor
   * @param {Hash[]} locator
   * @param {Hash?} stop
   */

  constructor(locator, stop) {
    super(locator, stop);
    this.cmd = 'getheaders';
    this.type = exports.types.GETHEADERS;
  }
}

/**
 * Headers Packet
 * @extends Packet
 * @property {Headers[]} items
 */

class HeadersPacket extends Packet {
  /**
   * Create a `headers` packet.
   * @constructor
   * @param {(Headers[])?} items
   */

  constructor(items) {
    super();

    this.cmd = 'headers';
    this.type = exports.types.HEADERS;

    this.items = items || [];
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += encoding.sizeVarint(this.items.length);

    for (const item of this.items)
      size += item.getSize();

    return size;
  }

  /**
   * Serialize headers packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    assert(this.items.length <= 2000, 'Too many headers.');

    bw.writeVarint(this.items.length);

    for (const item of this.items)
      item.toWriter(bw);

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    const count = br.readVarint();

    assert(count <= 2000, 'Too many headers.');

    for (let i = 0; i < count; i++)
      this.items.push(Headers.fromReader(br));

    return this;
  }
}

/**
 * SendHeaders Packet
 * @extends Packet
 */

class SendHeadersPacket extends Packet {
  /**
   * Create a `sendheaders` packet.
   * @constructor
   */

  constructor() {
    super();
    this.cmd = 'sendheaders';
    this.type = exports.types.SENDHEADERS;
  }
}

/**
 * Block Packet
 * @extends Packet
 * @property {Block} block
 */

class BlockPacket extends Packet {
  /**
   * Create a `block` packet.
   * @constructor
   * @param {Block|null} block
   */

  constructor(block) {
    super();

    this.cmd = 'block';
    this.type = exports.types.BLOCK;

    this.block = block || new MemBlock();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.block.getSize();
  }

  /**
   * Serialize block packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.block.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.block.fromReader(br);
    return this;
  }
}

/**
 * TX Packet
 * @extends Packet
 * @property {TX} block
 */

class TXPacket extends Packet {
  /**
   * Create a `tx` packet.
   * @constructor
   * @param {TX|null} tx
   */

  constructor(tx) {
    super();

    this.cmd = 'tx';
    this.type = exports.types.TX;

    this.tx = tx || new TX();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.tx.getSize();
  }

  /**
   * Serialize tx packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.tx.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.tx.fromReader(br);
    return this;
  }
}

/**
 * Reject Packet
 * @extends Packet
 * @property {(Number|String)?} code - Code
 * (see {@link RejectPacket.codes}).
 * @property {String?} msg - Message.
 * @property {String?} reason - Reason.
 * @property {(Hash|Buffer)?} data - Transaction or block hash.
 */

class RejectPacket extends Packet {
  /**
   * Create reject packet.
   * @constructor
   */

  constructor(options) {
    super();

    this.cmd = 'reject';
    this.type = exports.types.REJECT;

    this.message = '';
    this.code = RejectPacket.codes.INVALID;
    this.reason = '';
    this.hash = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    let code = options.code;

    if (options.message)
      this.message = options.message;

    if (code != null) {
      if (typeof code === 'string')
        code = RejectPacket.codes[code.toUpperCase()];

      if (code >= RejectPacket.codes.INTERNAL)
        code = RejectPacket.codes.INVALID;

      this.code = code;
    }

    if (options.reason)
      this.reason = options.reason;

    if (options.hash)
      this.hash = options.hash;

    return this;
  }

  /**
   * Get symbolic code.
   * @returns {String}
   */

  getCode() {
    const code = RejectPacket.codesByVal[this.code];

    if (!code)
      return this.code.toString(10);

    return code.toLowerCase();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 0;

    size += encoding.sizeVarString(this.message, 'ascii');
    size += 1;
    size += encoding.sizeVarString(this.reason, 'ascii');

    if (this.hash)
      size += 32;

    return size;
  }

  /**
   * Serialize reject packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    assert(this.message.length <= 12);
    assert(this.reason.length <= 111);

    bw.writeVarString(this.message, 'ascii');
    bw.writeU8(this.code);
    bw.writeVarString(this.reason, 'ascii');

    if (this.hash)
      bw.writeHash(this.hash);

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.message = br.readVarString('ascii', 12);
    this.code = br.readU8();
    this.reason = br.readVarString('ascii', 111);

    switch (this.message) {
      case 'block':
      case 'tx':
        this.hash = br.readHash('hex');
        break;
      default:
        this.hash = null;
        break;
    }

    return this;
  }

  /**
   * Inject properties from reason message and object.
   * @private
   * @param {Number} code
   * @param {String} reason
   * @param {String?} msg
   * @param {Hash?} hash
   */

  fromReason(code, reason, msg, hash) {
    if (typeof code === 'string')
      code = RejectPacket.codes[code.toUpperCase()];

    if (!code)
      code = RejectPacket.codes.INVALID;

    if (code >= RejectPacket.codes.INTERNAL)
      code = RejectPacket.codes.INVALID;

    this.message = '';
    this.code = code;
    this.reason = reason;

    if (msg) {
      assert(hash);
      this.message = msg;
      this.hash = hash;
    }

    return this;
  }

  /**
   * Instantiate reject packet from reason message.
   * @param {Number} code
   * @param {String} reason
   * @param {String?} msg
   * @param {Hash?} hash
   * @returns {RejectPacket}
   */

  static fromReason(code, reason, msg, hash) {
    return new this().fromReason(code, reason, msg, hash);
  }

  /**
   * Instantiate reject packet from verify error.
   * @param {VerifyError} err
   * @param {(TX|Block)?} obj
   * @returns {RejectPacket}
   */

  static fromError(err, obj) {
    return this.fromReason(err.code, err.reason, obj);
  }

  /**
   * Inspect reject packet.
   * @returns {String}
   */

  inspect() {
    const code = RejectPacket.codesByVal[this.code] || this.code;
    const hash = this.hash ? this.hash : null;
    return '<Reject:'
      + ` msg=${this.message}`
      + ` code=${code}`
      + ` reason=${this.reason}`
      + ` hash=${hash}`
      + '>';
  }
}

/**
 * Reject codes. Note that `internal` and higher
 * are not meant for use on the p2p network.
 * @enum {Number}
 * @default
 */

RejectPacket.codes = {
  MALFORMED: 0x01,
  INVALID: 0x10,
  OBSOLETE: 0x11,
  DUPLICATE: 0x12,
  NONSTANDARD: 0x40,
  DUST: 0x41,
  INSUFFICIENTFEE: 0x42,
  CHECKPOINT: 0x43,
  // Internal codes (NOT FOR USE ON NETWORK)
  INTERNAL: 0x100,
  HIGHFEE: 0x101,
  ALREADYKNOWN: 0x102,
  CONFLICT: 0x103
};

/**
 * Reject codes by value.
 * @const {Object}
 */

RejectPacket.codesByVal = {
  0x01: 'MALFORMED',
  0x10: 'INVALID',
  0x11: 'OBSOLETE',
  0x12: 'DUPLICATE',
  0x40: 'NONSTANDARD',
  0x41: 'DUST',
  0x42: 'INSUFFICIENTFEE',
  0x43: 'CHECKPOINT',
  // Internal codes (NOT FOR USE ON NETWORK)
  0x100: 'INTERNAL',
  0x101: 'HIGHFEE',
  0x102: 'ALREADYKNOWN',
  0x103: 'CONFLICT'
};

/**
 * Mempool Packet
 * @extends Packet
 */

class MempoolPacket extends Packet {
  /**
   * Create a `mempool` packet.
   * @constructor
   */

  constructor() {
    super();
    this.cmd = 'mempool';
    this.type = exports.types.MEMPOOL;
  }
}

/**
 * FilterLoad Packet
 * @extends Packet
 */

class FilterLoadPacket extends Packet {
  /**
   * Create a `filterload` packet.
   * @constructor
   * @param {BloomFilter|null} filter
   */

  constructor(filter) {
    super();

    this.cmd = 'filterload';
    this.type = exports.types.FILTERLOAD;

    this.filter = filter || new BloomFilter();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.filter.getSize();
  }

  /**
   * Serialize filterload packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.filter.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.filter.fromReader(br);
    return this;
  }

  /**
   * Ensure the filter is within the size limits.
   * @returns {Boolean}
   */

  isWithinConstraints() {
    return this.filter.isWithinConstraints();
  }
}

/**
 * FilterAdd Packet
 * @extends Packet
 * @property {Buffer} data
 */

class FilterAddPacket extends Packet {
  /**
   * Create a `filteradd` packet.
   * @constructor
   * @param {Buffer?} data
   */

  constructor(data) {
    super();

    this.cmd = 'filteradd';
    this.type = exports.types.FILTERADD;

    this.data = data || DUMMY;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return encoding.sizeVarBytes(this.data);
  }

  /**
   * Serialize filteradd packet to writer.
   * @returns {BufferWriter} bw
   */

  write(bw) {
    bw.writeVarBytes(this.data);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.data = br.readVarBytes();
    return this;
  }
}

/**
 * FilterClear Packet
 * @extends Packet
 */

class FilterClearPacket extends Packet {
  /**
   * Create a `filterclear` packet.
   * @constructor
   */

  constructor() {
    super();
    this.cmd = 'filterclear';
    this.type = exports.types.FILTERCLEAR;
  }
}

/**
 * MerkleBlock Packet
 * @extends Packet
 * @property {MerkleBlock} block
 */

class MerkleBlockPacket extends Packet {
  /**
   * Create a `merkleblock` packet.
   * @constructor
   * @param {MerkleBlock?} block
   */

  constructor(block) {
    super();

    this.cmd = 'merkleblock';
    this.type = exports.types.MERKLEBLOCK;

    this.block = block || new MerkleBlock();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.block.getSize();
  }

  /**
   * Serialize merkleblock packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.block.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.block.fromReader(br);
    return this;
  }
}

/**
 * FeeFilter Packet
 * @extends Packet
 * @property {Rate} rate
 */

class FeeFilterPacket extends Packet {
  /**
   * Create a `feefilter` packet.
   * @constructor
   * @param {Rate?} rate
   */

  constructor(rate) {
    super();

    this.cmd = 'feefilter';
    this.type = exports.types.FEEFILTER;

    this.rate = rate || 0;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 8;
  }

  /**
   * Serialize feefilter packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeI64(this.rate);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.rate = br.readI64();
    return this;
  }
}

/**
 * SendCmpct Packet
 * @extends Packet
 * @property {Number} mode
 * @property {Number} version
 */

class SendCmpctPacket extends Packet {
  /**
   * Create a `sendcmpct` packet.
   * @constructor
   * @param {Number|null} mode
   * @param {Number|null} version
   */

  constructor(mode, version) {
    super();

    this.cmd = 'sendcmpct';
    this.type = exports.types.SENDCMPCT;

    this.mode = mode || 0;
    this.version = version || 1;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 9;
  }

  /**
   * Serialize sendcmpct packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeU8(this.mode);
    bw.writeU64(this.version);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.mode = br.readU8();
    this.version = br.readU64();
    return this;
  }
}

/**
 * CmpctBlock Packet
 * @extends Packet
 * @property {Block} block
 */

class CmpctBlockPacket extends Packet {
  /**
   * Create a `cmpctblock` packet.
   * @constructor
   * @param {Block|null} block
   */

  constructor(block) {
    super();

    this.cmd = 'cmpctblock';
    this.type = exports.types.CMPCTBLOCK;

    this.block = block || new bip152.CompactBlock();
  }

  /**
   * Serialize cmpctblock packet.
   * @returns {Buffer}
   */

  getSize() {
    return this.block.getSize();
  }

  /**
   * Serialize cmpctblock packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.block.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.block.fromReader(br);
    return this;
  }
}

/**
 * GetBlockTxn Packet
 * @extends Packet
 * @property {TXRequest} request
 */

class GetBlockTxnPacket extends Packet {
  /**
   * Create a `getblocktxn` packet.
   * @constructor
   * @param {TXRequest?} request
   */

  constructor(request) {
    super();

    this.cmd = 'getblocktxn';
    this.type = exports.types.GETBLOCKTXN;

    this.request = request || new bip152.TXRequest();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.request.getSize();
  }

  /**
   * Serialize getblocktxn packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.request.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.request.fromReader(br);
    return this;
  }
}

/**
 * BlockTxn Packet
 * @extends Packet
 * @property {TXResponse} response
 */

class BlockTxnPacket extends Packet {
  /**
   * Create a `blocktxn` packet.
   * @constructor
   * @param {TXResponse?} response
   */

  constructor(response) {
    super();

    this.cmd = 'blocktxn';
    this.type = exports.types.BLOCKTXN;

    this.response = response || new bip152.TXResponse();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.response.getSize();
  }

  /**
   * Serialize blocktxn packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    return this.response.toWriter(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.response.fromReader(br);
    return this;
  }
}

/**
 * GetProof Packet
 * @extends Packet
 * @property {Buffer} root
 * @property {Buffer} key
 */

class GetProofPacket extends Packet {
  /**
   * Create a `getproof` packet.
   * @constructor
   * @param {Buffer?} root
   * @param {Buffer?} key
   */

  constructor(root, key) {
    super();

    this.cmd = 'getproof';
    this.type = exports.types.GETPROOF;
    this.root = root || consensus.ZERO_HASH;
    this.key = key || consensus.ZERO_HASH;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return 64;
  }

  /**
   * Serialize getproof packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeHash(this.root);
    bw.writeHash(this.key);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.root = br.readHash();
    this.key = br.readHash();
    return this;
  }
}

/**
 * Proof Packet
 * @extends Packet
 * @property {Hash} hash
 */

class ProofPacket extends Packet {
  /**
   * Create a `proof` packet.
   * @constructor
   * @param {Buffer} root
   * @param {Buffer} key
   * @param {Buffer[]} nodes
   */

  constructor(root, key, nodes) {
    super();

    this.cmd = 'proof';
    this.type = exports.types.PROOF;
    this.root = root || consensus.ZERO_HASH;
    this.key = key || consensus.ZERO_HASH;
    this.nodes = nodes || [];
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 64;
    size += encoding.sizeVarint(this.nodes.length);
    for (const node of this.nodes)
      size += encoding.sizeVarlen(node.length);
    return size;
  }

  /**
   * Serialize proof packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeHash(this.root);
    bw.writeHash(this.key);
    bw.writeVarint(this.nodes.length);
    for (const node of this.nodes)
      bw.writeVarBytes(node);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.root = br.readHash();
    this.key = br.readHash();
    const count = br.readVarint();
    for (let i = 0; i < count; i++)
      this.nodes.push(br.readVarBytes());
    return this;
  }
}

/**
 * Unknown Packet
 * @extends Packet
 * @property {String} cmd
 * @property {Buffer} data
 */

class UnknownPacket extends Packet {
  /**
   * Create an unknown packet.
   * @constructor
   * @param {String|null} cmd
   * @param {Buffer|null} data
   */

  constructor(cmd, data) {
    super();

    this.cmd = cmd;
    this.type = exports.types.UNKNOWN;
    this.data = data;
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.data.length;
  }

  /**
   * Serialize unknown packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeBytes(this.data);
    return this;
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromRaw(cmd, data) {
    assert(Buffer.isBuffer(data));
    this.cmd = cmd;
    this.data = data;
    return this;
  }
}

/**
 * Parse a payload.
 * @param {String} cmd
 * @param {Buffer} data
 * @returns {Packet}
 */

exports.fromRaw = function fromRaw(cmd, data) {
  switch (cmd) {
    case 'version':
      return VersionPacket.fromRaw(data);
    case 'verack':
      return VerackPacket.fromRaw(data);
    case 'ping':
      return PingPacket.fromRaw(data);
    case 'pong':
      return PongPacket.fromRaw(data);
    case 'getaddr':
      return GetAddrPacket.fromRaw(data);
    case 'addr':
      return AddrPacket.fromRaw(data);
    case 'inv':
      return InvPacket.fromRaw(data);
    case 'getdata':
      return GetDataPacket.fromRaw(data);
    case 'notfound':
      return NotFoundPacket.fromRaw(data);
    case 'getblocks':
      return GetBlocksPacket.fromRaw(data);
    case 'getheaders':
      return GetHeadersPacket.fromRaw(data);
    case 'headers':
      return HeadersPacket.fromRaw(data);
    case 'sendheaders':
      return SendHeadersPacket.fromRaw(data);
    case 'block':
      return BlockPacket.fromRaw(data);
    case 'tx':
      return TXPacket.fromRaw(data);
    case 'reject':
      return RejectPacket.fromRaw(data);
    case 'mempool':
      return MempoolPacket.fromRaw(data);
    case 'filterload':
      return FilterLoadPacket.fromRaw(data);
    case 'filteradd':
      return FilterAddPacket.fromRaw(data);
    case 'filterclear':
      return FilterClearPacket.fromRaw(data);
    case 'merkleblock':
      return MerkleBlockPacket.fromRaw(data);
    case 'feefilter':
      return FeeFilterPacket.fromRaw(data);
    case 'sendcmpct':
      return SendCmpctPacket.fromRaw(data);
    case 'cmpctblock':
      return CmpctBlockPacket.fromRaw(data);
    case 'getblocktxn':
      return GetBlockTxnPacket.fromRaw(data);
    case 'blocktxn':
      return BlockTxnPacket.fromRaw(data);
    case 'getproof':
      return GetProofPacket.fromRaw(data);
    case 'proof':
      return ProofPacket.fromRaw(data);
    default:
      return UnknownPacket.fromRaw(cmd, data);
  }
};

/*
 * Expose
 */

exports.Packet = Packet;
exports.VersionPacket = VersionPacket;
exports.VerackPacket = VerackPacket;
exports.PingPacket = PingPacket;
exports.PongPacket = PongPacket;
exports.GetAddrPacket = GetAddrPacket;
exports.AddrPacket = AddrPacket;
exports.InvPacket = InvPacket;
exports.GetDataPacket = GetDataPacket;
exports.NotFoundPacket = NotFoundPacket;
exports.GetBlocksPacket = GetBlocksPacket;
exports.GetHeadersPacket = GetHeadersPacket;
exports.HeadersPacket = HeadersPacket;
exports.SendHeadersPacket = SendHeadersPacket;
exports.BlockPacket = BlockPacket;
exports.TXPacket = TXPacket;
exports.RejectPacket = RejectPacket;
exports.MempoolPacket = MempoolPacket;
exports.FilterLoadPacket = FilterLoadPacket;
exports.FilterAddPacket = FilterAddPacket;
exports.FilterClearPacket = FilterClearPacket;
exports.MerkleBlockPacket = MerkleBlockPacket;
exports.FeeFilterPacket = FeeFilterPacket;
exports.SendCmpctPacket = SendCmpctPacket;
exports.CmpctBlockPacket = CmpctBlockPacket;
exports.GetBlockTxnPacket = GetBlockTxnPacket;
exports.BlockTxnPacket = BlockTxnPacket;
exports.GetProofPacket = GetProofPacket;
exports.ProofPacket = ProofPacket;
exports.UnknownPacket = UnknownPacket;
