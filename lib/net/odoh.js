/*!
 * odoh.js - experimental p2p transport for Oblivious DNS in hsd
 * Copyright (c) 2026, Handshake Developers (MIT License).
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const bio = require('bufio');
const IP = require('binet');
const Logger = require('blgr');
const bns = require('bns');
const blake2b = require('bcrypto/lib/blake2b');
const hkdf = require('bcrypto/lib/hkdf');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const sha256 = require('bcrypto/lib/sha256');
const {
  Aes128Gcm,
  CipherSuite,
  HkdfSha256
} = require('@hpke/core');
const {DhkemX25519HkdfSha256} = require('@hpke/dhkem-x25519');
const common = require('./common');
const packets = require('./packets');

const {Message, opcodes: dnsOpcodes} = bns.wire;

const opcodes = common.odohOpcodes;
const roles = common.odohRoles;
const status = common.odohStatus;
const EMPTY = Buffer.alloc(0);
const CONFIG_TAG = Buffer.from('HNS-P2P-ODOH-CONFIG-V1\0', 'ascii');
const QUERY_INFO = Buffer.from('odoh query', 'ascii');
const RESPONSE_INFO = Buffer.from('odoh response', 'ascii');
const KEY_ID_INFO = Buffer.from('odoh key id', 'ascii');
const RESPONSE_KEY_INFO = Buffer.from('odoh key', 'ascii');
const RESPONSE_NONCE_INFO = Buffer.from('odoh nonce', 'ascii');
const SUPPORTED_VERSION = 0x0001;
const KEM_X25519_SHA256 = 0x0020;
const KDF_HKDF_SHA256 = 0x0001;
const AEAD_AES_128_GCM = 0x0001;
const HPKE_ENC_SIZE = 32;
const HASH_SIZE = 32;
const AEAD_KEY_SIZE = 16;
const AEAD_NONCE_SIZE = 12;
const RESPONSE_NONCE_SIZE = 16;
const DIRECT_BRONTIDE = 1;
const HOST_IPV4 = 4;
const HOST_IPV6 = 6;

function toArrayBuffer(data) {
  assert(Buffer.isBuffer(data));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function fromArrayBuffer(data) {
  return Buffer.from(new Uint8Array(data));
}

function isZero(data) {
  for (const ch of data) {
    if (ch !== 0)
      return false;
  }
  return true;
}

function allZero(data) {
  return isZero(data);
}

function idKey(id) {
  return id.toString('hex');
}

function requestID() {
  let id;

  do {
    id = random.randomBytes(common.odoh.REQUEST_ID_SIZE);
  } while (isZero(id));

  return id;
}

/**
 * Validate that a decrypted DNS response belongs to the encrypted query.
 *
 * This is deliberately limited to transport-level structure and correlation.
 * HNS state, DNSSEC, TLSA and DANE validation remain requester concerns.
 *
 * @param {Buffer} queryRaw
 * @param {Buffer} responseRaw
 * @returns {Boolean}
 */

function validateDNSResponse(queryRaw, responseRaw) {
  assert(Buffer.isBuffer(queryRaw));
  assert(Buffer.isBuffer(responseRaw));

  if (responseRaw.length === 0
      || responseRaw.length > common.dnsRelay.MAX_RESPONSE_SIZE) {
    throw new Error('ODoH DNS response exceeds size limits.');
  }

  let query;
  let response;

  try {
    query = Message.decode(queryRaw);
    response = Message.decode(responseRaw);
  } catch (e) {
    throw new Error('Malformed ODoH DNS query or response.');
  }

  if (query.malformed
      || response.malformed
      || query.trailing.length !== 0
      || response.trailing.length !== 0) {
    throw new Error('Malformed ODoH DNS query or response.');
  }

  if (query.qr
      || query.opcode !== dnsOpcodes.QUERY
      || query.question.length !== 1) {
    throw new Error('Invalid ODoH DNS query correlation input.');
  }

  if (!response.qr
      || response.opcode !== dnsOpcodes.QUERY
      || response.question.length !== 1
      || !response.rd
      || !response.ra) {
    throw new Error('Invalid ODoH DNS response flags.');
  }

  if (response.id !== query.id)
    throw new Error('ODoH DNS response identifier mismatch.');

  if (!response.question[0].equals(query.question[0]))
    throw new Error('ODoH DNS response question mismatch.');

  return true;
}

function writeTLSVector(data) {
  assert(Buffer.isBuffer(data));
  assert(data.length <= 0xffff);

  const out = Buffer.allocUnsafe(2 + data.length);
  out.writeUInt16BE(data.length, 0);
  data.copy(out, 2);

  return out;
}

function readTLSVector(br, allowEmpty) {
  if (br.left() < 2)
    throw new Error('Truncated TLS vector length.');

  const size = br.readU16BE();

  if (!allowEmpty && size === 0)
    throw new Error('Empty TLS vector.');

  if (br.left() < size)
    throw new Error('Truncated TLS vector.');

  return br.readBytes(size);
}

function encodePlaintext(dns, blockSize) {
  assert(Buffer.isBuffer(dns));
  assert(dns.length > 0 && dns.length <= 0xffff);
  assert((blockSize >>> 0) === blockSize && blockSize > 0);

  const paddingSize = (blockSize - (dns.length % blockSize)) % blockSize;
  const bw = bio.write(4 + dns.length + paddingSize);

  bw.writeU16BE(dns.length);
  bw.writeBytes(dns);
  bw.writeU16BE(paddingSize);
  bw.writeBytes(Buffer.alloc(paddingSize));

  return bw.render();
}

function decodePlaintext(raw) {
  assert(Buffer.isBuffer(raw));
  const br = bio.read(raw);
  const dns = readTLSVector(br, false);
  const padding = readTLSVector(br, true);

  if (br.left() !== 0)
    throw new Error('Trailing ODoH plaintext bytes.');

  if (!allZero(padding))
    throw new Error('ODoH plaintext padding is nonzero.');

  return {dns, padding};
}

function encodeMessage(type, keyID, encrypted) {
  assert(type === 1 || type === 2);
  assert(Buffer.isBuffer(keyID));
  assert(Buffer.isBuffer(encrypted));
  assert(encrypted.length > 0 && encrypted.length <= 0xffff);

  return Buffer.concat([
    Buffer.from([type]),
    writeTLSVector(keyID),
    writeTLSVector(encrypted)
  ]);
}

function decodeMessage(raw, expectedType) {
  assert(Buffer.isBuffer(raw));
  const br = bio.read(raw);

  if (br.left() < 1)
    throw new Error('Truncated ODoH message.');

  const type = br.readU8();

  if (type !== expectedType)
    throw new Error('Unexpected ODoH message type.');

  const keyID = readTLSVector(br, true);
  const encrypted = readTLSVector(br, false);

  if (br.left() !== 0)
    throw new Error('Trailing ODoH message bytes.');

  return {type, keyID, encrypted};
}

function messageAAD(type, keyID) {
  const out = Buffer.allocUnsafe(3 + keyID.length);
  out[0] = type;
  out.writeUInt16BE(keyID.length, 1);
  keyID.copy(out, 3);
  return out;
}

function encodeConfigContents(publicKey) {
  assert(Buffer.isBuffer(publicKey));
  assert(publicKey.length === 32);

  const bw = bio.write(8 + publicKey.length);
  bw.writeU16BE(KEM_X25519_SHA256);
  bw.writeU16BE(KDF_HKDF_SHA256);
  bw.writeU16BE(AEAD_AES_128_GCM);
  bw.writeU16BE(publicKey.length);
  bw.writeBytes(publicKey);
  return bw.render();
}

