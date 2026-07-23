/*!
 * hnsr.js - regtest proof of concept for Handshake rendezvous and relay.
 * Copyright (c) 2026, Jaron Rosenau (MIT License).
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const bio = require('bufio');
const IP = require('binet');
const blake2b = require('bcrypto/lib/blake2b');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const common = require('./common');
const NetAddress = require('./netaddress');
const packets = require('./packets');

const ZERO32 = Buffer.alloc(32);
const EMPTY = Buffer.alloc(0);

const domains = {
  RESERVE: Buffer.from('HNSR-RESERVE-V1\0', 'ascii'),
  RENEW: Buffer.from('HNSR-RENEW-V1\0', 'ascii'),
  TICKET_RELAY: Buffer.from('HNSR-RELAY-TICKET-V1\0', 'ascii'),
  TICKET_ENDPOINT: Buffer.from('HNSR-RELAY-CONFIRM-V1\0', 'ascii'),
  DELEGATION: Buffer.from('HNSR-ENDPOINT-DELEGATION-V1\0', 'ascii'),
  ROUTE: Buffer.from('HNSR-ROUTE-RECORD-V1\0', 'ascii'),
  PEER_ROUTE: Buffer.from('HNSR-PEER-ROUTE-V1\0', 'ascii'),
  RENDEZVOUS_NODE: Buffer.from('HNSR-RENDEZVOUS-NODE-V1\0', 'ascii'),
  WITHDRAW: Buffer.from('HNSR-WITHDRAW-V1\0', 'ascii'),
  SAMPLE: Buffer.from('HNSR-SAMPLE-ROUTES-V1\0', 'ascii')
};

const opcodes = {
  FINDNODE: 0,
  NODES: 1,
  PUTROUTE: 2,
  PUTRESULT: 3,
  GETROUTE: 4,
  ROUTES: 5,
  SAMPLEROUTES: 6,
  RESERVE: 7,
  OFFER: 8,
  CONFIRM: 9,
  CONFIRMED: 10,
  RENEW: 11,
  WITHDRAW: 12,
  OPEN: 13,
  INCOMING: 14,
  ACCEPT: 15,
  OPENED: 16,
  DATA: 17,
  WINDOW: 18,
  CLOSE: 19,
  ERROR: 20
};

const errors = {
  NORMAL: 0,
  REFUSED: 1,
  UNSUPPORTED: 2,
  BUSY: 3,
  INVALID: 4,
  NOT_FOUND: 5,
  EXPIRED: 6,
  CAPACITY: 7,
  TIMEOUT: 8,
  PROTOCOL: 9,
  INTERNAL: 10,
  ENDPOINT_GONE: 11,
  AUTH_FAILED: 12,
  FLOW_CONTROL: 13,
  RATE_LIMITED: 14,
  SHUTDOWN: 15,
  PROFILE_DISABLED: 16,
  BYTE_LIMIT: 17
};

const profiles = {
  HNS_NODE_V1: 1,
  HNS_WEB_V1: 2
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function hash(domain, ...items) {
  return blake2b.digest(Buffer.concat([domain, ...items]), 32);
}

function magicBytes(magic) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(magic, 0, true);
  return data;
}

function sign(domain, data, key) {
  return secp256k1.signDER(hash(domain, data), key);
}

function verify(domain, data, signature, key) {
  if (!Buffer.isBuffer(signature)
      || signature.length === 0
      || signature.length > common.hnsr.MAX_SIGNATURE_SIZE) {
    return false;
  }

  try {
    return secp256k1.publicKeyVerify(key)
      && secp256k1.isLowDER(signature)
      && secp256k1.verifyDER(hash(domain, data), signature, key);
  } catch (e) {
    return false;
  }
}

function isZero(data) {
  for (const ch of data) {
    if (ch !== 0)
      return false;
  }

  return true;
}

function randomID(size) {
  let id;

  do {
    id = random.randomBytes(size);
  } while (isZero(id));

  return id;
}

function assertU64(value, name) {
  assert(Number.isSafeInteger(value) && value >= 0, `${name} must be a u64.`);
}

function readSignature(br, name) {
  const size = br.readU8();

  if (size > common.hnsr.MAX_SIGNATURE_SIZE)
    throw new Error(`${name} signature exceeds the HNSR limit.`);

  return br.readBytes(size);
}

function writeSignature(bw, signature) {
  assert(Buffer.isBuffer(signature));
  assert(signature.length <= common.hnsr.MAX_SIGNATURE_SIZE);
  bw.writeU8(signature.length);
  bw.writeBytes(signature);
}

function finish(br, name) {
  if (br.left() !== 0)
    throw new Error(`Trailing bytes in ${name}.`);
}

function peerKey(peer, contextID) {
  return `${peer.id}:${contextID.toString('hex')}`;
}

function routeKey(magic, endpointKey) {
  assert(secp256k1.publicKeyVerify(endpointKey));
  return hash(domains.PEER_ROUTE, magicBytes(magic), endpointKey);
}

function withdrawData(magic, relayKey, contextID, reservationID, ticketID) {
  assert(secp256k1.publicKeyVerify(relayKey));
  assert(contextID.length === 8);
  assert(reservationID.length === 16);
  assert(ticketID.length === 32);
  return Buffer.concat([
    magicBytes(magic),
    relayKey,
    contextID,
    reservationID,
    ticketID
  ]);
}

function rendezvousNodeID(magic, peerKey) {
  assert(secp256k1.publicKeyVerify(peerKey));
  return hash(domains.RENDEZVOUS_NODE, magicBytes(magic), peerKey);
}

function compareDistance(a, b, target) {
  assert(a.length === 32 && b.length === 32 && target.length === 32);

  for (let i = 0; i < 32; i++) {
    const left = a[i] ^ target[i];
    const right = b[i] ^ target[i];

    if (left !== right)
      return left - right;
  }

  return 0;
}

function peerPublicKey(peer) {
  if (peer && peer.address && secp256k1.publicKeyVerify(peer.address.key))
    return peer.address.key;

  if (peer && peer.brontide
      && secp256k1.publicKeyVerify(peer.brontide.remoteStatic)) {
    return peer.brontide.remoteStatic;
  }

  return null;
}

class RendezvousContact {
  constructor(options = {}) {
    this.nodeID = options.nodeID || Buffer.alloc(32);
    this.hostType = options.hostType || 1;
    this.host = options.host || Buffer.alloc(16);
    this.port = options.port || 0;
    this.services = options.services || 0;
    this.peerKey = options.peerKey || Buffer.alloc(33);
    this.observedAt = options.observedAt || 0;
  }

  verify(magic, timestamp = now()) {
    if (!Buffer.isBuffer(this.nodeID)
        || this.nodeID.length !== 32
        || (this.hostType !== 1 && this.hostType !== 2)
        || !Buffer.isBuffer(this.host)
        || this.host.length !== 16
        || this.port === 0
        || !Number.isSafeInteger(this.services)
        || this.services < 0
        || (this.services
          & common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE) === 0
        || !secp256k1.publicKeyVerify(this.peerKey)
        || !Number.isSafeInteger(this.observedAt)
        || this.observedAt > timestamp + 600
        || timestamp - this.observedAt > 86400) {
      return false;
    }

    return this.nodeID.equals(rendezvousNodeID(magic, this.peerKey));
  }

  encode() {
    assert(this.nodeID.length === 32);
    assert((this.hostType & 0xff) === this.hostType);
    assert(this.host.length === 16);
    assert((this.port & 0xffff) === this.port);
    assertU64(this.services, 'rendezvous services');
    assert(secp256k1.publicKeyVerify(this.peerKey));
    assertU64(this.observedAt, 'observedAt');

    const bw = bio.write(100);
    bw.writeBytes(this.nodeID);
    bw.writeU8(this.hostType);
    bw.writeBytes(this.host);
    bw.writeU16(this.port);
    bw.writeU64(this.services);
    bw.writeBytes(this.peerKey);
    bw.writeU64(this.observedAt);
    return bw.render();
  }

  toAddress(network) {
    const address = NetAddress.fromHost(
      IP.toString(this.host),
      this.port,
      this.peerKey,
      network);
    address.services = this.services;
    address.time = this.observedAt;
    return address;
  }

  static read(br) {
    const contact = new RendezvousContact();
    contact.nodeID = br.readBytes(32);
    contact.hostType = br.readU8();
    contact.host = br.readBytes(16);
    contact.port = br.readU16();
    contact.services = br.readU64();
    contact.peerKey = br.readBytes(33);
    contact.observedAt = br.readU64();
    return contact;
  }

  static decode(data) {
    const br = bio.read(data);
    const contact = RendezvousContact.read(br);
    finish(br, 'HNSR rendezvous contact');
    return contact;
  }
}

class ReserveRequest {
  constructor(options = {}) {
    this.endpointKey = options.endpointKey || Buffer.alloc(33);
    this.profile = options.profile || profiles.HNS_NODE_V1;
    this.lifetime = options.lifetime || 1800;
    this.maxCircuits = options.maxCircuits || 8;
    this.maxBytes = options.maxBytes || 1048576;
    this.nonce = options.nonce || Buffer.alloc(16);
    this.signature = options.signature || EMPTY;
  }

  encodeUnsigned() {
    assert(secp256k1.publicKeyVerify(this.endpointKey));
    assert((this.profile & 0xffff) === this.profile);
    assert((this.lifetime >>> 0) === this.lifetime);
    assert((this.maxCircuits & 0xffff) === this.maxCircuits);
    assertU64(this.maxBytes, 'maxBytes');
    assert(this.nonce.length === 16);

    const bw = bio.write(65);
    bw.writeBytes(this.endpointKey);
    bw.writeU16(this.profile);
    bw.writeU32(this.lifetime);
    bw.writeU16(this.maxCircuits);
    bw.writeU64(this.maxBytes);
    bw.writeBytes(this.nonce);
    return bw.render();
  }

  signatureData(magic, relayKey, contextID) {
    assert(contextID.length === 8);
    return Buffer.concat([
      magicBytes(magic),
      relayKey,
      contextID,
      this.encodeUnsigned()
    ]);
  }

  sign(magic, relayKey, contextID, privateKey) {
    this.signature = sign(
      domains.RESERVE,
      this.signatureData(magic, relayKey, contextID),
      privateKey);
    return this;
  }

  verify(magic, relayKey, contextID) {
    return verify(
      domains.RESERVE,
      this.signatureData(magic, relayKey, contextID),
      this.signature,
      this.endpointKey);
  }

  renewalData(magic, relayKey, contextID, reservationID) {
    assert(Buffer.isBuffer(reservationID) && reservationID.length === 16);
    return Buffer.concat([
      magicBytes(magic),
      relayKey,
      contextID,
      reservationID,
      this.encodeUnsigned()
    ]);
  }

  signRenewal(magic, relayKey, contextID, reservationID, privateKey) {
    this.signature = sign(
      domains.RENEW,
      this.renewalData(magic, relayKey, contextID, reservationID),
      privateKey);
    return this;
  }

  verifyRenewal(magic, relayKey, contextID, reservationID) {
    return verify(
      domains.RENEW,
      this.renewalData(magic, relayKey, contextID, reservationID),
      this.signature,
      this.endpointKey);
  }

  encode() {
    const unsigned = this.encodeUnsigned();
    const bw = bio.write(unsigned.length + 1 + this.signature.length);
    bw.writeBytes(unsigned);
    writeSignature(bw, this.signature);
    return bw.render();
  }

  static decode(data) {
    const br = bio.read(data);
    const request = new ReserveRequest();
    request.endpointKey = br.readBytes(33);
    request.profile = br.readU16();
    request.lifetime = br.readU32();
    request.maxCircuits = br.readU16();
    request.maxBytes = br.readU64();
    request.nonce = br.readBytes(16);
    request.signature = readSignature(br, 'reserve');
    finish(br, 'reserve request');
    request.encodeUnsigned();
    return request;
  }
}

class RelayTicket {
  constructor(options = {}) {
    this.version = 1;
    this.networkMagic = options.networkMagic || 0;
    this.profile = options.profile || profiles.HNS_NODE_V1;
    this.transport = options.transport || 0;
    this.hostType = options.hostType || 1;
    this.host = options.host || Buffer.alloc(16);
    this.port = options.port || 0;
    this.relayKey = options.relayKey || Buffer.alloc(33);
    this.endpointKey = options.endpointKey || Buffer.alloc(33);
    this.reservationID = options.reservationID || Buffer.alloc(16);
    this.issuedAt = options.issuedAt || 0;
    this.expiresAt = options.expiresAt || 0;
    this.maxActiveCircuits = options.maxActiveCircuits || 0;
    this.maxBytesPerCircuit = options.maxBytesPerCircuit || 0;
    this.maxTotalBytes = options.maxTotalBytes || 0;
    this.flags = options.flags || 0;
    this.relaySignature = options.relaySignature || EMPTY;
    this.endpointSignature = options.endpointSignature || EMPTY;
  }

  encodeUnsigned() {
    assert(this.version === 1);
    assert((this.networkMagic >>> 0) === this.networkMagic);
    assert((this.profile & 0xffff) === this.profile);
    assert((this.transport & 0xff) === this.transport);
    assert((this.hostType & 0xff) === this.hostType);
    assert(Buffer.isBuffer(this.host) && this.host.length === 16);
    assert((this.port & 0xffff) === this.port);
    assert(secp256k1.publicKeyVerify(this.relayKey));
    assert(secp256k1.publicKeyVerify(this.endpointKey));
    assert(this.reservationID.length === 16 && !isZero(this.reservationID));
    assertU64(this.issuedAt, 'issuedAt');
    assertU64(this.expiresAt, 'expiresAt');
    assert((this.maxActiveCircuits & 0xffff) === this.maxActiveCircuits);
    assertU64(this.maxBytesPerCircuit, 'maxBytesPerCircuit');
    assertU64(this.maxTotalBytes, 'maxTotalBytes');
    assert((this.flags & 0xffff) === this.flags);

    const bw = bio.write(145);
    bw.writeU8(this.version);
    bw.writeU32(this.networkMagic);
    bw.writeU16(this.profile);
    bw.writeU8(this.transport);
    bw.writeU8(this.hostType);
    bw.writeBytes(this.host);
    bw.writeU16(this.port);
    bw.writeBytes(this.relayKey);
    bw.writeBytes(this.endpointKey);
    bw.writeBytes(this.reservationID);
    bw.writeU64(this.issuedAt);
    bw.writeU64(this.expiresAt);
    bw.writeU16(this.maxActiveCircuits);
    bw.writeU64(this.maxBytesPerCircuit);
    bw.writeU64(this.maxTotalBytes);
    bw.writeU16(this.flags);
    return bw.render();
  }

  signRelay(privateKey) {
    this.relaySignature = sign(
      domains.TICKET_RELAY,
      this.encodeUnsigned(),
      privateKey);
    return this;
  }

  verifyRelay() {
    return verify(
      domains.TICKET_RELAY,
      this.encodeUnsigned(),
      this.relaySignature,
      this.relayKey);
  }

  endpointData() {
    return Buffer.concat([this.encodeUnsigned(), this.relaySignature]);
  }

  signEndpoint(privateKey) {
    assert(this.verifyRelay());
    this.endpointSignature = sign(
      domains.TICKET_ENDPOINT,
      this.endpointData(),
      privateKey);
    return this;
  }

  verifyEndpoint() {
    return verify(
      domains.TICKET_ENDPOINT,
      this.endpointData(),
      this.endpointSignature,
      this.endpointKey);
  }

  verify(magic, timestamp = now()) {
    if (this.networkMagic !== magic
        || this.profile !== profiles.HNS_NODE_V1
        || this.transport !== 0
        || (this.hostType !== 1 && this.hostType !== 2)
        || this.port === 0
        || this.flags !== 0
        || this.relayKey.equals(this.endpointKey)
        || this.maxActiveCircuits < 1
        || this.maxActiveCircuits > common.hnsr.MAX_CIRCUITS
        || this.maxBytesPerCircuit < 1
        || this.maxTotalBytes < this.maxBytesPerCircuit
        || this.expiresAt <= this.issuedAt
        || this.expiresAt - this.issuedAt > common.hnsr.MAX_TICKET_LIFETIME
        || timestamp < this.issuedAt
        || timestamp >= this.expiresAt) {
      return false;
    }

    return this.verifyRelay() && this.verifyEndpoint();
  }

  id() {
    return blake2b.digest(this.encode(), 32);
  }

  encode() {
    const unsigned = this.encodeUnsigned();
    const size = unsigned.length + 2
      + this.relaySignature.length
      + this.endpointSignature.length;
    const bw = bio.write(size);
    bw.writeBytes(unsigned);
    writeSignature(bw, this.relaySignature);
    writeSignature(bw, this.endpointSignature);
    return bw.render();
  }

  static read(br) {
    const ticket = new RelayTicket();
    ticket.version = br.readU8();
    ticket.networkMagic = br.readU32();
    ticket.profile = br.readU16();
    ticket.transport = br.readU8();
    ticket.hostType = br.readU8();
    ticket.host = br.readBytes(16);
    ticket.port = br.readU16();
    ticket.relayKey = br.readBytes(33);
    ticket.endpointKey = br.readBytes(33);
    ticket.reservationID = br.readBytes(16);
    ticket.issuedAt = br.readU64();
    ticket.expiresAt = br.readU64();
    ticket.maxActiveCircuits = br.readU16();
    ticket.maxBytesPerCircuit = br.readU64();
    ticket.maxTotalBytes = br.readU64();
    ticket.flags = br.readU16();
    ticket.relaySignature = readSignature(br, 'relay ticket');
    ticket.endpointSignature = readSignature(br, 'endpoint ticket');
    ticket.encodeUnsigned();
    return ticket;
  }

  static decode(data) {
    const br = bio.read(data);
    const ticket = RelayTicket.read(br);
    finish(br, 'relay ticket');
    return ticket;
  }
}

class EndpointDelegation {
  constructor(options = {}) {
    this.version = 1;
    this.authorizationID = options.authorizationID || ZERO32;
    this.endpointKey = options.endpointKey || Buffer.alloc(33);
    this.sequence = options.sequence || 1;
    this.issuedAt = options.issuedAt || 0;
    this.expiresAt = options.expiresAt || 0;
    this.maxActiveCircuits = options.maxActiveCircuits || 8;
    this.maxBytesPerCircuit = options.maxBytesPerCircuit || 1048576;
    this.flags = options.flags || 0;
    this.signature = options.signature || EMPTY;
  }

  encodeUnsigned() {
    assert(this.version === 1);
    assert(this.authorizationID.length === 32);
    assert(secp256k1.publicKeyVerify(this.endpointKey));
    assertU64(this.sequence, 'endpoint sequence');
    assertU64(this.issuedAt, 'issuedAt');
    assertU64(this.expiresAt, 'expiresAt');
    assert((this.maxActiveCircuits & 0xffff) === this.maxActiveCircuits);
    assertU64(this.maxBytesPerCircuit, 'maxBytesPerCircuit');
    assert((this.flags & 0xffff) === this.flags);

    const bw = bio.write(102);
    bw.writeU8(this.version);
    bw.writeBytes(this.authorizationID);
    bw.writeBytes(this.endpointKey);
    bw.writeU64(this.sequence);
    bw.writeU64(this.issuedAt);
    bw.writeU64(this.expiresAt);
    bw.writeU16(this.maxActiveCircuits);
    bw.writeU64(this.maxBytesPerCircuit);
    bw.writeU16(this.flags);
    return bw.render();
  }

  sign(magic, privateKey) {
    this.signature = sign(
      domains.DELEGATION,
      Buffer.concat([magicBytes(magic), this.encodeUnsigned()]),
      privateKey);
    return this;
  }

  verify(magic, timestamp = now()) {
    if (!isZero(this.authorizationID)
        || this.sequence < 1
        || this.expiresAt <= this.issuedAt
        || this.expiresAt - this.issuedAt > 604800
        || timestamp < this.issuedAt
        || timestamp >= this.expiresAt
        || this.maxActiveCircuits < 1
        || this.maxActiveCircuits > common.hnsr.MAX_CIRCUITS
        || this.maxBytesPerCircuit < 1
        || this.flags !== 0) {
      return false;
    }

    return verify(
      domains.DELEGATION,
      Buffer.concat([magicBytes(magic), this.encodeUnsigned()]),
      this.signature,
      this.endpointKey);
  }

  encode() {
    const unsigned = this.encodeUnsigned();
    const bw = bio.write(unsigned.length + 1 + this.signature.length);
    bw.writeBytes(unsigned);
    writeSignature(bw, this.signature);
    return bw.render();
  }

  static decode(data) {
    const br = bio.read(data);
    const delegation = new EndpointDelegation();
    delegation.version = br.readU8();
    delegation.authorizationID = br.readBytes(32);
    delegation.endpointKey = br.readBytes(33);
    delegation.sequence = br.readU64();
    delegation.issuedAt = br.readU64();
    delegation.expiresAt = br.readU64();
    delegation.maxActiveCircuits = br.readU16();
    delegation.maxBytesPerCircuit = br.readU64();
    delegation.flags = br.readU16();
    delegation.signature = readSignature(br, 'endpoint delegation');
    finish(br, 'endpoint delegation');
    delegation.encodeUnsigned();
    return delegation;
  }
}

class RouteRecord {
  constructor(options = {}) {
    this.version = 1;
    this.authorityType = 0;
    this.routeKey = options.routeKey || Buffer.alloc(32);
    this.profile = options.profile || profiles.HNS_NODE_V1;
    this.sequence = options.sequence || 1;
    this.issuedAt = options.issuedAt || 0;
    this.expiresAt = options.expiresAt || 0;
    this.authorization = options.authorization || EMPTY;
    this.delegation = options.delegation || new EndpointDelegation();
    this.tickets = options.tickets || [];
    this.endpointSignature = options.endpointSignature || EMPTY;
  }

  encodeUnsigned() {
    assert(this.version === 1);
    assert(this.authorityType === 0);
    assert(this.routeKey.length === 32);
    assert(this.profile === profiles.HNS_NODE_V1);
    assertU64(this.sequence, 'record sequence');
    assertU64(this.issuedAt, 'issuedAt');
    assertU64(this.expiresAt, 'expiresAt');
    assert(this.authorization.length === 0);
    assert(this.tickets.length >= 1 && this.tickets.length <= 8);

    const delegation = this.delegation.encode();
    const encodedTickets = this.tickets.map(ticket => ticket.encode());
    let size = 65 + delegation.length;

    for (const ticket of encodedTickets)
      size += ticket.length;

    const bw = bio.write(size);
    bw.writeU8(this.version);
    bw.writeU8(this.authorityType);
    bw.writeBytes(this.routeKey);
    bw.writeU16(this.profile);
    bw.writeU64(this.sequence);
    bw.writeU64(this.issuedAt);
    bw.writeU64(this.expiresAt);
    bw.writeU16(0);
    bw.writeU16(delegation.length);
    bw.writeBytes(delegation);
    bw.writeU8(encodedTickets.length);

    for (const ticket of encodedTickets)
      bw.writeBytes(ticket);

    return bw.render();
  }

  sign(privateKey) {
    this.endpointSignature = sign(
      domains.ROUTE,
      this.encodeUnsigned(),
      privateKey);
    return this;
  }

  verify(magic, timestamp = now()) {
    if (this.authorityType !== 0
        || this.profile !== profiles.HNS_NODE_V1
        || this.sequence < 1
        || this.expiresAt <= this.issuedAt
        || this.expiresAt - this.issuedAt > common.hnsr.MAX_ROUTE_LIFETIME
        || timestamp < this.issuedAt
        || timestamp >= this.expiresAt
        || this.tickets.length < 1
        || this.tickets.length > 8
        || !this.routeKey.equals(routeKey(magic, this.delegation.endpointKey))
        || !this.delegation.verify(magic, timestamp)
        || this.delegation.expiresAt < this.expiresAt) {
      return false;
    }

    for (const ticket of this.tickets) {
      if (!ticket.endpointKey.equals(this.delegation.endpointKey)
          || ticket.profile !== this.profile
          || ticket.expiresAt < this.expiresAt
          || !ticket.verify(magic, timestamp)) {
        return false;
      }
    }

    return verify(
      domains.ROUTE,
      this.encodeUnsigned(),
      this.endpointSignature,
      this.delegation.endpointKey);
  }

  encode() {
    const unsigned = this.encodeUnsigned();
    const bw = bio.write(unsigned.length + 1 + this.endpointSignature.length);
    bw.writeBytes(unsigned);
    writeSignature(bw, this.endpointSignature);
    return bw.render();
  }

  static decode(data) {
    if (data.length === 0 || data.length > common.hnsr.MAX_RECORD_SIZE)
      throw new Error('Route record exceeds the HNSR limit.');

    const br = bio.read(data);
    const record = new RouteRecord();
    record.version = br.readU8();
    record.authorityType = br.readU8();
    record.routeKey = br.readBytes(32);
    record.profile = br.readU16();
    record.sequence = br.readU64();
    record.issuedAt = br.readU64();
    record.expiresAt = br.readU64();
    const authSize = br.readU16();
    record.authorization = br.readBytes(authSize);
    const delegationSize = br.readU16();
    record.delegation = EndpointDelegation.decode(br.readBytes(delegationSize));
    const count = br.readU8();

    if (count < 1 || count > 8)
      throw new Error('Invalid HNSR route ticket count.');

    record.tickets = [];

    for (let i = 0; i < count; i++)
      record.tickets.push(RelayTicket.read(br));

    record.endpointSignature = readSignature(br, 'route record');
    finish(br, 'route record');
    record.encodeUnsigned();
    return record;
  }
}

class RouteStore {
  constructor(magic, options = {}) {
    this.magic = magic;
    this.maxRecords = options.maxRecords || common.hnsr.MAX_STORED_RECORDS;
    this.maxPerKey = options.maxPerKey || common.hnsr.MAX_RECORDS_PER_KEY;
    this.maxPerPeer = options.maxPerPeer
      || common.hnsr.MAX_STORES_PER_PEER;
    this.records = new Map();
    this.sourceCounts = new Map();
    this.size = 0;
  }

  put(key, raw, timestamp = now(), source = 'local') {
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new Error('Invalid HNSR route key.');

    if (typeof source !== 'string' || source.length === 0)
      throw new Error('Invalid HNSR route source.');

    const record = RouteRecord.decode(raw);

    if (!record.routeKey.equals(key) || !record.verify(this.magic, timestamp))
      throw new Error('Invalid HNSR route record.');

    const hex = key.toString('hex');
    const items = this._active(hex, timestamp);
    const endpoint = record.delegation.endpointKey.toString('hex');
    const index = items.findIndex(item => item.endpoint === endpoint);
    const previous = index !== -1 ? items[index] : null;

    if (previous) {
      if (previous.sequence >= record.sequence)
        throw new Error('Stale HNSR route sequence.');
    }

    if (!previous && items.length >= this.maxPerKey)
      throw new Error('HNSR per-key route capacity reached.');

    if (!previous && this.size >= this.maxRecords)
      throw new Error('HNSR route store capacity reached.');

    const sourceCount = this.sourceCounts.get(source) || 0;
    const replacesSameSource = previous && previous.source === source;

    if (sourceCount >= this.maxPerPeer && !replacesSameSource)
      throw new Error('HNSR per-peer route capacity reached.');

    if (previous) {
      this._decrementSource(previous.source);
      items.splice(index, 1);
      this.size -= 1;
    }

    items.push({
      endpoint,
      sequence: record.sequence,
      expiresAt: record.expiresAt,
      source,
      raw: Buffer.from(raw)
    });

    this.records.set(hex, items);
    this.sourceCounts.set(source, (this.sourceCounts.get(source) || 0) + 1);
    this.size += 1;

    return record.expiresAt;
  }

  get(key, maximum = 16, timestamp = now()) {
    assert(Buffer.isBuffer(key) && key.length === 32);
    const items = this._active(key.toString('hex'), timestamp);
    items.sort((a, b) => b.sequence - a.sequence);
    return items.slice(0, maximum).map(item => Buffer.from(item.raw));
  }

  sample(maximum, seed, timestamp = now()) {
    assert(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 16);
    assert(Buffer.isBuffer(seed) && seed.length === 32);

    const items = [];

    for (const hex of Array.from(this.records.keys())) {
      for (const item of this._active(hex, timestamp)) {
        items.push({
          score: hash(domains.SAMPLE, seed, item.raw),
          raw: item.raw
        });
      }
    }

    items.sort((a, b) => a.score.compare(b.score));
    return items.slice(0, maximum).map(item => Buffer.from(item.raw));
  }

  _decrementSource(source) {
    const count = this.sourceCounts.get(source) || 0;

    if (count <= 1)
      this.sourceCounts.delete(source);
    else
      this.sourceCounts.set(source, count - 1);
  }

  _active(hex, timestamp) {
    const items = this.records.get(hex) || [];
    const active = items.filter(item => item.expiresAt > timestamp);

    for (const item of items) {
      if (item.expiresAt <= timestamp)
        this._decrementSource(item.source);
    }

    this.size -= items.length - active.length;

    if (active.length === 0)
      this.records.delete(hex);
    else
      this.records.set(hex, active);

    return active;
  }
}

class CircuitSocket extends EventEmitter {
  constructor(service, peer, contextID, window) {
    super();

    this.service = service;
    this.peer = peer;
    this.contextID = Buffer.from(contextID);
    this.sendCredit = window;
    this.sendQueue = [];
    this.sendQueueBytes = 0;
    this.receiveQueue = [];
    this.receiveQueueBytes = 0;
    this.paused = false;
    this.destroyed = false;
    this.connected = false;
    this.readable = true;
    this.writable = true;
    this.remoteAddress = '127.0.0.1';
    this.localAddress = '127.0.0.1';
    this.remotePort = 49152 + contextID.readUInt16LE(0, true) % 16384;
    this.localPort = 0;
  }

  connect() {
    if (this.destroyed || this.connected)
      return;

    this.connected = true;
    this.emit('connect');
  }

  write(data) {
    assert(Buffer.isBuffer(data));

    if (this.destroyed)
      return false;

    if (data.length === 0)
      return true;

    if (this.sendQueueBytes + data.length > common.hnsr.MAX_SOCKET_QUEUE) {
      const err = new Error('HNSR circuit send queue exhausted.');
      this.destroy();
      this.emit('error', err);
      return false;
    }

    this.sendQueue.push(Buffer.from(data));
    this.sendQueueBytes += data.length;
    this._flush();
    return this.sendQueueBytes === 0;
  }

  _sendData(data) {
    assert(data.length > 0 && data.length <= common.hnsr.MAX_DATA_SIZE);
    assert(data.length <= this.sendCredit);
    this.sendCredit -= data.length;
    this.service._send(this.peer, opcodes.DATA, this.contextID, data);
  }

  _flush() {
    while (!this.destroyed && this.sendCredit > 0
        && this.sendQueue.length > 0) {
      const data = this.sendQueue[0];
      const size = Math.min(
        data.length,
        this.sendCredit,
        common.hnsr.MAX_DATA_SIZE);
      const chunk = data.slice(0, size);

      this._sendData(chunk);
      this.sendQueueBytes -= size;

      if (size === data.length)
        this.sendQueue.shift();
      else
        this.sendQueue[0] = data.slice(size);
    }

    if (!this.destroyed && this.sendQueueBytes === 0)
      setImmediate(() => this.emit('drain'));
  }

  addCredit(credit) {
    if (!Number.isSafeInteger(credit) || credit <= 0)
      throw new Error('Invalid HNSR window credit.');

    if (this.sendCredit + credit > common.hnsr.MAX_WINDOW)
      throw new Error('HNSR window exceeds the maximum.');

    this.sendCredit += credit;
    this._flush();
  }

  receive(data) {
    if (this.destroyed)
      return;

    if (this.paused) {
      if (this.receiveQueueBytes + data.length
          > common.hnsr.MAX_CIRCUIT_QUEUE) {
        const err = new Error('HNSR circuit receive queue exhausted.');
        this.destroy();
        this.emit('error', err);
        return;
      }

      this.receiveQueue.push(Buffer.from(data));
      this.receiveQueueBytes += data.length;
      return;
    }

    this._deliver(data);
  }

  _deliver(data) {
    this.emit('data', data);

    const bw = bio.write(4);
    bw.writeU32(data.length);
    this.service._send(
      this.peer,
      opcodes.WINDOW,
      this.contextID,
      bw.render());
  }

  pause() {
    this.paused = true;
    return this;
  }

  resume() {
    this.paused = false;

    while (!this.destroyed && !this.paused
        && this.receiveQueue.length > 0) {
      const data = this.receiveQueue.shift();
      this.receiveQueueBytes -= data.length;
      this._deliver(data);
    }

    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  setTimeout() {
    return this;
  }

  _clear() {
    this.readable = false;
    this.writable = false;
    this.sendQueue.length = 0;
    this.sendQueueBytes = 0;
    this.receiveQueue.length = 0;
    this.receiveQueueBytes = 0;
  }

  remoteClose() {
    if (this.destroyed)
      return;

    this.destroyed = true;
    this._clear();
    this.emit('close');
  }

  destroy() {
    if (this.destroyed)
      return;

    this.destroyed = true;
    this._clear();
    const bw = bio.write(3);
    bw.writeU16(errors.NORMAL);
    bw.writeU8(0);
    this.service._send(
      this.peer,
      opcodes.CLOSE,
      this.contextID,
      bw.render());
    this.service._dropSocket(this.peer, this.contextID);
    this.emit('close');
  }

  end() {
    this.destroy();
  }
}

class HNSRService extends EventEmitter {
  constructor(options) {
    super();

    assert(options);
    assert(options.network);
    assert(Buffer.isBuffer(options.identityKey));
    assert(secp256k1.privateKeyVerify(options.identityKey));

    this.network = options.network;
    this.identityKey = options.identityKey;
    this.publicKey = secp256k1.publicKeyCreate(this.identityKey, true);
    this.pool = options.pool || null;
    this.logger = options.logger && options.logger.context
      ? options.logger.context('hnsr')
      : options.logger;
    this.enabled = options.enabled === true;
    this.rendezvous = options.rendezvous === true;
    this.relay = options.relay === true;
    this.endpoint = options.endpoint === true;
    this.relayHost = options.relayHost || Buffer.from([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0xff, 0xff, 127, 0, 0, 1
    ]);
    this.relayPort = options.relayPort || this.network.port;
    this.timeout = options.timeout || common.hnsr.DEFAULT_TIMEOUT;
    this.opened = false;
    this.store = new RouteStore(this.network.magic, options.storeOptions);
    this.contacts = new Map();
    this.admission = new Map();
    this.pending = new Map();
    this.provisional = new Map();
    this.reservations = new Map();
    this.endpointTickets = new Map();
    this.opening = new Map();
    this.relayCircuits = new Map();
    this.relayQueue = [];
    this.relayQueueBytes = 0;
    this.relayFlushScheduled = false;
    this.relayFlushHandle = null;
    this.sockets = new Map();
    this.relayBytes = 0;
    this.relayFrames = 0;
    this.relayFlushes = 0;
    this.maxRelayQueuedBytes = 0;
    this.relayDrops = 0;
    this.relayPayloads = [];
    this.routeSequence = 0;
    this.endpointSequence = 0;
  }

  open() {
    this.opened = true;
  }

  close() {
    this.opened = false;

    if (this.relayFlushHandle != null) {
      clearImmediate(this.relayFlushHandle);
      this.relayFlushHandle = null;
    }

    this.relayFlushScheduled = false;
    this.relayQueue.length = 0;
    this.relayQueueBytes = 0;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('HNSR service closed.'));
    }

    this.pending.clear();

    for (const socket of this.sockets.values())
      socket.remoteClose();

    this.sockets.clear();

    for (const state of this.opening.values())
      clearTimeout(state.timer);

    this.opening.clear();
    this.relayCircuits.clear();
    this.provisional.clear();
    this.reservations.clear();
    this.endpointTickets.clear();
    this.contacts.clear();
    this.admission.clear();
  }

  isReady() {
    return this.enabled && this.opened;
  }

  services() {
    let bits = 0;

    if (this.enabled && this.rendezvous)
      bits |= common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE;

    if (this.enabled && this.relay)
      bits |= common.EXPERIMENTAL_HNSR_RELAY_SERVICE;

    return bits >>> 0;
  }

  selfContact(timestamp = now()) {
    if (!this.rendezvous)
      return null;

    return new RendezvousContact({
      nodeID: rendezvousNodeID(this.network.magic, this.publicKey),
      hostType: 1,
      host: Buffer.from(this.relayHost),
      port: this.relayPort,
      services: this.services(),
      peerKey: this.publicKey,
      observedAt: timestamp
    });
  }

  addPeer(peer) {
    if (!this.enabled || !peer || !peer.outbound || peer.hnsrVirtual)
      return null;

    if ((peer.services
        & common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE) === 0) {
      return null;
    }

    const key = peerPublicKey(peer);

    if (!key || !peer.address || peer.address.port === 0)
      return null;

    const contact = new RendezvousContact({
      nodeID: rendezvousNodeID(this.network.magic, key),
      hostType: 1,
      host: Buffer.from(peer.address.raw),
      port: peer.address.port,
      services: peer.services,
      peerKey: Buffer.from(key),
      observedAt: now()
    });

    if (!contact.verify(this.network.magic))
      return null;

    const hex = key.toString('hex');

    for (const [known, item] of this.contacts) {
      if (!item.verify(this.network.magic))
        this.contacts.delete(known);
    }

    if (!this.contacts.has(hex)
        && this.contacts.size >= common.hnsr.MAX_ROUTING_CONTACTS) {
      let oldestKey = null;
      let oldestTime = Infinity;

      for (const [known, item] of this.contacts) {
        if (item.observedAt < oldestTime) {
          oldestKey = known;
          oldestTime = item.observedAt;
        }
      }

      if (oldestKey != null)
        this.contacts.delete(oldestKey);
    }

    this.contacts.set(hex, contact);
    return contact;
  }

  _admit(peer, bytes) {
    const timestamp = Date.now();
    const key = peer.id;
    let state = this.admission.get(key);

    if (!state || timestamp - state.started >= 1000) {
      state = {started: timestamp, requests: 0, bytes: 0};
      this.admission.set(key, state);
    }

    state.requests += 1;
    state.bytes += bytes;

    return state.requests <= common.hnsr.MAX_REQUESTS_PER_SECOND
      && state.bytes <= common.hnsr.MAX_REQUEST_BYTES_PER_SECOND;
  }

  _closestContacts(target, maximum) {
    const contacts = [];
    const seen = new Set();
    const self = this.selfContact();

    if (self) {
      contacts.push(self);
      seen.add(self.peerKey.toString('hex'));
    }

    for (const contact of this.contacts.values()) {
      const key = contact.peerKey.toString('hex');

      if (seen.has(key) || !contact.verify(this.network.magic))
        continue;

      seen.add(key);
      contacts.push(contact);
    }

    contacts.sort((a, b) => compareDistance(a.nodeID, b.nodeID, target));
    return contacts.slice(0, maximum);
  }

  _send(peer, opcode, contextID, body) {
    if (!this.enabled || !peer || peer.destroyed)
      return false;

    assert(Buffer.isBuffer(contextID) && contextID.length === 8);
    assert(!isZero(contextID));
    assert(Buffer.isBuffer(body));
    assert(body.length <= common.hnsr.MAX_PACKET_SIZE - 12);

    peer.send(new packets.HNSRPacket(1, opcode, contextID, body));
    return true;
  }

  _request(peer, opcode, body, expected, contextID = randomID(8)) {
    assert(Array.isArray(expected));

    const key = peerKey(peer, contextID);

    if (this.pending.has(key))
      return Promise.reject(new Error('Duplicate live HNSR context ID.'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error('HNSR request timed out.'));
      }, this.timeout);

      this.pending.set(key, {
        expected: new Set(expected),
        resolve,
        reject,
        timer
      });

      if (!this._send(peer, opcode, contextID, body)) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error('HNSR peer is unavailable.'));
      }
    });
  }

  _resolvePending(peer, packet) {
    const key = peerKey(peer, packet.contextID);
    const pending = this.pending.get(key);

    if (!pending)
      return false;

    if (packet.opcode === opcodes.ERROR) {
      clearTimeout(pending.timer);
      this.pending.delete(key);

      try {
        const br = bio.read(packet.body);
        const reason = br.readU16();
        const size = br.readU8();
        const detail = br.readString(size, 'utf8');
        finish(br, 'HNSR error');
        const err = new Error(detail || `HNSR error ${reason}.`);
        err.code = reason;
        pending.reject(err);
      } catch (e) {
        pending.reject(e);
      }

      return true;
    }

    if (!pending.expected.has(packet.opcode))
      return false;

    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve(packet);
    return true;
  }

  _sendError(peer, contextID, reason, detail) {
    const message = Buffer.from(detail || '', 'utf8').slice(0, 128);
    const bw = bio.write(3 + message.length);
    bw.writeU16(reason);
    bw.writeU8(message.length);
    bw.writeBytes(message);
    this._send(peer, opcodes.ERROR, contextID, bw.render());
  }

  async handle(peer, packet) {
    if (!this.enabled)
      return;

    if (this._resolvePending(peer, packet))
      return;

    if (packet.opcode === opcodes.FINDNODE
        || packet.opcode === opcodes.PUTROUTE
        || packet.opcode === opcodes.GETROUTE
        || packet.opcode === opcodes.SAMPLEROUTES
        || packet.opcode === opcodes.RESERVE
        || packet.opcode === opcodes.RENEW
        || packet.opcode === opcodes.WITHDRAW
        || packet.opcode === opcodes.OPEN) {
      if (!this._admit(peer, packet.body.length + 12)) {
        this._sendError(
          peer,
          packet.contextID,
          errors.RATE_LIMITED,
          'HNSR peer admission limit reached.');
        return;
      }
    }

    try {
      switch (packet.opcode) {
        case opcodes.FINDNODE:
          this._handleFindNode(peer, packet);
          break;
        case opcodes.PUTROUTE:
          this._handlePutRoute(peer, packet);
          break;
        case opcodes.GETROUTE:
          this._handleGetRoute(peer, packet);
          break;
        case opcodes.SAMPLEROUTES:
          this._handleSampleRoutes(peer, packet);
          break;
        case opcodes.RESERVE:
          this._handleReserve(peer, packet, false);
          break;
        case opcodes.RENEW:
          this._handleReserve(peer, packet, true);
          break;
        case opcodes.WITHDRAW:
          this._handleWithdraw(peer, packet);
          break;
        case opcodes.CONFIRM:
          this._handleConfirm(peer, packet);
          break;
        case opcodes.OPEN:
          this._handleOpen(peer, packet);
          break;
        case opcodes.INCOMING:
          this._handleIncoming(peer, packet);
          break;
        case opcodes.ACCEPT:
          this._handleAccept(peer, packet);
          break;
        case opcodes.DATA:
          this._handleData(peer, packet);
          break;
        case opcodes.WINDOW:
          this._handleWindow(peer, packet);
          break;
        case opcodes.CLOSE:
          this._handleClose(peer, packet);
          break;
        case opcodes.OFFER:
        case opcodes.NODES:
        case opcodes.CONFIRMED:
        case opcodes.PUTRESULT:
        case opcodes.ROUTES:
        case opcodes.OPENED:
        case opcodes.ERROR:
          this.emit('unsolicited response', peer, packet);
          return;
        default:
          this._sendError(
            peer,
            packet.contextID,
            errors.UNSUPPORTED,
            'HNSR opcode is not implemented by this PoC.');
          break;
      }
    } catch (e) {
      this.emit('protocol error', e, peer, packet);
      this._sendError(peer, packet.contextID, errors.INVALID, e.message);
    }
  }

  async reserve(peer, options = {}) {
    return this._reserve(peer, options, null);
  }

  async renew(peer, ticket, options = {}) {
    if (!(ticket instanceof RelayTicket)
        || !ticket.verify(this.network.magic)) {
      throw new Error('Invalid HNSR ticket to renew.');
    }

    return this._reserve(peer, options, ticket);
  }

  async _reserve(peer, options = {}, previous) {
    if (!this.enabled || !this.endpoint)
      throw new Error('HNSR endpoint role is disabled.');

    if (!(peer.services & common.EXPERIMENTAL_HNSR_RELAY_SERVICE))
      throw new Error('Peer does not advertise the HNSR relay role.');

    const relayKey = options.relayKey
      || (peer.address && peer.address.key);

    if (!Buffer.isBuffer(relayKey) || !secp256k1.publicKeyVerify(relayKey))
      throw new Error('Authenticated HNSR relay key is required.');

    const contextID = randomID(8);
    const request = new ReserveRequest({
      endpointKey: this.publicKey,
      profile: options.profile || profiles.HNS_NODE_V1,
      lifetime: options.lifetime || 1800,
      maxCircuits: options.maxCircuits || 8,
      maxBytes: options.maxBytes || 1048576,
      nonce: randomID(16)
    });

    if (previous) {
      request.signRenewal(
        this.network.magic,
        relayKey,
        contextID,
        previous.reservationID,
        this.identityKey);
    } else {
      request.sign(
        this.network.magic,
        relayKey,
        contextID,
        this.identityKey);
    }

    let body = request.encode();

    if (previous)
      body = Buffer.concat([previous.reservationID, body]);

    const offered = await this._request(
      peer,
      previous ? opcodes.RENEW : opcodes.RESERVE,
      body,
      [opcodes.OFFER],
      contextID);
    const ticket = RelayTicket.decode(offered.body);

    if (!ticket.relayKey.equals(relayKey)
        || !ticket.endpointKey.equals(this.publicKey)
        || ticket.networkMagic !== this.network.magic
        || ticket.endpointSignature.length !== 0
        || !ticket.verifyRelay()
        || ticket.expiresAt <= now()) {
      throw new Error('Invalid HNSR relay offer.');
    }

    ticket.signEndpoint(this.identityKey);

    const bw = bio.write(17 + ticket.endpointSignature.length);
    bw.writeBytes(ticket.reservationID);
    writeSignature(bw, ticket.endpointSignature);

    const confirmed = await this._request(
      peer,
      opcodes.CONFIRM,
      bw.render(),
      [opcodes.CONFIRMED],
      contextID);
    const br = bio.read(confirmed.body);
    const reservationID = br.readBytes(16);
    const ticketID = br.readBytes(32);
    const expiresAt = br.readU64();
    finish(br, 'HNSR confirmation');

    if (!reservationID.equals(ticket.reservationID)
        || !ticketID.equals(ticket.id())
        || expiresAt !== ticket.expiresAt) {
      throw new Error('Mismatched HNSR confirmation.');
    }

    this.endpointTickets.set(ticketID.toString('hex'), {peer, ticket});
    return ticket;
  }

  async withdraw(peer, ticket) {
    if (!this.enabled || !this.endpoint)
      throw new Error('HNSR endpoint role is disabled.');

    if (!(ticket instanceof RelayTicket)
        || !ticket.verify(this.network.magic)) {
      throw new Error('Invalid HNSR ticket to withdraw.');
    }

    const relayKey = peerPublicKey(peer);

    if (!relayKey || !relayKey.equals(ticket.relayKey))
      throw new Error('HNSR withdrawal relay key mismatch.');

    const contextID = randomID(8);
    const ticketID = ticket.id();
    const signature = sign(
      domains.WITHDRAW,
      withdrawData(
        this.network.magic,
        relayKey,
        contextID,
        ticket.reservationID,
        ticketID),
      this.identityKey);
    const bw = bio.write(49 + signature.length);
    bw.writeBytes(ticket.reservationID);
    bw.writeBytes(ticketID);
    writeSignature(bw, signature);
    const response = await this._request(
      peer,
      opcodes.WITHDRAW,
      bw.render(),
      [opcodes.CONFIRMED],
      contextID);
    const br = bio.read(response.body);
    const reservationID = br.readBytes(16);
    const confirmedTicket = br.readBytes(32);
    const expiresAt = br.readU64();
    finish(br, 'HNSR withdrawal confirmation');

    if (!reservationID.equals(ticket.reservationID)
        || !confirmedTicket.equals(ticketID)
        || expiresAt !== 0) {
      throw new Error('Mismatched HNSR withdrawal confirmation.');
    }

    this.endpointTickets.delete(ticketID.toString('hex'));
    return true;
  }

  async _queryFindNode(peer, target, maximum) {
    const bw = bio.write(33);
    bw.writeBytes(target);
    bw.writeU8(maximum);
    const response = await this._request(
      peer,
      opcodes.FINDNODE,
      bw.render(),
      [opcodes.NODES]);
    const br = bio.read(response.body);
    const count = br.readU8();

    if (count > maximum || count > common.hnsr.MAX_CONTACTS)
      throw new Error('Too many HNSR rendezvous contacts returned.');

    const contacts = [];

    for (let i = 0; i < count; i++) {
      const contact = RendezvousContact.read(br);

      if (!contact.verify(this.network.magic))
        throw new Error('Invalid HNSR rendezvous contact.');

      contacts.push(contact);
    }

    finish(br, 'HNSR nodes response');
    return contacts;
  }

  async _peerForContact(contact) {
    if (!this.pool)
      throw new Error('HNSR rendezvous discovery requires a peer pool.');

    let peer = this.pool.findHNSRPeer(contact.peerKey);

    if (peer && peer.handshake && !peer.destroyed)
      return peer;

    peer = await this.pool.connectHNSRContact(contact);

    if (!peer || !peer.handshake || peer.destroyed)
      throw new Error('Could not connect to discovered HNSR rendezvous peer.');

    return peer;
  }

  async findNodes(bootstrap, target, maximum = common.hnsr.ROUTE_REPLICATION) {
    if (!Buffer.isBuffer(target) || target.length !== 32)
      throw new Error('Invalid HNSR rendezvous target.');

    if (!Array.isArray(bootstrap))
      bootstrap = [bootstrap];

    if (bootstrap.length === 0)
      throw new Error(
        'At least one HNSR rendezvous bootstrap peer is required.');

    if (maximum < 1 || maximum > common.hnsr.MAX_CONTACTS)
      throw new Error('Invalid HNSR rendezvous result limit.');

    const candidates = new Map();
    const peers = new Map();
    const queried = new Set();
    let queries = 0;

    for (const peer of bootstrap) {
      if (!peer || peer.destroyed
          || (peer.services
            & common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE) === 0) {
        continue;
      }

      const contact = this.addPeer(peer);

      if (!contact)
        continue;

      const key = contact.peerKey.toString('hex');
      candidates.set(key, contact);
      peers.set(key, peer);
    }

    if (candidates.size === 0)
      throw new Error('No usable HNSR rendezvous bootstrap peer.');

    while (queries < common.hnsr.MAX_FIND_QUERIES) {
      const ordered = Array.from(candidates.values()).sort(
        (a, b) => compareDistance(a.nodeID, b.nodeID, target));
      const batch = ordered.filter((contact) => {
        return !queried.has(contact.peerKey.toString('hex'));
      }).slice(0, Math.min(
        3,
        common.hnsr.MAX_FIND_QUERIES - queries));

      if (batch.length === 0)
        break;

      const results = await Promise.all(batch.map(async (contact) => {
        const key = contact.peerKey.toString('hex');
        queried.add(key);
        queries += 1;

        try {
          let peer = peers.get(key);

          if (!peer || peer.destroyed || !peer.handshake)
            peer = await this._peerForContact(contact);

          peers.set(key, peer);
          return await this._queryFindNode(
            peer,
            target,
            common.hnsr.MAX_CONTACTS);
        } catch (e) {
          this.emit('discovery failure', e, contact);
          return [];
        }
      }));

      for (const contacts of results) {
        for (const contact of contacts) {
          if (contact.peerKey.equals(this.publicKey))
            continue;

          const key = contact.peerKey.toString('hex');

          if (!candidates.has(key))
            candidates.set(key, contact);
        }
      }
    }

    const selected = Array.from(candidates.values()).sort(
      (a, b) => compareDistance(a.nodeID, b.nodeID, target)).slice(0, maximum);
    const result = [];

    for (const contact of selected) {
      const key = contact.peerKey.toString('hex');

      try {
        let peer = peers.get(key);

        if (!peer || peer.destroyed || !peer.handshake)
          peer = await this._peerForContact(contact);

        result.push({contact, peer});
      } catch (e) {
        this.emit('discovery failure', e, contact);
      }
    }

    if (result.length === 0)
      throw new Error('HNSR iterative lookup found no live rendezvous peers.');

    return result;
  }

  _createRoute(tickets, options = {}) {
    assert(Array.isArray(tickets) && tickets.length > 0);

    const timestamp = now();
    const expiresAt = Math.min(
      timestamp + (options.lifetime || 900),
      ...tickets.map(ticket => ticket.expiresAt));
    const endpointSequence = options.endpointSequence
      || ++this.endpointSequence;
    const sequence = options.sequence || ++this.routeSequence;
    const delegation = new EndpointDelegation({
      endpointKey: this.publicKey,
      sequence: endpointSequence,
      issuedAt: timestamp,
      expiresAt,
      maxActiveCircuits: Math.min(
        ...tickets.map(ticket => ticket.maxActiveCircuits)),
      maxBytesPerCircuit: Math.min(
        ...tickets.map(ticket => ticket.maxBytesPerCircuit))
    }).sign(this.network.magic, this.identityKey);
    const key = routeKey(this.network.magic, this.publicKey);
    const record = new RouteRecord({
      routeKey: key,
      profile: profiles.HNS_NODE_V1,
      sequence,
      issuedAt: timestamp,
      expiresAt,
      delegation,
      tickets
    }).sign(this.identityKey);

    if (record.encode().length > common.hnsr.MAX_RECORD_SIZE)
      throw new Error('HNSR route record exceeds the storage limit.');

    return record;
  }

  async _putRoute(peer, record) {
    const raw = record.encode();
    const bw = bio.write(34 + raw.length);
    bw.writeBytes(record.routeKey);
    bw.writeU16(raw.length);
    bw.writeBytes(raw);
    const result = await this._request(
      peer,
      opcodes.PUTROUTE,
      bw.render(),
      [opcodes.PUTRESULT]);
    const br = bio.read(result.body);
    const status = br.readU16();
    const storedUntil = br.readU64();
    finish(br, 'HNSR put result');

    if (status !== 0 || storedUntil !== record.expiresAt)
      throw new Error(`HNSR rendezvous store rejected route (${status}).`);

    return storedUntil;
  }

  async publish(peer, tickets, options = {}) {
    if (!this.enabled || !this.endpoint)
      throw new Error('HNSR endpoint role is disabled.');

    if (!(peer.services & common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE))
      throw new Error('Peer does not advertise the HNSR rendezvous role.');

    const record = this._createRoute(tickets, options);
    await this._putRoute(peer, record);
    return record;
  }

  async publishReplicated(bootstrap, tickets, options = {}) {
    if (!this.enabled || !this.endpoint)
      throw new Error('HNSR endpoint role is disabled.');

    const record = this._createRoute(tickets, options);
    const nodes = await this.findNodes(
      bootstrap,
      record.routeKey,
      options.replicas || common.hnsr.ROUTE_REPLICATION);
    const stored = [];
    const failures = [];

    await Promise.all(nodes.map(async ({contact, peer}) => {
      try {
        await this._putRoute(peer, record);
        stored.push(contact);
      } catch (e) {
        failures.push({contact, error: e});
      }
    }));

    const required = options.minimumStores
      || common.hnsr.MIN_ROUTE_STORES;

    if (stored.length < required) {
      throw new Error(
        `HNSR route replication quorum failed (${stored.length}/${required}).`);
    }

    return {record, stored, failures};
  }

  async republish(publication, tickets, bootstrap, options = {}) {
    const previous = publication.record || publication;

    if (!(previous instanceof RouteRecord))
      throw new Error('Invalid HNSR publication to refresh.');

    return this.publishReplicated(
      bootstrap,
      tickets,
      Object.assign({}, options, {
        sequence: previous.sequence + 1,
        endpointSequence: previous.delegation.sequence + 1
      }));
  }

  async lookup(peer, key, maximum = 16) {
    if (!this.enabled)
      throw new Error('HNSR is disabled.');

    if (!(peer.services & common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE))
      throw new Error('Peer does not advertise the HNSR rendezvous role.');

    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new Error('Invalid HNSR route key.');

    if (maximum < 1 || maximum > 16)
      throw new Error('Invalid HNSR route result limit.');

    const bw = bio.write(33);
    bw.writeBytes(key);
    bw.writeU8(maximum);
    const response = await this._request(
      peer,
      opcodes.GETROUTE,
      bw.render(),
      [opcodes.ROUTES]);
    const br = bio.read(response.body);
    const count = br.readU8();

    if (count > maximum)
      throw new Error('Too many HNSR route records returned.');

    const records = [];

    for (let i = 0; i < count; i++) {
      const size = br.readU16();

      if (size === 0 || size > common.hnsr.MAX_RECORD_SIZE)
        throw new Error('Invalid returned HNSR record length.');

      const record = RouteRecord.decode(br.readBytes(size));

      if (!record.routeKey.equals(key)
          || !record.verify(this.network.magic)) {
        throw new Error('Rendezvous peer returned an invalid HNSR record.');
      }

      records.push(record);
    }

    finish(br, 'HNSR routes response');
    return records;
  }

  async lookupReplicated(bootstrap, key, maximum = 16, options = {}) {
    const nodes = await this.findNodes(
      bootstrap,
      key,
      options.replicas || common.hnsr.ROUTE_REPLICATION);
    const failures = [];
    const records = new Map();

    await Promise.all(nodes.map(async ({contact, peer}) => {
      try {
        for (const record of await this.lookup(peer, key, maximum)) {
          const endpoint = record.delegation.endpointKey.toString('hex');
          const current = records.get(endpoint);

          if (!current || current.sequence < record.sequence)
            records.set(endpoint, record);
        }
      } catch (e) {
        failures.push({contact, error: e});
      }
    }));

    const result = Array.from(records.values())
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, maximum);

    return {
      records: result,
      queried: nodes.map(item => item.contact),
      failures
    };
  }

  async sampleRoutes(bootstrap, maximum = 16) {
    if (maximum < 1 || maximum > 16)
      throw new Error('Invalid HNSR sample result limit.');

    const seed = random.randomBytes(32);
    const target = hash(domains.SAMPLE, seed);
    const nodes = await this.findNodes(bootstrap, target, 3);
    const records = new Map();
    const failures = [];

    await Promise.all(nodes.map(async ({contact, peer}) => {
      const bw = bio.write(33);
      bw.writeU8(maximum);
      bw.writeBytes(seed);

      try {
        const response = await this._request(
          peer,
          opcodes.SAMPLEROUTES,
          bw.render(),
          [opcodes.ROUTES]);
        const br = bio.read(response.body);
        const count = br.readU8();

        if (count > maximum)
          throw new Error('Too many sampled HNSR routes returned.');

        for (let i = 0; i < count; i++) {
          const size = br.readU16();

          if (size === 0 || size > common.hnsr.MAX_RECORD_SIZE)
            throw new Error('Invalid sampled HNSR route length.');

          const record = RouteRecord.decode(br.readBytes(size));

          if (!record.verify(this.network.magic))
            throw new Error('Invalid sampled HNSR route.');

          const key = record.routeKey.toString('hex');
          const current = records.get(key);

          if (!current || current.sequence < record.sequence)
            records.set(key, record);
        }

        finish(br, 'HNSR sampled routes response');
      } catch (e) {
        failures.push({contact, error: e});
      }
    }));

    return {
      records: Array.from(records.values()).slice(0, maximum),
      queried: nodes.map(item => item.contact),
      failures
    };
  }

  async openRoute(record, options = {}) {
    if (!(record instanceof RouteRecord)
        || !record.verify(this.network.magic)) {
      throw new Error('Invalid HNSR route record.');
    }

    if (!this.pool)
      throw new Error('HNSR route opening requires a peer pool.');

    const failures = [];

    for (const ticket of record.tickets) {
      try {
        const peer = await this.pool.connectHNSRTicket(ticket);
        const circuit = await this.openCircuit(peer, ticket, options);
        return {ticket, relayPeer: peer, failures, ...circuit};
      } catch (e) {
        failures.push({ticket, error: e});
      }
    }

    const err = new Error('All HNSR relay candidates failed.');
    err.failures = failures;
    throw err;
  }

  async openPeer(record, options = {}) {
    const circuit = await this.openRoute(record, options);
    const peer = await this.pool.addHNSROutbound(
      circuit.socket,
      circuit.ticket.endpointKey,
      circuit);
    return {peer, ...circuit};
  }

  async openCircuit(peer, ticket, options = {}) {
    if (!this.enabled)
      throw new Error('HNSR is disabled.');

    if (!(peer.services & common.EXPERIMENTAL_HNSR_RELAY_SERVICE))
      throw new Error('Peer does not advertise the HNSR relay role.');

    if (!ticket.verify(this.network.magic))
      throw new Error('Invalid or expired HNSR relay ticket.');

    const window = options.window || common.hnsr.DEFAULT_WINDOW;

    if (window < common.hnsr.MIN_WINDOW || window > common.hnsr.MAX_WINDOW)
      throw new Error('Invalid HNSR initial window.');

    const bw = bio.write(103);
    bw.writeBytes(ticket.id());
    bw.writeBytes(ticket.reservationID);
    bw.writeBytes(ticket.endpointKey);
    bw.writeU16(ticket.profile);
    bw.writeBytes(randomID(16));
    bw.writeU32(window);
    const response = await this._request(
      peer,
      opcodes.OPEN,
      bw.render(),
      [opcodes.OPENED]);
    const br = bio.read(response.body);
    const circuitID = br.readBytes(8);
    const acceptedWindow = br.readU32();
    const endpointNonce = br.readBytes(16);
    finish(br, 'HNSR opened response');

    if (isZero(circuitID)
        || isZero(endpointNonce)
        || acceptedWindow < common.hnsr.MIN_WINDOW
        || acceptedWindow > window) {
      throw new Error('Invalid HNSR opened response.');
    }

    const socket = new CircuitSocket(this, peer, circuitID, acceptedWindow);
    this.sockets.set(peerKey(peer, circuitID), socket);
    setImmediate(() => socket.connect());

    return {socket, circuitID, endpointNonce};
  }

  _handleReserve(peer, packet, renewal) {
    if (!this.relay)
      throw new Error('HNSR relay role is disabled.');

    let previous = null;
    let body = packet.body;

    if (renewal) {
      const br = bio.read(packet.body);
      const reservationID = br.readBytes(16);
      body = br.readBytes(br.left());
      previous = this.reservations.get(reservationID.toString('hex'));

      if (!previous
          || previous.peer !== peer
          || previous.ticket.expiresAt <= now()) {
        throw new Error('Unknown HNSR reservation to renew.');
      }
    }

    const request = ReserveRequest.decode(body);

    const validSignature = renewal
      ? request.verifyRenewal(
        this.network.magic,
        this.publicKey,
        packet.contextID,
        previous.ticket.reservationID)
      : request.verify(
        this.network.magic,
        this.publicKey,
        packet.contextID);

    if (!validSignature) {
      throw new Error('Invalid HNSR reservation signature.');
    }

    if (request.profile !== profiles.HNS_NODE_V1
        || request.lifetime < 300
        || request.lifetime > common.hnsr.MAX_TICKET_LIFETIME
        || request.maxCircuits < 1
        || request.maxCircuits > common.hnsr.MAX_CIRCUITS
        || request.maxBytes < 1
        || request.maxBytes > 67108864) {
      throw new Error('HNSR reservation exceeds PoC policy.');
    }

    if (previous
        && !previous.ticket.endpointKey.equals(request.endpointKey)) {
      throw new Error('HNSR renewal endpoint key mismatch.');
    }

    const renewalAllowance = previous ? 1 : 0;
    const reservationCount = this.reservations.size + this.provisional.size;

    if (reservationCount
        >= common.hnsr.MAX_RESERVATIONS + renewalAllowance) {
      throw new Error('HNSR relay reservation capacity reached.');
    }

    let provisionalCount = 0;
    let peerCount = 0;

    for (const item of this.provisional.values()) {
      if (item.peer !== peer)
        continue;
      provisionalCount += 1;
      peerCount += 1;
    }

    for (const item of this.reservations.values()) {
      if (item.peer === peer)
        peerCount += 1;
    }

    if (provisionalCount >= 2)
      throw new Error('HNSR provisional reservation capacity reached.');

    if (peerCount
        >= common.hnsr.MAX_RESERVATIONS_PER_PEER + renewalAllowance) {
      throw new Error('HNSR per-peer reservation capacity reached.');
    }

    const timestamp = now();
    const ticket = new RelayTicket({
      networkMagic: this.network.magic,
      profile: request.profile,
      transport: 0,
      hostType: 1,
      host: this.relayHost,
      port: this.relayPort,
      relayKey: this.publicKey,
      endpointKey: request.endpointKey,
      reservationID: randomID(16),
      issuedAt: timestamp,
      expiresAt: timestamp + request.lifetime,
      maxActiveCircuits: request.maxCircuits,
      maxBytesPerCircuit: request.maxBytes,
      maxTotalBytes: request.maxBytes * request.maxCircuits,
      flags: 0
    }).signRelay(this.identityKey);
    const key = ticket.reservationID.toString('hex');

    this.provisional.set(key, {
      peer,
      ticket,
      replaces: previous ? previous.ticket.reservationID.toString('hex') : null
    });
    this._send(peer, opcodes.OFFER, packet.contextID, ticket.encode());
  }

  _handleConfirm(peer, packet) {
    if (!this.relay)
      throw new Error('HNSR relay role is disabled.');

    const br = bio.read(packet.body);
    const reservationID = br.readBytes(16);
    const endpointSignature = readSignature(br, 'reservation confirmation');
    finish(br, 'HNSR reservation confirmation');
    const key = reservationID.toString('hex');
    const item = this.provisional.get(key);

    if (!item || item.peer !== peer)
      throw new Error('Unknown HNSR provisional reservation.');

    const ticket = item.ticket;
    ticket.endpointSignature = endpointSignature;

    if (!ticket.verify(this.network.magic))
      throw new Error('Invalid HNSR endpoint confirmation.');

    this.provisional.delete(key);
    this.reservations.set(key, {
      peer,
      ticket,
      activeCircuits: 0,
      totalBytes: 0,
      retired: false
    });

    if (item.replaces) {
      const previous = this.reservations.get(item.replaces);

      if (previous)
        previous.retired = true;
    }

    const bw = bio.write(56);
    bw.writeBytes(ticket.reservationID);
    bw.writeBytes(ticket.id());
    bw.writeU64(ticket.expiresAt);
    this._send(peer, opcodes.CONFIRMED, packet.contextID, bw.render());
  }

  _handleFindNode(peer, packet) {
    if (!this.rendezvous)
      throw new Error('HNSR rendezvous role is disabled.');

    const br = bio.read(packet.body);
    const target = br.readBytes(32);
    const maximum = br.readU8();
    finish(br, 'HNSR find-node request');

    if (maximum < 1 || maximum > common.hnsr.MAX_CONTACTS)
      throw new Error('Invalid HNSR rendezvous result limit.');

    const contacts = this._closestContacts(target, maximum);
    const bw = bio.write(1 + contacts.length * 100);
    bw.writeU8(contacts.length);

    for (const contact of contacts)
      bw.writeBytes(contact.encode());

    this._send(peer, opcodes.NODES, packet.contextID, bw.render());
  }

  _sendRoutes(peer, contextID, records) {
    let size = 1;

    for (const raw of records)
      size += 2 + raw.length;

    if (size > common.hnsr.MAX_PACKET_SIZE - 12)
      throw new Error('HNSR routes response exceeds packet limit.');

    const bw = bio.write(size);
    bw.writeU8(records.length);

    for (const raw of records) {
      bw.writeU16(raw.length);
      bw.writeBytes(raw);
    }

    this._send(peer, opcodes.ROUTES, contextID, bw.render());
  }

  _handleSampleRoutes(peer, packet) {
    if (!this.rendezvous)
      throw new Error('HNSR rendezvous role is disabled.');

    const br = bio.read(packet.body);
    const maximum = br.readU8();
    const seed = br.readBytes(32);
    finish(br, 'HNSR sample-routes request');

    if (maximum < 1 || maximum > 16 || isZero(seed))
      throw new Error('Invalid HNSR sample-routes parameters.');

    this._sendRoutes(
      peer,
      packet.contextID,
      this.store.sample(maximum, seed));
  }

  _handleWithdraw(peer, packet) {
    if (!this.relay)
      throw new Error('HNSR relay role is disabled.');

    const br = bio.read(packet.body);
    const reservationID = br.readBytes(16);
    const ticketID = br.readBytes(32);
    const signature = readSignature(br, 'reservation withdrawal');
    finish(br, 'HNSR reservation withdrawal');
    const key = reservationID.toString('hex');
    const reservation = this.reservations.get(key);

    if (!reservation
        || reservation.peer !== peer
        || !reservation.ticket.id().equals(ticketID)
        || !verify(
          domains.WITHDRAW,
          withdrawData(
            this.network.magic,
            this.publicKey,
            packet.contextID,
            reservationID,
            ticketID),
          signature,
          reservation.ticket.endpointKey)) {
      throw new Error('Invalid HNSR reservation withdrawal.');
    }

    const states = new Set();

    for (const circuit of this.relayCircuits.values()) {
      if (circuit.state.reservation === reservation)
        states.add(circuit.state);
    }

    for (const state of states)
      this._closeRelayCircuit(state, errors.SHUTDOWN);

    this.reservations.delete(key);
    const bw = bio.write(56);
    bw.writeBytes(reservationID);
    bw.writeBytes(ticketID);
    bw.writeU64(0);
    this._send(peer, opcodes.CONFIRMED, packet.contextID, bw.render());
  }

  _handlePutRoute(peer, packet) {
    if (!this.rendezvous)
      throw new Error('HNSR rendezvous role is disabled.');

    const br = bio.read(packet.body);
    const key = br.readBytes(32);
    const size = br.readU16();

    if (size === 0 || size > common.hnsr.MAX_RECORD_SIZE || br.left() !== size)
      throw new Error('Invalid HNSR put-route length.');

    const raw = br.readBytes(size);
    let status = 0;
    let storedUntil = 0;

    try {
      const sourceKey = peerPublicKey(peer);
      const source = sourceKey
        ? sourceKey.toString('hex')
        : `peer:${peer.id}`;
      storedUntil = this.store.put(key, raw, now(), source);
    } catch (e) {
      status = errors.INVALID;
      this.emit('store reject', e, peer);
    }

    const bw = bio.write(10);
    bw.writeU16(status);
    bw.writeU64(storedUntil);
    this._send(peer, opcodes.PUTRESULT, packet.contextID, bw.render());
  }

  _handleGetRoute(peer, packet) {
    if (!this.rendezvous)
      throw new Error('HNSR rendezvous role is disabled.');

    const br = bio.read(packet.body);
    const key = br.readBytes(32);
    const maximum = br.readU8();
    finish(br, 'HNSR get-route request');

    if (maximum < 1 || maximum > 16)
      throw new Error('Invalid HNSR route result limit.');

    this._sendRoutes(
      peer,
      packet.contextID,
      this.store.get(key, maximum));
  }

  _handleOpen(peer, packet) {
    if (!this.relay)
      throw new Error('HNSR relay role is disabled.');

    const br = bio.read(packet.body);
    const ticketID = br.readBytes(32);
    const reservationID = br.readBytes(16);
    const endpointKey = br.readBytes(33);
    const profile = br.readU16();
    const requesterNonce = br.readBytes(16);
    const initialWindow = br.readU32();
    finish(br, 'HNSR open request');

    if (isZero(requesterNonce)
        || initialWindow < common.hnsr.MIN_WINDOW
        || initialWindow > common.hnsr.MAX_WINDOW) {
      throw new Error('Invalid HNSR open parameters.');
    }

    const reservation = this.reservations.get(
      reservationID.toString('hex'));

    if (!reservation
        || reservation.retired
        || reservation.ticket.expiresAt <= now()
        || !reservation.ticket.id().equals(ticketID)
        || !reservation.ticket.endpointKey.equals(endpointKey)
        || reservation.ticket.profile !== profile
        || reservation.activeCircuits
          >= reservation.ticket.maxActiveCircuits
        || reservation.peer.destroyed) {
      this._sendError(
        peer,
        packet.contextID,
        errors.ENDPOINT_GONE,
        'HNSR reservation is unavailable.');
      return;
    }

    const circuitID = randomID(8);
    const key = peerKey(reservation.peer, circuitID);
    const state = {
      requesterPeer: peer,
      requesterContext: Buffer.from(packet.contextID),
      endpointPeer: reservation.peer,
      circuitID,
      ticket: reservation.ticket,
      reservation,
      requesterNonce,
      initialWindow,
      totalBytes: 0,
      timer: null
    };

    state.timer = setTimeout(() => {
      this.opening.delete(key);
      this._sendError(
        peer,
        packet.contextID,
        errors.TIMEOUT,
        'HNSR endpoint did not accept the circuit.');
    }, 10000);

    this.opening.set(key, state);

    const bw = bio.write(62);
    bw.writeBytes(ticketID);
    bw.writeBytes(packet.contextID);
    bw.writeU16(profile);
    bw.writeBytes(requesterNonce);
    bw.writeU32(initialWindow);
    this._send(
      reservation.peer,
      opcodes.INCOMING,
      circuitID,
      bw.render());
  }

  _handleIncoming(peer, packet) {
    if (!this.endpoint)
      throw new Error('HNSR endpoint role is disabled.');

    const br = bio.read(packet.body);
    const ticketID = br.readBytes(32);
    const openRequestID = br.readBytes(8);
    const profile = br.readU16();
    const requesterNonce = br.readBytes(16);
    const initialWindow = br.readU32();
    finish(br, 'HNSR incoming request');
    const item = this.endpointTickets.get(ticketID.toString('hex'));

    if (!item
        || item.peer !== peer
        || item.ticket.profile !== profile
        || item.ticket.expiresAt <= now()
        || isZero(openRequestID)
        || isZero(requesterNonce)
        || initialWindow < common.hnsr.MIN_WINDOW
        || initialWindow > common.hnsr.MAX_WINDOW) {
      throw new Error('Invalid HNSR incoming circuit.');
    }

    const endpointNonce = randomID(16);
    const socket = new CircuitSocket(
      this,
      peer,
      packet.contextID,
      initialWindow);
    this.sockets.set(peerKey(peer, packet.contextID), socket);
    this.emit('circuit', socket, {
      circuitID: Buffer.from(packet.contextID),
      ticket: item.ticket,
      requesterNonce,
      endpointNonce,
      profile
    });

    const bw = bio.write(20);
    bw.writeU32(initialWindow);
    bw.writeBytes(endpointNonce);
    this._send(peer, opcodes.ACCEPT, packet.contextID, bw.render());
  }

  _handleAccept(peer, packet) {
    if (!this.relay)
      throw new Error('HNSR relay role is disabled.');

    const key = peerKey(peer, packet.contextID);
    const state = this.opening.get(key);

    if (!state || state.endpointPeer !== peer)
      throw new Error('Unknown HNSR pending circuit.');

    const br = bio.read(packet.body);
    const acceptedWindow = br.readU32();
    const endpointNonce = br.readBytes(16);
    finish(br, 'HNSR accept response');

    if (acceptedWindow < common.hnsr.MIN_WINDOW
        || acceptedWindow > state.initialWindow
        || isZero(endpointNonce)) {
      throw new Error('Invalid HNSR accept response.');
    }

    clearTimeout(state.timer);
    this.opening.delete(key);
    state.reservation.activeCircuits += 1;
    state.acceptedWindow = acceptedWindow;
    state.endpointNonce = endpointNonce;
    state.credit = {
      requester: acceptedWindow,
      endpoint: acceptedWindow
    };
    state.queuedBytes = 0;
    state.closed = false;
    this.relayCircuits.set(
      peerKey(state.requesterPeer, state.circuitID),
      {state, other: state.endpointPeer, side: 'requester'});
    this.relayCircuits.set(
      peerKey(state.endpointPeer, state.circuitID),
      {state, other: state.requesterPeer, side: 'endpoint'});

    const bw = bio.write(28);
    bw.writeBytes(state.circuitID);
    bw.writeU32(acceptedWindow);
    bw.writeBytes(endpointNonce);
    this._send(
      state.requesterPeer,
      opcodes.OPENED,
      state.requesterContext,
      bw.render());
  }

  _handleData(peer, packet) {
    if (packet.body.length === 0
        || packet.body.length > common.hnsr.MAX_DATA_SIZE) {
      throw new Error('Invalid HNSR DATA size.');
    }

    const key = peerKey(peer, packet.contextID);
    const circuit = this.relayCircuits.get(key);

    if (circuit) {
      if (packet.body.length > circuit.state.credit[circuit.side]) {
        this._closeRelayCircuit(circuit.state, errors.FLOW_CONTROL);
        return;
      }

      circuit.state.credit[circuit.side] -= packet.body.length;
      circuit.state.totalBytes += packet.body.length;
      circuit.state.reservation.totalBytes += packet.body.length;

      if (circuit.state.totalBytes
          > circuit.state.ticket.maxBytesPerCircuit
          || circuit.state.reservation.totalBytes
          > circuit.state.ticket.maxTotalBytes) {
        this._closeRelayCircuit(circuit.state, errors.BYTE_LIMIT);
        return;
      }

      this._queueRelayData(circuit, packet.body);
      return;
    }

    const socket = this.sockets.get(key);

    if (!socket)
      throw new Error('Unknown HNSR circuit DATA.');

    socket.receive(Buffer.from(packet.body));
  }

  _queueRelayData(circuit, data) {
    const state = circuit.state;

    if (state.closed)
      return;

    if (state.queuedBytes + data.length > common.hnsr.MAX_CIRCUIT_QUEUE) {
      this.relayDrops += 1;
      this._closeRelayCircuit(state, errors.CAPACITY);
      return;
    }

    if (this.relayQueueBytes + data.length > common.hnsr.MAX_RELAY_QUEUE) {
      this.relayDrops += 1;
      this._closeRelayCircuit(state, errors.CAPACITY);
      return;
    }

    const raw = Buffer.from(data);
    state.queuedBytes += raw.length;
    this.relayQueueBytes += raw.length;
    this.maxRelayQueuedBytes = Math.max(
      this.maxRelayQueuedBytes,
      this.relayQueueBytes);
    this.relayQueue.push({
      state,
      other: circuit.other,
      contextID: Buffer.from(state.circuitID),
      data: raw
    });
    this._scheduleRelayFlush();
  }

  _scheduleRelayFlush() {
    if (this.relayFlushScheduled || !this.opened)
      return;

    this.relayFlushScheduled = true;
    this.relayFlushHandle = setImmediate(() => {
      this.relayFlushHandle = null;
      this.relayFlushScheduled = false;
      this._flushRelayQueue();
    });
  }

  _flushRelayQueue() {
    let bytes = 0;

    this.relayFlushes += 1;

    while (this.relayQueue.length > 0) {
      const item = this.relayQueue[0];

      if (item.state.closed) {
        this.relayQueue.shift();
        this.relayQueueBytes -= item.data.length;
        continue;
      }

      if (bytes > 0 && bytes + item.data.length > common.hnsr.RELAY_BURST)
        break;

      this.relayQueue.shift();
      item.state.queuedBytes -= item.data.length;
      this.relayQueueBytes -= item.data.length;
      bytes += item.data.length;
      this.relayBytes += item.data.length;
      this.relayFrames += 1;

      if (this.relayPayloads.length < 128)
        this.relayPayloads.push(Buffer.from(item.data));

      this._send(
        item.other,
        opcodes.DATA,
        item.contextID,
        item.data);
    }

    if (this.relayQueue.length > 0)
      this._scheduleRelayFlush();
  }

  _handleWindow(peer, packet) {
    const br = bio.read(packet.body);
    const credit = br.readU32();
    finish(br, 'HNSR window update');

    if (credit === 0 || credit > common.hnsr.MAX_WINDOW)
      throw new Error('Invalid HNSR window credit.');

    const key = peerKey(peer, packet.contextID);
    const circuit = this.relayCircuits.get(key);

    if (circuit) {
      const side = circuit.side === 'requester' ? 'endpoint' : 'requester';

      if (circuit.state.credit[side] + credit > common.hnsr.MAX_WINDOW) {
        this._closeRelayCircuit(circuit.state, errors.FLOW_CONTROL);
        return;
      }

      circuit.state.credit[side] += credit;
      this._send(
        circuit.other,
        opcodes.WINDOW,
        packet.contextID,
        packet.body);
      return;
    }

    const socket = this.sockets.get(key);

    if (!socket)
      throw new Error('Unknown HNSR circuit window.');

    socket.addCredit(credit);
  }

  _handleClose(peer, packet) {
    const br = bio.read(packet.body);
    br.readU16();
    const size = br.readU8();

    if (size > 128)
      throw new Error('HNSR close detail exceeds the limit.');

    br.readBytes(size);
    finish(br, 'HNSR close');
    const key = peerKey(peer, packet.contextID);
    const circuit = this.relayCircuits.get(key);

    if (circuit) {
      this._send(
        circuit.other,
        opcodes.CLOSE,
        packet.contextID,
        packet.body);
      this._dropRelayCircuit(circuit.state);
      return;
    }

    const socket = this.sockets.get(key);

    if (socket) {
      this.sockets.delete(key);
      socket.remoteClose();
    }
  }

  _closeRelayCircuit(state, reason) {
    const bw = bio.write(3);
    bw.writeU16(reason);
    bw.writeU8(0);
    const body = bw.render();
    this._send(state.requesterPeer, opcodes.CLOSE, state.circuitID, body);
    this._send(state.endpointPeer, opcodes.CLOSE, state.circuitID, body);
    this._dropRelayCircuit(state);
  }

  _dropRelayCircuit(state) {
    state.closed = true;
    this.relayCircuits.delete(peerKey(state.requesterPeer, state.circuitID));
    this.relayCircuits.delete(peerKey(state.endpointPeer, state.circuitID));

    if (state.queuedBytes > 0) {
      const retained = [];

      for (const item of this.relayQueue) {
        if (item.state === state)
          this.relayQueueBytes -= item.data.length;
        else
          retained.push(item);
      }

      this.relayQueue = retained;
      state.queuedBytes = 0;
    }

    if (state.reservation.activeCircuits > 0)
      state.reservation.activeCircuits -= 1;
  }

  _dropSocket(peer, contextID) {
    this.sockets.delete(peerKey(peer, contextID));
  }

  cancelPeer(peer) {
    const prefix = `${peer.id}:`;

    this.admission.delete(peer.id);

    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix))
        continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('HNSR peer disconnected.'));
      this.pending.delete(key);
    }

    for (const [key, item] of this.provisional) {
      if (item.peer === peer)
        this.provisional.delete(key);
    }

    for (const [key, item] of this.reservations) {
      if (item.peer === peer)
        this.reservations.delete(key);
    }

    for (const [key, item] of this.endpointTickets) {
      if (item.peer === peer)
        this.endpointTickets.delete(key);
    }

    for (const [key, state] of this.opening) {
      if (state.requesterPeer !== peer && state.endpointPeer !== peer)
        continue;
      clearTimeout(state.timer);
      this.opening.delete(key);
    }

    const states = new Set();

    for (const circuit of this.relayCircuits.values()) {
      if (circuit.state.requesterPeer === peer
          || circuit.state.endpointPeer === peer) {
        states.add(circuit.state);
      }
    }

    for (const state of states)
      this._closeRelayCircuit(state, errors.ENDPOINT_GONE);

    for (const [key, socket] of this.sockets) {
      if (!key.startsWith(prefix))
        continue;
      this.sockets.delete(key);
      socket.remoteClose();
    }
  }
}

exports.opcodes = opcodes;
exports.errors = errors;
exports.profiles = profiles;
exports.routeKey = routeKey;
exports.rendezvousNodeID = rendezvousNodeID;
exports.compareDistance = compareDistance;
exports.RendezvousContact = RendezvousContact;
exports.ReserveRequest = ReserveRequest;
exports.RelayTicket = RelayTicket;
exports.EndpointDelegation = EndpointDelegation;
exports.RouteRecord = RouteRecord;
exports.RouteStore = RouteStore;
exports.CircuitSocket = CircuitSocket;
exports.HNSRService = HNSRService;
