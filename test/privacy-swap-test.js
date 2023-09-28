/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const {Script, Stack} = require('../lib/script');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const {Resource} = require('../lib/dns/resource');
const Coin = require('../lib/primitives/coin');
const common = require('../lib/script/common');
const Opcode = require('../lib/script/opcode.js');

const secp256k1 = require('bcrypto/lib/js/secp256k1');

const adaptor = require('./util/adaptor-sig');

const network = Network.get('regtest');

const ports = {
  p2p: 14331,
  node: 14332,
  wallet: 14333
};

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')],
  env: {
    'HSD_WALLET_HTTP_PORT': ports.wallet.toString()
  }
});

const {wdb} = node.require('walletdb');

let alice, bob, aliceReceive, bobReceive;

const name = rules.grindName(5, 1, network);
const nameHash = rules.hashName(name);
const price = 5 * 1e6; // 5 HNS

// glob is used to store communication data between Bob and Alex
let glob;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

function createMultisig(key1, key2) {
  return new Script([
    Opcode.fromInt(2),
    Opcode.fromPush(key1),
    Opcode.fromPush(key2),
    Opcode.fromInt(2),
    Opcode.fromSymbol('checkmultisig')
  ]);
}

function createAnyoneCanFinalizeMultisig(key1, key2) {
  return new Script([
    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.TRANSFER),
    Opcode.fromSymbol('equal'),

    Opcode.fromSymbol('if'),
    Opcode.fromInt(2),
    Opcode.fromPush(key1),
    Opcode.fromPush(key2),
    Opcode.fromInt(2),
    Opcode.fromSymbol('checkmultisig'),

    Opcode.fromSymbol('else'),

    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.FINALIZE),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('endif')
  ]);
}