function decodeConfigContents(raw) {
  const br = bio.read(raw);

  if (br.left() < 8)
    throw new Error('Truncated ODoH config contents.');

  const kemID = br.readU16BE();
  const kdfID = br.readU16BE();
  const aeadID = br.readU16BE();
  const publicKey = readTLSVector(br, false);

  if (br.left() !== 0)
    throw new Error('Trailing ODoH config contents.');

  if (kemID !== KEM_X25519_SHA256
      || kdfID !== KDF_HKDF_SHA256
      || aeadID !== AEAD_AES_128_GCM
      || publicKey.length !== 32) {
    throw new Error('Unsupported ODoH cipher suite.');
  }

  return {kemID, kdfID, aeadID, publicKey, raw};
}

function encodeConfigs(publicKeys) {
  if (Buffer.isBuffer(publicKeys))
    publicKeys = [publicKeys];

  assert(Array.isArray(publicKeys));
  assert(publicKeys.length > 0);

  const configs = [];

  for (const publicKey of publicKeys) {
    const contents = encodeConfigContents(publicKey);
    const config = Buffer.allocUnsafe(4 + contents.length);
    config.writeUInt16BE(SUPPORTED_VERSION, 0);
    config.writeUInt16BE(contents.length, 2);
    contents.copy(config, 4);
    configs.push(config);
  }

  return writeTLSVector(Buffer.concat(configs));
}

function decodeConfigList(raw) {
  assert(Buffer.isBuffer(raw));
  const outer = bio.read(raw);
  const list = readTLSVector(outer, false);

  if (outer.left() !== 0)
    throw new Error('Trailing ObliviousDoHConfigs bytes.');

  const br = bio.read(list);
  const supported = [];

  while (br.left() > 0) {
    if (br.left() < 4)
      throw new Error('Truncated ObliviousDoHConfig.');

    const version = br.readU16BE();
    const contentsRaw = readTLSVector(br, false);

    if (version !== SUPPORTED_VERSION)
      continue;

    supported.push(decodeConfigContents(contentsRaw));
  }

  if (supported.length === 0)
    throw new Error('No supported ODoH configuration.');

  return supported;
}

function decodeConfigs(raw) {
  return decodeConfigList(raw)[0];
}

function deriveKeyID(contents) {
  const prk = hkdf.extract(sha256, contents, EMPTY);
  return hkdf.expand(sha256, prk, KEY_ID_INFO, HASH_SIZE);
}

function deriveResponseSecrets(secret, queryPlaintext, nonce) {
  assert(secret.length === AEAD_KEY_SIZE);
  assert(nonce.length === RESPONSE_NONCE_SIZE);

  const nonceLength = Buffer.allocUnsafe(2);
  nonceLength.writeUInt16BE(nonce.length, 0);
  const salt = Buffer.concat([queryPlaintext, nonceLength, nonce]);
  const prk = hkdf.extract(sha256, secret, salt);

  return {
    key: hkdf.expand(sha256, prk, RESPONSE_KEY_INFO, AEAD_KEY_SIZE),
    nonce: hkdf.expand(sha256, prk, RESPONSE_NONCE_INFO, AEAD_NONCE_SIZE)
  };
}

function createSuite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm()
  });
}

class ODoHCrypto {
  constructor() {
    this.suite = createSuite();
    this.aead = new Aes128Gcm();
  }

  async generateKeyPair() {
    const pair = await this.suite.kem.generateKeyPair();
    return {
      publicKey: fromArrayBuffer(
        await this.suite.kem.serializePublicKey(pair.publicKey)),
      privateKey: fromArrayBuffer(
        await this.suite.kem.serializePrivateKey(pair.privateKey))
    };
  }

  async encryptQuery(config, dns) {
    const plaintext = encodePlaintext(dns, 128);
    const contents = encodeConfigContents(config.publicKey);
    const keyID = deriveKeyID(contents);
    const publicKey = await this.suite.kem.deserializePublicKey(
      toArrayBuffer(config.publicKey));
    const context = await this.suite.createSenderContext({
      recipientPublicKey: publicKey,
      info: toArrayBuffer(QUERY_INFO)
    });
    const aad = messageAAD(1, keyID);
    const ciphertext = fromArrayBuffer(await context.seal(
      toArrayBuffer(plaintext),
      toArrayBuffer(aad)));
    const encrypted = Buffer.concat([fromArrayBuffer(context.enc), ciphertext]);

    return {
      message: encodeMessage(1, keyID, encrypted),
      context,
      plaintext
    };
  }

  async decryptQuery(privateKey, message, expectedPublicKey) {
    const parsed = decodeMessage(message, 1);

    if (expectedPublicKey) {
      const expectedKeyID = deriveKeyID(
        encodeConfigContents(expectedPublicKey));

      if (!parsed.keyID.equals(expectedKeyID))
        throw new Error('Unknown ODoH key identifier.');
    }

    if (parsed.encrypted.length <= HPKE_ENC_SIZE)
      throw new Error('Truncated HPKE query ciphertext.');

    const configPublic = await this.suite.kem.deserializePrivateKey(
      toArrayBuffer(privateKey));
    const enc = parsed.encrypted.slice(0, HPKE_ENC_SIZE);
    const ciphertext = parsed.encrypted.slice(HPKE_ENC_SIZE);
    const context = await this.suite.createRecipientContext({
      recipientKey: configPublic,
      enc: toArrayBuffer(enc),
      info: toArrayBuffer(QUERY_INFO)
    });
    const aad = messageAAD(1, parsed.keyID);
    const plaintext = fromArrayBuffer(await context.open(
      toArrayBuffer(ciphertext),
      toArrayBuffer(aad)));

    return {
      context,
      plaintext,
      keyID: parsed.keyID,
      dns: decodePlaintext(plaintext).dns
    };
  }

  async encryptResponse(context, queryPlaintext, dns) {
    const plaintext = encodePlaintext(dns, 468);
    const responseNonce = random.randomBytes(RESPONSE_NONCE_SIZE);
    const secret = fromArrayBuffer(await context.export(
      toArrayBuffer(RESPONSE_INFO),
      AEAD_KEY_SIZE));
    const derived = deriveResponseSecrets(
      secret, queryPlaintext, responseNonce);
    const aad = messageAAD(2, responseNonce);
    const aead = this.aead.createEncryptionContext(toArrayBuffer(derived.key));
    const encrypted = fromArrayBuffer(await aead.seal(
      toArrayBuffer(derived.nonce),
      toArrayBuffer(plaintext),
      toArrayBuffer(aad)));

    return encodeMessage(2, responseNonce, encrypted);
  }

  async decryptResponse(query, message) {
    const parsed = decodeMessage(message, 2);

    if (parsed.keyID.length !== RESPONSE_NONCE_SIZE)
      throw new Error('Invalid ODoH response nonce length.');

    const secret = fromArrayBuffer(await query.context.export(
      toArrayBuffer(RESPONSE_INFO),
      AEAD_KEY_SIZE));
    const derived = deriveResponseSecrets(
      secret, query.plaintext, parsed.keyID);
    const aad = messageAAD(2, parsed.keyID);
    const aead = this.aead.createEncryptionContext(toArrayBuffer(derived.key));
    const plaintext = fromArrayBuffer(await aead.open(
      toArrayBuffer(derived.nonce),
      toArrayBuffer(parsed.encrypted),
      toArrayBuffer(aad)));

    return decodePlaintext(plaintext).dns;
  }
}

