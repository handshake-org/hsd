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
 *
 * We modify the LN handshake in the following way:
 *
 *   Definition: "elligator" -- an invertible algebraic
 *   function which maps a field element to a point. We use
 *   the _generalized_ definition here. Think tissue, not
 *   kleenex.
 *
 *   For better indistinguishability and censorship mitigation,
 *   we use an Elligator Squared construction as described by
 *   Tibouchi[1][2]. As Tibouchi notes, elligators are _more_
 *   useful on prime order curves. Any curve with torsion
 *   groups must necessarily be distinguishable, as public
 *   keys reside in the primary subgroup (though, this may
 *   not be true of the Ristretto encoding). An adversary
 *   can simply run the forward map and check whether the
 *   resulting point is in the primary subgroup.
 *
 *   We're in a unique position here, since we're already
 *   hell bent on using secp256k1 for compat with bitcoin,
 *   as opposed to something like ed25519. The fact that
 *   secp256k1 has a cofactor of 1 allows us to use a truly
 *   indistinguishable encoding.
 *
 *   The Elligator Squared construction is such that the
 *   sender must provide the receiver with two preimages
 *   (u, v) which map to a point via `f^2(u,v) -> f(u) + f(v)`
 *   where `f(u)` is the forward map. The inverse map f^2^-1(p)
 *   is more complex and involves a loop as well as random
 *   group element generation.
 *
 *   Performance may be a concern. Encoding a point requires
 *   16 inversions and 20 square roots on average (an average
 *   of 4 iterations of the elligator squared loop). This
 *   should be on the order of ~3-4 point multiplications.
 *   In the future, the inversions can likely be optimized
 *   and reduced if multiple iterations are attempted at
 *   once.
 *
 *   The forward map is cheaper, requiring only 6 square
 *   roots and 3 inversions. We can visualize this as decoding
 *   _nine_ compressed public keys instead of one.
 *
 *   We can potentially double the performance by moving to
 *   a curve which is 3-isogenous to secp256k1[3][4] (idea
 *   from [5]). This allows us to use the Simplified
 *   Shallue-Woestijne-Ulas map instead of the Shallue-van
 *   de Woestijne map, though, the sender may have to modify
 *   their private key before executing the actual ECDH (as
 *   their public key would be multiplied by 3 by the receiver).
 *
 *   All bets are off if the user is subjected to a more
 *   interactive attack, such as a honeypot/sybil attack,
 *   or a MITM. An attack like that will no doubt prove
 *   that this particular exchange of messages is that
 *   of an end-to-end encryption handshake. However, the
 *   construction is here to provide a mitigation against
 *   more passive attacks, like non-interactive packet
 *   inspection. A user in this situation has plausible
 *   deniability with regards to using cryptography over
 *   the wire.
 *
 *   We have an elligator squared implentation in both C and
 *   javascript[6][7].
 *
 *   [1] https://eprint.iacr.org/2014/043.pdf
 *   [2] https://www.di.ens.fr/~fouque/pub/latincrypt12.pdf
 *   [3] https://gist.github.com/chjj/09c447047d5d0b63afcbbbc484d2c882
 *   [4] https://github.com/bcoin-org/bcrypto/commit/aac4464
 *   [5] https://github.com/cfrg/draft-irtf-cfrg-hash-to-curve/issues/158
 *   [6] https://github.com/bcoin-org/bcrypto/blob/master/src/extra256k1/elligator.h
 *   [7] https://github.com/bcoin-org/bcrypto/blob/master/lib/js/elliptic.js
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const sha256 = require('bcrypto/lib/sha256');
const aead = require('bcrypto/lib/aead');
const hkdf = require('bcrypto/lib/hkdf');
const secp256k1 = require('bcrypto/lib/secp256k1');
const common = require('./common');

/*
 * Constants
 */

const ZERO_KEY = Buffer.alloc(32, 0x00);
const ZERO_PUB = Buffer.alloc(33, 0x00);
const EMPTY = Buffer.alloc(0);

const PROTOCOL_NAME = 'Noise_XK_secp256k1_ChaChaPoly_SHA256+SVDW_Squared';
const PROLOGUE = 'hns';
const ROTATION_INTERVAL = 1000;
const HEADER_SIZE = 20;
const ACT_ONE_SIZE = 80; // 64 + 16
const ACT_TWO_SIZE = 80; // 64 + 16
const ACT_THREE_SIZE = 65; // 33 + 16 + 16
const MAX_MESSAGE = common.MAX_MESSAGE + 9;

