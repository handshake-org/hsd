#!/usr/bin/env node

'use strict';

const assert = require('bsert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secp256k1 = require('bcrypto/lib/secp256k1');
const sha256 = require('bcrypto/lib/sha256');
const FullNode = require('../lib/node/fullnode');
const NetAddress = require('../lib/net/netaddress');
const common = require('../lib/net/common');
const {createLocator, decodeConfigList} = require('../lib/net/odoh');

const QUERY = Buffer.from(
  '123401100001000000000001037777770972656c6179746573740000010001'
  + '00002904d0000080000000',
  'hex');
const RESPONSE = Buffer.from(
  '123481b00001000100000001037777770972656c6179746573740000010001'
  + 'c00c000100010000003c0004c000020100002904d0000080000000',
  'hex');

function waitForPeer(node, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onOpen = (peer) => {
      clearTimeout(timer);
      resolve(peer);
    };
    timer = setTimeout(() => {
      node.pool.removeListener('peer open', onOpen);
      reject(new Error('Timed out waiting for a regtest peer.'));
    }, timeout);
    node.pool.once('peer open', onOpen);
  });
}

function peerAddress(node, port) {
  return NetAddress.fromHost(
    '127.0.0.1',
    port,
    secp256k1.publicKeyCreate(node.identityKey),
    'regtest').hostname;
}

function nodeOptions(prefix, identityKey, ports, extra = {}) {
  return Object.assign({
    network: 'regtest',
    memory: false,
    prefix,
    identityKey,
    workers: false,
    listen: true,
    host: '127.0.0.1',
    port: ports.p2p,
    brontidePort: ports.brontide,
    httpHost: '127.0.0.1',
    httpPort: ports.http,
    noAuth: true,
    noDns: true,
    seeds: [],
    checkpoints: false,
    logConsole: false,
    logFile: false,
    persistentMempool: false,
    maxOutbound: 2
  }, extra);
}

