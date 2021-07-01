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
 * because migration IDs are only increasing, we only need
 * to store the last one.
 * @alias module.migrations.MigrationState
 * @property {Boolean} inProgress - is/was migration in progress
 * NOTE: If inProgress is true, we know lastMigration + 1 was the one in
 *       the progress.
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
    this.lastMigration = 0;
  }

  /**
   * Inject properties from another state.
   * @param {MigrationState} obj
   * @returns MigrationState;
   */

  inject(obj) {
    assert(obj instanceof MigrationState);
    this.inProgress = obj.inProgress;
    this.lastMigration = obj.lastMigration;
    return this;
  }

  /**
   * Get size of the encoded migration state object.
   * @returns {Number}
   */

  getSize() {
    // flags + last migration number
    return 4 + encoding.sizeVarint(this.lastMigration);
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
    bw.writeVarint(this.lastMigration);
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
    this.lastMigration = br.readVarint();
    return this;
  }
}

module.exports = MigrationState;
