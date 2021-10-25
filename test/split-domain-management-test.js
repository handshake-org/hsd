/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const {Script, Opcode, Stack} = require('../lib/script');
const rules = require('../lib/covenants/rules');
const {Resource} = require('../lib/dns/resource');
const {forValue} = require('./util/common');
const common = require('../lib/script/common.js');

// Split Domain Management:
//
// Script:
// OP_TYPE
// types.RENEW
// OP_EQUAL
// OP_IF
//   OP_TRUE
// OP_ELSE
//   OP_DUP
//   <hot pubkey>
//   OP_EQUAL
//   OP_IF
//     OP_TYPE
//     types.UPDATE
//     OP_EQUALVERIFY
//     OP_CHECKSIG
//   OP_ELSE
//     OP_DUP
//     <cold pubkey>
//     OP_EQUALVERIFY
//     OP_CHECKSIG
//   OP_ENDIF
// OP_ENDIF

const createScript = function (pubKeyhot,pubKeycold) {
  return new Script([
    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.RENEW),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('if'),
    Opcode.fromBool(true),
    Opcode.fromSymbol('else'),
    Opcode.fromSymbol('dup'),
    Opcode.fromPush(pubKeyhot),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('if'),
    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.UPDATE),
    Opcode.fromSymbol('equalverify'),
    Opcode.fromSymbol('checksig'),
    Opcode.fromSymbol('else'),
    Opcode.fromSymbol('dup'),
    Opcode.fromPush(pubKeycold),
    Opcode.fromSymbol('equalverify'),
    Opcode.fromSymbol('checksig'),
    Opcode.fromSymbol('endif'),
    Opcode.fromSymbol('endif')
  ]);
};

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');

let alice, aliceReceive;
let bob, bobReceive;
let faythe, faytheReceive;

let pubKeyhot, pubKeycold, privKeyhot, privKeycold;
let script, address;

