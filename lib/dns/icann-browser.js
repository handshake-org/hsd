'use strict';

const assert = require('bsert');
const tld = require('./tld.json');

/**
 * ICANN Root Zone
 */

class ICANN {
  constructor(data) {
    this.data = data;
  }

  has(name) {
    assert(typeof name === 'string');

    name = trimFQDN(name);

    if (name.length === 0 || name.length > 63)
      return false;

    name = name.toLowerCase();

    const data = this.data[name];

    if (!data)
      return false;

    return typeof data === 'string';
  }

  get(name) {
    assert(typeof name === 'string');

    name = trimFQDN(name);

    if (name.length === 0 || name.length > 63)
      return null;

    name = name.toLowerCase();

    const data = this.data[name];

    if (!data)
      return false;

    if (typeof data !== 'string')
      return null;

    return Buffer.from(data, 'base64');
  }
}

/*
 * Helpers
 */

function trimFQDN(name) {
  if (name.length > 0 && name[name.length - 1] === '.')
    name = name.slice(0, -1);
  return name;
}

/*
 * Expose
 */

module.exports = new ICANN(tld);
