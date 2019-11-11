/*!
 * mtx.js - mutable transaction object for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {encoding} = require('bufio');
const {BufferMap} = require('buffer-map');
const Script = require('../script/script');
const TX = require('./tx');
const Input = require('./input');
const Output = require('./output');
const Coin = require('./coin');
const Outpoint = require('./outpoint');
const CoinView = require('../coins/coinview');
const Path = require('../wallet/path');
const WalletCoinView = require('../wallet/walletcoinview');
const Address = require('./address');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const Amount = require('../ui/amount');
const Stack = require('../script/stack');
const rules = require('../covenants/rules');
const util = require('../utils/util');
const {types} = rules;

/**
 * MTX
 * A mutable transaction object.
 * @alias module:primitives.MTX
 * @extends TX
 * @property {Number} changeIndex
 * @property {CoinView} view
 */

class MTX extends TX {
  /**
   * Create a mutable transaction.
   * @alias module:primitives.MTX
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();

    this.mutable = true;
    this.changeIndex = -1;
    this.view = new CoinView();

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    if (options.version != null) {
      assert((options.version >>> 0) === options.version,
        'Version must a be uint32.');
      this.version = options.version;
    }

    if (options.inputs) {
      assert(Array.isArray(options.inputs), 'Inputs must be an array.');
      for (const input of options.inputs)
        this.addInput(input);
    }

    if (options.outputs) {
      assert(Array.isArray(options.outputs), 'Outputs must be an array.');
      for (const output of options.outputs)
        this.addOutput(output);
    }

    if (options.locktime != null) {
      assert((options.locktime >>> 0) === options.locktime,
        'Locktime must be a uint32.');
      this.locktime = options.locktime;
    }

    if (options.changeIndex != null) {
      if (options.changeIndex !== -1) {
        assert((options.changeIndex >>> 0) === options.changeIndex,
          'Change index must be a uint32.');
        this.changeIndex = options.changeIndex;
      } else {
        this.changeIndex = -1;
      }
    }

    return this;
  }

  /**
   * Clone the transaction. Note that
   * this will not carry over the view.
   * @returns {MTX}
   */

  inject(mtx) {
    assert(mtx instanceof this.constructor);
    super.inject(mtx);
    this.changeIndex = mtx.changeIndex;
    return this;
  }

  /**
   * Add an input to the transaction.
   * @param {Input|Object} options
   * @returns {Input}
   *
   * @example
   * mtx.addInput({ prevout: { hash: ... }, witness: ... });
   * mtx.addInput(new Input());
   */

  addInput(options) {
    const input = Input.fromOptions(options);
    this.inputs.push(input);
    return input;
  }

  /**
   * Add an outpoint as an input.
   * @param {Outpoint|Object} outpoint
   * @returns {Input}
   *
   * @example
   * mtx.addOutpoint({ hash: ..., index: 0 });
   * mtx.addOutpoint(new Outpoint(hash, index));
   */

  addOutpoint(outpoint) {
    const prevout = Outpoint.fromOptions(outpoint);
    const input = Input.fromOutpoint(prevout);
    this.inputs.push(input);
    return input;
  }

  /**
   * Add a coin as an input. Note that this will
   * add the coin to the internal coin viewpoint.
   * @param {Coin} coin
   * @returns {Input}
   *
   * @example
   * mtx.addCoin(Coin.fromTX(tx, 0, -1));
   */

  addCoin(coin) {
    assert(coin instanceof Coin, 'Cannot add non-coin.');

    const input = Input.fromCoin(coin);

    this.inputs.push(input);
    this.view.addCoin(coin);

    return input;
  }

  /**
   * Add a transaction as an input. Note that
   * this will add the coin to the internal
   * coin viewpoint.
   * @param {TX} tx
   * @param {Number} index
   * @param {Number?} height
   * @returns {Input}
   *
   * @example
   * mtx.addTX(tx, 0);
   */

  addTX(tx, index, height) {
    assert(tx instanceof TX, 'Cannot add non-transaction.');

    if (height == null)
      height = -1;

    const input = Input.fromTX(tx, index);

    this.inputs.push(input);

    this.view.addIndex(tx, index, height);

    return input;
  }

  /**
   * Add an output.
   * @param {Address|Output|Object} addr - Address or output options.
   * @param {Amount?} value
   * @returns {Output}
   *
   * @example
   * mtx.addOutput(new Output());
   * mtx.addOutput({ address: ..., value: 100000 });
   * mtx.addOutput(address, 100000);
   */

  addOutput(addr, value) {
    let output;

    if (value != null)
      output = Output.fromScript(addr, value);
    else
      output = Output.fromOptions(addr);

    this.outputs.push(output);

    return output;
  }

  /**
   * Verify all transaction inputs.
   * @param {VerifyFlags} [flags=STANDARD_VERIFY_FLAGS]
   * @returns {Boolean} Whether the inputs are valid.
   * @throws {ScriptError} on invalid inputs
   */

  check(flags) {
    return super.check(this.view, flags);
  }

