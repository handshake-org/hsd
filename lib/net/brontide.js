/*!
 * brontide.js - peer-to-peer communication encryption.
 * Copyright (c) 2018, Christopher Jeffrey (MIT License).
 *
 * Resources:
 *   https://github.com/lightningnetwork/lightning-rfc/blob/master/08-transport.md
 *
 * Parts of this software are based on LND:
 *   Copyright (C) 2015-2017 The Lightning Network Developers
 *   https://github.com/lightningnetwork/lnd/blob/master/brontide/noise.go
 *   https://github.com/lightningnetwork/lnd/blob/master/brontide/noise_test.go
 */

'use strict';

const assert = require('assert');
const bio = require('bufio');
const EventEmitter = require('events');
const sha256 = require('bcrypto/lib/sha256');
const Poly1305 = require('bcrypto/lib/poly1305');
const AEAD = require('bcrypto/lib/aead');
const hkdf = require('bcrypto/lib/hkdf');
const secp256k1 = require('bcrypto/lib/secp256k1');
const {encoding} = bio;

const ZERO_KEY = Buffer.alloc(32, 0x00);
const ZERO_PUB = Buffer.alloc(33, 0x00);
const ZERO_MAC = Buffer.alloc(16, 0x00);
const EMPTY = Buffer.alloc(0);

const PROTOCOL_NAME = 'Noise_XK_secp256k1_ChaChaPoly_SHA256';
const PROLOGUE = 'hsk';
const MAC_SIZE = 16;
const LENGTH_SIZE = 4;
const ROTATION_INTERVAL = 1000;
const VERSION = 0;
const HEADER_SIZE = 20;
const ACT_ONE_SIZE = 50;
const ACT_TWO_SIZE = 50;
const ACT_THREE_SIZE = 66;

const ACT_NONE = 0;
const ACT_ONE = 1;
const ACT_TWO = 2;
const ACT_THREE = 3;
const ACT_DONE = 4;

class CipherState extends EventEmitter {
  constructor() {
    super();
    this.nonce = 0;
    this.iv = Buffer.alloc(12, 0x00);
    this.secretKey = ZERO_KEY;
    this.salt = ZERO_KEY;
    this.tag = ZERO_MAC;
    this.cipher = new AEAD();
  }

  update() {
    this.iv.writeUInt32LE(this.nonce, 4, true);
    return this.iv;
  }

  initKey(key) {
    this.secretKey = key;
    this.nonce = 0;
    this.update();
  }

  initKeyWithSalt(salt, key) {
    this.salt = salt;
    this.initKey(key);
  }

  rotateKey() {
    const info = EMPTY;
    const oldKey = this.secretKey;
    const [h1, h2] = expand(sha256, oldKey, this.salt, info);
    this.salt = h1;
    const nextKey = h2;
    this.initKey(nextKey);
  }

  encrypt(ad, pt) {
    this.cipher.init(this.secretKey, this.iv);

    if (ad)
      this.cipher.aad(ad);

    this.cipher.encrypt(pt);
    this.tag = this.cipher.final();

    this.nonce += 1;
    this.update();

    if (this.nonce === ROTATION_INTERVAL)
      this.rotateKey();

    return pt;
  }

  decrypt(ad, ct) {
    this.cipher.init(this.secretKey, this.iv);

    if (ad)
      this.cipher.aad(ad);

    this.cipher.decrypt(ct);
    this.tag = this.cipher.final();

    this.nonce += 1;
    this.update();

    if (this.nonce === ROTATION_INTERVAL)
      this.rotateKey();

    return ct;
  }

  verify(tag) {
    return Poly1305.verify(this.tag, tag);
  }
}

class SymmetricState extends CipherState {
  constructor() {
    super();
    this.chainingKey = ZERO_KEY;
    this.tempKey = ZERO_KEY;
    this.handshakeDigest = ZERO_KEY;
  }

  initSymmetric(protocolName) {
    const empty = ZERO_KEY;
    const proto = Buffer.from(protocolName, 'ascii');

    this.handshakeDigest = sha256.digest(proto);
    this.chainingKey = this.handshakeDigest;
    this.initKey(empty);

    return this;
  }

  mixKey(input) {
    const info = EMPTY;
    const secret = input;
    const salt = this.chainingKey;

    const [h1, h2] = expand(sha256, secret, salt, info);

    this.chainingKey = h1;
    this.tempKey = h2;

    this.initKey(this.tempKey);
  }

  _mixHash(data, tag) {
    const ctx = sha256.hash();
    ctx.init();
    ctx.update(this.handshakeDigest);
    ctx.update(data);
    if (tag)
      ctx.update(tag);
    return ctx.final();
  }

