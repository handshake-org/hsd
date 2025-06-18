/*!
 * coinselector.js - Coin Selector
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2025, Nodari Chkuaselidze (MIT License)
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const Amount = require('../ui/amount');
const Address = require('../primitives/address');
const Output = require('../primitives/output');
const Outpoint = require('../primitives/outpoint');
const policy = require('../protocol/policy');
const {BufferMap} = require('buffer-map');

/** @typedef {import('../types').Amount} AmountValue */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('../coins/coinview')} CoinView */
/** @typedef {import('../primitives/mtx').MTX} MTX */
/** @typedef {import('../primitives/coin')} Coin */

class AbstractCoinSource {
  /**
   * Initialize the coin source.
   * @returns {Promise}
   */

  async init() {
    throw new Error('Abstract method.');
  }

  /**
   * @returns {Boolean}
   */

  hasNext() {
    throw new Error('Abstract method.');
  }

  /**
   * @returns {Promise<Coin?>}
   */

  next() {
    throw new Error('Abstract method.');
  }

  /**
   * @param {BufferMap<Number>} inputs
   * @param {Coin[]} coins - Coin per input.
   * @returns {Promise<void>}
   */

  async resolveInputsToCoins(inputs, coins) {
    throw new Error('Abstract method.');
  }
}

/** @typedef {'all'|'random'|'age'|'value'} MemSelectionType */

/**
 * @typedef {Object} CoinSourceOptions
 * @property {MemSelectionType} [selection] - Selection type.
 * @property {Coin[]} [coins] - Coins to select from.
 */

/**
 * Coin Source with coins.
 * @alias module:utils.CoinSource
 */

class InMemoryCoinSource extends AbstractCoinSource {
  /**
   * @param {CoinSourceOptions} [options]
   */

  constructor(options = {}) {
    super();

    /** @type {Coin[]} */
    this.coins = [];

    /** @type {MemSelectionType} */
    this.selection = 'value';

    this.index = -1;

    if (options)
      this.fromOptions(options);
  }

  /**
   * @param {CoinSourceOptions} options
   * @returns {this}
   */

  fromOptions(options = {}) {
    if (options.coins != null) {
      assert(Array.isArray(options.coins), 'Coins must be an array.');
      this.coins = options.coins.slice();
    }

    if (options.selection != null) {
      assert(typeof options.selection === 'string',
        'Selection must be a string.');
      this.selection = options.selection;
    }

    return this;
  }

  async init() {
    this.index = 0;

    switch (this.selection) {
      case 'all':
      case 'random':
        shuffle(this.coins);
        break;
      case 'age':
        this.coins.sort(sortAge);
        break;
      case 'value':
        this.coins.sort(sortValue);
        break;
      default:
        throw new FundingError(`Bad selection type: ${this.selection}`);
    }
  }

  hasNext() {
    return this.index < this.coins.length;
  }

  /**
   * @returns {Promise<Coin?>}
   */

  async next() {
    if (!this.hasNext())
      return null;

    return this.coins[this.index++];
  }

  /**
   * @param {BufferMap<Number>} inputs
   * @param {Coin[]} coins
   * @returns {Promise<void>}
   */

  async resolveInputsToCoins(inputs, coins) {
    for (const coin of this.coins) {
      const {hash, index} = coin;
      const key = Outpoint.toKey(hash, index);
      const i = inputs.get(key);

      if (i != null) {
        assert(!coins[i]);
        coins[i] = coin;
        inputs.delete(key);
      }
    }
  }
}

/**
 * @typedef {Object} InputOption
 * @property {Hash} hash
 * @property {Number} index
 */

/**
 * @typedef {Object} CoinSelectorOptions
 * @property {Address} [changeAddress] - Change address.
 * @property {Boolean} [subtractFee] - Subtract fee from output.
 * @property {Number} [subtractIndex] - Index of output to subtract fee from.
 * @property {Number} [height] - Current chain height.
 * @property {Number} [depth] - Minimum confirmation depth of coins to spend.
 * @property {Number} [confirmations] - depth alias.
 * @property {Number} [coinbaseMaturity] - When do CBs become spendable.
 * @property {Number} [hardFee] - Fixed fee.
 * @property {Number} [rate] - Rate of dollarydoo per kB.
 * @property {Number} [maxFee] - Maximum fee we are willing to pay.
 * @property {Boolean} [round] - Round to the nearest kilobyte.
 * @property {Function?} [estimate] - Input script size estimator.
 * @property {Boolean} [selectAll] - Select all coins.
 * @property {InputOption[]} [inputs] - Inputs to use for funding.
 */

/**
 * Coin Selector
 * @alias module:utils.CoinSelector
 * @property {MTX} tx - clone of the original mtx.
 * @property {CoinView} view - reference to the original view.
 */

class CoinSelector {
  /**
   * @param {MTX} mtx
   * @param {AbstractCoinSource} source
   * @param {CoinSelectorOptions?} [options]
   */

