/*!
 * tx.js - transaction object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const secp256k1 = require('bcrypto/lib/secp256k1');
const {BufferSet} = require('buffer-map');
const util = require('../utils/util');
const Amount = require('../ui/amount');
const Network = require('../protocol/network');
const Script = require('../script/script');
const Input = require('./input');
const Output = require('./output');
const Outpoint = require('./outpoint');
const rules = require('../covenants/rules');
const InvItem = require('./invitem');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const ScriptError = require('../script/scripterror');
const {OwnershipProof} = require('../covenants/ownership');
const AirdropProof = require('../primitives/airdropproof');
const {encoding} = bio;
const {hashType} = Script;

/**
 * TX
 * A static transaction object.
 * @alias module:primitives.TX
 * @property {Number} version
 * @property {Input[]} inputs
 * @property {Output[]} outputs
 * @property {Number} locktime
 */

class TX extends bio.Struct {
  /**
   * Create a transaction.
   * @constructor
   * @param {Object?} options
   */

  constructor(options) {
    super();

    this.version = 0;
    this.inputs = [];
    this.outputs = [];
    this.locktime = 0;

    this.mutable = false;

    this._hash = null;
    this._wdhash = null;
    this._whash = null;

    this._raw = null;
    this._sizes = null;

    this._hashPrevouts = null;
    this._hashSequence = null;
    this._hashOutputs = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'TX data is required.');

    if (options.version != null) {
      assert((options.version >>> 0) === options.version,
        'Version must be a uint32.');
      this.version = options.version;
    }

    if (options.inputs) {
      assert(Array.isArray(options.inputs), 'Inputs must be an array.');
      for (const input of options.inputs)
        this.inputs.push(new Input(input));
    }

    if (options.outputs) {
      assert(Array.isArray(options.outputs), 'Outputs must be an array.');
      for (const output of options.outputs)
        this.outputs.push(new Output(output));
    }

    if (options.locktime != null) {
      assert((options.locktime >>> 0) === options.locktime,
        'Locktime must be a uint32.');
      this.locktime = options.locktime;
    }

