'use strict';

const assert = require('bsert');
const bdb = require('bdb');
const Network = require('../../../lib/protocol/network');
const MTX = require('../../../lib/primitives/mtx');
const WalletDB = require('../../../lib/wallet/walletdb');
const wutils = require('../../util/wallet');

const network = Network.get('regtest');

const layout = {
  wdb: {
    V: bdb.key('V'),

    // W[wid] -> wallet id
    W: bdb.key('W', ['uint32'])
  },
  txdb: {
    prefix: bdb.key('t', ['uint32']),

    // Coins
    c: bdb.key('c', ['hash256', 'uint32']),
    C: bdb.key('C', ['uint32', 'hash256', 'uint32']),
    d: bdb.key('d', ['hash256', 'uint32']),
    s: bdb.key('s', ['hash256', 'uint32']),

    // confirmed by Value
    Sv: bdb.key('Sv', ['uint64', 'hash256', 'uint32']),
    // confirmed by account + Value
    SV: bdb.key('SV', ['uint32', 'uint64', 'hash256', 'uint32']),
    // Unconfirmed by value
    Su: bdb.key('Su', ['uint64', 'hash256', 'uint32']),
    // Unconfirmed by account + value
    SU: bdb.key('SU', ['uint32', 'uint64', 'hash256', 'uint32']),
    // by height
    Sh: bdb.key('Sh', ['uint32', 'hash256', 'uint32']),
    // by account + height
    SH: bdb.key('SH', ['uint32', 'uint32', 'hash256', 'uint32'])
  }
};

/** @typedef {import('../../util/wallet').InboundTXOptions} InboundTXOptions */
/** @typedef {import('../../util/wallet').OutputInfo} OutputInfo */

/*
 * Generate a wallet with coins in multiple states,
 * similar to coin selection indexes test at test/wallet-coinselection-test.js
 */

const OUT_ADDR = 'rs1q2uqpaefgfjke38whrtvdzsve3478k38qcgg9ws';

const wallet1priv = 'rprvKE8qsHtkmUxUSPQdn2sFKFUcKyUQz9pKQhxjEWecnXg9hgJMsmJXcw'
  + 'J77SqmHT1R6mcuNqVPzgT2EoGStsXaUN92VJKhQWUB6uZdL8gAZvez';
const wallet2priv = 'rprvKE8qsHtkmUxUSR4jE7Lti9XV77hv7xxacAShw5MvxY6RfsAYVeB1WL'
  + 'WtjiebDmqTruVJxmMeQUMkk61e83WDZbZidDnNPhHyQpeEwxjuSZuG';

