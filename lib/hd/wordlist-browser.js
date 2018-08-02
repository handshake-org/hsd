/*!
 * wordlist.js - wordlists for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const words = require('./words');

exports.get = function get(name) {
  switch (name) {
    case 'simplified chinese':
      return words.chinese.simplified;
    case 'traditional chinese':
      return words.chinese.traditional;
    case 'english':
      return words.english;
    case 'french':
      return words.french;
    case 'italian':
      return words.italian;
    case 'japanese':
      return words.japanese;
    case 'spanish':
      return words.spanish;
    default:
      throw new Error(`Unknown language: ${name}.`);
  }
};
