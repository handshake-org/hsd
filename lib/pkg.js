/*!
 * pkg.js - package constants
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const pkg = exports;

/**
 * Package Name
 * @const {String}
 * @default
 */

pkg.name = 'hskd';

/**
 * Project Name
 * @const {String}
 * @default
 */

pkg.core = 'hsk';

/**
 * Organization Name
 * @const {String}
 * @default
 */

pkg.organization = 'handshakecompany';

/**
 * Currency Name
 * @const {String}
 * @default
 */

pkg.currency = 'handshake';

/**
 * Currency Unit
 * @const {String}
 * @default
 */

pkg.unit = 'hsk';

/**
 * Base Unit (dollarydoos!)
 * @const {String}
 * @default
 */

pkg.base = 'doo';

/**
 * Config file name.
 * @const {String}
 * @default
 */

pkg.cfg = `${pkg.core}.conf`;

/**
 * Current version string.
 * @const {String}
 * @default
 */

pkg.version = '0.0.0';

/**
 * Repository URL.
 * @const {String}
 * @default
 */

pkg.url = `https://github.com/${pkg.organization}/${pkg.name}`;