async function main() {
  const artifact = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsd-odoh-regtest-'));
  const identities = {
    requester: secp256k1.privateKeyGenerate(),
    proxy: secp256k1.privateKeyGenerate(),
    target: secp256k1.privateKeyGenerate()
  };
  const ports = {
    target: {p2p: 14329, brontide: 14339, http: 14349},
    proxy: {p2p: 14328, brontide: 14338, http: 14348},
    requester: {p2p: 14327, brontide: 14337, http: 14347}
  };
  const opened = [];
  let requester = null;
  let proxy = null;
  let target = null;

  try {
    target = new FullNode(nodeOptions(
      path.join(root, 'target'),
      identities.target,
      ports.target,
      {
        logConsole: process.env.ODOH_TRIAL_DEBUG === '1',
        logLevel: process.env.ODOH_TRIAL_DEBUG === '1' ? 'debug' : 'none',
        experimentalDnsRelay: true,
        experimentalOdohTarget: true,
        experimentalOdohInstrumentation: true,
        experimentalOdohAllowPrivateTargets: true,
        experimentalOdohTargetHost: '127.0.0.1',
        experimentalOdohTargetPort: ports.target.brontide
      }));

    const targetAddress = peerAddress(target, ports.target.brontide);

    proxy = new FullNode(nodeOptions(
      path.join(root, 'proxy'),
      identities.proxy,
      ports.proxy,
      {
        experimentalOdohProxy: true,
        experimentalOdohInstrumentation: true,
        experimentalOdohAllowPrivateTargets: true,
        nodes: [targetAddress]
      }));

    const proxyAddress = peerAddress(proxy, ports.proxy.brontide);

    requester = new FullNode(nodeOptions(
      path.join(root, 'requester'),
      identities.requester,
      ports.requester,
      {
        listen: false,
        experimentalOdohAllowPrivateTargets: true,
        nodes: [proxyAddress]
      }));

    const backend = {
      queries: [],
      isReady() {
        return true;
      },
      resolveRaw(raw) {
        this.queries.push(Buffer.from(raw));
        return Promise.resolve(Buffer.from(RESPONSE));
      }
    };
    target.dnsRelay.backend = backend;
    target.dnsRelay.checkName = name => Promise.resolve(name === 'relaytest');

    await target.ensure();
    await target.open();
    opened.push(target);
    target.chain.synced = true;
    await target.connect();

    await proxy.ensure();
    await proxy.open();
    opened.push(proxy);
    const proxyTargetOpen = waitForPeer(proxy);
    await proxy.connect();
    const proxyTargetPeer = await proxyTargetOpen;

    await requester.ensure();
    await requester.open();
    opened.push(requester);
    const requesterProxyOpen = waitForPeer(requester);
    await requester.connect();
    const requesterProxyPeer = await requesterProxyOpen;

    assert(proxyTargetPeer.address.key.equals(
      secp256k1.publicKeyCreate(target.identityKey)));
    assert(requesterProxyPeer.address.key.equals(
      secp256k1.publicKeyCreate(proxy.identityKey)));

    const locator = createLocator(
      '127.0.0.1',
      ports.target.brontide,
      secp256k1.publicKeyCreate(target.identityKey),
      true);
    let proxyView = null;
    let targetView = null;
    proxy.odoh.once('proxy query', (value) => {
      proxyView = value;
    });
    target.odoh.once('target query', (value) => {
      targetView = value;
    });

    const proxyCaps = await requester.odoh.getCapabilities(
      requesterProxyPeer);
    const record = await requester.odoh.getConfig(
      requesterProxyPeer,
      locator);
    const rotationTime = Math.floor(Date.now() / 1000);
    assert(await target.odoh.rotateTargetKey(rotationTime, true));
    const response = await requester.odoh.query(
      requesterProxyPeer,
      locator,
      record,
      QUERY);
    const rotatedRecord = await requester.odoh.getConfig(
      requesterProxyPeer,
      locator);

    assert(response.equals(RESPONSE));
    assert.strictEqual(backend.queries.length, 1);
    assert(backend.queries[0].equals(QUERY));
    assert(proxyView && targetView);
    assert.strictEqual(proxyView.ciphertext.includes(QUERY), false);
    assert(targetView.dns.equals(QUERY));
    assert.strictEqual(
      proxyView.clientRequestID.equals(targetView.targetRequestID),
      false);
    assert.strictEqual(proxy.odoh.getMetrics().proxyPlaintextBytes, 0);
    assert.strictEqual(rotatedRecord.sequence, record.sequence + 1);
    assert.strictEqual(
      decodeConfigList(rotatedRecord.odohConfigs).length,
      2);

    const result = {
      schema: 1,
      network: 'regtest',
      transport: 'Handshake Brontide',
      assignment: {
        serviceBit: `0x${common.EXPERIMENTAL_ODOH_SERVICE.toString(16)}`,
        packetType: `0x${common.EXPERIMENTAL_ODOH.toString(16)}`
      },
      nodes: {
        requester: secp256k1.publicKeyCreate(
          requester.identityKey).toString('hex'),
        proxy: secp256k1.publicKeyCreate(proxy.identityKey).toString('hex'),
        target: secp256k1.publicKeyCreate(target.identityKey).toString('hex')
      },
      capabilities: {
        proxyRoles: proxyCaps.roles,
        targetAdvertisedBaseRelay: Boolean(
          proxyTargetPeer.services & common.EXPERIMENTAL_DNS_RELAY_SERVICE),
        targetAdvertisedODoH: Boolean(
          proxyTargetPeer.services & common.EXPERIMENTAL_ODOH_SERVICE)
      },
      targetConfig: {
        signatureVerified: true,
        configRecordID: record.id.toString('hex'),
        locatorMatched: record.locator.targetKey.equals(locator.targetKey),
        expiresAt: record.expiresAt,
        rotation: {
          previousSequence: record.sequence,
          currentSequence: rotatedRecord.sequence,
          overlappingConfigs: decodeConfigList(
            rotatedRecord.odohConfigs).length,
          previousRecordAcceptedAfterRotation: response.equals(RESPONSE)
        }
      },
      privacy: {
        queryAbsentFromProxyCiphertext: !proxyView.ciphertext.includes(QUERY),
        proxyEventFields: Object.keys(proxyView).sort(),
        targetEventFields: Object.keys(targetView).sort(),
        hopRequestIDsIndependent: !proxyView.clientRequestID.equals(
          targetView.targetRequestID),
        proxyPlaintextBytes: proxy.odoh.getMetrics().proxyPlaintextBytes,
        ciphertextSHA256: sha256.digest(
          proxyView.ciphertext).toString('hex')
      },
      dns: {
        qname: 'www.relaytest.',
        qtype: 'A',
        baseRelayBackendRequests: backend.queries.length,
        responseMatched: response.equals(RESPONSE)
      },
      metrics: {
        proxy: proxy.odoh.getMetrics(),
        target: target.odoh.getMetrics(),
        baseRelay: target.dnsRelay.getMetrics()
      },
      result: 'pass'
    };
    const output = JSON.stringify(result, null, 2) + '\n';

    if (artifact) {
      fs.mkdirSync(path.dirname(artifact), {recursive: true});
      fs.writeFileSync(artifact, output, {encoding: 'utf8', mode: 0o600});
    }

    process.stdout.write(output);
  } finally {
    for (const node of opened.reverse()) {
      try {
        await node.close();
      } catch (e) {
        process.stderr.write(`cleanup warning: ${e.message}\n`);
      }
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