const name = rules.grindName(5, 1, network);
const nameHash = rules.hashName(name);
let heightBeforeOpen, heightBeforeRegister, heightBeforeFinalize;
let coin;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Split Domain Management', function() {
  before(async () => {
    await node.open();

    alice = await wdb.create(); // Bought and retains ownership of domain
    bob = await wdb.create(); // Has ability to UPDATE
    faythe = await wdb.create(); //  Watchtower which can renew domain.

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();
    faytheReceive = await faythe.receiveAddress();

    // TODO: HIP-0009
    // pubKeyhot = bob.deriveSomething();
    // pubKeycold = alice.deriveSomething();

    // I'm Lazy right now so imma just do that for now
    pubKeyhot = (await bob.getKey(bobReceive)).publicKey;
    pubKeycold = (await alice.getKey(aliceReceive)).publicKey;

    privKeyhot = (await bob.getPrivateKey(bobReceive)).privateKey;
    privKeycold = (await alice.getPrivateKey(aliceReceive)).privateKey;

    script = createScript(pubKeyhot,pubKeycold);
  });

  after(async () => {
    await node.close();
  });

  it('should create address from script', () => {
    address = new Address().fromScript(script);
  });

  it('should fund all wallets', async () => {
    await mineBlocks(2, aliceReceive);
    await mineBlocks(2, bobReceive);
    await mineBlocks(2, faytheReceive);

    await forValue(wdb, 'height', node.chain.height);

    const aliceBal = await alice.getBalance();
    const bobBal = await bob.getBalance();
    const faytheBal = await faythe.getBalance();

    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
    assert(bobBal.confirmed === 2000 * 2 * 1e6);
    assert(faytheBal.confirmed === 2000 * 2 * 1e6);
  });

  it('should win name with Alice\'s wallet', async () => {
    heightBeforeOpen = node.chain.height;

    await alice.sendOpen(name, false);
    await mineBlocks(network.names.treeInterval + 1);

    await alice.sendBid(name, 100000, 200000);
    await mineBlocks(network.names.biddingPeriod);

    await alice.sendReveal(name);
    await mineBlocks(network.names.revealPeriod + 1);

    let ns = await node.getNameStatus(nameHash);
    assert(ns);
    const owner = ns.owner;
    const coin = await alice.getCoin(owner.hash, owner.index);
    assert(coin);
    const json = ns.getJSON(node.chain.height, node.network);
    assert(json.state === 'CLOSED');

    heightBeforeRegister = node.chain.height;

    const resource = Resource.fromJSON({
      records: [{type: 'TXT', txt: ['This name is managed by multiple keys']}]
    });
    await alice.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);

    ns = await node.getNameStatus(nameHash);
    assert.strictEqual(ns.height, heightBeforeOpen + 1);
    assert.strictEqual(ns.renewal, heightBeforeRegister + 1);
  });

  it('should TRANSFER/FINALIZE to Split domain management address', async () => {
    const heightBeforeTransfer = node.chain.height;

    await alice.sendTransfer(name, address);
    await mineBlocks(network.names.transferLockup);

    let ns = await node.getNameStatus(nameHash);
    assert.strictEqual(ns.transfer, heightBeforeTransfer + 1);

    heightBeforeFinalize = node.chain.height;

    await alice.sendFinalize(name);
    await mineBlocks(1);

    // FINALIZE resets transfer and renewal
    ns = await node.getNameStatus(nameHash);
    assert.strictEqual(ns.transfer, 0);
    assert.strictEqual(ns.height, heightBeforeOpen + 1);
    assert.strictEqual(ns.renewal, heightBeforeFinalize + 1);

    const {hash, index} = ns.owner;
    coin = await node.getCoin(hash, index);
    assert.deepStrictEqual(coin.address, address);
  });

  it('should not be owned by either wallet', async  () => {
    assert.rejects(
      alice.sendTransfer(name, aliceReceive),
      {message: `Wallet does not own: "${name}".`}
    );

    assert.rejects(
      bob.sendTransfer(name, bobReceive),
      {message: 'Auction not found.'}
    );
  });

  it('should advance chain to avoid premature renewal', async () => {
    await mineBlocks(network.names.treeInterval);
  });

  it('should fail to spend without correct script', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    const witness = new Stack();
    witness.pushData(Buffer.from('deadbeef', 'hex'));
    mtx.inputs[0].witness.fromStack(witness);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));
    mtx.output(0).covenant.type = rules.types.RENEW;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.pushHash(node.chain.tip.hash);

    await alice.fund(mtx, {coins: [coin]});
    await alice.finalize(mtx, {coins: [coin]});
    await alice.sign(mtx);

    assert.throws(
      () => mtx.check(),
      {message: 'WITNESS_PROGRAM_MISMATCH'}
    );
  });

  it('should spend with correct action type: RENEW - Faythe', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);
    const witness = new Stack();
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));
    mtx.output(0).covenant.type = rules.types.RENEW;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.pushHash(node.chain.tip.hash);

    await faythe.fund(mtx, {coins: [coin]});
    await faythe.finalize(mtx, {coins: [coin]});
    await faythe.sign(mtx);

    mtx.check();
    await mineBlocks(50);

    // faythe (aka "anyone") will broadcast
    const heightBeforeRenewal = node.chain.height;
    await node.sendTX(mtx.toTX());

    await mineBlocks(1);

    const ns = await node.getNameStatus(nameHash);
    assert.strictEqual(ns.transfer, 0);
    assert.strictEqual(ns.height, heightBeforeOpen + 1);
    assert.strictEqual(ns.renewal, heightBeforeRenewal + 1);

    const {hash, index} = ns.owner;
    coin = await node.getCoin(hash, index);
    assert.deepStrictEqual(coin.address, address);
    assert.bufferEqual(hash, mtx.hash());

    // Urkel tree data is preserved
    const res = Resource.decode(ns.data);
    assert.strictEqual(res.records[0].txt[0], 'This name is managed by multiple keys');
  });

  it('should fail to spend without correct signature: UPDATE', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));

    const resource = Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['This name is managed by multiple keys and was just updated by Bob']
        }
      ]
    });

    mtx.output(0).covenant.type = rules.types.UPDATE;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.push(resource.encode());

    await bob.fund(mtx, {coins: [coin]});
    await bob.finalize(mtx, {coins: [coin]});

    const witness = new Stack();
    witness.pushData(Buffer.from([]));
    witness.pushData(pubKeyhot);
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    await bob.sign(mtx);
    assert.throws(
      () => mtx.check(),
      {message: 'EVAL_FALSE'}
    );
  });

  it('should fail to spend without correct signature: TRANSFER', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));

    mtx.output(0).covenant.type = rules.types.TRANSFER;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.pushU8(coin.address.version);
    // Let's just try transfer to same address whatever
    mtx.output(0).covenant.push(coin.address.hash);

    await bob.fund(mtx, {coins: [coin]});
    await bob.finalize(mtx, {coins: [coin]});

    // Sign after all the funding stuff is done
    // Attempt signing from hot key while trying transfer
    const sig = mtx.signature(0, script, coin.value, privKeyhot, common.hashType.ALL);
    const witness = new Stack();
    witness.pushData(sig);
    witness.pushData(privKeyhot);
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    await bob.sign(mtx);
    assert.throws(
      () => mtx.check(),
      {message: 'EQUALVERIFY (op=OP_EQUALVERIFY, ip=17)'}
    );
  });

  it('should spend with correct action type and signature: UPDATE - Bob', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));

    const resource = Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['This name is managed by multiple keys and was just updated by Bob']
        }
      ]
    });

    mtx.output(0).covenant.type = rules.types.UPDATE;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.push(resource.encode());

    await bob.fund(mtx, {coins: [coin]});
    await bob.finalize(mtx, {coins: [coin]});

    // Sign after all the funding stuff is done
    const sig = mtx.signature(0, script, coin.value, privKeyhot, common.hashType.ALL);
    const witness = new Stack();
    witness.pushData(sig);
    witness.pushData(pubKeyhot);
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    await bob.sign(mtx);

    mtx.check();

    await node.sendTX(mtx.toTX());
    await mineBlocks(1);

    const ns = await node.getNameStatus(nameHash);
    const {hash, index} = ns.owner;
    coin = await node.getCoin(hash, index);
    assert.deepStrictEqual(coin.address, address);
    assert.bufferEqual(hash, mtx.hash());

    const res = Resource.decode(ns.data);
    assert.strictEqual(
      res.records[0].txt[0],
       'This name is managed by multiple keys and was just updated by Bob'
    );
  });

  it('should spend with correct action type and signature: UPDATE - Alice', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));

    const resource = Resource.fromJSON({
      records: [
        {
          type: 'TXT',
          txt: ['This name is managed by multiple keys and was just updated by Alice']
        }
      ]
    });

    mtx.output(0).covenant.type = rules.types.UPDATE;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.push(resource.encode());

    await alice.fund(mtx, {coins: [coin]});
    await alice.finalize(mtx, {coins: [coin]});

    // Sign after all the funding stuff is done
    const sig = mtx.signature(0, script, coin.value, privKeycold, common.hashType.ALL);
    const witness = new Stack();
    witness.pushData(sig);
    witness.pushData(pubKeycold);
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    await alice.sign(mtx);

    mtx.check();

    await node.sendTX(mtx.toTX());
    await mineBlocks(1);

    const ns = await node.getNameStatus(nameHash);
    const {hash, index} = ns.owner;
    coin = await node.getCoin(hash, index);
    assert.deepStrictEqual(coin.address, address);
    assert.bufferEqual(hash, mtx.hash());

    const res = Resource.decode(ns.data);
    assert.strictEqual(
      res.records[0].txt[0],
       'This name is managed by multiple keys and was just updated by Alice'
    );
  });

  it('should spend with correct action type and signature: TRANSFER - Alice', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);
    // Anyone-can-renew address, just for testing
    const address = Address.fromString('rs1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqs570axm');

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));

    mtx.output(0).covenant.type = rules.types.TRANSFER;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.pushU8(address.version);
    mtx.output(0).covenant.push(address.hash);

    await alice.fund(mtx, {coins: [coin]});
    await alice.finalize(mtx, {coins: [coin]});

    // Sign after all the funding stuff is done
    const sig = mtx.signature(0, script, coin.value, privKeycold, common.hashType.ALL);
    const witness = new Stack();
    witness.pushData(sig);
    witness.pushData(pubKeycold);
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    await alice.sign(mtx);
    mtx.check();
    await node.sendTX(mtx.toTX());
    await mineBlocks(1);

    // Confirm tx got confirmed
    const ns = await node.getNameStatus(nameHash);
    const {hash, index} = ns.owner;
    coin = await node.getCoin(hash, index);
    assert.bufferEqual(hash, mtx.hash());
  });

  it('should spend with correct action type and signature: TRANSFER - Alice', async () => {
    // Mine blocks to pass the transfer window
    await mineBlocks(50);
    const mtx = new MTX();
    mtx.addCoin(coin);
    // Anyone-can-renew address, just for testing
    const address = Address.fromString('rs1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqs570axm');
    mtx.addOutput(new Output({
      value: coin.value,
      address: address
    }));

    let ns = await node.getNameStatus(nameHash);
    let flags = 0;
    if (ns.weak)
      flags |= 1;

    mtx.output(0).covenant.type = rules.types.FINALIZE;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(ns.height);
    mtx.output(0).covenant.push(Buffer.from(name, 'ascii'));
    mtx.output(0).covenant.pushU8(flags);
    mtx.output(0).covenant.pushU32(ns.claimed);
    mtx.output(0).covenant.pushU32(ns.renewals);
    mtx.output(0).covenant.pushHash(await wdb.getRenewalBlock());

    await alice.fund(mtx, {coins: [coin]});
    await alice.finalize(mtx, {coins: [coin]});

    // Sign after all the funding stuff is done
    const sig = mtx.signature(0, script, coin.value, privKeycold, common.hashType.ALL);
    const witness = new Stack();
    witness.pushData(sig);
    witness.pushData(pubKeycold);
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    await alice.sign(mtx);
    mtx.check();
    await node.sendTX(mtx.toTX());
    await mineBlocks(1);

    // Confirm tx got confirmed
    ns = await node.getNameStatus(nameHash);
    const {hash, index} = ns.owner;
    coin = await node.getCoin(hash, index);
    // Confirm Name got transferred to new address
    assert.deepStrictEqual(coin.address, address);
    assert.bufferEqual(hash, mtx.hash());
  });
});