function validateLocator(locator, allowPrivate) {
  assert(locator && typeof locator === 'object');

  if (locator.type !== DIRECT_BRONTIDE)
    throw new Error('Only direct Brontide target locators are supported.');

  if (!Buffer.isBuffer(locator.targetKey)
      || locator.targetKey.length !== 33
      || !secp256k1.publicKeyVerify(locator.targetKey)) {
    throw new Error('Invalid ODoH target peer key.');
  }

  if (!Buffer.isBuffer(locator.host) || locator.host.length !== 16)
    throw new Error('Invalid ODoH target address.');

  if (!IP.isValid(locator.host))
    throw new Error('Invalid ODoH target address.');

  if (!allowPrivate && !IP.isRoutable(locator.host))
    throw new Error('ODoH target address is not publicly routable.');

  if ((locator.port & 0xffff) !== locator.port || locator.port === 0)
    throw new Error('Invalid ODoH target port.');

  return locator;
}

function createLocator(host, port, targetKey, allowPrivate) {
  const locator = {
    type: DIRECT_BRONTIDE,
    targetKey: Buffer.from(targetKey),
    host: IP.toBuffer(host),
    port
  };

  return validateLocator(locator, allowPrivate);
}

function encodeLocator(locator) {
  validateLocator(locator, true);
  const bw = bio.write(55);
  bw.writeU8(locator.type);
  bw.writeBytes(locator.targetKey);
  bw.writeU16(19);
  bw.writeU8(IP.isIPv4(locator.host) ? HOST_IPV4 : HOST_IPV6);
  bw.writeBytes(locator.host);
  bw.writeU16(locator.port);
  return bw.render();
}

function readLocator(br, allowPrivate) {
  if (br.left() < 36)
    throw new Error('Truncated ODoH target locator.');

  const type = br.readU8();
  const targetKey = br.readBytes(33);
  const bodyLength = br.readU16();

  if (type !== DIRECT_BRONTIDE || bodyLength !== 19 || br.left() < bodyLength)
    throw new Error('Unsupported ODoH target locator.');

  const hostType = br.readU8();
  const host = br.readBytes(16);
  const port = br.readU16();

  if (hostType !== HOST_IPV4 && hostType !== HOST_IPV6)
    throw new Error('Invalid ODoH target host type.');

  if ((hostType === HOST_IPV4) !== IP.isIPv4(host))
    throw new Error('ODoH target host encoding mismatch.');

  return validateLocator({type, targetKey, host, port}, allowPrivate);
}

function decodeLocator(raw, allowPrivate) {
  const br = bio.read(raw);
  const locator = readLocator(br, allowPrivate);

  if (br.left() !== 0)
    throw new Error('Trailing ODoH target locator bytes.');

  return locator;
}

function locatorEquals(a, b) {
  return encodeLocator(a).equals(encodeLocator(b));
}

function encodeUnsignedRecord(record) {
  const locator = encodeLocator(record.locator);
  const size = 1 + 4 + locator.length + 8 + 8 + 8
    + 2 + record.odohConfigs.length;
  const bw = bio.write(size);
  bw.writeU8(1);
  bw.writeU32(record.networkMagic);
  bw.writeBytes(locator);
  bw.writeU64(record.sequence);
  bw.writeU64(record.issuedAt);
  bw.writeU64(record.expiresAt);
  bw.writeU16(record.odohConfigs.length);
  bw.writeBytes(record.odohConfigs);
  return bw.render();
}

class TargetConfigRecord {
  constructor(options) {
    assert(options && typeof options === 'object');
    this.version = 1;
    this.networkMagic = options.networkMagic;
    this.locator = options.locator;
    this.sequence = options.sequence;
    this.issuedAt = options.issuedAt;
    this.expiresAt = options.expiresAt;
    this.odohConfigs = options.odohConfigs;
    this.signature = options.signature || EMPTY;
    this.raw = null;
    this.id = null;
  }

  unsigned() {
    return encodeUnsignedRecord(this);
  }

  digest() {
    return blake2b.digest(Buffer.concat([CONFIG_TAG, this.unsigned()]), 32);
  }

  sign(privateKey) {
    this.signature = secp256k1.signDER(this.digest(), privateKey);
    this.raw = this.encode();
    this.id = blake2b.digest(this.raw, 32);
    return this;
  }

  encode() {
    if (this.signature.length < 8 || this.signature.length > 72)
      throw new Error('Invalid target configuration signature length.');

    return Buffer.concat([
      this.unsigned(),
      Buffer.from([this.signature.length]),
      this.signature
    ]);
  }

  verify(options) {
    const now = options.now != null
      ? options.now
      : Math.floor(Date.now() / 1000);

    validateLocator(this.locator, options.allowPrivate);

    if (this.networkMagic !== options.networkMagic)
      throw new Error('Wrong target configuration network.');

    if (this.sequence < 1)
      throw new Error('Invalid target configuration sequence.');

    if (this.issuedAt > now + 300)
      throw new Error('Target configuration is from the future.');

    if (this.expiresAt <= this.issuedAt || this.expiresAt <= now)
      throw new Error('Target configuration is expired.');

    if (this.expiresAt - this.issuedAt > common.odoh.MAX_CONFIG_LIFETIME)
      throw new Error('Target configuration lifetime is too long.');

    if (this.odohConfigs.length < 1
        || this.odohConfigs.length > common.odoh.MAX_CONFIG_SIZE) {
      throw new Error('Invalid target ODoH configuration size.');
    }

    decodeConfigList(this.odohConfigs);

    if (!secp256k1.isLowDER(this.signature))
      throw new Error(
        'Target configuration signature is not strict low-S DER.');

    if (!secp256k1.verifyDER(
      this.digest(), this.signature, this.locator.targetKey)) {
      throw new Error('Invalid target configuration signature.');
    }

    const canonical = this.encode();

    if (this.raw && !canonical.equals(this.raw))
      throw new Error('Non-canonical target configuration record.');

    this.raw = canonical;
    this.id = blake2b.digest(canonical, 32);
    return true;
  }

  static decode(raw, allowPrivate) {
    assert(Buffer.isBuffer(raw));

    if (raw.length > common.odoh.MAX_CONFIG_SIZE)
      throw new Error('Target configuration exceeds size limit.');

    const br = bio.read(raw);

    if (br.left() < 5 || br.readU8() !== 1)
      throw new Error('Unsupported target configuration version.');

    const networkMagic = br.readU32();
    const locator = readLocator(br, allowPrivate);

    if (br.left() < 8 + 8 + 8 + 2 + 1)
      throw new Error('Truncated target configuration.');

    const sequence = br.readU64();
    const issuedAt = br.readU64();
    const expiresAt = br.readU64();
    const configsLength = br.readU16();

    if (configsLength < 1
        || configsLength > common.odoh.MAX_CONFIG_SIZE
        || br.left() < configsLength + 1) {
      throw new Error('Invalid target ODoH configuration length.');
    }

    const odohConfigs = br.readBytes(configsLength);
    const signatureLength = br.readU8();

    if (signatureLength < 8
        || signatureLength > 72
        || br.left() !== signatureLength) {
      throw new Error('Invalid target configuration signature length.');
    }

    const signature = br.readBytes(signatureLength);
    const record = new TargetConfigRecord({
      networkMagic,
      locator,
      sequence,
      issuedAt,
      expiresAt,
      odohConfigs,
      signature
    });

    record.raw = Buffer.from(raw);
    record.id = blake2b.digest(raw, 32);
    return record;
  }
}

