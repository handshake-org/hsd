'use strict';

const assert = require('bsert');
const {wire, util} = require('bns');
const {Record, NSECRecord, types} = wire;
const {DEFAULT_TTL} = require('./common');

function create(name, nextDomain, typeBitmap) {
  const rr = new Record();
  const rd = new NSECRecord();
  rr.name = util.fqdn(name);
  rr.type = types.NSEC;
  rr.ttl = DEFAULT_TTL;

  rd.nextDomain = util.fqdn(nextDomain);
  rd.typeBitmap = typeBitmap;
  rr.data = rd;

  return rr;
}

// Find the successor of a top level name
function nextName(tld) {
  tld = util.trimFQDN(tld.toLowerCase());

  // If the label is already 63 octets
  // increment last character by one
  if (tld.length === 63) {
    // Assuming no escaped octets are present
    let last = tld.charCodeAt(62);
    last = String.fromCharCode(last + 1);
    return tld.slice(0, -1) + last + '.';
  }

  return tld + '\\000.';
}

// Find the predecessor of a top level name
function prevName(tld) {
  tld = util.trimFQDN(tld.toLowerCase());
  assert(tld.length !== 0);

  // Decrement the last character by 1
  // assuming no escaped octets are present
  let last = tld.charCodeAt(tld.length - 1);
  last = String.fromCharCode(last - 1);
  tld = tld.slice(0, -1) + last;

  // See RFC4034 6.1 Canonical DNS Name Order
  // https://tools.ietf.org/html/rfc4034#section-6.1
  // Appending \255 prevents names that begin
  // with the decremented name from falling
  // in range i.e. if the name is `hello` a lexically
  // smaller name is `helln` append `\255`
  // to ensure that helln\255 > hellna
  // while keeping helln\255 < hello
  if (tld.length < 63) {
    tld += '\\255';
  }

  return util.fqdn(tld);
}

exports.create = create;
exports.prevName = prevName;
exports.nextName = nextName;
