/*!
 * worker.js - worker thread/process for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const Master = require('./master');
const server = new Master();

process.title = 'hsd-worker';

server.listen();
