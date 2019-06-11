/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-unused-vars: "off" */

'use strict';

const assert = require('bsert');
const MTX = require('../lib/primitives/mtx');

const mtx1json = require('./data/mtx1.json');
const mtx2json = require('./data/mtx2.json');
const mtx1 = MTX.fromJSON(mtx1json);
const mtx2 = MTX.fromJSON(mtx2json);

describe('MTX', function() {
  it('should serialize path', () => {
    const input = mtx1.inputs[0];
    const view = mtx1.view;
    const coin = view.getCoinFor(input);
    const path = view.getPathFor(input);
    const json = input.getJSON('regtest', coin, path);
    const got = json.path;
    const want = {
      name: 'default',
      account: 0,
      change: false,
      derivation: 'm/44\'/5355\'/0\'/0/0'
    };

    assert.deepStrictEqual(got, want);
  });

  it('should not serialize path', () => {
    const input = mtx2.inputs[0];
    const view = mtx2.view;
    const coin = view.getCoinFor(input);
    const path = view.getPathFor(input);
    const json = input.getJSON('regtest', coin, path);
    const got = json.path;
    const want = undefined;

    assert.deepStrictEqual(got, want);
  });
});
