'use strict';

const assert = require('bsert');
const fs = require('fs');
const path = require('path');
const secp256k1 = require('bcrypto/lib/secp256k1');
const common = require('../lib/net/common');
const packets = require('../lib/net/packets');
const Network = require('../lib/protocol/network');
const {
  ODoHCrypto,
  ODoHService,
  TargetConfigRecord,
  createLocator,
  encodeLocator,
  decodeLocator,
  encodePlaintext,
  decodePlaintext,
  encodeConfigs,
  decodeConfigs,
  decodeConfigList,
  encodeConfigContents,
  deriveKeyID,
  deriveResponseSecrets,
  encodeCaps,
  decodeCaps,
  encodeGetConfig,
  decodeGetConfig,
  encodeClientQuery,
  decodeClientQuery,
  encodeTargetQuery,
  decodeTargetQuery,
  encodeResponse,
  decodeResponse,
  encodeError,
  decodeError,
  validateDNSResponse
} = require('../lib/net/odoh');

const opcodes = common.odohOpcodes;
const roles = common.odohRoles;
const network = Network.get('regtest');
const QUERY = Buffer.from(
  '123401100001000000000001037777770972656c6179746573740000010001'
  + '00002904d0000080000000',
  'hex');
const RESPONSE = Buffer.from(
  '123481b00001000100000001037777770972656c6179746573740000010001'
  + 'c00c000100010000003c0004c000020100002904d0000080000000',
  'hex');
const VECTORS = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'data', 'odoh-v1-vectors.json'),
  'utf8'));

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

class FakePeerList {
  constructor() {
    this.first = null;
  }

  add(peer) {
    peer.next = this.first;
    this.first = peer;
  }

  head() {
    return this.first;
  }
}

class FakePool {
  constructor() {
    this.peers = new FakePeerList();
  }
}

class FakePeer {
  constructor(options) {
    this.handshake = true;
    this.destroyed = false;
    this.outbound = Boolean(options.outbound);
    this.services = options.services >>> 0;
    this.localServices = options.localServices >>> 0;
    this.address = {
      host: options.host,
      port: options.port,
      key: options.key || Buffer.alloc(33)
    };
    this.remote = null;
    this.remoteService = null;
    this.sent = [];
    this.next = null;
  }

  send(packet) {
    this.sent.push(packet);
    const raw = packet.encode();
    const decoded = packets.decode(packet.rawType, raw);
    setImmediate(() => {
      this.remoteService.handle(this.remote, decoded).catch(() => {});
    });
  }

  hostname() {
    return `${this.address.host}:${this.address.port}`;
  }
}

function connect(aService, bService, aOptions, bOptions) {
  const a = new FakePeer(aOptions);
  const b = new FakePeer(bOptions);
  a.remote = b;
  b.remote = a;
  a.remoteService = bService;
  b.remoteService = aService;
  return {a, b};
}

class FakeDNSRelay {
  constructor() {
    this.requests = [];
  }

  isReady() {
    return true;
  }

  handle(peer, packet) {
    this.requests.push(Buffer.from(packet.query));
    peer.send(new packets.DNSRelayPacket(
      packet.requestID,
      common.dnsRelayStatus.OK,
      RESPONSE));
    return Promise.resolve(true);
  }

  cancelPeer() {}
}

