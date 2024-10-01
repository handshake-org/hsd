'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const NameState = require('./namestate');
const NameUndo = require('./undo');

/** @typedef {import('../types').Hash} Hash */

class View {
  constructor() {
    /** @type {BufferMap<NameState>} */
    this.names = new BufferMap();
  }

  /**
   * @param {Object} db
   * @param {Hash} nameHash
   * @returns {NameState}
   */

  getNameStateSync(db, nameHash) {
    assert(db && typeof db.getNameState === 'function');
    assert(Buffer.isBuffer(nameHash));

    const cache = this.names.get(nameHash);

    if (cache)
      return cache;

    /** @type {NameState?} */
    const ns = db.getNameState(nameHash);

    if (!ns) {
      const ns = new NameState();
      ns.nameHash = nameHash;
      this.names.set(nameHash, ns);
      return ns;
    }

    this.names.set(nameHash, ns);

    return ns;
  }

  /**
   * @param {Object} db
   * @param {Hash} nameHash
   * @returns {Promise<NameState>}
   */

  async getNameState(db, nameHash) {
    assert(db && typeof db.getNameState === 'function');
    assert(Buffer.isBuffer(nameHash));

    const cache = this.names.get(nameHash);

    if (cache)
      return cache;

    /** @type {NameState?} */
    const ns = await db.getNameState(nameHash);

    if (!ns) {
      const ns = new NameState();
      ns.nameHash = nameHash;
      this.names.set(nameHash, ns);
      return ns;
    }

    this.names.set(nameHash, ns);

    return ns;
  }

  toNameUndo() {
    return NameUndo.fromView(this);
  }
}

module.exports = View;
