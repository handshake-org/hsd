/*!
 * script/index.js - bitcoin scripting for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

/**
 * @module script
 */

exports.common = require('./common');
exports.Opcode = require('./opcode');
exports.Script = require('./script');
exports.ScriptError = require('./scripterror');
exports.ScriptNum = require('./scriptnum');
exports.sigcache = require('./sigcache');
exports.Stack = require('./stack');
exports.Witness = require('./witness');
