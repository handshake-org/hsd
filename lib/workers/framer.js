/*!
 * workers.js - worker processes for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const bio = require('bufio');

/**
 * Framer
 * @alias module:workers.Framer
 */

class Framer {
  /**
   * Create a framer.
   * @constructor
   */

  constructor() {}

  packet(payload) {
    const size = 10 + payload.getSize();
    const bw = bio.write(size);

    bw.writeU32(payload.id);
    bw.writeU8(payload.cmd);
    bw.seek(4);

    payload.toWriter(bw);

    bw.writeU8(0x0a);

    const msg = bw.render();
    msg.writeUInt32LE(msg.length - 10, 5, true);

    return msg;
  }
}

/*
 * Expose
 */

module.exports = Framer;