  /**
   * Verify the transaction inputs on the worker pool
   * (if workers are enabled).
   * @param {VerifyFlags?} [flags=STANDARD_VERIFY_FLAGS]
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  checkAsync(flags, pool) {
    return super.checkAsync(this.view, flags, pool);
  }

  /**
   * Verify all transaction inputs.
   * @param {VerifyFlags} [flags=STANDARD_VERIFY_FLAGS]
   * @returns {Boolean} Whether the inputs are valid.
   */

  verify(flags) {
    try {
      this.check(flags);
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
   * @param {VerifyFlags?} [flags=STANDARD_VERIFY_FLAGS]
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async verifyAsync(flags, pool) {
    try {
      await this.checkAsync(flags, pool);
    } catch (e) {
      if (e.type === 'ScriptError')
        return false;
      throw e;
    }
    return true;
  }

  /**
   * Calculate the fee for the transaction.
   * @returns {Amount} fee (zero if not all coins are available).
   */

  getFee() {
    return super.getFee(this.view);
  }

  /**
   * Calculate the total input value.
   * @returns {Amount} value
   */

  getInputValue() {
    return super.getInputValue(this.view);
  }

  /**
   * Get all input addresses.
   * @returns {Address[]} addresses
   */

  getInputAddresses() {
    return super.getInputAddresses(this.view);
  }

  /**
   * Get all addresses.
   * @returns {Address[]} addresses
   */

  getAddresses() {
    return super.getAddresses(this.view);
  }

  /**
   * Get all input address hashes.
   * @returns {Hash[]} hashes
   */

  getInputHashes() {
    return super.getInputHashes(this.view);
  }

  /**
   * Get all address hashes.
   * @returns {Hash[]} hashes
   */

  getHashes() {
    return super.getHashes(this.view);
  }

  /**
   * Test whether the transaction has
   * all coins available/filled.
   * @returns {Boolean}
   */

  hasCoins() {
    return super.hasCoins(this.view);
  }

  /**
   * Calculate virtual sigop count.
   * @param {VerifyFlags?} flags
   * @returns {Number} sigop count
   */

  getSigops() {
    return super.getSigops(this.view);
  }

  /**
   * Calculate the virtual size of the transaction
   * (weighted against bytes per sigop cost).
   * @returns {Number} vsize
   */

  getSigopsSize() {
    return super.getSigopsSize(this.getSigops());
  }

  /**
   * Perform contextual checks to verify input, output,
   * and fee values, as well as coinbase spend maturity
   * (coinbases can only be spent 100 blocks or more
   * after they're created). Note that this function is
   * consensus critical.
   * @param {Number} height - Height at which the
   * transaction is being spent. In the mempool this is
   * the chain height plus one at the time it entered the pool.
   * @returns {Boolean}
   */

  verifyInputs(height, network) {
    const [fee] = this.checkInputs(height, network);
    return fee !== -1;
  }

  /**
   * Perform contextual checks to verify input, output,
   * and fee values, as well as coinbase spend maturity
   * (coinbases can only be spent 100 blocks or more
   * after they're created). Note that this function is
   * consensus critical.
   * @param {Number} height - Height at which the
   * transaction is being spent. In the mempool this is
   * the chain height plus one at the time it entered the pool.
   * @returns {Array} [fee, reason, score]
   */

  checkInputs(height, network) {
    return super.checkInputs(this.view, height, network);
  }

  /**
   * Build input script (or witness) templates (with
   * OP_0 in place of signatures).
   * @param {Number} index - Input index.
   * @param {Coin|Output} coin
   * @param {KeyRing} ring
   * @returns {Boolean} Whether the script was able to be built.
   */

  scriptInput(index, coin, ring) {
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert(coin, 'No coin passed.');

    // Don't bother with any below calculation
    // if the output is already templated.
    if (input.witness.items.length !== 0)
      return true;

    const addr = coin.address;

    if (addr.isScripthash()) {
      const redeem = ring.getRedeem(addr.hash);

      if (!redeem)
        return false;

      const vector = this.scriptVector(redeem, ring);

      if (!vector)
        return false;

      vector.push(redeem.encode());

      input.witness.fromStack(vector);

      return true;
    }

    if (addr.isPubkeyhash()) {
      const pkh = Script.fromPubkeyhash(addr.hash);
      const vector = this.scriptVector(pkh, ring);

      if (!vector)
        return false;

      input.witness.fromStack(vector);

      return true;
    }

    return false;
  }

  /**
   * Build script for a single vector
   * based on a previous script.
   * @param {Script} prev
   * @param {Buffer} ring
   * @return {Boolean}
   */

  scriptVector(prev, ring) {
    // P2PK
    const pk = prev.getPubkey();
    if (pk) {
      if (!pk.equals(ring.publicKey))
        return null;

      const stack = new Stack();

      stack.pushInt(0);

      return stack;
    }

    // P2PKH
    const pkh = prev.getPubkeyhash();
    if (pkh) {
      if (!pkh.equals(ring.getKeyHash()))
        return null;

      const stack = new Stack();

      stack.pushInt(0);
      stack.pushData(ring.publicKey);

      return stack;
    }

    // Multisig
    const [, n] = prev.getMultisig();
    if (n !== -1) {
      if (prev.indexOf(ring.publicKey) === -1)
        return null;

      // Technically we should create m signature slots,
      // but we create n signature slots so we can order
      // the signatures properly.
      const stack = new Stack();

      stack.pushInt(0);

      // Fill script with `n` signature slots.
      for (let i = 0; i < n; i++)
        stack.pushInt(0);

      return stack;
    }

    return null;
  }

  /**
   * Sign a transaction input on the worker pool
   * (if workers are enabled).
   * @param {Number} index
   * @param {Coin|Output} coin
   * @param {KeyRing} ring
   * @param {SighashType?} type
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async signInputAsync(index, coin, ring, type, pool) {
    if (!pool)
      return this.signInput(index, coin, ring, type);

    return await pool.signInput(this, index, coin, ring, type, pool);
  }

  /**
   * Sign an input.
   * @param {Number} index - Index of input being signed.
   * @param {Coin|Output} coin
   * @param {KeyRing} ring - Private key.
   * @param {SighashType} type
   * @returns {Boolean} Whether the input was able to be signed.
   */

  signInput(index, coin, ring, type) {
    const input = this.inputs[index];
    const key = ring.privateKey;

    assert(input, 'Input does not exist.');
    assert(coin, 'No coin passed.');

    // Get the previous output's script
    const value = coin.value;
    const addr = coin.address;

    // Create our signature.
    if (addr.isScripthash()) {
      const stack = input.witness.toStack();
      const redeem = stack.pop();

      if (!redeem)
        return false;

      const prev = Script.decode(redeem);
      const sig = this.signature(index, prev, value, key, type);

      const result = this.signVector(prev, stack, sig, ring);

      if (!result)
        return false;

      result.push(redeem);

      input.witness.fromStack(result);

      return true;
    }

    if (addr.isPubkeyhash()) {
      const prev = Script.fromPubkeyhash(addr.hash);
      const sig = this.signature(index, prev, value, key, type);

      const stack = input.witness.toStack();
      const result = this.signVector(prev, stack, sig, ring);

      if (!result)
        return false;

      input.witness.fromStack(result);

      return true;
    }

    return false;
  }

  /**
   * Add a signature to a vector
   * based on a previous script.
   * @param {Script} prev
   * @param {Stack} vector
   * @param {Buffer} sig
   * @param {KeyRing} ring
   * @return {Boolean}
   */

  signVector(prev, vector, sig, ring) {
    // P2PK
    const pk = prev.getPubkey();
    if (pk) {
      // Make sure the pubkey is ours.
      if (!ring.publicKey.equals(pk))
        return null;

      if (vector.length === 0)
        throw new Error('Input has not been templated.');

      // Already signed.
      if (vector.get(0).length > 0)
        return vector;

      vector.set(0, sig);

      return vector;
    }

    // P2PKH
    const pkh = prev.getPubkeyhash();
    if (pkh) {
      // Make sure the pubkey hash is ours.
      if (!ring.getKeyHash().equals(pkh))
        return null;

      if (vector.length !== 2)
        throw new Error('Input has not been templated.');

      if (vector.get(1).length === 0)
        throw new Error('Input has not been templated.');

      // Already signed.
      if (vector.get(0).length > 0)
        return vector;

      vector.set(0, sig);

      return vector;
    }

    // Multisig
    const [m, n] = prev.getMultisig();
    if (m !== -1) {
      if (vector.length < 2)
        throw new Error('Input has not been templated.');

      if (vector.get(0).length !== 0)
        throw new Error('Input has not been templated.');

      // Too many signature slots. Abort.
      if (vector.length - 1 > n)
        throw new Error('Input has not been templated.');

      // Count the number of current signatures.
      let total = 0;
      for (let i = 1; i < vector.length; i++) {
        const item = vector.get(i);
        if (item.length > 0)
          total += 1;
      }

      // Signatures are already finalized.
      if (total === m && vector.length - 1 === m)
        return vector;

      // Add some signature slots for us to use if
      // there was for some reason not enough.
      while (vector.length - 1 < n)
        vector.pushInt(0);

      // Grab the redeem script's keys to figure
      // out where our key should go.
      const keys = [];
      for (const op of prev.code) {
        if (op.data)
          keys.push(op.data);
      }

      // Find the key index so we can place
      // the signature in the same index.
      let keyIndex = -1;

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.equals(ring.publicKey)) {
          keyIndex = i;
          break;
        }
      }

      // Our public key is not in the prev_out
      // script. We tried to sign a transaction
      // that is not redeemable by us.
      if (keyIndex === -1)
        return null;

      // Offset key index by one to turn it into
      // "sig index". Accounts for OP_0 byte at
      // the start.
      keyIndex += 1;

      // Add our signature to the correct slot
      // and increment the total number of
      // signatures.
      if (keyIndex < vector.length && total < m) {
        if (vector.get(keyIndex).length === 0) {
          vector.set(keyIndex, sig);
          total += 1;
        }
      }

      // All signatures added. Finalize.
      if (total >= m) {
        // Remove empty slots left over.
        for (let i = vector.length - 1; i >= 1; i--) {
          const item = vector.get(i);
          if (item.length === 0)
            vector.remove(i);
        }

        // Remove signatures which are not required.
        // This should never happen.
        while (total > m) {
          vector.pop();
          total -= 1;
        }

        // Sanity checks.
        assert(total === m);
        assert(vector.length - 1 === m);
      }

      return vector;
    }

    return null;
  }