const ACT_NONE = 0;
const ACT_ONE = 1;
const ACT_TWO = 2;
const ACT_THREE = 3;
const ACT_DONE = 4;

/**
 * CipherState
 * @extends {EventEmitter}
 */

class CipherState extends EventEmitter {
  constructor() {
    super();
    this.nonce = 0;
    this.iv = Buffer.alloc(12, 0x00);
    this.key = ZERO_KEY; // secret key
    this.salt = ZERO_KEY;
  }

  update() {
    this.iv.writeUInt32LE(this.nonce, 4, true);
    return this.iv;
  }

  initKey(key) {
    assert(Buffer.isBuffer(key));
    this.key = key;
    this.nonce = 0;
    this.update();
    return this;
  }

  initSalt(key, salt) {
    assert(Buffer.isBuffer(salt));
    this.salt = salt;
    this.initKey(key);
    return this;
  }

  rotateKey() {
    const info = EMPTY;
    const old = this.key;
    const [salt, next] = expand(old, this.salt, info);

    this.salt = salt;
    this.initKey(next);

    return this;
  }

  encrypt(pt, ad) {
    const tag = aead.encrypt(this.key, this.iv, pt, ad);

    this.nonce += 1;
    this.update();

    if (this.nonce === ROTATION_INTERVAL)
      this.rotateKey();

    return tag;
  }

  decrypt(ct, tag, ad) {
    if (!aead.decrypt(this.key, this.iv, ct, tag, ad))
      return false;

    this.nonce += 1;
    this.update();

    if (this.nonce === ROTATION_INTERVAL)
      this.rotateKey();

    return true;
  }
}

/**
 * SymmetricState
 * @extends {CipherState}
 */

class SymmetricState extends CipherState {
  constructor() {
    super();
    this.chain = ZERO_KEY; // chaining key
    this.temp = ZERO_KEY; // temp key
    this.digest = ZERO_KEY; // handshake digest
  }

  initSymmetric(protocolName) {
    assert(typeof protocolName === 'string');

    const empty = ZERO_KEY;
    const proto = Buffer.from(protocolName, 'ascii');

    this.digest = sha256.digest(proto);
    this.chain = this.digest;
    this.initKey(empty);

    return this;
  }

  mixKey(input) {
    const info = EMPTY;
    const secret = input;
    const salt = this.chain;

    [this.chain, this.temp] = expand(secret, salt, info);

    this.initKey(this.temp);

    return this;
  }

  mixDigest(data, tag) {
    return sha256.multi(this.digest, data, tag);
  }

  mixHash(data, tag) {
    this.digest = this.mixDigest(data, tag);
    return this;
  }

  encryptHash(pt) {
    const tag = this.encrypt(pt, this.digest);
    this.mixHash(pt, tag);
    return tag;
  }

  decryptHash(ct, tag) {
    assert(Buffer.isBuffer(tag));

    const digest = this.mixDigest(ct, tag);

    if (!this.decrypt(ct, tag, this.digest))
      return false;

    this.digest = digest;

    return true;
  }
}

/**
 * HandshakeState
 * @extends {SymmetricState}
 */

class HandshakeState extends SymmetricState {
  constructor() {
    super();
    this.initiator = false;
    this.localStatic = ZERO_KEY;
    this.localEphemeral = ZERO_KEY;
    this.remoteStatic = ZERO_PUB;
    this.remoteEphemeral = ZERO_PUB;
    this.generateKey = () => secp256k1.privateKeyGenerate();
  }

  initState(initiator, prologue, localPub, remotePub) {
    assert(typeof initiator === 'boolean');
    assert(typeof prologue === 'string');
    assert(Buffer.isBuffer(localPub));
    assert(!remotePub || Buffer.isBuffer(remotePub));

    this.initiator = initiator;
    this.localStatic = localPub; // private
    this.remoteStatic = remotePub || ZERO_PUB;

    this.initSymmetric(PROTOCOL_NAME);
    this.mixHash(Buffer.from(prologue, 'ascii'));

    if (initiator) {
      this.mixHash(remotePub);
    } else {
      const pub = getPublic(localPub);
      this.mixHash(pub);
    }

    return this;
  }
}

