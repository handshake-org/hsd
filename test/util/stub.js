'use strict';

const assert = require('bsert');
const path = require('path');
const {StubResolver, wire} = require('bns');
const fs = require('bfile');
const {tmpdir} = require('os');

let CACHE = {};

/**
 * Proxy requests if they are not cached.
 */

class CachedStubResolver extends StubResolver {
  constructor(options) {
    super(options);

    this.enabled = true;
    this.cacheOnDisk = process.env['HSD_TEST_DNS_FILE_CACHE'] === 'true';
    this.cacheDir = path.join(tmpdir(), 'hsd-test');
    this.cacheFile = path.join(this.cacheDir, 'dns-cache.json');

    this.loadCacheSync();
  }

  loadCacheSync() {
    if (!this.cacheOnDisk)
      return;

    if (!fs.existsSync(this.cacheDir))
      fs.mkdirSync(this.cacheDir);

    if (fs.existsSync(this.cacheFile))
      CACHE = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
  }

  saveCacheSync() {
    if (!this.cacheOnDisk)
      return;

    const stringified = JSON.stringify(CACHE, null, 2);
    fs.writeFileSync(this.cacheFile, stringified, 'utf8');
  }

  setCache(qs, res) {
    if (!this.enabled)
      return;

    assert(qs instanceof wire.Question);
    assert(res instanceof wire.Message);

    CACHE[qs.toString()] = res.toString();
    this.saveCacheSync();
  }

  hasCache(qs) {
    if (!this.enabled)
      return false;

    assert(qs instanceof wire.Question);

    return Boolean(CACHE[qs.toString()]);
  }

  getCache(qs) {
    if (!this.enabled)
      return null;

    assert(qs instanceof wire.Question);

    return wire.Message.fromString(CACHE[qs.toString()]);
  }

  async resolve(qs) {
    if (this.hasCache(qs))
      return this.getCache(qs);

    const resolved = await super.resolve(qs);

    if (!resolved)
      return null;

    this.setCache(qs, resolved);
    return resolved;
  }
}

exports.CachedStubResolver = CachedStubResolver;

exports.STUB_SERVERS = ['1.1.1.1', '1.0.0.1'];
