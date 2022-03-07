/*!
 * blockstore/file.js - file blockstore for hsd
 * Copyright (c) 2019, Braydon Fuller (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const {isAbsolute, resolve, join} = require('path');
const bdb = require('bdb');
const assert = require('bsert');
const fs = require('bfile');
const bio = require('bufio');
const Network = require('../protocol/network');
const consensus = require('../protocol/consensus');
const Headers = require('../primitives/headers');
const AbstractBlockStore = require('./abstract');
const {BlockRecord, FileRecord} = require('./records');
const layout = require('./layout');
const {types, prefixes} = require('./common');

const WRITE = 0;
const PRUNE = 1;

/**
 * File Block Store
 *
 * @alias module:blockstore:FileBlockStore
 * @abstract
 */

class FileBlockStore extends AbstractBlockStore {
  /**
   * Create a blockstore that stores blocks in files.
   * @constructor
   */

  constructor(options) {
    super(options);

    assert(isAbsolute(options.location), 'Location not absolute.');

    this.location = options.location;
    this.indexLocation = resolve(this.location, './index');

    this.db = bdb.create({
      location: this.indexLocation,
      cacheSize: options.cacheSize,
      compression: false
    });
    this.name = 'fileblockstore';
    this.version = 0;

    this.maxFileLength = options.maxFileLength || 128 * 1024 * 1024;

    assert(Number.isSafeInteger(this.maxFileLength),
      'Invalid max file length.');

    this.network = Network.primary;

    if (options.network != null)
      this.network = Network.get(options.network);

    this.writing = Object.create(null);
  }

  /**
   * Compares the number of files in the directory
   * with the recorded number of files.
   * @param {Number} type - The type of block data
   * @private
   * @returns {Promise<Object>}
   */

  async check(type) {
    const prefix = prefixes[type];
    const regexp = new RegExp(`^${prefix}(\\d{5})\\.dat$`);
    const all = await fs.readdir(this.location);
    const dats = all.filter(f => regexp.test(f));
    const filenos = dats.map(f => parseInt(f.match(regexp)[1]));

    let missing = false;

    for (const fileno of filenos) {
      const rec = await this.db.get(layout.f.encode(type, fileno));
      if (!rec) {
        missing = true;
        break;
      }
    }

    return {missing, filenos};
  }

  /**
   * Creates indexes from files for a block type. Reads the hash of
   * the block data from the magic prefix, except for a block which
   * the hash is read from the block header.
   * @private
   * @param {Number} type - The type of block data
   * @returns {Promise}
   */

  async _index(type) {
    const {missing, filenos} = await this.check(type);

    if (!missing)
      return;

    this.logger.info('Indexing block type %d...', type);

    for (const fileno of filenos) {
      const b = this.db.batch();
      const filepath = this.filepath(type, fileno);
      const data = await fs.readFile(filepath);
      const reader = bio.read(data);
      let magic = null;
      let blocks = 0;

      while (reader.left() >= 4) {
        magic = reader.readU32();

        // Move forward a byte from the last read
        // if the magic doesn't match.
        if (magic !== this.network.magic) {
          reader.seek(-3);
          continue;
        }

        let hash = null;
        let position = 0;
        let length = 0;

        try {
          length = reader.readU32();

          if (type === types.BLOCK || type === types.MERKLE) {
            position = reader.offset;

            const headers = Headers.fromReader(reader);
            hash = headers.hash();

            reader.seek(length - consensus.HEADER_SIZE);
          } else {
            hash = reader.readHash();
            position = reader.offset;
            reader.seek(length);
          }
        } catch (err) {
          this.logger.warning(
            'Unknown block in file: %s, reason: %s',
            filepath, err.message);
          continue;
        }

        const blockrecord = new BlockRecord({
          file: fileno,
          position: position,
          length: length
        });

        blocks += 1;
        b.put(layout.b.encode(type, hash), blockrecord.encode());
      }

      const filerecord = new FileRecord({
        blocks: blocks,
        used: reader.offset,
        length: this.maxFileLength
      });

      b.put(layout.f.encode(type, fileno), filerecord.encode());

      await b.write();

      this.logger.info('Indexed %d blocks (file=%s).', blocks, filepath);
    }
  }