describe('P2P ODoH', function() {
  this.timeout(10000);

  describe('wire codecs', function() {
    const identity = secp256k1.privateKeyGenerate();
    const publicKey = secp256k1.publicKeyCreate(identity);
    const locator = createLocator('127.0.0.1', 14039, publicKey, true);

    it('should round trip the ODNS envelope', () => {
      const id = Buffer.from('0807060504030201', 'hex');
      const packet = new packets.ODNSPacket(
        opcodes.GETCAPS,
        id,
        Buffer.alloc(0));
      const decoded = packets.ODNSPacket.decode(packet.encode());
      assert.strictEqual(decoded.version, 1);
      assert.strictEqual(decoded.opcode, opcodes.GETCAPS);
      assert.bufferEqual(decoded.requestID, id);
      assert.strictEqual(decoded.body.length, 0);
    });

    it('should reject invalid ODNS envelopes', () => {
      const valid = new packets.ODNSPacket(
        opcodes.GETCAPS,
        Buffer.alloc(8, 1)).encode();
      const zero = Buffer.from(valid);
      zero.fill(0, 4, 12);
      assert.throws(() => packets.ODNSPacket.decode(zero), /zero/);

      const flags = Buffer.from(valid);
      flags.writeUInt16LE(1, 2);
      assert.throws(() => packets.ODNSPacket.decode(flags), /flags/);

      const version = Buffer.from(valid);
      version[0] = 2;
      assert.throws(() => packets.ODNSPacket.decode(version), /version/);

      assert.throws(
        () => packets.ODNSPacket.decode(valid.slice(0, 11)),
        /Truncated/);
    });

    it('should round trip locators and opcode bodies', () => {
      assert.bufferEqual(
        encodeLocator(decodeLocator(encodeLocator(locator), true)),
        encodeLocator(locator));

      const caps = decodeCaps(encodeCaps(roles.PROXY | roles.TARGET));
      assert.strictEqual(caps.roles, roles.PROXY | roles.TARGET);

      const getConfig = decodeGetConfig(
        encodeGetConfig(locator, true), true);
      assert.strictEqual(getConfig.allowCached, true);

      const configID = Buffer.alloc(32, 2);
      const message = Buffer.from('0100000001aa', 'hex');
      const client = decodeClientQuery(
        encodeClientQuery(locator, configID, message), true);
      assert.bufferEqual(client.configID, configID);
      assert.bufferEqual(client.message, message);

      const target = decodeTargetQuery(
        encodeTargetQuery(configID, message));
      assert.bufferEqual(target.message, message);

      const responseMessage = Buffer.from('0200000001aa', 'hex');
      assert.bufferEqual(
        decodeResponse(encodeResponse(responseMessage)).message,
        responseMessage);

      const error = decodeError(encodeError(common.odohStatus.BUSY, 2, 0));
      assert.strictEqual(error.status, common.odohStatus.BUSY);
      assert.strictEqual(error.retryAfter, 2);
    });

    it('should enforce all-zero plaintext padding', () => {
      const raw = encodePlaintext(QUERY, 128);
      assert.bufferEqual(decodePlaintext(raw).dns, QUERY);
      raw[raw.length - 1] = 1;
      assert.throws(() => decodePlaintext(raw), /padding/);
    });

    it('should reject private locators outside the regtest exception', () => {
      assert.throws(
        () => decodeLocator(encodeLocator(locator), false),
        /publicly routable/);
    });

    it('should validate DNS response correlation and recursive flags', () => {
      assert(validateDNSResponse(QUERY, RESPONSE));

      const wrongID = Buffer.from(RESPONSE);
      wrongID[1] ^= 1;
      assert.throws(
        () => validateDNSResponse(QUERY, wrongID),
        /identifier mismatch/);

      const wrongQuestion = Buffer.from(RESPONSE);
      wrongQuestion[28] = 28;
      assert.throws(
        () => validateDNSResponse(QUERY, wrongQuestion),
        /question mismatch/);

      const noRecursion = Buffer.from(RESPONSE);
      noRecursion[3] &= ~0x80;
      assert.throws(
        () => validateDNSResponse(QUERY, noRecursion),
        /response flags/);
    });
  });

  describe('RFC 9230 cryptography and target records', function() {
    it('should match the published deterministic profile vectors', () => {
      const input = VECTORS.inputs;
      const expected = VECTORS.expected;
      const identity = Buffer.from(input.targetIdentityPrivateKey, 'hex');
      const publicKey = Buffer.from(input.hpkePublicKey, 'hex');
      const locator = createLocator(
        input.targetHost,
        input.targetPort,
        Buffer.from(input.targetPeerKey, 'hex'),
        true);
      const contents = encodeConfigContents(publicKey);
      const configs = encodeConfigs(publicKey);
      const plaintext = encodePlaintext(
        Buffer.from(input.dnsQuery, 'hex'),
        128);
      const secrets = deriveResponseSecrets(
        Buffer.from(input.responseSecret, 'hex'),
        plaintext,
        Buffer.from(input.responseNonce, 'hex'));
      const record = new TargetConfigRecord({
        networkMagic: input.networkMagic,
        locator,
        sequence: input.sequence,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        odohConfigs: configs
      }).sign(identity);

      assert.strictEqual(encodeLocator(locator).toString('hex'),
        expected.locator);
      assert.strictEqual(contents.toString('hex'), expected.configContents);
      assert.strictEqual(configs.toString('hex'), expected.configs);
      assert.strictEqual(deriveKeyID(contents).toString('hex'),
        expected.keyID);
      assert.strictEqual(plaintext.toString('hex'), expected.queryPlaintext);
      assert.strictEqual(secrets.key.toString('hex'), expected.responseKey);
      assert.strictEqual(secrets.nonce.toString('hex'),
        expected.responseNonce);
      assert.strictEqual(record.raw.toString('hex'),
        expected.targetConfigRecord);
      assert.strictEqual(record.id.toString('hex'),
        expected.targetConfigRecordID);
    });

    it('should encrypt a query and response without proxy plaintext', async() => {
      const crypto = new ODoHCrypto();
      const pair = await crypto.generateKeyPair();
      const config = decodeConfigs(encodeConfigs(pair.publicKey));
      const query = await crypto.encryptQuery(config, QUERY);
      assert.strictEqual(query.message.includes(QUERY), false);

      const opened = await crypto.decryptQuery(pair.privateKey, query.message);
      assert.bufferEqual(opened.dns, QUERY);

      const response = await crypto.encryptResponse(
        opened.context,
        opened.plaintext,
        RESPONSE);
      assert.strictEqual(response.includes(RESPONSE), false);
      assert.bufferEqual(
        await crypto.decryptResponse(query, response),
        RESPONSE);
    });

    it('should fail closed with the wrong HPKE key', async() => {
      const crypto = new ODoHCrypto();
      const pair = await crypto.generateKeyPair();
      const wrong = await crypto.generateKeyPair();
      const config = decodeConfigs(encodeConfigs(pair.publicKey));
      const query = await crypto.encryptQuery(config, QUERY);
      await assert.rejects(
        crypto.decryptQuery(wrong.privateKey, query.message));
      await assert.rejects(
        crypto.decryptQuery(
          pair.privateKey,
          query.message,
          wrong.publicKey),
        /key identifier/);
    });

    it('should sign, verify, and identify a canonical target record', async() => {
      const identity = secp256k1.privateKeyGenerate();
      const targetKey = secp256k1.publicKeyCreate(identity);
      const locator = createLocator('127.0.0.1', 14039, targetKey, true);
      const crypto = new ODoHCrypto();
      const pair = await crypto.generateKeyPair();
      const now = Math.floor(Date.now() / 1000);
      const record = new TargetConfigRecord({
        networkMagic: network.magic,
        locator,
        sequence: 1,
        issuedAt: now,
        expiresAt: now + 3600,
        odohConfigs: encodeConfigs(pair.publicKey)
      }).sign(identity);
      const decoded = TargetConfigRecord.decode(record.raw, true);
      assert(decoded.verify({
        networkMagic: network.magic,
        allowPrivate: true,
        now
      }));
      assert.bufferEqual(decoded.id, record.id);

      assert.throws(() => decoded.verify({
        networkMagic: network.magic ^ 1,
        allowPrivate: true,
        now
      }), /Wrong.*network/);

      assert.throws(() => decoded.verify({
        networkMagic: network.magic,
        allowPrivate: true,
        now: now + 3600
      }), /expired/);

      decoded.signature[decoded.signature.length - 1] ^= 1;
      assert.throws(() => decoded.verify({
        networkMagic: network.magic,
        allowPrivate: true,
        now
      }), /signature/);
    });
  });

  describe('three-peer service', function() {
    let requester;
    let proxy;
    let target;
    let requesterProxy;
    let proxyRequester;
    let proxyTarget;
    let targetProxy;
    let targetIdentity;
    let relay;

    beforeEach(async() => {
      const requesterPool = new FakePool();
      const proxyPool = new FakePool();
      const targetPool = new FakePool();
      const requesterIdentity = secp256k1.privateKeyGenerate();
      const proxyIdentity = secp256k1.privateKeyGenerate();
      targetIdentity = secp256k1.privateKeyGenerate();
      relay = new FakeDNSRelay();

      requester = new ODoHService({
        pool: requesterPool,
        network,
        identityKey: requesterIdentity,
        allowPrivate: true
      });
      proxy = new ODoHService({
        pool: proxyPool,
        network,
        identityKey: proxyIdentity,
        proxy: true,
        allowPrivate: true,
        instrumentation: true
      });
      target = new ODoHService({
        pool: targetPool,
        network,
        identityKey: targetIdentity,
        dnsRelay: relay,
        target: true,
        allowPrivate: true,
        instrumentation: true,
        targetHost: '127.0.0.1',
        targetPort: 14039
      });

      await requester.open();
      await proxy.open();
      await target.open();

      const rp = connect(requester, proxy, {
        outbound: true,
        services: common.EXPERIMENTAL_ODOH_SERVICE,
        localServices: 0,
        host: '127.0.0.1',
        port: 14038,
        key: secp256k1.publicKeyCreate(proxyIdentity)
      }, {
        outbound: false,
        services: 0,
        localServices: common.EXPERIMENTAL_ODOH_SERVICE,
        host: '127.0.0.1',
        port: 40000
      });
      requesterProxy = rp.a;
      proxyRequester = rp.b;
      requesterPool.peers.add(requesterProxy);
      proxyPool.peers.add(proxyRequester);

      const pt = connect(proxy, target, {
        outbound: true,
        services: common.EXPERIMENTAL_ODOH_SERVICE
          | common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        localServices: common.EXPERIMENTAL_ODOH_SERVICE,
        host: '127.0.0.1',
        port: 14039,
        key: secp256k1.publicKeyCreate(targetIdentity)
      }, {
        outbound: false,
        services: common.EXPERIMENTAL_ODOH_SERVICE,
        localServices: common.EXPERIMENTAL_ODOH_SERVICE
          | common.EXPERIMENTAL_DNS_RELAY_SERVICE,
        host: '127.0.0.1',
        port: 40001
      });
      proxyTarget = pt.a;
      targetProxy = pt.b;
      proxyPool.peers.add(proxyTarget);
      targetPool.peers.add(targetProxy);
    });

    afterEach(async() => {
      await requester.close();
      await proxy.close();
      await target.close();
    });

    it('should complete an oblivious request through independent hop IDs',
      async() => {
        const locator = createLocator(
          '127.0.0.1',
          14039,
          secp256k1.publicKeyCreate(targetIdentity),
          true);
        let proxyView = null;
        let targetView = null;
        proxy.once('proxy query', (value) => {
          proxyView = value;
        });
        target.once('target query', (value) => {
          targetView = value;
        });

        const proxyCaps = await requester.getCapabilities(requesterProxy);
        assert(proxyCaps.roles & roles.PROXY);
        const record = await requester.getConfig(requesterProxy, locator);
        const response = await requester.query(
          requesterProxy, locator, record, QUERY);
        assert.bufferEqual(response, RESPONSE);
        assert.bufferEqual(relay.requests[0], QUERY);
        assert(proxyView);
        assert(targetView);
        assert.strictEqual(proxyView.ciphertext.includes(QUERY), false);
        assert.bufferEqual(targetView.dns, QUERY);
        assert.strictEqual(
          proxyView.clientRequestID.equals(targetView.targetRequestID),
          false);
        assert.strictEqual(proxy.getMetrics().proxyPlaintextBytes, 0);
      });

    it('should reject an exact ciphertext replay at the target', async() => {
      const locator = createLocator(
        '127.0.0.1',
        14039,
        secp256k1.publicKeyCreate(targetIdentity),
        true);
      const record = await requester.getConfig(requesterProxy, locator);
      await requester.query(requesterProxy, locator, record, QUERY);
      const sent = proxyTarget.sent.find(
        packet => packet.opcode === opcodes.TARGET_QUERY);
      assert(sent);

      await target.handle(targetProxy, new packets.ODNSPacket(
        opcodes.TARGET_QUERY,
        Buffer.alloc(8, 9),
        sent.body));
      await tick();
      assert.strictEqual(target.getMetrics().replays, 1);
    });

    it('should rotate keys while accepting an overlapping record', async() => {
      const locator = createLocator(
        '127.0.0.1',
        14039,
        secp256k1.publicKeyCreate(targetIdentity),
        true);
      const previous = await requester.getConfig(requesterProxy, locator);
      const now = Math.floor(Date.now() / 1000);

      assert(await target.rotateTargetKey(now, true));

      const current = await requester.getConfig(requesterProxy, locator);
      assert.strictEqual(current.sequence, previous.sequence + 1);
      assert.strictEqual(decodeConfigList(current.odohConfigs).length, 2);
      assert.bufferEqual(
        await requester.query(
          requesterProxy, locator, previous, QUERY),
        RESPONSE);
      assert.strictEqual(target.getMetrics().rotations, 2);
    });
  });
});