function encodeCaps(roleBits) {
  const bw = bio.write(15);
  bw.writeU8(roleBits);
  bw.writeU16(common.odoh.MAX_QUERY_SIZE);
  bw.writeU32(common.odoh.MAX_RESPONSE_SIZE);
  bw.writeU16(common.odoh.MAX_LIVE_PER_CONNECTION);
  bw.writeU16(common.odoh.MAX_CONFIG_SIZE);
  bw.writeU16(512);
  bw.writeU16(1024);
  return bw.render();
}

function decodeCaps(raw) {
  if (raw.length !== 15)
    throw new Error('Invalid P2P ODoH capabilities length.');

  const br = bio.read(raw);
  const result = {
    roles: br.readU8(),
    maxClientQuery: br.readU16(),
    maxTargetResponse: br.readU32(),
    maxLivePerConnection: br.readU16(),
    maxConfigSize: br.readU16(),
    preferredQueryBucket: br.readU16(),
    preferredResponseBucket: br.readU16()
  };

  if ((result.roles & ~(roles.PROXY | roles.TARGET | roles.CONFIG_CACHE)) !== 0
      || result.roles === 0) {
    throw new Error('Invalid P2P ODoH capability roles.');
  }

  if (result.maxClientQuery < 256
      || result.maxClientQuery > common.odoh.MAX_QUERY_SIZE
      || result.maxTargetResponse < 512
      || result.maxTargetResponse > common.odoh.MAX_RESPONSE_SIZE
      || result.maxLivePerConnection < 1
      || result.maxLivePerConnection > 256
      || result.maxConfigSize < 128
      || result.maxConfigSize > common.odoh.MAX_CONFIG_SIZE) {
    throw new Error('Invalid P2P ODoH capability limit.');
  }

  for (const bucket of [
    result.preferredQueryBucket,
    result.preferredResponseBucket
  ]) {
    if (bucket === 0)
      continue;
    if (bucket < 128 || bucket > 4096 || (bucket & (bucket - 1)) !== 0)
      throw new Error('Invalid P2P ODoH padding bucket.');
  }

  return result;
}

function encodeGetConfig(locator, allowCached) {
  return Buffer.concat([
    encodeLocator(locator),
    Buffer.from([allowCached ? 1 : 0])
  ]);
}

function decodeGetConfig(raw, allowPrivate) {
  const br = bio.read(raw);
  const locator = readLocator(br, allowPrivate);

  if (br.left() !== 1)
    throw new Error('Invalid GETCONFIG body.');

  const allowCached = br.readU8();

  if (allowCached > 1)
    throw new Error('Invalid GETCONFIG cache flag.');

  return {locator, allowCached: allowCached === 1};
}

function encodeConfig(record) {
  const raw = record.raw || record.encode();

  if (raw.length > common.odoh.MAX_CONFIG_SIZE)
    throw new Error('Target configuration exceeds size limit.');

  const bw = bio.write(2 + raw.length);
  bw.writeU16(raw.length);
  bw.writeBytes(raw);
  return bw.render();
}

function decodeConfig(raw, allowPrivate) {
  const br = bio.read(raw);

  if (br.left() < 2)
    throw new Error('Truncated CONFIG body.');

  const size = br.readU16();

  if (size < 1 || size > common.odoh.MAX_CONFIG_SIZE || br.left() !== size)
    throw new Error('Invalid CONFIG record length.');

  return TargetConfigRecord.decode(br.readBytes(size), allowPrivate);
}

function writeOuterPadding(bw, padding) {
  assert(Buffer.isBuffer(padding));
  assert(padding.length <= 4096);
  assert(allZero(padding));
  bw.writeU16(padding.length);
  bw.writeBytes(padding);
}

function readOuterPadding(br) {
  if (br.left() < 2)
    throw new Error('Truncated outer-padding length.');

  const size = br.readU16();

  if (size > 4096 || br.left() !== size)
    throw new Error('Invalid outer-padding length.');

  const padding = br.readBytes(size);

  if (!allZero(padding))
    throw new Error('Outer padding is nonzero.');

  return padding;
}

function encodeClientQuery(locator, configID, message, padding = EMPTY) {
  assert(Buffer.isBuffer(configID) && configID.length === 32);
  assert(Buffer.isBuffer(message));
  assert(message.length > 0 && message.length <= common.odoh.MAX_QUERY_SIZE);
  const locatorRaw = encodeLocator(locator);
  const bw = bio.write(
    locatorRaw.length + 32 + 2 + message.length + 2 + padding.length);
  bw.writeBytes(locatorRaw);
  bw.writeBytes(configID);
  bw.writeU16(message.length);
  bw.writeBytes(message);
  writeOuterPadding(bw, padding);
  return bw.render();
}

function decodeClientQuery(raw, allowPrivate) {
  const br = bio.read(raw);
  const locator = readLocator(br, allowPrivate);

  if (br.left() < 32 + 2)
    throw new Error('Truncated CLIENT_QUERY body.');

  const configID = br.readBytes(32);
  const size = br.readU16();

  if (size < 1 || size > common.odoh.MAX_QUERY_SIZE || br.left() < size + 2)
    throw new Error('Invalid CLIENT_QUERY message length.');

  const message = br.readBytes(size);
  decodeMessage(message, 1);
  const padding = readOuterPadding(br);
  return {locator, configID, message, padding};
}

function encodeTargetQuery(configID, message, padding = EMPTY) {
  assert(Buffer.isBuffer(configID) && configID.length === 32);
  assert(Buffer.isBuffer(message));
  const bw = bio.write(32 + 2 + message.length + 2 + padding.length);
  bw.writeBytes(configID);
  bw.writeU16(message.length);
  bw.writeBytes(message);
  writeOuterPadding(bw, padding);
  return bw.render();
}

function decodeTargetQuery(raw) {
  const br = bio.read(raw);

  if (br.left() < 32 + 2)
    throw new Error('Truncated TARGET_QUERY body.');

  const configID = br.readBytes(32);
  const size = br.readU16();

  if (size < 1 || size > common.odoh.MAX_QUERY_SIZE || br.left() < size + 2)
    throw new Error('Invalid TARGET_QUERY message length.');

  const message = br.readBytes(size);
  decodeMessage(message, 1);
  const padding = readOuterPadding(br);
  return {configID, message, padding};
}

function encodeResponse(message, padding = EMPTY) {
  assert(Buffer.isBuffer(message));
  assert(message.length > 0 && message.length <= common.odoh.MAX_RESPONSE_SIZE);
  const bw = bio.write(4 + message.length + 2 + padding.length);
  bw.writeU32(message.length);
  bw.writeBytes(message);
  writeOuterPadding(bw, padding);
  return bw.render();
}

function decodeResponse(raw) {
  const br = bio.read(raw);

  if (br.left() < 4)
    throw new Error('Truncated ODoH response body.');

  const size = br.readU32();

  if (size < 1 || size > common.odoh.MAX_RESPONSE_SIZE || br.left() < size + 2)
    throw new Error('Invalid ODoH response length.');

  const message = br.readBytes(size);
  decodeMessage(message, 2);
  const padding = readOuterPadding(br);
  return {message, padding};
}

function encodeError(code, retryAfter = 0, errorClass = 0) {
  assert((code & 0xff) === code && code <= status.INTERNAL_ERROR);
  const bw = bio.write(7);
  bw.writeU8(code);
  bw.writeU32(retryAfter);
  bw.writeU16(errorClass);
  return bw.render();
}