/**
 * Brontide
 * @extends {HandshakeState}
 */

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

    const ephemeral = getPublic(this.localEphemeral);
    const uniform = secp256k1.publicKeyToHash(ephemeral);

    this.mixHash(ephemeral);

    // es
    const s = ecdh(this.remoteStatic, this.localEphemeral);

    this.mixKey(s);

    const tag = this.encryptHash(EMPTY);
    const actOne = Buffer.allocUnsafe(ACT_ONE_SIZE);

    uniform.copy(actOne, 0);
    tag.copy(actOne, 64);

    return actOne;
  }

  recvActOne(actOne) {
    assert(Buffer.isBuffer(actOne));

    if (actOne.length !== ACT_ONE_SIZE)
      throw new Error('Act one: bad size.');

    const u = actOne.slice(0, 64);
    const p = actOne.slice(64);
    const e = secp256k1.publicKeyFromHash(u);

    // e
    this.remoteEphemeral = e;
    this.mixHash(this.remoteEphemeral);

    // es
    const s = ecdh(this.remoteEphemeral, this.localStatic);

    this.mixKey(s);

    if (!this.decryptHash(EMPTY, p))
      throw new Error('Act one: bad tag.');

    return this;
  }

  genActTwo() {
    // e
    this.localEphemeral = this.generateKey();

    const ephemeral = getPublic(this.localEphemeral);
    const uniform = secp256k1.publicKeyToHash(ephemeral);

    this.mixHash(ephemeral);

    // ee
    const s = ecdh(this.remoteEphemeral, this.localEphemeral);

    this.mixKey(s);

    const tag = this.encryptHash(EMPTY);
    const actTwo = Buffer.allocUnsafe(ACT_TWO_SIZE);

    uniform.copy(actTwo, 0);
    tag.copy(actTwo, 64);

    return actTwo;
  }

  recvActTwo(actTwo) {
    assert(Buffer.isBuffer(actTwo));

    if (actTwo.length !== ACT_TWO_SIZE)
      throw new Error('Act two: bad size.');

    const u = actTwo.slice(0, 64);
    const p = actTwo.slice(64);
    const e = secp256k1.publicKeyFromHash(u);

    // e
    this.remoteEphemeral = e;
    this.mixHash(this.remoteEphemeral);

    // ee
    const s = ecdh(this.remoteEphemeral, this.localEphemeral);

    this.mixKey(s);

    if (!this.decryptHash(EMPTY, p))
      throw new Error('Act two: bad tag.');

    return this;
  }

  genActThree() {
    const ourPubkey = getPublic(this.localStatic);
    const tag1 = this.encryptHash(ourPubkey);
    const ct = ourPubkey;

    const s = ecdh(this.remoteEphemeral, this.localStatic);

    this.mixKey(s);

    const tag2 = this.encryptHash(EMPTY);
    const actThree = Buffer.allocUnsafe(ACT_THREE_SIZE);

    ct.copy(actThree, 0);
    tag1.copy(actThree, 33);
    tag2.copy(actThree, 49);

    this.split();

    return actThree;
  }

  recvActThree(actThree) {
    assert(Buffer.isBuffer(actThree));

    if (actThree.length !== ACT_THREE_SIZE)
      throw new Error('Act three: bad size.');

    const s1 = actThree.slice(0, 33);
    const p1 = actThree.slice(33, 49);

    const s2 = actThree.slice(49, 49);
    const p2 = actThree.slice(49, 65);

    // s
    if (!this.decryptHash(s1, p1))
      throw new Error('Act three: bad tag.');

    const remotePub = s1;

    this.remoteStatic = remotePub;

    // se
    const se = ecdh(this.remoteStatic, this.localEphemeral);

    this.mixKey(se);

    if (!this.decryptHash(s2, p2))
      throw new Error('Act three: bad tag.');

    this.split();

    return this;
  }

  split() {
    const [h1, h2] = expand(EMPTY, this.chain, EMPTY);

    if (this.initiator) {
      const sendKey = h1;
      this.sendCipher.initSalt(sendKey, this.chain);
      const recvKey = h2;
      this.recvCipher.initSalt(recvKey, this.chain);
    } else {
      const recvKey = h1;
      this.recvCipher.initSalt(recvKey, this.chain);
      const sendKey = h2;
      this.sendCipher.initSalt(sendKey, this.chain);
    }

    return this;
  }

  write(data) {
    assert(Buffer.isBuffer(data));
    assert(data.length <= 0xffff);

    const packet = Buffer.allocUnsafe(2 + 16 + data.length + 16);
    packet.writeUInt16BE(data.length, 0);
    data.copy(packet, 2 + 16);

    const len = packet.slice(0, 2);
    const ta1 = packet.slice(2, 18);
    const msg = packet.slice(18, 18 + data.length);
    const ta2 = packet.slice(18 + data.length, 18 + data.length + 16);

    const tag1 = this.sendCipher.encrypt(len);
    tag1.copy(ta1, 0);

    const tag2 = this.sendCipher.encrypt(msg);
    tag2.copy(ta2, 0);

    return packet;
  }

  read(packet) {
    assert(Buffer.isBuffer(packet));

    const len = packet.slice(0, 2);
    const ta1 = packet.slice(2, 18);

    if (!this.recvCipher.decrypt(len, ta1))
      throw new Error('Bad tag for header.');

    const size = len.readUInt16BE(0, true);
    assert(packet.length === 18 + size + 16);

    const msg = packet.slice(18, 18 + size);
    const ta2 = packet.slice(18 + size, 18 + size + 16);

    if (!this.recvCipher.decrypt(msg, ta2))
      throw new Error('Bad tag for message.');

    return msg;
  }
}