  /**
   * Test whether the transaction is fully-signed.
   * @returns {Boolean}
   */

  isSigned() {
    for (let i = 0; i < this.inputs.length; i++) {
      const {prevout} = this.inputs[i];
      const coin = this.view.getOutput(prevout);

      if (!coin)
        return false;

      if (!this.isInputSigned(i, coin))
        return false;
    }

    return true;
  }

  /**
   * Test whether an input is fully-signed.
   * @param {Number} index
   * @param {Coin|Output} coin
   * @returns {Boolean}
   */

  isInputSigned(index, coin) {
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert(coin, 'No coin passed.');

    const addr = coin.address;
    const stack = input.witness.toStack();

    if (addr.isScripthash()) {
      const prev = Script.decode(stack.pop());
      return this.isVectorSigned(prev, stack);
    }

    if (addr.isPubkeyhash()) {
      const prev = Script.fromPubkeyhash(addr.hash);
      return this.isVectorSigned(prev, stack);
    }

    return false;
  }

  /**
   * Test whether a vector is fully-signed.
   * @param {Script} prev
   * @param {Stack} vector
   * @returns {Boolean}
   */

  isVectorSigned(prev, vector) {
    if (prev.isPubkey()) {
      if (vector.length !== 1)
        return false;

      if (vector.get(0).length === 0)
        return false;

      return true;
    }

    if (prev.isPubkeyhash()) {
      if (vector.length !== 2)
        return false;

      if (vector.get(0).length === 0)
        return false;

      if (vector.get(1).length === 0)
        return false;

      return true;
    }

    const [m] = prev.getMultisig();

    if (m !== -1) {
      // Ensure we have the correct number
      // of required signatures.
      if (vector.length - 1 !== m)
        return false;

      // Ensure all members are signatures.
      for (let i = 1; i < vector.length; i++) {
        const item = vector.get(i);
        if (item.length === 0)
          return false;
      }

      return true;
    }

    return false;
  }

