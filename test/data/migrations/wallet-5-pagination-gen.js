'use strict';

/**
 * NOTE, patch is necessary to run this migration gen script for older v6.
diff --git a/test/util/wallet.js b/test/util/wallet.js
index 7d2b9029..354c6105 100644
--- a/test/util/wallet.js
+++ b/test/util/wallet.js
@@ -20,7 +20,7 @@ walletUtils.fakeBlock = (height, prevSeed = 0, seed = prevSeed) => {
     hash: hash,
     prevBlock: prev,
     merkleRoot: root,
-    time: 500000000 + (height * (10 * 60)),
+    time: 1580745078 + (height * (10 * 60)),
     bits: 0,
     nonce: 0,
     height: height,
 */

const assert = require('bsert');
const bdb = require('bdb');
const Network = require('../../../lib/protocol/network');
const Block = require('../../../lib/primitives/block');
const ChainEntry = require('../../../lib/blockchain/chainentry');
const WalletDB = require('../../../lib/wallet/walletdb');
const MTX = require('../../../lib/primitives/mtx');
const wutils = require('../../../test/util/wallet');

const layout = {
  wdb: {
    V: bdb.key('V'),

    // h[height] -> block hash
    h: bdb.key('h', ['uint32']),

    // W[wid] -> wallet id
    W: bdb.key('W', ['uint32']),

    // P[wid][addr-hash] -> path data
    P: bdb.key('P', ['uint32', 'hash'])
  },
  txdb: {
    prefix: bdb.key('t', ['uint32']),

    // Latest unconfirmed Index.
    I: bdb.key('I'),

    // Coin - we need this in order to find accounts.
    // c[tx-hash][index] -> coin
    c: bdb.key('c', ['hash256', 'uint32']),
    // We need this for spent inputs in blocks.
    // d[tx-hash][index] -> undo coin
    d: bdb.key('d', ['hash256', 'uint32']),

    // these two are no longer used.
    m: bdb.key('m', ['uint32', 'hash256']),
    M: bdb.key('M', ['uint32', 'uint32', 'hash256']),

    // these are not affected by the migration, but here for reference
    // and time check.
    t: bdb.key('t', ['hash256']),
    T: bdb.key('T', ['uint32', 'hash256']),

    // Transaction.
    // z[height][index] -> tx hash (tx by count)
    z: bdb.key('z', ['uint32', 'uint32']),
    // Z[account][height][index] -> tx hash (tx by count + account)
    Z: bdb.key('Z', ['uint32', 'uint32', 'uint32']),
    // y[hash] -> count (count for tx)
    y: bdb.key('y', ['hash256']),
    // x[hash] -> undo count (unconfirmed count for tx)
    x: bdb.key('x', ['hash256']),

    // Confirmed.
    // these are used to recover heights [+ accounts] of txs.

    // b[height] -> block record
    b: bdb.key('b', ['uint32']),
    // h[height][tx-hash] -> dummy (tx by height)
    h: bdb.key('h', ['uint32', 'hash256']),
    // H[account][height][tx-hash] -> dummy (tx by height + account)
    H: bdb.key('H', ['uint32', 'uint32', 'hash256']),

    // g[time][height][index][hash] -> dummy (tx by time)
    g: bdb.key('g', ['uint32', 'uint32', 'uint32', 'hash256']),
    // G[account][time][height][index][hash] -> dummy (tx by time + account)
    G: bdb.key('G', ['uint32', 'uint32', 'uint32', 'uint32', 'hash256']),

    // Unconfirmed.
    // w[time][count][hash] -> dummy (tx by time)
    w: bdb.key('w', ['uint32', 'uint32', 'hash256']),
    // W[account][time][count][hash] -> dummy (tx by time + account)
    W: bdb.key('W', ['uint32', 'uint32', 'uint32', 'hash256']),
    // e[hash] -> undo time (unconfirmed time for tx)
    e: bdb.key('e', ['hash256'])
  }
};

const NETWORK = Network.get('regtest');

const wallet1priv = 'rprvKE8qsHtkmUxUSPQdn2sFKFUcKyUQz9pKQhxjEWecnXg9hgJMsmJXcw'
  + 'J77SqmHT1R6mcuNqVPzgT2EoGStsXaUN92VJKhQWUB6uZdL8gAZvez';