/**
 * BrontideStream
 * @extends {Brontide}
 */

class BrontideStream extends Brontide {
  constructor() {
    super();
    this.socket = null;
    this.state = ACT_NONE;
    this.pending = [];
    this.total = 0;
    this.waiting = 0;
    this.hasSize = false;
    this.buffer = [];
    this.onData = data => this.feed(data);
    this.onConnect = () => this.start();
  }

  accept(socket, ourKey) {
    assert(!this.socket);
    assert(socket);
    this.socket = socket;
    this.init(false, ourKey);
    this.socket.on('data', this.onData);
    this.start();
    return this;
  }

  connect(socket, ourKey, theirKey) {
    assert(!this.socket);
    assert(socket);
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
        setImmediate(() => {
          this.destroy();
          this.emit('error', e);
        });
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

    return this;
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
    assert(Buffer.isBuffer(data));

    if (this.state === ACT_NONE)
      return false;

    if (this.state !== ACT_DONE) {
      this.buffer.push(data);
      return false;
    }

    assert(data.length <= 0xffffffff);

    const len = Buffer.allocUnsafe(4);
    len.writeUInt32LE(data.length, 0);

    let r = 1;

    const tag1 = this.sendCipher.encrypt(len);

    r &= this.socket.write(len);
    r &= this.socket.write(tag1);

    const tag2 = this.sendCipher.encrypt(data);

    r &= this.socket.write(data);
    r &= this.socket.write(tag2);

    return Boolean(r);
  }

  feed(data) {
    assert(Buffer.isBuffer(data));

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
    assert((size >>> 0) === size);
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
    assert(Buffer.isBuffer(data));

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

      const len = data.slice(0, 4);
      const tag = data.slice(4, 20);

      if (!this.recvCipher.decrypt(len, tag))
        throw new Error('Bad tag for header.');

      const size = len.readUInt32LE(0, true);

      if (size > MAX_MESSAGE)
        throw new Error('Bad packet size.');

      this.hasSize = true;
      this.waiting = size + 16;

      return;
    }

    const payload = data.slice(0, this.waiting - 16);
    const tag = data.slice(this.waiting - 16, this.waiting);

    this.hasSize = false;
    this.waiting = HEADER_SIZE;

    if (!this.recvCipher.decrypt(payload, tag))
      throw new Error('Bad tag for message.');

    this.emit('data', payload);
  }

  static fromInbound(socket, ourKey) {
    return new BrontideStream().accept(socket, ourKey);
  }

  static fromOutbound(socket, ourKey, theirKey) {
    return new BrontideStream().connect(socket, ourKey, theirKey);
  }
}

/*
 * Helpers
 */

function ecdh(publicKey, privateKey) {
  const secret = secp256k1.derive(publicKey, privateKey, true);
  return sha256.digest(secret);
}

function getPublic(priv) {
  return secp256k1.publicKeyCreate(priv, true);
}

function expand(secret, salt, info) {
  const prk = hkdf.extract(sha256, secret, salt);
  const out = hkdf.expand(sha256, prk, info, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/*
 * Expose
 */

exports.CipherState = CipherState;
exports.SymmetricState = SymmetricState;
exports.HandshakeState = HandshakeState;
exports.Brontide = Brontide;
exports.BrontideStream = BrontideStream;