    return this;
  }

  /**
   * Inject properties from tx.
   * Used for cloning.
   * @private
   * @param {TX} tx
   * @returns {TX}
   */

  inject(tx) {
    this.version = tx.version;

    for (const input of tx.inputs)
      this.inputs.push(input.clone());

    for (const output of tx.outputs)
      this.outputs.push(output.clone());

    this.locktime = tx.locktime;

    return this;
  }

  /**
   * Clear any cached values.
   */

  refresh() {
    this._hash = null;
    this._wdhash = null;
    this._whash = null;

    this._raw = null;
    this._sizes = null;

    this._hashPrevouts = null;
    this._hashSequence = null;
    this._hashOutputs = null;

    return this;
  }

  /**
   * Hash the transaction with the non-witness serialization.
   * @returns {Hash} hash
   */

  hash() {
    if (this.mutable)
      return this.left();

    if (!this._hash)
      this._hash = this.left();

    return this._hash;
  }

  /**
   * Hash the transaction with the witness
   * serialization, return the wtxid (normal
   * hash if no witness is present, all zeroes
   * if coinbase).
   * @returns {Hash} hash
   */

  witnessHash() {
    if (this.mutable)
      return this.root();

    if (!this._whash)
      this._whash = this.root();

    return this._whash;
  }

  /**
   * Calculate the virtual size of the transaction.
   * Note that this is cached.
   * @returns {Number} vsize
   */

  getVirtualSize() {
    const scale = consensus.WITNESS_SCALE_FACTOR;
    return (this.getWeight() + scale - 1) / scale | 0;
  }

  /**
   * Calculate the virtual size of the transaction
   * (weighted against bytes per sigop cost).
   * @param {Number} sigops - Sigops cost.
   * @returns {Number} vsize
   */

  getSigopsSize(sigops) {
    const scale = consensus.WITNESS_SCALE_FACTOR;
    const bytes = policy.BYTES_PER_SIGOP;
    const weight = Math.max(this.getWeight(), sigops * bytes);
    return (weight + scale - 1) / scale | 0;
  }

  /**
   * Calculate the weight of the transaction.
   * Note that this is cached.
   * @returns {Number} weight
   */

  getWeight() {
    const {base, witness} = this.getSizes();
    const total = base + witness;
    return base * (consensus.WITNESS_SCALE_FACTOR - 1) + total;
  }

  /**
   * Calculate the real size of the transaction
   * with the witness included.
   * @returns {Number} size
   */

  getSize() {
    const {base, witness} = this.getSizes();
    return base + witness;
  }

  /**
   * Calculate the size of the transaction
   * without the witness.
   * with the witness included.
   * @returns {Number} size
   */

  getBaseSize() {
    const {base} = this.getSizes();
    return base;
  }

  /**
   * Test whether the transaction has a non-empty witness.
   * @returns {Boolean}
   */

  hasWitness() {
    for (const {witness} of this.inputs) {
      if (witness.items.length > 0)
        return true;
    }

    return false;
  }

  /**
   * Get the signature hash of the transaction for signing verifying.
   * @param {Number} index - Index of input being signed/verified.
   * @param {Script} prev - Previous output script or redeem script
   * (in the case of witnesspubkeyhash, this should be the generated
   * p2pkh script).
   * @param {Amount} value - Previous output value.
   * @param {SighashType} type - Sighash type.
   * @returns {Buffer} Signature hash.
   */

  signatureHash(index, prev, value, type) {
    assert(index >= 0 && index < this.inputs.length);
    assert(prev instanceof Script);
    assert(typeof value === 'number');
    assert(typeof type === 'number');

    let input = this.inputs[index];
    let prevouts = consensus.ZERO_HASH;
    let sequences = consensus.ZERO_HASH;
    let outputs = consensus.ZERO_HASH;

    if (type & hashType.NOINPUT)
      input = new Input();

    if (!(type & hashType.ANYONECANPAY)) {
      if (this._hashPrevouts) {
        prevouts = this._hashPrevouts;
      } else {
        const bw = bio.pool(this.inputs.length * 36);

        for (const input of this.inputs)
          input.prevout.write(bw);

        prevouts = blake2b.digest(bw.render());

        if (!this.mutable)
          this._hashPrevouts = prevouts;
      }
    }

    if (!(type & hashType.ANYONECANPAY)
        && (type & 0x1f) !== hashType.SINGLE
        && (type & 0x1f) !== hashType.SINGLEREVERSE
        && (type & 0x1f) !== hashType.NONE) {
      if (this._hashSequence) {
        sequences = this._hashSequence;
      } else {
        const bw = bio.pool(this.inputs.length * 4);

        for (const input of this.inputs)
          bw.writeU32(input.sequence);

        sequences = blake2b.digest(bw.render());

        if (!this.mutable)
          this._hashSequence = sequences;
      }
    }

    if ((type & 0x1f) !== hashType.SINGLE
        && (type & 0x1f) !== hashType.SINGLEREVERSE
        && (type & 0x1f) !== hashType.NONE) {
      if (this._hashOutputs) {
        outputs = this._hashOutputs;
      } else {
        let size = 0;

        for (const output of this.outputs)
          size += output.getSize();

        const bw = bio.pool(size);

        for (const output of this.outputs)
          output.write(bw);

        outputs = blake2b.digest(bw.render());

        if (!this.mutable)
          this._hashOutputs = outputs;
      }
    } else if ((type & 0x1f) === hashType.SINGLE) {
      if (index < this.outputs.length) {
        const output = this.outputs[index];
        outputs = blake2b.digest(output.encode());
      }
    } else if ((type & 0x1f) === hashType.SINGLEREVERSE) {
      if (index < this.outputs.length) {
        const output = this.outputs[(this.outputs.length - 1) - index];
        outputs = blake2b.digest(output.encode());
      }
    }

    const size = 156 + prev.getVarSize();
    const bw = bio.pool(size);

    bw.writeU32(this.version);
    bw.writeBytes(prevouts);
    bw.writeBytes(sequences);
    bw.writeHash(input.prevout.hash);
    bw.writeU32(input.prevout.index);
    bw.writeVarBytes(prev.encode());
    bw.writeU64(value);
    bw.writeU32(input.sequence);
    bw.writeBytes(outputs);
    bw.writeU32(this.locktime);
    bw.writeU32(type);

    return blake2b.digest(bw.render());
  }

  /**
   * Verify signature.
   * @param {Number} index
   * @param {Script} prev
   * @param {Amount} value
   * @param {Buffer} sig
   * @param {Buffer} key
   * @returns {Boolean}
   */

  checksig(index, prev, value, sig, key) {
    if (sig.length === 0)
      return false;

    const type = sig[sig.length - 1];
    const hash = this.signatureHash(index, prev, value, type);

    return secp256k1.verify(hash, sig.slice(0, -1), key);
  }

  /**
   * Create a signature suitable for inserting into scriptSigs/witnesses.
   * @param {Number} index - Index of input being signed.
   * @param {Script} prev - Previous output script or redeem script
   * (in the case of witnesspubkeyhash, this should be the generated
   * p2pkh script).
   * @param {Amount} value - Previous output value.
   * @param {Buffer} key
   * @param {SighashType} type
   * @returns {Buffer} Signature in DER format.
   */

  signature(index, prev, value, key, type) {
    if (type == null)
      type = hashType.ALL;

    const hash = this.signatureHash(index, prev, value, type);
    const sig = secp256k1.sign(hash, key);
    const bw = bio.write(65);

    bw.writeBytes(sig);
    bw.writeU8(type);

    return bw.render();
  }

  /**
   * Verify all transaction inputs.
   * @param {CoinView} view
   * @param {VerifyFlags?} [flags=STANDARD_VERIFY_FLAGS]
   * @throws {ScriptError} on invalid inputs
   */

  check(view, flags) {
    if (this.inputs.length === 0)
      throw new ScriptError('UNKNOWN_ERROR', 'No inputs.');

    if (this.isCoinbase()) {
      for (let i = 1; i < this.inputs.length; i++) {
        const {witness} = this.inputs[i];

        if (witness.items.length !== 1)
          throw new ScriptError('UNKNOWN_ERROR', 'Invalid claim proof.');

        if (i >= this.outputs.length)
          throw new ScriptError('UNKNOWN_ERROR', 'Invalid claim proof.');

        const output = this.outputs[i];

        if (!output.covenant.isClaim()) {
          assert(output.covenant.isNone());

          let proof;
          try {
            proof = AirdropProof.decode(witness.items[0]);
          } catch (e) {
            throw new ScriptError('UNKNOWN_ERROR', 'Invalid airdrop proof.');
          }

          if (!proof.isSane())
            throw new ScriptError('UNKNOWN_ERROR', 'Non-sane airdrop proof.');

          if (!proof.verify()) {
            throw new ScriptError('UNKNOWN_ERROR',
                                  'Invalid airdrop signature.');
          }

          if (output.value !== proof.getValue() - proof.fee
              || output.address.version !== proof.version
              || !output.address.hash.equals(proof.address)) {
            throw new ScriptError('UNKNOWN_ERROR', 'Invalid airdrop output.');
          }

          continue;
        }

        let proof;
        try {
          proof = OwnershipProof.decode(witness.items[0]);
        } catch (e) {
          throw new ScriptError('UNKNOWN_ERROR', 'Invalid claim proof.');
        }

        if (!proof.isSane())
          throw new ScriptError('UNKNOWN_ERROR', 'Non-sane claim proof.');

        if (!proof.verifySignatures())
          throw new ScriptError('UNKNOWN_ERROR', 'Invalid claim signatures.');
      }

      return;
    }

    for (let i = 0; i < this.inputs.length; i++) {
      const {prevout} = this.inputs[i];
      const coin = view.getOutput(prevout);

      if (!coin)
        throw new ScriptError('UNKNOWN_ERROR', 'No coin available.');

      this.checkInput(i, coin, flags);
    }
  }

  /**
   * Verify a transaction input.
   * @param {Number} index - Index of output being
   * verified.
   * @param {Coin|Output} coin - Previous output.
   * @param {VerifyFlags} [flags=STANDARD_VERIFY_FLAGS]
   * @throws {ScriptError} on invalid input
   */

  checkInput(index, coin, flags) {
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert(coin, 'No coin passed.');

    Script.verify(
      input.witness,
      coin.address,
      this,
      index,
      coin.value,
      flags
    );
  }

  /**
   * Verify the transaction inputs on the worker pool
   * (if workers are enabled).
   * @param {CoinView} view
   * @param {VerifyFlags?} [flags=STANDARD_VERIFY_FLAGS]
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async checkAsync(view, flags, pool) {
    if (this.inputs.length === 0)
      throw new ScriptError('UNKNOWN_ERROR', 'No inputs.');

    if (!pool) {
      this.check(view, flags);
      return undefined;
    }

    return pool.check(this, view, flags);
  }

  /**
   * Verify a transaction input asynchronously.
   * @param {Number} index - Index of output being
   * verified.
   * @param {Coin|Output} coin - Previous output.
   * @param {VerifyFlags} [flags=STANDARD_VERIFY_FLAGS]
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async checkInputAsync(index, coin, flags, pool) {
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert(coin, 'No coin passed.');

    if (!pool) {
      this.checkInput(index, coin, flags);
      return undefined;
    }

    return pool.checkInput(this, index, coin, flags);
  }

  /**
   * Verify all transaction inputs.
   * @param {CoinView} view
   * @param {VerifyFlags?} [flags=STANDARD_VERIFY_FLAGS]
   * @returns {Boolean} Whether the inputs are valid.
   */

  verify(view, flags) {
    try {
      this.check(view, flags);
    } catch (e) {
      if (e.type === 'ScriptError')
        return false;
      throw e;
    }
    return true;
  }

  /**
   * Verify a transaction input.
   * @param {Number} index - Index of output being
   * verified.
   * @param {Coin|Output} coin - Previous output.
   * @param {VerifyFlags} [flags=STANDARD_VERIFY_FLAGS]
   * @returns {Boolean} Whether the input is valid.
   */

  verifyInput(index, coin, flags) {
    try {
      this.checkInput(index, coin, flags);
    } catch (e) {
      if (e.type === 'ScriptError')
        return false;
      throw e;
    }
    return true;
  }

  /**
   * Verify the transaction inputs on the worker pool
   * (if workers are enabled).
   * @param {CoinView} view
   * @param {VerifyFlags?} [flags=STANDARD_VERIFY_FLAGS]
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async verifyAsync(view, flags, pool) {
    try {
      await this.checkAsync(view, flags, pool);
    } catch (e) {
      if (e.type === 'ScriptError')
        return false;
      throw e;
    }
    return true;
  }

  /**
   * Verify a transaction input asynchronously.
   * @param {Number} index - Index of output being
   * verified.
   * @param {Coin|Output} coin - Previous output.
   * @param {VerifyFlags} [flags=STANDARD_VERIFY_FLAGS]
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async verifyInputAsync(index, coin, flags, pool) {
    try {
      await this.checkInput(index, coin, flags, pool);
    } catch (e) {
      if (e.type === 'ScriptError')
        return false;
      throw e;
    }
    return true;
  }

  /**
   * Test whether the transaction is a coinbase
   * by examining the inputs.
   * @returns {Boolean}
   */

  isCoinbase() {
    return this.inputs.length > 0 && this.inputs[0].prevout.isNull();
  }

  /**
   * Calculate the fee for the transaction.
   * @param {CoinView} view
   * @returns {Amount} fee (zero if not all coins are available).
   */

  getFee(view) {
    if (!this.hasCoins(view))
      return 0;

    return this.getInputValue(view) - this.getOutputValue();
  }

  /**
   * Calculate the total input value.
   * @param {CoinView} view
   * @returns {Amount} value
   */

  getInputValue(view) {
    let total = 0;

    for (const {prevout} of this.inputs) {
      const coin = view.getOutput(prevout);

      if (!coin)
        return 0;

      total += coin.value;
    }

    return total;
  }

  /**
   * Calculate the total output value.
   * @returns {Amount} value
   */

  getOutputValue() {
    let total = 0;

    for (const output of this.outputs)
      total += output.value;

    return total;
  }

  /**
   * Get all input addresses.
   * @private
   * @param {CoinView} view
   * @returns {Array} [addrs, table]
   */

  _getInputAddresses(view) {
    const table = new BufferSet();
    const addrs = [];

    if (this.isCoinbase())
      return [addrs, table];

    for (const input of this.inputs) {
      const coin = view ? view.getOutputFor(input) : null;
      const addr = input.getAddress(coin);

      if (!addr)
        continue;

      const hash = addr.getHash();

      if (!table.has(hash)) {
        table.add(hash);
        addrs.push(addr);
      }
    }

    return [addrs, table];
  }

  /**
   * Get all output addresses.
   * @private
   * @returns {Array} [addrs, table]
   */

  _getOutputAddresses() {
    const table = new BufferSet();
    const addrs = [];

    for (const output of this.outputs) {
      const addr = output.getAddress();

      if (!addr)
        continue;

      const hash = addr.getHash();

      if (!table.has(hash)) {
        table.add(hash);
        addrs.push(addr);
      }
    }

    return [addrs, table];
  }

  /**
   * Get all addresses.
   * @private
   * @param {CoinView} view
   * @returns {Array} [addrs, table]
   */

  _getAddresses(view) {
    const [addrs, table] = this._getInputAddresses(view);
    const output = this.getOutputAddresses();

    for (const addr of output) {
      const hash = addr.getHash();

      if (!table.has(hash)) {
        table.add(hash);
        addrs.push(addr);
      }
    }

    return [addrs, table];
  }

  /**
   * Get all input addresses.
   * @param {CoinView|null} view
   * @returns {Address[]} addresses
   */

  getInputAddresses(view) {
    const [addrs] = this._getInputAddresses(view);
    return addrs;
  }

  /**
   * Get all output addresses.
   * @returns {Address[]} addresses
   */

  getOutputAddresses() {
    const [addrs] = this._getOutputAddresses();
    return addrs;
  }

  /**
   * Get all addresses.
   * @param {CoinView|null} view
   * @returns {Address[]} addresses
   */

  getAddresses(view) {
    const [addrs] = this._getAddresses(view);
    return addrs;
  }

  /**
   * Get all input address hashes.
   * @param {CoinView|null} view
   * @returns {Hash[]} hashes
   */

  getInputHashes(view) {
    const [, table] = this._getInputAddresses(view);
    return table.toArray();
  }

  /**
   * Get all output address hashes.
   * @returns {Hash[]} hashes
   */

  getOutputHashes() {
    const [, table] = this._getOutputAddresses();
    return table.toArray();
  }

  /**
   * Get all address hashes.
   * @param {CoinView|null} view
   * @returns {Hash[]} hashes
   */

  getHashes(view) {
    const [, table] = this._getAddresses(view);
    return table.toArray();
  }

  /**
   * Test whether the transaction has
   * all coins available.
   * @param {CoinView} view
   * @returns {Boolean}
   */

  hasCoins(view) {
    if (this.inputs.length === 0)
      return false;

    for (const {prevout} of this.inputs) {
      if (!view.hasEntry(prevout))
        return false;
    }

    return true;
  }

  /**
   * Check finality of transaction by examining
   * nLocktime and nSequence values.
   * @example
   * tx.isFinal(chain.height + 1, network.now());
   * @param {Number} height - Height at which to test. This
   * is usually the chain height, or the chain height + 1
   * when the transaction entered the mempool.
   * @param {Number} time - Time at which to test. This is
   * usually the chain tip's parent's median time, or the
   * time at which the transaction entered the mempool. If
   * MEDIAN_TIME_PAST is enabled this will be the median
   * time of the chain tip's previous entry's median time.
   * @returns {Boolean}
   */

  isFinal(height, time) {
    const FLAG = consensus.LOCKTIME_FLAG;
    const MASK = consensus.LOCKTIME_MASK;
    const MULT = consensus.LOCKTIME_MULT;

    if (this.locktime === 0)
      return true;

    if (this.locktime & FLAG) {
      const locktime = this.locktime & MASK;

      if ((locktime * MULT) < time)
        return true;
    } else {
      if (this.locktime < height)
        return true;
    }

    for (const input of this.inputs) {
      if (input.sequence !== 0xffffffff)
        return false;
    }

    return true;
  }

  /**
   * Verify the absolute locktime of a transaction.
   * Called by OP_CHECKLOCKTIMEVERIFY.
   * @param {Number} index - Index of input being verified.
   * @param {Number} predicate - Locktime to verify against.
   * @returns {Boolean}
   */

  verifyLocktime(index, predicate) {
    const FLAG = consensus.LOCKTIME_FLAG;
    const MASK = consensus.LOCKTIME_MASK;
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert(predicate >= 0, 'Locktime must be non-negative.');

    // Locktimes must be of the same type (blocks or seconds).
    if ((this.locktime & FLAG) !== (predicate & FLAG))
      return false;

    if ((predicate & MASK) > (this.locktime & MASK))
      return false;

    if (input.sequence === 0xffffffff)
      return false;

    return true;
  }

  /**
   * Verify the relative locktime of an input.
   * Called by OP_CHECKSEQUENCEVERIFY.
   * @param {Number} index - Index of input being verified.
   * @param {Number} predicate - Relative locktime to verify against.
   * @returns {Boolean}
   */

  verifySequence(index, predicate) {
    const DISABLE_FLAG = consensus.SEQUENCE_DISABLE_FLAG;
    const TYPE_FLAG = consensus.SEQUENCE_TYPE_FLAG;
    const MASK = consensus.SEQUENCE_MASK;
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert(predicate >= 0, 'Locktime must be non-negative.');

    // For future softfork capability.
    if (predicate & DISABLE_FLAG)
      return true;

    // Cannot use the disable flag without
    // the predicate also having the disable
    // flag (for future softfork capability).
    if (input.sequence & DISABLE_FLAG)
      return false;

    // Locktimes must be of the same type (blocks or seconds).
    if ((input.sequence & TYPE_FLAG) !== (predicate & TYPE_FLAG))
      return false;

    if ((predicate & MASK) > (input.sequence & MASK))
      return false;

    return true;
  }

  /**
   * Calculate sigops.
   * @param {CoinView} view
   * @returns {Number}
   */

  getSigops(view) {
    if (this.isCoinbase())
      return 0;

    let total = 0;

    for (const input of this.inputs) {
      const coin = view.getOutputFor(input);

      if (!coin)
        continue;

      total += coin.address.getSigops(input.witness);
    }

    return total;
  }

  /**
   * Non-contextual sanity checks for the transaction.
   * Will mostly verify coin and output values.
   * @see CheckTransaction()
   * @returns {Array} [result, reason, score]
   */

  isSane() {
    const [valid] = this.checkSanity();
    return valid;
  }

  /**
   * Non-contextual sanity checks for the transaction.
   * Will mostly verify coin and output values.
   * @see CheckTransaction()
   * @returns {Array} [valid, reason, score]
   */

  checkSanity() {
    if (this.inputs.length === 0)
      return [false, 'bad-txns-vin-empty', 100];

    if (this.outputs.length === 0)
      return [false, 'bad-txns-vout-empty', 100];

    if (this.getBaseSize() > consensus.MAX_TX_SIZE)
      return [false, 'bad-txns-oversize', 100];

    if (this.getWeight() > consensus.MAX_TX_WEIGHT)
      return [false, 'bad-txns-overweight', 100];

    let total = 0;

    for (const output of this.outputs) {
      if (output.value < 0)
        return [false, 'bad-txns-vout-negative', 100];

      if (output.value > consensus.MAX_MONEY)
        return [false, 'bad-txns-vout-toolarge', 100];

      total += output.value;

      if (total < 0 || total > consensus.MAX_MONEY)
        return [false, 'bad-txns-txouttotal-toolarge', 100];

      if (!output.address.isValid())
        return [false, 'bad-txns-address-size', 100];
    }

    if (this.isCoinbase()) {
      if (!this.inputs[0].prevout.isNull())
        return [false, 'bad-cb-outpoint', 100];

      const size = this.inputs[0].witness.getSize();

      if (size > 1000)
        return [false, 'bad-cb-length', 100];

      for (let i = 1; i < this.inputs.length; i++) {
        const input = this.inputs[i];

        if (!input.prevout.isNull())
          return [false, 'bad-cb-outpoint', 100];

        if (input.witness.items.length !== 1)
          return [false, 'bad-cb-witness', 100];

        const size = input.witness.items[0].length;

        if (size > 10000)
          return [false, 'bad-cb-length', 100];
      }
    } else {
      const prevout = new BufferSet();

      for (const input of this.inputs) {
        const key = input.prevout.toKey();

        if (prevout.has(key))
          return [false, 'bad-txns-inputs-duplicate', 100];

        prevout.add(key);
      }

      for (const input of this.inputs) {
        if (input.prevout.isNull())
          return [false, 'bad-txns-prevout-null', 10];
      }
    }

    if (!this.hasSaneCovenants())
      return [false, 'bad-txns-covenants', 100];

    return [true, 'valid', 0];
  }

  /**
   * Test whether the transaction violates
   * any basic covenants rules.
   * @returns {Boolean}
   */

  hasSaneCovenants() {
    return rules.hasSaneCovenants(this);
  }

  /**
   * Non-contextual checks to determine whether the
   * transaction has all standard output script
   * types and standard input script size with only
   * pushdatas in the code.
   * Will mostly verify coin and output values.
   * @see IsStandardTx()
   * @returns {Array} [valid, reason, score]
   */

  isStandard() {
    const [valid] = this.checkStandard();
    return valid;
  }

  /**
   * Non-contextual checks to determine whether the
   * transaction has all standard output script
   * types and standard input script size with only
   * pushdatas in the code.
   * Will mostly verify coin and output values.
   * @see IsStandardTx()
   * @returns {Array} [valid, reason, score]
   */

  checkStandard() {
    if (this.version > policy.MAX_TX_VERSION)
      return [false, 'version', 0];

    if (this.getWeight() > policy.MAX_TX_WEIGHT)
      return [false, 'tx-size', 0];

    let nulldata = 0;

    for (const output of this.outputs) {
      if (output.address.isUnknown())
        return [false, 'address', 0];

      if (output.address.isNulldata()) {
        nulldata += 1;
        continue;
      }

      if (output.covenant.isUnknown())
        return [false, 'covenant', 0];

      if (output.isDust(policy.MIN_RELAY))
        return [false, 'dust', 0];
    }

    if (nulldata > 1)
      return [false, 'multi-op-return', 0];

    return [true, 'valid', 0];
  }

  /**
   * Perform contextual checks to verify coin and input
   * script standardness (including the redeem script).
   * @see AreInputsStandard()
   * @param {CoinView} view
   * @returns {Boolean}
   */

  hasStandardInputs(view) {
    if (this.isCoinbase())
      return true;

    for (const input of this.inputs) {
      const witness = input.witness;
      const coin = view.getOutputFor(input);

      if (!coin)
        continue;

      if (witness.items.length === 0)
        continue;

      const addr = coin.address;

      if (addr.isPubkeyhash()) {
        if (witness.items.length !== 2)
          return false;

        if (witness.items[0].length !== 65)
          return false;

        if (witness.items[1].length !== 33)
          return false;

        continue;
      }

      if (addr.isScripthash()) {
        if (witness.items.length - 1 > policy.MAX_P2WSH_STACK)
          return false;

        for (let i = 0; i < witness.items.length - 1; i++) {
          const item = witness.items[i];
          if (item.length > policy.MAX_P2WSH_PUSH)
            return false;
        }

        const raw = witness.items[witness.items.length - 1];

        if (raw.length > policy.MAX_P2WSH_SIZE)
          return false;

        const redeem = Script.decode(raw);

        if (redeem.isPubkey()) {
          if (witness.items.length - 1 !== 1)
            return false;

          if (witness.items[0].length !== 65)
            return false;

          continue;
        }

        if (redeem.isPubkeyhash()) {
          if (input.witness.items.length - 1 !== 2)
            return false;

          if (witness.items[0].length !== 65)
            return false;

          if (witness.items[1].length !== 33)
            return false;

          continue;
        }

        const [m] = redeem.getMultisig();

        if (m !== -1) {
          if (witness.items.length - 1 !== m + 1)
            return false;

          if (witness.items[0].length !== 0)
            return false;

          for (let i = 1; i < witness.items.length - 1; i++) {
            const item = witness.items[i];
            if (item.length !== 65)
              return false;
          }
        }

        continue;
      }

      if (witness.items.length > policy.MAX_P2WSH_STACK)
        return false;

      for (const item of witness.items) {
        if (item.length > policy.MAX_P2WSH_PUSH)
          return false;
      }
    }

    return true;
  }

  /**
   * Perform contextual checks to verify input, output,
   * and fee values, as well as coinbase spend maturity
   * (coinbases can only be spent 100 blocks or more
   * after they're created). Note that this function is
   * consensus critical.
   * @param {CoinView} view
   * @param {Number} height - Height at which the
   * transaction is being spent. In the mempool this is
   * the chain height plus one at the time it entered the pool.
   * @returns {Boolean}
   */

  verifyInputs(view, height, network) {
    const [fee] = this.checkInputs(view, height, network);
    return fee !== -1;
  }

  /**
   * Perform contextual checks to verify input, output,
   * and fee values, as well as coinbase spend maturity
   * (coinbases can only be spent 100 blocks or more
   * after they're created). Note that this function is
   * consensus critical.
   * @param {CoinView} view
   * @param {Number} height - Height at which the
   * transaction is being spent. In the mempool this is
   * the chain height plus one at the time it entered the pool.
   * @returns {Array} [fee, reason, score]
   */

  checkInputs(view, height, network) {
    assert(typeof height === 'number');
    assert(network instanceof Network);

    if (this.isCoinbase()) {
      const conjured = this.verifyCovenants(view, height, network);

      if (conjured === -1)
        return [-1, 'bad-txns-claims', 100];

      return [conjured, 'valid', 0];
    }

    let total = 0;

    for (const {prevout} of this.inputs) {
      const entry = view.getEntry(prevout);

      if (!entry)
        return [-1, 'bad-txns-inputs-missingorspent', 0];

      if (entry.coinbase) {
        if (height - entry.height < network.coinbaseMaturity)
          return [-1, 'bad-txns-premature-spend-of-coinbase', 0];
      }

      const coin = view.getOutput(prevout);
      assert(coin);

      if (coin.value < 0 || coin.value > consensus.MAX_MONEY)
        return [-1, 'bad-txns-inputvalues-outofrange', 100];

      total += coin.value;

      if (total < 0 || total > consensus.MAX_MONEY)
        return [-1, 'bad-txns-inputvalues-outofrange', 100];
    }

    // Overflows already checked in `isSane()`.
    const value = this.getOutputValue();

    if (total < value)
      return [-1, 'bad-txns-in-belowout', 100];

    const fee = total - value;

    if (fee < 0)
      return [-1, 'bad-txns-fee-negative', 100];

    if (fee > consensus.MAX_MONEY)
      return [-1, 'bad-txns-fee-outofrange', 100];

    const conjured = this.verifyCovenants(view, height, network);

    if (conjured === -1)
      return [-1, 'bad-txns-covenants', 100];

    assert(conjured === 0);

    return [fee, 'valid', 0];
  }

  /**
   * Test whether the transaction violates
   * any contextual covenants rules.
   * @param {CoinView} view
   * @param {Number} height
   * @returns {Boolean}
   */

  verifyCovenants(view, height, network) {
    return rules.verifyCovenants(this, view, height, network);
  }

  /**
   * Calculate the modified size of the transaction. This
   * is used in the mempool for calculating priority.
   * @param {Number?} size - The size to modify. If not present,
   * virtual size will be used.
   * @returns {Number} Modified size.
   */

  getModifiedSize(size) {
    if (size == null)
      size = this.getVirtualSize();

    for (const input of this.inputs) {
      const offset = 45 + Math.min(100, input.witness.getSize());
      if (size > offset)
        size -= offset;
    }

    return size;
  }

  /**
   * Calculate the transaction priority.
   * @param {CoinView} view
   * @param {Number} height
   * @param {Number?} size - Size to calculate priority
   * based on. If not present, virtual size will be used.
   * @returns {Number}
   */

  getPriority(view, height, size) {
    assert(typeof height === 'number', 'Must pass in height.');

    if (this.isCoinbase())
      return 0;

    if (size == null)
      size = this.getVirtualSize();

    let sum = 0;

    for (const {prevout} of this.inputs) {
      const coin = view.getOutput(prevout);

      if (!coin)
        continue;

      const coinHeight = view.getHeight(prevout);

      if (coinHeight === -1)
        continue;

      if (coinHeight <= height) {
        const age = height - coinHeight;
        sum += coin.value * age;
      }
    }

    return Math.floor(sum / size);
  }

  /**
   * Calculate the transaction's on-chain value.
   * @param {CoinView} view
   * @returns {Number}
   */

  getChainValue(view) {
    if (this.isCoinbase())
      return 0;

    let value = 0;

    for (const {prevout} of this.inputs) {
      const coin = view.getOutput(prevout);

      if (!coin)
        continue;

      const height = view.getHeight(prevout);

      if (height === -1)
        continue;

      value += coin.value;
    }

    return value;
  }

  /**
   * Determine whether the transaction is above the
   * free threshold in priority. A transaction which
   * passed this test is most likely relayable
   * without a fee.
   * @param {CoinView} view
   * @param {Number?} height - If not present, tx
   * height or network height will be used.
   * @param {Number?} size - If not present, modified
   * size will be calculated and used.
   * @returns {Boolean}
   */

  isFree(view, height, size) {
    const priority = this.getPriority(view, height, size);
    return priority > policy.FREE_THRESHOLD;
  }

  /**
   * Calculate minimum fee in order for the transaction
   * to be relayable (not the constant min relay fee).
   * @param {Number?} size - If not present, max size
   * estimation will be calculated and used.
   * @param {Rate?} rate - Rate of dollarydoo per kB.
   * @returns {Amount} fee
   */

  getMinFee(size, rate) {
    if (size == null)
      size = this.getVirtualSize();

    return policy.getMinFee(size, rate);
  }

  /**
   * Calculate the minimum fee in order for the transaction
   * to be relayable, but _round to the nearest kilobyte
   * when taking into account size.
   * @param {Number?} size - If not present, max size
   * estimation will be calculated and used.
   * @param {Rate?} rate - Rate of dollarydoo per kB.
   * @returns {Amount} fee
   */

  getRoundFee(size, rate) {
    if (size == null)
      size = this.getVirtualSize();

    return policy.getRoundFee(size, rate);
  }

  /**
   * Calculate the transaction's rate based on size
   * and fees. Size will be calculated if not present.
   * @param {CoinView} view
   * @param {Number?} size
   * @returns {Rate}
   */

  getRate(view, size) {
    const fee = this.getFee(view);

    if (fee < 0)
      return 0;

    if (size == null)
      size = this.getVirtualSize();

    return policy.getRate(size, fee);
  }

  /**
   * Get all unique outpoint hashes.
   * @returns {Hash[]} Outpoint hashes.
   */

  getPrevout() {
    if (this.isCoinbase())
      return [];

    const prevout = new BufferSet();

    for (const input of this.inputs)
      prevout.add(input.prevout.hash);

    return prevout.toArray();
  }

  /**
   * Test a transaction against a bloom filter.
   * @param {BloomFilter} filter
   * @returns {Boolean}
   */

  test(filter) {
    let found = false;

    if (filter.test(this.hash()))
      found = true;

    for (let i = 0; i < this.outputs.length; i++) {
      const {address, covenant} = this.outputs[i];

      if (filter.test(address.hash) || covenant.test(filter)) {
        const prevout = Outpoint.fromTX(this, i);
        filter.add(prevout.encode());
        found = true;
      }
    }

    if (found)
      return found;

    for (const {prevout} of this.inputs) {
      if (filter.test(prevout.encode()))
        return true;
    }

    return false;
  }

  /**
   * Get little-endian tx hash.
   * @returns {Hash}
   */

  txid() {
    return this.hash().toString('hex');
  }

  /**
   * Get little-endian wtx hash.
   * @returns {Hash}
   */

  wtxid() {
    return this.witnessHash().toString('hex');
  }

  /**
   * Create outpoint from output index.
   * @param {Number} index
   * @returns {Outpoint}
   */

  outpoint(index) {
    return new Outpoint(this.hash(), index);
  }

  /**
   * Get input from index.
   * @param {Number} index
   * @returns {Input|null}
   */

  input(index) {
    if (index >= this.inputs.length)
      return null;
    return this.inputs[index];
  }

  /**
   * Get output from index.
   * @param {Number} index
   * @returns {Output|null}
   */

  output(index) {
    if (index >= this.outputs.length)
      return null;
    return this.outputs[index];
  }

  /**
   * Get covenant from index.
   * @param {Number} index
   * @returns {Covenant|null}
   */

  covenant(index) {
    if (index >= this.outputs.length)
      return null;
    return this.outputs[index].covenant;
  }

  /**
   * Convert the tx to an inv item.
   * @returns {InvItem}
   */

  toInv() {
    return new InvItem(InvItem.types.TX, this.hash());
  }

  /**
   * Inspect the transaction and return a more
   * user-friendly representation of the data.
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Number} index
   * @returns {Object}
   */

  format(view, entry, index) {
    let rate = 0;
    let fee = 0;
    let height = -1;
    let block = null;
    let time = 0;
    let date = null;

    if (view) {
      fee = this.getFee(view);
      rate = this.getRate(view);

      // Rate can exceed 53 bits in testing.
      if (!Number.isSafeInteger(rate))
        rate = 0;
    }

    if (entry) {
      height = entry.height;
      block = entry.hash.toString('hex');
      time = entry.time;
      date = util.date(time);
    }

    if (index == null)
      index = -1;

    return {
      hash: this.txid(),
      witnessHash: this.wtxid(),
      size: this.getSize(),
      virtualSize: this.getVirtualSize(),
      value: Amount.coin(this.getOutputValue()),
      fee: Amount.coin(fee),
      rate: Amount.coin(rate),
      minFee: Amount.coin(this.getMinFee()),
      height: height,
      block: block,
      time: time,
      date: date,
      index: index,
      version: this.version,
      inputs: this.inputs.map((input) => {
        const coin = view ? view.getOutputFor(input) : null;
        return input.format(coin);
      }),
      outputs: this.outputs,
      locktime: this.locktime
    };
  }

  /**
   * Convert the transaction to an object suitable
   * for JSON serialization.
   * @param {Network} network
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Number} index
   * @returns {Object}
   */

  getJSON(network, view, entry, index) {
    let rate, fee, height, block, time, date;

    if (view) {
      fee = this.getFee(view);
      rate = this.getRate(view);

      // Rate can exceed 53 bits in testing.
      if (!Number.isSafeInteger(rate))
        rate = 0;
    }

    if (entry) {
      height = entry.height;
      block = entry.hash.toString('hex');
      time = entry.time;
      date = util.date(time);
    }

    network = Network.get(network);

    return {
      hash: this.txid(),
      witnessHash: this.wtxid(),
      fee: fee,
      rate: rate,
      mtime: util.now(),
      height: height,
      block: block,
      time: time,
      date: date,
      index: index,
      version: this.version,
      inputs: this.inputs.map((input) => {
        const coin = view ? view.getCoinFor(input) : null;
        const path = view ? view.getPathFor(input) : null;
        return input.getJSON(network, coin, path);
      }),
      outputs: this.outputs.map((output) => {
        return output.getJSON(network);
      }),
      locktime: this.locktime,
      hex: this.toHex()
    };
  }

  /**
   * Inject properties from a json object.
   * @private
   * @param {Object} json
   */

  fromJSON(json) {
    assert(json, 'TX data is required.');
    assert((json.version >>> 0) === json.version, 'Version must be a uint32.');
    assert(Array.isArray(json.inputs), 'Inputs must be an array.');
    assert(Array.isArray(json.outputs), 'Outputs must be an array.');
    assert((json.locktime >>> 0) === json.locktime,
      'Locktime must be a uint32.');

    this.version = json.version;

    for (const input of json.inputs)
      this.inputs.push(Input.fromJSON(input));

    for (const output of json.outputs)
      this.outputs.push(Output.fromJSON(output));

    this.locktime = json.locktime;

    return this;
  }

  /**
   * Inject properties from serialized
   * buffer reader (witness serialization).
   * @private
   * @param {BufferReader} br
   */

  read(br) {
    br.start();

    this.version = br.readU32();

    const inCount = br.readVarint();

    for (let i = 0; i < inCount; i++)
      this.inputs.push(Input.read(br));

    const outCount = br.readVarint();

    for (let i = 0; i < outCount; i++)
      this.outputs.push(Output.read(br));

    this.locktime = br.readU32();

    const start = br.offset;

    for (let i = 0; i < inCount; i++) {
      const input = this.inputs[i];
      input.witness.read(br);
    }

    const witness = br.offset - start;

    if (!this.mutable) {
      const raw = br.endData();
      const base = raw.length - witness;
      this._raw = raw;
      this._sizes = new Sizes(base, witness);
    } else {
      br.end();
    }

    return this;
  }

  /**
   * Calculate the real size of the transaction
   * with the witness included.
   * @returns {Sizes}
   */

  getSizes() {
    if (this._sizes)
      return this._sizes;

    let base = 0;
    let witness = 0;

    base += 4;
    base += encoding.sizeVarint(this.inputs.length);

    for (const input of this.inputs) {
      base += 40;
      witness += input.witness.getVarSize();
    }

    base += encoding.sizeVarint(this.outputs.length);

    for (const output of this.outputs)
      base += output.getSize();

    base += 4;

    const sizes = new Sizes(base, witness);

    if (!this.mutable)
      this._sizes = sizes;

    return sizes;
  }

  /**
   * Serialize transaction with witness. Calculates the witness
   * size as it is framing (exposed on return value as `witness`).
   * @private
   * @param {BufferWriter} bw
   * @returns {Sizes}
   */

  write(bw) {
    if (this._raw) {
      bw.writeBytes(this._raw);
      return bw;
    }

    bw.writeU32(this.version);

    bw.writeVarint(this.inputs.length);

    for (const input of this.inputs)
      input.write(bw);

    bw.writeVarint(this.outputs.length);

    for (const output of this.outputs)
      output.write(bw);

    bw.writeU32(this.locktime);

    for (const input of this.inputs)
      input.witness.write(bw);

    return bw;
  }

  /**
   * Serialize transaction.
   * @returns {Buffer}
   */

  encode() {
    if (this.mutable)
      return super.encode();

    if (!this._raw)
      this._raw = super.encode();

    return this._raw;
  }

  /**
   * Calculate left hash.
   * @returns {Buffer}
   */

  left() {
    return this.hashes()[0];
  }

  /**
   * Calculate right hash.
   * @returns {Buffer}
   */

  right() {
    return this.hashes()[1];
  }

  /**
   * Calculate root hash.
   * @returns {Buffer}
   */

  root() {
    return this.hashes()[2];
  }

  /**
   * Calculate all three transaction hashes.
   * @private
   * @returns {Buffer[]}
   */

  hashes() {
    if (this._hash && this._wdhash && this._whash)
      return [this._hash, this._wdhash, this._whash];

    const {base, witness} = this.getSizes();
    const raw = this.encode();

    assert(raw.length === base + witness);

    // Normal data.
    const ndata = raw.slice(0, base);

    // Witness data.
    const wdata = raw.slice(base, base + witness);

    // Left = HASH(normal-data) = normal txid
    const hash = blake2b.digest(ndata);

    // Right = HASH(witness-data)
    const wdhash = blake2b.digest(wdata);

    // WTXID = HASH(normal-txid || witness-data-hash)
    const whash = blake2b.root(hash, wdhash);

    if (!this.mutable) {
      this._hash = hash;
      this._wdhash = wdhash;
      this._whash = whash;
    }

    return [hash, wdhash, whash];
  }

  /**
   * Test whether an object is a TX.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isTX(obj) {
    return obj instanceof TX;
  }
}

/*
 * Helpers
 */

class Sizes {
  constructor(base, witness) {
    this.base = base;
    this.witness = witness;
  }
}

/*
 * Expose
 */

module.exports = TX;
