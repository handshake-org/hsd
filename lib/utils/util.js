/*!
 * util.js - utils for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const {types} = require('../covenants/rules');

/**
 * @exports utils/util
 */

const util = exports;

/**
 * Return hrtime (shim for browser).
 * @param {Array} time
 * @returns {Array} [seconds, nanoseconds]
 */

util.bench = function bench(time) {
  if (!process.hrtime) {
    const now = Date.now();

    if (time) {
      const [hi, lo] = time;
      const start = hi * 1000 + lo / 1e6;
      return now - start;
    }

    const ms = now % 1000;

    // Seconds
    const hi = (now - ms) / 1000;

    // Nanoseconds
    const lo = ms * 1e6;

    return [hi, lo];
  }

  if (time) {
    const [hi, lo] = process.hrtime(time);
    return hi * 1000 + lo / 1e6;
  }

  return process.hrtime();
};

/**
 * Get current time in unix time (seconds).
 * @returns {Number}
 */

util.now = function now() {
  return Math.floor(Date.now() / 1000);
};

/**
 * Get current time in unix time (milliseconds).
 * @returns {Number}
 */

util.ms = function ms() {
  return Date.now();
};

/**
 * Create a Date ISO string from time in unix time (seconds).
 * @param {Number?} time - Seconds in unix time.
 * @returns {String}
 */

util.date = function date(time) {
  if (time == null)
    time = util.now();

  return new Date(time * 1000).toISOString().slice(0, -5) + 'Z';
};

/**
 * Get unix seconds from a Date string.
 * @param {String?} date - Date ISO String.
 * @returns {Number}
 */

util.time = function time(date) {
  if (date == null)
    return util.now();

  return new Date(date) / 1000 | 0;
};

/**
 * Convert u32 to padded hex.
 * @param {Number} num
 * @returns {String}
 */

util.hex32 = function hex32(num) {
  assert((num >>> 0) === num);
  num = num.toString(16);
  switch (num.length) {
    case 1:
      return `0000000${num}`;
    case 2:
      return `000000${num}`;
    case 3:
      return `00000${num}`;
    case 4:
      return `0000${num}`;
    case 5:
      return `000${num}`;
    case 6:
      return `00${num}`;
    case 7:
      return `0${num}`;
    case 8:
      return `${num}`;
    default:
      throw new Error();
  }
};

/**
 * Parse hex.
 * @param {String} str
 * @param {Number} size
 * @returns {Buffer}
 */

util.parseHex = function parseHex(str, size) {
  if (size == null)
    size = -1;

  assert(typeof str === 'string');
  assert(size === -1 || (size >>> 0) === size);

  if (str.length & 1)
    throw new Error('Invalid hex string.');

  if (size !== -1) {
    if ((str.length >>> 1) !== size)
      throw new Error('Invalid hex string.');
  }

  const data = Buffer.from(str, 'hex');

  if (data.length !== (str.length >>> 1))
    throw new Error('Invalid hex string.');

  return data;
};

/**
 * Test whether a number is a safe uint64.
 * @param {Number} num
 * @returns {Boolean}
 */

util.isU64 = function isU64(num) {
  return Number.isSafeInteger(num) && num >= 0;
};

/**
 * Encode a uint32.
 * @param {Number} num
 * @returns {Buffer}
 */

util.encodeU32 = function encodeU32(num) {
  assert(Number.isSafeInteger(num));
  const buf = Buffer.allocUnsafe(4);
  buf[0] = num;
  num >>>= 8;
  buf[1] = num;
  num >>>= 8;
  buf[2] = num;
  num >>>= 8;
  buf[3] = num;
  return buf;
};

/**
 * Create a valid mtx with limited
 * number of outputs
 * @param {Number} limit
 * @param {Map<String, Array<T>>} domainOutputMap
 * @returns {{
 *   validDomains: Array<{String, Number}>,
 *   invalidDomains: Array<{String, Number}>
 * }}
 */