  /**
   * Build input scripts (or witnesses).
   * @param {KeyRing} ring - Address used to sign. The address
   * must be able to redeem the coin.
   * @returns {Number} Number of inputs templated.
   */

  template(ring) {
    if (Array.isArray(ring)) {
      let total = 0;
      for (const key of ring)
        total += this.template(key);
      return total;
    }

    let total = 0;

    for (let i = 0; i < this.inputs.length; i++) {
      const {prevout} = this.inputs[i];
      const coin = this.view.getOutput(prevout);

      if (!coin)
        continue;

      if (!ring.ownOutput(coin))
        continue;

      // Build script for input
      if (!this.scriptInput(i, coin, ring))
        continue;

      total += 1;
    }

    return total;
  }

  /**
   * Built input scripts (or witnesses) and sign the inputs.
   * @param {KeyRing} ring - Address used to sign. The address
   * must be able to redeem the coin.
   * @param {SighashType} type
   * @returns {Number} Number of inputs signed.
   */

  sign(ring, type) {
    if (Array.isArray(ring)) {
      let total = 0;
      for (const key of ring)
        total += this.sign(key, type);
      return total;
    }

    assert(ring.privateKey, 'No private key available.');

    let total = 0;

    for (let i = 0; i < this.inputs.length; i++) {
      const {prevout} = this.inputs[i];
      const coin = this.view.getOutput(prevout);

      if (!coin)
        continue;

      if (!ring.ownOutput(coin))
        continue;

      // Build script for input
      if (!this.scriptInput(i, coin, ring))
        continue;

      // Sign input
      if (!this.signInput(i, coin, ring, type))
        continue;

      total += 1;
    }

    return total;
  }

  /**
   * Sign the transaction inputs on the worker pool
   * (if workers are enabled).
   * @param {KeyRing} ring
   * @param {SighashType?} type
   * @param {WorkerPool?} pool
   * @returns {Promise}
   */

  async signAsync(ring, type, pool) {
    if (!pool)
      return this.sign(ring, type);

    return await pool.sign(this, ring, type);
  }

  /**
   * Estimate maximum possible size.
   * @param {Function?} estimate - Input script size estimator.
   * @returns {Number}
   */

  async estimateSize(estimate) {
    const scale = consensus.WITNESS_SCALE_FACTOR;

    let total = 0;

    // Calculate the size, minus the input scripts.
    total += 4;
    total += encoding.sizeVarint(this.inputs.length);
    total += this.inputs.length * 40;

    total += encoding.sizeVarint(this.outputs.length);

    for (const output of this.outputs)
      total += output.getSize();

    total += 4;

    // Add size for signatures and public keys
    for (const {prevout} of this.inputs) {
      const coin = this.view.getOutput(prevout);

      // We're out of luck here.
      // Just assume it's a p2pkh.
      if (!coin) {
        total += 110;
        continue;
      }

      // Previous output script.
      const addr = coin.address;

      // P2WPKH
      if (addr.isPubkeyhash()) {
        let size = 0;
        // varint-items-len
        size += 1;
        // varint-len [signature]
        size += 1 + 65;
        // varint-len [key]
        size += 1 + 33;
        // vsize
        size = (size + scale - 1) / scale | 0;
        total += size;
        continue;
      }

      // Call out to the custom estimator.
      if (estimate) {
        const size = await estimate(addr);
        if (size !== -1) {
          total += size;
          continue;
        }
      }

      // P2WSH
      if (addr.isScripthash()) {
        let size = 0;
        // varint-items-len
        size += 1;
        // 2-of-3 multisig input
        size += 149;
        // vsize
        size = (size + scale - 1) / scale | 0;
        total += size;
        continue;
      }

      // Unknown.
      total += 110;
    }

    return total;
  }