function decodeError(raw) {
  if (raw.length !== 7)
    throw new Error('Invalid P2P ODoH error body.');

  const br = bio.read(raw);
  const result = {
    status: br.readU8(),
    retryAfter: br.readU32(),
    errorClass: br.readU16()
  };

  if (result.status > status.INTERNAL_ERROR)
    throw new Error('Unknown P2P ODoH error status.');

  return result;
}

class BaseRelayCapture {
  constructor(service, sourcePeer) {
    this.service = service;
    this.sourcePeer = sourcePeer;
    this.handshake = true;
    this.localServices = common.EXPERIMENTAL_DNS_RELAY_SERVICE;
    this.destroyed = false;
    this.pending = new Map();
  }

  send(packet) {
    if (!(packet instanceof packets.DNSRelayPacket))
      return;

    const item = this.pending.get(idKey(packet.requestID));

    if (!item)
      return;

    this.pending.delete(idKey(packet.requestID));

    if (packet.status === common.dnsRelayStatus.OK) {
      item.resolve(packet.response);
      return;
    }

    const err = new Error('Base DNS relay rejected the oblivious query.');
    err.status = packet.status;
    item.reject(err);
  }

  query(raw) {
    let id;
    let key;

    do {
      id = requestID();
      key = idKey(id);
    } while (this.pending.has(key));

    return new Promise((resolve, reject) => {
      const item = {resolve, reject};
      this.pending.set(key, item);
      const packet = new packets.GetDNSRelayPacket(id, raw);

      this.service.handle(this, packet).then((accepted) => {
        if (accepted || !this.pending.has(key))
          return;

        this.pending.delete(key);
        const err = new Error('Base DNS relay did not accept the query.');
        err.status = common.dnsRelayStatus.BUSY;
        reject(err);
      }, (err) => {
        if (!this.pending.delete(key))
          return;
        reject(err);
      });
    });
  }

  cancel() {
    this.destroyed = true;
    this.service.cancelPeer(this);

    for (const item of this.pending.values())
      item.reject(new Error('ODoH proxy peer disconnected.'));

    this.pending.clear();
  }
}

class ODoHService extends EventEmitter {
  constructor(options) {
    super();
    assert(options && typeof options === 'object');
    assert(options.pool && typeof options.pool === 'object');
    assert(options.network && typeof options.network === 'object');
    assert(Buffer.isBuffer(options.identityKey));

    this.pool = options.pool;
    this.network = options.network;
    this.identityKey = options.identityKey;
    this.publicKey = secp256k1.publicKeyCreate(this.identityKey);
    this.dnsRelay = options.dnsRelay || null;
    this.logger = options.logger
      ? options.logger.context('odoh')
      : Logger.global.context('odoh');
    this.proxyEnabled = Boolean(options.proxy);
    this.targetEnabled = Boolean(options.target);
    this.allowPrivate = Boolean(options.allowPrivate);
    this.instrumentation = Boolean(options.instrumentation);
    this.targetHost = options.targetHost || null;
    this.targetPort = options.targetPort || this.network.brontidePort;
    this.timeout = options.timeout || common.odoh.DEFAULT_TIMEOUT;
    this.maxLive = options.maxLive || common.odoh.MAX_LIVE_GLOBAL;
    this.rotationInterval = options.rotationInterval != null
      ? options.rotationInterval
      : common.odoh.DEFAULT_KEY_ROTATION;
    this.keyOverlap = options.keyOverlap != null
      ? options.keyOverlap
      : common.odoh.DEFAULT_KEY_OVERLAP;
    this.opened = false;
    this.crypto = new ODoHCrypto();
    this.keyPair = null;
    this.targetConfig = null;
    this.targetSequence = 0;
    this.nextRotation = 0;
    this.targetKeys = new Map();
    this.targetRecords = new Map();
    this.pending = new Map();
    this.clientMappings = new Map();
    this.targetMappings = new Map();
    this.baseCaptures = new Map();
    this.caps = new Map();
    this.replays = new Map();
    this.metrics = {
      proxyConfigForwards: 0,
      proxyQueries: 0,
      proxyResponses: 0,
      proxyPlaintextBytes: 0,
      targetQueries: 0,
      targetResponses: 0,
      targetFailures: 0,
      replays: 0,
      rotations: 0
    };

    if (this.allowPrivate && this.network.type !== 'regtest')
      throw new Error('Private ODoH targets are permitted only on regtest.');

    if ((this.proxyEnabled || this.targetEnabled)
        && this.network.type !== 'regtest') {
      throw new Error('Experimental ODoH roles are regtest-only.');
    }

    if (this.instrumentation && this.network.type !== 'regtest')
      throw new Error('ODoH instrumentation is regtest-only.');

    if (!Number.isSafeInteger(this.rotationInterval)
        || !Number.isSafeInteger(this.keyOverlap)
        || this.rotationInterval < 60
        || this.keyOverlap < 60
        || this.rotationInterval + this.keyOverlap
          > common.odoh.MAX_CONFIG_LIFETIME) {
      throw new Error('Invalid ODoH key rotation or overlap interval.');
    }

    if (this.targetEnabled) {
      if (!this.dnsRelay)
        throw new Error('ODoH target requires the base DNS relay service.');
      if (!this.targetHost)
        throw new Error('ODoH target requires an explicit target host.');
      createLocator(
        this.targetHost,
        this.targetPort,
        this.publicKey,
        this.allowPrivate);
    }
  }

  async open() {
    assert(!this.opened);

    if (this.targetEnabled)
      await this.rotateTargetKey(Math.floor(Date.now() / 1000), true);

    this.opened = true;
  }

  async close() {
    assert(this.opened);
    this.opened = false;

    for (const peer of Array.from(this.pending.keys()))
      this.cancelPeer(peer);

    for (const peer of Array.from(this.clientMappings.keys()))
      this.cancelPeer(peer);

    for (const capture of this.baseCaptures.values())
      capture.cancel();

    this.baseCaptures.clear();

    for (const item of this.targetKeys.values())
      item.pair.privateKey.fill(0);

    this.keyPair = null;
    this.targetConfig = null;
    this.targetSequence = 0;
    this.nextRotation = 0;
    this.targetKeys.clear();
    this.targetRecords.clear();
    this.replays.clear();
  }

  pruneTargetKeys(now) {
    for (const [key, item] of this.targetKeys) {
      if (item.retireAt > now)
        continue;
      item.pair.privateKey.fill(0);
      this.targetKeys.delete(key);
    }

    for (const [key, item] of this.targetRecords) {
      if (item.record.expiresAt <= now)
        this.targetRecords.delete(key);
    }
  }

  async rotateTargetKey(now = Math.floor(Date.now() / 1000), force = false) {
    if (!this.targetEnabled)
      throw new Error('ODoH target role is disabled.');

    if (!force && this.targetConfig && now < this.nextRotation)
      return false;

    this.pruneTargetKeys(now);

    const pair = await this.crypto.generateKeyPair();
    const contents = encodeConfigContents(pair.publicKey);
    const keyID = deriveKeyID(contents);
    const retireAt = now + this.rotationInterval + this.keyOverlap;
    const existing = Array.from(this.targetKeys.values())
      .filter(item => item.retireAt > now)
      .sort((a, b) => b.sequence - a.sequence);
    const publicKeys = [pair.publicKey];

    for (const item of existing) {
      if (!publicKeys.some(key => key.equals(item.pair.publicKey)))
        publicKeys.push(item.pair.publicKey);
    }

    const locator = createLocator(
      this.targetHost,
      this.targetPort,
      this.publicKey,
      this.allowPrivate);
    const sequence = this.targetSequence + 1;
    const record = new TargetConfigRecord({
      networkMagic: this.network.magic,
      locator,
      sequence,
      issuedAt: now,
      expiresAt: retireAt,
      odohConfigs: encodeConfigs(publicKeys)
    }).sign(this.identityKey);
    const allowedKeys = new Set(
      decodeConfigList(record.odohConfigs)
        .map(config => deriveKeyID(encodeConfigContents(config.publicKey)))
        .map(id => id.toString('hex')));

    this.targetKeys.set(keyID.toString('hex'), {
      pair,
      sequence,
      retireAt
    });
    this.targetRecords.set(record.id.toString('hex'), {
      record,
      allowedKeys
    });
    this.keyPair = pair;
    this.targetConfig = record;
    this.targetSequence = sequence;
    this.nextRotation = now + this.rotationInterval;
    this.metrics.rotations += 1;
    return true;
  }