  /**
   * Compares the number of files in the directory
   * with the recorded number of files. If there are any
   * inconsistencies it will reindex all blocks.
   * @private
   * @returns {Promise}
   */

  async index() {
    await this._index(types.BLOCK);
    await this._index(types.UNDO);
    await this._index(types.MERKLE);
  }

  /**
   * This method ensures that both the block storage directory
   * and index directory exist.
   * before opening.
   * @returns {Promise}
   */

  async ensure() {
    return fs.mkdirp(this.indexLocation);
  }

  /**
   * Opens the file block store. It will regenerate necessary block
   * indexing if the index is missing or inconsistent.
   * @returns {Promise}
   */

  async open() {
    this.logger.info('Opening FileBlockStore...');

    await this.db.open();
    await this.db.verify(layout.V.encode(), this.name, this.version);

    await this.index();
  }

  /**
   * This closes the file block store and underlying
   * indexing databases.
   */

  async close() {
    this.logger.info('Closing FileBlockStore...');

    await this.db.close();
  }

  /**
   * This method will determine the file path based on the file number
   * and the current block data location.
   * @private
   * @param {Number} type - The type of block data
   * @param {Number} fileno - The number of the file.
   * @returns {Promise}
   */

  filepath(type, fileno) {
    const pad = 5;

    let num = fileno.toString(10);

    if (num.length > pad)
      throw new Error('File number too large.');

    while (num.length < pad)
      num = `0${num}`;

    let filepath = null;

    const prefix = prefixes[type];

    if (!prefix)
      throw new Error('Unknown file prefix.');

    filepath = join(this.location, `${prefix}${num}.dat`);

    return filepath;
  }

  /**
   * This method will select and potentially allocate a file to
   * write a block based on the size and type.
   * @private
   * @param {Number} type - The type of block data
   * @param {Number} length - The number of bytes
   * @returns {Promise}
   */

  async allocate(type, length) {
    if (length > this.maxFileLength)
      throw new Error('Block length above max file length.');

    let fileno = 0;
    let filerecord = null;
    let filepath = null;

    const last = await this.db.get(layout.F.encode(type));
    if (last)
      fileno = bio.readU32(last, 0);

    filepath = this.filepath(type, fileno);

    const rec = await this.db.get(layout.f.encode(type, fileno));

    let touch = false;

    if (rec) {
      filerecord = FileRecord.decode(rec);
    } else {
      touch = true;
      filerecord = new FileRecord({
        blocks: 0,
        used: 0,
        length: this.maxFileLength
      });
    }

    if (filerecord.used + length > filerecord.length) {
      fileno += 1;
      filepath = this.filepath(type, fileno);
      touch = true;
      filerecord = new FileRecord({
        blocks: 0,
        used: 0,
        length: this.maxFileLength
      });
    }

    if (touch) {
      const fd = await fs.open(filepath, 'w');
      await fs.close(fd);
    }

    return {fileno, filerecord, filepath};
  }

  /**
   * This method stores merkle block data in files.
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async writeMerkle(hash, data) {
    return this._write(types.MERKLE, hash, data);
  }

  /**
   * This method stores block undo coin data in files.
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async writeUndo(hash, data) {
    return this._write(types.UNDO, hash, data);
  }

  /**
   * This method stores block data in files.
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async writeBlock(hash, data) {
    return this._write(types.BLOCK, hash, data);
  }

  /**
   * This method stores block data in files with by appending
   * data to the last written file and updating indexes to point
   * to the file and position.
   * @private
   * @param {Number} type - The type of block data
   * @param {Buffer} hash - The block hash
   * @param {Buffer} data - The block data
   * @returns {Promise}
   */

