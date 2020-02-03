/*!
 * packets.js - packets for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module net/packets
 */

const assert = require('bsert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const UrkelProof = require('urkel/radix').Proof;
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
const Claim = require('../primitives/claim');
const AirdropProof = require('../primitives/airdropproof');
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
  CLAIM: 28,
  AIRDROP: 29,
  UNKNOWN: 30,
  // Internal
  INTERNAL: 31,
  DATA: 32
};

const types = exports.types;

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
  'GETPROOF',
  'PROOF',
  'CLAIM',
  'AIRDROP',
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
    this.type = 0;
  }
}

/**
 * Version Packet
 * @extends Packet
 * @property {Number} version - Protocol version.
 * @property {Number} services - Service bits.
 * @property {Number} time - Timestamp of discovery.
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
   * @param {NetAddress} options.remote - Their address.
   * @param {Buffer} options.nonce
   * @param {String} options.agent - User agent string.
   * @param {Number} options.height - Chain height.
   * @param {Boolean} options.noRelay - Whether transactions
   * should be relayed immediately.
   */

  constructor(options) {
    super();

    this.type = exports.types.VERSION;

    this.version = common.PROTOCOL_VERSION;
    this.services = common.LOCAL_SERVICES;
    this.time = util.now();
    this.remote = new NetAddress();
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
    this.nonce = br.readBytes(8);
    this.agent = br.readString(br.readU8(), 'ascii');
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
   * @param {Buffer} nonce
   */

  constructor(nonce) {
    super();

    this.type = exports.types.PING;

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
   * @param {Buffer} nonce
   */

  constructor(nonce) {
    super();

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
    assert(this.items.length <= common.MAX_INV);

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

    assert(count <= common.MAX_INV, 'Inv item count too high.');

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

    this.type = exports.types.GETBLOCKS;

    this.locator = locator || [];
    this.stop = stop || consensus.ZERO_HASH;
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
    assert(this.locator.length <= common.MAX_INV, 'Too many block hashes.');

    bw.writeVarint(this.locator.length);

    for (const hash of this.locator)
      bw.writeHash(hash);

    bw.writeHash(this.stop);

    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    const count = br.readVarint();

    assert(count <= common.MAX_INV, 'Too many block hashes.');

    for (let i = 0; i < count; i++)
      this.locator.push(br.readHash());

    this.stop = br.readHash();

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

    assert(count <= 2000, 'Too many headers.');

    for (let i = 0; i < count; i++)
      this.items.push(Headers.read(br));

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
    return this.block.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.block.read(br);
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
    return this.tx.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.tx.read(br);
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

    this.type = exports.types.REJECT;

    this.message = 0;
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

    if (options.message != null)
      this.message = options.message | 0;

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

    size += 1;
    size += 1;
    size += 1;
    size += this.reason.length;

    if (this.hash)
      size += 32;

    return size;
  }

  /**
   * Serialize reject packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeU8(this.message);
    bw.writeU8(this.code);
    bw.writeU8(this.reason.length);
    bw.writeString(this.reason, 'ascii');

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
    this.message = br.readU8();
    this.code = br.readU8();
    this.reason = br.readString(br.readU8(), 'ascii');

    switch (this.message) {
      case types.BLOCK:
      case types.TX:
      case types.CLAIM:
      case types.AIRDROP:
        this.hash = br.readHash();
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

    this.message = 0;
    this.code = code;
    this.reason = reason;

    if (msg != null) {
      assert(hash);
      this.message = msg | 0;
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

  format() {
    const msg = exports.typesByVal[this.message] || 'UNKNOWN';
    const code = RejectPacket.codesByVal[this.code] || this.code;
    const hash = this.hash ? this.hash : null;
    return '<Reject:'
      + ` msg=${msg}`
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
    return this.filter.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.filter.read(br);
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
    return this.block.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.block.read(br);
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
    return this.block.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.block.read(br);
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
    return this.request.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.request.read(br);
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
    return this.response.write(bw);
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.response.read(br);
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
    bw.writeBytes(this.key);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.root = br.readHash();
    this.key = br.readBytes(32);
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
   * @param {UrkelProof} proof
   */

  constructor(root, key, proof) {
    super();

    this.type = exports.types.PROOF;
    this.root = root || consensus.ZERO_HASH;
    this.key = key || consensus.ZERO_HASH;
    this.proof = proof || new UrkelProof();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    let size = 64;
    size += this.proof.getSize(blake2b, 256);
    return size;
  }

  /**
   * Serialize proof packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    bw.writeHash(this.root);
    bw.writeBytes(this.key);
    this.proof.writeBW(bw, blake2b, 256);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.root = br.readHash();
    this.key = br.readBytes(32);
    this.proof = UrkelProof.readBR(br, blake2b, 256);
    return this;
  }
}

/**
 * Claim Packet
 * @extends Packet
 */

class ClaimPacket extends Packet {
  /**
   * Create a `proof` packet.
   * @constructor
   * @param {Claim?} claim
   */

  constructor(claim) {
    super();

    this.type = exports.types.CLAIM;
    this.claim = claim || new Claim();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.claim.getSize();
  }

  /**
   * Serialize proof packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    this.claim.write(bw);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.claim.read(br);
    return this;
  }
}

/**
 * Airdrop Packet
 * @extends Packet
 */

class AirdropPacket extends Packet {
  /**
   * Create a `proof` packet.
   * @constructor
   * @param {AirdropProof?} proof
   */

  constructor(proof) {
    super();

    this.type = exports.types.AIRDROP;
    this.proof = proof || new AirdropProof();
  }

  /**
   * Get serialization size.
   * @returns {Number}
   */

  getSize() {
    return this.proof.getSize();
  }

  /**
   * Serialize proof packet to writer.
   * @param {BufferWriter} bw
   */

  write(bw) {
    this.proof.write(bw);
    return this;
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    this.proof.read(br);
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
   * @param {Number|null} type
   * @param {Buffer|null} data
   */

  constructor(type, data) {
    super();

    this.type = type || types.UNKNOWN;
    this.data = data || DUMMY;
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
   * @param {BufferReader} data
   * @param {Number} type
   */

  read(br, type) {
    this.data = br.readBytes(br.getSize());
    this.type = type;
    return this;
  }
}

/**
 * Parse a payload.
 * @param {Number} type
 * @param {Buffer} data
 * @returns {Packet}
 */

exports.decode = function decode(type, data) {
  switch (type) {
    case types.VERSION:
      return VersionPacket.decode(data);
    case types.VERACK:
      return VerackPacket.decode(data);
    case types.PING:
      return PingPacket.decode(data);
    case types.PONG:
      return PongPacket.decode(data);
    case types.GETADDR:
      return GetAddrPacket.decode(data);
    case types.ADDR:
      return AddrPacket.decode(data);
    case types.INV:
      return InvPacket.decode(data);
    case types.GETDATA:
      return GetDataPacket.decode(data);
    case types.NOTFOUND:
      return NotFoundPacket.decode(data);
    case types.GETBLOCKS:
      return GetBlocksPacket.decode(data);
    case types.GETHEADERS:
      return GetHeadersPacket.decode(data);
    case types.HEADERS:
      return HeadersPacket.decode(data);
    case types.SENDHEADERS:
      return SendHeadersPacket.decode(data);
    case types.BLOCK:
      return BlockPacket.decode(data);
    case types.TX:
      return TXPacket.decode(data);
    case types.REJECT:
      return RejectPacket.decode(data);
    case types.MEMPOOL:
      return MempoolPacket.decode(data);
    case types.FILTERLOAD:
      return FilterLoadPacket.decode(data);
    case types.FILTERADD:
      return FilterAddPacket.decode(data);
    case types.FILTERCLEAR:
      return FilterClearPacket.decode(data);
    case types.MERKLEBLOCK:
      return MerkleBlockPacket.decode(data);
    case types.FEEFILTER:
      return FeeFilterPacket.decode(data);
    case types.SENDCMPCT:
      return SendCmpctPacket.decode(data);
    case types.CMPCTBLOCK:
      return CmpctBlockPacket.decode(data);
    case types.GETBLOCKTXN:
      return GetBlockTxnPacket.decode(data);
    case types.BLOCKTXN:
      return BlockTxnPacket.decode(data);
    case types.GETPROOF:
      return GetProofPacket.decode(data);
    case types.PROOF:
      return ProofPacket.decode(data);
    case types.CLAIM:
      return ClaimPacket.decode(data);
    case types.AIRDROP:
      return AirdropPacket.decode(data);
    default:
      return UnknownPacket.decode(data, type);
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
exports.ClaimPacket = ClaimPacket;
exports.AirdropPacket = AirdropPacket;
exports.UnknownPacket = UnknownPacket;