  async maybeRotateTargetKey() {
    if (!this.targetEnabled)
      return false;
    return this.rotateTargetKey(Math.floor(Date.now() / 1000), false);
  }

  roleBits() {
    let bits = 0;

    if (this.proxyEnabled && this.opened)
      bits |= roles.PROXY;

    if (this.isTargetReady())
      bits |= roles.TARGET;

    return bits;
  }

  isTargetReady() {
    return this.targetEnabled
      && this.opened
      && this.targetConfig != null
      && this.dnsRelay != null
      && this.dnsRelay.isReady();
  }

  isReady() {
    return this.roleBits() !== 0;
  }

  getMetrics() {
    return Object.assign({}, this.metrics, {
      pending: this.countEntries(this.pending),
      clientMappings: this.countEntries(this.clientMappings),
      targetMappings: this.countEntries(this.targetMappings),
      replayEntries: this.replays.size
    });
  }

  countEntries(map) {
    let total = 0;
    for (const items of map.values())
      total += items.size;
    return total;
  }

  peerMap(map, peer, create) {
    let items = map.get(peer);

    if (!items && create) {
      items = new Map();
      map.set(peer, items);
    }

    return items;
  }

  send(peer, opcode, id, body = EMPTY) {
    if (peer.destroyed)
      return false;
    peer.send(new packets.ODNSPacket(opcode, id, body));
    return true;
  }

  sendError(peer, id, code) {
    try {
      this.send(peer, opcodes.ERROR, id, encodeError(code));
    } catch (e) {
      this.logger.debug('Unable to send P2P ODoH error (%d).', code);
    }
  }

