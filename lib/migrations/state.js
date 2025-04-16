/**
 * migrations/state.js - migration state for hsd.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License)
 */
'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {encoding} = bio;

/** @typedef {import('../types').BufioWriter} BufioWriter */

const EMPTY = Buffer.alloc(0);

/**
 * State of database migrations.
 * Because migration IDs are only increasing, we only need
 * to store the last one.
 * @alias module.migrations.MigrationState
 * @property {Boolean} inProgress - is/was migration in progress
 * NOTE: If inProgress is true, we know lastMigration + 1 was the one in
 *       progress.
 * @property {Number} lastMigration - last migration
 * NOTE: Migration numbers start from 1.
 *       0 - means there is no migration.
 */

class MigrationState extends bio.Struct {
  /**
   * Create MigrationState
   * @constructor
   */

  constructor() {
    super();

    this.version = 1;
    this.inProgress = false;
    this.nextMigration = 0;
    /** @type {Number[]} */
    this.skipped = [];

    this.inProgressData = EMPTY;
  }

  get lastMigration() {
    return this.nextMigration - 1;
  }

  /**
   * Inject properties from another state.
   * @param {MigrationState} obj
   * @returns MigrationState;
   */

  inject(obj) {
    assert(obj instanceof MigrationState);
    this.inProgress = obj.inProgress;
    this.nextMigration = obj.nextMigration;
    this.skipped = obj.skipped.slice();
    this.inProgressData = obj.inProgressData.slice();
    return this;
  }

  /**
   * Get size of the encoded migration state object.
   * @returns {Number}
   */

  getSize() {
    let size = 2; // flags
    size += 2; // version
    size += encoding.sizeVarint(this.nextMigration);
    size += encoding.sizeVarint(this.skipped.length);

    for (const id of this.skipped)
      size += encoding.sizeVarint(id);

    if (this.version > 0)
      size += encoding.sizeVarBytes(this.inProgressData);

    return size;
  }

  /**
   * Serialize migration state.
   * @param {BufioWriter} bw
   * @returns {BufioWriter}
   */

  write(bw) {
    let flags = 0;

    if (this.inProgress)
      flags |= 1 << 0;

    bw.writeU16(flags);
    bw.writeU16(this.version);
    bw.writeVarint(this.nextMigration);
    bw.writeVarint(this.skipped.length);

    for (const id of this.skipped)
      bw.writeVarint(id);

    if (this.version > 0)
      bw.writeVarBytes(this.inProgressData);

    return bw;
  }

  /**
   * Deserialize migration state.
   * @param {bio.BufferReader} br
   * @returns {this}
   */

  read(br) {
    const flags = br.readU16();
    this.inProgress = (flags & 1) !== 0;

    this.version = br.readU16();
    this.nextMigration = br.readVarint();
    this.skipped = [];

    const skippedItems = br.readVarint();

    for (let i = 0; i < skippedItems; i++)
      this.skipped.push(br.readVarint());

    if (this.version > 0)
      this.inProgressData = br.readVarBytes();

    return this;
  }
}

module.exports = MigrationState;
