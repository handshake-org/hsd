'use strict';

/**
 * This migration is for v4 -> v5.
 */

const bdb = require('bdb');
const Network = require('../../../lib/protocol/network');
const WalletDB = require('../../../lib/wallet/walletdb');
const wutils = require('../../util/wallet');
const mutils = require('../../util/migrations');

const layout = {
  wdb: {
    // W[wid] -> wallet id
    W: bdb.key('W', ['uint32']),

    // a[wid][index] -> account
    a: bdb.key('a', ['uint32', 'uint32'])
  }
};

const NETWORK = Network.get('regtest');
const LOOKAHEAD1 = 10;
const LOOKAHEAD2 = 200;

const wallet1priv = 'rprvKE8qsHtkmUxUSPQdn2sFKFUcKyUQz9pKQhxjEWecnXg9hgJMsmJXcw'
  + 'J77SqmHT1R6mcuNqVPzgT2EoGStsXaUN92VJKhQWUB6uZdL8gAZvez';
const wallet2priv = 'rprvKE8qsHtkmUxUSR4jE7Lti9XV77hv7xxacAShw5MvxY6RfsAYVeB1WL'
  + 'WtjiebDmqTruVJxmMeQUMkk61e83WDZbZidDnNPhHyQpeEwxjuSZuG';
const rpub = 'rpubKBAPj83PkcGYSz3GR9xfzXBfTFTPtERb2x7fKvbikH9utGMvr6HDd4sTxt5zo'
  + 'arw4bzzgH1VDzBUoX9fotzmPrrngFyLMz3ozAi1ozAbJjSY';

(async () => {
  const wdb = new WalletDB({
    network: NETWORK,
    memory: true
  });

  await wdb.open();

  const wallet1 = await wdb.create({
    id: 'wallet1',
    master: wallet1priv,
    lookahead: LOOKAHEAD1
  });

  await wallet1.createAccount({
    name: 'alt',
    lookahead: LOOKAHEAD2
  });

  const wallet2 = await wdb.create({
    id: 'wallet2',
    master: wallet2priv,
    lookahead: LOOKAHEAD2,
    m: 1,
    n: 2
  });

  await wallet2.addSharedKey(0, rpub);

  for (let i = 0; i < 100; i++) {
    const entry = wutils.nextEntry(wdb);
    await wdb.addBlock(entry, []);
  }

  console.log(JSON.stringify({
    data: await getMigrationDump(wdb)
  }, null, 2));

  await wdb.close();
})().catch((e) => {
    console.error(e);
});

async function getMigrationDump(wdb) {
  const prefixes = [];

  // skip primary wallet.
  for (let i = 1; i < 3; i++) {
    prefixes.push(layout.wdb.W.encode(i).toString('hex'));
    prefixes.push(layout.wdb.a.encode(i, 0).slice(0, 5).toString('hex'));
  }

  return await mutils.dumpDB(wdb, prefixes);
}