  async request(peer, opcode, body, expected) {
    if (!peer.handshake || peer.destroyed)
      throw new Error('P2P ODoH peer is not connected.');

    const items = this.peerMap(this.pending, peer, true);

    if (items.size >= common.odoh.MAX_LIVE_PER_CONNECTION
        || this.countEntries(this.pending) >= this.maxLive) {
      throw new Error('P2P ODoH requester limit reached.');
    }

    let id;
    let key;

    do {
      id = requestID();
      key = idKey(id);
    } while (items.has(key));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!items.delete(key))
          return;
        if (items.size === 0)
          this.pending.delete(peer);
        reject(new Error('P2P ODoH request timed out.'));
      }, this.timeout);

      items.set(key, {expected, resolve, reject, timer});

      try {
        if (!this.send(peer, opcode, id, body))
          throw new Error('P2P ODoH peer disconnected before send.');
      } catch (e) {
        clearTimeout(timer);
        items.delete(key);
        if (items.size === 0)
          this.pending.delete(peer);
        reject(e);
      }
    });
  }

  resolvePending(peer, packet) {
    const items = this.peerMap(this.pending, peer, false);

    if (!items)
      return false;

    const key = idKey(packet.requestID);
    const item = items.get(key);

    if (!item)
      return false;

    if (packet.opcode !== item.expected && packet.opcode !== opcodes.ERROR)
      return false;

    clearTimeout(item.timer);
    items.delete(key);
    if (items.size === 0)
      this.pending.delete(peer);

    if (packet.opcode === opcodes.ERROR) {
      try {
        const detail = decodeError(packet.body);
        const err = new Error(`P2P ODoH error status ${detail.status}.`);
        err.status = detail.status;
        item.reject(err);
      } catch (e) {
        item.reject(new Error('Malformed P2P ODoH error response.'));
      }
    } else {
      item.resolve(packet.body);
    }

    return true;
  }

  async getCapabilities(peer) {
    const cached = this.caps.get(peer);

    if (cached && Date.now() - cached.time < 300000)
      return cached.value;

    const raw = await this.request(peer, opcodes.GETCAPS, EMPTY, opcodes.CAPS);
    const value = decodeCaps(raw);

    if ((value.roles & roles.TARGET)
        && !(peer.services & common.EXPERIMENTAL_DNS_RELAY_SERVICE)) {
      throw new Error('ODoH target omitted the base DNS relay service bit.');
    }

    this.caps.set(peer, {time: Date.now(), value});
    return value;
  }

  async getConfig(peer, locator) {
    validateLocator(locator, this.allowPrivate);
    const caps = await this.getCapabilities(peer);

    if (!(caps.roles & roles.PROXY))
      throw new Error('Selected peer does not advertise the ODoH proxy role.');

    const raw = await this.request(
      peer,
      opcodes.GETCONFIG,
      encodeGetConfig(locator, true),
      opcodes.CONFIG);
    const record = decodeConfig(raw, this.allowPrivate);
    record.verify({
      networkMagic: this.network.magic,
      allowPrivate: this.allowPrivate
    });

    if (!locatorEquals(record.locator, locator))
      throw new Error('Proxy substituted the ODoH target locator.');

    return record;
  }

  async query(peer, locator, record, dns) {
    assert(record instanceof TargetConfigRecord);
    record.verify({
      networkMagic: this.network.magic,
      allowPrivate: this.allowPrivate
    });

    if (!locatorEquals(record.locator, locator))
      throw new Error('Target configuration locator mismatch.');

    const caps = await this.getCapabilities(peer);

    if (!(caps.roles & roles.PROXY))
      throw new Error('Selected peer does not advertise the ODoH proxy role.');

    const config = decodeConfigs(record.odohConfigs);
    const query = await this.crypto.encryptQuery(config, dns);
    const raw = await this.request(
      peer,
      opcodes.CLIENT_QUERY,
      encodeClientQuery(locator, record.id, query.message),
      opcodes.CLIENT_RESPONSE);
    const response = decodeResponse(raw);
    const decrypted = await this.crypto.decryptResponse(
      query, response.message);

    validateDNSResponse(dns, decrypted);

    return decrypted;
  }

  async handle(peer, packet) {
    assert(peer && typeof peer === 'object');
    assert(packet instanceof packets.ODNSPacket);

    if (this.resolvePending(peer, packet))
      return true;

    if (!peer.handshake
        || !(peer.localServices & common.EXPERIMENTAL_ODOH_SERVICE)) {
      return false;
    }

    try {
      switch (packet.opcode) {
        case opcodes.GETCAPS:
          return this.handleGetCaps(peer, packet);
        case opcodes.GETCONFIG:
          return await this.handleGetConfig(peer, packet);
        case opcodes.CONFIG:
          return this.handleProxyResponse(peer, packet, opcodes.CONFIG);
        case opcodes.CLIENT_QUERY:
          return await this.handleClientQuery(peer, packet);
        case opcodes.TARGET_QUERY:
          return await this.handleTargetQuery(peer, packet);
        case opcodes.TARGET_RESPONSE:
          return this.handleProxyResponse(
            peer, packet, opcodes.TARGET_RESPONSE);
        case opcodes.CLIENT_RESPONSE:
          return false;
        case opcodes.CANCEL:
          return this.handleCancel(peer, packet);
        case opcodes.ERROR:
          return this.handleProxyResponse(peer, packet, opcodes.ERROR);
        default:
          this.sendError(peer, packet.requestID, status.UNSUPPORTED);
          return false;
      }
    } catch (e) {
      this.logger.debug('P2P ODoH request failed: %s', e.message);
      this.sendError(peer, packet.requestID, status.INVALID_OUTER);
      return false;
    }
  }

  handleGetCaps(peer, packet) {
    if (packet.body.length !== 0) {
      this.sendError(peer, packet.requestID, status.INVALID_OUTER);
      return false;
    }

    const bits = this.roleBits();

    if (bits === 0) {
      this.sendError(peer, packet.requestID, status.UNSUPPORTED);
      return false;
    }

    this.send(peer, opcodes.CAPS, packet.requestID, encodeCaps(bits));
    return true;
  }

  async handleGetConfig(peer, packet) {
    const request = decodeGetConfig(packet.body, this.allowPrivate);

    await this.maybeRotateTargetKey();

    if (this.isTargetReady()
        && locatorEquals(request.locator, this.targetConfig.locator)) {
      this.send(
        peer,
        opcodes.CONFIG,
        packet.requestID,
        encodeConfig(this.targetConfig));
      return true;
    }

    if (!this.proxyEnabled) {
      this.sendError(peer, packet.requestID, status.UNSUPPORTED);
      return false;
    }

    return this.forwardToTarget(
      peer,
      packet.requestID,
      request.locator,
      opcodes.GETCONFIG,
      encodeGetConfig(request.locator, false),
      opcodes.CONFIG);
  }

  async handleClientQuery(peer, packet) {
    if (!this.proxyEnabled) {
      this.sendError(peer, packet.requestID, status.UNSUPPORTED);
      return false;
    }

    const query = decodeClientQuery(packet.body, this.allowPrivate);

    if (query.locator.targetKey.equals(this.publicKey)) {
      this.sendError(peer, packet.requestID, status.REFUSED);
      return false;
    }

    this.metrics.proxyQueries += 1;
    if (this.instrumentation) {
      this.emit('proxy query', {
        clientRequestID: Buffer.from(packet.requestID),
        ciphertext: Buffer.from(query.message),
        targetKey: Buffer.from(query.locator.targetKey)
      });
    }

    return this.forwardToTarget(
      peer,
      packet.requestID,
      query.locator,
      opcodes.TARGET_QUERY,
      encodeTargetQuery(query.configID, query.message),
      opcodes.TARGET_RESPONSE);
  }

  findTarget(locator) {
    const host = IP.toString(locator.host);

    for (let peer = this.pool.peers.head(); peer; peer = peer.next) {
      if (!peer.outbound || !peer.handshake || peer.destroyed)
        continue;
      if (!(peer.services & common.EXPERIMENTAL_ODOH_SERVICE))
        continue;
      if (!(peer.services & common.EXPERIMENTAL_DNS_RELAY_SERVICE))
        continue;
      if (!peer.address.key.equals(locator.targetKey))
        continue;
      if (peer.address.host !== host || peer.address.port !== locator.port)
        continue;
      return peer;
    }

    return null;
  }

  async forwardToTarget(
    clientPeer,
    clientID,
    locator,
    targetOpcode,
    targetBody,
    expectedOpcode) {
    validateLocator(locator, this.allowPrivate);

    if (locator.targetKey.equals(this.publicKey)) {
      this.sendError(clientPeer, clientID, status.REFUSED);
      return false;
    }

    const targetPeer = this.findTarget(locator);

    if (!targetPeer) {
      this.sendError(clientPeer, clientID, status.TARGET_UNREACHABLE);
      return false;
    }

    let caps;

    try {
      caps = await this.getCapabilities(targetPeer);
    } catch (e) {
      this.sendError(clientPeer, clientID, status.TARGET_UNREACHABLE);
      return false;
    }

    if (!(caps.roles & roles.TARGET)) {
      this.sendError(clientPeer, clientID, status.UNSUPPORTED);
      return false;
    }

    if (clientPeer.destroyed || targetPeer.destroyed)
      return false;

    const clients = this.peerMap(this.clientMappings, clientPeer, true);
    const targets = this.peerMap(this.targetMappings, targetPeer, true);
    const clientKey = idKey(clientID);

    if (clients.has(clientKey)
        || clients.size >= common.odoh.MAX_LIVE_PER_CONNECTION
        || targets.size >= caps.maxLivePerConnection
        || this.countEntries(this.clientMappings) >= this.maxLive) {
      this.sendError(clientPeer, clientID, status.BUSY);
      return false;
    }

    let targetID;
    let targetKey;

    do {
      targetID = requestID();
      targetKey = idKey(targetID);
    } while (targets.has(targetKey));

    const timer = setTimeout(() => {
      const item = targets.get(targetKey);
      if (!item)
        return;
      targets.delete(targetKey);
      clients.delete(clientKey);
      if (targets.size === 0)
        this.targetMappings.delete(targetPeer);
      if (clients.size === 0)
        this.clientMappings.delete(clientPeer);
      this.sendError(clientPeer, clientID, status.TARGET_TIMEOUT);
    }, this.timeout);
    const mapping = {
      clientPeer,
      clientID: Buffer.from(clientID),
      clientKey,
      targetPeer,
      targetID,
      targetKey,
      expectedOpcode,
      timer
    };
    clients.set(clientKey, mapping);
    targets.set(targetKey, mapping);

    if (targetOpcode === opcodes.GETCONFIG)
      this.metrics.proxyConfigForwards += 1;

    try {
      if (!this.send(targetPeer, targetOpcode, targetID, targetBody))
        throw new Error('ODoH target disconnected before send.');
    } catch (e) {
      clearTimeout(timer);
      clients.delete(clientKey);
      targets.delete(targetKey);
      if (clients.size === 0)
        this.clientMappings.delete(clientPeer);
      if (targets.size === 0)
        this.targetMappings.delete(targetPeer);
      this.sendError(clientPeer, clientID, status.TARGET_UNREACHABLE);
      return false;
    }

    return true;
  }

  handleProxyResponse(targetPeer, packet, opcode) {
    const targets = this.peerMap(this.targetMappings, targetPeer, false);

    if (!targets)
      return false;

    const targetKey = idKey(packet.requestID);
    const mapping = targets.get(targetKey);

    if (!mapping)
      return false;

    if (opcode !== opcodes.ERROR && opcode !== mapping.expectedOpcode)
      return false;

    clearTimeout(mapping.timer);
    targets.delete(targetKey);
    if (targets.size === 0)
      this.targetMappings.delete(targetPeer);
    const clients = this.peerMap(
      this.clientMappings, mapping.clientPeer, false);
    if (clients) {
      clients.delete(mapping.clientKey);
      if (clients.size === 0)
        this.clientMappings.delete(mapping.clientPeer);
    }

    if (opcode === opcodes.ERROR) {
      let code = status.TARGET_FAILURE;
      try {
        const detail = decodeError(packet.body);
        if (detail.status === status.BUSY
            || detail.status === status.RATE_LIMITED
            || detail.status === status.CONFIG_UNKNOWN
            || detail.status === status.CONFIG_EXPIRED
            || detail.status === status.RESPONSE_TOO_LARGE) {
          code = detail.status;
        }
      } catch (e) {
        code = status.TARGET_FAILURE;
      }
      this.sendError(mapping.clientPeer, mapping.clientID, code);
      return true;
    }

    const clientOpcode = opcode === opcodes.CONFIG
      ? opcodes.CONFIG
      : opcodes.CLIENT_RESPONSE;
    this.send(mapping.clientPeer, clientOpcode, mapping.clientID, packet.body);

    if (clientOpcode === opcodes.CLIENT_RESPONSE)
      this.metrics.proxyResponses += 1;

    return true;
  }

  pruneReplays(now) {
    for (const [key, time] of this.replays) {
      if (now - time <= common.odoh.REPLAY_WINDOW)
        break;
      this.replays.delete(key);
    }

    while (this.replays.size >= common.odoh.MAX_REPLAY_ENTRIES) {
      const first = this.replays.keys().next().value;
      this.replays.delete(first);
    }
  }

  checkReplay(configID, message) {
    const now = Date.now();
    this.pruneReplays(now);
    const digest = blake2b.digest(Buffer.concat([configID, message]), 32);
    const key = digest.toString('hex');

    if (this.replays.has(key)) {
      this.metrics.replays += 1;
      throw new Error('Replayed ODoH ciphertext.');
    }

    this.replays.set(key, now);
  }

  captureFor(peer) {
    let capture = this.baseCaptures.get(peer);

    if (!capture) {
      capture = new BaseRelayCapture(this.dnsRelay, peer);
      this.baseCaptures.set(peer, capture);
    }

    return capture;
  }

  async handleTargetQuery(peer, packet) {
    if (!this.isTargetReady()) {
      this.sendError(peer, packet.requestID, status.BUSY);
      return false;
    }

    let query;

    try {
      await this.maybeRotateTargetKey();
      query = decodeTargetQuery(packet.body);

      const recordItem = this.targetRecords.get(query.configID.toString('hex'));

      if (!recordItem) {
        this.sendError(peer, packet.requestID, status.CONFIG_UNKNOWN);
        return false;
      }

      this.checkReplay(query.configID, query.message);
      const parsed = decodeMessage(query.message, 1);
      const key = parsed.keyID.toString('hex');
      const keyItem = this.targetKeys.get(key);

      if (!keyItem || !recordItem.allowedKeys.has(key)) {
        this.sendError(peer, packet.requestID, status.CONFIG_UNKNOWN);
        return false;
      }

      const opened = await this.crypto.decryptQuery(
        keyItem.pair.privateKey,
        query.message,
        keyItem.pair.publicKey);
      this.metrics.targetQueries += 1;
      if (this.instrumentation) {
        this.emit('target query', {
          targetRequestID: Buffer.from(packet.requestID),
          dns: Buffer.from(opened.dns)
        });
      }
      const raw = await this.captureFor(peer).query(opened.dns);
      const response = await this.crypto.encryptResponse(
        opened.context,
        opened.plaintext,
        raw);

      if (response.length > common.odoh.MAX_RESPONSE_SIZE) {
        this.sendError(peer, packet.requestID, status.RESPONSE_TOO_LARGE);
        return false;
      }

      this.metrics.targetResponses += 1;
      this.send(
        peer,
        opcodes.TARGET_RESPONSE,
        packet.requestID,
        encodeResponse(response));
      return true;
    } catch (e) {
      this.metrics.targetFailures += 1;
      this.logger.debug('ODoH target failure: %s', e.message);
      this.sendError(peer, packet.requestID, status.TARGET_FAILURE);
      return false;
    }
  }

  handleCancel(peer, packet) {
    if (packet.body.length !== 1 || packet.body[0] > 3) {
      this.sendError(peer, packet.requestID, status.INVALID_OUTER);
      return false;
    }

    const clients = this.peerMap(this.clientMappings, peer, false);
    const key = idKey(packet.requestID);
    const mapping = clients ? clients.get(key) : null;

    if (!mapping)
      return false;

    clearTimeout(mapping.timer);
    clients.delete(key);
    if (clients.size === 0)
      this.clientMappings.delete(peer);
    const targets = this.peerMap(
      this.targetMappings, mapping.targetPeer, false);
    if (targets) {
      targets.delete(mapping.targetKey);
      if (targets.size === 0)
        this.targetMappings.delete(mapping.targetPeer);
    }
    this.send(
      mapping.targetPeer,
      opcodes.CANCEL,
      mapping.targetID,
      packet.body);
    return true;
  }

  cancelPeer(peer) {
    this.caps.delete(peer);

    const pending = this.peerMap(this.pending, peer, false);
    if (pending) {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('P2P ODoH peer disconnected.'));
      }
      this.pending.delete(peer);
    }

    const clients = this.peerMap(this.clientMappings, peer, false);
    if (clients) {
      for (const mapping of clients.values()) {
        clearTimeout(mapping.timer);
        const targets = this.peerMap(
          this.targetMappings, mapping.targetPeer, false);
        if (targets) {
          targets.delete(mapping.targetKey);
          if (targets.size === 0)
            this.targetMappings.delete(mapping.targetPeer);
        }
      }
      this.clientMappings.delete(peer);
    }

    const targets = this.peerMap(this.targetMappings, peer, false);
    if (targets) {
      for (const mapping of targets.values()) {
        clearTimeout(mapping.timer);
        const clientItems = this.peerMap(
          this.clientMappings, mapping.clientPeer, false);
        if (clientItems) {
          clientItems.delete(mapping.clientKey);
          if (clientItems.size === 0)
            this.clientMappings.delete(mapping.clientPeer);
        }
        this.sendError(
          mapping.clientPeer,
          mapping.clientID,
          status.TARGET_UNREACHABLE);
      }
      this.targetMappings.delete(peer);
    }

    const capture = this.baseCaptures.get(peer);
    if (capture) {
      capture.cancel();
      this.baseCaptures.delete(peer);
    }
  }
}

