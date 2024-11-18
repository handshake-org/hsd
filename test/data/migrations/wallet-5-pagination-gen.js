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
const rules = require('../../../lib/covenants/rules');
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

    // Confirmed.
    // b[height] -> block record
    b: bdb.key('b', ['uint32']),
    // h[height][tx-hash] -> dummy (tx by height)
    h: bdb.key('h', ['uint32', 'hash256']),
    // H[account][height][tx-hash] -> dummy (tx by height + account)
    H: bdb.key('H', ['uint32', 'uint32', 'hash256']),

    // Count and Time Index.
    // prefix to the whole thing.
    O: bdb.key('O')
  }
};

const NETWORK = Network.get('regtest');

const OUT_ADDR = 'rs1q2uqpaefgfjke38whrtvdzsve3478k38qcgg9ws';

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

  // add 2 blocks to the wallet.
  for (let i = 0; i < 2; i++)
    await wdb.addBlock(nextEntry(), []);

  // fund wallets
  const txs1 = await fundThree(wallet1, wallet2);
  await wdb.addBlock(nextEntry(), txs1);

  const fundTXs = [];

  // Now let's send 5 more transactions to each wallet.
  // Seen directly in the block.
  for (let i = 0; i < 5; i++) {
    const txs = await fundThree(wallet1, wallet2);
    await wdb.addBlock(nextEntry(), txs);
    fundTXs.push(txs);
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

  // Some BIDs, it's is testing a special case in db
  // where tx may be part of the recorded block, but wallet
  // may not have the itself. That happens on BID/REVEAL/OPEN etc.
  // which are not sent from the wallet itself.
  //  Here, wallet1 and wallet2 txs will be separate but appear in both.
  const name2bid = 'name2bid';
  const txs = await createBids(
    fundTXs.shift(),
    wallet1,
    wallet2,
    name2bid,
    wdb.height - NETWORK.names.treeInterval
  );

  await wdb.addBlock(nextEntry(), txs);

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
  const txs = [];
  const funds = [
    [wallet1, 0],
    [wallet1, 1],
    [wallet2, 0]
  ];

  for (const [wallet, acct] of funds) {
    timeCounter++;
    const mtx1 = new MTX();
    mtx1.addInput(wutils.deterministicInput(txID++));
    mtx1.addOutput(await wallet.receiveAddress(acct), 10e6);
    mtx1.addOutput(OUT_ADDR, 1e6);
    txs.push(mtx1.toTX());
  }

  return txs;
}

async function spendThree(threeInputs, wallet1, wallet2) {
  const txs = [];
  const spends = [
    [wallet1, 0],
    [wallet1, 1],
    [wallet2, 0]
  ];

  let txi = 0;
  for (const [wallet, acct] of spends) {
    timeCounter++;
    const mtx = new MTX();
    mtx.addTX(threeInputs[txi++], 0);
    mtx.addOutput(await wallet.changeAddress(acct), 9e6);
    mtx.addOutput(OUT_ADDR, 1e6);
    await wallet.sign(mtx);

    txs.push(mtx.toTX());
  }

  return txs;
}

async function createBids(inputs, wallet1, wallet2, name, height) {
  const nameHash = rules.hashName(name);
  const rawName = Buffer.from(name, 'ascii');

  const bidVal = 1e6; // bid = blind

  const txs = [];
  const bids = [
    [wallet1, 0],
    [wallet1, 1],
    [wallet2, 0]
  ];

  let txi = 0;
  for (const [wallet, acct] of bids) {
    timeCounter++;
    const mtx = new MTX();
    const addr = await wallet.receiveAddress(acct);
    const blind = await wallet.generateBlind(nameHash, addr, bidVal);
    const bidOut = mtx.addOutput(addr, bidVal);
    mtx.addTX(inputs[txi++], 0);
    bidOut.covenant.setBid(nameHash, height, rawName, blind);
    await wallet.sign(mtx);
    txs.push(mtx.toTX());
  }

  return txs;
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
