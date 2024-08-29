'use strict';

// Works for walletdb version 2 to 3 migration.
// HSD v6 -> v7 migration.

const assert = require('bsert');
const bdb = require('bdb');
const Network = require('../../../lib/protocol/network');
const WalletDB = require('../../../lib/wallet/walletdb');
const MTX = require('../../../lib/primitives/mtx');
const wutils = require('../../../test/util/wallet');
const rules = require('../../../lib/covenants/rules');

const layout = {
  wdb: {
    V: bdb.key('V'),
    // W[wid] -> wallet id
    W: bdb.key('W', ['uint32'])
  },
  txdb: {
    prefix: bdb.key('t', ['uint32']),
    // t[tx-hash] -> extended tx (Read only)
    t: bdb.key('t', ['hash256']),
    // i[name-hash][tx-hash][index] -> txdb.BlindBid
    i: bdb.key('i', ['hash256', 'hash256', 'uint32']),
    // B[name-hash][tx-hash][index] -> txdb.BidReveal
    B: bdb.key('B', ['hash256', 'hash256', 'uint32']),
    // E[name-hash][tx-hash][index] -> bid to reveal out.
    E: bdb.key('E', ['hash256', 'hash256', 'uint32'])
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
  const wdb = new WalletDB({
    network: NETWORK,
    memory: true,
    nowFn: () => timeCounter++
  });

  await wdb.open();

  const wallet1 = await wdb.create({
    id: 'wallet1',
    master: wallet1priv
  });

  await wallet1.createAccount('alt');

  const wallet2 = await wdb.create({
    id: 'wallet2',
    master: wallet2priv
  });

  // add 10 blocks to the wallet.
  await mineBlocks(wdb, 100);

  // fund wallets
  const mtx1 = new MTX();
  mtx1.addInput(wutils.deterministicInput(txID++));
  mtx1.addOutput(await wallet1.receiveAddress(0), 10e6);

  const mtx2 = new MTX();
  mtx2.addInput(wutils.deterministicInput(txID++));
  mtx2.addOutput(await wallet1.receiveAddress(1), 10e6);

  // fund second wallet.
  const mtx3 = new MTX();
  mtx3.addInput(wutils.deterministicInput(txID++));
  mtx3.addOutput(await wallet2.receiveAddress(), 10e6);

  await wdb.addBlock(wutils.nextEntry(wdb), [
    mtx1.toTX(),
    mtx2.toTX(),
    mtx3.toTX()
  ]);

  const name1 = 'testname1';
  const name2 = 'testname2';

  const open1 = await wallet1.createOpen(name1, {
    account: 0
  });
  await wdb.addTX(open1.toTX());
  const open2 = await wallet1.createOpen(name2, {
    account: 0
  });

  await wdb.addBlock(wutils.nextEntry(wdb), [
    open1.toTX(),
    open2.toTX()
  ]);

  await mineBlocks(wdb, NETWORK.names.treeInterval + 1);

  const ns = await wallet1.getNameState(rules.hashName(name1));
  const bid1 = await wallet1.createBid(name1, 2e6, 2e6, {
    account: 0
  });

  const bid2 = await wallet1.createBid(name2, 2e6, 2e6, {
    account: 1
  });

  // wallet2 does not know the state of the name.
  const _getNameStatusBak = wdb.getNameStatus;
  wdb.getNameStatus = (nameHash) => {
    assert(Buffer.isBuffer(nameHash));
    assert(nameHash.equals(rules.hashName(name1)));

    return ns;
  };

  const bid3 = await wallet2.createBid(name1, 3e6, 3e6);
  await wdb.addBlock(wutils.nextEntry(wdb), [
    bid1.toTX(),
    bid2.toTX(),
    bid3.toTX()
  ]);

  wdb.getNameStatus = _getNameStatusBak;
  await mineBlocks(wdb, NETWORK.names.biddingPeriod);

  const reveal1 = await wallet1.createReveal(name1, {
    account: 0
  });

  const reveal2 = await wallet1.createReveal(name2, {
    account: 1
  });

  const reveal3 = await wallet2.createReveal(name1);

  await wdb.addBlock(wutils.nextEntry(wdb), [
    reveal1.toTX(),
    reveal2.toTX(),
    reveal3.toTX()
  ]);

  const dump = await getMigrationDump(wdb);
  console.log(JSON.stringify({
    data: dump
  }, null, 2));

  await wdb.close();
})().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});

async function mineBlocks(wdb, n) {
  for (let i = 0; i < n; i++) {
    const entry = wutils.nextEntry(wdb);
    await wdb.addBlock(entry, []);
  }
};

async function getMigrationDump(wdb) {
  const prefixes = [];

  for (let i = 1; i < 3; i++) {
    const tprefix = layout.txdb.prefix.encode(i).toString('hex');
    const ti = tprefix + 'i'.charCodeAt(0).toString(16);
    const tB = tprefix + 'B'.charCodeAt(0).toString(16);
    const tE = tprefix + 'E'.charCodeAt(0).toString(16);
    const tt = tprefix + 't'.charCodeAt(0).toString(16);
    prefixes.push(ti, tB, tE, tt);
  }

  for (let i = 0; i < 3; i++) {
    prefixes.push(layout.wdb.W.encode(i).toString('hex'));
  }

  const dump = await wutils.dumpWDB(wdb, prefixes);

  return dump;
};