util.createBatch = function(limit, domainOutputMap) {
  if (!limit || limit === 0)
    throw new Error('invalid limit provided!');

  if (!domainOutputMap || domainOutputMap.entries().length === 0) {
      throw new Error('Invalid map provided!');
  }

  const entriesArray = [...domainOutputMap.entries()];
  entriesArray.sort((elem1, elem2) => elem1[1].length > elem2[1].length);

  const rejectedDomains = [];
  const validDomains = [];
  let totalNumberOfOutputs = 0;

  for (const [name, outputs] of entriesArray) {
      const outputLen = totalNumberOfOutputs + outputs.length;
      if (outputLen > limit) {
        // if there is any space left, partially process the bids
        // of this domain
        const availableSpots = limit - totalNumberOfOutputs;
        if (availableSpots > 0) {
          totalNumberOfOutputs += availableSpots;
          validDomains.push({name, bidCount: availableSpots});
          const remainingBidsForDomain = outputs.length - availableSpots;
          rejectedDomains.push({name, bidCount: remainingBidsForDomain});
        } else {
          rejectedDomains.push({name, bidCount: outputs.length});
        }
      } else {
          totalNumberOfOutputs += outputs.length;
          validDomains.push({name, bidCount: outputs.length});
      }
  }

  return {validDomains: validDomains, rejectedDomains: rejectedDomains};
};

/**
 * Create a valid mtx with strictly limited
 * number of outputs, not partial reveals permitted
 * @param {Number} limit
 * @param {Map<String, Array<T>>} domainOutputMap
 * @returns {{
 *   validDomains: Array<{String, Number}>,
 *   invalidDomains: Array<{String, Number}>
 * }}
 */

util.createStrictBatch = function(limit, domainOutputMap) {
  if (!limit || limit === 0)
    throw new Error('invalid limit provided!');

  if (!domainOutputMap || domainOutputMap.entries().length === 0) {
      throw new Error('Invalid map provided!');
  }

  const entriesArray = [...domainOutputMap.entries()];
  entriesArray.sort((elem1, elem2) => elem1[1].length > elem2[1].length);

  const rejectedDomains = [];
  const validDomains = [];
  let totalNumberOfOutputs = 0;

  for (const [name, outputs] of entriesArray) {
    const outputLen = totalNumberOfOutputs + outputs.length;
    if (outputLen > limit) {
        rejectedDomains.push({name, bidCount: outputs.length});
    } else {
        totalNumberOfOutputs += outputs.length;
        validDomains.push({name, bidCount: outputs.length});
    }
}
  return {validDomains: validDomains, rejectedDomains: rejectedDomains};
};

/**
 * Transform BatchBids in to
 * Expected format
 * @param {string} txHash
 * @param {Array} tx Outputs
 * @param {Array} mtx Outputs
 * @returns {Array<Bid>} processedBids
 */

util.postProcessBatchBids = function(txHash, txOutputs, mtxOutputs) {
  const processedBids = [];

  for (let i=0; i<txOutputs.length; i++) {
    const txOutput  = txOutputs[i];
    if (txOutput.covenant.type === types.BID) {
      processedBids.push({
        idempotency_key: mtxOutputs[i].idempotencyKey,
        tx_hash: txHash,
        output_index: i,
        output: txOutput
      });
    }
  }
  //
  return processedBids;
};

/**
 * PostProcesses the Tx and formats
 * BatchFinish output
 * @param {*} txJSON Tx
 * @param {*} finishCache Cache
 * @param {Map<string,string>} nameHashMap name, namehash
 * @param {Array} processedFinishes holds formatted TX outputs
 * @returns {undefined} returns nothing
 */
util.postProcessBatchFinishes =
function (txJSON, finishCache, nameHashMap, processedFinishes) {
  txJSON.outputs.forEach((output, outputIndex) => {
    const covenant = output.covenant;
    const covenantType = covenant.type;

    if (
      covenantType === types.REDEEM ||
      covenantType === types.REGISTER
    ) {
      const nameHash = covenant.items[0];
      const name = nameHashMap.get(nameHash);
      const item = {
        idempotency_key: name,
        tx_hash: txJSON.hash,
        output_index: outputIndex,
        output: output,
        from_cache: false
      };
      processedFinishes.push(item);
      // populate cache
      const cachedItem = Object.assign({}, item);
      cachedItem.from_cache = true;
      // Handle Cache Insert
      if (!finishCache.get(name)) {
        finishCache.set(name, []);
      }

      finishCache.get(name).push(cachedItem);
    }
  });

  return processedFinishes;
};

