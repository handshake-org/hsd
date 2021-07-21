/**
 * migrations/state.js - migration state for hsd.
 * Copyright (c) 2021, Nodari Chkuaselidze (MIT License)
 */
'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {encoding} = bio;

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

    this.inProgress = false;
    this.nextMigration = 0;
    this.skipped = [];
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
    return this;
  }

  /**
   * Get size of the encoded migration state object.
   * @returns {Number}
   */

  getSize() {
    // flags + last migration number
    let size = 4; // flags
    size += encoding.sizeVarint(this.nextMigration);
    size += encoding.sizeVarint(this.skipped.length);

    for (const id of this.skipped)
      size += encoding.sizeVarint(id);

    return size;
  }

  /**
   * Serialize migration state.
   * @param {BufferWriter} bw
   * @returns {BufferWriter}
   */

  write(bw) {
    let flags = 0;

    if (this.inProgress)
      flags |= 1 << 0;

    bw.writeU32(flags);
    bw.writeVarint(this.nextMigration);
    bw.writeVarint(this.skipped.length);

    for (const id of this.skipped)
      bw.writeVarint(id);

    return bw;
  }

  /**
   * Deserialize migration state.
   * @param {BufferReader}
   * @returns {MigrationState}
   */

  read(br) {
    const flags = br.readU32();

    this.inProgress = (flags & 1) !== 0;
    this.nextMigration = br.readVarint();
    this.skipped = [];

    const skippedItems = br.readVarint();

    for (let i = 0; i < skippedItems; i++)
      this.skipped.push(br.readVarint(0));

    return this;
  }
}

module.exports = MigrationState;
