'use strict';

const Logger = require('blgr');
const Network = require('../../../lib/protocol/network');
const ChainDB = require('../../../lib/blockchain/chaindb');
const mutils = require('../../util/migrations');

const NETWORK = Network.get('regtest');
let blockstore = null;

try {
  blockstore = require('../../../lib/blockstore');
} catch (e) {
  ;
}

async function dumpMigration(options) {
  let blocks = null;

  if (blockstore && !options.spv) {
    blocks = blockstore.create({
      memory: true,
      network: NETWORK,
      logger: Logger.global
    });

    await blocks.open();
  }

  const chainDB = new ChainDB({
    logger: Logger.global,
    network: NETWORK,
    memory: true,
    prune: options.prune,
    spv: options.spv,
    entryCache: 5000,
    blocks
  });

  await chainDB.open();
  const data = await getMigrationDump(chainDB);

  await chainDB.close();

  if (blocks)
    await blocks.close();

  return data;
}

(async () => {
  const full = await dumpMigration({ prune: false, spv: false });
  const prune = await dumpMigration({ prune: true, spv: false });
  const spv = await dumpMigration({ prune: false, spv: true });

  console.log(JSON.stringify({
    full,
    prune,
    spv
  }, null, 2));
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});

async function getMigrationDump(chaindb) {
  const prefixes = [
    'O',
    'M'
  ];

  return mutils.dumpChainDB(chaindb, prefixes.map(mutils.prefix2hex));
}