/**
 *
 * Creates a ProcessedOutput
 * from provide parameters
 *
 * @param {Output} output
 * @param {Number} outputIndex
 * @param {String} txHash
 * @param {String} idempotencyKey
 * @returns {ProcessedOutput}
 */

util.postProcessOutput = function (output,
  outputIndex,
  txHash,
  idempotencyKey) {
  return {
    idempotency_key: idempotencyKey,
    tx_hash: txHash,
    output_index: outputIndex,
    output: output,
    from_cache: false
  };
};

/**
 * Retrieve keys from cache and apply placer mapper
 * function to each returned cache value and store placers
 * output in cacheHits.
 *
 * @param {LRU} cache processedOutputCache
 * @param {Array<String>} keys idempotencyKeys to look for within cache
 * @param {function} placer mapper function to map each cached
 * value to requested format
 * @returns {{ cacheHits: Array<ProcessedOutput>, cacheMisses: Array<String> }}
 * CacheSearchResult
 */
util.retrieveFromCache = function (cache, keys, placer) {
  const cacheMisses = [];
  const cacheHits = [];
  keys.forEach((key) => {
    if (cache.has(key)) {
      const retrieved = cache.get(key);
      placer(cacheHits, retrieved);
    } else {
      cacheMisses.push(key);
    }
  });

  return {
    cacheMisses,
    cacheHits
  };
};

/**
 * Retrieves keys from cache, each value is threated as an Array
 * and results accumulated to cacheHits
 *
 * @param {LRU} cache processedOutputCache
 * @param {Array<String>} keys idempotencyKeys to look for within cache
 * @returns {{ cacheHits: Array<ProcessedOutput>, cacheMisses: Array<String> }}
 * CacheSearchResult
 */

util.retrieveMultipleFromCache = function (cache, keys) {
  return this.retrieveFromCache(cache, keys, (cacheHits, retrieved) =>
    retrieved.forEach(element => cacheHits.push(element))
  );
};

/**
 * Retrieves keys from cache
 *
 * @param {LRU} cache processedOutputCache
 * @param {Array<string>} keys idempotencyKeys to look for within cache
 * @returns {{ cacheHits: Array<ProcessedOutput>, cacheMisses: Array<String> }}
 * CacheSearchResult
 */

util.retrieveSingleFromCache = function (cache, keys) {
  return this.retrieveFromCache(cache, keys, (cacheHits, retrieved) =>
    cacheHits.push(retrieved)
  );
};

/**
 * Stores processedOutput in cache, using the placer
 * to generate proper key
 *
 * @param {ProcessedOutput} processedOutput  the tx output
 * @param {LRU} cache processedOutputCache
 * @param {function} placer inserts the output into cache
 * @returns {undefined}
 */
util.storeInCache = function (processedOutput, cache, placer) {
  const cachedItem = Object.assign({}, processedOutput);
  cachedItem.from_cache = true;
  placer(cache, cachedItem);
};

/**
 * Stores processedOutput in cache as a member of an array
 *
 * @param {ProcessedOutput} processedOutput the tx output
 * @param {LRU} cache processedOutputCache
 * @returns {undefined}
 */
util.storeMultipleInCache = function (processedOutput, cache) {
  const placer = function (placerCache, item) {
    const idempotencyKey = item.idempotency_key;
    if (placerCache.has(idempotencyKey)) {
      placerCache.get(idempotencyKey).push(item);
    } else {
      placerCache.set(idempotencyKey, [item]);
    }
  };

  this.storeInCache(processedOutput, cache, placer);
};

/**
 * Stores processedOutput within cache
 *
 * @param {ProcessedOutput} processedOutput the tx output
 * @param {LRU} cache processedOutputCache
 * @returns {undefined}
 */
util.storeOneInCache = function (processedOutput, cache) {
  const placer = function (placerCache, item) {
    const idempotencyKey = item.idempotency_key;
      placerCache.set(idempotencyKey, item);
  };

  this.storeInCache(processedOutput, cache, placer);
};
