'use strict';

/**
 * This migration is checked against v2.1.3 - which is buggy version.
 * And then checked with v2.2.0 - which has fix and migration,
 * but run w/o migratoin.
 *
 * This generates two wallets with 2 accounts each.
 * Each account with 1 tx each that receives 1 change output that goes to
 * the LOOKAHEAD - 1 address. Lookahead for this test is set to 10.
 */

const bdb = require('bdb');
const Network = require('../../../lib/protocol/network');
const WalletDB = require('../../../lib/wallet/walletdb');
const wutils = require('../../util/wallet');
const mutils = require('../../util/migrations');

const NETWORK = Network.get('regtest');

const wallet1priv = 'rprvKE8qsHtkmUxUSPQdn2sFKFUcKyUQz9pKQhxjEWecnXg9hgJMsmJXcw'
  + 'J77SqmHT1R6mcuNqVPzgT2EoGStsXaUN92VJKhQWUB6uZdL8gAZvez';
const wallet2priv = 'rprvKE8qsHtkmUxUSR4jE7Lti9XV77hv7xxacAShw5MvxY6RfsAYVeB1WL'
  + 'WtjiebDmqTruVJxmMeQUMkk61e83WDZbZidDnNPhHyQpeEwxjuSZuG';
const rpub = 'rpubKBAPj83PkcGYSz3GR9xfzXBfTFTPtERb2x7fKvbikH9utGMvr6HDd4sTxt5zo'
  + 'arw4bzzgH1VDzBUoX9fotzmPrrngFyLMz3ozAi1ozAbJjSY';

const layout = {
  wdb: {
    // W[wid] -> wallet id
    W: bdb.key('W', ['uint32']),

    // w[wid] -> wallet
    w: bdb.key('w', ['uint32']),

    // l[id] -> wid
    l: bdb.key('l', ['ascii']),

    // n[wid][index] -> account name
    n: bdb.key('n', ['uint32', 'uint32']),

    // a[wid][index] -> account
    a: bdb.key('a', ['uint32', 'uint32']),

    // p[addr-hash] -> address->wid map
    p: bdb.key('p', ['hash']),

    // P[wid][addr-hash] -> path data
    P: bdb.key('P', ['uint32', 'hash']),

    // r[wid][index][addr-hash] -> dummy (addr by account)
    r: bdb.key('r', ['uint32', 'uint32', 'hash'])
  }
};

const LOOKAHEAD = 10;

(async () => {
  const wdb = new WalletDB({
    network: NETWORK,
    memory: true
  });

  await wdb.open();

  const wallet1 = await wdb.create({
    id: 'wallet1',
    master: wallet1priv,
    lookahead: LOOKAHEAD
  });

  await wallet1.createAccount({
    name: 'alt1',
    lookahead: LOOKAHEAD
  });

  const wallet2 = await wdb.create({
    id: 'wallet2',
    master: wallet2priv,
    lookahead: LOOKAHEAD,
    m: 1,
    n: 2
  });

  await wallet2.addSharedKey(0, rpub);

  await mineBlocks(wdb, 100);

  for (let i = 0; i < LOOKAHEAD; i++) {
    // Derive receives to get deterministic outputs.
    await wallet1.createReceive(0);
    await wallet1.createReceive(1);
    await wallet2.createReceive(0);

    await wallet1.createChange(0);
    await wallet1.createChange(1);
    await wallet2.createChange(0);
  }

  // const accounts = [
  //   await wallet1.getAccount(0),
  //   await wallet1.getAccount(1),
  //   await wallet2.getAccount(0)
  // ];

  // const lookaheadHashes = [];

  // for (const acc of accounts) {
  //   const addr = await acc.deriveChange(LOOKAHEAD * 2);
  //   lookaheadHashes.push(addr.getHash());
  // }

  // let hasKey = false;
  // for (const hash of lookaheadHashes) {
  //   const map = await wdb.getPathMap(hash);
  //   if (map) {
  //     hasKey = true;
  //     break;
  //   }
  // }

  const {beforeOnly, filtered} = await getMigrationDump(wdb);
  const data = {
    beforeOnly: beforeOnly,
    data: filtered
  };
  console.log(JSON.stringify(data, null, 2));
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});

async function mineBlocks(wdb, n) {
  for (let i = 0; i < n; i++) {
    const entry = wutils.nextEntry(wdb);
    await wdb.addBlock(entry, []);
  }
};

async function getMigrationDump(wdb) {
  const HASH = Buffer.alloc(32);
  const beforeOnlyPrefixes = [];

  const prefixes = [
    layout.wdb.p.encode(HASH).slice(0, 1).toString('hex'),
    layout.wdb.n.encode(0, 0).slice(0, 1).toString('hex'),
    layout.wdb.l.encode('wid').slice(0, 1).toString('hex')
  ];

  // SKIP Primary wallet.
  for (let i = 1; i < 3; i++) {
    prefixes.push(layout.wdb.a.encode(i, 0).slice(0, 5).toString('hex'));
    prefixes.push(layout.wdb.P.encode(i, HASH).slice(0, 5).toString('hex'));
    prefixes.push(layout.wdb.r.encode(i, 0, HASH).slice(0, 5).toString('hex'));
    prefixes.push(layout.wdb.W.encode(i).toString('hex'));
    prefixes.push(layout.wdb.w.encode(i).toString('hex'));
  }

  beforeOnlyPrefixes.push(layout.wdb.a.encode(0, 0).slice(0, 5).toString('hex'));
  beforeOnlyPrefixes.push(layout.wdb.P.encode(0, HASH).slice(0, 5).toString('hex'));
  beforeOnlyPrefixes.push(layout.wdb.r.encode(0, 0, HASH).slice(0, 5).toString('hex'));
  beforeOnlyPrefixes.push(layout.wdb.W.encode(0).toString('hex'));
  beforeOnlyPrefixes.push(layout.wdb.w.encode(0).toString('hex'));

  const dump = await mutils.dumpDB(wdb, prefixes);
  const dumpBeforeOnly = await mutils.dumpDB(wdb, beforeOnlyPrefixes);
  const beforeOnly = dumpBeforeOnly;

  const filtered = {};
  for (const [key, value] of Object.entries(dump)) {
    // This is maprecord for primary wallet. We don't want primary wallet.
    // 4 byte (size of wid set) + 4 byte * (size of wid set) (Small Endian)
    // 1 size + 0 wid.
    if (key.startsWith('70') && value === '0100000000000000') {
      beforeOnly[key] = value;
      continue;
    }

    // Maprecord for performance is not deserialized and instead data is appended
    // to it. This can cause duplicate indexes in the dump. So manually fix that
    // for the migration.
    if (key.startsWith('70')) {
      if (value === '020000000100000001000000') {
        filtered[key] = '0100000001000000';
        continue;
      }

      if (value === '020000000200000002000000') {
        filtered[key] = '0100000002000000';
        continue;
      }
    }

    filtered[key] = value;
  }

  return {
    filtered,
    beforeOnly
  };
}
