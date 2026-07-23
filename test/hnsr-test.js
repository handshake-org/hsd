'use strict';

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const FullNode = require('../lib/node/fullnode');
const Network = require('../lib/protocol/network');
const common = require('../lib/net/common');
const packets = require('../lib/net/packets');
const {
  ReserveRequest,
  RelayTicket,
  EndpointDelegation,
  RouteRecord,
  RouteStore,
  RendezvousContact,
  CircuitSocket,
  rendezvousNodeID,
  compareDistance,
  opcodes,
  routeKey
} = require('../lib/net/hnsr');

const network = Network.get('regtest');
const ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function writeBig(value, size) {
  const hex = value.toString(16).padStart(size * 2, '0');
  return Buffer.from(hex, 'hex');
}

function highS(signature) {
  const raw = secp256k1.signatureImport(signature);
  const low = BigInt(`0x${raw.slice(32).toString('hex')}`);
  writeBig(ORDER - low, 32).copy(raw, 32);
  return secp256k1.signatureExport(raw);
}

function fixture(timestamp = Math.floor(Date.now() / 1000), sequence = 1) {
  const endpointPrivate = secp256k1.privateKeyGenerate();
  const endpointKey = secp256k1.publicKeyCreate(endpointPrivate, true);
  const relayPrivate = secp256k1.privateKeyGenerate();
  const relayKey = secp256k1.publicKeyCreate(relayPrivate, true);
  const ticket = new RelayTicket({
    networkMagic: network.magic,
    profile: 1,
    transport: 0,
    hostType: 1,
    host: Buffer.alloc(16),
    port: network.brontidePort,
    relayKey,
    endpointKey,
    reservationID: Buffer.alloc(16, 0x01),
    issuedAt: timestamp,
    expiresAt: timestamp + 1800,
    maxActiveCircuits: 8,
    maxBytesPerCircuit: 1048576,
    maxTotalBytes: 8388608
  }).signRelay(relayPrivate).signEndpoint(endpointPrivate);
  const delegation = new EndpointDelegation({
    endpointKey,
    sequence,
    issuedAt: timestamp,
    expiresAt: timestamp + 900,
    maxActiveCircuits: 8,
    maxBytesPerCircuit: 1048576
  }).sign(network.magic, endpointPrivate);
  const key = routeKey(network.magic, endpointKey);
  const record = new RouteRecord({
    routeKey: key,
    sequence,
    issuedAt: timestamp,
    expiresAt: timestamp + 900,
    delegation,
    tickets: [ticket]
  }).sign(endpointPrivate);

  return {
    endpointPrivate,
    endpointKey,
    relayPrivate,
    relayKey,
    ticket,
    delegation,
    key,
    record,
    timestamp
  };
}