const wallet2priv = 'rprvKE8qsHtkmUxUSR4jE7Lti9XV77hv7xxacAShw5MvxY6RfsAYVeB1WL'
  + 'WtjiebDmqTruVJxmMeQUMkk61e83WDZbZidDnNPhHyQpeEwxjuSZuG';

let txID = 0;
let timeCounter = 0;

(async () => {
  const block = Block.decode(NETWORK.genesisBlock);
  const entry = ChainEntry.fromBlock(block);
  const headerEntries = [
    entry
  ];
  const seenHeights = new Set();

  const wdb = new WalletDB({
    network: NETWORK,
    memory: true,
    nowFn: () => timeCounter
  });

  await wdb.open();

  const nextEntry = () => {
    const next = wutils.nextEntry(wdb);

    if (!seenHeights.has(next.height)) {
      headerEntries.push(next);
      seenHeights.add(next.height);
    }
    return next;
  };

  const wallet1 = await wdb.create({
    id: 'wallet1',
    master: wallet1priv
  });

  await wallet1.createAccount('alt');

  const wallet2 = await wdb.create({
    id: 'wallet2',
    master: wallet2priv
  });

  // add 100 blocks to the wallet.
  for (let i = 0; i < 100; i++)
    await wdb.addBlock(nextEntry(), []);

  // fund wallets
  const txs1 = await fundThree(wallet1, wallet2);
  await wdb.addBlock(nextEntry(), txs1);

  // Now let's send 5 more transactions to each wallet.
  // Seen directly in the block.
  for (let i = 0; i < 5; i++) {
    const txs = await fundThree(wallet1, wallet2);
    await wdb.addBlock(nextEntry(), txs);
  }

  // Now let's send 5 more transactions to each wallet.
  // Each in mempool first and then in the block.
  for (let i = 0; i < 5; i++) {
    const txs = await fundThree(wallet1, wallet2);
    for (const tx of txs) {
      timeCounter++;
      await wdb.addTX(tx);
    }

    await wdb.addBlock(nextEntry(), txs);
  }

  // Spend some coins.
  const spendTXs1 = await spendThree(txs1, wallet1, wallet2);
  await wdb.addBlock(nextEntry(), spendTXs1);

  const spendCrossAcctConfirmed = new MTX();
  // spend receive.
  spendCrossAcctConfirmed.addTX(spendTXs1[0], 0);
  spendCrossAcctConfirmed.addOutput(await wallet1.receiveAddress(1), 5e6);
  await wallet1.sign(spendCrossAcctConfirmed);
  const spendCrossAcctConfirmedTX = spendCrossAcctConfirmed.toTX();
  await wdb.addTX(spendCrossAcctConfirmedTX);
  await wdb.addBlock(nextEntry(), [spendCrossAcctConfirmedTX]);

  // just empty block.
  await wdb.addBlock(nextEntry(), []);

  // ---
  // UNCONFIRMED TERRITORY
  // ---

  // Now let's send 5 more transactions to each wallet.
  // All unconfirmed
  for (let i = 0; i < 5; i++) {
    const txs = await fundThree(wallet1, wallet2);

    for (const tx of txs) {
      timeCounter++;
      await wdb.addTX(tx);
    }
  }

  const unconfirmed = await fundThree(wallet1, wallet2);

  for (const tx of unconfirmed) {
    timeCounter++;
    await wdb.addTX(tx);
  }

  // Spend unconfirmed.
  const spendUnconfirmed = await spendThree(unconfirmed, wallet1, wallet2);
  for (const tx of spendUnconfirmed) {
    timeCounter++;
    await wdb.addTX(tx);
  }

  timeCounter++;
  const spendCrossAcctUnconfirmed = new MTX();
  // spend change.
  spendCrossAcctUnconfirmed.addTX(spendTXs1[0], 1);
  spendCrossAcctUnconfirmed.addOutput(await wallet1.receiveAddress(1), 5e6);
  await wallet1.sign(spendCrossAcctUnconfirmed);
  await wdb.addTX(spendCrossAcctUnconfirmed.toTX());

  // Confirm -> Unconfirm
  {
    const txs = await fundThree(wallet1, wallet2);
    const next2unconf = nextEntry();

    for (const tx of txs) {
      timeCounter++;
      await wdb.addTX(tx);
    }

    await wdb.addBlock(next2unconf, txs);
    await wdb.removeBlock(next2unconf);
  }

  // Confirm -> Unconfirm -> Confirm
  // Unfortunately, this can't be migrated directly. There will be
  // a discrepancy between the old and new state, as the new state
  // will track mempool tx counts as they come in, and they never get
  // removed. The full migration cannot account for this,
  // as the data for it does not exist, but it's a minor issue.
  // {
  //   const txs = await fundThree(wallet1, wallet2);
  //   const next2unconf = nextEntry();

  //   for (const tx of txs) {
  //     timeCounter++;
  //     await wdb.addTX(tx);
  //   }

  //   await wdb.addBlock(next2unconf, txs);
  //   await wdb.removeBlock(next2unconf);
  //   await wdb.addBlock(next2unconf, txs);
  // }

  // Hack for the second block.
  headerEntries[1].prevBlock = headerEntries[0].hash;

  const dump = await getMigrationDump(wdb);
  console.log(JSON.stringify({
    data: dump,
    headers: headerEntries
  }, null, 2));

  await wdb.close();
})().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});

