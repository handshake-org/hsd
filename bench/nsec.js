'use strict';

const bench = require('./bench');
const nsec = require('../lib/dns/nsec');
const {TYPE_MAP_EMPTY} = require('../lib/dns/common');

const tld = 'dollarydoo';
const ops = 100000;

const end = bench('nsec');
for (let i = 0; i < ops; i++) {
  const prev = nsec.prevName(tld);
  const next = nsec.nextName(tld);
  nsec.create(prev, next, TYPE_MAP_EMPTY);
}
end(ops);
