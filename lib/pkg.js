/*!
 * pkg.js - package constants
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

/**
 * Package Name
 * @const {String}
 * @default
 */

exports.name = 'hsk';

/**
 * Organization Name
 * @const {String}
 * @default
 */

exports.organization = 'handshakecompany';

/**
 * Currency Name
 * @const {String}
 * @default
 */

exports.currency = 'handshake';

/**
 * Currency Unit
 * @const {String}
 * @default
 */

exports.unit = 'hsk';

/**
 * Base Unit (dollarydoos!)
 * @const {String}
 * @default
 */

exports.base = 'doo';

/**
 * Config file name.
 * @const {String}
 * @default
 */

exports.cfg = `${exports.name}.cfg`;

/**
 * Current version string.
 * @const {String}
 * @default
 */

exports.version = '0.0.0';

/**
 * Repository URL.
 * @const {String}
 * @default
 */

exports.url = `https://github.com/${exports.organization}/${exports.name}`;
