/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const Script = require('../lib/script/script');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const {Resource} = require('../lib/dns/resource');
const {WalletClient} = require('hs-client');

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

let alice, bob, aliceReceive, bobReceive;
let aliceOriginalBalance, bobOriginalBalance, bobFee;

// These are data that will be communicated between Alice and Bob
const name = rules.grindName(5, 1, network);
const nameHash = rules.hashName(name);
const price = 1234567; // 1.234567 HNS
let blob;

async function mineBlocks(n, addr) {
  addr = addr ? addr : new Address().toString('regtest');
  for (let i = 0; i < n; i++) {
    const block = await node.miner.mineBlock(null, addr);
    await node.chain.add(block);
  }
}

describe('Interactive name swap', function() {
  before(async () => {
    await node.open();
    await wclient.open();

    alice = await wdb.create();
    bob = await wdb.create();

    aliceReceive = await alice.receiveAddress();
    bobReceive = await bob.receiveAddress();
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

  it('should not be able to send a TRANSFER before REGISTER', async () => {
    assert.rejects(async () => {
      await alice.sendTransfer(name, bobReceive);
    }, {
      message: 'Name must be registered.'
    });
  });

  it('should REGISTER', async () => {
    const resource = Resource.fromJSON({
      records: [{type: 'TXT', txt: ['Contact Alice to buy this name!']}]
    });
    await alice.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);
  });

  // Alice and Bob communicate and agree on a price.
  // Bob sends Alice an address to receive the name.

  it('should TRANSFER to Bob\'s wallet', async () => {
    await alice.sendTransfer(name, bobReceive);
    await mineBlocks(1);

    const ns = await alice.getNameStateByName(name);
    const json = ns.getJSON(node.chain.height, node.network);
    assert(json.transfer);
  });

  it('should record Alice and Bob\'s balances before FINALIZE', async () => {
    aliceOriginalBalance = await alice.getBalance();
    bobOriginalBalance = await bob.getBalance();
  });

  // Alice and Bob must wait at least 288 blocks (on mainnet)
  // before a FINALIZE is allowed. Any time before the FINALIZE
  // is confirmed, Alice can CANCEL and nothing is lost except
  // some miner fees and everybody's precious time.
  // Bob can see the TRANSFER on the blockchain and check that the
  // address in the covenant belongs to him, and thus track the status
  // of this transfer. If Bob sees TRANSFER->UPDATE (an effective cancel)
  // then he knows the deal is over and he needs to re-negotiate with Alice.

  it('should advance blockchain through lockup period', async () => {
    await mineBlocks(network.names.transferLockup);
  });

  it('should create a partially-signed FINALIZE', async () => {
    // Alice constructs an incomplete transaction.
    // input 0 and output 1 are committed by Alice's SINGLEREVERSE signature.
    // output 0 can be added by either party since it's construction is
    // dictated completely by consensus rules (it isn't signed yet).
    //
    // input 0: TRANSFER UTXO --> output 0: FINALIZE covenant
    //                 (null) --- output 1: payment to Alice

    const ns = await alice.getNameStateByName(name);
    const owner = ns.owner;
    const coin = await alice.getCoin(owner.hash, owner.index);

    const output0 = new Output();
    output0.value = coin.value;
    output0.address = bobReceive;
    output0.covenant.type = types.FINALIZE;
    output0.covenant.pushHash(nameHash);
    output0.covenant.pushU32(ns.height);
    output0.covenant.push(Buffer.from(name, 'ascii'));
    output0.covenant.pushU8(0); // flags, may be required if name was CLAIMed
    output0.covenant.pushU32(ns.claimed);
    output0.covenant.pushU32(ns.renewals);
    output0.covenant.pushHash(await wdb.getRenewalBlock());

    const output1 = new Output();
    output1.address = aliceReceive;
    output1.value = price;

    const mtx = new MTX();
    mtx.addCoin(coin);
    mtx.outputs.push(output0);
    mtx.outputs.push(output1);

    // Sign
    const rings = await alice.deriveInputs(mtx);
    assert(rings.length === 1);
    const signed = await mtx.sign(
      rings,
      Script.hashType.SINGLEREVERSE | Script.hashType.ANYONECANPAY
    );
    assert(signed === 1);

    assert(mtx.verify());

    // Alice sends this MTX to Bob.
    // Note that it is not a valid transaction yet because its
    // output value is greater than its input value.
    // The MTX must be transmitted to Bob out-of-band as a hex string.
    blob = mtx.encode().toString('hex');
  });

  it('should complete transaction', async () => {
    // Bob receives the hex string as a blob and decodes.
    const mtx = MTX.decode(Buffer.from(blob, 'hex'));

    // Bob should verify all the data in the MTX to ensure everything is valid,
    // but this is the minimum.
    const input0 = mtx.input(0).clone(); // copy input with Alice's signature
    const coinEntry = await node.chain.db.readCoin(input0.prevout);
    assert(coinEntry); // ensures that coin exists and is still unspent

    const coin = coinEntry.toCoin(input0.prevout);
    assert(coin.covenant.type === types.TRANSFER);
    const addr = new Address({
      version: coin.covenant.items[2].readInt8(),
      hash: coin.covenant.items[3]
    });
    assert.deepStrictEqual(addr, bobReceive); // transfer is to Bob's address

    // Fund the TX.
    // The hsd wallet is not designed to handle partially-signed TXs
    // or coins from outside the wallet, so a little hacking is needed.
    const changeAddress = await bob.changeAddress();
    const rate = await wdb.estimateFee();
    const coins = await bob.getSmartCoins();
    // Add the external coin to the coin selector so we don't fail assertions
    coins.push(coin);
    await mtx.fund(coins, {changeAddress, rate});
    // The funding mechanism starts by wiping out existing inputs
    // which for us includes Alice's signature. Replace it from our backup.
    mtx.inputs[0].inject(input0);

    // Rearrange outputs.
    // Since we added a change output, the SINGELREVERSE is now broken:
    //
    // input 0: TRANSFER UTXO --> output 0: FINALIZE covenant
    // input 1: Bob's funds   --- output 1: payment to Alice
    //                 (null) --- output 2: change to Bob
    const outputs = mtx.outputs.slice();
    mtx.outputs = [outputs[0], outputs[2], outputs[1]];

    // Prepare to wait for mempool acceptance (race condition)
    const waiter = new Promise((resolve, reject) => {
      node.mempool.once('tx', resolve);
    });

    // Sign & Broadcast
    // Bob uses SIGHASHALL. The final TX looks like this:
    //
    // input 0: TRANSFER UTXO --> output 0: FINALIZE covenant
    // input 1: Bob's funds   --- output 1: change to Bob
    //                 (null) --- output 2: payment to Alice
    const tx = await bob.sendMTX(mtx);
    bobFee = tx.getFee(mtx.view);
    assert(tx.verify(mtx.view));

    // Wait for mempool and check
    await waiter;
    assert(node.mempool.hasEntry(tx.hash()));

    // Confirm
    await mineBlocks(1);
  });

  it('should verify that name has been swapped', async () => {
    const aliceNewBalance = await alice.getBalance();
    const bobNewBalance = await bob.getBalance();

    // Alice got the monies
    // Note: This test works right now because the value of the name
    // Alice won in the auction is ZERO (she had the only bid)
    // See https://github.com/handshake-org/hsd/pull/464 for explanation
    // Currently hsd wallet does not account for FINALIZE correctly
    assert.strictEqual(
      aliceNewBalance.confirmed,
      aliceOriginalBalance.confirmed + price
    );
    assert.strictEqual(
      bobNewBalance.confirmed,
      bobOriginalBalance.confirmed - price - bobFee
    );

    // Bob got the name
    const ns = await node.getNameStatus(nameHash);
    const owner = ns.owner;
    let coin = await alice.getCoin(owner.hash, owner.index);
    assert(!coin);
    coin = await bob.getCoin(owner.hash, owner.index);
    assert(coin);

    const resource = Resource.fromJSON({
      records: [{type: 'TXT', txt: ['Thanks Alice! --Bob']}]
    });
    await bob.sendUpdate(name, resource);
    await mineBlocks(network.names.treeInterval);
    const actual = await node.chain.db.getNameState(nameHash);
    assert.bufferEqual(resource.encode(), actual.data);

    // The End
  });
});