  mixHash(data, tag) {
    this.handshakeDigest = this._mixHash(data, tag);
  }

  encryptAndHash(pt) {
    this.encrypt(this.handshakeDigest, pt);
    this.mixHash(pt, this.tag);
    return pt;
  }

  decryptAndHash(ct, tag) {
    const h = this._mixHash(ct, tag);
    this.decrypt(this.handshakeDigest, ct);
    this.handshakeDigest = h;
    return ct;
  }
}

class HandshakeState extends SymmetricState {
  constructor() {
    super();
    this.initiator = false;
    this.localStatic = ZERO_KEY;
    this.localEphemeral = ZERO_KEY;
    this.remoteStatic = ZERO_PUB;
    this.remoteEphemeral = ZERO_PUB;
    this.generateKey = () => secp256k1.generatePrivateKey();
  }

  initState(initiator, prologue, localPub, remotePub) {
    this.initiator = initiator;
    this.localStatic = localPub; // private
    this.remoteStatic = remotePub || ZERO_PUB;

    this.initSymmetric(PROTOCOL_NAME);
    this.mixHash(Buffer.from(prologue, 'ascii'));

    if (initiator) {
      this.mixHash(remotePub);
    } else {
      const pub = secp256k1.publicKeyCreate(localPub);
      this.mixHash(pub);
    }

    return this;
  }
}

class Brontide extends HandshakeState {
  constructor() {
    super();
    this.sendCipher = new CipherState();
    this.recvCipher = new CipherState();
  }

  init(initiator, localPub, remotePub) {
    return this.initState(initiator, PROLOGUE, localPub, remotePub);
  }

  genActOne() {
    // e
    this.localEphemeral = this.generateKey();

    const ephemeral = secp256k1.publicKeyCreate(this.localEphemeral);
    this.mixHash(ephemeral);

    // ec
    const s = ecdh(this.remoteStatic, this.localEphemeral);
    this.mixKey(s);

    this.encryptAndHash(EMPTY);

    const actOne = Buffer.allocUnsafe(ACT_ONE_SIZE);
    actOne[0] = VERSION;
    ephemeral.copy(actOne, 1);
    this.tag.copy(actOne, 34);

    return actOne;
  }

  recvActOne(actOne) {
    if (actOne.length !== ACT_ONE_SIZE)
      throw new Error('Act one: bad size.');

    if (actOne[0] !== VERSION)
      throw new Error('Act one: bad version.');

    const e = actOne.slice(1, 34);
    const p = actOne.slice(34);

    if (!secp256k1.publicKeyVerify(e))
      throw new Error('Act one: bad key.');

    // e
    this.remoteEphemeral = e;
    this.mixHash(this.remoteEphemeral);

    // es
    const s = ecdh(this.remoteEphemeral, this.localStatic);
    this.mixKey(s);

    this.decryptAndHash(EMPTY, p);

    if (!this.verify(p))
      throw new Error('Act one: bad tag.');

    return this;
  }

  genActTwo() {
    // e
    this.localEphemeral = this.generateKey();

    const ephemeral = secp256k1.publicKeyCreate(this.localEphemeral);
    this.mixHash(ephemeral);

    // ee
    const s = ecdh(this.remoteEphemeral, this.localEphemeral);
    this.mixKey(s);

    this.encryptAndHash(EMPTY);

    const actTwo = Buffer.allocUnsafe(ACT_TWO_SIZE);
    actTwo[0] = VERSION;
    ephemeral.copy(actTwo, 1);
    this.tag.copy(actTwo, 34);

    return actTwo;
  }

  recvActTwo(actTwo) {
    if (actTwo.length !== ACT_TWO_SIZE)
      throw new Error('Act two: bad size.');

    if (actTwo[0] !== VERSION)
      throw new Error('Act two: bad version.');

    const e = actTwo.slice(1, 34);
    const p = actTwo.slice(34);

    if (!secp256k1.publicKeyVerify(e))
      throw new Error('Act two: bad key.');

    // e
    this.remoteEphemeral = e;
    this.mixHash(this.remoteEphemeral);

    // ee
    const s = ecdh(this.remoteEphemeral, this.localEphemeral);
    this.mixKey(s);

    this.decryptAndHash(EMPTY, p);

    if (!this.verify(p))
      throw new Error('Act two: bad tag.');

    return this;
  }

  genActThree() {
    const ourPubkey = secp256k1.publicKeyCreate(this.localStatic);
    const ct = this.encryptAndHash(ourPubkey);
    const tag1 = this.tag;

    const s = ecdh(this.remoteEphemeral, this.localStatic);
    this.mixKey(s);

    this.encryptAndHash(EMPTY);
    const tag2 = this.tag;

    const actThree = Buffer.allocUnsafe(ACT_THREE_SIZE);
    actThree[0] = VERSION;
    ct.copy(actThree, 1);
    tag1.copy(actThree, 34);
    tag2.copy(actThree, 50);

    this.split();

    return actThree;
  }