  async _write(type, hash, data) {
    if (this.writing[type])
      throw new Error('Already writing.');

    this.writing[type] = true;

    if (await this.db.has(layout.b.encode(type, hash))) {
      this.writing[type] = false;
      return false;
    }

    let mlength = 8;

    // Hash for a block is not stored with
    // the magic prefix as it's read from the header
    // of the block data.
    if (type !== types.BLOCK && type !== types.MERKLE)
      mlength += 32;

    const blength = data.length;
    const length = data.length + mlength;

    const bwm = bio.write(mlength);

    bwm.writeU32(this.network.magic);
    bwm.writeU32(blength);

    if (type !== types.BLOCK && type !== types.MERKLE)
      bwm.writeHash(hash);

    const magic = bwm.render();

    const {
      fileno,
      filerecord,
      filepath
    } = await this.allocate(type, length);

    const mposition = filerecord.used;
    const bposition = filerecord.used + mlength;

    const fd = await fs.open(filepath, 'r+');

    let mwritten = 0;
    let bwritten = 0;

    try {
      mwritten = await fs.write(fd, magic, 0, mlength, mposition);
      bwritten = await fs.write(fd, data, 0, blength, bposition);
    } finally {
      await fs.close(fd);
    }

    if (mwritten !== mlength) {
      this.writing[type] = false;
      throw new Error('Could not write block magic.');
    }

    if (bwritten !== blength) {
      this.writing[type] = false;
      throw new Error('Could not write block.');
    }

    filerecord.blocks += 1;
    filerecord.used += length;

    const b = this.db.batch();

    const blockrecord = new BlockRecord({
      file: fileno,
      position: bposition,
      length: blength
    });

    b.put(layout.b.encode(type, hash), blockrecord.encode());
    b.put(layout.f.encode(type, fileno), filerecord.encode());

    const last = bio.write(4).writeU32(fileno).render();
    b.put(layout.F.encode(type), last);

    await b.write();

    this.writing[type] = false;

    return true;
  }

  /**
   * This method will retrieve merkle block data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async readMerkle(hash) {
    return this._read(types.MERKLE, hash);
  }

  /**
   * This method will retrieve block undo coin data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async readUndo(hash) {
    return this._read(types.UNDO, hash);
  }

  /**
   * This method will retrieve block data. Smaller portions of the
   * block (e.g. transactions) can be read by using the offset and
   * length arguments.
   * @param {Buffer} hash - The block hash
   * @param {Number} offset - The offset within the block
   * @param {Number} length - The number of bytes of the data
   * @returns {Promise}
   */

  async readBlock(hash, offset, length) {
    return this._read(types.BLOCK, hash, offset, length);
  }

  /**
   * This methods reads data from disk by retrieving the index of
   * the data and reading from the corresponding file and location.
   * @private
   * @param {Number} type - The type of block data
   * @param {Buffer} hash - The block hash
   * @param {Number} offset - The offset within the block
   * @param {Number} length - The number of bytes of the data
   * @returns {Promise}
   */

  async _read(type, hash, offset, length) {
    const raw = await this.db.get(layout.b.encode(type, hash));
    if (!raw)
      return null;

    const blockrecord = BlockRecord.decode(raw);

    const filepath = this.filepath(type, blockrecord.file);

    let position = blockrecord.position;

    if (offset)
      position += offset;

    if (!length && offset > 0)
      length = blockrecord.length - offset;

    if (!length)
      length = blockrecord.length;

    if (offset + length > blockrecord.length)
      throw new Error('Out-of-bounds read.');

    const data = Buffer.alloc(length);

    const fd = await fs.open(filepath, 'r');
    let bytes = 0;

    try {
      bytes = await fs.read(fd, data, 0, length, position);
    } finally {
      await fs.close(fd);
    }

    if (bytes !== length)
      throw new Error('Wrong number of bytes read.');

    return data;
  }

  /**
   * This will free resources for storing merkle block data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async pruneMerkle(hash) {
    return this._prune(types.MERKLE, hash);
  }

  /**
   * This will free resources for storing the block undo coin data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async pruneUndo(hash) {
    return this._prune(types.UNDO, hash);
  }

  /**
   * This will free resources for storing the block data.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async pruneBlock(hash) {
    return this._prune(types.BLOCK, hash);
  }

  /**
   * This will free resources for storing the block data. The block
   * data may not be deleted from disk immediately, the index for the
   * block is removed and will not be able to be read. The underlying
   * file is unlinked when all blocks in a file have been pruned.
   * @private
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async _prune(type, hash) {
    const braw = await this.db.get(layout.b.encode(type, hash));
    if (!braw)
      return false;

    const blockrecord = BlockRecord.decode(braw);

    const fraw = await this.db.get(layout.f.encode(type, blockrecord.file));
    if (!fraw)
      return false;

    const filerecord = FileRecord.decode(fraw);

    filerecord.blocks -= 1;

    const b = this.db.batch();

    if (filerecord.blocks === 0)
      b.del(layout.f.encode(type, blockrecord.file));
    else
      b.put(layout.f.encode(type, blockrecord.file), filerecord.encode());

    b.del(layout.b.encode(type, hash));

    await b.write();

    if (filerecord.blocks === 0)
      await fs.unlink(this.filepath(type, blockrecord.file));

    return true;
  }

  /**
   * This will check if merkle block data has been stored
   * and is available.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async hasMerkle(hash) {
    return await this.db.has(layout.b.encode(types.MERKLE, hash));
  }

  /**
   * This will check if a block undo coin has been stored
   * and is available.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async hasUndo(hash) {
    return await this.db.has(layout.b.encode(types.UNDO, hash));
  }

  /**
   * This will check if a block has been stored and is available.
   * @param {Buffer} hash - The block hash
   * @returns {Promise}
   */

