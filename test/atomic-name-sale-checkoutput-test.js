/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Script = require('../lib/script/script');
const Opcode = require('../lib/script/opcode');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const Output = require('../lib/primitives/output');
const Input = require('../lib/primitives/input');
const Address = require('../lib/primitives/address');
const rules = require('../lib/covenants/rules');
const Resource = require('../lib/dns/resource');

const network = Network.get('regtest');

const node = new FullNode({
  memory: true,
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');
const name = rules.grindName(10, 20, network);
const salePrice = 123456789;
let owner, buyer, ownerAddr, buyerAddr;
let paymentAddr, transferAddr, saleAddr, script;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Atomic name sale with CHECKOUTPUT', function() {
  before(async () => {
    await node.open();

    owner = await wdb.create();
    ownerAddr = await owner.createReceive();
    owner.createAccount({name: 'payment'});
    paymentAddr = await owner.createReceive('payment');
    ownerAddr = ownerAddr.getKeyAddress().toString('regtest');
    paymentAddr = paymentAddr.getKeyAddress();

    buyer = await wdb.create();
    buyerAddr = await buyer.createReceive();
    transferAddr = await buyer.createReceive();
    buyerAddr = buyerAddr.getKeyAddress().toString('regtest');
    transferAddr = transferAddr.getKeyAddress();
  });

  after(async () => {
    await node.close();
  });

  it('should fund both wallets', async () => {
    await mineBlocks(10, ownerAddr);
    await mineBlocks(10, buyerAddr);

    // Wallet rescan is an effective way to ensure that
    // wallet and chain are synced before proceeding.
    await wdb.rescan(0);

    const ownerBal = await owner.getBalance();
    const buyerBal = await owner.getBalance();
    assert(ownerBal.confirmed === 2000 * 10 * 1e6);
    assert(buyerBal.confirmed === 2000 * 10 * 1e6);
  });

  it('should run an entire auction until a name is owned', async () => {
    await owner.sendOpen(name, false);
    await mineBlocks(network.names.treeInterval + 2);
    let ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isBidding(node.chain.height, network));

    await wdb.rescan(0);

    await owner.sendBid(name, 100000, 200000);
    await mineBlocks(network.names.biddingPeriod);
    ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isReveal(node.chain.height, network));

    await wdb.rescan(0);

    await owner.sendReveal(name);
    await mineBlocks(network.names.revealPeriod);
    ns = await node.chain.db.getNameStateByName(name);
    assert(ns.isClosed(node.chain.height, network));

    await wdb.rescan(0);

    const resource = Resource.fromJSON({
      text: ['Delicious Handhsake name for sale!']
    });

    await owner.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);

    await wdb.rescan(0);

    ns = await node.chain.db.getNameStateByName(name);

    // Owner owns the name.
    let coin = await owner.getCoin(ns.owner.hash, ns.owner.index);
    assert(coin);

    coin = await buyer.getCoin(ns.owner.hash, ns.owner.index);
    assert(!coin);
  });

  it('should transfer name to sale script', async () => {
    script = new Script([
      Opcode.fromSymbol('OP_TYPE'),
      Opcode.fromInt(rules.types.TRANSFER),
      Opcode.fromSymbol('OP_EQUAL'),
      Opcode.fromSymbol('OP_IF'),
        Opcode.fromInt(1),  // Output index to check
        Opcode.fromInt(paymentAddr.version),
        Opcode.fromData(paymentAddr.hash),
        Opcode.fromInt(salePrice),
        Opcode.fromSymbol('OP_CHECKOUTPUT'),
      Opcode.fromSymbol('OP_ELSE'),
        Opcode.fromSymbol('OP_TYPE'),
        Opcode.fromInt(rules.types.FINALIZE),
        Opcode.fromSymbol('OP_EQUAL'),
      Opcode.fromSymbol('OP_ENDIF')
    ]);

    saleAddr = Address.fromScript(script);

    await owner.sendTransfer(name, saleAddr);
    await mineBlocks(network.names.transferLockup);

    await wdb.rescan(0);

    const finalize = await owner.sendFinalize(name);
    await mineBlocks(network.names.treeInterval);

    await wdb.rescan(0);

    // Name is now controlled by above script in a FINALIZE.
    const ns = await node.chain.db.getNameStateByName(name);
    assert.bufferEqual(finalize.hash(), ns.owner.hash);
  });

  it('should transfer money to owner and name to buyer', async () => {
    /*
     * If the above script format is accepted as a standard and globally known,
     * then at this point the name owner only needs to announce (in plain text):
     *  1. The name for sale
     *  2. The payment address
     *  3. The sale price
     *
     * (and actually if the buyer has --index-address turned on,
     * they could even figure out which name is for sale on their own!)
     *
     * The buyer can recreate the redeem script from the owner's offer data
     * and verify that the name is owned by that script, including the
     * impossibility of the transfer being REVOKE'd.
     */

    // Buyer retrieves namestate to get owner outpoint
    let ns = await node.chain.db.getNameStateByName(name);
    const coin = await node.chain.getCoin(ns.owner.hash, ns.owner.index);

    // Output 0: the TRANSFER, sends to same address and value as current owner.
    const output0 = new Output();
    output0.address = coin.address;
    output0.value = coin.value;

    // Buyer adds their own receive address to covenant.
    output0.covenant.type = rules.types.TRANSFER;
    output0.covenant.pushHash(ns.nameHash);
    output0.covenant.pushU32(ns.height);
    output0.covenant.pushU8(transferAddr.version);
    output0.covenant.push(transferAddr.hash);

    // Output 1: the payout. Money goes to owner, satisfying OP_CHECKOUTPUT.
    const output1 = new Output();
    output1.address = paymentAddr;
    output1.value = salePrice;

    // First add the money stuff so wallet can fund and create change output.
    // wallet.fund() doesn't work if mtx already has inputs...
    const mtx = new MTX();
    mtx.outputs.push(output1);
    // Preemptively double the fee because half the tx is still missing
    await buyer.fund(mtx, {rate: network.feeRate * 2});

    // Insert the name covenants as input 0 and output 0
    mtx.outputs.unshift(output0);
    mtx.inputs.unshift(Input.fromCoin(coin));

    // Insert seralized script into witness of input 0 -- no signature needed!
    mtx.inputs[0].witness.push(script.toRaw());
    mtx.view.addCoin(coin);

    // Sign (the payment input) & send
    await buyer.sign(mtx);
    assert(mtx.verify());
    const tx = mtx.toTX();
    await node.sendTX(tx);

    // Confirm
    await mineBlocks(network.names.transferLockup);
    await wdb.rescan(0);

    // Owner is paid
    const paymentBalance = await owner.getBalance('payment');
    assert.strictEqual(paymentBalance.confirmed, salePrice);

    // Name is owned by TRANSFER tx
    ns = await node.chain.db.getNameStateByName(name);
    assert.bufferEqual(ns.owner.hash, tx.hash());
  });

  it('should finalize the transfer', async () => {
    // Buyer retrieves namestate to get owner outpoint
    let ns = await node.chain.db.getNameStateByName(name);
    let coin = await node.chain.getCoin(ns.owner.hash, ns.owner.index);

    // Output 0: the FINALIZE
    const output0 = new Output();
    output0.address = transferAddr;
    output0.value = coin.value;
    output0.covenant.type = rules.types.FINALIZE;
    output0.covenant.pushHash(ns.nameHash);
    output0.covenant.pushU32(ns.height);
    output0.covenant.push(Buffer.from(name, 'ascii'));
    output0.covenant.pushU8(0);
    output0.covenant.pushU32(ns.claimed);
    output0.covenant.pushU32(ns.renewals);
    output0.covenant.pushHash(await wdb.getRenewalBlock());

    // Fund a no-value MTX. Yep, just a miner fee (make it a double).
    const mtx = new MTX();
    await buyer.fund(mtx, {rate: network.feeRate * 2});

    // Insert the name covenants as input 0 and output 0
    mtx.outputs.unshift(output0);
    mtx.inputs.unshift(Input.fromCoin(coin));

    // Insert seralized script into witness of input 0 -- no signature needed!
    mtx.inputs[0].witness.push(script.toRaw());
    mtx.view.addCoin(coin);

    // Sign (the payment input) & send
    await buyer.sign(mtx);
    assert(mtx.verify());
    const tx = mtx.toTX();
    await node.sendTX(tx);

    // Confirm
    await mineBlocks(1);
    await wdb.rescan(0);

    // Name is owned by BUYER
    ns = await node.chain.db.getNameStateByName(name);
    const buyerCoin = await buyer.getCoin(ns.owner.hash, ns.owner.index);
    assert(buyerCoin);

    coin = await node.chain.getCoin(ns.owner.hash, ns.owner.index);
    const buyerKey = await buyer.getKey(coin.address);
    assert(buyerKey);
  });
});