(async () => {
  // we use legacy selection to ensure
  // deterministic coin selections.
  const selection = 'value';

  const wdb = new WalletDB({
    network: network,
    memory: true
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

  for (let i = 0; i < 5; i++) {
    await wdb.addBlock(wutils.nextEntry(wdb), []);
  }

  /** @type {OutputInfo[]} */
  const outputs = Array.from({ length: 15 }, () => {
    return {
      value: 1e6
    };
  });

  /** @type {InboundTXOptions} */
  const createOptions = {
    createAddress: true,
    txPerOutput: true,
    deterministicInput: true
  };

  // unconfirm -> confirm
  const w1a1txs = await wutils.createInboundTXs(wallet1, outputs, createOptions);
  const w1a2txs = await wutils.createInboundTXs(wallet1, outputs.map(v => ({
    ...v,
    account: 1
  })), createOptions);
  const w2a1txs = await wutils.createInboundTXs(wallet2, outputs, createOptions);
  const alltxs = [...w1a1txs, ...w1a2txs, ...w2a1txs];

  for (const tx of alltxs)
    await wdb.addTX(tx);

  // confirm.
  await wdb.addBlock(wutils.nextEntry(wdb), alltxs);

  // new unconfirmed txs
  const w1a1txs2 = await wutils.createInboundTXs(wallet1, outputs, createOptions);
  const w1a2txs2 = await wutils.createInboundTXs(wallet1, outputs.map(v => ({
    ...v,
    account: 1
  })), createOptions);
  const w2a1txs2 = await wutils.createInboundTXs(wallet2, outputs, createOptions);
  const alltxs2 = [...w1a1txs2, ...w1a2txs2, ...w2a1txs2];

  for (const tx of alltxs2) {
    await wdb.addTX(tx);
  }

  // 1 coinbase for each
  /** @type {OutputInfo[]} */
  const coinbase = [{
    value: 1e6,
    coinbase: true
  }];

  const w1a1cb = await wutils.createInboundTXs(wallet1, coinbase, createOptions);
  const w1a2cb = await wutils.createInboundTXs(wallet1, [{
    ...coinbase[0],
    account: 1
  }], createOptions);
  const w2a1cb = await wutils.createInboundTXs(wallet2, coinbase, createOptions);
  const allcb = [...w1a1cb, ...w1a2cb, ...w2a1cb];

  for (const tx of allcb)
    await wdb.addBlock(wutils.nextEntry(wdb), [tx]);

  // send some coins
  {
    const sendOpts = {
      outputs: [{
        address: OUT_ADDR,
        value: 1e6
      }],
      selection
    };

    const confirmSend1 = await wallet1.send(sendOpts);
    const confirmSend2 = await wallet1.send({ account: 1, ...sendOpts });
    const confirmSend3 = await wallet2.send(sendOpts);

    await wallet1.send(sendOpts);
    await wallet1.send({ account: 1, ...sendOpts });
    await wallet2.send(sendOpts);

    await wdb.addBlock(wutils.nextEntry(wdb), [
      confirmSend1, confirmSend2, confirmSend3
    ]);
  }

  // unconfirmed
  {
    const sendOpts = {
      depth: 2,
      outputs: [{
        address: OUT_ADDR,
        value: 1e6
      }],
      selection
    };

    const mtx1 = await wallet1.createTX({ account: 0, ...sendOpts });
    const mtx2 = await wallet1.createTX({ account: 1, ...sendOpts });
    const mtx3 = await wallet2.createTX(sendOpts);

    const txs = [mtx1, mtx2, mtx3].map(mtx => mtx.toTX());
    await wdb.addBlock(wutils.nextEntry(wdb), txs);
  }

  {
    // double spend
    const sendOpts = {
      depth: 1,
      outputs: [{
        address: OUT_ADDR,
        value: 1e6
      }],
      selection
    };

    const mtx1 = await wallet1.createTX({ account: 0, ...sendOpts });
    const mtx2 = await wallet1.createTX({ account: 1, ...sendOpts });
    const mtx3 = await wallet2.createTX(sendOpts);

    const txs = [mtx1, mtx2, mtx3].map(mtx => mtx.toTX());
    const entry = wutils.nextEntry(wdb);
    await wdb.addBlock(entry, txs);

    const discedTXCount = await wdb.removeBlock(entry);
    assert(discedTXCount === txs.length);

    const coins1 = mtx1.inputs.map(input => mtx1.view.getCoinFor(input));
    const coins2 = mtx2.inputs.map(input => mtx2.view.getCoinFor(input));
    const coins3 = mtx3.inputs.map(input => mtx3.view.getCoinFor(input));

    const dblspend1 = new MTX();
    dblspend1.addOutput({
      address: OUT_ADDR,
      value: 1e6
    });

    for (const coin of coins1)
      dblspend1.addCoin(coin);

    await wallet1.sign(dblspend1);
    dblspend1.check();

    const dblspend2 = new MTX();
    dblspend2.addOutput({
      address: OUT_ADDR,
      value: 1e6
    });

    for (const coin of coins2)
      dblspend2.addCoin(coin);

    await wallet1.sign(dblspend2);
    dblspend2.check();

    const dblspend3 = new MTX();
    dblspend3.addOutput({
      address: OUT_ADDR,
      value: 1e6
    });

    for (const coin of coins3)
      dblspend3.addCoin(coin);

    await wallet2.sign(dblspend3);
    dblspend3.check();

    await wdb.addBlock(wutils.nextEntry(wdb), [
      dblspend1.toTX(),
      dblspend2.toTX(),
      dblspend3.toTX()
    ]);
  }

  const dump = await getMigrationDump(wdb);
  console.log(JSON.stringify({
    data: dump
  }, null, 2));

  await wdb.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * @param {WalletDB} wdb
 * @returns {Object}
 */

async function getMigrationDump(wdb) {
  const prefixes = [
    layout.wdb.V.encode().toString('hex')
  ];

  for (let i = 1; i < 3; i++) {
    prefixes.push(layout.wdb.W.encode(i).toString('hex'));
  }

  for (let i = 1; i < 3; i++) {
    const tprefix = layout.txdb.prefix.encode(i).toString('hex');

    for (const key of Object.keys(layout.txdb)) {
      if (key === 'prefix')
        continue;

      const val = layout.txdb[key];

      assert(val.id.toString('hex') === str2hex(key));
      // const prefix = str2hex(key);
      const prefix = key.charCodeAt(0).toString(16);
      prefixes.push(tprefix + prefix);
    }
  }

  const dump = await wutils.dumpWDB(wdb, prefixes);

  return dump;
}

function str2hex(key) {
  return Buffer.from(key, 'utf8').toString('hex');
}
