'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const { MTX } = require('../lib/primitives/mtx');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const Coin = require('../lib/primitives/coin');
const {Resource} = require('../lib/dns/resource');

const {Script, Opcode, Stack} = require('../lib/script');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const {WalletClient} = require('hs-client');
const crypto = require('crypto');
const common = require('../lib/script/common');
const bio = require('bufio');
const policy = require('../lib/protocol/policy');
const { Outpoint } = require('../lib/primitives');

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

const wclient = new WalletClient({
  port: ports.wallet
});

const {wdb} = node.require('walletdb');

// Alice wants to Bid 10 HNS
// Bob is willing to lend 90 HNS for a fee of 5 HNS
let alice, bob, aliceReceive, bobReceive;
let bobKey, aliceKey1, aliceKey2;

// Amount lost to TX fee
let aliceLoss = 0;
let bobLoss = 0;

// Here we only create one watchonly wallet, but we'll assume both parties have one.
let watchOnly;

let presign;
let glob;

const {
  ALL,
  NOINPUT,
  ANYONECANPAY
} = common.hashType;

// These are data that will be communicated between Alice and Bob
const name = rules.grindName(5, 1, network);
const nameHash = rules.hashName(name);
let ns;
const config = {
  bid : 10 * 1e6, // 10 HNS
  blind : 90 * 1e6, // 90 HNS
  fee : 5 * 1e6 // 5 HNS, this fee should cover any transaction fees incurred by Bob too.
};

let bobRevealTX;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

function creatTimeLockedMultisig(stakerPubkey,bidderPubkey,height) {
  // Script:
  // OP_IF
  //  <pubKeyA> OP_CHECKSIGVERIFY
  // OP_ELSE
  //   <reveal phase end height> OP_CHECKLOCKTIMEVERIFY OP_DROP
  // OP_ENDIF
  // <pubKeyB1> OP_CHECKSIG

  const script = new Script([
    Opcode.fromSymbol('if'),
    Opcode.fromPush(stakerPubkey),
    Opcode.fromSymbol('checksigverify'),
    Opcode.fromSymbol('else'),
    Opcode.fromInt(height),
    Opcode.fromSymbol('checklocktimeverify'),
    Opcode.fromSymbol('drop'),
    Opcode.fromSymbol('endif'),
    Opcode.fromPush(bidderPubkey),
    Opcode.fromSymbol('checksig')
  ]);
  return script;
}

