'use strict';

const assert = require('bsert');
const {BufferMap} = require('buffer-map');
const NameState = require('./namestate');
const NameUndo = require('./undo');

class View {
  constructor() {
    this.names = new BufferMap();
  }

  getNameStateSync(db, nameHash) {
    assert(db && typeof db.getNameState === 'function');
    assert(Buffer.isBuffer(nameHash));

    const cache = this.names.get(nameHash);

    if (cache)
      return cache;

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

  async getNameState(db, nameHash) {
    assert(db && typeof db.getNameState === 'function');
    assert(Buffer.isBuffer(nameHash));

    const cache = this.names.get(nameHash);

    if (cache)
      return cache;

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
