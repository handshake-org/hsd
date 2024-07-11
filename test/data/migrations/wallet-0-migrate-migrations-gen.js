'use strict';

/**
 * walletdb version 0 to 1 migration.
 * Final migration data needs modifications for
 * the correct next migration value.
 */

const Network = require('../../../lib/protocol/network');
const WalletDB = require('../../../lib/wallet/walletdb');
const mutils = require('../../util/migrations');

const NETWORK = Network.get('regtest');

(async () => {
  const wdb = new WalletDB({
    network: NETWORK,
    memory: true
  });

  await wdb.open();
  console.log(JSON.stringify({
    data: await getMigrationDump(wdb)
  }, null, 2));

  await wdb.close();
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});

async function getMigrationDump(wdb) {
  const prefixes = [
    'M'
  ];

  return mutils.dumpDB(wdb, prefixes.map(mutils.prefix2hex));
}
