'use strict';

/**
 * Migration from v2.x to v3.0.0
 */

const Logger = require('blgr');
const Network = require('../../../lib/protocol/network');
const Mempool = require('../../../lib/mempool/mempool');
const Miner = require('../../../lib/mining/miner');
const Chain = require('../../../lib/blockchain/chain');
const MemWallet = require('../../util/memwallet');
const HD = require('../../../lib/hd');
// const rules = require('../../../lib/covenants/rules');
const mutils = require('../../util/migrations');

const NETWORK = Network.get('regtest');
let blockstore = null;

try {
  blockstore = require('../../../lib/blockstore');
} catch (e) {
  ;
}

const wallet1priv = 'rprvKE8qsHtkmUxUSPQdn2sFKFUcKyUQz9pKQhxjEWecnXg9hgJMsmJXcw'
  + 'J77SqmHT1R6mcuNqVPzgT2EoGStsXaUN92VJKhQWUB6uZdL8gAZvez';

async function dumpMigration(prune) {
  NETWORK.block.pruneAfterHeight = 10;
  NETWORK.block.keepBlocks = 40;

  let txID = 0;

  const commonOptions = {
    memory: true,
    network: NETWORK,
    logger: Logger.global
  };

  let blocks = null;

  if (blockstore) {
    blocks = blockstore.create(commonOptions);

    await blocks.open();
  }

  const chain = new Chain({
    ...commonOptions,
    entryCache: 5000,
    blocks,
    prune
  });

  const mempool = new Mempool({
    ...commonOptions,
    chain
  });

  const miner = new Miner({
    ...commonOptions,
    mempool,
    chain
  });

  const master = HD.HDPrivateKey.fromBase58(wallet1priv, NETWORK);
  const wallet = new MemWallet({
    network: NETWORK,
    master
  });

  const address = wallet.getAddress();
  miner.addAddress(address);

  mempool.on('tx', (tx) => {
    miner.cpu.notifyEntry();
    wallet.addTX(tx);
  });

  chain.on('connect', async (entry, block, view) => {
    try {
      await mempool._addBlock(entry, block.txs, view);
      wallet.addBlock(entry, block.txs);
    } catch (e) {
      ;
    }
  });

  chain.on('disconnect', async (entry, block) => {
    try {
      await mempool._removeBlock(entry, block.txs);
    } catch (e) {
      ;
    }
  });

  await chain.open();
  await mempool.open();
  await miner.open();

  miner.createBlock = async (tip, address) => {
    return mutils.createBlock({
      txno: txID++,
      chain,
      miner,
      tip,
      address
    });
  };

  const mineBlock = async () => {
    const block = await miner.mineBlock(chain.tip, address);
    await chain.add(block);
  };

  for (let i = 0; i < 40; i++)
    await mineBlock();

  // full auction from start to finish.
  // const name = rules.grindName(10, chain.tip.height + 1, NETWORK);
  const name = 'nypvzvlxha';
  const openTX = await wallet.createOpen(name);
  await mempool.addTX(openTX.toTX());

  for (let i = 0; i < NETWORK.names.treeInterval + 1; i++)
    await mineBlock();

  const bidTX1 = await wallet.createBid(name, 10000, 20000);
  await mempool.addTX(bidTX1.toTX());
  const bidTX2 = await wallet.createBid(name, 10000, 20000);
  await mempool.addTX(bidTX2.toTX());

  for (let i = 0; i < NETWORK.names.biddingPeriod; i++)
    await mineBlock();

  const reveal = await wallet.createReveal(name);
  await mempool.addTX(reveal.toTX());

  for (let i = 0; i < NETWORK.names.revealPeriod + 1; i++)
    await mineBlock();

  const register = await wallet.createRegister(name, Buffer.from([1,2,3]));
  await mempool.addTX(register.toTX());
  await mineBlock();

  const update = await wallet.createUpdate(name, Buffer.from([1,2,3,4]));
  await mempool.addTX(update.toTX());
  await mineBlock();

  const data = await getMigrationDump(chain);

  await miner.close();
  await mempool.close();
  await chain.close();

  if (blocks)
    await blocks.close();

  return data;
}

(async () => {
  const full = await dumpMigration(false);
  const pruned = await dumpMigration(true);

  console.log(JSON.stringify({
    full,
    pruned
  }, null, 2));
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});

async function getMigrationDump(chain) {
  const prefixes = [
    'b',
    'u'
  ];

  return mutils.dumpChainDB(chain.db, prefixes.map(mutils.prefix2hex));
}