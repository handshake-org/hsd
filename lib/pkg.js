/*!
 * pkg.js - package constants
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const pkg = exports;

/**
 * Package Name
 * @const {String}
 * @default
 */

pkg.name = 'hsd';

/**
 * Project Name
 * @const {String}
 * @default
 */

pkg.core = 'hsd';

/**
 * Organization Name
 * @const {String}
 * @default
 */

pkg.organization = 'handshake-org';

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

pkg.unit = 'hns';

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

pkg.version = '2.2.0';

/**
 * Repository URL.
 * @const {String}
 * @default
 */

pkg.url = `https://github.com/${pkg.organization}/${pkg.name}`;
