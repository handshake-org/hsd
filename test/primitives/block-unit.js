/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const {BloomFilter} = require('bfilter');
const assert = require('../util/assert');
const common = require('../util/common');
const Block = require('../../lib/primitives/block');
const MerkleBlock = require('../../lib/primitives/merkleblock');
const consensus = require('../../lib/protocol/consensus');
const Network = require('../../lib/protocol/network');
const Script = require('../../lib/script/script');
const bip152 = require('../../lib/net/bip152');
const CompactBlock = bip152.CompactBlock;
const TXRequest = bip152.TXRequest;
const TXResponse = bip152.TXResponse;

describe('Block', function() {
  this.timeout(10000);
});
