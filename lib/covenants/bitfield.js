'use strict';

const assert = require('bsert');
const AirdropProof = require('../primitives/airdropproof');
const {TREE_LEAVES} = AirdropProof;

/**
 * Field
 */

class Field {
  constructor(size = 0) {
    assert((size >>> 0) === size);

    this.size = size;
    this.field = Buffer.alloc((size + 7) >>> 3, 0x00);
    this.dirty = false;
  }

  set(i, val) {
    assert((i >>> 0) === i);
    assert(i < this.size);
    assert((val >>> 0) === val);
    assert(val === 0 || val === 1);

    if (val)
      this.field[i >>> 3] |= 1 << (7 - (i & 7));
    else
      this.field[i >>> 3] &= ~(1 << (7 - (i & 7)));

    this.dirty = true;

    return this;
  }

  get(i) {
    assert((i >>> 0) === i);

    if (i >= this.size)
      return 1;

    return (this.field[i >>> 3] >> (7 - (i & 7))) & 1;
  }

  isSpent(i) {
    return Boolean(this.get(i));
  }

  spend(i) {
    return this.set(i, 1);
  }

  unspend(i) {
    return this.set(i, 0);
  }

  encode() {
    this.dirty = false;
    return this.field;
  }

  decode(data) {
    assert(Buffer.isBuffer(data));
    this.field = data;
    this.dirty = false;
    return this;
  }

  static decode(size, data) {
    return new this(size).decode(data);
  }
}

/**
 * BitField
 */

class BitField extends Field {
  constructor() {
    super(TREE_LEAVES);
  }

  static decode(data) {
    return new this().decode(data);
  }
}

/**
 * BitView
 */

class BitView {
  constructor() {
    this.bits = new Map();
  }

  spend(field, tx) {
    assert(field instanceof Field);
    assert(tx && tx.isCoinbase());

    for (let i = 1; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const output = tx.output(i);
      const {witness} = input;

      assert(output && witness.items.length === 1);

      const {covenant} = output;

      if (!covenant.isNone())
        continue;

      const proof = AirdropProof.decode(witness.items[0]);
      const index = proof.position();

      if (!this.bits.has(index))
        this.bits.set(index, field.get(index));

      if (this.bits.get(index) !== 0)
        return false;

      this.bits.set(index, 1);
    }

    return true;
  }

  undo(tx) {
    assert(tx && tx.isCoinbase());

    for (let i = 1; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const output = tx.output(i);
      const {witness} = input;

      assert(output && witness.items.length === 1);

      const {covenant} = output;

      if (!covenant.isNone())
        continue;

      const proof = AirdropProof.decode(witness.items[0]);
      const index = proof.position();

      this.bits.set(index, 0);
    }

    return this;
  }

  commit(field) {
    assert(field instanceof Field);

    for (const [bit, spent] of this.bits)
      field.set(bit, spent);

    return field.dirty;
  }
}

/*
 * Expose
 */

exports.Field = Field;
exports.BitField = BitField;
exports.BitView = BitView;
