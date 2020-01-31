/*!
 * lookup.js - dns lookup for hsd
 * Copyright (c) 2020, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const dns = require('bdns');
const constants = require('bns/lib/constants');
const Hints = require('bns/lib/hints');
const UnboundResolver = require('bns/lib/resolver/unbound');
const wire = require('bns/lib/wire');

/*
 * Resolver
 */

let resolver = null;

/*
 * Lookup
 */

async function lookup(host, family, timeout) {
  if (family == null)
    family = null;

  assert(family === null || family === 4 || family === 6);

  const stub = new dns.Resolver();

  stub.setServers([
    // Cloudflare
    '1.1.1.1',
    // Google
    '8.8.8.8',
    '8.8.4.4',
    // OpenDNS
    '208.67.222.222',
    '208.67.220.220',
    '208.67.222.220',
    '208.67.220.222'
  ]);

  const out = [];
  const types = [];

  if (family == null || family === 4)
    types.push('A');

  if (family == null || family === 6)
    types.push('AAAA');

  for (const type of types) {
    let addrs;

    try {
      addrs = await stub.resolve(host, type, timeout);
    } catch (e) {
      continue;
    }

    out.push(...addrs);
  }

  if (out.length === 0)
    throw new Error('No DNS results.');

  return out;
}

/*
 * Resolve
 */

async function resolve(name, family, timeout) {
  if (family == null)
    family = null;

  assert(typeof name === 'string');
  assert(family === null || family === 4 || family === 6);

  if (!resolver) {
    resolver = new UnboundResolver({
      tcp: false,
      edns: true,
      dnssec: false,
      hints: Hints.fromRoot()
    });

    resolver.on('error', () => {});
  }

  await resolver.open();

  try {
    return await _resolve(name, family);
  } finally {
    await resolver.close();
  }
}

async function _resolve(name, family) {
  const out = [];
  const types = [];

  if (family == null || family === 4)
    types.push(wire.types.A);

  if (family == null || family === 6)
    types.push(wire.types.AAAA);

  for (const type of types) {
    const res = await resolver.lookup(name, type);

    if (res.code !== wire.codes.NOERROR) {
      const typeName = constants.typeToString(type);
      const codeName = constants.codeToString(res.code);
      const err = new Error(`Query error: ${codeName} (${name} ${typeName}).`);

      err.name = name;
      err.type = type;
      err.code = res.code;

      throw err;
    }

    for (const rr of res.collect(name, type))
      out.push(rr.data.address);
  }

  if (out.length === 0)
    throw new Error('No DNS results.');

  return out;
}

/*
 * Expose
 */

exports.lookup = lookup;
exports.resolve = resolve;