describe('Privacy preserving name swap', function() {
  before(async () => {
    await node.open();

    alice = await wdb.create();
    bob = await wdb.create();

    aliceReceive = await alice.receiveAddress(); // Will recieve funds at this address
    bobReceive = await bob.receiveAddress(); // Will recieve name at this address
  });

  after(async () => {
    await node.close();
  });

  it('should fund both wallets', async () => {
    await mineBlocks(2, aliceReceive);
    await mineBlocks(2, bobReceive);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const aliceBal = await alice.getBalance();
    const bobBal = await bob.getBalance();
    assert(aliceBal.confirmed === 2000 * 2 * 1e6);
    assert(bobBal.confirmed === 2000 * 2 * 1e6);
  });

  it('should win name with Alice\'s wallet', async () => {
    await alice.sendOpen(name, false);
    await mineBlocks(network.names.treeInterval + 1);

    await alice.sendBid(name, 100000, 200000);
    await mineBlocks(network.names.biddingPeriod);

    await alice.sendReveal(name);
    await mineBlocks(network.names.revealPeriod + 1);

    const ns = await alice.getNameStateByName(name);
    assert(ns);
    const owner = ns.owner;
    const coin = await alice.getCoin(owner.hash, owner.index);
    assert(coin);
    const json = ns.getJSON(node.chain.height, node.network);
    assert(json.state === 'CLOSED');
  });

  it('should REGISTER', async () => {
    const resource = Resource.fromJSON({
      records: [{type: 'TXT', txt: ['Contact Alice to buy this name!']}]
    });
    await alice.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);
  });

  it('should generate multisig contracts', async () => {
    // We make two multisig, one will hold the funds, the other will hold the name
    // These will probably be deterministic?
    const aliceKeys = [secp256k1.privateKeyGenerate(), secp256k1.privateKeyGenerate()];
    const bobKeys = [secp256k1.privateKeyGenerate(), secp256k1.privateKeyGenerate()];

    // Alice and Bob exchange pubkeys
    const alicePubKeys = aliceKeys.map(k => secp256k1.publicKeyCreate(k));
    const bobPubKeys = bobKeys.map(k => secp256k1.publicKeyCreate(k));

    const nameMultisig = createAnyoneCanFinalizeMultisig(alicePubKeys[0], bobPubKeys[0]);
    const fundMultisig = createMultisig(alicePubKeys[1], bobPubKeys[1]);

    glob = {
      aliceKeys,
      bobKeys,
      alicePubKeys,
      bobPubKeys,
      nameMultisig,
      fundMultisig
    };
  });

  // Before transferring the name, both parties will create a refund presign in case
  // the other party leaves, the refund presign will have a future locktime
  it('should create presigns for a refund transaction', async () => {
    // TODO
  });

  it('should TRANSFER/FINALIZE to name address', async () => {
    const heightBeforeTransfer = node.chain.height;
    const address = Address.fromScript(glob.nameMultisig);
    await alice.sendTransfer(name, address);
    await mineBlocks(network.names.transferLockup);

    let ns = await node.getNameStatus(nameHash);
    assert.strictEqual(ns.transfer, heightBeforeTransfer + 1);

    await alice.sendFinalize(name);
    await mineBlocks(1);

    ns = await node.getNameStatus(nameHash);

    const {hash, index} = ns.owner;
    const coin = await node.getCoin(hash, index);
    assert.deepStrictEqual(coin.address, address);
  });

  it('should fund the fund address - bob', async () => {
    const address = Address.fromScript(glob.fundMultisig);
    const out = new Output({
      address: address,
      value: price
    });
    glob.fundingTX = await bob.send({
        outputs: [out]
    });
    await mineBlocks(1);
  });

  it('should verify both addresses are correctly funded', async () => {
    // TODO
  });

  it('should create presigns', async () => {
    const mtx = new MTX();
    const output = new Output();
    output.address = aliceReceive;
    output.value = price;
    mtx.addOutput(output);
    mtx.addCoin(Coin.fromTX(glob.fundingTX, 0, -1));

    glob.fundTX = mtx;
  });

  it('should verify fundTX', async () => {
    // TODO
  });

  it('should create TRANSFER presigns', async () => {
    const ns = await node.getNameStatus(nameHash);
    const mtx = new MTX();

    const {hash, index} = ns.owner;
    const nameCoin = await node.getCoin(hash, index);
    mtx.addCoin(nameCoin);

    const nameAddress = Address.fromScript(glob.nameMultisig);
    const output = new Output();
    output.address = nameAddress;
    output.value = ns.value;

    const address = bobReceive;
    output.covenant.type = types.TRANSFER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.pushU8(address.version);
    output.covenant.push(address.hash);
    mtx.outputs.push(output);
    glob.transferTX = mtx;
  });

  it('should verify TRANSFER/FINALIZE presigns', async () => {
    // TODO
  });

  it('should sign TRANSFER presign - Alice', async () => {
    const {
      ALL,
      ANYONECANPAY
    } = common.hashType;

    const ns = await node.getNameStatus(nameHash);

    const sighashName = glob.transferTX.signatureHash(0, glob.nameMultisig, ns.value, ALL | ANYONECANPAY);
    const [t, T] = adaptor.generateTweakPoint();
    const sige = adaptor.signTweaked(sighashName, glob.aliceKeys[0], T);
    glob.t = t;
    glob.T = T;
    glob.sige_transfer = sige;
    // pass [T, sige] to Bob
  });

  it('should verify encrypted signature - Bob', async () => {
    const {
      ALL,
      ANYONECANPAY
    } = common.hashType;
    const ns = await node.getNameStatus(nameHash);

    const [P, Q, se, proof] = glob.sige_transfer;
    const sighashName = glob.transferTX.signatureHash(0, glob.nameMultisig, ns.value, ALL | ANYONECANPAY);
    assert(adaptor.verifyTweakedSignature(sighashName, P, Q, se, proof, glob.T, glob.alicePubKeys[0]));
  });

  it('should sign funding transaction - bob', async () => {
    const {
      ALL,
      ANYONECANPAY
    } = common.hashType;

    const sighashFund = glob.fundTX.signatureHash(0, glob.fundMultisig, price, ALL | ANYONECANPAY);
    const sige = adaptor.signTweaked(sighashFund, glob.bobKeys[1], glob.T);
    glob.sige_fund = sige;
    // pass this to Alice
  });

  it('should verify encrypted signature - Alice', async () => {
    const {
      ALL,
      ANYONECANPAY
    } = common.hashType;

    const [P, Q, se, proof] = glob.sige_fund;
    const sighashFund = glob.fundTX.signatureHash(0, glob.fundMultisig, price, ALL | ANYONECANPAY);
    assert(adaptor.verifyTweakedSignature(sighashFund, P, Q, se, proof, glob.T, glob.bobPubKeys[1]));
  });

  it('should reveal signature fundTX - Alice', async () => {
    const {
      ALL,
      ANYONECANPAY
    } = common.hashType;
    const ns = await node.getNameStatus(nameHash);

    const aliceSig = glob.fundTX.signature(0, glob.fundMultisig, price, glob.aliceKeys[1], ALL);

    const [P, Q, se, proof] = glob.sige_fund;
    const bobSig = adaptor.untweakCompact(Q, se, glob.t, ALL | ANYONECANPAY);

    const witness = new Stack();
    witness.pushInt(0);
    witness.push(aliceSig);
    witness.push(bobSig);
    witness.push(glob.fundMultisig.encode());
    glob.fundTX.inputs[0].witness.fromStack(witness);

    assert(glob.fundTX.verify());
  });

  it('should recover t from fundTX signature - Alice', async () => {
    const {
      ALL,
      ANYONECANPAY
    } = common.hashType;

    const ns = await node.getNameStatus(nameHash);
    const bobSig = glob.transferTX.signature(0, glob.nameMultisig, ns.value, glob.bobKeys[0], ALL);

    const untweaked_sig = glob.fundTX.inputs[0].witness.toArray()[2];
    const [r, s] = secp256k1._decodeCompact(untweaked_sig.slice(0, -1));
    const [P, Q, se, proof] = glob.sige_transfer;
    const [t] = adaptor.extractTweakPoint(s, glob.sige_fund[2]);

    const aliceSig = adaptor.untweakCompact(Q, se, t, ALL | ANYONECANPAY);

    const witness = new Stack();
    witness.pushInt(0);
    witness.push(aliceSig);
    witness.push(bobSig);
    witness.push(glob.nameMultisig.encode());
    glob.transferTX.inputs[0].witness.fromStack(witness);

    assert(glob.transferTX.verify());
  });
});