exports.ODoHCrypto = ODoHCrypto;
exports.ODoHService = ODoHService;
exports.TargetConfigRecord = TargetConfigRecord;
exports.createLocator = createLocator;
exports.encodeLocator = encodeLocator;
exports.decodeLocator = decodeLocator;
exports.locatorEquals = locatorEquals;
exports.encodePlaintext = encodePlaintext;
exports.decodePlaintext = decodePlaintext;
exports.encodeMessage = encodeMessage;
exports.decodeMessage = decodeMessage;
exports.encodeConfigContents = encodeConfigContents;
exports.decodeConfigContents = decodeConfigContents;
exports.encodeConfigs = encodeConfigs;
exports.decodeConfigs = decodeConfigs;
exports.decodeConfigList = decodeConfigList;
exports.deriveKeyID = deriveKeyID;
exports.deriveResponseSecrets = deriveResponseSecrets;
exports.encodeCaps = encodeCaps;
exports.decodeCaps = decodeCaps;
exports.encodeGetConfig = encodeGetConfig;
exports.decodeGetConfig = decodeGetConfig;
exports.encodeConfig = encodeConfig;
exports.decodeConfig = decodeConfig;
exports.encodeClientQuery = encodeClientQuery;
exports.decodeClientQuery = decodeClientQuery;
exports.encodeTargetQuery = encodeTargetQuery;
exports.decodeTargetQuery = decodeTargetQuery;
exports.encodeResponse = encodeResponse;
exports.decodeResponse = decodeResponse;
exports.encodeError = encodeError;
exports.decodeError = decodeError;
exports.validateDNSResponse = validateDNSResponse;
exports.constants = {
  SUPPORTED_VERSION,
  KEM_X25519_SHA256,
  KDF_HKDF_SHA256,
  AEAD_AES_128_GCM,
  DIRECT_BRONTIDE
};