  /**
   * Select necessary coins based on total output value.
   * @param {Coin[]} coins
   * @param {Object?} options
   * @returns {CoinSelection}
   * @throws on not enough funds available.
   */

  selectCoins(coins, options) {
    const selector = new CoinSelector(this, options);
    return selector.select(coins);
  }

  /**
   * Attempt to subtract a fee from a single output.
   * @param {Number} index
   * @param {Amount} fee
   */

  subtractIndex(index, fee) {
    assert(typeof index === 'number');
    assert(typeof fee === 'number');

    const output = this.outputs[index];

    if (!output)
      throw new Error('Subtraction index does not exist.');

    if (output.value < fee + output.getDustThreshold())
      throw new Error('Could not subtract fee.');

    output.value -= fee;
  }

  /**
   * Attempt to subtract a fee from all outputs evenly.
   * @param {Amount} fee
   */

  subtractFee(fee) {
    assert(typeof fee === 'number');

    let outputs = 0;

    for (const output of this.outputs) {
      if (output.covenant.type !== types.NONE)
        continue;

      // Ignore nulldatas and
      // other OP_RETURN scripts.
      if (output.address.isUnspendable())
        continue;

      outputs += 1;
    }

    if (outputs === 0)
      throw new Error('Could not subtract fee.');

    const left = fee % outputs;
    const share = (fee - left) / outputs;

    // First pass, remove even shares.
    for (const output of this.outputs) {
      if (output.covenant.type !== types.NONE)
        continue;

      if (output.address.isUnspendable())
        continue;

      if (output.value < share + output.getDustThreshold())
        throw new Error('Could not subtract fee.');

      output.value -= share;
    }

    // Second pass, remove the remainder
    // for the one unlucky output.
    for (const output of this.outputs) {
      if (output.covenant.type !== types.NONE)
        continue;

      if (output.address.isUnspendable())
        continue;

      if (output.value >= left + output.getDustThreshold()) {
        output.value -= left;
        return;
      }
    }

    throw new Error('Could not subtract fee.');
  }

  /**
   * Select coins and fill the inputs.
   * @param {Coin[]} coins
   * @param {Object} options - See {@link MTX#selectCoins} options.
   * @returns {CoinSelector}
   */

  async fund(coins, options) {
    assert(options, 'Options are required.');
    assert(options.changeAddress, 'Change address is required.');

    // Select necessary coins.
    const select = await this.selectCoins(coins, options);

    // Make sure we empty the input array.
    this.inputs.length = 0;

    // Add coins to transaction.
    for (const coin of select.chosen)
      this.addCoin(coin);

    // Attempt to subtract fee.
    if (select.subtractFee) {
      const index = select.subtractIndex;
      if (index !== -1)
        this.subtractIndex(index, select.fee);
      else
        this.subtractFee(select.fee);
    }

    // Add a change output.
    const output = new Output();
    output.value = select.change;
    output.address = select.changeAddress;

    if (output.isDust(policy.MIN_RELAY)) {
      // Do nothing. Change is added to fee.
      this.changeIndex = -1;
      assert.strictEqual(this.getFee(), select.fee + select.change);
    } else {
      this.outputs.push(output);
      this.changeIndex = this.outputs.length - 1;
      assert.strictEqual(this.getFee(), select.fee);
    }

    return select;
  }

  /**
   * Sort inputs and outputs according to BIP69.
   * @see https://github.com/bitcoin/bips/blob/master/bip-0069.mediawiki
   */

  sortMembers() {
    let changeOutput = null;

    if (this.changeIndex !== -1) {
      changeOutput = this.outputs[this.changeIndex];
      assert(changeOutput);
      assert(changeOutput.covenant.type === 0);
    }

    const inputs = [];
    const outputs = [];
    const linked = [];

    let i = 0;

    for (; i < this.outputs.length; i++) {
      const input = this.input(i);
      const output = this.outputs[i];

      if (!input) {
        outputs.push(output);
        continue;
      }

      if (!output.covenant.isLinked()) {
        inputs.push(input);
        outputs.push(output);
        continue;
      }

      linked.push([input, output]);
    }

    for (; i < this.inputs.length; i++)
      inputs.push(this.inputs[i]);

    inputs.sort(sortInputs);
    outputs.sort(sortOutputs);
    linked.sort(sortLinked);

    this.inputs = [];
    this.outputs = [];

    for (const [input, output] of linked) {
      this.inputs.push(input);
      this.outputs.push(output);
    }

    for (const input of inputs)
      this.inputs.push(input);

    for (const output of outputs)
      this.outputs.push(output);

    if (this.changeIndex !== -1) {
      this.changeIndex = this.outputs.indexOf(changeOutput);
      assert(this.changeIndex !== -1);
    }
  }

  /**
   * Avoid fee sniping.
   * @param {Number} - Current chain height.
   * @see bitcoin/src/wallet/wallet.cpp
   */