describe('HNSR', function() {
  it('should round trip the private HNSR envelope', () => {
    const context = Buffer.from('0102030405060708', 'hex');
    const body = Buffer.from('deadbeef', 'hex');
    const packet = new packets.HNSRPacket(1, 17, context, body);
    const decoded = packets.decode(packet.type, packet.encode());

    assert.strictEqual(decoded.version, 1);
    assert.strictEqual(decoded.opcode, 17);
    assert(decoded.contextID.equals(context));
    assert(decoded.body.equals(body));
  });

  it('should reject malformed HNSR envelopes', () => {
    const context = Buffer.from('0102030405060708', 'hex');
    const packet = new packets.HNSRPacket(1, 17, context, Buffer.alloc(1));
    const raw = packet.encode();

    assert.throws(() => packets.decode(packet.type, raw.slice(0, 11)));

    const badVersion = Buffer.from(raw);
    badVersion[0] = 2;
    assert.throws(() => packets.decode(packet.type, badVersion));

    const flags = Buffer.from(raw);
    flags[2] = 1;
    assert.throws(() => packets.decode(packet.type, flags));

    const zero = Buffer.from(raw);
    zero.fill(0, 4, 12);
    assert.throws(() => packets.decode(packet.type, zero));

    const opcode = Buffer.from(raw);
    opcode[1] = 21;
    assert.throws(() => packets.decode(packet.type, opcode));
  });

  it('should bind a reservation to relay, network, and context', () => {
    const item = fixture();
    const context = Buffer.from('0102030405060708', 'hex');
    const request = new ReserveRequest({
      endpointKey: item.endpointKey,
      profile: 1,
      lifetime: 1800,
      maxCircuits: 8,
      maxBytes: 1048576,
      nonce: Buffer.alloc(16, 0x02)
    }).sign(
      network.magic,
      item.relayKey,
      context,
      item.endpointPrivate);
    const decoded = ReserveRequest.decode(request.encode());

    assert(decoded.verify(network.magic, item.relayKey, context));
    assert.strictEqual(
      decoded.verify(network.magic + 1, item.relayKey, context),
      false);
    assert.strictEqual(
      decoded.verify(network.magic, item.endpointKey, context),
      false);
    assert.strictEqual(
      decoded.verify(network.magic, item.relayKey, Buffer.alloc(8, 0x03)),
      false);
  });

  it('should bind a renewal to its previous reservation', () => {
    const item = fixture();
    const context = Buffer.from('0102030405060708', 'hex');
    const previous = Buffer.alloc(16, 0x04);
    const request = new ReserveRequest({
      endpointKey: item.endpointKey,
      profile: 1,
      lifetime: 1800,
      maxCircuits: 8,
      maxBytes: 1048576,
      nonce: Buffer.alloc(16, 0x05)
    }).signRenewal(
      network.magic,
      item.relayKey,
      context,
      previous,
      item.endpointPrivate);
    const decoded = ReserveRequest.decode(request.encode());

    assert(decoded.verifyRenewal(
      network.magic,
      item.relayKey,
      context,
      previous));
    assert.strictEqual(decoded.verifyRenewal(
      network.magic,
      item.relayKey,
      context,
      Buffer.alloc(16, 0x06)), false);
    assert.strictEqual(
      decoded.verify(network.magic, item.relayKey, context),
      false);
  });

  it('should round trip and authenticate a relay ticket', () => {
    const item = fixture();
    const decoded = RelayTicket.decode(item.ticket.encode());

    assert(decoded.verifyRelay());
    assert(decoded.verifyEndpoint());
    assert(decoded.verify(network.magic, item.timestamp));
    assert(decoded.id().equals(item.ticket.id()));

    decoded.endpointSignature[decoded.endpointSignature.length - 1] ^= 1;
    assert.strictEqual(decoded.verifyEndpoint(), false);
  });

  it('should reject a high-S ticket signature', () => {
    const item = fixture();
    item.ticket.relaySignature = highS(item.ticket.relaySignature);
    assert.strictEqual(secp256k1.isLowDER(item.ticket.relaySignature), false);
    assert.strictEqual(item.ticket.verifyRelay(), false);
  });

  it('should round trip an unnamed route authorization chain', () => {
    const item = fixture();
    const raw = item.record.encode();
    const decoded = RouteRecord.decode(raw);

    assert(raw.length <= common.hnsr.MAX_RECORD_SIZE);
    assert(decoded.verify(network.magic, item.timestamp));
    assert(decoded.routeKey.equals(item.key));
    assert(decoded.delegation.endpointKey.equals(item.endpointKey));
    assert(decoded.tickets[0].id().equals(item.ticket.id()));
  });

  it('should reject a route-key substitution', () => {
    const item = fixture();
    item.record.routeKey[0] ^= 1;
    item.record.sign(item.endpointPrivate);
    assert.strictEqual(item.record.verify(network.magic, item.timestamp), false);
  });

  it('should replace only increasing endpoint route sequences', () => {
    const item = fixture(1700000000, 1);
    const store = new RouteStore(network.magic, {
      maxRecords: 4,
      maxPerKey: 2
    });

    store.put(item.key, item.record.encode(), item.timestamp);
    assert.strictEqual(store.get(item.key, 16, item.timestamp).length, 1);
    assert.throws(() => {
      store.put(item.key, item.record.encode(), item.timestamp);
    }, /Stale HNSR route sequence/);

    item.record.sequence = 2;
    item.record.sign(item.endpointPrivate);
    store.put(item.key, item.record.encode(), item.timestamp);

    const records = store.get(item.key, 16, item.timestamp);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(RouteRecord.decode(records[0]).sequence, 2);
  });

  it('should expire rendezvous records without a withdrawal broadcast', () => {
    const item = fixture(1700000000);
    const store = new RouteStore(network.magic);
    store.put(item.key, item.record.encode(), item.timestamp);

    assert.strictEqual(
      store.get(item.key, 16, item.record.expiresAt).length,
      0);
    assert.strictEqual(store.size, 0);
  });

  it('should encode authenticated rendezvous contacts and XOR order', () => {
    const privateKey = secp256k1.privateKeyGenerate();
    const peerKey = secp256k1.publicKeyCreate(privateKey, true);
    const timestamp = 1700000000;
    const contact = new RendezvousContact({
      nodeID: rendezvousNodeID(network.magic, peerKey),
      hostType: 1,
      host: Buffer.from('00000000000000000000ffff7f000001', 'hex'),
      port: network.brontidePort,
      services: common.services.NETWORK
        | common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE,
      peerKey,
      observedAt: timestamp
    });
    const decoded = RendezvousContact.decode(contact.encode());

    assert.strictEqual(contact.encode().length, 100);
    assert(decoded.verify(network.magic, timestamp));
    assert(decoded.peerKey.equals(peerKey));
    assert.strictEqual(decoded.toAddress(network).host, '127.0.0.1');
    assert.strictEqual(decoded.toAddress(network).port, network.brontidePort);

    const target = Buffer.alloc(32);
    const near = Buffer.alloc(32);
    const far = Buffer.alloc(32);
    near[0] = 1;
    far[0] = 2;
    assert(compareDistance(near, far, target) < 0);
    assert(compareDistance(far, near, target) > 0);
  });

  it('should sample deterministically and enforce source quotas', () => {
    const timestamp = 1700000000;
    const first = fixture(timestamp, 1);
    const second = fixture(timestamp, 1);
    const store = new RouteStore(network.magic, {
      maxRecords: 4,
      maxPerKey: 2,
      maxPerPeer: 1
    });

    store.put(first.key, first.record.encode(), timestamp, 'peer-a');
    assert.throws(() => {
      store.put(second.key, second.record.encode(), timestamp, 'peer-a');
    }, /per-peer route capacity/);
    store.put(second.key, second.record.encode(), timestamp, 'peer-b');

    const seed = Buffer.alloc(32, 0x11);
    const sample = store.sample(2, seed, timestamp);
    const repeated = store.sample(2, seed, timestamp);

    assert.strictEqual(sample.length, 2);
    assert.bufferEqual(sample[0], repeated[0]);
    assert.bufferEqual(sample[1], repeated[1]);

    first.record.sequence = 2;
    first.record.sign(first.endpointPrivate);
    assert.throws(() => {
      store.put(first.key, first.record.encode(), timestamp, 'peer-b');
    }, /per-peer route capacity/);

    const retained = RouteRecord.decode(store.get(
      first.key,
      1,
      timestamp)[0]);
    assert.strictEqual(retained.sequence, 1);
  });

  it('should apply circuit backpressure and delayed window credit', async () => {
    const sent = [];
    const service = {
      _send(peer, opcode, contextID, body) {
        sent.push({peer, opcode, contextID, body});
        return true;
      },
      _dropSocket() {}
    };
    const peer = {id: 1};
    const contextID = Buffer.from('0102030405060708', 'hex');
    const socket = new CircuitSocket(
      service,
      peer,
      contextID,
      common.hnsr.MIN_WINDOW);
    const payload = Buffer.alloc(common.hnsr.MIN_WINDOW + 10, 0x22);

    assert.strictEqual(socket.write(payload), false);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].opcode, opcodes.DATA);
    assert.strictEqual(sent[0].body.length, common.hnsr.MIN_WINDOW);
    assert.strictEqual(socket.sendQueueBytes, 10);

    const drained = new Promise(resolve => socket.once('drain', resolve));
    socket.addCredit(10);
    await drained;
    assert.strictEqual(socket.sendQueueBytes, 0);
    assert.strictEqual(sent[1].body.length, 10);

    let received = null;
    socket.on('data', (data) => {
      received = data;
    });
    socket.pause();
    socket.receive(Buffer.from('aabb', 'hex'));
    assert.strictEqual(received, null);
    assert.strictEqual(sent.length, 2);
    socket.resume();
    assert.bufferEqual(received, Buffer.from('aabb', 'hex'));
    assert.strictEqual(sent[2].opcode, opcodes.WINDOW);
    assert.strictEqual(sent[2].body.readUInt32LE(0), 2);
  });

  it('should expose role bits only for configured regtest roles', () => {
    const node = new FullNode({
      network: 'regtest',
      memory: true,
      listen: true,
      noDns: true,
      experimentalHnsr: true,
      experimentalHnsrRelay: true,
      experimentalHnsrRendezvous: true
    });
    const expected = common.services.NETWORK
      | common.EXPERIMENTAL_HNSR_RELAY_SERVICE
      | common.EXPERIMENTAL_HNSR_RENDEZVOUS_SERVICE;

    assert.strictEqual(node.pool.options.services, expected);
  });

  it('should refuse the private assignment outside regtest', () => {
    assert.throws(() => new FullNode({
      network: 'main',
      memory: true,
      listen: true,
      noDns: true,
      experimentalHnsr: true,
      experimentalHnsrRelay: true
    }), /regtest-only/);
  });
});
