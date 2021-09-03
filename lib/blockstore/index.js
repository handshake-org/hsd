/*!
 * blockstore/index.js - blockstore for hsd
 * Copyright (c) 2019, Braydon Fuller (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const {join} = require('path');

const AbstractBlockStore = require('./abstract');
const LevelBlockStore = require('./level');
const FileBlockStore = require('./file');

/**
 * @module blockstore
 */

exports.create = (options) => {
  if (options.memory) {
    return new LevelBlockStore({
      network: options.network,
      logger: options.logger,
      cacheSize: options.cacheSize,
      memory: options.memory
    });
  }

  const location = join(options.prefix, 'blocks');

  return new FileBlockStore({
    network: options.network,
    logger: options.logger,
    location: location,
    cacheSize: options.cacheSize,
    maxFileLength: options.maxFileLength
  });
};

exports.AbstractBlockStore = AbstractBlockStore;
exports.FileBlockStore = FileBlockStore;
exports.LevelBlockStore = LevelBlockStore;