  avoidFeeSniping(height) {
    assert(typeof height === 'number', 'Must pass in height.');

    if ((Math.random() * 10 | 0) === 0) {
      height -= Math.random() * 100 | 0;

      if (height < 0)
        height = 0;
    }

    this.setLocktime(height);
  }

  /**
   * Set locktime and sequences appropriately.
   * @param {Number} locktime
   * @param {Boolean?} seconds
   */

  setLocktime(locktime, seconds) {
    assert(Number.isSafeInteger(locktime) && locktime >= 0,
      'Locktime must be an unsigned integer.');
    assert(this.inputs.length > 0, 'Cannot set sequence with no inputs.');

    if (seconds) {
      assert(locktime < 2 ** 40, 'Time locktime must be 40 bits.');
      locktime /= consensus.LOCKTIME_MULT;
      locktime |= consensus.LOCKTIME_FLAG;
      locktime >>>= 0;
    } else {
      assert((locktime & consensus.LOCKTIME_MASK) === locktime,
        'Height locktime must be 31 bits.');
    }

    for (const input of this.inputs) {
      if (input.sequence === 0xffffffff)
        input.sequence = 0xfffffffe;
    }

    this.locktime = locktime;
  }

  /**
   * Set sequence locktime.
   * @param {Number} index - Input index.
   * @param {Number} locktime
   * @param {Boolean?} seconds
   */

  setSequence(index, locktime, seconds) {
    const input = this.inputs[index];

    assert(input, 'Input does not exist.');
    assert((locktime >>> 0) === locktime, 'Locktime must be a uint32.');

    if (seconds) {
      locktime >>>= consensus.SEQUENCE_GRANULARITY;
      locktime &= consensus.SEQUENCE_MASK;
      locktime |= consensus.SEQUENCE_TYPE_FLAG;
    } else {
      locktime &= consensus.SEQUENCE_MASK;
    }

    input.sequence = locktime;
  }

  /**
   * Inspect the transaction.
   * @returns {Object}
   */

  format() {
    return super.format(this.view);
  }

  /**
   * Convert transaction to JSON.
   * @returns {Object}
   */

  toJSON() {
    return super.getJSON(null, this.view);
  }

  /**
   * Convert transaction to JSON.
   * @param {Network} network
   * @returns {Object}
   */

  getJSON(network) {
    return super.getJSON(network, this.view);
  }

  /**
   * Inject properties from a json object.
   * @param {Object} json
   */

  fromJSON(json) {
    super.fromJSON(json);

    for (let i = 0; i < json.inputs.length; i++) {
      const input = json.inputs[i];
      const {prevout} = input;

      if (!input.coin)
        continue;

      const coin = Coin.fromJSON(input.coin);

      coin.hash = util.parseHex(prevout.hash, 32);
      coin.index = prevout.index;

      this.view.addCoin(coin);

      if (!input.path)
        continue;

      if(!(this.view instanceof WalletCoinView))
        this.view = WalletCoinView.fromCoinView(this.view);

      const outpoint = Outpoint.fromJSON(prevout);
      const path = Path.fromJSON(input.path);

      this.view.addPath(outpoint, path);
    }

    return this;
  }

  /**
   * Convert the MTX to a TX.
   * @returns {TX}
   */

  toTX() {
    return new TX().inject(this);
  }

  /**
   * Convert the MTX to a TX.
   * @returns {Array} [tx, view]
   */

  commit() {
    return [this.toTX(), this.view];
  }

  /**
   * Instantiate MTX from TX.
   * @param {TX} tx
   * @returns {MTX}
   */

  fromTX(tx) {
    return super.inject(tx);
  }

  /**
   * Instantiate MTX from TX.
   * @param {TX} tx
   * @returns {MTX}
   */

  static fromTX(tx) {
    return new this().fromTX(tx);
  }

  /**
   * Test whether an object is an MTX.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isMTX(obj) {
    return obj instanceof MTX;
  }
}

/**
 * Coin Selector
 * @alias module:primitives.CoinSelector
 */

class CoinSelector {
  /**
   * Create a coin selector.
   * @constructor
   * @param {TX} tx
   * @param {Object?} options
   */

  constructor(tx, options) {
    this.tx = tx.clone();
    this.coins = [];
    this.outputValue = 0;
    this.index = 0;
    this.chosen = [];
    this.change = 0;
    this.fee = CoinSelector.MIN_FEE;

    this.selection = 'value';
    this.subtractFee = false;
    this.subtractIndex = -1;
    this.height = -1;
    this.depth = -1;
    this.hardFee = -1;
    this.rate = CoinSelector.FEE_RATE;
    this.maxFee = -1;
    this.round = false;
    this.coinbaseMaturity = 400;
    this.changeAddress = null;
    this.inputs = new BufferMap();

    // Needed for size estimation.
    this.estimate = null;

    this.injectInputs();

    if (options)
      this.fromOptions(options);
  }

  /**
   * Initialize selector options.
   * @param {Object} options
   * @private
   */

