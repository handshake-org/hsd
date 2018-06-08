/*!
 * worker.js - worker thread/process for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hskd
 */

'use strict';

const Master = require('./master');
const server = new Master();

server.listen();