  recvActThree(actThree) {
    if (actThree.length !== ACT_THREE_SIZE)
      throw new Error('Act three: bad size.');

    if (actThree[0] !== VERSION)
      throw new Error('Act three: bad version.');

    const s1 = actThree.slice(1, 34);
    const p1 = actThree.slice(34, 50);

    const s2 = actThree.slice(50, 50);
    const p2 = actThree.slice(50, 66);

    // s
    const remotePub = this.decryptAndHash(s1, p1);

    if (!this.verify(p1))
      throw new Error('Act three: bad tag.');

    if (!secp256k1.publicKeyVerify(remotePub))
      throw new Error('Act three: bad key.');

    this.remoteStatic = remotePub;

    // se
    const se = ecdh(this.remoteStatic, this.localEphemeral);
    this.mixKey(se);

    this.decryptAndHash(s2, p2);

    if (!this.verify(p2))
      throw new Error('Act three: bad tag.');

    this.split();

    return this;
  }

  split() {
    const [h1, h2] = expand(sha256, EMPTY, this.chainingKey, EMPTY);

    if (this.initiator) {
      const sendKey = h1;
      this.sendCipher.initKeyWithSalt(this.chainingKey, sendKey);
      const recvKey = h2;
      this.recvCipher.initKeyWithSalt(this.chainingKey, recvKey);
    } else {
      const recvKey = h1;
      this.recvCipher.initKeyWithSalt(this.chainingKey, recvKey);
      const sendKey = h2;
      this.sendCipher.initKeyWithSalt(this.chainingKey, sendKey);
    }

    return this;
  }

  write(data) {
    assert(data.length <= 0xffff);

    const packet = Buffer.allocUnsafe(2 + 16 + data.length + 16);
    packet.writeUInt16BE(data.length, 0);
    data.copy(packet, 2 + 16);

    const len = packet.slice(0, 2);
    const ta1 = packet.slice(2, 18);
    const msg = packet.slice(18, 18 + data.length);
    const ta2 = packet.slice(18 + data.length, 18 + data.length + 16);

    this.sendCipher.encrypt(null, len);
    this.sendCipher.tag.copy(ta1, 0);

    this.sendCipher.encrypt(null, msg);
    this.sendCipher.tag.copy(ta2, 0);

    return packet;
  }

  read(packet) {
    const len = packet.slice(0, 2);
    const ta1 = packet.slice(2, 18);

    this.recvCipher.decrypt(null, len);

    if (!this.recvCipher.verify(ta1))
      throw new Error('Bad tag for header.');

    const size = len.readUInt16BE(0, true);
    assert(packet.length === 18 + size + 16);

    const msg = packet.slice(18, 18 + size);
    const ta2 = packet.slice(18 + size, 18 + size + 16);

    this.recvCipher.decrypt(null, msg);

    if (!this.recvCipher.verify(ta2))
      throw new Error('Bad tag for message.');

    return msg;
  }
}

class BrontideSocket extends Brontide {
  constructor() {
    super();
    this.socket = null;
    this.state = ACT_NONE;
    this.pending = [];
    this.total = 0;
    this.waiting = 0;
    this.hasSize = false;
    this.buffer = [];
    this.onData = (data) => this.feed(data);
    this.onConnect = () => this.start();
  }

  accept(socket, ourKey) {
    assert(!this.socket);
    this.socket = socket;
    this.init(false, ourKey, null);
    this.socket.on('data', this.onData);
    this.start();
    return this;
  }

  connect(socket, ourKey, theirKey) {
    assert(!this.socket);
    this.socket = socket;
    this.init(true, ourKey, theirKey);
    this.socket.on('connect', this.onConnect);
    this.socket.on('data', this.onData);
    return this;
  }

  start() {
    if (this.initiator) {
      this.state = ACT_TWO;
      this.waiting = ACT_TWO_SIZE;
      try {
        this.socket.write(this.genActOne());
      } catch (e) {
        this.destroy();
        this.emit('error', e);
        return this;
      }
    } else {
      this.state = ACT_ONE;
      this.waiting = ACT_ONE_SIZE;
    }
    return this;
  }

  unleash() {
    assert(this.state === ACT_DONE);

    for (const buf of this.buffer)
      this.write(buf);

    this.buffer.length = 0;
  }

  destroy() {
    this.state = ACT_NONE;
    this.pending.length = 0;
    this.total = 0;
    this.waiting = 0;
    this.hasSize = false;
    this.buffer.length = 0;
    this.socket.removeListener('connect', this.onConnect);
    this.socket.removeListener('data', this.onData);
    return this;
  }