  fromOptions(options) {
    if (options.selection) {
      assert(typeof options.selection === 'string');
      this.selection = options.selection;
    }

    if (options.subtractFee != null) {
      if (typeof options.subtractFee === 'number') {
        assert(Number.isSafeInteger(options.subtractFee));
        assert(options.subtractFee >= -1);
        this.subtractIndex = options.subtractFee;
        this.subtractFee = this.subtractIndex !== -1;
      } else {
        assert(typeof options.subtractFee === 'boolean');
        this.subtractFee = options.subtractFee;
      }
    }

    if (options.subtractIndex != null) {
      assert(Number.isSafeInteger(options.subtractIndex));
      assert(options.subtractIndex >= -1);
      this.subtractIndex = options.subtractIndex;
      this.subtractFee = this.subtractIndex !== -1;
    }

    if (options.height != null) {
      assert(Number.isSafeInteger(options.height));
      assert(options.height >= -1);
      this.height = options.height;
    }

    if (options.confirmations != null) {
      assert(Number.isSafeInteger(options.confirmations));
      assert(options.confirmations >= -1);
      this.depth = options.confirmations;
    }

    if (options.depth != null) {
      assert(Number.isSafeInteger(options.depth));
      assert(options.depth >= -1);
      this.depth = options.depth;
    }

    if (options.hardFee != null) {
      assert(Number.isSafeInteger(options.hardFee));
      assert(options.hardFee >= -1);
      this.hardFee = options.hardFee;
    }

    if (options.rate != null) {
      assert(Number.isSafeInteger(options.rate));
      assert(options.rate >= 0);
      this.rate = options.rate;
    }

    if (options.maxFee != null) {
      assert(Number.isSafeInteger(options.maxFee));
      assert(options.maxFee >= -1);
      this.maxFee = options.maxFee;
    }

    if (options.round != null) {
      assert(typeof options.round === 'boolean');
      this.round = options.round;
    }

    if (options.coinbaseMaturity != null) {
      assert((options.coinbaseMaturity >>> 0) === options.coinbaseMaturity);
      this.coinbaseMaturity = options.coinbaseMaturity;
    }

    if (options.changeAddress) {
      const addr = options.changeAddress;
      if (typeof addr === 'string') {
        this.changeAddress = Address.fromString(addr);
      } else {
        assert(addr instanceof Address);
        this.changeAddress = addr;
      }
    }

    if (options.estimate) {
      assert(typeof options.estimate === 'function');
      this.estimate = options.estimate;
    }

    if (options.inputs) {
      assert(Array.isArray(options.inputs));
      for (let i = 0; i < options.inputs.length; i++) {
        const prevout = options.inputs[i];
        assert(prevout && typeof prevout === 'object');
        const {hash, index} = prevout;
        this.inputs.set(Outpoint.toKey(hash, index), i);
      }
    }

    return this;
  }

  /**
   * Attempt to inject existing inputs.
   * @private
   */

  injectInputs() {
    if (this.tx.inputs.length > 0) {
      for (let i = 0; i < this.tx.inputs.length; i++) {
        const {prevout} = this.tx.inputs[i];
        this.inputs.set(prevout.toKey(), i);
      }
    }
  }

  /**
   * Initialize the selector with coins to select from.
   * @param {Coin[]} coins
   */

  init(coins) {
    this.coins = coins.slice();
    this.outputValue = this.tx.getOutputValue();
    this.index = 0;
    this.chosen = [];
    this.change = 0;
    this.fee = CoinSelector.MIN_FEE;
    this.tx.inputs.length = 0;

    switch (this.selection) {
      case 'all':
      case 'random':
        this.coins.sort(sortRandom);
        break;
      case 'age':
        this.coins.sort(sortAge);
        break;
      case 'value':
        this.coins.sort(sortValue);
        break;
      default:
        throw new FundingError(`Bad selection type: ${this.selection}.`);
    }
  }

  /**
   * Calculate total value required.
   * @returns {Amount}
   */

  total() {
    if (this.subtractFee)
      return this.outputValue;
    return this.outputValue + this.fee;
  }

  /**
   * Test whether the selector has
   * completely funded the transaction.
   * @returns {Boolean}
   */

  isFull() {
    return this.tx.getInputValue() >= this.total();
  }

  /**
   * Test whether a coin is spendable
   * with regards to the options.
   * @param {Coin} coin
   * @returns {Boolean}
   */

  isSpendable(coin) {
    if (this.tx.view.hasEntry(coin))
      return false;

    if (coin.covenant.isNonspendable())
      return false;

    if (this.height === -1)
      return true;

    if (coin.coinbase) {
      if (coin.height === -1)
        return false;

      if (this.height + 1 < coin.height + this.coinbaseMaturity)
        return false;

      return true;
    }

    if (this.depth === -1)
      return true;

    const depth = coin.getDepth(this.height);

    if (depth < this.depth)
      return false;

    return true;
  }

  /**
   * Get the current fee based on a size.
   * @param {Number} size
   * @returns {Amount}
   */

  getFee(size) {
    // This is mostly here for testing.
    // i.e. A fee rounded to the nearest
    // kb is easier to predict ahead of time.
    if (this.round) {
      const fee = policy.getRoundFee(size, this.rate);
      return Math.min(fee, CoinSelector.MAX_FEE);
    }

    const fee = policy.getMinFee(size, this.rate);
    return Math.min(fee, CoinSelector.MAX_FEE);
  }