  constructor(mtx, source, options = {}) {
    this.original = mtx;
    /** @type {MTX} */
    this.tx = mtx.clone();
    /** @type {CoinView} */
    this.view = mtx.view;
    this.source = source;
    this.outputValue = 0;
    this.fee = CoinSelector.MIN_FEE;

    /** @type {Coin[]} */
    this.chosen = [];

    this.selectAll = false;
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
    this.estimate = null;

    /** @type {BufferMap<Number>} */
    this.inputs = new BufferMap();

    this.injectInputs();

    if (options)
      this.fromOptions(options);
  }

  /**
   * @param {CoinSelectorOptions} [options]
   * @returns {this}
   */

  fromOptions(options = {}) {
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

    if (options.selectAll != null) {
      assert(typeof options.selectAll === 'boolean');
      this.selectAll = options.selectAll;
    }

    if (options.inputs) {
      assert(Array.isArray(options.inputs));

      const lastIndex = this.inputs.size;
      for (let i = 0; i < options.inputs.length; i++) {
        const prevout = options.inputs[i];
        assert(prevout && typeof prevout === 'object');
        const {hash, index} = prevout;
        this.inputs.set(Outpoint.toKey(hash, index), lastIndex + i);
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
   */

  init() {
    this.outputValue = this.tx.getOutputValue();
    this.chosen = [];
    this.change = 0;
    this.fee = CoinSelector.MIN_FEE;
    this.tx.inputs.length = 0;
  }

  /**
   * Calculate total value required.
   * @returns {AmountValue}
   */

  total() {
    if (this.subtractFee)
      return this.outputValue;

    return this.outputValue + this.fee;
  }

  /**
   * Test whether filler
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
   * @returns {AmountValue}
   */

  getFee(size) {
    // This is mostly here for testing.
    // i.e. A fee rounded to the nearest
    // kb is easier to predict ahead of time.
    if (this.round)
      return policy.getRoundFee(size, this.rate);

    return policy.getMinFee(size, this.rate);
  }

  /**
   * Fund the transaction with more
   * coins if the `output value + fee`
   * total was updated.
   * @returns {Promise<void>}
   */

  async fund() {
    // Ensure all preferred inputs first.
    await this.resolveInputCoins();

    if (this.isFull() && !this.selectAll)
      return;

    for (;;) {
      const coin = await this.source.next();

      if (!coin)
        break;

      if (!this.isSpendable(coin))
        continue;

      this.tx.addCoin(coin);
      this.chosen.push(coin);

      if (this.selectAll)
        continue;

      if (this.isFull())
        break;
    }
  }

  /**
   * Initialize selection based on size estimate.
   */

  async selectEstimate() {
    // Set minimum fee and do
    // an initial round of funding.
    this.fee = CoinSelector.MIN_FEE;
    await this.fund();

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
        await this.fund();
    } while (!this.isFull() && this.source.hasNext());
  }

  /**
   * Collect coins for the transaction.
   * @returns {Promise<void>}
   */

  async selectHard() {
    this.fee = this.hardFee;
    await this.fund();
  }

  /**
   * Fill the transaction with inputs.
   * @returns {Promise<this>}
   */

  async select() {
    this.init();

    if (this.hardFee !== -1) {
      await this.selectHard();
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

  async resolveInputCoins() {
    if (this.inputs.size === 0)
      return;

    /** @type {Coin[]} */
    const coins = [];

    for (let i = 0 ; i < this.inputs.size; i++) {
      coins.push(null);
    }

    // first resolve from coinview if possible.
    for (const key of this.inputs.keys()) {
      const prevout = Outpoint.fromKey(key);

      if (this.view.hasEntry(prevout)) {
        const coinEntry = this.view.getEntry(prevout);
        const i = this.inputs.get(key);

        if (i != null) {
          assert(!coins[i]);
          coins[i] = coinEntry.toCoin(prevout);
          this.inputs.delete(key);
        }
      }
    }

    if (this.inputs.size > 0)
      await this.source.resolveInputsToCoins(this.inputs, coins);

    if (this.inputs.size > 0)
      throw new Error('Could not resolve preferred inputs.');

    for (const coin of coins) {
      this.tx.addCoin(coin);
      this.chosen.push(coin);
    }
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
   * @param {AmountValue} [available]
   * @param {AmountValue} [required]
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

/**
 * @param {Coin} a
 * @param {Coin} b
 * @returns {Number}
 */

function sortAge(a, b) {
  const ah = a.height === -1 ? 0x7fffffff : a.height;
  const bh = b.height === -1 ? 0x7fffffff : b.height;
  return ah - bh;
}

/**
 * @param {Coin[]} coins
 * @returns {Coin[]}
 */

function shuffle(coins) {
  for (let i = coins.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [coins[i], coins[j]] = [coins[j], coins[i]];
  }
  return coins;
}

/**
 * @param {Coin} a
 * @param {Coin} b
 * @returns {Number}
 */

function sortValue(a, b) {
  if (a.height === -1 && b.height !== -1)
    return 1;

  if (a.height !== -1 && b.height === -1)
    return -1;

  return b.value - a.value;
}

exports.AbstractCoinSource = AbstractCoinSource;
exports.InMemoryCoinSource = InMemoryCoinSource;
exports.CoinSelector = CoinSelector;
exports.FundingError = FundingError;
