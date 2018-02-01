/*!
 * nfkd.js - unicode normalization for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

/**
 * Normalize unicode string.
 * @alias module:utils.nfkd
 * @param {String} str
 * @returns {String}
 */

function nfkd(str) {
  return str.normalize('NFKD');
}

/*
 * Expose
 */

module.exports = nfkd;