  /**
   * Fund the transaction with more
   * coins if the `output value + fee`
   * total was updated.
   */

  fund() {
    // Ensure all preferred inputs first.
    if (this.inputs.size > 0) {
      const coins = [];

      for (let i = 0; i < this.inputs.size; i++)
        coins.push(null);

      for (const coin of this.coins) {
        const {hash, index} = coin;
        const key = Outpoint.toKey(hash, index);
        const i = this.inputs.get(key);

        if (i != null) {
          coins[i] = coin;
          this.inputs.delete(key);
        }
      }

      if (this.inputs.size > 0)
        throw new Error('Could not resolve preferred inputs.');

      for (const coin of coins) {
        this.tx.addCoin(coin);
        this.chosen.push(coin);
      }
    }

    if (this.isFull())
      return;

    while (this.index < this.coins.length) {
      const coin = this.coins[this.index++];

      if (!this.isSpendable(coin))
        continue;

      this.tx.addCoin(coin);
      this.chosen.push(coin);

      if (this.selection === 'all')
        continue;

      if (this.isFull())
        break;
    }
  }

  /**
   * Initiate selection from `coins`.
   * @param {Coin[]} coins
   * @returns {CoinSelector}
   */

  async select(coins) {
    this.init(coins);

    if (this.hardFee !== -1) {
      this.selectHard();
    } else {
      // This is potentially asynchronous:
      // it may invoke the size estimator
      // required for redeem scripts (we
      // may be calling out to a wallet
      // or something similar).
      await this.selectEstimate();
    }

    if (!this.isFull()) {
      // Still failing to get enough funds.
      throw new FundingError(
        'Not enough funds.',
        this.tx.getInputValue(),
        this.total());
    }

    // How much money is left after filling outputs.
    this.change = this.tx.getInputValue() - this.total();

    return this;
  }

  /**
   * Initialize selection based on size estimate.
   */

  async selectEstimate() {
    // Set minimum fee and do
    // an initial round of funding.
    this.fee = CoinSelector.MIN_FEE;
    this.fund();

    // Add dummy output for change.
    const change = new Output();

    if (this.changeAddress) {
      change.address = this.changeAddress;
    } else {
      // In case we don't have a change address,
      // we use a fake p2pkh output to gauge size.
      change.address.fromPubkeyhash(Buffer.allocUnsafe(20));
    }

    this.tx.outputs.push(change);

    // Keep recalculating the fee and funding
    // until we reach some sort of equilibrium.
    do {
      const size = await this.tx.estimateSize(this.estimate);

      this.fee = this.getFee(size);

      if (this.maxFee > 0 && this.fee > this.maxFee)
        throw new FundingError('Fee is too high.');

      // Failed to get enough funds, add more coins.
      if (!this.isFull())
        this.fund();
    } while (!this.isFull() && this.index < this.coins.length);
  }

  /**
   * Initiate selection based on a hard fee.
   */

  selectHard() {
    this.fee = Math.min(this.hardFee, CoinSelector.MAX_FEE);
    this.fund();
  }
}

/**
 * Default fee rate
 * for coin selection.
 * @const {Amount}
 * @default
 */

CoinSelector.FEE_RATE = 10000;

/**
 * Minimum fee to start with
 * during coin selection.
 * @const {Amount}
 * @default
 */

CoinSelector.MIN_FEE = 10000;

/**
 * Maximum fee to allow
 * after coin selection.
 * @const {Amount}
 * @default
 */

CoinSelector.MAX_FEE = consensus.COIN / 10;

/**
 * Funding Error
 * An error thrown from the coin selector.
 * @ignore
 * @extends Error
 * @property {String} message - Error message.
 * @property {Amount} availableFunds
 * @property {Amount} requiredFunds
 */

class FundingError extends Error {
  /**
   * Create a funding error.
   * @constructor
   * @param {String} msg
   * @param {Amount} available
   * @param {Amount} required
   */

  constructor(msg, available, required) {
    super();

    this.type = 'FundingError';
    this.message = msg;
    this.availableFunds = -1;
    this.requiredFunds = -1;

    if (available != null) {
      this.message += ` (available=${Amount.coin(available)},`;
      this.message += ` required=${Amount.coin(required)})`;
      this.availableFunds = available;
      this.requiredFunds = required;
    }

    if (Error.captureStackTrace)
      Error.captureStackTrace(this, FundingError);
  }
}

/*
 * Helpers
 */

function sortAge(a, b) {
  a = a.height === -1 ? 0x7fffffff : a.height;
  b = b.height === -1 ? 0x7fffffff : b.height;
  return a - b;
}

function sortRandom(a, b) {
  return Math.random() > 0.5 ? 1 : -1;
}

function sortValue(a, b) {
  if (a.height === -1 && b.height !== -1)
    return 1;

  if (a.height !== -1 && b.height === -1)
    return -1;

  return b.value - a.value;
}

function sortInputs(a, b) {
  return a.compare(b);
}

function sortOutputs(a, b) {
  return a.compare(b);
}

function sortLinked(a, b) {
  return a[0].compare(b[0]);
}

/*
 * Expose
 */

exports = MTX;
exports.MTX = MTX;
exports.Selector = CoinSelector;
exports.FundingError = FundingError;

module.exports = exports;
