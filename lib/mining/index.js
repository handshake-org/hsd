/*!
 * mining/index.js - mining infrastructure for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

/**
 * @module mining
 */

exports.common = require('./common');
exports.CPUMiner = require('./cpuminer');
exports.mine = require('./mine');
exports.Miner = require('./miner');
exports.BlockTemplate = require('./template');
