'use strict';

const assert = require('bsert');
const bio = require('bufio');
const NameDelta = require('./namedelta');

class NameUndo extends bio.Struct {
  constructor() {
    super();
    this.names = [];
  }

  fromView(view) {
    assert(view && view.names);

    for (const ns of view.names.values()) {
      if (!ns.hasDelta())
        continue;

      this.names.push([ns.nameHash, ns.delta]);
    }

    return this;
  }

  getSize() {
    let size = 0;

    size += 4;

    for (const [, delta] of this.names) {
      size += 32;
      size += delta.getSize();
    }

    return size;
  }

  write(bw) {
    bw.writeU32(this.names.length);

    for (const [nameHash, delta] of this.names) {
      bw.writeBytes(nameHash);
      delta.write(bw);
    }

    return bw;
  }

  read(br) {
    const count = br.readU32();

    for (let i = 0; i < count; i++) {
      const nameHash = br.readBytes(32);
      const delta = NameDelta.read(br);

      this.names.push([nameHash, delta]);
    }

    return this;
  }

  static fromView(view) {
    return new this().fromView(view);
  }
}

module.exports = NameUndo;
