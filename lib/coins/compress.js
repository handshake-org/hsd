/*!
 * compress.js - coin compressor for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module coins/compress
 * @ignore
 */

const {encoding} = require('bufio');

/**
 * Compress an output.
 * @param {Output} output
 * @param {BufferWriter} bw
 */

function compressOutput(output, bw) {
  bw.writeVarint(output.value);
  output.address.write(bw);
  output.covenant.write(bw);
  return bw;
}

/**
 * Decompress a script from buffer reader.
 * @param {Output} output
 * @param {BufferReader} br
 */

function decompressOutput(output, br) {
  output.value = br.readVarint();
  output.address.read(br);
  output.covenant.read(br);
  return output;
}

/**
 * Calculate output size.
 * @returns {Number}
 */

function sizeOutput(output) {
  let size = 0;
  size += encoding.sizeVarint(output.value);
  size += output.address.getSize();
  size += output.covenant.getVarSize();
  return size;
}

/**
 * Compress value using an exponent. Takes advantage of
 * the fact that many values are divisible by 10.
 * @see https://github.com/btcsuite/btcd/blob/master/blockchain/compress.go
 * @param {Amount} value
 * @returns {Number}
 */

function compressValue(value) {
  if (value === 0)
    return 0;

  let exp = 0;
  while (value % 10 === 0 && exp < 9) {
    value /= 10;
    exp += 1;
  }

  if (exp < 9) {
    const last = value % 10;
    value = (value - last) / 10;
    return 1 + 10 * (9 * value + last - 1) + exp;
  }

  return 10 + 10 * (value - 1);
}

/**
 * Decompress value.
 * @param {Number} value - Compressed value.
 * @returns {Amount} value
 */

function decompressValue(value) {
  if (value === 0)
    return 0;

  value -= 1;

  let exp = value % 10;

  value = (value - exp) / 10;

  let n;
  if (exp < 9) {
    const last = value % 9;
    value = (value - last) / 9;
    n = value * 10 + last + 1;
  } else {
    n = value + 1;
  }

  while (exp > 0) {
    n *= 10;
    exp -= 1;
  }

  return n;
}

// Make eslint happy.
compressValue;
decompressValue;

/*
 * Expose
 */

exports.pack = compressOutput;
exports.unpack = decompressOutput;
exports.size = sizeOutput;
