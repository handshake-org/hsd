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

// ANYONE-CAN-RENEW address:
//
// Script: OP_TYPE OP_8 OP_EQUAL
// Serialized script: d05887
// Script hash: e466310e566f8f14ac36f7eb7607a5d77a2351ad6bb5aba20a17396c5b18b8c1
//
// main:    hs1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqsw3f8kc
// testnet: ts1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqsj8gmfv
// regtest: rs1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqs570axm
// simnet:  ss1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqs4kzusf

const script = new Script([
  Opcode.fromSymbol('type'),
  Opcode.fromInt(rules.types.RENEW),
  Opcode.fromSymbol('equal')
]);
const address = new Address().fromScript(script);

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');

let alice, aliceReceive;
let bob, bobReceive;

const name = rules.grindName(10, 1, network);
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

describe('Anyone-can-renew address', function() {
  before(async () => {
    await node.open();

    alice = await wdb.create();
    bob = await wdb.create();

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();
  });

  after(async () => {
    await node.close();
  });

  it('should prove anyone-can-renew values', () => {
    assert.bufferEqual(script.encode(), Buffer.from('d05887', 'hex'));
    assert.strictEqual(
      address.toString('main'),
      'hs1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqsw3f8kc'
    );
    assert.strictEqual(
      address.toString('testnet'),
      'ts1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqsj8gmfv'
    );
    assert.strictEqual(
      address.toString('regtest'),
      'rs1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqs570axm'
    );
    assert.strictEqual(
      address.toString('simnet'),
      'ss1qu3nrzrjkd783ftpk7l4hvpa96aazx5dddw66hgs2zuukckcchrqs4kzusf'
    );
  });

  it('should fund both wallets', async () => {
    await mineBlocks(2, aliceReceive);
    await mineBlocks(2, bobReceive);

    await forValue(wdb, 'height', node.chain.height);

    const aliceBal = await alice.getBalance();
    const bobBal = await bob.getBalance();
    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
    assert(bobBal.confirmed === 2000 * 2 * 1e6);
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
      records: [{type: 'TXT', txt: ['This name is ANYONE-CAN-RENEW']}]
    });
    await alice.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);

    ns = await node.getNameStatus(nameHash);
    assert.strictEqual(ns.height, heightBeforeOpen + 1);
    assert.strictEqual(ns.renewal, heightBeforeRegister + 1);
  });

  it('should TRANSFER/FINALIZE to ANYONE-CAN-RENEW address', async () => {
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

    // Have to add this last because wallet fund clears existing input data
    const witness = new Stack();
    witness.pushData(Buffer.from('deadbeef', 'hex'));
    mtx.inputs[0].witness.fromStack(witness);

    assert.throws(
      () => mtx.check(),
      {message: 'WITNESS_PROGRAM_MISMATCH'}
    );
  });

  it('should fail to spend without correct action type: UPDATE', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));
    mtx.output(0).covenant.type = rules.types.UPDATE;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.push(Buffer.alloc(1));

    await alice.fund(mtx, {coins: [coin]});
    await alice.finalize(mtx, {coins: [coin]});
    await alice.sign(mtx);

    // Have to add this last because wallet fund clears existing input data
    const witness = new Stack();
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    assert.throws(
      () => mtx.check(),
      {message: 'EVAL_FALSE'}
    );
  });

  it('should fail to spend without correct action type: TRANSFER', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));
    mtx.output(0).covenant.type = rules.types.TRANSFER;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.pushU8(0);
    mtx.output(0).covenant.push(Buffer.alloc(20));

    await alice.fund(mtx, {coins: [coin]});
    await alice.finalize(mtx, {coins: [coin]});
    await alice.sign(mtx);

    // Have to add this last because wallet fund clears existing input data
    const witness = new Stack();
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    assert.throws(
      () => mtx.check(),
      {message: 'EVAL_FALSE'}
    );
  });

  it('should spend with correct action type: RENEW - Alice', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

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

    // Have to add this last because wallet fund clears existing input data
    const witness = new Stack();
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    mtx.check();
  });

  it('should spend with correct action type: RENEW - Bob', async () => {
    const mtx = new MTX();
    mtx.addCoin(coin);

    mtx.addOutput(new Output({
      value: coin.value,
      address: coin.address
    }));
    mtx.output(0).covenant.type = rules.types.RENEW;
    mtx.output(0).covenant.pushHash(nameHash);
    mtx.output(0).covenant.pushU32(heightBeforeOpen + 1);
    mtx.output(0).covenant.pushHash(node.chain.tip.hash);

    await bob.fund(mtx, {coins: [coin]});
    await bob.finalize(mtx, {coins: [coin]});
    await bob.sign(mtx);

    // Have to add this last because wallet fund clears existing input data
    const witness = new Stack();
    witness.pushData(script.encode());
    mtx.inputs[0].witness.fromStack(witness);

    mtx.check();

    // Bob (aka "anyone") will broadcast
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
    assert.strictEqual(res.records[0].txt[0], 'This name is ANYONE-CAN-RENEW');

    // Bob's wallet still isn't tracking the name, but Alice's is.
    const nsBob = await bob.getNameStateByName(name);
    assert.strictEqual(nsBob, null);
    const nsAlice = await alice.getNameStateByName(name);
    assert.deepStrictEqual(nsAlice, ns);
  });
});