async function fundThree(wallet1, wallet2) {
  timeCounter++;
  const mtx1 = new MTX();
  mtx1.addInput(wutils.deterministicInput(txID++));
  mtx1.addOutput(await wallet1.receiveAddress(0), 10e6);

  timeCounter++;
  const mtx2 = new MTX();
  mtx2.addInput(wutils.deterministicInput(txID++));
  mtx2.addOutput(await wallet1.receiveAddress(1), 10e6);

  timeCounter++;
  const mtx3 = new MTX();
  mtx3.addInput(wutils.deterministicInput(txID++));
  mtx3.addOutput(await wallet2.receiveAddress(), 10e6);

  return [
    mtx1.toTX(),
    mtx2.toTX(),
    mtx3.toTX()
  ];
}

async function spendThree(three, wallet1, wallet2) {
  timeCounter++;
  const mtx1 = new MTX();
  mtx1.addTX(three[0], 0);
  mtx1.addOutput(await wallet1.receiveAddress(0), 5e6);
  mtx1.addOutput(await wallet1.changeAddress(0), 5e6);
  await wallet1.sign(mtx1);

  timeCounter++;
  const mtx2 = new MTX();
  mtx2.addTX(three[1], 0);
  mtx2.addOutput(await wallet1.receiveAddress(1), 5e6);
  mtx2.addOutput(await wallet1.changeAddress(1), 5e6);
  await wallet1.sign(mtx2);

  timeCounter++;
  const mtx3 = new MTX();
  mtx3.addTX(three[2], 0);
  mtx3.addOutput(await wallet2.receiveAddress(), 5e6);
  mtx3.addOutput(await wallet2.changeAddress(), 5e6);
  await wallet2.sign(mtx3);

  assert(mtx1.verify());
  assert(mtx2.verify());
  assert(mtx3.verify());

  return [
    mtx1.toTX(),
    mtx2.toTX(),
    mtx3.toTX()
  ];
}

async function getMigrationDump(wdb) {
  const prefixes = [
    'V'.charCodeAt(0).toString(16),
    'h'.charCodeAt(0).toString(16)
  ];

  // wdb prefixes per wallet..
  for (let i = 1; i < 3; i++) {
    prefixes.push(layout.wdb.W.encode(i).toString('hex'));
    const path = layout.wdb.P.encode(i, Buffer.alloc(32));
    const pathPrefix = path.slice(0, 1 + 4).toString('hex');
    prefixes.push(pathPrefix);
  }

  for (let i = 1; i < 3; i++) {
    const tprefix = layout.txdb.prefix.encode(i).toString('hex');

    for (const key of Object.keys(layout.txdb)) {
      if (key === 'prefix')
        continue;

      const val = layout.txdb[key];

      assert(val.id.toString('hex') === key.charCodeAt(0).toString(16));
      const prefix = key.charCodeAt(0).toString(16);
      // console.error(`${key} -> ${tprefix + prefix}`);
      // console.error(`${tprefix + prefix} -> ${key}`);
      prefixes.push(tprefix + prefix);
    }
  }

  // console.log(prefixes);
  const dump = await wutils.dumpWDB(wdb, prefixes);
  return dump;
};