  async hasBlock(hash) {
    return await this.db.has(layout.b.encode(types.BLOCK, hash));
  }

  /**
   * Create batch.
   * @returns {FileBatch}
   */

  batch() {
    return new FileBatch(this);
  }
}

/**
 * Batch operations for fileblockstore.
 * Currently, this is not meant for atomicity or performance improvements,
 * but to have better interface for chaindb.
 * Proper implementation could use single batch for
 * leveldb updates after all file writes.
 * @alias module:blockstore.FileBatch
 */

class FileBatch {
  /**
   * Create AbstractBatch.
   * @constructor
   */

  constructor(blocks) {
    this.blocks = blocks;
    this.writes = [];
    this.prunes = [];
    this.committedWrites = false;
    this.committedPrunes = false;
  }

  get written() {
    return this.committedWrites && this.committedPrunes;
  }

  /**
   * Write merkle block data to the batch.
   * @property {Buffer} hash
   * @property {Buffer} data
   * @returns {Batch}
   */

  writeMerkle(hash, data) {
    this.writes.push(new WriteOp(types.MERKLE, hash, data));
  }

  /**
   * Write undo coin data to the batch.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Batch}
   */

  writeUndo(hash, data) {
    this.writes.push(new WriteOp(types.UNDO, hash, data));
  }

  /**
   * Write block data to the batch.
   * @param {Buffer} hash
   * @param {Buffer} data
   * @returns {Batch}
   */

  writeBlock(hash, data) {
    this.writes.push(new WriteOp(types.BLOCK, hash, data));
  }

  /**
   * Remove merkle block data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneMerkle(hash) {
    this.prunes.push(new PruneOp(types.MERKLE, hash));
  }

  /**
   * Remove undo data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneUndo(hash) {
    this.prunes.push(new PruneOp(types.UNDO, hash));
  }

  /**
   * Prune block data from the batch.
   * @param {Buffer} hash
   * @returns {Batch}
   */

  pruneBlock(hash) {
    this.prunes.push(new PruneOp(types.BLOCK, hash));
  }

  /**
   * Clear the batch.
   * @returns {Batch}
   */

  clear() {
    assert(!this.written, 'Already written all.');
    this.writes.length = 0;
    this.prunes.length = 0;
  }

  /**
   * Commit only writes.
   * @returns {Promise}
   */

  async commitWrites() {
    assert(!this.committedWrites, 'Already written writes.');

    for (const op of this.writes)
      await this.blocks._write(op.writeType, op.hash, op.data);

    this.committedWrites = true;
  }

  /**
   * Commit only prunes.
   * @returns {Promise}
   */

  async commitPrunes() {
    assert(!this.committedPrunes, 'Already written prunes.');

    for (const op of this.prunes)
      await this.blocks._prune(op.pruneType, op.hash);

    this.committedPrunes = true;
  }

  /**
   * Commit both.
   * @returns {Promise}
   */

  async commit() {
    assert(!this.written, 'Already written all.');

    await this.commitWrites();
    await this.commitPrunes();
  }
}

class WriteOp {
  constructor(type, hash, data) {
    this.type = WRITE;
    this.writeType = type;
    this.hash = hash;
    this.data = data;
  }
}

class PruneOp {
  constructor(type, hash) {
    this.type = PRUNE;
    this.pruneType = type;
    this.hash = hash;
  }
}

/*
 * Expose
 */

module.exports = FileBlockStore;