  write(data) {
    if (this.state === ACT_NONE)
      return false;

    if (this.state !== ACT_DONE) {
      this.buffer.push(data);
      return false;
    }

    assert(data.length <= 0xffffffff);

    const len = Buffer.allocUnsafe(4);
    len.writeUInt32LE(data.length, 0);

    let r = 0;

    this.sendCipher.encrypt(null, len);

    r |= !this.socket.write(len);
    r |= !this.socket.write(this.sendCipher.tag);

    this.sendCipher.encrypt(null, data);

    r |= !this.socket.write(data);
    r |= !this.socket.write(this.sendCipher.tag);

    return !r;
  }

  feed(data) {
    if (this.state === ACT_NONE)
      return;

    this.total += data.length;
    this.pending.push(data);

    while (this.total >= this.waiting) {
      const chunk = this.read(this.waiting);
      if (!this.parse(chunk))
        break;
    }
  }

  read(size) {
    assert(this.total >= size, 'Reading too much.');

    if (size === 0)
      return Buffer.alloc(0);

    const pending = this.pending[0];

    if (pending.length > size) {
      const chunk = pending.slice(0, size);
      this.pending[0] = pending.slice(size);
      this.total -= chunk.length;
      return chunk;
    }

    if (pending.length === size) {
      const chunk = this.pending.shift();
      this.total -= chunk.length;
      return chunk;
    }

    const chunk = Buffer.allocUnsafe(size);

    let off = 0;

    while (off < chunk.length) {
      const pending = this.pending[0];
      const len = pending.copy(chunk, off);
      if (len === pending.length)
        this.pending.shift();
      else
        this.pending[0] = pending.slice(len);
      off += len;
    }

    assert.strictEqual(off, chunk.length);

    this.total -= chunk.length;

    return chunk;
  }

  parse(data) {
    try {
      this._parse(data);
      return true;
    } catch (e) {
      this.destroy();
      this.emit('error', e);
      return false;
    }
  }

  _parse(data) {
    if (this.initiator) {
      switch (this.state) {
        case ACT_TWO:
          this.recvActTwo(data);
          this.socket.write(this.genActThree());
          this.state = ACT_DONE;
          this.waiting = HEADER_SIZE;
          this.unleash();
          this.emit('connect');
          return;
        default:
          assert(this.state === ACT_DONE);
          break;
      }
    } else {
      switch (this.state) {
        case ACT_ONE:
          this.recvActOne(data);
          this.socket.write(this.genActTwo());
          this.state = ACT_THREE;
          this.waiting = ACT_THREE_SIZE;
          return;
        case ACT_THREE:
          this.recvActThree(data);
          this.state = ACT_DONE;
          this.waiting = HEADER_SIZE;
          this.unleash();
          this.emit('connect');
          return;
        default:
          assert(this.state === ACT_DONE);
          break;
      }
    }

    if (!this.hasSize) {
      assert(this.waiting === HEADER_SIZE);
      assert(data.length === HEADER_SIZE);

      const s = data.slice(0, 4);
      const tag = data.slice(4, 20);

      this.recvCipher.decrypt(null, s);

      if (!this.recvCipher.verify(tag))
        throw new Error('Bad tag for header.');

      const size = s.readUInt32LE(0, true);

      if (size > (8 << 20))
        throw new Error('Bad packet size.');

      this.hasSize = true;
      this.waiting = size + 16;

      return;
    }

    const payload = data.slice(0, this.waiting - 16);
    const tag = data.slice(this.waiting - 16, this.waiting);

    this.hasSize = false;
    this.waiting = HEADER_SIZE;

    this.recvCipher.decrypt(null, payload);

    if (!this.recvCipher.verify(tag))
      throw new Error('Bad tag for message.');

    this.emit('data', payload);
  }

  static fromInbound(socket, ourKey) {
    return new BrontideSocket().accept(socket, ourKey);
  }

  static fromOutbound(socket, ourKey, theirKey) {
    return new BrontideSocket().connect(socket, ourKey, theirKey);
  }
}

/*
 * Helpers
 */

function ecdh(publicKey, privateKey) {
  const secret = secp256k1.ecdh(publicKey, privateKey);
  return sha256.digest(secret);
}

function expand(hash, secret, salt, info) {
  const prk = hkdf.extract(hash, secret, salt);
  const out = hkdf.expand(hash, prk, info, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/*
 * Expose
 */

exports.CipherState = CipherState;
exports.SymmetricState = SymmetricState;
exports.HandshakeState = HandshakeState;
exports.Brontide = Brontide;
exports.BrontideSocket = BrontideSocket;
