'use strict';

const assert = require('bsert');
const {wire, util} = require('bns');
const {Record, NSECRecord, types} = wire;

// NS SOA RRSIG NSEC DNSKEY
// Types available for the root "."
const TYPE_MAP_ROOT = Buffer.from('000722000000000380', 'hex');

// RRSIG NSEC
const TYPE_MAP_EMPTY =  Buffer.from('0006000000000003', 'hex');

// NS RRSIG NSEC
const TYPE_MAP_NS = Buffer.from('0006200000000003', 'hex');

// TXT RRSIG NSEC
const TYPE_MAP_TXT = Buffer.from('0006000080000003', 'hex');

function create(name, nextDomain, typeBitmap) {
  const rr = new Record();
  const rd = new NSECRecord();
  rr.name = util.fqdn(name);
  rr.type = types.NSEC;
  rr.ttl = 86400;

  rd.nextDomain = util.fqdn(nextDomain);
  rd.typeBitmap = typeBitmap;
  rr.data = rd;

  return rr;
}

// find the successor of a top level name
function nextName(tld) {
  tld = util.trimFQDN(tld.toLowerCase());

  // if the label is already 63 octets
  // increment last character by one
  if(tld.length === 63) {
    // assuming no escaped octets are present
    const next = Buffer.from(tld, 'ascii');
    next[next.length-1]++;
    return next.toString() + '.';
  }

  return tld + '\\000.';
}

// find the predecessor of a top level name
function prevName(tld) {
  tld = util.trimFQDN(tld.toLowerCase());
  assert(tld.length !== 0);

  // decrement the last character by 1
  // assuming no escaped octets are present
  let prev = Buffer.from(tld, 'ascii');
  prev[prev.length-1]--;
  prev = prev.toString();

  // See RFC4034 6.1 Canonical DNS Name Order
  // https://tools.ietf.org/html/rfc4034#section-6.1
  // Appending \255 prevents names that begin
  // with the decremented name from falling
  // in range i.e if the name is `hello` a lexically
  // smaller name is `helln` append `\255`
  // to ensure that helln\255 > hellna
  // while keeping helln\255 < hello
  if (prev.length < 63) {
    prev += '\\255';
  }

  return util.fqdn(prev);
}

exports.TYPE_MAP_ROOT = TYPE_MAP_ROOT;
exports.TYPE_MAP_EMPTY = TYPE_MAP_EMPTY;
exports.TYPE_MAP_NS = TYPE_MAP_NS;
exports.TYPE_MAP_TXT = TYPE_MAP_TXT;
exports.create = create;
exports.prevName = prevName;
exports.nextName = nextName;