describe('turbo blinds', function() {
  before(async () => {
    await node.open();
    await wclient.open();

    alice = await wdb.create();
    bob = await wdb.create();

    watchOnly = await wdb.create({
      accountKey: (await bob.getAccount('default')).accountKey,
      watchOnly: true
    });

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();

    aliceKey1 = alice.master.key.derive(5305,true).derive(0);
    aliceKey2 = alice.master.key.derive(5305,true).derive(1);
    bobKey = alice.master.key.derive(5305,true).derive(0);
  });

  after(async () => {
    await wclient.close();
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

  // This step can be done by anyone
  it('should send open', async () => {
    const tx = await alice.sendOpen(name, false);
    await mineBlocks(network.names.treeInterval + 1);

    const view = await alice.getSpentView(tx);
    aliceLoss += tx.getFee(view);
  });

  it('should create presigned transactions - Bob', async () => {
    ns = await alice.getNameStateByName(name);

    // Verify that we have enough time to bid, 5 blocks is enough.
    assert(ns.isBidding(wdb.height + 5, network));

    const revealPeriodEnd = ns.height + network.names.biddingPeriod + network.names.revealPeriod;
    const bidScript = creatTimeLockedMultisig(bobKey.publicKey,aliceKey1.publicKey,revealPeriodEnd);
    const fundingScript = creatTimeLockedMultisig(bobKey.publicKey,aliceKey2.publicKey,revealPeriodEnd);

    const nonce = crypto.randomBytes(32);

    // Bob creates presigned reveal (Alice can do this step too)
    const revealTX = new MTX();

    const output0 = new Output();
    const address = new Address().fromScript(bidScript);
    output0.address = address;
    output0.value = config.bid;
    output0.covenant.type = types.REVEAL;
    output0.covenant.pushHash(nameHash);
    output0.covenant.pushU32(ns.height);
    output0.covenant.pushHash(nonce);

    const output1 = new Output();
    output1.address = bobReceive;
    output1.value = config.blind + config.bid + config.fee;

    revealTX.outputs.push(output0);
    revealTX.outputs.push(output1);

    // Just a hack to set the appropriate coin values in coinview.
    const coin1 = new Coin({
      height: 0,
      value: config.bid + config.blind,
      address: new Address().fromScript(bidScript),
      hash: Buffer.alloc(32, 0x00),
      index: 0
    });

    const coin2 = new Coin({
      height: 0,
      value: config.bid + config.fee,
      address: new Address().fromScript(fundingScript),
      hash: Buffer.alloc(32, 0x00),
      index: 1
    });

    revealTX.addCoin(coin1);
    revealTX.addCoin(coin2);

    const feeRate = await wdb.estimateFee(1); //
    const size = await revealTX.estimateSize(); // TODO: Pass in a custom size estimator for witness items
    const fee = policy.getRoundFee(size,feeRate); // txfee

    // Modify coinview to contain appropriate value.
    coin2.value += fee;
    revealTX.view.addCoin(coin2);

    const sig0 = revealTX.signature(0, bidScript, config.bid + config.blind, bobKey.privateKey, ALL | NOINPUT | ANYONECANPAY);
    const sig1 = revealTX.signature(1, fundingScript, config.bid + config.fee + fee, bobKey.privateKey, ALL | NOINPUT | ANYONECANPAY);

    bobRevealTX = revealTX;
    // Bob Communicates the following information to alice,
    // technically you could encode most of this in the tx itself, but this feels better
    presign = {
      tx: revealTX.encode().toString('hex'),
      nonce: nonce.toString('hex'),
      txFee: fee,
      signaturesBob: [sig0.toString('hex'), sig1.toString('hex')],
      signaturesAlice : [],
      pubkeyBob: bobKey.publicKey.toString('hex'),
      bidScript: bidScript.encode().toString('hex'),
      fundingScript: fundingScript.encode().toString('hex')
    };
    glob = {
      bidScript: bidScript,
      fundingScript: fundingScript
    };
  });

  it('should verify and sign transaction sent by Bob - Alice', async () => {
    // Verify that we have enough time to bid, 5 blocks is enough.
    assert(ns.isBidding(wdb.height + 5, network));

    const revealPeriodEnd = ns.height + network.names.biddingPeriod + network.names.revealPeriod;

    // Create contracts using information provided
    const pubkeyBob = Buffer.from(presign.pubkeyBob, 'hex');
    const bidScript = creatTimeLockedMultisig(pubkeyBob,aliceKey1.publicKey,revealPeriodEnd);
    const fundingScript = creatTimeLockedMultisig(pubkeyBob,aliceKey2.publicKey,revealPeriodEnd);

    // Verify given contracts
    assert.bufferEqual(fundingScript.encode(),Buffer.from(presign.fundingScript, 'hex'));
    assert.bufferEqual(bidScript.encode(),Buffer.from(presign.bidScript, 'hex'));

    /** @type {MTX} */
    const revealTX = MTX.decode(Buffer.from(presign.tx, 'hex'));
    const address = new Address().fromScript(bidScript);

    // Verify Outputs
    // Verify Bid reveal output
    assert.bufferEqual(revealTX.output(0).address.getHash(), address.getHash());
    assert(revealTX.output(0).value === config.bid);
    assert(revealTX.output(0).covenant.type === types.REVEAL);

    // Verify convenants
    const convenants = revealTX.output(0).covenant.toArray();

    assert.bufferEqual(convenants[0], nameHash);
    assert(bio.readU32(convenants[1], 0) === ns.height);
    assert.bufferEqual(convenants[2], presign.nonce);

    // We really do not care what happens with the other outputs,
    // Alice can split them into multiple coins, donate it to miners
    const bobSigs = presign.signaturesBob.map(s => Buffer.from(s, 'hex'));

    // Technically these are malleable, but there is no need for other person
    // to mess with these.
    assert(revealTX.input(0).sequence === 0xffffffff);
    assert(revealTX.input(1).sequence === 0xffffffff);
    assert(revealTX.locktime === 0);

    // Ensure fee is high enough for reveal to go through, worst case scenario,
    // since ANYONECANPAY is used, we can sacrifice some low value coin to pay the fee.
    const feeRate = await wdb.estimateFee(3); //
    const size = await revealTX.estimateSize(); // TODO: Pass in a custom size estimator for witness items
    const minFee = policy.getRoundFee(size,feeRate);

    assert(presign.txFee >= minFee);

    // Sign the inputs, now it may seem like a bad idea signing this before verifying,
    // but we'll do that shortly and these are presigns
    const sig0 = revealTX.signature(0, bidScript, config.bid + config.blind, aliceKey1.privateKey, ALL | NOINPUT | ANYONECANPAY);
    const sig1 = revealTX.signature(1, fundingScript, config.bid + config.fee + presign.txFee, aliceKey2.privateKey, ALL | NOINPUT | ANYONECANPAY);

    // Push signatures into witness records
    const witness0 = new Stack();
    witness0.pushData(sig0); // Put Alice's Signature here
    witness0.pushData(bobSigs[0]);
    witness0.pushBool(true);
    witness0.pushData(bidScript.encode());

    const witness1 = new Stack();
    witness1.pushData(sig1);
    witness1.pushData(bobSigs[1]);
    witness1.pushBool(true);
    witness1.pushData(fundingScript.encode());

    // Placeholder coins
    const coin1 = new Coin({
      height: 0,
      value: config.bid + config.blind,
      address: new Address().fromScript(bidScript),
      hash: Buffer.alloc(32, 0x00),
      index: 0
    });

    const coin2 = new Coin({
      height: 0,
      value: config.bid + config.fee + presign.txFee,
      address: new Address().fromScript(fundingScript),
      hash: Buffer.alloc(32, 0x00),
      index: 1
    });

    revealTX.view.addCoin(coin1);
    revealTX.view.addCoin(coin2);

    revealTX.inputs[0].witness.fromStack(witness0);
    revealTX.inputs[1].witness.fromStack(witness1);

    // Ensure Fee is high enough
    assert(revealTX.getFee() === presign.txFee);
    // Verify the transaction, this will take care of signatures too!
    assert(revealTX.verify());

    glob.revealTX = revealTX;
    presign.signaturesAlice = [sig0.toString('hex'), sig1.toString('hex')];
    // All that needs to be set is appropriate prevouts, send signatures to Bob
  });

  it('should verify signatures sent by Alice - Bob', async () => {
    const bobSigs = presign.signaturesBob.map(s => Buffer.from(s, 'hex'));
    const aliceSigs = presign.signaturesAlice.map(s => Buffer.from(s, 'hex'));

    const witness0 = new Stack();
    witness0.pushData(aliceSigs[0]); // Put Alice's Signature here
    witness0.pushData(bobSigs[0]);
    witness0.pushBool(true);
    witness0.pushData(Buffer.from(presign.bidScript, 'hex'));

    const witness1 = new Stack();
    witness1.pushData(aliceSigs[1]);
    witness1.pushData(bobSigs[1]);
    witness1.pushBool(true);
    witness1.pushData(Buffer.from(presign.fundingScript, 'hex'));

    bobRevealTX.inputs[0].witness.fromStack(witness0);
    bobRevealTX.inputs[1].witness.fromStack(witness1);
    assert(bobRevealTX.verify());
  });

  it('should start watching both funding and bid address', async () => {
    glob.fundingAddress = new Address().fromScript(glob.fundingScript);
    glob.bidAddress = new Address().fromScript(glob.bidScript);

    watchOnly.importAddress('default', glob.fundingAddress);
    watchOnly.importAddress('default', glob.bidAddress);
  });

  it('should fund the funding script - Alice', async () => {
    const out = new Output({
      address: glob.fundingAddress,
      value: config.bid + config.fee + presign.txFee
    });

    // Optional NullAddress to backup Bob's pubkey and maybe a index;
    // Compressed public keys are ~33 bytes

    // const out2 = new Output({
    //   address: new Address().fromNulldata(bobKey.publicKey),
    //   value: 0,
    // })

    const tx = await alice.send({
      outputs: [out]
    });
    // Tell Bob we funded the funding script :)
    glob.fundingTX = tx;
    const view = await alice.getSpentView(tx);
    aliceLoss += tx.getFee(view);
  });

  it('should verify funding transaction - Bob', async () => {
    // Bob waits 3 blocks for funding transaction to confirm
    await mineBlocks(4);
    // Verify fundingTX
    const tx = await watchOnly.getTX(glob.fundingTX.hash());

    // Verify fund has atleast 3 confirmations
    // This is very important cause a double spend
    // can cause bob to lose all his funds
    const currentHeight = node.chain.tip.height;
    assert(tx.height + 3 <= currentHeight);

    // Fund the funding output
    let fundingOutput = null;
    let fundingOutputIndex;
    for(const index in tx.tx.outputs) {
      const output = tx.tx.outputs[index];
      if(output.address.toString() === glob.fundingAddress.toString()) {
        fundingOutput = output;
        fundingOutputIndex = parseInt(index);
      }
    }
    assert(fundingOutput, 'Funding Transaction does not fund the address');
    assert(fundingOutput.value === config.bid + config.fee + presign.txFee);
    assert(fundingOutput.covenant.type === types.NONE);
    // You never know :P
    assert(fundingOutput.address.toString() === glob.fundingAddress.toString());

    glob.fundingPrevout = {
      tx: tx,
      hash: tx.tx.hash(),
      index: fundingOutputIndex
    };
  });

  it('should BID on name - Bob', async () => {
    const start = ns.height;
    // Generate blind from nonce
    const blind = rules.blind(config.bid, Buffer.from(presign.nonce,'hex'));
    const rawName = Buffer.from(name, 'ascii');

    const output = new Output();
    output.address = glob.bidAddress;
    output.value = config.bid + config.blind;
    output.covenant.type = types.BID;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(start);
    output.covenant.push(rawName);
    output.covenant.pushHash(blind);

    const mtx = new MTX();
    mtx.outputs.push(output);

    const unlock = await bob.fundLock.lock();
    let tx;
    try {
      await bob.fill(mtx);
      await bob.finalize(mtx);
      tx = await bob.sendMTX(mtx); // Verifies, signs and broadcasts;
    } finally {
      unlock();
    }
    assert(tx);
    glob.bidTX = tx;
    const view = await bob.getSpentView(tx);
    bobLoss += tx.getFee(view);
  });

  it('Verify bid by bob - Alice', async () => {
    await mineBlocks(1);
    // Verify bidTX, this will also be done by the trusted third party
    // to decide wheteher to punish Bob or not.
    const tx = await watchOnly.getTX(glob.bidTX.hash());
    assert(tx);

    const rawName = Buffer.from(name, 'ascii');
    const blind = rules.blind(config.bid, Buffer.from(presign.nonce,'hex'));

    let bidOutput = null;
    let bidOutputIndex = -1;
    for(const index in tx.tx.outputs) {
      const output = tx.tx.outputs[index];
      if(output.address.toString() === glob.bidAddress.toString()) {
        bidOutput = output;
        bidOutputIndex = parseInt(index);
      }
    }

    glob.bidPrevout = {
      tx: tx,
      hash: tx.tx.hash(),
      index: bidOutputIndex
    };

    assert(bidOutput);
    assert(bidOutput.value = config.bid + config.blind);

    const covenants = bidOutput.covenant.toArray();
    assert(bidOutput.covenant.type === types.BID);
    assert.bufferEqual(covenants[0], nameHash);
    assert(bio.readU32(covenants[1], 0) === ns.height);
    assert.bufferEqual(covenants[2], rawName);
    assert.bufferEqual(covenants[3], blind);
  });

  it('should wait for reveal phase to start and reveal - Bob or Alice', async () => {
    // Either parties can reveal, but Alice has little incentive to reveal
    // so bob has to ensure that he reveals on time
    const currentHeight = node.chain.tip.height;
    const {
      treeInterval,
      biddingPeriod
    } = network.names;

    const openPeriod = treeInterval + 1;
    const revealHeight = ns.height + openPeriod + biddingPeriod;

    if(currentHeight < revealHeight) {
      await mineBlocks(revealHeight - currentHeight);
    }

    assert(ns.isReveal(node.chain.tip.height, network));

    // Just a hack to add entries to the view so we can verify the tx
    const coin0 = new Coin().fromTX(glob.bidPrevout.tx.tx, glob.bidPrevout.index, glob.bidPrevout.tx.height);
    const coin1 = new Coin().fromTX(glob.fundingPrevout.tx.tx, glob.fundingPrevout.index, glob.fundingPrevout.tx.height);

    // Bob can reveal now
    const mtx = glob.revealTX;
    mtx.input(0).prevout = new Outpoint(glob.bidPrevout.hash, glob.bidPrevout.index);
    mtx.input(1).prevout = new Outpoint(glob.fundingPrevout.hash, glob.fundingPrevout.index);
    mtx.view.addCoin(coin0);
    mtx.view.addCoin(coin1);

    assert(mtx.verify());
    await node.sendTX(mtx.toTX());
    await mineBlocks(1);
  });

  it('should verify everyone recieved funds correctly', async () => {
    const aliceBal = await alice.getBalance();
    const bobBal = await bob.getBalance();

    // Alice pays for
    // TX fee for funding
    // The bid and staker's fee
    // and TX fee for the reveal
    // (optionally) TX fee for open
    aliceLoss += config.bid + config.fee + presign.txFee;

    assert(aliceBal.confirmed === 4000 * 1e6 -  aliceLoss);

    // Bob gains his fee (subtract tx fee for the bid)
    // His fee should be high enough to cover the tx fees
    const bobGain = config.fee - bobLoss;
    assert(bobGain > 0);
    assert(bobBal.confirmed === 4000 * 1e6 + bobGain);
  });

  it('should register name', async () => {
    // Skip past the reveal phase
    const currentHeight = node.chain.tip.height;
    const {
      treeInterval,
      biddingPeriod,
      revealPeriod
    } = network.names;
    const revealEnd = ns.height + treeInterval + 1 + biddingPeriod + revealPeriod;

    if(currentHeight < revealEnd) {
      await mineBlocks(revealEnd - currentHeight);
    }
    ns = await alice.getNameStateByName(name);
    assert(ns.isClosed(node.chain.tip.height, network));
    assert.bufferEqual(ns.owner.hash, glob.revealTX.hash());
    assert(ns.owner.index === 0);

    // Alice should be able to register the name
    const mtx = new MTX();

    const output = new Output();
    output.address = glob.bidAddress;
    output.value = ns.value;

    output.covenant.type = types.REGISTER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(Buffer.alloc(0));
    output.covenant.pushHash(await wdb.getRenewalBlock());
    mtx.outputs.push(output);

    const tx = await watchOnly.getTX(glob.revealTX.hash());
    const nameCoin = Coin.fromTX(tx.tx, 0, tx.height);
    mtx.addCoin(nameCoin);

    mtx.setLocktime(node.chain.tip.height);
    // Now time to sign it
    await alice.fund(mtx);
    await alice.sign(mtx);
    const sig = mtx.signature(0, glob.bidScript, nameCoin.value, aliceKey1.privateKey, ALL);

    const witness = new Stack();
    witness.pushData(sig);
    witness.pushBool(false);
    witness.pushData(glob.bidScript.encode());

    mtx.inputs[0].witness.fromStack(witness);
    assert(mtx.verify());
    await node.sendTX(mtx.toTX());
    await mineBlocks(1);

    ns = await alice.getNameStateByName(name);
    assert(ns.registered);
  });

  it('should transfer name', async () => {
    ns = await alice.getNameStateByName(name);

    const mtx = new MTX();

    const {hash, index} = ns.owner;
    const nameCoin = await node.getCoin(hash, index);
    mtx.addCoin(nameCoin);

    const output = new Output();
    output.address = glob.bidAddress;
    output.value = ns.value;

    const address = await alice.receiveAddress();
    output.covenant.type = types.TRANSFER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.pushU8(address.version);
    output.covenant.push(address.hash);
    mtx.outputs.push(output);

    mtx.setLocktime(node.chain.tip.height);
    // Now time to sign it
    await alice.fund(mtx);
    await alice.sign(mtx);
    const sig = mtx.signature(0, glob.bidScript, nameCoin.value, aliceKey1.privateKey, ALL);

    const witness = new Stack();
    witness.pushData(sig);
    witness.pushBool(false);
    witness.pushData(glob.bidScript.encode());

    mtx.inputs[0].witness.fromStack(witness);
    assert(mtx.verify());
    await node.sendTX(mtx.toTX());
    await mineBlocks(1);
  });

  it('should finalize name transfer', async () => {
    // We wait out the transfer lockup time
    await mineBlocks(network.names.transferLockup + 1);

    ns = await alice.getNameStateByName(name);

    const {hash, index} = ns.owner;
    const nameCoin = await node.getCoin(hash, index);

    const version = nameCoin.covenant.getU8(2);
    const addr = nameCoin.covenant.get(3);
    const address = Address.fromHash(addr, version);
    const rawName = Buffer.from(name, 'ascii');

    // Alice should be able to register the name
    const mtx = new MTX();
    mtx.addCoin(nameCoin);

    const output = new Output();
    output.address = address;
    output.value = ns.value;

    output.covenant.type = types.FINALIZE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(rawName);
    output.covenant.pushU8(0); // this name was part of a bid so
    output.covenant.pushU32(ns.claimed);
    output.covenant.pushU32(ns.renewals);
    output.covenant.pushHash(await wdb.getRenewalBlock());
    mtx.outputs.push(output);

    mtx.setLocktime(node.chain.tip.height);
    // Now time to sign it
    await alice.fund(mtx);
    await alice.sign(mtx);

    const sig = mtx.signature(0, glob.bidScript, nameCoin.value, aliceKey1.privateKey, ALL);

    const witness = new Stack();
    witness.pushData(sig);
    witness.pushBool(false);
    witness.pushData(glob.bidScript.encode());

    mtx.inputs[0].witness.fromStack(witness);
    assert(mtx.verify());
    await node.sendTX(mtx.toTX());
    await mineBlocks(1);
  });

  it('should verify name got transferred', async () => {
    const ns = await node.getNameStatus(nameHash);
    const owner = ns.owner;
    const coin = await alice.getCoin(owner.hash, owner.index);
    assert(coin);

    const resource = Resource.fromJSON({
      records: [{type: 'TXT', txt: ['Thanks Bob! -- Alice']}]
    });
    await alice.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);
    const actual = await node.chain.db.getNameState(nameHash);
    assert.bufferEqual(resource.encode(), actual.data);
  });
});
